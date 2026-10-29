import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	GOAL_LOCK_DIR,
	GoalLockRecoveryError,
	acquireGoalLock,
	inspectGoalLock,
	inspectGoalLockGate,
	recoverStaleGoalLock,
	withGoalLock,
	type GoalLock,
} from "../extensions/storage/goal-lock.ts";

const lockModule = new URL("../extensions/storage/goal-lock.ts", import.meta.url).href;
const posix = process.platform !== "win32";
// Far above any pid_max, so process.kill(pid, 0) reports ESRCH.
const DEAD_PID = 999_999_999;

function tempCtx(t: test.TestContext): { cwd: string } {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-lock-")));
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	return { cwd };
}

function lockDir(ctx: { cwd: string }): string {
	return path.join(ctx.cwd, GOAL_LOCK_DIR);
}

function writeOwner(ctx: { cwd: string }, fileName: string, payload: unknown, ageMs = 0): string {
	fs.mkdirSync(lockDir(ctx), { recursive: true });
	const filePath = path.join(lockDir(ctx), fileName);
	fs.writeFileSync(filePath, typeof payload === "string" ? payload : JSON.stringify(payload));
	if (ageMs > 0) {
		const then = new Date(Date.now() - ageMs);
		fs.utimesSync(filePath, then, then);
	}
	return filePath;
}

test("a live owner keeps its lock however old it is", t => {
	const ctx = tempCtx(t);
	const startedAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
	const filePath = writeOwner(ctx, "g1.lock", { pid: process.pid, startedAt, token: randomUUID() }, 24 * 60 * 60_000);
	const before = fs.readFileSync(filePath);
	assert.throws(
		() => acquireGoalLock(ctx, "g1", { attempts: 3, retryMs: 1, staleTtlMs: 1 }),
		/Timed out acquiring the goal lock for g1/,
	);
	assert.deepEqual(fs.readFileSync(filePath), before, "the live owner's lock is untouched");
	assert.equal(inspectGoalLock(ctx, "g1.lock"), null, "age alone never makes a lock stale");
});

test("a dead or malformed owner is recovered at once", t => {
	const ctx = tempCtx(t);
	for (const payload of [
		{ pid: DEAD_PID, startedAt: new Date().toISOString(), token: randomUUID() },
		"{ torn",
		"",
	]) {
		const filePath = writeOwner(ctx, "g1.lock", payload);
		const stale = inspectGoalLock(ctx, "g1.lock");
		assert.ok(stale, `stale: ${JSON.stringify(payload)}`);
		const lock = acquireGoalLock(ctx, "g1", { attempts: 2, retryMs: 1 });
		const owner = JSON.parse(fs.readFileSync(filePath, "utf8")) as { pid: number; token: string };
		assert.equal(owner.pid, process.pid);
		assert.match(owner.token, /^[0-9a-f-]{36}$/);
		lock.release();
		assert.equal(fs.existsSync(filePath), false);
	}
	assert.deepEqual(fs.readdirSync(lockDir(ctx)), [], "no gate, claim or quarantine is left behind");
});

test("waiting on a live owner never takes the ownership gate", t => {
	const ctx = tempCtx(t);
	const held = acquireGoalLock(ctx, "g1");
	const mutableFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
	const openSync = mutableFs.openSync;
	const opened: string[] = [];
	mutableFs.openSync = ((file: fs.PathLike, ...rest: unknown[]) => {
		opened.push(String(file));
		return (openSync as (...args: unknown[]) => number)(file, ...rest);
	}) as typeof mutableFs.openSync;
	syncBuiltinESMExports();
	try {
		assert.throws(() => acquireGoalLock(ctx, "g1", { attempts: 4, retryMs: 1 }), /Timed out acquiring the goal lock/);
	} finally {
		mutableFs.openSync = openSync;
		syncBuiltinESMExports();
		held.release();
	}
	assert.ok(opened.some((file) => file.endsWith("g1.lock")), "each attempt reads the owner");
	assert.deepEqual(opened.filter((file) => file.endsWith(".gate")), [], "contention costs one read per attempt, not a gate");
});

test("release removes only the lock this holder created", t => {
	const ctx = tempCtx(t);
	const first = acquireGoalLock(ctx, "g1");
	const filePath = path.join(lockDir(ctx), "g1.lock");
	// Another process decided the first holder was gone and took over.
	fs.unlinkSync(filePath);
	const successor = acquireGoalLock(ctx, "g1");
	const successorBytes = fs.readFileSync(filePath);
	first.release();
	assert.deepEqual(fs.readFileSync(filePath), successorBytes, "the successor's lock survives a late release");
	successor.release();
	assert.equal(fs.existsSync(filePath), false);
	first.release(); // idempotent
});

