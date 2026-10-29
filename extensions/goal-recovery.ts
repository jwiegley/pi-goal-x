/**
 * /goal-recovery — read-only storage/recovery report + guarded repair.
 *
 * Reliability campaign 2026-08-09. The report scans these failure classes:
 *   - malformed goal files (active_goal_*.md that do not parse);
 *   - malformed ledger lines (counted by the ledger reader);
 *   - stale locks and ownership gates (.pi/goals/.locks/* whose owner pid is
 *     dead or whose payload is malformed — left behind by crashed sessions;
 *     a live owner is never stale, however old its lock);
 *   - orphaned snapshot data (pool-snapshot goals with no matching file);
 *   - completed records stranded at active paths by a crash or a failed
 *     archive, which the pool no longer shows;
 *   - recovery-ledger markers left when such a record was archived but its
 *     ledger backfill did not finish.
 *
 * Everything is read-only by default. Repair operations (stale-lock removal,
 * stranded-completion archival with ledger backfill, snapshot refresh) require
 * an explicit confirmation and back the affected files up first: lock bytes
 * are copied, and a stranded completed record is hard-linked into a permanent
 * backup before its active name is removed. A stale lock is removed only
 * under its ownership gate after its bytes and identity revalidate. Abandoned
 * gates are reported but never removed automatically: removing the guard
 * safely would itself need a guard, so they are an offline repair once every
 * Goal X writer has stopped. Every failed repair is returned with its
 * operation and stage. Malformed goal files and malformed ledger lines are
 * reported but never rewritten automatically — rewriting user-owned data is
 * deliberately out of scope (and automatic ledger rewriting is a documented
 * non-goal of the reliability campaign).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { commandPaths, type GoalCommands } from "./goal-controls.ts";
import { appendGoalEvents, readGoalLedger, readGoalLedgerForGoal, type GoalLedgerEvent } from "./goal-ledger.ts";
import type { GoalRecord } from "./goal-record.ts";
import {
	acquireGoalLock,
	GOAL_LOCK_DIR,
	GoalLockRecoveryError,
	inspectGoalLock,
	inspectGoalLockGate,
	recoverStaleGoalLock,
	withGoalLock,
} from "./storage/goal-lock.ts";
import {
	ARCHIVED_GOALS_DIR,
	archiveClaimedGoalFile,
	archivedPathForGoal,
	claimGoalFileForRecovery,
	isSafeActivePath,
	isSafeArchivedPath,
	MAX_CHECKED_GOAL_FILE_BYTES,
	MAX_CHECKED_POOL_SNAPSHOT_BYTES,
	parseGoalFileChecked,
	readGoalFileSnapshotChecked,
	recoveredArchivedGoal,
	refreshActiveGoalPoolSnapshot,
	resolveGoalPath,
	serializeGoalFile,
	type GoalFileContext,
	type RecoveryGoalFileClaim,
} from "./storage/goal-files.ts";
import { ensureGoalStorageDirectory, goalPoolSnapshotPath, goalStoragePath } from "./storage/goal-root.ts";
import {
	assertSafeFileAncestors,
	atomicWriteRegularFile,
	claimRegularFile,
	discardClaimedRegularFile,
	readRegularFile,
	restoreClaimedRegularFile,
	sameRegularFile,
} from "./storage/safe-fs.ts";

export const GOALS_DIR = ".pi/goals";
export const RECOVERY_BACKUP_DIR = ".pi/goals/.recovery-backup";
export const RECOVERY_LEDGER_PENDING_DIR = ".pi/goals/.recovery-ledger-pending";
const MAX_RECOVERY_LEDGER_MARKER_BYTES = 64 * 1024;

export interface MalformedGoalFileEntry {
	relPath: string;
	error: string;
}

export interface StaleLockEntry {
	fileName: string;
	pid: number;
	startedAt: string;
	ageMs: number;
}

export interface OrphanedSnapshotEntry {
	goalId: string;
	activePath: string;
}

export interface CompletedActiveGoalEntry {
	goalId: string;
	activePath: string;
}

export interface PendingRecoveryLedgerEntry {
	fileName: string;
	goalId: string;
	archivePath: string;
	archiveSha256: string;
	backupPath: string;
	sourceSha256: string;
	completedAt: string;
	archivedAt: string;
}

export interface RecoveryReport {
	scannedAt: string;
	malformedGoalFiles: MalformedGoalFileEntry[];
	malformedLedgerLines: number;
	staleLocks: StaleLockEntry[];
	abandonedGates: StaleLockEntry[];
	orphanedSnapshotGoals: OrphanedSnapshotEntry[];
	completedActiveGoals: CompletedActiveGoalEntry[];
	pendingRecoveryLedger: PendingRecoveryLedgerEntry[];
	healthy: boolean;
}

export interface RecoveryRepairFailure {
	operation: "prepare_backup" | "remove_abandoned_gate" | "remove_stale_lock" | "archive_completed_goal" | "append_recovery_ledger" | "refresh_pool_snapshot";
	stage: string;
	target: string;
	message: string;
}

export interface RecoveryRepairResult {
	applied: string[];
	failures: RecoveryRepairFailure[];
	backupDir: string | null;
	confirmed: boolean;
}

function recoveryFailureMessage(error: unknown): string {
	if (error instanceof AggregateError) {
		const details = error.errors.map(recoveryFailureMessage).join("; ");
		return details ? `${error.message}: ${details}` : error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

function goalLockRecoveryFailure(error: unknown): GoalLockRecoveryError | null {
	if (error instanceof GoalLockRecoveryError) return error;
	if (error instanceof AggregateError) {
		if (error.cause instanceof GoalLockRecoveryError) return error.cause;
		for (const failure of error.errors) {
			const nested = goalLockRecoveryFailure(failure);
			if (nested) return nested;
		}
	}
	return null;
}

function safeLockName(goalId: string): string {
	return goalId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function goalsDir(ctx: GoalFileContext): string {
	return goalStoragePath(ctx, GOALS_DIR);
}

function locksDir(ctx: GoalFileContext): string {
	return goalStoragePath(ctx, GOAL_LOCK_DIR);
}

function pendingLedgerDir(ctx: GoalFileContext): string {
	return goalStoragePath(ctx, RECOVERY_LEDGER_PENDING_DIR);
}

function pendingLedgerFileName(goalId: string): string {
	return `${createHash("sha256").update(goalId).digest("hex")}.json`;
}

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Markers name their backup by a logical path below the recovery backup directory. */
function resolveRecoveryBackupPath(ctx: GoalFileContext, relPath: string): string {
	if (!relPath || path.isAbsolute(relPath) || relPath.includes("\0")) {
		throw new Error(`Unsafe recovery backup path: ${relPath}`);
	}
	const root = goalStoragePath(ctx, RECOVERY_BACKUP_DIR);
	const absolutePath = goalStoragePath(ctx, relPath);
	const relative = path.relative(root, absolutePath);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Unsafe recovery backup path: ${relPath}`);
	}
	return absolutePath;
}

function recoveryBackupRelativePath(ctx: GoalFileContext, backupPath: string): string {
	const root = goalStoragePath(ctx, RECOVERY_BACKUP_DIR);
	const relative = path.relative(root, path.resolve(backupPath));
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Recovery backup path escapes ${RECOVERY_BACKUP_DIR}: ${backupPath}`);
	}
	return path.posix.join(RECOVERY_BACKUP_DIR, ...relative.split(path.sep));
}

