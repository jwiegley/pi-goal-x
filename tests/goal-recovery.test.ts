import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import test from "node:test";

import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import { goalLedgerPath, invalidateGoalLedgerCache, readGoalLedger } from "../extensions/goal-ledger.ts";
import { invalidateGoalPoolCache, parseGoalFile, readActiveGoalPool, writeActiveGoalFile, type GoalFileContext } from "../extensions/storage/goal-files.ts";
import {
	runRecoveryReport,
	runRecoveryRepair,
	formatRecoveryReport,
	GOALS_DIR,
	RECOVERY_BACKUP_DIR,
	RECOVERY_LEDGER_PENDING_DIR,
} from "../extensions/goal-recovery.ts";

function tempCtx(): GoalFileContext {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "goal-recovery-"));
	fs.mkdirSync(path.join(cwd, GOALS_DIR, "archived"), { recursive: true });
	fs.mkdirSync(path.join(cwd, GOALS_DIR, ".locks"), { recursive: true });
	return { cwd };
}

function cleanup(ctx: GoalFileContext): void {
	try { fs.rmSync(ctx.cwd, { recursive: true, force: true }); } catch {}
}

function writeGoal(ctx: GoalFileContext, objective = "healthy goal"): void {
	writeActiveGoalFile(ctx, createGoal({ objective, autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 6, 9, 0, 0)));
}

function writeStaleLock(ctx: GoalFileContext, name: string): void {
	fs.writeFileSync(
		path.join(ctx.cwd, GOALS_DIR, ".locks", name),
		JSON.stringify({ pid: 999_999_999, startedAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
		"utf8",
	);
}

test("recovery report: healthy fixture reports no issues", () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		const report = runRecoveryReport(ctx);
		assert.equal(report.healthy, true);
		assert.deepEqual(report.malformedGoalFiles, []);
		assert.equal(report.malformedLedgerLines, 0);
		assert.deepEqual(report.staleLocks, []);
		assert.deepEqual(report.orphanedSnapshotGoals, []);
		assert.match(formatRecoveryReport(report), /OK — no issues found/);
	} finally {
		cleanup(ctx);
	}
});

test("recovery report: malformed goal file, bad ledger line, stale lock, and orphaned snapshot are all identified", () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		// Malformed goal file.
		fs.writeFileSync(path.join(ctx.cwd, GOALS_DIR, "active_goal_bad.md"), "this is not a goal file", "utf8");
		// Malformed ledger line.
		fs.appendFileSync(path.join(ctx.cwd, GOALS_DIR, "goal_events.jsonl"), "{{{ not json\n", "utf8");
		// Stale lock (dead pid + old startedAt).
		writeStaleLock(ctx, "g1.lock");
		// Orphaned snapshot entry: a snapshot goal whose file does not exist.
		writeGoal(ctx);
		readActiveGoalPool(ctx); // cold read writes the pool snapshot
		const snapshotPath = path.join(ctx.cwd, ".pi", ".goals-pool-snapshot.json");
		assert.ok(fs.existsSync(snapshotPath), "cold read wrote a snapshot");
		const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
		snapshot.goals.push({ goalId: "gone", activePath: "active_goal_gone.md", latestStatus: "active" });
		fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");

		const report = runRecoveryReport(ctx);
		assert.equal(report.healthy, false);
		assert.equal(report.malformedGoalFiles.length, 1);
		assert.match(report.malformedGoalFiles[0]!.relPath, /active_goal_bad\.md$/);
		assert.equal(report.malformedLedgerLines, 1);
		assert.equal(report.staleLocks.length, 1);
		assert.equal(report.staleLocks[0]!.fileName, "g1.lock");
		assert.equal(report.orphanedSnapshotGoals.length, 1);
		assert.equal(report.orphanedSnapshotGoals[0]!.goalId, "gone");
		assert.match(formatRecoveryReport(report), /issues found/);
	} finally {
		cleanup(ctx);
	}
});

test("recovery repair: confirmation rejection touches nothing", async () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		writeStaleLock(ctx, "g1.lock");
		const report = runRecoveryReport(ctx);
		assert.equal(report.staleLocks.length, 1);

		const result = await runRecoveryRepair(ctx, report, async () => false);
		assert.equal(result.confirmed, false);
		assert.deepEqual(result.applied, []);
		assert.equal(result.backupDir, null);
		assert.ok(fs.existsSync(path.join(ctx.cwd, GOALS_DIR, ".locks", "g1.lock")), "lock untouched");
	} finally {
		cleanup(ctx);
	}
});

