import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import test from "node:test";

import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import {
	invalidateGoalPoolCache,
	parseGoalFile,
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";

const SNAPSHOT_NAME = ".goals-pool-snapshot.json";

function tempCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "goal-pool-snapshot-"));
}

function writeGoal(cwd: string, id: string): void {
	writeActiveGoalFile({ cwd }, createGoal({ objective: `objective ${id}`, autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 5, 9, 0, 0)));
}

function snapshotPaths(cwd: string): { newPath: string; legacyPath: string; goalsDir: string } {
	const goalsDir = path.join(cwd, ".pi", "goals");
	return { newPath: path.join(cwd, ".pi", SNAPSHOT_NAME), legacyPath: path.join(goalsDir, SNAPSHOT_NAME), goalsDir };
}

test("pool snapshot lives outside the watched goals dir and records its mtime", () => {
	const cwd = tempCwd();
	try {
		writeGoal(cwd, "g1");
		// A cold read writes the snapshot; invalidate the in-memory cache so the
		// read goes cold again.
		invalidateGoalPoolCache();
		const pool = readActiveGoalPool({ cwd });
		assert.equal(pool.size, 1);
		assert.ok(fs.existsSync(snapshotPaths(cwd).newPath), "snapshot written outside the goals dir");
		assert.ok(!fs.existsSync(snapshotPaths(cwd).legacyPath), "no legacy in-dir snapshot");

		const snapshot = JSON.parse(fs.readFileSync(snapshotPaths(cwd).newPath, "utf8"));
		const goalsDirStat = fs.lstatSync(snapshotPaths(cwd).goalsDir);
		// The fast path (2-op cold read: lstat + snapshot read, no readdir
		// fallback) holds exactly when the recorded dir mtime matches the live
		// one — and the snapshot's own write no longer perturbs that key.
		assert.equal(snapshot.dirMtimeMs, goalsDirStat.mtimeMs, "dir mtime key matches after the snapshot write");
		assert.equal(snapshot.version, 1);
		assert.equal(snapshot.goals.length, 1);
	} finally {
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("pool snapshot: a subsequent goal write keeps the fast-path key valid", () => {
	const cwd = tempCwd();
	try {
		writeGoal(cwd, "g1");
		invalidateGoalPoolCache();
		readActiveGoalPool({ cwd }); // cold: full scan + snapshot write

		// Another extension write (updatePoolSnapshotSync path).
		writeGoal(cwd, "g2");
		const snapshot = JSON.parse(fs.readFileSync(snapshotPaths(cwd).newPath, "utf8"));
		const goalsDirStat = fs.lstatSync(snapshotPaths(cwd).goalsDir);
		assert.equal(snapshot.dirMtimeMs, goalsDirStat.mtimeMs, "delta update keeps the mtime key fresh");
		assert.equal(snapshot.goals.length, 2);

		// Cold read after cache invalidation serves the snapshot (2-op path).
		invalidateGoalPoolCache();
		const pool = readActiveGoalPool({ cwd });
		assert.equal(pool.size, 2);
	} finally {
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("pool snapshot: a legacy in-dir snapshot that cannot be proven fresh is rescanned and removed", () => {
	const cwd = tempCwd();
	try {
		writeGoal(cwd, "g1");
		// A pre-relocation snapshot lives inside the goals dir. Writing it there
		// changes the directory's mtime, so its recorded key can never prove it
		// fresh; matching filenames alone are not proof either.
		const goalsDir = snapshotPaths(cwd).goalsDir;
		const diskFile = fs.readdirSync(goalsDir).find((n) => n.startsWith("active_goal_"))!;
		const diskGoal = parseGoalFile(path.join(goalsDir, diskFile))!;
		const markerGoal = { ...diskGoal, snapshotMarker: true };
		const legacy = {
			version: 1,
			dirMtimeMs: fs.lstatSync(goalsDir).mtimeMs,
			goals: [markerGoal],
		};
		fs.writeFileSync(snapshotPaths(cwd).legacyPath, JSON.stringify(legacy), "utf8");

		invalidateGoalPoolCache();
		const pool = readActiveGoalPool({ cwd });
		assert.equal(pool.size, 1, "the rescan finds the goal");
		const served = [...pool.values()][0]!;
		assert.equal((served as GoalRecord & { snapshotMarker?: boolean }).snapshotMarker, undefined, "served from a rescan, not the stale snapshot");
		assert.ok(!fs.existsSync(snapshotPaths(cwd).legacyPath), "the rescan's snapshot write removes the legacy file");
	} finally {
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("pool snapshot: a cold read sees an active file another writer replaced under the same name", () => {
	const cwd = tempCwd();
	try {
		writeGoal(cwd, "g1");
		invalidateGoalPoolCache();
		readActiveGoalPool({ cwd }); // cold: writes a snapshot naming the same file
		const goalsDir = snapshotPaths(cwd).goalsDir;
		const diskFile = path.join(goalsDir, fs.readdirSync(goalsDir).find((n) => n.startsWith("active_goal_"))!);
		// Another process saves by rename without touching the derived snapshot.
		const replaced = fs.readFileSync(diskFile, "utf8").replaceAll("objective g1", "objective edited elsewhere");
		const temp = path.join(goalsDir, "editor-save.tmp");
		fs.writeFileSync(temp, replaced, "utf8");
		fs.renameSync(temp, diskFile);

		invalidateGoalPoolCache();
		const pool = readActiveGoalPool({ cwd });
		assert.equal([...pool.values()][0]?.objective, "objective edited elsewhere");
	} finally {
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("pool snapshot: writing removes the legacy in-dir file", () => {
	const cwd = tempCwd();
	try {
		writeGoal(cwd, "g1");
		fs.writeFileSync(snapshotPaths(cwd).legacyPath, "{}", "utf8");
		invalidateGoalPoolCache();
		readActiveGoalPool({ cwd });
		assert.ok(!fs.existsSync(snapshotPaths(cwd).legacyPath), "legacy file cleaned up after the new write");
		assert.ok(fs.existsSync(snapshotPaths(cwd).newPath));
	} finally {
		try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});
