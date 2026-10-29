import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createGoal } from "../extensions/goal-record.ts";
import {
	ARCHIVED_GOALS_DIR,
	archiveGoalFile,
	invalidateGoalPoolCache,
	readActiveGoalPool,
	readGoalFileSnapshotChecked,
	recoveredArchivedGoal,
	serializeGoalFile,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import {
	assertSafeFileAncestors,
	atomicWriteRegularFile,
	claimRegularFile,
	discardClaimedRegularFile,
	ensureSafeDirectory,
	ProtectedFileChangedError,
	readRegularFile,
	readRegularFileAsync,
	restoreClaimedRegularFile,
} from "../extensions/storage/safe-fs.ts";

function project(t: test.TestContext): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-safe-fs-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const posix = process.platform !== "win32";

test("reads are bounded regular files below the root, never through symlinks or special files", async t => {
	const root = project(t);
	const outside = project(t);
	fs.mkdirSync(path.join(root, ".pi/goals"), { recursive: true });
	const file = path.join(root, ".pi/goals/goal.md");
	fs.writeFileSync(file, "bytes");
	assert.equal(readRegularFile(root, file, 16).bytes.toString(), "bytes");
	assert.equal((await readRegularFileAsync(root, file, 16)).bytes.toString(), "bytes");
	assert.throws(() => readRegularFile(root, file, 2), RangeError);
	await assert.rejects(readRegularFileAsync(root, file, 2), RangeError);

	fs.writeFileSync(path.join(outside, "secret"), "outside");
	fs.symlinkSync(path.join(outside, "secret"), path.join(root, ".pi/goals/linked.md"));
	assert.throws(() => readRegularFile(root, path.join(root, ".pi/goals/linked.md"), 64), /ELOOP|EMLINK|symbolic link/);
	await assert.rejects(readRegularFileAsync(root, path.join(root, ".pi/goals/linked.md"), 64), /ELOOP|EMLINK|symbolic link/);

	fs.mkdirSync(path.join(outside, "dir"));
	fs.writeFileSync(path.join(outside, "dir/goal.md"), "outside");
	fs.symlinkSync(path.join(outside, "dir"), path.join(root, ".pi/linked-dir"));
	assert.throws(() => readRegularFile(root, path.join(root, ".pi/linked-dir/goal.md"), 64), /symlink ancestor/);
	assert.throws(() => readRegularFile(root, path.join(outside, "secret"), 64), /escapes its root/);

	if (posix) {
		execFileSync("mkfifo", [path.join(root, ".pi/goals/fifo.md")]);
		assert.throws(() => readRegularFile(root, path.join(root, ".pi/goals/fifo.md"), 64), /not a regular file/);
	}
});

test("a file renamed away while it is read is reported as a concurrent change", t => {
	const root = project(t);
	const file = path.join(root, "owner.json");
	fs.writeFileSync(file, "{\"pid\":1}");
	const mutableFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
	const readSync = mutableFs.readSync;
	let renamed = false;
	mutableFs.readSync = ((...args: unknown[]) => {
		// Another process claims the file between this reader's open and its read.
		if (!renamed) { renamed = true; fs.renameSync(file, `${file}.claimed`); }
		return (readSync as (...rest: unknown[]) => number)(...args);
	}) as typeof mutableFs.readSync;
	syncBuiltinESMExports();
	try {
		assert.throws(() => readRegularFile(root, file, 1024), (error: unknown) => error instanceof ProtectedFileChangedError || (error as NodeJS.ErrnoException).code === "ENOENT");
	} finally {
		mutableFs.readSync = readSync;
		syncBuiltinESMExports();
	}
	assert.equal(renamed, true);
});

test("directories are created privately one component at a time and symlinked components are refused", t => {
	const root = project(t);
	const outside = project(t);
	ensureSafeDirectory(root, path.join(root, "a/b/c"));
	if (posix) assert.equal(fs.statSync(path.join(root, "a/b/c")).mode & 0o777, 0o700);
	fs.symlinkSync(outside, path.join(root, "a/link"));
	assert.throws(() => ensureSafeDirectory(root, path.join(root, "a/link/d")), /symlink ancestor/);
	assert.deepEqual(fs.readdirSync(outside), []);
	assert.throws(() => assertSafeFileAncestors(root, path.join(root, "a/link/file")), /symlink ancestor/);
});

test("atomic writes keep replaced permissions, keep new files private, and never clobber with replace:false", t => {
	const root = project(t);
	const file = path.join(root, ".pi/goals/goal.md");
	atomicWriteRegularFile(root, file, Buffer.from("first"));
	if (posix) assert.equal(fs.statSync(file).mode & 0o777, 0o600, "new files are private to their owner");
	if (posix) fs.chmodSync(file, 0o640);
	atomicWriteRegularFile(root, file, Buffer.from("second"));
	assert.equal(fs.readFileSync(file, "utf8"), "second");
	if (posix) assert.equal(fs.statSync(file).mode & 0o777, 0o640, "a replacement keeps the replaced file's bits");

	assert.throws(() => atomicWriteRegularFile(root, file, Buffer.from("third"), { replace: false }), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
	assert.equal(fs.readFileSync(file, "utf8"), "second", "no-clobber publication preserves the existing file");

	const target = path.join(root, "outside-target");
	fs.writeFileSync(target, "untouched");
	fs.symlinkSync(target, path.join(root, ".pi/goals/link.md"));
	assert.throws(() => atomicWriteRegularFile(root, path.join(root, ".pi/goals/link.md"), Buffer.from("x")), /symbolic link|not a regular file/);
	assert.equal(fs.readFileSync(target, "utf8"), "untouched");
	fs.mkdirSync(path.join(root, ".pi/goals/dir.md"));
	assert.throws(() => atomicWriteRegularFile(root, path.join(root, ".pi/goals/dir.md"), Buffer.from("x")), /not a regular file/);
	assert.deepEqual(fs.readdirSync(path.join(root, ".pi/goals")).filter(name => name.includes(".write-")), [], "failed writes remove their private temporary directory");
});

test("a claimed file is restored without clobbering a successor and discarded only when unchanged", t => {
	const root = project(t);
	const file = path.join(root, "lock");
	fs.writeFileSync(file, "owner");
	const claim = claimRegularFile(root, file, 64, "test");
	assert.equal(fs.existsSync(file), false, "the canonical name is claimed");
	assert.equal(claim.file.bytes.toString(), "owner");
	restoreClaimedRegularFile(root, file, claim);
	assert.equal(fs.readFileSync(file, "utf8"), "owner");

	const second = claimRegularFile(root, file, 64, "test");
	fs.writeFileSync(file, "successor");
	assert.throws(() => restoreClaimedRegularFile(root, file, second), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
	assert.equal(fs.readFileSync(file, "utf8"), "successor", "the successor is never overwritten");
	discardClaimedRegularFile(root, second);
	assert.equal(fs.existsSync(second.quarantinePath), false);

	const third = claimRegularFile(root, file, 64, "test");
	fs.writeFileSync(third.quarantinePath, "SUCCESSOR");
	assert.throws(() => discardClaimedRegularFile(root, third), /changed before deletion/);
	assert.equal(fs.readFileSync(third.quarantinePath, "utf8"), "SUCCESSOR");
	fs.writeFileSync(third.quarantinePath, "grew while it was claimed");
	assert.throws(() => discardClaimedRegularFile(root, third), RangeError);
	assert.equal(fs.readFileSync(third.quarantinePath, "utf8"), "grew while it was claimed");
});

test("archival removes exactly the validated active file and publishes without clobbering", t => {
	const cwd = project(t);
	const ctx = { cwd };
	const goal = writeActiveGoalFile(ctx, createGoal({ objective: "Archive me", autoContinue: false, sisyphus: false }));
	const activeFile = path.join(cwd, goal.activePath!);
	const source = readGoalFileSnapshotChecked(ctx, activeFile);

	// A writer changed the file after the caller validated it: refuse and keep it.
	fs.writeFileSync(activeFile, serializeGoalFile({ ...goal, objective: "Changed concurrently" }));
	assert.throws(() => archiveGoalFile(ctx, { ...goal, status: "complete" }, source), /changed before archival/);
	assert.equal(fs.existsSync(activeFile), true);
	assert.deepEqual(fs.existsSync(path.join(cwd, ARCHIVED_GOALS_DIR)) ? fs.readdirSync(path.join(cwd, ARCHIVED_GOALS_DIR)) : [], []);

	const current = writeActiveGoalFile(ctx, { ...goal, revision: 1 });
	const fresh = readGoalFileSnapshotChecked(ctx, activeFile);
	invalidateGoalPoolCache();
	readActiveGoalPool(ctx); // writes the derived pool snapshot
	assert.ok(fs.existsSync(path.join(cwd, ".pi/.goals-pool-snapshot.json")));
	const archived = archiveGoalFile(ctx, { ...current, status: "complete" }, fresh);
	assert.equal(fs.existsSync(activeFile), false);
	assert.equal(archived.activePath, undefined);
	assert.ok(archived.archivedPath && fs.existsSync(path.join(cwd, archived.archivedPath)));
	assert.equal(fs.existsSync(path.join(cwd, ".pi/.goals-pool-snapshot.json")), false, "archival discards the derived snapshot instead of trusting a delta");
	assert.deepEqual(fs.readdirSync(path.join(cwd, ".pi/goals")).filter(name => name.startsWith(".")), [], "no private claim or temporary directory is left behind");
});

test("an interrupted archive is adopted byte-for-byte, and a different version gets a content-qualified name", t => {
	const cwd = project(t);
	const ctx = { cwd };
	const goal = writeActiveGoalFile(ctx, createGoal({ objective: "Retry archival", autoContinue: false, sisyphus: false }));
	const target = { ...goal, status: "complete" as const, archivedPath: `${ARCHIVED_GOALS_DIR}/goal_fixed_${goal.id}.md` };
	// The previous attempt published the archive but crashed before removing the active file.
	const published = recoveredArchivedGoal(ctx, target, "2026-10-29T00:00:00.000Z", target.archivedPath);
	fs.mkdirSync(path.join(cwd, ARCHIVED_GOALS_DIR), { recursive: true });
	fs.writeFileSync(path.join(cwd, target.archivedPath), serializeGoalFile(published));
	const adopted = archiveGoalFile(ctx, target);
	assert.equal(adopted.archivedPath, target.archivedPath);
	assert.equal(adopted.updatedAt, "2026-10-29T00:00:00.000Z");
	assert.equal(fs.existsSync(path.join(cwd, goal.activePath!)), false);

	const second = writeActiveGoalFile(ctx, createGoal({ objective: "Older version archived", autoContinue: false, sisyphus: false }));
	const derived = archiveGoalFile(ctx, { ...second, objective: "Older version archived", status: "complete" });
	fs.unlinkSync(path.join(cwd, derived.archivedPath!));
	const older = { ...second, status: "complete" as const, objective: "Older version", updatedAt: derived.updatedAt, archivedPath: derived.archivedPath };
	delete older.activePath;
	const newer = writeActiveGoalFile(ctx, { ...second, objective: "Newer version" });
	fs.writeFileSync(path.join(cwd, derived.archivedPath!), serializeGoalFile(older));
	// Same id and timestamp-derived name as the preserved archive, different bytes.
	const qualified = archiveGoalFile(ctx, { ...newer, status: "complete", archivedPath: undefined, updatedAt: second.updatedAt });
	assert.notEqual(qualified.archivedPath, derived.archivedPath);
	assert.match(qualified.archivedPath ?? "", /_[0-9a-f]{16}\.md$/);
	assert.match(fs.readFileSync(path.join(cwd, derived.archivedPath!), "utf8"), /Older version/, "the earlier archive is preserved");
});