test("recovery repair: confirmed repair backs up, removes stale locks, and refreshes the snapshot", async () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		writeStaleLock(ctx, "g1.lock");
		// Orphaned snapshot entry.
		readActiveGoalPool(ctx); // cold read writes the pool snapshot
		const snapshotPath = path.join(ctx.cwd, ".pi", ".goals-pool-snapshot.json");
		const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
		const orphanCount = snapshot.goals.length;
		snapshot.goals.push({ goalId: "gone", activePath: "active_goal_gone.md", latestStatus: "active" });
		fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");

		const report = runRecoveryReport(ctx);
		assert.equal(report.staleLocks.length, 1);
		assert.equal(report.orphanedSnapshotGoals.length, 1);

		const result = await runRecoveryRepair(ctx, report, async () => true);
		assert.equal(result.confirmed, true);
		assert.ok(result.backupDir && result.backupDir.startsWith(path.join(ctx.cwd, RECOVERY_BACKUP_DIR)), "backup dir under .recovery-backup");
		assert.ok(fs.existsSync(path.join(result.backupDir!, "lock-g1.lock")), "stale lock backed up");
		assert.ok(!fs.existsSync(path.join(ctx.cwd, GOALS_DIR, ".locks", "g1.lock")), "stale lock removed");
		assert.ok(fs.existsSync(path.join(result.backupDir!, "pool-snapshot.json")), "snapshot backed up before refresh");
		assert.equal(result.applied.length, 2);

		// The refreshed snapshot no longer contains the orphan.
		const refreshed = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
		assert.equal(refreshed.goals.length, orphanCount);
		assert.ok(!refreshed.goals.some((g: { goalId?: string }) => g.goalId === "gone"), "orphan dropped from the refreshed snapshot");

		// A follow-up report is healthy for the repaired classes.
		const after = runRecoveryReport(ctx);
		assert.equal(after.staleLocks.length, 0);
		assert.equal(after.orphanedSnapshotGoals.length, 0);
	} finally {
		cleanup(ctx);
	}
});

test("recovery leaves a live owner's lock alone however old it is", async () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		const lockPath = path.join(ctx.cwd, GOALS_DIR, ".locks", "g1.lock");
		fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 60 * 60_000).toISOString() }), "utf8");
		writeStaleLock(ctx, "g2.lock");
		const report = runRecoveryReport(ctx);
		assert.deepEqual(report.staleLocks.map((lock) => lock.fileName), ["g2.lock"], "age alone does not make a lock stale");
		// The g2 owner came back before the repair ran.
		fs.writeFileSync(path.join(ctx.cwd, GOALS_DIR, ".locks", "g2.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
		const result = await runRecoveryRepair(ctx, report, async () => true);
		assert.deepEqual(result.applied, [], "a lock that is no longer stale is not removed");
		assert.deepEqual(result.failures.map((failure) => `${failure.operation}/${failure.stage} ${failure.target}`), ["remove_stale_lock/validate g2.lock"]);
		assert.ok(fs.existsSync(lockPath));
		assert.ok(fs.existsSync(path.join(ctx.cwd, GOALS_DIR, ".locks", "g2.lock")));
	} finally {
		cleanup(ctx);
	}
});

test("recovery reports an abandoned ownership gate and never removes it", async () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		writeStaleLock(ctx, "g1.lock.gate");
		const report = runRecoveryReport(ctx);
		assert.equal(report.healthy, false);
		assert.deepEqual(report.staleLocks, []);
		assert.deepEqual(report.abandonedGates.map((gate) => gate.fileName), ["g1.lock.gate"]);
		assert.match(formatRecoveryReport(report), /abandoned lock ownership gate[\s\S]*delete each gate by hand/);
		const result = await runRecoveryRepair(ctx, report, async () => true);
		assert.equal(result.confirmed, false, "there is nothing repair may do");
		assert.ok(fs.existsSync(path.join(ctx.cwd, GOALS_DIR, ".locks", "g1.lock.gate")));
	} finally {
		cleanup(ctx);
	}
});

function writeStrandedCompletion(ctx: GoalFileContext): { goal: GoalRecord; bytes: Buffer } {
	const goal = writeActiveGoalFile(ctx, { ...createGoal({ objective: "finished elsewhere", autoContinue: false, sisyphus: false }, Date.UTC(2026, 9, 1, 9, 0, 0)), status: "complete" });
	return { goal, bytes: fs.readFileSync(path.join(ctx.cwd, goal.activePath!)) };
}

function goalEvents(ctx: GoalFileContext, goalId: string): string[] {
	invalidateGoalLedgerCache();
	return readGoalLedger(ctx).events.filter((event) => "goalId" in event && event.goalId === goalId).map((event) => event.type);
}

