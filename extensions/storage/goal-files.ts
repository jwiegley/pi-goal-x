import { goalStoragePath, goalPoolSnapshotPath, isExternalGoalStorage, ensureGoalStorageDirectory, type GoalStorageContext } from "./goal-root.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
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
	formatDuration,
	formatTokenValue,
	statusLabel,
} from "../goal-core.ts";
import {
	cloneGoal,
	normalizeGoalRecord,
	normalizeRelPath,
	nowIso,
	safeIdPart,
	type GoalRecord,
	type TaskStatus,
} from "../goal-record.ts";

export const GOALS_DIR = ".pi/goals";
export const ARCHIVED_GOALS_DIR = ".pi/goals/archived";
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
 * Per-file parse cache (P1-1): keyed by (absolute path, mtime, size), so
 * steady-state parses of goal files cost one lstat instead of lstat+read+
 * JSON-parse. Every parse call site (pool scan, reconcile, merge-from-disk)
 * shares this cache; writers invalidate the entries they touch.
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
 * Zero-op pool cache (NAF 2026-08-06): the fully-scanned active pool per
 * goals dir, served without any stat. Every extension write (atomic write /
 * unlink / archive) invalidates it, so extension-mediated changes are always
 * observed; external (non-extension) file edits go stale mid-session
 * (documented in the naf spec PRODUCT.md). The safety-critical persist path
 * re-reads the goal file directly (parseGoalFile, mtime-keyed) under the
 * lock, so cross-process revision conflicts are still detected.
 */
const goalPoolCache = new Map<string, Map<string, GoalRecord>>();

/**
 * Session boundary (session_start / resume): drop the zero-op pool cache so
 * a new session rescans the goal pool fresh from disk.
 */
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

// ── Persistent pool snapshot (NAF cold-start, 2026-08-06) ───────────────────
// The zero-op pool cache is in-memory; a fresh process (new session) has no
// cache, so a cold pool read re-scanned every goal file (2 fs ops per goal).
// The snapshot persists the pool as ONE file, so a cold read is
// lstat(root) + readFile(snapshot) = 2 ops total, and every extension write
// keeps it current (read-modify-write, +4 ops per mutation — mutations are
// write-floor-exempt in the bench).
//
// Freshness: the snapshot records the goals-dir mtime; if the dir mtime
// changed (goal files added/removed — including external edits), the
// snapshot is invalidated and a full scan re-syncs it. In-place content
// edits to a goal file do NOT change the dir mtime, so a cold read may serve
// the last extension-written snapshot until the next extension write or
// mtime-changing change — the same staleness class as the in-memory pool
// cache's documented mid-session behavior (external hand-edits go stale;
// the safety-critical persist path still re-reads the goal file directly
// via parseGoalFile, mtime-keyed, so cross-process conflicts are detected).
interface PoolSnapshot {
	version: 1;
	dirMtimeMs: number;
	goals: GoalRecord[];
}

const POOL_SNAPSHOT_LEGACY_NAME = ".goals-pool-snapshot.json";

function poolSnapshotLegacyPath(root: string): string {
	return path.join(root, POOL_SNAPSHOT_LEGACY_NAME);
}

/** Read + validate the snapshot; null when missing/corrupt/unsupported. */
function readPoolSnapshotSync(ctx: GoalFileContext, root: string): PoolSnapshot | null {
	const parsed = tryParsePoolSnapshotSync(ctx, goalPoolSnapshotPath(ctx));
	if (parsed) return parsed;
	// One-time migration fallback: a snapshot written before 2026-08-09 lives
	// inside the goals dir; keep serving it until the next write replaces it.
	return tryParsePoolSnapshotSync(ctx, poolSnapshotLegacyPath(root));
}

/** A derived snapshot is read as one bounded regular file below the project, never through a symlink. */
function tryParsePoolSnapshotSync(ctx: GoalFileContext, filePath: string): PoolSnapshot | null {
	try {
		const bytes = readRegularFile(ctx.cwd, filePath, MAX_CHECKED_POOL_SNAPSHOT_BYTES).bytes;
		const data = JSON.parse(bytes.toString("utf8")) as Partial<PoolSnapshot>;
		if (data.version === 1 && Array.isArray(data.goals) && typeof data.dirMtimeMs === "number") {
			return data as PoolSnapshot;
		}
	} catch {
		// missing or corrupt — caller falls back to a full scan
	}
	return null;
}

