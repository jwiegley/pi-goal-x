/**
 * Reading and writing goal files, and the caches in front of them.
 *
 * The text format lives in goal-file-format.ts, path rules in goal-paths.ts
 * and the persisted pool snapshot in goal-pool-snapshot.ts. This module owns
 * the disk access and the three in-memory caches (file parses, directory
 * listings and the zero-op pool).
 */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { parseGoalFileContent, serializeGoalFile } from "./goal-file-format.ts";
import {
	assertSafeFileAncestors,
	atomicWriteRegularFile,
	claimRegularFile,
	discardClaimedRegularFile,
	readRegularFile,
	readRegularFileAsync,
	restoreClaimedRegularFile,
	sameRegularFile,
	type RegularFileIdentity,
} from "./safe-fs.ts";
import {
	ARCHIVED_GOALS_DIR,
	GOALS_DIR,
	activePathForGoal,
	archivedPathForGoal,
	isActiveGoalFileName,
	isSafeActivePath,
	resolveGoalPath,
	sanitizeGoalPaths,
	type GoalFileContext,
} from "./goal-paths.ts";
import {
	poolFromSnapshot,
	readPoolSnapshotAsync,
	readPoolSnapshotSync,
	legacyPath as poolSnapshotLegacyPath,
	updatePoolSnapshotSync,
	writePoolSnapshotAsync,
	writePoolSnapshotSync,
	writePoolSnapshotSyncChecked,
} from "./goal-pool-snapshot.ts";
import { ensureGoalStorageDirectory, goalPoolSnapshotPath, goalStoragePath, isExternalGoalStorage } from "./goal-root.ts";
import { normalizeRelPath, nowIso, type GoalRecord } from "../goal-record.ts";

// The rest of the code imports these names from here.
export { ARCHIVED_GOALS_DIR, GOALS_DIR, activePathForGoal, archivedPathForGoal, resolveGoalPath, sanitizeGoalPaths, serializeGoalFile };
export type { GoalFileContext };
export const MAX_CHECKED_GOAL_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_CHECKED_POOL_SNAPSHOT_BYTES = 16 * 1024 * 1024;

/** The bytes and identity of one goal file, read from a single checked descriptor. */
/** A completed active record moved into a permanent recovery backup by /goal-recovery. */
export interface RecoveryGoalFileClaim {
	sourcePath: string;
	backupPath: string;
	snapshot: GoalFileSnapshot;
}

export interface GoalFileSnapshot {
	identity: RegularFileIdentity;
	bytes: Buffer;
	goal: GoalRecord | null;
}

/**
 * Per-file parse cache, keyed by (absolute path, mtime, size). A steady-state
 * parse costs one lstat instead of lstat + read + JSON parse. Every parse
 * call site shares it and writers drop the entries they touch.
 */
interface GoalFileParseCacheEntry {
	mtimeMs: number;
	size: number;
	parsed: GoalRecord | null;
}

const goalFileParseCache = new Map<string, GoalFileParseCacheEntry>();

/** Directory listing cache (names only): keyed by (absolute path, dir mtime). */
interface GoalDirListingCacheEntry {
	mtimeMs: number;
	names: string[];
}

const goalDirListingCache = new Map<string, GoalDirListingCacheEntry>();

/**
 * Zero-op pool cache (NAF 2026-08-06): the fully scanned active pool per
 * goals dir, served without any stat. Every extension write (atomic write,
 * unlink, archive) drops it, so extension-made changes are always seen.
 * Edits made outside the extension go stale mid-session (see the naf spec).
 * The persist path re-reads the goal file under the lock, so cross-process
 * revision conflicts are still detected.
 */
const goalPoolCache = new Map<string, Map<string, GoalRecord>>();

/** Session boundary (session_start / resume): the next read rescans the pool from disk. */
export function invalidateGoalPoolCache(): void {
	goalPoolCache.clear();
	goalFileParseCache.clear();
	goalDirListingCache.clear();
}

function invalidateGoalPathCaches(filePath: string): void {
	goalFileParseCache.delete(filePath);
}