interface PendingRecoveryLedgerSnapshot {
	entry: PendingRecoveryLedgerEntry;
	filePath: string;
	bytes: Buffer;
	identity: { dev: number; ino: number };
}

function readPendingRecoveryLedgerMarker(ctx: GoalFileContext, fileName: string): PendingRecoveryLedgerSnapshot {
	if (path.basename(fileName) !== fileName || !/^[a-f0-9]{64}\.json$/.test(fileName)) {
		throw new Error(`Unsafe recovery-ledger marker name: ${fileName}`);
	}
	const filePath = path.join(pendingLedgerDir(ctx), fileName);
	const file = readRegularFile(ctx.cwd, filePath, MAX_RECOVERY_LEDGER_MARKER_BYTES);
	let parsed: unknown;
	try {
		parsed = JSON.parse(file.bytes.toString("utf8")) as unknown;
	} catch (error) {
		throw new Error(`Malformed recovery-ledger marker ${fileName}.`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Malformed recovery-ledger marker ${fileName}.`);
	}
	const value = parsed as Record<string, unknown>;
	if (
		typeof value.goalId !== "string"
		|| typeof value.archivePath !== "string"
		|| typeof value.archiveSha256 !== "string"
		|| !/^[a-f0-9]{64}$/.test(value.archiveSha256)
		|| typeof value.backupPath !== "string"
		|| typeof value.sourceSha256 !== "string"
		|| !/^[a-f0-9]{64}$/.test(value.sourceSha256)
		|| typeof value.completedAt !== "string"
		|| typeof value.archivedAt !== "string"
		|| pendingLedgerFileName(value.goalId) !== fileName
		|| !isSafeArchivedPath(ctx, value.archivePath)
	) throw new Error(`Malformed recovery-ledger marker ${fileName}.`);
	resolveRecoveryBackupPath(ctx, value.backupPath);
	return {
		entry: {
			fileName,
			goalId: value.goalId,
			archivePath: value.archivePath,
			archiveSha256: value.archiveSha256,
			backupPath: value.backupPath,
			sourceSha256: value.sourceSha256,
			completedAt: value.completedAt,
			archivedAt: value.archivedAt,
		},
		filePath,
		bytes: file.bytes,
		identity: file,
	};
}

function readdirIfPresent(ctx: GoalFileContext, dir: string): string[] {
	try {
		assertSafeFileAncestors(ctx.cwd, path.join(dir, ".recovery-scan"));
		return fs.readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function scanPendingRecoveryLedger(ctx: GoalFileContext): PendingRecoveryLedgerEntry[] {
	return readdirIfPresent(ctx, pendingLedgerDir(ctx))
		.filter((name) => name.endsWith(".json"))
		.sort((left, right) => left.localeCompare(right))
		.map((name) => readPendingRecoveryLedgerMarker(ctx, name).entry);
}

/**
 * Record, before anything moves, where a stranded completion will be archived
 * and with which bytes, so an interrupted repair resumes to the same archive
 * and the ledger backfill can be completed later. An existing marker for the
 * goal is reused only when it describes this exact record.
 */
function preparePendingRecoveryLedger(
	ctx: GoalFileContext,
	current: GoalRecord,
	sourceBytes: Buffer,
	archivedAt: string,
	backupPath: string,
): PendingRecoveryLedgerEntry {
	const goalId = current.id;
	const completedAt = current.updatedAt;
	const sourceSha256 = sha256(sourceBytes);
	const fileName = pendingLedgerFileName(goalId);
	ensureGoalStorageDirectory(ctx, RECOVERY_LEDGER_PENDING_DIR);
	try {
		const existing = readPendingRecoveryLedgerMarker(ctx, fileName).entry;
		const expectedDigest = sha256(serializeGoalFile(recoveredArchivedGoal(ctx, current, existing.archivedAt, existing.archivePath)));
		if (
			existing.goalId !== goalId
			|| existing.completedAt !== completedAt
			|| existing.sourceSha256 !== sourceSha256
			|| existing.archiveSha256 !== expectedDigest
		) {
			throw new Error(`Recovery-ledger marker for ${goalId} conflicts with the completed record.`);
		}
		return existing;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const archivePath = archivedPathForGoal(ctx, current);
	const entry: PendingRecoveryLedgerEntry = {
		fileName,
		goalId,
		archivePath,
		archiveSha256: sha256(serializeGoalFile(recoveredArchivedGoal(ctx, current, archivedAt, archivePath))),
		backupPath: recoveryBackupRelativePath(ctx, backupPath),
		sourceSha256,
		completedAt,
		archivedAt,
	};
	atomicWriteRegularFile(ctx.cwd, path.join(pendingLedgerDir(ctx), fileName), Buffer.from(JSON.stringify(entry), "utf8"), { replace: false });
	return readPendingRecoveryLedgerMarker(ctx, fileName).entry;
}

/** Continue an interrupted claim from the permanent backup its marker names. */
function resumeRecoveryClaim(
	ctx: GoalFileContext,
	entry: PendingRecoveryLedgerEntry,
): { current: GoalRecord; claim: RecoveryGoalFileClaim } {
	const backupPath = resolveRecoveryBackupPath(ctx, entry.backupPath);
	const snapshot = readGoalFileSnapshotChecked(ctx, backupPath);
	if (sha256(snapshot.bytes) !== entry.sourceSha256) {
		throw new Error(`Recovery backup for ${entry.goalId} no longer matches its pending marker.`);
	}
	const current = snapshot.goal;
	if (
		!current
		|| current.id !== entry.goalId
		|| current.status !== "complete"
		|| !isSafeActivePath(ctx, current.activePath)
	) throw new Error(`Recovery backup for ${entry.goalId} is not the completed active record named by its marker.`);
	if (sha256(serializeGoalFile(recoveredArchivedGoal(ctx, current, entry.archivedAt, entry.archivePath))) !== entry.archiveSha256) {
		throw new Error(`Recovery marker for ${entry.goalId} no longer matches its archived record.`);
	}
	const sourcePath = resolveGoalPath(ctx, GOALS_DIR, current.activePath);
	try {
		// The active name may still be a second link to the backup inode.
		const active = readGoalFileSnapshotChecked(ctx, sourcePath);
		if (!sameRegularFile(active.identity, snapshot.identity) || !active.bytes.equals(snapshot.bytes)) {
			throw new Error(`A successor owns the active path for ${entry.goalId}.`);
		}
		const duplicate = claimRegularFile(ctx.cwd, sourcePath, MAX_CHECKED_GOAL_FILE_BYTES, "recovery-resume");
		if (!sameRegularFile(duplicate.file, snapshot.identity) || !duplicate.file.bytes.equals(snapshot.bytes)) {
			try {
				restoreClaimedRegularFile(ctx.cwd, sourcePath, duplicate);
			} catch {
				// Preserve the private claim if a successor won the canonical name.
			}
			throw new Error(`The restored active path for ${entry.goalId} changed while recovery reclaimed it.`);
		}
		discardClaimedRegularFile(ctx.cwd, duplicate);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { current, claim: { sourcePath, backupPath, snapshot } };
}

/** Scan the goals dir for active_goal files that fail to parse or cannot be read safely. */
function scanMalformedGoalFiles(ctx: GoalFileContext): MalformedGoalFileEntry[] {
	const root = goalsDir(ctx);
	const out: MalformedGoalFileEntry[] = [];
	for (const name of readdirIfPresent(ctx, root)) {
		if (!/^active_goal_.*\.md$/.test(name)) continue;
		const relPath = path.posix.join(GOALS_DIR, name);
		try {
			if (!parseGoalFileChecked(ctx, path.join(root, name))) out.push({ relPath, error: "file does not parse as a goal record" });
		} catch (error) {
			out.push({ relPath, error: `file cannot be read safely: ${recoveryFailureMessage(error)}` });
		}
	}
	return out;
}

/** Completed records left at an active path by a crash or failed archive. */
function scanCompletedActiveGoals(ctx: GoalFileContext): CompletedActiveGoalEntry[] {
	const root = goalsDir(ctx);
	const out: CompletedActiveGoalEntry[] = [];
	for (const name of readdirIfPresent(ctx, root)) {
		if (!/^active_goal_.*\.md$/.test(name)) continue;
		const activePath = path.posix.join(GOALS_DIR, name);
		if (!isSafeActivePath(ctx, activePath)) continue;
		let parsed: GoalRecord | null;
		try {
			parsed = parseGoalFileChecked(ctx, path.join(root, name));
		} catch {
			continue; // reported as malformed
		}
		if (parsed?.status === "complete") out.push({ goalId: parsed.id, activePath });
	}
	return out;
}

/**
 * Locks whose owner pid is dead or whose payload is malformed. Each lock is
 * read through the checked file boundary; a symlinked or non-regular lock
 * fails the report instead of being followed.
 */
function scanStaleLocks(ctx: GoalFileContext): StaleLockEntry[] {
	const out: StaleLockEntry[] = [];
	for (const name of readdirIfPresent(ctx, locksDir(ctx))) {
		// Only names acquireGoalLock can create; anything else is not a goal lock.
		if (!/^[A-Za-z0-9._-]+\.lock$/.test(name)) continue;
		const stale = inspectGoalLock(ctx, name);
		if (stale) out.push({ fileName: name, pid: stale.pid, startedAt: stale.startedAt, ageMs: stale.ageMs });
	}
	return out;
}

/** Ownership gates left behind by a crashed acquisition; these fail closed. */
function scanAbandonedGates(ctx: GoalFileContext): StaleLockEntry[] {
	const out: StaleLockEntry[] = [];
	for (const name of readdirIfPresent(ctx, locksDir(ctx))) {
		if (!/^[A-Za-z0-9._-]+\.lock\.gate$/.test(name)) continue;
		const stale = inspectGoalLockGate(ctx, name);
		if (stale) out.push({ fileName: name, pid: stale.pid, startedAt: stale.startedAt, ageMs: stale.ageMs });
	}
	return out;
}

/** Snapshot goals whose active file no longer exists in the goals dir. */
function scanOrphanedSnapshotGoals(ctx: GoalFileContext): OrphanedSnapshotEntry[] {
	const out: OrphanedSnapshotEntry[] = [];
	const present = new Set(readdirIfPresent(ctx, goalsDir(ctx)));
	let source: string;
	try {
		source = readRegularFile(ctx.cwd, goalPoolSnapshotPath(ctx), MAX_CHECKED_POOL_SNAPSHOT_BYTES).bytes.toString("utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source) as unknown;
	} catch {
		// A corrupt derived snapshot is ignored; the authoritative goal files
		// remain available for the cold pool scan.
		return out;
	}
	const goals = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { goals?: unknown }).goals : undefined;
	if (!Array.isArray(goals)) return out;
	for (const candidate of goals) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const goal = candidate as Record<string, unknown>;
		const activePath = typeof goal.activePath === "string" ? goal.activePath : "";
		const base = path.posix.basename(activePath);
		if (base && !present.has(base)) {
			const goalId = typeof goal.id === "string" ? goal.id : typeof goal.goalId === "string" ? goal.goalId : base;
			out.push({ goalId, activePath });
		}
	}
	return out;
}

/** Read-only recovery report. Never mutates goal storage. */
export function runRecoveryReport(ctx: GoalFileContext): RecoveryReport {
	// Only the malformed-line count is needed; the window stays minimal.
	const ledger = readGoalLedger(ctx, { maxEvents: 1 });
	const malformedGoalFiles = scanMalformedGoalFiles(ctx);
	const staleLocks = scanStaleLocks(ctx);
	const abandonedGates = scanAbandonedGates(ctx);
	const orphanedSnapshotGoals = scanOrphanedSnapshotGoals(ctx);
	const completedActiveGoals = scanCompletedActiveGoals(ctx);
	const pendingRecoveryLedger = scanPendingRecoveryLedger(ctx);
	return {
		scannedAt: new Date().toISOString(),
		malformedGoalFiles,
		malformedLedgerLines: ledger.malformed,
		staleLocks,
		abandonedGates,
		orphanedSnapshotGoals,
		completedActiveGoals,
		pendingRecoveryLedger,
		healthy: malformedGoalFiles.length === 0
			&& ledger.malformed === 0
			&& staleLocks.length === 0
			&& abandonedGates.length === 0
			&& orphanedSnapshotGoals.length === 0
			&& completedActiveGoals.length === 0
			&& pendingRecoveryLedger.length === 0,
	};
}

function hasRepairableIssues(report: RecoveryReport): boolean {
	return report.staleLocks.length > 0
		|| report.orphanedSnapshotGoals.length > 0
		|| report.completedActiveGoals.length > 0
		|| report.pendingRecoveryLedger.length > 0;
}

/**
 * Apply the safe repair operations with confirmation + backup.
 *
 * Repairs: stale-lock removal (backed up, revalidated under the lock's
 * ownership gate, then removed); stranded-completion archival under the
 * goal lock (backed up first, with a durable marker so an interrupted repair
 * resumes to the same archive); recovery-ledger backfill of the goal_completed
 * and goal_archived events those archives lack; and pool-snapshot refresh
 * (backed up then rewritten from a fresh scan). Every failure is returned
 * with its operation and stage. When `confirm` rejects, nothing is touched.
 */
export async function runRecoveryRepair(
	ctx: GoalFileContext,
	report: RecoveryReport,
	confirm: () => Promise<boolean>,
): Promise<RecoveryRepairResult> {
	if (!hasRepairableIssues(report)) {
		return { applied: [], failures: [], backupDir: null, confirmed: false };
	}
	const confirmed = await confirm();
	if (!confirmed) return { applied: [], failures: [], backupDir: null, confirmed: false };

	const applied: string[] = [];
	const failures: RecoveryRepairFailure[] = [];
	const fail = (operation: RecoveryRepairFailure["operation"], stage: string, target: string, error: unknown): void => {
		failures.push({ operation, stage, target, message: recoveryFailureMessage(error) });
	};
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupRoot = goalStoragePath(ctx, RECOVERY_BACKUP_DIR);
	let backupDir: string;
	try {
		ensureGoalStorageDirectory(ctx, RECOVERY_BACKUP_DIR);
		backupDir = fs.mkdtempSync(path.join(backupRoot, `${stamp}-`));
	} catch (error) {
		fail("prepare_backup", "mkdir", backupRoot, error);
		return { applied, failures, backupDir: null, confirmed: true };
	}
	const pendingLedger = new Map(report.pendingRecoveryLedger.map((entry) => [entry.fileName, entry]));

	for (const gate of report.abandonedGates) {
		fail("remove_abandoned_gate", "offline_required", gate.fileName, new Error("Repair never removes an ownership gate. Stop every Goal X session in this project, confirm its pid is gone, and delete the gate by hand."));
	}

	for (const lock of report.staleLocks) {
		try {
			// Refused when the owner came back to life or the lock changed since the report.
			recoverStaleGoalLock(ctx, lock.fileName, (bytes) => {
				fs.writeFileSync(path.join(backupDir, `lock-${safeLockName(lock.fileName)}`), bytes, { flag: "wx" });
			});
			applied.push(`removed stale lock ${lock.fileName}`);
		} catch (error) {
			fail("remove_stale_lock", goalLockRecoveryFailure(error)?.stage ?? "validate", lock.fileName, error);
		}
	}

	for (const completed of report.completedActiveGoals) {
		let lock;
		try {
			lock = acquireGoalLock(ctx, completed.goalId);
		} catch (error) {
			fail("archive_completed_goal", "lock", completed.goalId, error);
			continue;
		}
		withGoalLock(lock, () => {
			let stage = "validate";
			try {
				if (!isSafeActivePath(ctx, completed.activePath)) throw new Error("active path is unsafe");
				const snapshot = readGoalFileSnapshotChecked(ctx, resolveGoalPath(ctx, GOALS_DIR, completed.activePath));
				const current = snapshot.goal;
				if (!current || current.id !== completed.goalId || current.status !== "complete" || current.activePath !== completed.activePath) {
					throw new Error("completed goal no longer matches the recovery report");
				}
				const pending = preparePendingRecoveryLedger(
					ctx,
					current,
					snapshot.bytes,
					new Date().toISOString(),
					path.join(backupDir, `completed-${safeLockName(completed.goalId)}.md`),
				);
				stage = "backup";
				let claim: RecoveryGoalFileClaim;
				let claimed = current;
				try {
					const resumed = resumeRecoveryClaim(ctx, pending);
					claim = resumed.claim;
					claimed = resumed.current;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					claim = claimGoalFileForRecovery(ctx, current, snapshot, resolveRecoveryBackupPath(ctx, pending.backupPath));
				}
				stage = "archive";
				const archived = archiveClaimedGoalFile(ctx, claimed, claim, pending.archivedAt, pending.archivePath);
				if (archived.archivedPath !== pending.archivePath) {
					throw new Error(`Recovered archive path for ${claimed.id} diverged from its pending ledger marker.`);
				}
				applied.push(`archived recovered completed goal ${completed.goalId}`);
				pendingLedger.set(pending.fileName, pending);
			} catch (error) {
				fail("archive_completed_goal", stage, completed.goalId, error);
			}
		}, (error) => fail("archive_completed_goal", "release", completed.goalId, error));
	}

	for (const pending of pendingLedger.values()) {
		let lock;
		try {
			lock = acquireGoalLock(ctx, pending.goalId);
		} catch (error) {
			fail("append_recovery_ledger", "lock", pending.goalId, error);
			continue;
		}
		withGoalLock(lock, () => {
			let stage = "read";
			try {
				const marker = readPendingRecoveryLedgerMarker(ctx, pending.fileName);
				const entry = marker.entry;
				const archiveFile = resolveGoalPath(ctx, ARCHIVED_GOALS_DIR, entry.archivePath);
				let archiveSnapshot;
				try {
					archiveSnapshot = readGoalFileSnapshotChecked(ctx, archiveFile);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					stage = "resume_archive";
					const resumed = resumeRecoveryClaim(ctx, entry);
					archiveClaimedGoalFile(ctx, resumed.current, resumed.claim, entry.archivedAt, entry.archivePath);
					applied.push(`archived recovered completed goal ${entry.goalId}`);
					archiveSnapshot = readGoalFileSnapshotChecked(ctx, archiveFile);
				}
				const archived = archiveSnapshot.goal;
				if (
					!archived
					|| archived.id !== entry.goalId
					|| archived.status !== "complete"
					|| archived.archivedPath !== entry.archivePath
					|| sha256(archiveSnapshot.bytes) !== entry.archiveSha256
				) throw new Error(`Pending recovery ledger for ${entry.goalId} has no matching archived goal.`);

				const facts = readGoalLedgerForGoal(ctx, entry.goalId, { maxEvents: 1 });
				const events: GoalLedgerEvent[] = [];
				// Completion is a lifecycle fact; historical completion events may be
				// pathless, so an existing one is never duplicated.
				if (facts.completedAt === undefined) events.push({ type: "goal_completed", goalId: entry.goalId, archivePath: entry.archivePath, at: entry.completedAt });
				if (facts.archivedArchivePath !== entry.archivePath) events.push({ type: "goal_archived", goalId: entry.goalId, archivePath: entry.archivePath, at: entry.archivedAt });
				stage = "append";
				const ledger = appendGoalEvents(ctx, events);
				if (!ledger.ok) {
					fail("append_recovery_ledger", stage, entry.goalId, ledger.error);
					return;
				}
				stage = "backup";
				fs.writeFileSync(path.join(backupDir, `pending-${entry.fileName}`), marker.bytes, { flag: "wx" });
				stage = "remove_marker";
				const claim = claimRegularFile(ctx.cwd, marker.filePath, MAX_RECOVERY_LEDGER_MARKER_BYTES, "recovery-ledger");
				if (!sameRegularFile(marker.identity, claim.file) || !marker.bytes.equals(claim.file.bytes)) {
					try {
						restoreClaimedRegularFile(ctx.cwd, marker.filePath, claim);
					} catch {
						// Preserve the private claim and never overwrite a successor marker.
					}
					throw new Error(`Recovery-ledger marker for ${entry.goalId} changed before removal.`);
				}
				discardClaimedRegularFile(ctx.cwd, claim);
				applied.push(`reconciled recovery ledger for ${entry.goalId}`);
			} catch (error) {
				fail("append_recovery_ledger", stage, pending.goalId, error);
			}
		}, (error) => fail("append_recovery_ledger", "release", pending.goalId, error));
	}

	if (report.orphanedSnapshotGoals.length > 0) {
		const snapshotPath = goalPoolSnapshotPath(ctx);
		let stage = "backup";
		try {
			try {
				const snapshot = readRegularFile(ctx.cwd, snapshotPath, MAX_CHECKED_POOL_SNAPSHOT_BYTES);
				fs.writeFileSync(path.join(backupDir, "pool-snapshot.json"), snapshot.bytes, { flag: "wx" });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			// Rebuild from an uncached scan and publish the replacement before
			// claiming that any orphaned entry was dropped.
			stage = "refresh";
			refreshActiveGoalPoolSnapshot(ctx);
			applied.push(`refreshed pool snapshot (${report.orphanedSnapshotGoals.length} orphaned entr${report.orphanedSnapshotGoals.length === 1 ? "y" : "ies"} dropped)`);
		} catch (error) {
			fail("refresh_pool_snapshot", stage, snapshotPath, error);
		}
	}

	return { applied, failures, backupDir, confirmed: true };
}

export function formatRecoveryReport(report: RecoveryReport, commands?: GoalCommands): string {
	const lines: string[] = [];
	lines.push(report.healthy ? "Recovery report: OK — no issues found." : "Recovery report: issues found.");
	if (report.malformedGoalFiles.length > 0) {
		lines.push(`  - ${report.malformedGoalFiles.length} malformed goal file(s):`);
		for (const f of report.malformedGoalFiles) lines.push(`      ${f.relPath} — ${f.error}`);
	}
	if (report.malformedLedgerLines > 0) {
		lines.push(`  - ${report.malformedLedgerLines} malformed ledger line(s) (read-only; manual review advised)`);
	}
	if (report.staleLocks.length > 0) {
		lines.push(`  - ${report.staleLocks.length} stale lock(s):`);
		for (const l of report.staleLocks) lines.push(`      ${l.fileName} (pid ${l.pid}, ${Math.round(l.ageMs / 1000)}s old)`);
	}
	if (report.abandonedGates.length > 0) {
		lines.push(`  - ${report.abandonedGates.length} abandoned lock ownership gate(s):`);
		for (const gate of report.abandonedGates) lines.push(`      ${gate.fileName} (pid ${gate.pid}, ${Math.round(gate.ageMs / 1000)}s old)`);
		lines.push("      repair never removes these; stop every Goal X session in this project, then delete each gate by hand");
	}
	if (report.orphanedSnapshotGoals.length > 0) {
		lines.push(`  - ${report.orphanedSnapshotGoals.length} orphaned snapshot entr${report.orphanedSnapshotGoals.length === 1 ? "y" : "ies"}:`);
		for (const o of report.orphanedSnapshotGoals) lines.push(`      ${o.goalId} (${o.activePath})`);
	}
	if (report.completedActiveGoals.length > 0) {
		lines.push(`  - ${report.completedActiveGoals.length} completed goal record(s) still at active paths:`);
		for (const goal of report.completedActiveGoals) lines.push(`      ${goal.goalId} (${goal.activePath})`);
	}
	if (report.pendingRecoveryLedger.length > 0) {
		lines.push(`  - ${report.pendingRecoveryLedger.length} pending recovery-ledger backfill(s):`);
		for (const pending of report.pendingRecoveryLedger) lines.push(`      ${pending.goalId} (${pending.archivePath})`);
	}
	if (hasRepairableIssues(report)) {
		const route = commandPaths(commands, "goal-recovery")[0];
		lines.push(route
			? `Run \`/${route} repair\` to archive stranded completions, backfill their ledger events, remove stale locks and refresh the pool snapshot (confirmation + backup required).`
			: "Enable a recovery command in /goal-settings controls to repair these files (confirmation + backup required).");
	}
	return lines.join("\n");
}