async function readPoolSnapshotAsync(ctx: GoalFileContext, root: string): Promise<PoolSnapshot | null> {
	return readPoolSnapshotSync(ctx, root);
}

function hydratePoolFromSnapshot(snapshot: PoolSnapshot): Map<string, GoalRecord> {
	const pool = new Map<string, GoalRecord>();
	for (const goal of snapshot.goals) {
		if (goal.status === "complete") continue; // matches scanActiveGoalFiles
		pool.set(goal.id, goal);
	}
	return pool;
}

/** Atomic snapshot write used by both best-effort and checked callers. */
function writePoolSnapshotSyncChecked(ctx: GoalFileContext, root: string, goals: GoalRecord[]): void {
	const rootStat = fs.lstatSync(root);
	const snapshot: PoolSnapshot = { version: 1, dirMtimeMs: rootStat.mtimeMs, goals };
	if (isExternalGoalStorage(ctx)) ensureGoalStorageDirectory(ctx, ".pi/goals/.metadata");
	atomicWriteRegularFile(ctx.cwd, goalPoolSnapshotPath(ctx), Buffer.from(JSON.stringify(snapshot), "utf8"));
	removeLegacyPoolSnapshot(root);
}

/** Best-effort atomic snapshot write through a private exclusive temp file. */
function writePoolSnapshotSync(ctx: GoalFileContext, root: string, goals: GoalRecord[]): void {
	try {
		writePoolSnapshotSyncChecked(ctx, root, goals);
	} catch {
		// best-effort: a missing/stale snapshot just costs a full scan next cold read
	}
}

async function writePoolSnapshotAsync(ctx: GoalFileContext, root: string, goals: GoalRecord[]): Promise<void> {
	writePoolSnapshotSync(ctx, root, goals);
}

/** Merge a delta (written goal or removal) into the persisted snapshot. */
function updatePoolSnapshotSync(ctx: GoalFileContext, root: string, mutate: (goals: GoalRecord[]) => GoalRecord[]): void {
	const snapshot = readPoolSnapshotSync(ctx, root);
	if (!snapshot) return; // no snapshot yet — next cold read does a full scan + write
	snapshot.goals = mutate(snapshot.goals);
	try {
		const rootStat = fs.lstatSync(root);
		snapshot.dirMtimeMs = rootStat.mtimeMs;
		if (isExternalGoalStorage(ctx)) ensureGoalStorageDirectory(ctx, ".pi/goals/.metadata");
		atomicWriteRegularFile(ctx.cwd, goalPoolSnapshotPath(ctx), Buffer.from(JSON.stringify(snapshot), "utf8"));
		removeLegacyPoolSnapshot(root);
	} catch {
		// best-effort
	}
}

/** Best-effort removal of the legacy in-dir snapshot after the first new-location write. */
function removeLegacyPoolSnapshot(root: string): void {
	try {
		fs.unlinkSync(poolSnapshotLegacyPath(root));
	} catch {
		// already absent
	}
}

export type GoalFileContext = GoalStorageContext;

export function timestampForFile(iso = nowIso()): string {
	const date = new Date(iso);
	const safe = Number.isFinite(date.getTime()) ? date : new Date();
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return [
		safe.getFullYear(),
		pad(safe.getMonth() + 1),
		pad(safe.getDate()),
		pad(safe.getHours()),
		pad(safe.getMinutes()),
		pad(safe.getSeconds()),
		pad(Math.floor(safe.getMilliseconds() / 10)),
	].join("");
}