function invalidateGoalDirCache(root: string): void {
	goalDirListingCache.delete(root);
	goalPoolCache.delete(root);
}

export function ensureDirectory(ctx: GoalFileContext, relPath: string): void {
	ensureGoalStorageDirectory(ctx, relPath);
}

/** One metadata read suffices for existence and symlink checks; retain real IO errors. */
function statIfPresent(filePath: string): fs.Stats | undefined {
	try { return fs.lstatSync(filePath); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function atomicWriteGoalFile(ctx: GoalFileContext, rootRel: string, relPath: string, content: string, options: { replace?: boolean } = {}): void {
	ensureDirectory(ctx, rootRel);
	const filePath = resolveGoalPath(ctx, rootRel, relPath);
	atomicWriteRegularFile(ctx.cwd, filePath, Buffer.from(content, "utf8"), options);
	invalidateGoalPathCaches(filePath);
	invalidateGoalDirCache(goalStoragePath(ctx, rootRel));
}

export function safeUnlinkGoalFile(ctx: GoalFileContext, rootRel: string, relPath: string, goalId?: string): void {
	if (rootRel === GOALS_DIR && !isSafeActivePath(ctx, relPath)) {
		throw new Error(`Refusing to unlink invalid active goal path: ${relPath}`);
	}
	const filePath = resolveGoalPath(ctx, rootRel, relPath);
	assertSafeFileAncestors(ctx.cwd, filePath);
	const stat = statIfPresent(filePath);
	if (stat && stat.isFile()) {
		fs.unlinkSync(filePath);
		invalidateGoalPathCaches(filePath);
		invalidateGoalDirCache(goalStoragePath(ctx, rootRel));
		if (rootRel === GOALS_DIR) {
			const root = goalStoragePath(ctx, GOALS_DIR);
			const normalized = normalizeRelPath(relPath);
			updatePoolSnapshotSync(ctx, root, (goals) => goals.filter((g) =>
				(goalId === undefined || g.id !== goalId)
				&& normalizeRelPath(g.activePath ?? "") !== normalized));
		}
	}
}

/**
 * Parse goal-file text and remember the result in the parse cache. Text that
 * is not even a JSON object is not cached; text that is valid but holds no
 * usable goal is cached as null, so it is not re-read until the file changes.
 */
function parseAndCache(filePath: string, mtimeMs: number, size: number, content: string): GoalRecord | null {
	const parsed = parseGoalFileContent(content);
	if (parsed === undefined) return null;
	goalFileParseCache.set(filePath, { mtimeMs, size, parsed });
	return parsed;
}

export function parseGoalFile(filePath: string): GoalRecord | null {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(filePath);
	} catch {
		goalFileParseCache.delete(filePath);
		return null;
	}
	if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CHECKED_GOAL_FILE_BYTES) return null;
	const cached = goalFileParseCache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.parsed;
	}
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	return parseAndCache(filePath, stat.mtimeMs, stat.size, content);
}

/**
 * Fresh goal-file parse for paths that must distinguish malformed content
 * (null) from an lstat/read failure (throw). It always reads the current
 * bytes through one checked descriptor, then refreshes the parse cache.
 */
export function parseGoalFileChecked(ctx: GoalFileContext, filePath: string): GoalRecord | null {
	const file = readRegularFile(ctx.cwd, filePath, MAX_CHECKED_GOAL_FILE_BYTES);
	return parseAndCache(filePath, file.mtimeMs, file.size, file.bytes.toString("utf8"));
}

/** Bounded parse tied to the exact regular-file descriptor whose bytes it returns. */
export function readGoalFileSnapshotChecked(ctx: GoalFileContext, filePath: string): GoalFileSnapshot {
	const file = readRegularFile(ctx.cwd, filePath, MAX_CHECKED_GOAL_FILE_BYTES);
	return {
		identity: file,
		bytes: file.bytes,
		goal: parseAndCache(filePath, file.mtimeMs, file.size, file.bytes.toString("utf8")),
	};
}