test("a completed record stranded at an active path is archived with its ledger events", async () => {
	const ctx = tempCtx();
	try {
		const { goal, bytes } = writeStrandedCompletion(ctx);
		invalidateGoalPoolCache();
		assert.equal(readActiveGoalPool(ctx).has(goal.id), false, "the pool no longer shows a completed record");
		const report = runRecoveryReport(ctx);
		assert.deepEqual(report.completedActiveGoals, [{ goalId: goal.id, activePath: goal.activePath }]);
		assert.equal(report.healthy, false);
		assert.match(formatRecoveryReport(report), /completed goal record\(s\) still at active paths[\s\S]*repair` to archive stranded completions/);

		const result = await runRecoveryRepair(ctx, report, async () => true);
		assert.deepEqual(result.failures, []);
		assert.deepEqual(result.applied, [`archived recovered completed goal ${goal.id}`, `reconciled recovery ledger for ${goal.id}`]);
		assert.equal(fs.existsSync(path.join(ctx.cwd, goal.activePath!)), false, "the active name is gone");
		const archivedDir = path.join(ctx.cwd, GOALS_DIR, "archived");
		const archives = fs.readdirSync(archivedDir);
		assert.equal(archives.length, 1);
		const archived = parseGoalFile(path.join(archivedDir, archives[0]!))!;
		assert.equal(archived.id, goal.id);
		assert.equal(archived.status, "complete");
		assert.deepEqual(fs.readFileSync(path.join(result.backupDir!, `completed-${goal.id}.md`)), bytes, "the original record is kept in the backup");
		assert.deepEqual(goalEvents(ctx, goal.id), ["goal_completed", "goal_archived"]);
		assert.deepEqual(fs.readdirSync(path.join(ctx.cwd, RECOVERY_LEDGER_PENDING_DIR)), [], "the marker is removed once the ledger has both events");

		const after = runRecoveryReport(ctx);
		assert.deepEqual(after.completedActiveGoals, []);
		assert.deepEqual(after.pendingRecoveryLedger, []);
		const again = await runRecoveryRepair(ctx, after, async () => assert.fail("nothing is left to repair"));
		assert.equal(again.confirmed, false);
	} finally {
		cleanup(ctx);
	}
});

test("a ledger backfill that fails is reported and finished by a later repair", async () => {
	const ctx = tempCtx();
	try {
		const { goal } = writeStrandedCompletion(ctx);
		// A directory at the ledger's append-lock path makes every append fail
		// while the ledger itself stays readable.
		const appendLock = path.join(path.dirname(goalLedgerPath(ctx)), ".goal-events.lock.sqlite");
		fs.mkdirSync(appendLock);
		const first = await runRecoveryRepair(ctx, runRecoveryReport(ctx), async () => true);
		assert.deepEqual(first.applied, [`archived recovered completed goal ${goal.id}`]);
		assert.deepEqual(first.failures.map((failure) => `${failure.operation}/${failure.stage} ${failure.target}`), [`append_recovery_ledger/append ${goal.id}`]);
		const pending = runRecoveryReport(ctx);
		assert.deepEqual(pending.completedActiveGoals, [], "the completion was archived");
		assert.deepEqual(pending.pendingRecoveryLedger.map((entry) => entry.goalId), [goal.id], "the missing ledger events stay visible");
		assert.match(formatRecoveryReport(pending), /pending recovery-ledger backfill/);

		fs.rmdirSync(appendLock);
		const second = await runRecoveryRepair(ctx, pending, async () => true);
		assert.deepEqual(second.failures, []);
		assert.deepEqual(second.applied, [`reconciled recovery ledger for ${goal.id}`]);
		assert.deepEqual(goalEvents(ctx, goal.id), ["goal_completed", "goal_archived"]);
		assert.equal(runRecoveryReport(ctx).healthy, true);
	} finally {
		cleanup(ctx);
	}
});

test("recovery report: never appends ledger events or rewrites goal files", () => {
	const ctx = tempCtx();
	try {
		writeGoal(ctx);
		const ledgerBefore = readGoalLedger({ cwd: ctx.cwd }).events.length;
		runRecoveryReport(ctx);
		runRecoveryReport(ctx);
		assert.equal(readGoalLedger({ cwd: ctx.cwd }).events.length, ledgerBefore, "report is read-only for the ledger");
		assert.equal(fs.readdirSync(path.join(ctx.cwd, GOALS_DIR)).filter((n) => n.startsWith("active_goal_")).length, 1);
	} finally {
		cleanup(ctx);
	}
});