export function isSafeRelativeUnder(ctx: GoalFileContext, rootRel: string, relPath: string | undefined): relPath is string {
	if (!relPath || path.isAbsolute(relPath) || relPath.includes("\0")) return false;
	const normalized = normalizeRelPath(relPath);
	const parent = normalizeRelPath(path.posix.dirname(normalized));
	if (parent !== normalizeRelPath(rootRel)) return false;
	const root = goalStoragePath(ctx, rootRel);
	const absolutePath = goalStoragePath(ctx, normalized);
	const relative = path.relative(root, absolutePath);
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isSafeActivePath(ctx: GoalFileContext, relPath: string | undefined): relPath is string {
	return Boolean(
		isSafeRelativeUnder(ctx, GOALS_DIR, relPath)
			&& /^active_goal_.*\.md$/.test(path.posix.basename(normalizeRelPath(relPath))),
	);
}

export function isSafeArchivedPath(ctx: GoalFileContext, relPath: string | undefined): relPath is string {
	return Boolean(
		isSafeRelativeUnder(ctx, ARCHIVED_GOALS_DIR, relPath)
			&& /^goal_.*\.md$/.test(path.posix.basename(normalizeRelPath(relPath))),
	);
}

export function sanitizeGoalPaths(ctx: GoalFileContext, goal: GoalRecord): GoalRecord {
	const next = cloneGoal(goal);
	if (!isSafeActivePath(ctx, next.activePath)) delete next.activePath;
	if (!isSafeArchivedPath(ctx, next.archivedPath)) delete next.archivedPath;
	return next;
}

export function ensureDirectory(ctx: GoalFileContext, relPath: string): void {
	ensureGoalStorageDirectory(ctx, relPath);
}

export function resolveGoalPath(ctx: GoalFileContext, rootRel: string, relPath: string): string {
	const root = goalStoragePath(ctx, rootRel);
	const absolutePath = goalStoragePath(ctx, normalizeRelPath(relPath));
	const relative = path.relative(root, absolutePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Goal path escapes ${rootRel}: ${relPath}`);
	return absolutePath;
}

/**
 * Replace (or, with `replace: false`, publish without clobbering) one goal file.
 * The bytes go through an exclusive, verified temporary file in a private
 * directory below the project; symlinked components and non-regular targets
 * are refused. See storage/safe-fs.ts for the trust boundary.
 */
export function atomicWriteGoalFile(
	ctx: GoalFileContext,
	rootRel: string,
	relPath: string,
	content: string,
	options: { replace?: boolean } = {},
): void {
	ensureDirectory(ctx, rootRel);
	const filePath = resolveGoalPath(ctx, rootRel, relPath);
	atomicWriteRegularFile(ctx.cwd, filePath, Buffer.from(content, "utf8"), options);
	invalidateGoalPathCaches(filePath);
	invalidateGoalDirCache(goalStoragePath(ctx, rootRel));
}

/** One metadata read suffices for existence and symlink checks; retain real IO errors. */
function statIfPresent(filePath: string): fs.Stats | undefined {
	try { return fs.lstatSync(filePath); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
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

export function makeActiveGoalPath(goal: GoalRecord): string {
	return `${GOALS_DIR}/active_goal_${timestampForFile(goal.createdAt)}_${safeIdPart(goal.id)}.md`;
}

export function makeArchivedGoalPath(goal: GoalRecord): string {
	return `${ARCHIVED_GOALS_DIR}/goal_${timestampForFile(goal.updatedAt)}_${safeIdPart(goal.id)}.md`;
}

export function activePathForGoal(ctx: GoalFileContext, goal: GoalRecord): string {
	return isSafeActivePath(ctx, goal.activePath) ? goal.activePath : makeActiveGoalPath(goal);
}

export function archivedPathForGoal(ctx: GoalFileContext, goal: GoalRecord): string {
	return isSafeArchivedPath(ctx, goal.archivedPath) ? goal.archivedPath : makeArchivedGoalPath(goal);
}

/** The exact archived record produced for `current` when it is archived at `archivedAt`. */
export function recoveredArchivedGoal(
	ctx: GoalFileContext,
	current: GoalRecord,
	archivedAt: string,
	archivedPath = archivedPathForGoal(ctx, current),
): GoalRecord {
	const next = sanitizeGoalPaths(ctx, { ...current, archivedPath, updatedAt: archivedAt });
	delete next.activePath;
	return next;
}

function taskCheckbox(status: TaskStatus): string {
	if (status === "complete") return "x";
	if (status === "skipped") return "~";
	return " ";
}

function taskLineSuffix(task: { status: TaskStatus; evidence?: string; skipReason?: string; verificationContract?: string }): string {
	const parts: string[] = [];
	if (task.status === "complete" && task.evidence) parts.push(`evidence: ${task.evidence}`);
	if (task.status === "skipped" && task.skipReason) parts.push(`skipped: ${task.skipReason}`);
	if ((task.status === "pending") && task.verificationContract) parts.push(`contract: ${task.verificationContract}`);
	return parts.length > 0 ? ` — ${parts.join("; ")}` : "";
}

export function serializeGoalFile(goal: GoalRecord): string {
	const meta = JSON.stringify({ version: 3, ...goal }, null, 2);
	const pauseLines: string[] = [];
	if (goal.pauseReason) pauseLines.push(`- Agent pause reason: ${goal.pauseReason}`);
	if (goal.pauseSuggestedAction) pauseLines.push(`- Agent suggests: ${goal.pauseSuggestedAction}`);
	const pauseBlock = pauseLines.length > 0 ? `\n${pauseLines.join("\n")}` : "";
	let taskSection = "";
	if (goal.taskList) {
		const taskLines = goal.taskList.tasks.map((t) => {
			return `- [${taskCheckbox(t.status)}] ${t.id}: ${t.title}${taskLineSuffix(t)}`;
		});
		taskSection = `\n## Tasks

<!-- blockCompletion: ${goal.taskList.blockCompletion} -->\n${taskLines.join("\n")}\n`;
	}
	const contractLine = goal.verificationContract?.trim() ? `
- Verification contract: ${goal.verificationContract.trim()}` : "";
	return `${meta}

# Goal Prompt

${goal.objective.trim()}

## Progress

- Status: ${statusLabel(goal)}
- Auto-continue: ${goal.autoContinue ? "on" : "off"}
- Sisyphus mode: ${goal.sisyphus ? "yes (prompt/criteria style)" : "no"}
- Time spent: ${formatDuration(goal.usage.activeSeconds)}
- Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}${contractLine}${taskSection}${pauseBlock}
`;
}

export function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i++) {
		const char = content[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === "\"") {
				inString = false;
			}
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth++;
			continue;
		}
		if (char === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

export function extractObjectiveFromBody(body: string): string | undefined {
	const lines = body.replace(/^\s+/, "").split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "# Goal Prompt");
	if (start < 0) return body.trim() || undefined;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "## Progress") {
			end = i;
			break;
		}
	}
	return lines.slice(start + 1, end).join("\n").trim() || undefined;
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
	return parseGoalContentCached(filePath, stat.mtimeMs, stat.size, content);
}

/**
 * Fresh goal-file parse for paths that must distinguish malformed content
 * (null) from an lstat/read failure (throw). It always reads the current
 * bytes through one checked descriptor, then refreshes the parse cache.
 */
export function parseGoalFileChecked(ctx: GoalFileContext, filePath: string): GoalRecord | null {
	const file = readRegularFile(ctx.cwd, filePath, MAX_CHECKED_GOAL_FILE_BYTES);
	return parseGoalContentCached(filePath, file.mtimeMs, file.size, file.bytes.toString("utf8"));
}

/** Bounded parse tied to the exact regular-file descriptor whose bytes it returns. */
export function readGoalFileSnapshotChecked(ctx: GoalFileContext, filePath: string): GoalFileSnapshot {
	const file = readRegularFile(ctx.cwd, filePath, MAX_CHECKED_GOAL_FILE_BYTES);
	return {
		identity: file,
		bytes: file.bytes,
		goal: parseGoalContentCached(filePath, file.mtimeMs, file.size, file.bytes.toString("utf8")),
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

/**
 * Parse goal-file content and seed the P1-1 parse cache (shared by the sync
 * and the parallel async readers). Returns null for malformed content.
 */
export function parseGoalContentCached(filePath: string, mtimeMs: number, size: number, content: string): GoalRecord | null {
	const end = findJsonObjectEnd(content);
	if (end < 0) return null;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(content.slice(0, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
	const objective = extractObjectiveFromBody(content.slice(end + 1)) ?? raw.objective;
	const parsed = normalizeGoalRecord({ ...raw, objective });
	goalFileParseCache.set(filePath, { mtimeMs, size, parsed });
	return parsed;
}

export function writeActiveGoalFile(ctx: GoalFileContext, current: GoalRecord): GoalRecord {
	const activePath = activePathForGoal(ctx, current);
	const next = sanitizeGoalPaths(ctx, { ...current, activePath, updatedAt: nowIso() });
	atomicWriteGoalFile(ctx, GOALS_DIR, activePath, serializeGoalFile(next));
	// Keep the persistent pool snapshot current (read-modify-write, best-effort).
	updatePoolSnapshotSync(ctx, goalStoragePath(ctx, GOALS_DIR), (goals) => {
		const rest = goals.filter((g) => g.id !== next.id);
		rest.push(next);
		return rest;
	});
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
	// Prompt text is a supported hand-edit surface. Read the exact active file
	// here instead of the directory-level pool cache, which may legitimately
	// lag an external body edit.
	try {
		const parsed = parseGoalFileChecked(ctx, resolveGoalPath(ctx, GOALS_DIR, current.activePath));
		if (!parsed) return current;
		return { ...current, objective: parsed.objective };
	} catch {
		return current;
	}
}

export function readActiveGoalFiles(ctx: GoalFileContext): GoalRecord[] {
	const root = goalStoragePath(ctx, GOALS_DIR);
	const cachedPool = goalPoolCache.get(root);
	if (cachedPool) return Array.from(cachedPool.values());
	const goals = scanActiveGoalFiles(ctx, root);
	const pool = new Map<string, GoalRecord>();
	for (const goal of goals) pool.set(goal.id, goal);
	goalPoolCache.set(root, pool);
	return goals;
}

/** Uncached full scan (used when the zero-op pool cache is empty). */
function scanActiveGoalFiles(ctx: GoalFileContext, root: string, options: { surfaceIoErrors?: boolean } = {}): GoalRecord[] {
	let entries: string[];
	try {
		const rootStat = fs.lstatSync(root);
		if (rootStat.isSymbolicLink()) { if (isExternalGoalStorage(ctx)) throw new Error(`Goal root is a symlink: ${root}`); return []; }
		const cachedListing = goalDirListingCache.get(root);
		if (cachedListing && cachedListing.mtimeMs === rootStat.mtimeMs) {
			entries = cachedListing.names;
		} else {
			entries = fs.readdirSync(root)
				.filter((name) => /^active_goal_.*\.md$/.test(name))
				.sort((a, b) => a.localeCompare(b));
			goalDirListingCache.set(root, { mtimeMs: rootStat.mtimeMs, names: entries });
		}
	} catch (error) {
		if (options.surfaceIoErrors || isExternalGoalStorage(ctx)) throw error;
		return [];
	}
	return entries
		.map((name) => {
			const relPath = `${GOALS_DIR}/${name}`;
			if (!isSafeActivePath(ctx, relPath)) return null;
			let parsed: GoalRecord | null;
			try {
				parsed = parseGoalFileChecked(ctx, resolveGoalPath(ctx, GOALS_DIR, relPath));
			} catch (error) {
				if (options.surfaceIoErrors) throw error;
				return null;
			}
			if (!parsed || parsed.status === "complete") return null;
			return sanitizeGoalPaths(ctx, { ...parsed, activePath: relPath });
		})
		.filter((goal): goal is GoalRecord => goal !== null);
}

/**
 * Rebuild and persist the derived pool snapshot, surfacing scan and write
 * errors, so a caller never reports a snapshot repaired until the
 * replacement is visible on disk.
 */
export function refreshActiveGoalPoolSnapshot(ctx: GoalFileContext): void {
	const root = goalStoragePath(ctx, GOALS_DIR);
	invalidateGoalPoolCache();
	const goals = scanActiveGoalFiles(ctx, root, { surfaceIoErrors: true });
	writePoolSnapshotSyncChecked(ctx, root, goals);
	const pool = new Map<string, GoalRecord>();
	for (const goal of goals) pool.set(goal.id, goal);
	goalPoolCache.set(root, pool);
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

/** Cold pool read: serve the persisted snapshot only when the goals directory is
 * unchanged since it was written. Filename equality is not enough: an atomic
 * save replaces an active record by rename without changing its basename, so
 * another process's write would otherwise hide behind a stale snapshot.
 * Otherwise full scan + re-snapshot. */
function readPoolWithSnapshotSync(ctx: GoalFileContext, root: string): Map<string, GoalRecord> {
	let rootStat: fs.Stats | null = null;
	try {
		rootStat = fs.lstatSync(root);
	} catch {
		rootStat = null;
	}
	if (rootStat && !rootStat.isSymbolicLink()) {
		const snapshot = readPoolSnapshotSync(ctx, root);
		if (snapshot) {
			if (snapshot.dirMtimeMs === rootStat.mtimeMs) {
				return hydratePoolFromSnapshot(snapshot);
			}
		}
	}
	const pool = new Map<string, GoalRecord>();
	for (const goal of scanActiveGoalFiles(ctx, root)) {
		pool.set(goal.id, goal);
	}
	writePoolSnapshotSync(ctx, root, Array.from(pool.values()));
	return pool;
}

/**
 * Parallel pool read (P1-7): fs.promises-based readdir + bounded per-file
 * descriptor reads in parallel, seeding the P1-1 parse cache so subsequent
 * sync reads hit it.
 * Used by session startup rehydration (loadState). NAF: serves the zero-op
 * pool cache when present; a cold read populates it so subsequent sync reads
 * (reconcile, get_goal, prompts) are zero-op.
 */
export async function readActiveGoalPoolAsync(ctx: GoalFileContext): Promise<Map<string, GoalRecord>> {
	const root = goalStoragePath(ctx, GOALS_DIR);
	const cachedPool = goalPoolCache.get(root);
	if (cachedPool) return new Map(cachedPool);
	const pool = await readPoolWithSnapshotAsync(ctx, root);
	goalPoolCache.set(root, pool);
	return new Map(pool);
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
		if (snapshot) {
			if (snapshot.dirMtimeMs === rootStat.mtimeMs) {
				return hydratePoolFromSnapshot(snapshot);
			}
		}
	}
	const pool = await scanActiveGoalFilesAsync(ctx, root);
	await writePoolSnapshotAsync(ctx, root, Array.from(pool.values()));
	return pool;
}

async function scanActiveGoalFilesAsync(ctx: GoalFileContext, root: string): Promise<Map<string, GoalRecord>> {
	let names: string[];
	try {
		const rootStat = await fs.promises.lstat(root);
		if (rootStat.isSymbolicLink()) { if (isExternalGoalStorage(ctx)) throw new Error(`Goal root is a symlink: ${root}`); return new Map(); }
		names = (await fs.promises.readdir(root))
			.filter((name) => /^active_goal_.*\.md$/.test(name))
			.sort((a, b) => a.localeCompare(b));
	} catch (error) {
		if (isExternalGoalStorage(ctx)) throw error;
		return new Map();
	}
	const parsed = await Promise.all(names.map(async (name): Promise<GoalRecord | null> => {
		const relPath = `${GOALS_DIR}/${name}`;
		if (!isSafeActivePath(ctx, relPath)) return null;
		const abs = resolveGoalPath(ctx, GOALS_DIR, relPath);
		try {
			const file = await readRegularFileAsync(ctx.cwd, abs, MAX_CHECKED_GOAL_FILE_BYTES);
			const parsed = parseGoalContentCached(abs, file.mtimeMs, file.size, file.bytes.toString("utf8"));
			if (!parsed || parsed.status === "complete") return null;
			return sanitizeGoalPaths(ctx, { ...parsed, activePath: relPath });
		} catch {
			return null;
		}
	}));
	const pool = new Map<string, GoalRecord>();
	for (const goal of parsed) {
		if (goal) pool.set(goal.id, goal);
	}
	return pool;
}