export function sameGoalFileSnapshot(left: GoalFileSnapshot, right: GoalFileSnapshot): boolean {
	return sameRegularFile(left.identity, right.identity) && left.bytes.equals(right.bytes);
}

/**
 * Archival cannot safely publish a remove-only snapshot delta: a successor may
 * claim the just-vacated active pathname at any time. Drop both derived
 * snapshot generations so the next pool read scans authoritative files and
 * cannot hide that successor.
 */
function discardArchivedPoolSnapshots(ctx: GoalFileContext, filePath: string): void {
	invalidateGoalPathCaches(filePath);
	const root = goalStoragePath(ctx, GOALS_DIR);
	invalidateGoalPoolCache();
	invalidateGoalDirCache(root);
	for (const snapshotPath of [goalPoolSnapshotPath(ctx), poolSnapshotLegacyPath(root)]) {
		try {
			assertSafeFileAncestors(ctx.cwd, snapshotPath);
			fs.unlinkSync(snapshotPath);
		} catch {
			// Snapshots are derived. The authoritative goals-directory rename has
			// already changed its mtime, so a surviving snapshot will fail freshness
			// validation; never turn committed archival into a reported failure.
		}
	}
}


export function writeActiveGoalFile(ctx: GoalFileContext, current: GoalRecord): GoalRecord {
	const activePath = activePathForGoal(ctx, current);
	const next = sanitizeGoalPaths(ctx, { ...current, activePath, updatedAt: nowIso() });
	atomicWriteGoalFile(ctx, GOALS_DIR, activePath, serializeGoalFile(next));
	// Keep the persisted pool snapshot current (read-modify-write, best-effort).
	updatePoolSnapshotSync(ctx, goalStoragePath(ctx, GOALS_DIR), (goals) => {
		const rest = goals.filter((g) => g.id !== next.id);
		rest.push(next);
		return rest;
	});
	return next;
}

export function recoveredArchivedGoal(ctx: GoalFileContext, current: GoalRecord, archivedAt: string, archivedPath = archivedPathForGoal(ctx, current)): GoalRecord {
	const next = sanitizeGoalPaths(ctx, { ...current, archivedPath, updatedAt: archivedAt });
	delete next.activePath;
	return next;
}
/**
 * Archive the active goal file whose bytes and identity the caller validated
 * (normally under the goal lock) as `expectedSource`; without one, the file
 * as read at the start of archival must still describe `current`.
 *
 * The archive is published first, without clobbering an existing archive, so
 * a crash always leaves the active record or its archive visible. Then the
 * exact active inode is claimed by renaming it into a private directory and
 * compared with `expectedSource`; a replacement written by another writer is
 * restored (never deleted) and the archive fails. A byte-exact archive left
 * by an interrupted earlier attempt is adopted instead of failing every retry.
 * Committed archival never turns into a failure: a private claim that cannot
 * be removed is reported through `onCleanupFailure` for manual cleanup.
 */