test("an abandoned ownership gate fails closed and is reported", t => {
	const ctx = tempCtx(t);
	const gate = writeOwner(ctx, "g1.lock.gate", { pid: DEAD_PID, startedAt: new Date().toISOString(), token: randomUUID() });
	assert.throws(() => acquireGoalLock(ctx, "g1", { attempts: 2, retryMs: 1 }), /ownership gate/);
	assert.ok(fs.existsSync(gate), "an abandoned gate is never reaped automatically");
	assert.equal(fs.existsSync(path.join(lockDir(ctx), "g1.lock")), false);
	assert.equal(inspectGoalLockGate(ctx, "g1.lock.gate")?.pid, DEAD_PID);
	writeOwner(ctx, "g1.lock.gate", { pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() });
	assert.equal(inspectGoalLockGate(ctx, "g1.lock.gate"), null, "a live gate is not abandoned");
	assert.throws(() => inspectGoalLockGate(ctx, "../g1.lock.gate"), /Unsafe goal-lock gate name/);
	assert.throws(() => inspectGoalLock(ctx, "../escape.lock"), /Unsafe goal lock name/);
});

test("stale-lock recovery backs up, revalidates and refuses a lock that changed", t => {
	const ctx = tempCtx(t);
	const filePath = writeOwner(ctx, "g1.lock", { pid: DEAD_PID, startedAt: new Date().toISOString(), token: randomUUID() });
	const original = fs.readFileSync(filePath);
	const backups: Buffer[] = [];
	recoverStaleGoalLock(ctx, "g1.lock", bytes => backups.push(bytes));
	assert.deepEqual(backups, [original]);
	assert.equal(fs.existsSync(filePath), false);

	writeOwner(ctx, "g1.lock", { pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() });
	assert.throws(
		() => recoverStaleGoalLock(ctx, "g1.lock", () => assert.fail("a live lock is never backed up for removal")),
		(error: unknown) => error instanceof GoalLockRecoveryError && error.stage === "validate",
	);
	assert.ok(fs.existsSync(filePath));

	writeOwner(ctx, "g1.lock", { pid: DEAD_PID, startedAt: new Date().toISOString(), token: randomUUID() });
	const revived = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() });
	assert.throws(
		// The owner came back while the backup was being written.
		() => recoverStaleGoalLock(ctx, "g1.lock", () => fs.writeFileSync(filePath, revived)),
		(error: unknown) => error instanceof GoalLockRecoveryError && error.stage === "revalidate",
	);
	assert.equal(fs.readFileSync(filePath, "utf8"), revived, "the revived lock is kept");
	assert.equal(fs.existsSync(`${filePath}.gate`), false, "the recovery gate is released");
});

test("withGoalLock keeps a completed result when release fails and reports both failures otherwise", () => {
	const failing: GoalLock = { release: () => { throw new Error("release failed"); } };
	const observed: unknown[] = [];
	assert.equal(withGoalLock(failing, () => 42, error => observed.push(error)), 42);
	assert.equal(observed.length, 1);
	assert.match(String(observed[0]), /release failed/);
	assert.equal(withGoalLock(failing, () => 7, () => { throw new Error("observer"); }), 7, "an observer cannot undo a completed result");
	assert.throws(() => withGoalLock(failing, () => 1), /release failed/, "without an observer a failed release is thrown");
	assert.throws(
		() => withGoalLock(failing, () => { throw new Error("body failed"); }, () => assert.fail("not a completed result")),
		(error: unknown) => error instanceof AggregateError && error.errors.length === 2 && /body failed/.test(String(error.errors[0])),
	);
	let released = 0;
	const working: GoalLock = { release: () => { released++; } };
	assert.throws(() => withGoalLock(working, () => { throw new Error("body only"); }), /body only/);
	assert.equal(released, 1);
});

test("a symlinked lock directory is refused", { skip: !posix }, t => {
	const ctx = tempCtx(t);
	const outside = tempCtx(t);
	fs.mkdirSync(path.join(ctx.cwd, ".pi/goals"), { recursive: true });
	fs.symlinkSync(outside.cwd, lockDir(ctx));
	assert.throws(() => acquireGoalLock(ctx, "g1", { attempts: 1, retryMs: 1 }));
	assert.deepEqual(fs.readdirSync(outside.cwd), [], "nothing is created through the link");
});

test("processes contending for one goal lock never overlap", async t => {
	const ctx = tempCtx(t);
	const counter = path.join(ctx.cwd, "counter");
	fs.writeFileSync(counter, "0");
	const rounds = 40;
	const worker = `
		const fs = await import("node:fs");
		const { acquireGoalLock } = await import(${JSON.stringify(lockModule)});
		const [cwd, counter, rounds] = process.argv.slice(1);
		for (let i = 0; i < Number(rounds); i++) {
			const lock = acquireGoalLock({ cwd }, "shared", { attempts: 100000, retryMs: 1 });
			try {
				const value = Number(fs.readFileSync(counter, "utf8"));
				fs.writeFileSync(counter, String(value + 1));
			} finally {
				lock.release();
			}
		}
	`;
	const children = [1, 2, 3].map(() => new Promise<number>((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", worker, ctx.cwd, counter, String(rounds)], { stdio: ["ignore", "ignore", "inherit"] });
		child.once("error", reject);
		child.once("exit", code => resolve(code ?? -1));
	}));
	assert.deepEqual(await Promise.all(children), [0, 0, 0]);
	assert.equal(Number(fs.readFileSync(counter, "utf8")), 3 * rounds, "no increment was lost to an overlapping holder");
	assert.deepEqual(fs.readdirSync(lockDir(ctx)), []);
});