export function archiveGoalFile(
	ctx: GoalFileContext,
	current: GoalRecord,
	expectedSource?: GoalFileSnapshot,
	onCleanupFailure: (error: unknown, quarantinePath: string) => void = () => {},
): GoalRecord {
	if (!isSafeActivePath(ctx, current.activePath)) {
		throw new Error(`Cannot archive goal ${current.id}: active path is missing or unsafe.`);
	}
	const sourcePath = resolveGoalPath(ctx, GOALS_DIR, current.activePath);
	const observed = readGoalFileSnapshotChecked(ctx, sourcePath);
	// Without a caller-validated snapshot, archive the bytes observed now.
	expectedSource ??= observed;
	if (!sameGoalFileSnapshot(observed, expectedSource)) {
		throw new Error(`Cannot archive goal ${current.id}: active file changed before archival.`);
	}
	const sourceRevision = expectedSource.goal?.revision ?? 0;
	const currentRevision = current.revision ?? 0;
	if (
		!expectedSource.goal
		|| expectedSource.goal.id !== current.id
		|| expectedSource.goal.activePath !== current.activePath
		|| (currentRevision !== sourceRevision && currentRevision !== sourceRevision + 1)
	) {
		throw new Error(`Cannot archive goal ${current.id}: active file no longer matches.`);
	}
	const archivedPath = archivedPathForGoal(ctx, current);
	let next = sanitizeGoalPaths(ctx, { ...current, archivedPath, updatedAt: nowIso() });
	delete next.activePath;
	try {
		atomicWriteGoalFile(ctx, ARCHIVED_GOALS_DIR, archivedPath, serializeGoalFile(next), { replace: false });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		// A crash may have published this exact logical archive before removing the
		// active name. Accept only a byte-exact reconstruction using the archive's
		// persisted timestamp; unrelated collisions remain hard failures.
		const existing = readGoalFileSnapshotChecked(ctx, resolveGoalPath(ctx, ARCHIVED_GOALS_DIR, archivedPath));
		if (!existing.goal) throw error;
		const expectedExisting = recoveredArchivedGoal(ctx, current, existing.goal.updatedAt, archivedPath);
		if (existing.bytes.equals(Buffer.from(serializeGoalFile(expectedExisting), "utf8"))) {
			next = existing.goal;
		} else if (existing.goal.id === current.id && current.archivedPath === undefined) {
			// An earlier publish-before-remove attempt may have archived an older
			// version at the timestamp-derived name. Preserve it and publish this
			// version at a deterministic content-qualified name so the failed
			// attempt cannot poison every retry.
			const suffix = createHash("sha256").update(serializeGoalFile(current)).digest("hex").slice(0, 16);
			const qualifiedPath = archivedPath.endsWith(".md") ? `${archivedPath.slice(0, -3)}_${suffix}.md` : `${archivedPath}_${suffix}`;
			next = sanitizeGoalPaths(ctx, { ...next, archivedPath: qualifiedPath });
			try {
				atomicWriteGoalFile(ctx, ARCHIVED_GOALS_DIR, qualifiedPath, serializeGoalFile(next), { replace: false });
			} catch (qualifiedError) {
				if ((qualifiedError as NodeJS.ErrnoException).code !== "EEXIST") throw qualifiedError;
				const qualifiedExisting = readGoalFileSnapshotChecked(ctx, resolveGoalPath(ctx, ARCHIVED_GOALS_DIR, qualifiedPath));
				if (!qualifiedExisting.goal) throw qualifiedError;
				const expectedQualified = recoveredArchivedGoal(ctx, current, qualifiedExisting.goal.updatedAt, qualifiedPath);
				if (!qualifiedExisting.bytes.equals(Buffer.from(serializeGoalFile(expectedQualified), "utf8"))) throw qualifiedError;
				next = qualifiedExisting.goal;
			}
		} else {
			throw error;
		}
	}

	// Claim the exact inode read above; a replacement is restored and reported
	// instead of being deleted by pathname.
	const claim = claimRegularFile(ctx.cwd, sourcePath, MAX_CHECKED_GOAL_FILE_BYTES, "archive");
	if (!sameRegularFile(expectedSource.identity, claim.file) || !expectedSource.bytes.equals(claim.file.bytes)) {
		try {
			restoreClaimedRegularFile(ctx.cwd, sourcePath, claim);
		} catch {
			// A successor owns the canonical path. Preserve the mismatched private
			// claim for manual recovery and never overwrite or delete the successor.
		}
		throw new Error(`Cannot archive goal ${current.id}: active file changed while being claimed.`);
	}
	try {
		discardClaimedRegularFile(ctx.cwd, claim);
	} catch (error) {
		// Archive publication and the exact-inode claim are already committed.
		// Keep the private name for manual cleanup instead of inviting a retry
		// that cannot find the removed active source.
		try {
			onCleanupFailure(error, claim.quarantinePath);
		} catch {}
	}
	discardArchivedPoolSnapshots(ctx, sourcePath);
	return next;
}

function restoreRecoveryClaim(ctx: GoalFileContext, claim: RecoveryGoalFileClaim): void {
	assertSafeFileAncestors(ctx.cwd, claim.sourcePath);
	assertSafeFileAncestors(ctx.cwd, claim.backupPath);
	try {
		fs.lstatSync(claim.sourcePath);
		return; // A successor owns the canonical name; leave it untouched.
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Keep the permanent backup and restore the active name as another hard link.
	fs.linkSync(claim.backupPath, claim.sourcePath);
	invalidateGoalPathCaches(claim.sourcePath);
	invalidateGoalDirCache(goalStoragePath(ctx, GOALS_DIR));
}

/**
 * Move a completed active record into a permanent recovery backup: publish the
 * backup as a no-clobber hard link first, then claim and remove exactly the
 * validated active inode. A crash from the link onward leaves the active
 * name, the backup, or both, so a retry never depends on a random private
 * name; a successor that appears at the active path is never removed.
 */
export function claimGoalFileForRecovery(
	ctx: GoalFileContext,
	current: GoalRecord,
	expected: GoalFileSnapshot,
	backupPath: string,
): RecoveryGoalFileClaim {
	if (!isSafeActivePath(ctx, current.activePath)) {
		throw new Error(`Cannot archive goal ${current.id}: active path is missing or unsafe.`);
	}
	const source = resolveGoalPath(ctx, GOALS_DIR, current.activePath);
	const beforeLink = readGoalFileSnapshotChecked(ctx, source);
	if (!sameGoalFileSnapshot(beforeLink, expected)) {
		throw new Error(`Active goal ${current.id} changed after its recovery backup was prepared.`);
	}
	assertSafeFileAncestors(ctx.cwd, backupPath);
	fs.linkSync(source, backupPath);
	const snapshot = readGoalFileSnapshotChecked(ctx, backupPath);
	if (!sameGoalFileSnapshot(snapshot, expected)) {
		throw new Error(`Recovery backup for ${current.id} changed during publication.`);
	}
	const sourceClaim = claimRegularFile(ctx.cwd, source, MAX_CHECKED_GOAL_FILE_BYTES, "recovery-backup");
	try {
		if (!sameRegularFile(sourceClaim.file, snapshot.identity) || !sourceClaim.file.bytes.equals(snapshot.bytes)) {
			throw new Error(`Active goal ${current.id} changed while recovery claimed it.`);
		}
		discardClaimedRegularFile(ctx.cwd, sourceClaim);
	} catch (error) {
		try {
			restoreClaimedRegularFile(ctx.cwd, source, sourceClaim);
		} catch {
			// The permanent backup remains available to a marker-driven retry.
		}
		throw error;
	}
	invalidateGoalPathCaches(source);
	invalidateGoalDirCache(goalStoragePath(ctx, GOALS_DIR));
	return { sourcePath: source, backupPath, snapshot };
}

/**
 * Archive a record claimed by claimGoalFileForRecovery at a fixed archive path
 * and timestamp, so a retry reproduces the same bytes. A byte-exact archive
 * left by an interrupted attempt is adopted; a successor at the active path
 * stops the archive and the claim is restored.
 */
export function archiveClaimedGoalFile(
	ctx: GoalFileContext,
	current: GoalRecord,
	claim: RecoveryGoalFileClaim,
	archivedAt = nowIso(),
	archivedPath = archivedPathForGoal(ctx, current),
): GoalRecord {
	const currentBackup = readGoalFileSnapshotChecked(ctx, claim.backupPath);
	if (!sameGoalFileSnapshot(currentBackup, claim.snapshot)) {
		throw new Error(`Recovery backup for ${current.id} changed before archival.`);
	}
	const next = recoveredArchivedGoal(ctx, current, archivedAt, archivedPath);
	const archiveBytes = Buffer.from(serializeGoalFile(next), "utf8");
	const assertNoSuccessor = (when: string): void => {
		try {
			fs.lstatSync(claim.sourcePath);
			throw new Error(`A successor appeared at the active path for ${current.id} ${when}.`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};
	try {
		assertNoSuccessor("before archival");
		try {
			atomicWriteGoalFile(ctx, ARCHIVED_GOALS_DIR, archivedPath, archiveBytes.toString("utf8"), { replace: false });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = readRegularFile(ctx.cwd, resolveGoalPath(ctx, ARCHIVED_GOALS_DIR, archivedPath), MAX_CHECKED_GOAL_FILE_BYTES);
			if (!existing.bytes.equals(archiveBytes)) throw error;
		}
		assertNoSuccessor("during archival");
	} catch (error) {
		try {
			restoreRecoveryClaim(ctx, claim);
		} catch {
			// The permanent backup remains recoverable; never overwrite a successor.
		}
		throw error;
	}
	discardArchivedPoolSnapshots(ctx, claim.sourcePath);
	return next;
}

export function mergeGoalPromptFromDisk(ctx: GoalFileContext, current: GoalRecord): GoalRecord {
	if (!isSafeActivePath(ctx, current.activePath)) return current;
	// The editable prompt must be read from the current active file.
	try {
		const parsed = parseGoalFileChecked(ctx, resolveGoalPath(ctx, GOALS_DIR, current.activePath));
		if (!parsed) return current;
		return { ...current, objective: parsed.objective };
	} catch {
		return current;
	}
}

// ── Pool scan ───────────────────────────────────────────────────────────────

/**
 * Whether a goals dir can be scanned. A symlinked root is refused for an
 * external pool and treated as empty otherwise. Shared by the sync and async scans.
 */
function checkScanRoot(ctx: GoalFileContext, root: string, rootStat: fs.Stats): "scan" | "empty" {
	if (!rootStat.isSymbolicLink()) return "scan";
	if (isExternalGoalStorage(ctx)) throw new Error(`Goal root is a symlink: ${root}`);
	return "empty";
}

function activeGoalNames(names: string[]): string[] {
	return names.filter(isActiveGoalFileName).sort((a, b) => a.localeCompare(b));
}

/** Pool entry for a parsed file: open goals only, with the path pinned to its real location. */
function poolEntry(ctx: GoalFileContext, parsed: GoalRecord | null, relPath: string): GoalRecord | null {
	if (!parsed || parsed.status === "complete") return null;
	return sanitizeGoalPaths(ctx, { ...parsed, activePath: relPath });
}

function poolFromEntries(goals: Iterable<GoalRecord | null>): Map<string, GoalRecord> {
	const pool = new Map<string, GoalRecord>();
	for (const goal of goals) {
		if (goal) pool.set(goal.id, goal);
	}
	return pool;
}

/** Uncached full scan (used when the zero-op pool cache is empty). */
function scanActiveGoalFiles(ctx: GoalFileContext, root: string, options: { surfaceIoErrors?: boolean } = {}): Map<string, GoalRecord> {
	let names: string[];
	try {
		const rootStat = fs.lstatSync(root);
		if (checkScanRoot(ctx, root, rootStat) === "empty") return new Map();
		const cached = goalDirListingCache.get(root);
		if (cached && cached.mtimeMs === rootStat.mtimeMs) names = cached.names;
		else {
			names = activeGoalNames(fs.readdirSync(root));
			goalDirListingCache.set(root, { mtimeMs: rootStat.mtimeMs, names });
		}
	} catch (error) {
		if (options.surfaceIoErrors || isExternalGoalStorage(ctx)) throw error;
		return new Map();
	}
	return poolFromEntries(names.map((name) => {
		const relPath = `${GOALS_DIR}/${name}`;
		if (!isSafeActivePath(ctx, relPath)) return null;
		try {
			return poolEntry(ctx, parseGoalFileChecked(ctx, resolveGoalPath(ctx, GOALS_DIR, relPath)), relPath);
		} catch (error) {
			if (options.surfaceIoErrors) throw error;
			return null;
		}
	}));
}

export function refreshActiveGoalPoolSnapshot(ctx: GoalFileContext): void {
	const root = goalStoragePath(ctx, GOALS_DIR);
	invalidateGoalPoolCache();
	const pool = scanActiveGoalFiles(ctx, root, { surfaceIoErrors: true });
	writePoolSnapshotSyncChecked(ctx, root, Array.from(pool.values()));
	goalPoolCache.set(root, pool);
}

/**
 * Parallel scan: fs.promises readdir plus per-file stat/read in parallel,
 * seeding the parse cache so later sync reads hit it. Used by session startup.
 */
async function scanActiveGoalFilesAsync(ctx: GoalFileContext, root: string): Promise<Map<string, GoalRecord>> {
	let names: string[];
	try {
		const rootStat = await fs.promises.lstat(root);
		if (checkScanRoot(ctx, root, rootStat) === "empty") return new Map();
		names = activeGoalNames(await fs.promises.readdir(root));
	} catch (error) {
		if (isExternalGoalStorage(ctx)) throw error;
		return new Map();
	}
	return poolFromEntries(await Promise.all(names.map(async (name): Promise<GoalRecord | null> => {
		const relPath = `${GOALS_DIR}/${name}`;
		if (!isSafeActivePath(ctx, relPath)) return null;
		const abs = resolveGoalPath(ctx, GOALS_DIR, relPath);
		try {
			const file = await readRegularFileAsync(ctx.cwd, abs, MAX_CHECKED_GOAL_FILE_BYTES);
			return poolEntry(ctx, parseAndCache(abs, file.mtimeMs, file.size, file.bytes.toString("utf8")), relPath);
		} catch {
			return null;
		}
	})));
}

/** Serve a cold snapshot only when the goals directory is unchanged. */
function readPoolWithSnapshotSync(ctx: GoalFileContext, root: string): Map<string, GoalRecord> {
	let rootStat: fs.Stats | null = null;
	try {
		rootStat = fs.lstatSync(root);
	} catch {
		rootStat = null;
	}
	if (rootStat && !rootStat.isSymbolicLink()) {
		const snapshot = readPoolSnapshotSync(ctx, root);
		if (snapshot && snapshot.dirMtimeMs === rootStat.mtimeMs) {
			return poolFromSnapshot(snapshot);
		}
	}
	const pool = scanActiveGoalFiles(ctx, root);
	writePoolSnapshotSync(ctx, root, Array.from(pool.values()));
	return pool;
}

async function readPoolWithSnapshotAsync(ctx: GoalFileContext, root: string): Promise<Map<string, GoalRecord>> {
	let rootStat: fs.Stats | null = null;
	try {
		rootStat = await fs.promises.lstat(root);
	} catch {
		rootStat = null;
	}
	if (rootStat && !rootStat.isSymbolicLink()) {
		const snapshot = await readPoolSnapshotAsync(ctx, root);
		if (snapshot && snapshot.dirMtimeMs === rootStat.mtimeMs) {
			return poolFromSnapshot(snapshot);
		}
	}
	const pool = await scanActiveGoalFilesAsync(ctx, root);
	await writePoolSnapshotAsync(ctx, root, Array.from(pool.values()));
	return pool;
}

export function readActiveGoalPoolView(ctx: GoalFileContext): ReadonlyMap<string, GoalRecord> {
	const root = goalStoragePath(ctx, GOALS_DIR);
	const cached = goalPoolCache.get(root);
	if (cached) return cached;
	const pool = readPoolWithSnapshotSync(ctx, root);
	goalPoolCache.set(root, pool);
	return pool;
}

export function readActiveGoalPool(ctx: GoalFileContext): Map<string, GoalRecord> {
	return new Map(readActiveGoalPoolView(ctx));
}

/**
 * Async pool read for session startup (loadState). Serves the zero-op pool
 * cache when present; a cold read fills it, so the sync reads that follow
 * (reconcile, get_goal, prompts) cost nothing.
 */
export async function readActiveGoalPoolAsync(ctx: GoalFileContext): Promise<Map<string, GoalRecord>> {
	const root = goalStoragePath(ctx, GOALS_DIR);
	const cachedPool = goalPoolCache.get(root);
	if (cachedPool) return new Map(cachedPool);
	const pool = await readPoolWithSnapshotAsync(ctx, root);
	goalPoolCache.set(root, pool);
	return new Map(pool);
}
