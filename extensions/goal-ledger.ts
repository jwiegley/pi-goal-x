import { goalStoragePath, ensureGoalStorageDirectory, type GoalStorageContext } from "./storage/goal-root.ts";
import { indexedActivityEvents } from "./goal-activity.ts";
import {
  GOAL_INDEX_ACTIVITY_LIMIT,
  GOAL_INDEX_RECENT_LIMIT,
  auditApplies,
  indexGoalLedgerEvent,
  newGoalLedgerIndex,
  type GoalAuditEvent,
  type GoalLedgerIndex,
} from "./goal-ledger-index.ts";
import type { OracleConsultState } from "./goal-oracle.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { safeIdPart } from "./goal-record.ts";
import { atomicWriteRegularFile, assertSafeFileAncestors, openRegularFile, readRegularFile, writeAll } from "./storage/safe-fs.ts";

export const GOAL_LEDGER_FILE = ".pi/goals/goal_events.jsonl";

/*
 * Bounded ledger reads.
 *
 * The JSONL ledger is append-only and authoritative; it is never loaded whole.
 * Every reader streams it in fixed-size chunks, rejects lines longer than
 * MAX_LEDGER_LINE_BYTES, and retains only bounded windows:
 *
 *  - readGoalLedger: the newest events of the whole ledger, capped by count
 *    and bytes, plus exact counts;
 *  - readGoalLedgerForGoal: one goal's exact facts (completion requested,
 *    latest audit, completion/archive timestamps), its recent and activity
 *    working sets, and a capped tail of its events;
 *  - goalOracleState: one Oracle fingerprint's state, reduced while
 *    streaming, so no per-fingerprint map is retained.
 *
 * Per-goal indexes are cached in a small LRU bounded by entry count and
 * bytes, and the newest one is persisted as a single-goal checkpoint, so
 * neither memory nor the checkpoint grows with the number of goals the ledger
 * has ever seen. A cached or checkpointed index is reused only after its
 * ledger identity and fixed-size prefix anchors validate; then only the bytes
 * appended since are scanned. Replacement, truncation, a changed prefix or a
 * same-size rewrite falls back to one streaming rebuild.
 */
const LEDGER_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_LEDGER_LINE_BYTES = 1024 * 1024;
const DEFAULT_LEDGER_EVENT_LIMIT = 4096;
const DEFAULT_GOAL_EVENT_LIMIT = 64;
const MAX_RETAINED_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_GOAL_INDEX_ENTRIES = 16;
export const MAX_GOAL_INDEX_EVENTS = DEFAULT_LEDGER_EVENT_LIMIT;
const MAX_GOAL_INDEX_BYTES = MAX_RETAINED_LEDGER_BYTES;
const MAX_GOAL_ACTIVITY_BYTES = 1024 * 1024;

export const LEDGER_CHECKPOINT_FILE = ".goal-ledger-checkpoint.json";
export const LEDGER_CHECKPOINT_VERSION = 5;
const MAX_LEDGER_CHECKPOINT_BYTES = 10 * 1024 * 1024;

export type GoalLedgerEvent =
  | { type: "goal_created"; goalId: string; objective: string; sisyphus: boolean; autoContinue: boolean; at: string }
  | { type: "goal_focused"; goalId: string; reason: string; at: string }
  | { type: "goal_unfocused"; reason: string; at: string }
  | { type: "goal_paused"; goalId: string; reason: string; suggestedAction?: string; status?: "paused"; source?: "user" | "agent"; at: string }
  | { type: "goal_resumed"; goalId: string; reason: string; at: string }
  | { type: "goal_tweaked"; goalId: string; changeSummary: string; at: string }
  | { type: "auditor_toggled"; goalId: string; enabled: boolean; at: string }
  | { type: "completion_requested"; goalId: string; summary?: string; at: string }
  | { type: "audit_started"; goalId: string; auditId?: string; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "audit_result"; goalId: string; auditId?: string; verdict: "approved" | "disapproved" | "error"; report: string; at: string }
  | { type: "audit_skipped"; goalId: string; auditId?: string; reason: "disabled" | "user_aborted"; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "goal_completed"; goalId: string; archivePath?: string; at: string }
  | { type: "goal_archived"; goalId: string; archivePath: string; at: string }
  | { type: "goal_archive_failed"; goalId: string; message: string; at: string }
  | { type: "goal_aborted"; goalId: string; reason: string; archivePath?: string; at: string }
  | { type: "task_list_set"; goalId: string; taskCount: number; blockCompletion: boolean; at: string }
  | { type: "task_complete"; goalId: string; taskId: string; evidence?: string; at: string }
  | { type: "task_skipped"; goalId: string; taskId: string; reason: string; at: string }
  | { type: "task_reopened"; goalId: string; taskId: string; at: string }
  | { type: "task_started"; goalId: string; taskId: string; at: string }
  | { type: "goal_budget_changed"; goalId: string; oldBudget: number | null; newBudget: number | null; tokensUsed: number; at: string }
  | { type: "goal_budget_limited"; goalId: string; budget: number; tokensUsed: number; at: string }
  | { type: "goal_budget_warning"; goalId: string; budget: number; tokensUsed: number; pct: number; at: string }
  | { type: "goal_stalled"; goalId: string; reason: string; at: string }
  | { type: "goal_blocked"; goalId: string; reason: string; source: "agent" | "system"; at: string }
  | { type: "oracle_started"; goalId: string; fingerprint: string; provider: string; model: string; thinkingLevel?: string; reason: string; at: string }
  | { type: "oracle_result"; goalId: string; fingerprint: string; adviceId: string; disposition: "actionable" | "needs_human" | "insufficient_context"; summary: string; recommendedTitle?: string; at: string }
  | { type: "oracle_failed"; goalId: string; fingerprint: string; attempt: number; errorCode: "config" | "provider" | "aborted" | "invalid_output"; message: string; at: string }
  | { type: "oracle_followup_attempted"; goalId: string; fingerprint: string; adviceId: string; firstToolName: string; at: string };

export type GoalLedgerContext = GoalStorageContext;

export interface GoalLedgerReadResult {
  events: GoalLedgerEvent[];
  malformed: number;
  /** True when older events lie outside the returned window. */
  truncated: boolean;
  /** Valid events in the whole ledger. */
  validEvents: number;
  /** Opaque generation for borrowed, read-only history views; replaced when the history changes. */
  revision?: object;
}

export type GoalAuditorResult = { verdict: "approved" | "disapproved" | "error"; report: string; at: string };

/** Exact per-goal facts from the whole ledger, plus a bounded window of the goal's events. */
export interface GoalLedgerGoalReadResult extends GoalLedgerReadResult {
  hasCompletionRequested: boolean;
  completedAt: string | undefined;
  completedArchivePath: string | undefined;
  archivedAt: string | undefined;
  archivedArchivePath: string | undefined;
  /** Result of the goal's latest applicable audit; undefined while a newer audit has no result. */
  latestAuditorResult: GoalAuditorResult | undefined;
}

export interface ReconstructedGoalState {
  goalId: string;
  latestStatus: "active" | "paused" | "complete" | "aborted" | "unknown";
  latestFocus: boolean;
  latestPauseReason?: string;
  latestPauseSuggestedAction?: string;
  latestAuditId?: string;
  latestAuditorResult?: { verdict: "approved" | "disapproved" | "error"; report: string; at: string };
  /** Issue #26: bounded latest Oracle disposition for this goal. */
  latestOracleResult?: { fingerprint: string; adviceId: string; disposition: "actionable" | "needs_human" | "insufficient_context"; summary: string; at: string };
  createdAt?: string;
  completedAt?: string;
  abortedAt?: string;
  tweakedAt?: string;
  resumedAt?: string;
}

export interface ReconstructedLedgerState {
  focusedGoalId: string | null;
  goals: Map<string, ReconstructedGoalState>;
  terminalGoals: Map<string, ReconstructedGoalState>;
}

function safeGoalId(value: string): string {
  return safeIdPart(value);
}

function goalIdOf(event: GoalLedgerEvent): string | null {
  return "goalId" in event ? event.goalId : null;
}

export function goalLedgerPath(ctx: GoalLedgerContext): string {
  return goalStoragePath(ctx, GOAL_LEDGER_FILE);
}

/** Every protected ledger path is checked from the project directory down. */
function ledgerRoot(ctx: GoalLedgerContext): string {
  return path.resolve(ctx.cwd);
}

export type GoalLedgerAppendResult = { ok: true } | { ok: false; error: unknown };

/**
 * Append one ledger event. Returns a discriminated result instead of swallowing
 * both append attempts internally: the authoritative state write is never
 * rolled back after a ledger failure, but callers (GoalService) route failures
 * through the onDiagnostic hook so they stay observable.
 */
export function appendGoalEvent(ctx: GoalLedgerContext, event: GoalLedgerEvent): GoalLedgerAppendResult {
  return appendLedgerLines(ctx, [event]);
}

/** Append several ledger events as one line block (P1-8): one lock, one write. */
export function appendGoalEvents(ctx: GoalLedgerContext, events: GoalLedgerEvent[]): GoalLedgerAppendResult {
  if (events.length === 0) return { ok: true };
  return appendLedgerLines(ctx, events);
}

/*
 * Appends from every Goal X process sharing a ledger are serialized through an
 * exclusive SQLite transaction on a private lock database next to the ledger.
 * The transaction holds an OS file lock, so a crashed holder's lock is released
 * with its process instead of being guessed stale from a pid. It is only as
 * reliable as the file system's locking, which SQLite documents as unreliable
 * on some network file systems.
 */
const GOAL_LEDGER_LOCK_FILE = ".pi/goals/.goal-events.lock.sqlite";
const GOAL_LEDGER_LOCK_APPLICATION_ID = 0x5049474c; // "PIGL"
const GOAL_LEDGER_LOCK_WAIT_MS = 2 * 60 * 1000;

type SqliteModule = typeof import("node:sqlite");
let sqliteModule: SqliteModule | undefined;

/** Loaded on the first append, so processes that only read the ledger never load SQLite. */
function sqlite(): SqliteModule {
  return sqliteModule ??= process.getBuiltinModule("node:sqlite") as SqliteModule;
}

function assertRegularLockPath(lockPath: string, message: string): void {
  try {
    const linked = fs.lstatSync(lockPath);
    if (linked.isSymbolicLink() || !linked.isFile()) throw new Error(`${message}: ${lockPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function acquireLedgerAppendLock(ctx: GoalLedgerContext): () => void {
  const root = ledgerRoot(ctx);
  const lockPath = goalStoragePath(ctx, GOAL_LEDGER_LOCK_FILE);
  ensureGoalStorageDirectory(ctx, ".pi/goals");
  assertSafeFileAncestors(root, lockPath);
  assertRegularLockPath(lockPath, "Goal ledger lock path is not a regular file");
  let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;
  try {
    db = new (sqlite().DatabaseSync)(lockPath);
    // Ownership inspection and initialization happen inside the exclusive
    // transaction, so concurrent first writers cannot misread a half-made lock.
    db.exec(`
      PRAGMA busy_timeout = ${GOAL_LEDGER_LOCK_WAIT_MS};
      PRAGMA journal_mode = DELETE;
      BEGIN EXCLUSIVE;
    `);
    const application = db.prepare("PRAGMA application_id").get() as { application_id: number };
    if (application.application_id === 0) {
      const schema = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { count: number };
      if (schema.count !== 0) throw new Error(`Refusing unrecognized goal ledger lock database: ${lockPath}`);
      db.exec(`PRAGMA application_id = ${GOAL_LEDGER_LOCK_APPLICATION_ID}`);
    } else if (application.application_id !== GOAL_LEDGER_LOCK_APPLICATION_ID) {
      throw new Error(`Refusing unrecognized goal ledger lock database: ${lockPath}`);
    }
    if (process.platform !== "win32") fs.chmodSync(lockPath, 0o600);
    db.exec("CREATE TABLE IF NOT EXISTS ledger_lock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))");
    assertRegularLockPath(lockPath, "Goal ledger lock path changed during acquisition");
  } catch (error) {
    try {
      db?.close();
    } catch {}
    throw error;
  }
  const held = db;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      held.exec("COMMIT");
    } finally {
      held.close();
    }
  };
}

function withLedgerAppendLock(ctx: GoalLedgerContext, body: () => GoalLedgerAppendResult): GoalLedgerAppendResult {
  const release = acquireLedgerAppendLock(ctx);
  let completed = false;
  let result: GoalLedgerAppendResult | undefined;
  let failure: unknown;
  try {
    result = body();
    completed = true;
  } catch (error) {
    failure = error;
  }
  try {
    release();
  } catch (releaseError) {
    if (!completed) throw new AggregateError([failure, releaseError], "Goal ledger append and lock release both failed.", { cause: failure });
    // The append's own result stands; the OS drops the lock with the handle.
    console.warn(`Goal ledger lock release failed after the append result: ${String(releaseError)}`);
  }
  if (!completed) throw failure;
  return result!;
}

function appendLedgerLines(ctx: GoalLedgerContext, events: GoalLedgerEvent[]): GoalLedgerAppendResult {
  const serialized: string[] = [];
  try {
    for (const event of events) {
      const line = JSON.stringify(event);
      const bytes = Buffer.byteLength(line, "utf8");
      // Readers count longer lines as malformed; never write one.
      if (bytes > MAX_LEDGER_LINE_BYTES) return { ok: false, error: new RangeError(`Goal ledger event is ${bytes} bytes; the maximum is ${MAX_LEDGER_LINE_BYTES}.`) };
      serialized.push(line);
    }
  } catch (error) {
    return { ok: false, error };
  }
  try {
    return withLedgerAppendLock(ctx, () => appendLedgerLinesLocked(ctx, serialized));
  } catch (error) {
    return { ok: false, error };
  }
}

function appendLedgerLinesLocked(ctx: GoalLedgerContext, serialized: string[]): GoalLedgerAppendResult {
  const root = ledgerRoot(ctx);
  const filePath = goalLedgerPath(ctx);
  let fd: number | null = null;
  try {
    const opened = openRegularFile(root, filePath, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT);
    fd = opened.fd;
    // A torn final line (crash mid-append, or an editor that dropped the final
    // newline) must not swallow this batch: start it on a fresh line.
    let separator = "";
    if (opened.identity.size > 0) {
      const finalByte = Buffer.allocUnsafe(1);
      if (fs.readSync(fd, finalByte, 0, 1, opened.identity.size - 1) === 1 && finalByte[0] !== 0x0a) separator = "\n";
    }
    // One O_APPEND descriptor writes the complete batch. A partial or
    // ambiguous write is reported and never retried.
    writeAll(fd, Buffer.from(separator + serialized.map((line) => line + "\n").join(""), "utf8"));
    const written = fs.fstatSync(fd);
    assertSafeFileAncestors(root, filePath);
    const linked = fs.lstatSync(filePath);
    if (linked.isSymbolicLink() || !linked.isFile() || linked.dev !== written.dev || linked.ino !== written.ino) {
      throw new Error("Goal ledger path changed during append; the write result is ambiguous and will not be retried.");
    }
    // The bytes are committed once their inode is verified. A failed close(2)
    // leaves descriptor state unspecified: detach the fd first and never turn a
    // committed append into a retry signal.
    const committedFd = fd;
    fd = null;
    try {
      fs.closeSync(committedFd);
    } catch {
      // Committed ledger bytes remain authoritative despite close failure.
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the primary failure; never retry an fd with unspecified state.
      }
    }
  }
}

/** Drop cached per-goal indexes at session boundaries; the ledger and its checkpoint stay on disk. */
export function invalidateGoalLedgerCache(): void {
  goalIndexCache.clear();
}

/** Diagnostics: cached per-goal indexes and their conservatively counted bytes. */
export function goalLedgerCacheStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const entry of goalIndexCache.values()) bytes += entry.bytes;
  return { entries: goalIndexCache.size, bytes };
}

// ── streaming line reader ────────────────────────────────────────────────

type ParsedLedgerLine =
  | { kind: "empty" }
  | { kind: "malformed" }
  | { kind: "event"; event: GoalLedgerEvent };

interface LedgerLineState {
  /** Bytes of the current, not yet newline-terminated line. */
  pending: Buffer;
  /** The current line already exceeded MAX_LEDGER_LINE_BYTES; skip it until its newline. */
  discardingOversizedLine: boolean;
}

function parseLedgerLine(line: Buffer): ParsedLedgerLine {
  const trimmed = line.toString("utf8").trim();
  if (!trimmed) return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { kind: "malformed" };
  }
  if (!isValidLedgerEvent(parsed)) return { kind: "malformed" };
  return { kind: "event", event: sanitizeEvent(parsed, true) };
}

function appendLineSegment(state: LedgerLineState, segment: Buffer): void {
  if (state.discardingOversizedLine || segment.length === 0) return;
  if (state.pending.length + segment.length > MAX_LEDGER_LINE_BYTES) {
    state.pending = Buffer.alloc(0);
    state.discardingOversizedLine = true;
    return;
  }
  // The read buffer is reused, so a retained segment must be copied.
  state.pending = state.pending.length === 0
    ? Buffer.from(segment)
    : Buffer.concat([state.pending, segment], state.pending.length + segment.length);
}

function finishLedgerLine(state: LedgerLineState): ParsedLedgerLine {
  if (state.discardingOversizedLine) {
    state.pending = Buffer.alloc(0);
    state.discardingOversizedLine = false;
    return { kind: "malformed" };
  }
  const result = parseLedgerLine(state.pending);
  state.pending = Buffer.alloc(0);
  return result;
}

function feedLedgerBytes(state: LedgerLineState, bytes: Buffer, onLine: (line: ParsedLedgerLine) => void): void {
  let cursor = 0;
  while (cursor < bytes.length) {
    const newline = bytes.indexOf(0x0a, cursor);
    const end = newline < 0 ? bytes.length : newline;
    appendLineSegment(state, bytes.subarray(cursor, end));
    if (newline < 0) return;
    onLine(finishLedgerLine(state));
    cursor = newline + 1;
  }
}

/** A final line without its newline is visible to readers but stays pending for the next scan. */
function observePendingLedgerLine(state: LedgerLineState): ParsedLedgerLine {
  if (state.discardingOversizedLine) return { kind: "malformed" };
  return parseLedgerLine(state.pending);
}

function normalizeEventLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const limit = Math.trunc(value);
  return Number.isFinite(limit) ? Math.max(1, limit) : fallback;
}

// ── bounded event windows ────────────────────────────────────────────────

const eventByteSizes = new WeakMap<GoalLedgerEvent, number>();

function retainedEventBytes(event: GoalLedgerEvent): number {
  let bytes = eventByteSizes.get(event);
  if (bytes === undefined) {
    bytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
    eventByteSizes.set(event, bytes);
  }
  return bytes;
}

/** The newest events, bounded by count and bytes; always keeps at least the newest one. */
class EventWindow {
  private items: Array<GoalLedgerEvent | undefined> = [];
  private start = 0;
  bytes = 0;
  readonly limit: number;
  private readonly maxBytes: number;

  constructor(limit: number, maxBytes: number) {
    this.limit = limit;
    this.maxBytes = maxBytes;
  }

  get length(): number {
    return this.items.length - this.start;
  }

  push(event: GoalLedgerEvent): void {
    this.items.push(event);
    this.bytes += retainedEventBytes(event);
    this.trim(this.maxBytes);
  }

  /** Drop the oldest events while over the count limit or `maxBytes`. */
  trim(maxBytes: number): void {
    while (this.length > 1 && (this.length > this.limit || this.bytes > maxBytes)) {
      this.bytes -= retainedEventBytes(this.items[this.start]!);
      this.items[this.start] = undefined;
      this.start++;
    }
    // Amortized compaction keeps push O(1) without unbounded dead slots.
    if (this.start > 1024 && this.start * 2 > this.items.length) {
      this.items = this.items.slice(this.start);
      this.start = 0;
    }
  }

  newest(count = this.length): GoalLedgerEvent[] {
    return this.items.slice(Math.max(this.start, this.items.length - count)) as GoalLedgerEvent[];
  }

  clone(): EventWindow {
    const copy = new EventWindow(this.limit, this.maxBytes);
    copy.items = this.newest();
    copy.bytes = this.bytes;
    return copy;
  }
}

// ── whole-ledger streaming scans ─────────────────────────────────────────

interface LedgerScanStats {
  malformed: number;
  validEvents: number;
  coveredBytes: number;
}

function scanGoalLedgerPath(
  root: string,
  filePath: string,
  visit: (event: GoalLedgerEvent) => void,
): LedgerScanStats {
  let fd: number;
  try {
    fd = openRegularFile(root, filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK).fd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { malformed: 0, validEvents: 0, coveredBytes: 0 };
    throw error;
  }
  const buffer = Buffer.allocUnsafe(LEDGER_READ_CHUNK_BYTES);
  const lineState: LedgerLineState = { pending: Buffer.alloc(0), discardingOversizedLine: false };
  let malformed = 0;
  let validEvents = 0;
  let position = 0;
  const accept = (line: ParsedLedgerLine): void => {
    if (line.kind === "empty") return;
    if (line.kind === "malformed") {
      malformed++;
      return;
    }
    // Visitor failures are implementation errors, not malformed input.
    visit(line.event);
    validEvents++;
  };
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      feedLedgerBytes(lineState, buffer.subarray(0, bytesRead), accept);
    }
    accept(observePendingLedgerLine(lineState));
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Preserve the scan result or primary read failure; never retry an fd
      // whose close state is unspecified.
    }
  }
  return { malformed, validEvents, coveredBytes: position };
}

/**
 * The newest events of the whole ledger, bounded by `maxEvents` (default 4096)
 * and eight MiB, with exact valid/malformed counts. Never loads the file whole.
 */
export function readGoalLedger(ctx: GoalLedgerContext, options: { maxEvents?: number } = {}): GoalLedgerReadResult {
  const window = new EventWindow(normalizeEventLimit(options.maxEvents, DEFAULT_LEDGER_EVENT_LIMIT), MAX_RETAINED_LEDGER_BYTES);
  const stats = scanGoalLedgerPath(ledgerRoot(ctx), goalLedgerPath(ctx), (event) => window.push(event));
  return { events: window.newest(), malformed: stats.malformed, truncated: stats.validEvents > window.length, validEvents: stats.validEvents, revision: {} };
}

/**
 * One Oracle fingerprint's consult state, reduced while streaming the ledger.
 * Consultations are rare (a goal being reported blocked), so no
 * per-fingerprint state is retained between calls.
 */
export function goalOracleState(ctx: GoalLedgerContext, goalId: string, fingerprint: string): OracleConsultState {
  const safeId = safeGoalId(goalId);
  const state: OracleConsultState = { failedAttempts: 0, followupAttempted: false };
  scanGoalLedgerPath(ledgerRoot(ctx), goalLedgerPath(ctx), (event) => {
    if (!("fingerprint" in event) || event.goalId !== safeId || event.fingerprint !== fingerprint) return;
    if (event.type === "oracle_result") state.result = { adviceId: event.adviceId, disposition: event.disposition, summary: event.summary };
    if (event.type === "oracle_failed") {
      state.failedAttempts++;
      state.lastFailure = { errorCode: event.errorCode, message: event.message };
    }
    if (event.type === "oracle_followup_attempted") state.followupAttempted = true;
  });
  return state;
}

// ── per-goal indexes ─────────────────────────────────────────────────────

interface LedgerFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface GoalLedgerFacts {
  hasCompletionRequested: boolean;
  completedAt: string | undefined;
  completedArchivePath: string | undefined;
  archivedAt: string | undefined;
  archivedArchivePath: string | undefined;
}

interface GoalLedgerIndexEntry extends LedgerFileIdentity, GoalLedgerFacts {
  root: string;
  filePath: string;
  goalId: string;
  /** Prefix-anchor fingerprint of the covered bytes [0, size). */
  fingerprint: string;
  line: LedgerLineState;
  malformed: number;
  validEvents: number;
  matchingEvents: number;
  /** Recent, activity and latest audit/completion/lifecycle events; never Oracle state. */
  projection: GoalLedgerIndex;
  /** The goal's newest events, bounded by count and bytes. */
  tail: EventWindow;
  /** Retained bytes, counted conservatively (shared events count twice). */
  bytes: number;
  /** Replaced whenever new ledger bytes are indexed. */
  generation: object;
}

const goalIndexCache = new Map<string, GoalLedgerIndexEntry>();

function goalIndexKey(filePath: string, goalId: string): string {
  return `${filePath}\0${goalId}`;
}

function checkpointPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), LEDGER_CHECKPOINT_FILE);
}

class LedgerChangedError extends Error {}

function statLedgerPath(root: string, filePath: string): LedgerFileIdentity | null {
  try {
    assertSafeFileAncestors(root, filePath);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Goal ledger is not a regular file: ${filePath}`);
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameLedgerIdentity(left: LedgerFileIdentity, right: LedgerFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLedgerSnapshot(left: LedgerFileIdentity, right: LedgerFileIdentity): boolean {
  return sameLedgerIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function emptyGoalIndex(root: string, filePath: string, goalId: string, identity: LedgerFileIdentity): GoalLedgerIndexEntry {
  return {
    ...identity,
    root,
    filePath,
    goalId,
    fingerprint: "",
    line: { pending: Buffer.alloc(0), discardingOversizedLine: false },
    malformed: 0,
    validEvents: 0,
    matchingEvents: 0,
    hasCompletionRequested: false,
    completedAt: undefined,
    completedArchivePath: undefined,
    archivedAt: undefined,
    archivedArchivePath: undefined,
    projection: newGoalLedgerIndex(),
    tail: new EventWindow(MAX_GOAL_INDEX_EVENTS, MAX_GOAL_INDEX_BYTES),
    bytes: 0,
    generation: {},
  };
}

function cloneProjection(projection: GoalLedgerIndex): GoalLedgerIndex {
  return { ...projection, recent: [...projection.recent], activity: [...projection.activity], oracle: new Map() };
}

function copyGoalIndex(entry: GoalLedgerIndexEntry): GoalLedgerIndexEntry {
  return {
    ...entry,
    line: { pending: Buffer.from(entry.line.pending), discardingOversizedLine: entry.line.discardingOversizedLine },
    projection: cloneProjection(entry.projection),
    tail: entry.tail.clone(),
  };
}

function applyGoalFacts(facts: GoalLedgerFacts, event: GoalLedgerEvent): void {
  if (event.type === "completion_requested") facts.hasCompletionRequested = true;
  if (event.type === "goal_completed") {
    facts.completedAt = event.at;
    facts.completedArchivePath = event.archivePath;
  }
  if (event.type === "goal_archived") {
    facts.archivedAt = event.at;
    facts.archivedArchivePath = event.archivePath;
  }
}

function applyGoalIndexEvent(entry: GoalLedgerIndexEntry, event: GoalLedgerEvent): void {
  entry.validEvents++;
  if (goalIdOf(event) !== entry.goalId) return;
  entry.matchingEvents++;
  applyGoalFacts(entry, event);
  indexGoalLedgerEvent(entry.projection, event, { oracle: false });
  entry.tail.push(event);
}

function acceptGoalIndexLine(entry: GoalLedgerIndexEntry, line: ParsedLedgerLine): void {
  if (line.kind === "empty") return;
  if (line.kind === "malformed") {
    entry.malformed++;
    return;
  }
  applyGoalIndexEvent(entry, line.event);
}

function projectionEvents(projection: GoalLedgerIndex): GoalLedgerEvent[] {
  const events = new Set<GoalLedgerEvent>([...projection.recent, ...projection.activity]);
  for (const event of [projection.lastActivityEvent, projection.audit, projection.auditStarted, projection.settledAudit, projection.completion, projection.lifecycle]) {
    if (event) events.add(event);
  }
  return [...events];
}

/** Bound one goal's retained bytes: activity by its own cap, then the tail by what remains. */
function boundGoalIndexEntry(entry: GoalLedgerIndexEntry): void {
  const activity = entry.projection.activity;
  let activityBytes = 0;
  for (const event of activity) activityBytes += retainedEventBytes(event);
  while (activity.length > 1 && activityBytes > MAX_GOAL_ACTIVITY_BYTES) activityBytes -= retainedEventBytes(activity.shift()!);
  let projectionBytes = 0;
  for (const event of projectionEvents(entry.projection)) projectionBytes += retainedEventBytes(event);
  entry.tail.trim(MAX_GOAL_INDEX_BYTES - entry.line.pending.length - projectionBytes);
  entry.bytes = entry.tail.bytes + entry.line.pending.length + projectionBytes;
}

function rememberGoalIndex(entry: GoalLedgerIndexEntry): GoalLedgerIndexEntry {
  const key = goalIndexKey(entry.filePath, entry.goalId);
  goalIndexCache.delete(key);
  goalIndexCache.set(key, entry);
  let retained = 0;
  for (const cached of goalIndexCache.values()) retained += cached.bytes;
  while (goalIndexCache.size > MAX_GOAL_INDEX_ENTRIES || retained > MAX_GOAL_INDEX_BYTES) {
    const oldest = goalIndexCache.entries().next().value as [string, GoalLedgerIndexEntry] | undefined;
    if (!oldest || oldest[0] === key) break;
    goalIndexCache.delete(oldest[0]);
    retained -= oldest[1].bytes;
  }
  return entry;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const result = Buffer.allocUnsafe(length);
  let used = 0;
  while (used < length) {
    const count = fs.readSync(fd, result, used, length - used, position + used);
    if (count === 0) break;
    used += count;
  }
  return result.subarray(0, used);
}

/** Hash only fixed-size head and boundary anchors of a covered append-only prefix. */
function fingerprintLedgerPrefixFd(fd: number, coveredBytes: number): string {
  const stat = fs.fstatSync(fd);
  if (stat.size < coveredBytes) throw new LedgerChangedError("Goal ledger changed while its index was being validated.");
  const anchorBytes = Math.min(4096, coveredBytes);
  const tailStart = Math.max(anchorBytes, coveredBytes - anchorBytes);
  const hash = createHash("sha256");
  hash.update(`goal-ledger-prefix-v1:${coveredBytes}:`);
  hash.update(readAt(fd, 0, anchorBytes));
  if (tailStart < coveredBytes) hash.update(readAt(fd, tailStart, coveredBytes - tailStart));
  return hash.digest("hex");
}

function fingerprintLedgerPrefix(root: string, filePath: string, coveredBytes: number): string {
  const opened = openRegularFile(root, filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    return fingerprintLedgerPrefixFd(opened.fd, coveredBytes);
  } finally {
    try {
      fs.closeSync(opened.fd);
    } catch {
      // Preserve the fingerprint result or primary validation failure.
    }
  }
}

// ── single-goal checkpoint ───────────────────────────────────────────────

interface GoalProjectionJson {
  recent: GoalLedgerEvent[];
  activity: GoalLedgerEvent[];
  lastActivityEvent?: GoalLedgerEvent;
  audit?: GoalLedgerEvent;
  auditStarted?: GoalLedgerEvent;
  settledAudit?: GoalLedgerEvent;
  completion?: GoalLedgerEvent;
  lifecycle?: GoalLedgerEvent;
}

interface GoalLedgerCheckpointPayload extends GoalLedgerFacts {
  version: typeof LEDGER_CHECKPOINT_VERSION;
  format: "goal-ledger-goal-index";
  goalId: string;
  identity: LedgerFileIdentity;
  fingerprint: string;
  malformed: number;
  validEvents: number;
  matchingEvents: number;
  projection: GoalProjectionJson;
  events: GoalLedgerEvent[];
  pendingBase64: string;
  discardingOversizedLine: boolean;
}

function checkpointPayloadDigest(payload: unknown): string {
  return createHash("sha256").update("goal-ledger-checkpoint-v5:").update(JSON.stringify(payload)).digest("hex");
}

function checkpointJson(entry: GoalLedgerIndexEntry): GoalLedgerCheckpointPayload & { digest: string } {
  const p = entry.projection;
  const payload: GoalLedgerCheckpointPayload = {
    version: LEDGER_CHECKPOINT_VERSION,
    format: "goal-ledger-goal-index",
    goalId: entry.goalId,
    identity: { dev: entry.dev, ino: entry.ino, size: entry.size, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs },
    fingerprint: entry.fingerprint,
    malformed: entry.malformed,
    validEvents: entry.validEvents,
    matchingEvents: entry.matchingEvents,
    hasCompletionRequested: entry.hasCompletionRequested,
    completedAt: entry.completedAt,
    completedArchivePath: entry.completedArchivePath,
    archivedAt: entry.archivedAt,
    archivedArchivePath: entry.archivedArchivePath,
    projection: {
      recent: p.recent,
      activity: p.activity,
      lastActivityEvent: p.lastActivityEvent,
      audit: p.audit,
      auditStarted: p.auditStarted,
      settledAudit: p.settledAudit,
      completion: p.completion,
      lifecycle: p.lifecycle,
    },
    events: entry.tail.newest(),
    pendingBase64: entry.line.pending.toString("base64"),
    discardingOversizedLine: entry.line.discardingOversizedLine,
  };
  // Hash the JSON form the reader will see (undefined fields omitted).
  const normalized = JSON.parse(JSON.stringify(payload)) as GoalLedgerCheckpointPayload;
  return { ...normalized, digest: checkpointPayloadDigest(normalized) };
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** A checkpoint event must be a valid event of this goal within the line limit. */
function checkpointEvent(value: unknown, goalId: string): GoalLedgerEvent | null {
  if (!isValidLedgerEvent(value)) return null;
  const event = sanitizeEvent(value, true);
  if (goalIdOf(event) !== goalId || retainedEventBytes(event) - 1 > MAX_LEDGER_LINE_BYTES) return null;
  return event;
}

function parseCheckpointProjection(value: unknown, goalId: string): GoalLedgerIndex | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.recent) || !Array.isArray(raw.activity)) return null;
  if (raw.recent.length > GOAL_INDEX_RECENT_LIMIT || raw.activity.length > GOAL_INDEX_ACTIVITY_LIMIT) return null;
  const projection = newGoalLedgerIndex();
  for (const candidate of raw.recent) {
    const event = checkpointEvent(candidate, goalId);
    if (!event) return null;
    projection.recent.push(event);
  }
  for (const candidate of raw.activity) {
    const event = checkpointEvent(candidate, goalId);
    if (!event) return null;
    projection.activity.push(event);
  }
  const single = (key: keyof GoalProjectionJson, types?: readonly string[]): GoalLedgerEvent | undefined | null => {
    if (raw[key] === undefined) return undefined;
    const event = checkpointEvent(raw[key], goalId);
    return event && (!types || types.includes(event.type)) ? event : null;
  };
  const auditTypes = ["audit_started", "audit_result", "audit_skipped"] as const;
  const lastActivityEvent = single("lastActivityEvent");
  const audit = single("audit", auditTypes);
  const auditStarted = single("auditStarted", ["audit_started"]);
  const settledAudit = single("settledAudit", ["audit_result"]);
  const completion = single("completion", ["completion_requested"]);
  const lifecycle = single("lifecycle");
  if ([lastActivityEvent, audit, auditStarted, settledAudit, completion, lifecycle].includes(null)) return null;
  if (projection.activity.length > 0 && !lastActivityEvent) return null;
  projection.lastActivityEvent = lastActivityEvent ?? undefined;
  projection.audit = (audit ?? undefined) as GoalAuditEvent | undefined;
  projection.auditStarted = (auditStarted ?? undefined) as GoalAuditEvent | undefined;
  projection.settledAudit = (settledAudit ?? undefined) as GoalAuditEvent | undefined;
  projection.completion = completion ?? undefined;
  projection.lifecycle = lifecycle ?? undefined;
  return projection;
}

function parseCheckpointJson(root: string, filePath: string, value: unknown): GoalLedgerIndexEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.digest !== "string" || !/^[a-f0-9]{64}$/.test(raw.digest)) return null;
  const { digest, ...payload } = raw;
  if (checkpointPayloadDigest(payload) !== digest) return null;
  if (raw.version !== LEDGER_CHECKPOINT_VERSION || raw.format !== "goal-ledger-goal-index") return null;
  if (typeof raw.goalId !== "string" || safeGoalId(raw.goalId) !== raw.goalId) return null;
  if (typeof raw.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.fingerprint)) return null;
  if (!validCounter(raw.malformed) || !validCounter(raw.validEvents) || !validCounter(raw.matchingEvents)) return null;
  if (typeof raw.hasCompletionRequested !== "boolean" || typeof raw.pendingBase64 !== "string") return null;
  if (!optionalString(raw.completedAt) || !optionalString(raw.completedArchivePath) || !optionalString(raw.archivedAt) || !optionalString(raw.archivedArchivePath)) return null;
  if (typeof raw.discardingOversizedLine !== "boolean" || !Array.isArray(raw.events)) return null;
  const identity = raw.identity as Record<string, unknown> | undefined;
  if (!identity || typeof identity !== "object") return null;
  for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const) {
    if (typeof identity[key] !== "number" || !Number.isFinite(identity[key]) || identity[key] < 0) return null;
  }
  if (raw.events.length > MAX_GOAL_INDEX_EVENTS) return null;
  const projection = parseCheckpointProjection(raw.projection, raw.goalId);
  if (!projection) return null;
  const pending = Buffer.from(raw.pendingBase64, "base64");
  if (pending.length > MAX_LEDGER_LINE_BYTES || pending.toString("base64") !== raw.pendingBase64) return null;
  const entry = emptyGoalIndex(root, filePath, raw.goalId, {
    dev: identity.dev as number,
    ino: identity.ino as number,
    size: identity.size as number,
    mtimeMs: identity.mtimeMs as number,
    ctimeMs: identity.ctimeMs as number,
  });
  for (const candidate of raw.events) {
    const event = checkpointEvent(candidate, raw.goalId);
    if (!event) return null;
    entry.tail.push(event);
  }
  if (entry.tail.length !== raw.events.length) return null;
  Object.assign(entry, {
    fingerprint: raw.fingerprint,
    line: { pending, discardingOversizedLine: raw.discardingOversizedLine },
    malformed: raw.malformed,
    validEvents: raw.validEvents,
    matchingEvents: raw.matchingEvents,
    hasCompletionRequested: raw.hasCompletionRequested,
    completedAt: raw.completedAt,
    completedArchivePath: raw.completedArchivePath,
    archivedAt: raw.archivedAt,
    archivedArchivePath: raw.archivedArchivePath,
    projection,
  });
  boundGoalIndexEntry(entry);
  if (entry.tail.length !== raw.events.length || entry.bytes > MAX_GOAL_INDEX_BYTES) return null;
  return entry;
}

function readGoalCheckpoint(root: string, filePath: string, goalId: string): GoalLedgerIndexEntry | null {
  try {
    const body = readRegularFile(root, checkpointPathFor(filePath), MAX_LEDGER_CHECKPOINT_BYTES).bytes;
    const parsed = parseCheckpointJson(root, filePath, JSON.parse(body.toString("utf8")) as unknown);
    return parsed?.goalId === goalId ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the newest index as the only checkpoint; a derived optimization, so failures are ignored. */
function writeGoalCheckpoint(entry: GoalLedgerIndexEntry): void {
  try {
    const body = Buffer.from(JSON.stringify(checkpointJson(entry)), "utf8");
    if (body.length > MAX_LEDGER_CHECKPOINT_BYTES) return;
    atomicWriteRegularFile(entry.root, checkpointPathFor(entry.filePath), body);
  } catch {
    // The JSONL ledger remains authoritative.
  }
}

// ── index refresh ────────────────────────────────────────────────────────

/** Index the bytes appended after `entry.size`, then re-anchor the covered prefix. */
function scanGoalIndexTail(entry: GoalLedgerIndexEntry): GoalLedgerIndexEntry {
  const next = copyGoalIndex(entry);
  const buffer = Buffer.allocUnsafe(LEDGER_READ_CHUNK_BYTES);
  const fd = openRegularFile(next.root, next.filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK).fd;
  let finalStat: fs.Stats;
  let fingerprint = "";
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== next.dev || opened.ino !== next.ino || opened.size < next.size) {
      throw new LedgerChangedError("Goal ledger changed while its index was being applied.");
    }
    let position = next.size;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead > 0) {
        position += bytesRead;
        feedLedgerBytes(next.line, buffer.subarray(0, bytesRead), (line) => acceptGoalIndexLine(next, line));
        continue;
      }
      finalStat = fs.fstatSync(fd);
      if (finalStat.size > position) continue;
      next.size = position;
      fingerprint = fingerprintLedgerPrefixFd(fd, next.size);
      break;
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Preserve the scan result or primary validation failure.
    }
  }
  next.dev = finalStat!.dev;
  next.ino = finalStat!.ino;
  next.mtimeMs = finalStat!.mtimeMs;
  next.ctimeMs = finalStat!.ctimeMs;
  next.fingerprint = fingerprint;
  next.generation = {};
  boundGoalIndexEntry(next);
  return next;
}

function rebuildGoalIndex(root: string, filePath: string, goalId: string, identity: LedgerFileIdentity): GoalLedgerIndexEntry {
  return scanGoalIndexTail(emptyGoalIndex(root, filePath, goalId, { ...identity, size: 0 }));
}

function reusableGoalIndex(entry: GoalLedgerIndexEntry, identity: LedgerFileIdentity): GoalLedgerIndexEntry | null {
  if (!sameLedgerIdentity(entry, identity) || identity.size < entry.size) return null;
  // With no growth, changed timestamps prove an in-place rewrite. During
  // append growth timestamps necessarily change, so the append-only contract
  // is checked with fixed-size anchors; rereading every old byte would make
  // this path O(total ledger).
  if (identity.size === entry.size && (identity.mtimeMs !== entry.mtimeMs || identity.ctimeMs !== entry.ctimeMs)) return null;
  if (fingerprintLedgerPrefix(entry.root, entry.filePath, entry.size) !== entry.fingerprint) return null;
  return entry;
}

function refreshGoalIndexAttempt(root: string, filePath: string, goalId: string): GoalLedgerIndexEntry {
  const identity = statLedgerPath(root, filePath);
  if (!identity) return emptyGoalIndex(root, filePath, goalId, { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 });
  const key = goalIndexKey(filePath, goalId);
  let memory = goalIndexCache.get(key);
  if (memory && sameLedgerSnapshot(memory, identity)) {
    try {
      if (fingerprintLedgerPrefix(root, filePath, memory.size) === memory.fingerprint) return rememberGoalIndex(memory);
    } catch {
      // Fall through to the authoritative rebuild path below.
    }
    memory = undefined;
  }
  let seed: GoalLedgerIndexEntry | null = null;
  try {
    const checkpoint = memory ?? readGoalCheckpoint(root, filePath, goalId);
    seed = checkpoint ? reusableGoalIndex(checkpoint, identity) : null;
  } catch {
    seed = null;
  }
  let refreshed: GoalLedgerIndexEntry;
  // A checkpoint that already covers the whole ledger needs no rewrite.
  let checkpointCurrent = !memory && !!seed && identity.size === seed.size;
  if (seed && identity.size === seed.size) refreshed = { ...copyGoalIndex(seed), ...identity };
  else if (seed) refreshed = scanGoalIndexTail(seed);
  else refreshed = rebuildGoalIndex(root, filePath, goalId, identity);

  let after = statLedgerPath(root, filePath);
  if (!after) throw new LedgerChangedError("Goal ledger disappeared while it was being indexed.");
  if (sameLedgerIdentity(refreshed, after) && after.size > refreshed.size) {
    const valid = reusableGoalIndex(refreshed, after);
    refreshed = valid ? scanGoalIndexTail(valid) : rebuildGoalIndex(root, filePath, goalId, after);
    checkpointCurrent = false;
    after = statLedgerPath(root, filePath);
    if (!after) throw new LedgerChangedError("Goal ledger disappeared while its appended tail was being indexed.");
  }
  if (!sameLedgerSnapshot(refreshed, after)) throw new LedgerChangedError("Goal ledger was replaced while it was being indexed.");
  if (!checkpointCurrent) writeGoalCheckpoint(refreshed);
  return rememberGoalIndex(refreshed);
}

function refreshGoalIndex(ctx: GoalLedgerContext, goalId: string): GoalLedgerIndexEntry {
  const root = ledgerRoot(ctx);
  const filePath = goalLedgerPath(ctx);
  const safeId = safeGoalId(goalId);
  let lastChange: LedgerChangedError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return refreshGoalIndexAttempt(root, filePath, safeId);
    } catch (error) {
      if (!(error instanceof LedgerChangedError)) throw error;
      lastChange = error;
    }
  }
  throw new Error(`Goal ledger changed during three bounded index attempts: ${lastChange?.message ?? "unknown change"}`);
}

/** The index as a reader sees it, including a final event that has no newline yet. */
interface GoalLedgerView extends GoalLedgerFacts {
  entry: GoalLedgerIndexEntry;
  projection: GoalLedgerIndex;
  pendingEvent: GoalLedgerEvent | undefined;
  malformed: number;
  validEvents: number;
  matchingEvents: number;
}

function goalLedgerView(ctx: GoalLedgerContext, goalId: string): GoalLedgerView {
  const entry = refreshGoalIndex(ctx, goalId);
  const view: GoalLedgerView = {
    entry,
    projection: entry.projection,
    pendingEvent: undefined,
    malformed: entry.malformed,
    validEvents: entry.validEvents,
    matchingEvents: entry.matchingEvents,
    hasCompletionRequested: entry.hasCompletionRequested,
    completedAt: entry.completedAt,
    completedArchivePath: entry.completedArchivePath,
    archivedAt: entry.archivedAt,
    archivedArchivePath: entry.archivedArchivePath,
  };
  const pending = observePendingLedgerLine(entry.line);
  if (pending.kind === "malformed") view.malformed++;
  if (pending.kind === "event") {
    view.validEvents++;
    if (goalIdOf(pending.event) === entry.goalId) {
      view.matchingEvents++;
      view.pendingEvent = pending.event;
      view.projection = cloneProjection(entry.projection);
      indexGoalLedgerEvent(view.projection, pending.event, { oracle: false });
      applyGoalFacts(view, pending.event);
    }
  }
  return view;
}

/** Pinned audit/completion events outside `window` first (upstream order), then the window. */
function withPinnedEvents(projection: GoalLedgerIndex, window: GoalLedgerEvent[]): GoalLedgerEvent[] {
  const same = (a: GoalLedgerEvent | undefined, b: GoalLedgerEvent | undefined) => a === b || !!a && !!b && a.type === b.type && a.at === b.at && JSON.stringify(a) === JSON.stringify(b);
  const prior = same(projection.settledAudit, projection.audit) ? undefined : projection.settledAudit;
  const pinned = [prior, projection.completion, projection.auditStarted, projection.audit];
  return [...pinned.filter((event, index): event is GoalLedgerEvent => !!event
    && !window.some(other => same(event, other))
    && !pinned.slice(0, index).some(other => same(event, other))), ...window];
}

/**
 * One goal's exact facts and a bounded window of its events: the newest
 * `maxEvents` (default 64) of a retained tail of at most 4096 events and
 * eight MiB, preceded by the goal's latest audit and completion events when
 * they are older than the window.
 */
export function readGoalLedgerForGoal(
  ctx: GoalLedgerContext,
  goalId: string,
  options: { maxEvents?: number } = {},
): GoalLedgerGoalReadResult {
  const view = goalLedgerView(ctx, goalId);
  const maxEvents = normalizeEventLimit(options.maxEvents, DEFAULT_GOAL_EVENT_LIMIT);
  const retained = view.entry.tail.newest(view.pendingEvent ? maxEvents - 1 : maxEvents);
  const window = view.pendingEvent ? [...retained, view.pendingEvent] : retained;
  const audit = view.projection.audit;
  return {
    events: withPinnedEvents(view.projection, window),
    malformed: view.malformed,
    truncated: view.matchingEvents > window.length,
    validEvents: view.validEvents,
    revision: view.pendingEvent ? {} : view.entry.generation,
    hasCompletionRequested: view.hasCompletionRequested,
    completedAt: view.completedAt,
    completedArchivePath: view.completedArchivePath,
    archivedAt: view.archivedAt,
    archivedArchivePath: view.archivedArchivePath,
    latestAuditorResult: audit?.type === "audit_result" ? { verdict: audit.verdict, report: audit.report, at: audit.at } : undefined,
  };
}

/** Bounded runtime working set for prompts and audits: latest audit/completion events plus the 12 newest. */
export function goalRuntimeEvents(ctx: GoalLedgerContext, goalId: string): GoalLedgerEvent[] {
  const projection = goalLedgerView(ctx, goalId).projection;
  return withPinnedEvents(projection, [...projection.recent]);
}

/** Up to 64 deduplicated activity events in display order, for the dashboard. */
export function goalActivityEvents(ctx: GoalLedgerContext, goalId: string): GoalLedgerEvent[] {
  return indexedActivityEvents([...goalLedgerView(ctx, goalId).projection.activity]);
}

function isValidLedgerEvent(value: unknown): value is GoalLedgerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string") return false;
  if (typeof obj.at !== "string") return false;
  const type = obj.type as GoalLedgerEvent["type"];
  if ((type === "audit_started" || type === "audit_result" || type === "audit_skipped") && obj.auditId !== undefined && (typeof obj.auditId !== "string" || !obj.auditId)) return false;
  switch (type) {
    case "goal_created":
      return typeof obj.goalId === "string" && typeof obj.objective === "string" && typeof obj.sisyphus === "boolean" && typeof obj.autoContinue === "boolean";
    case "goal_focused":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_unfocused":
      return typeof obj.reason === "string";
    case "goal_paused":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.suggestedAction === undefined || typeof obj.suggestedAction === "string") && (obj.status === undefined || obj.status === "paused") && (obj.source === undefined || obj.source === "user" || obj.source === "agent");
    case "goal_resumed":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_tweaked":
      return typeof obj.goalId === "string" && typeof obj.changeSummary === "string";
    case "auditor_toggled":
      return typeof obj.goalId === "string" && typeof obj.enabled === "boolean";
    case "completion_requested":
      return typeof obj.goalId === "string" && (obj.summary === undefined || typeof obj.summary === "string");
    case "audit_started":
      return typeof obj.goalId === "string" && (obj.provider === undefined || typeof obj.provider === "string") && (obj.model === undefined || typeof obj.model === "string") && (obj.thinkingLevel === undefined || typeof obj.thinkingLevel === "string");
    case "audit_result":
      return typeof obj.goalId === "string" && (obj.verdict === "approved" || obj.verdict === "disapproved" || obj.verdict === "error") && typeof obj.report === "string";
    case "audit_skipped":
      return typeof obj.goalId === "string" && (obj.reason === "disabled" || obj.reason === "user_aborted") && (obj.provider === undefined || typeof obj.provider === "string") && (obj.model === undefined || typeof obj.model === "string") && (obj.thinkingLevel === undefined || typeof obj.thinkingLevel === "string");
    case "goal_completed":
      return typeof obj.goalId === "string" && (obj.archivePath === undefined || typeof obj.archivePath === "string");
    case "goal_archived":
      return typeof obj.goalId === "string" && typeof obj.archivePath === "string";
    case "goal_archive_failed":
      return typeof obj.goalId === "string" && typeof obj.message === "string";
    case "goal_aborted":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.archivePath === undefined || typeof obj.archivePath === "string");
    case "task_list_set":
      return typeof obj.goalId === "string" && typeof obj.taskCount === "number" && typeof obj.blockCompletion === "boolean";
    case "task_complete":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string" && (obj.evidence === undefined || typeof obj.evidence === "string");
    case "task_skipped":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string" && typeof obj.reason === "string";
    case "task_reopened":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string";
    case "task_started":
      return typeof obj.goalId === "string" && typeof obj.taskId === "string";
    case "goal_budget_changed":
      return typeof obj.goalId === "string" && (obj.oldBudget === null || (Number.isSafeInteger(obj.oldBudget) && Number(obj.oldBudget) > 0)) && (obj.newBudget === null || (Number.isSafeInteger(obj.newBudget) && Number(obj.newBudget) > 0)) && typeof obj.tokensUsed === "number";
    case "goal_budget_limited":
      return typeof obj.goalId === "string" && typeof obj.budget === "number" && typeof obj.tokensUsed === "number";
    case "goal_budget_warning":
      return typeof obj.goalId === "string" && typeof obj.budget === "number" && typeof obj.tokensUsed === "number" && typeof obj.pct === "number";
    case "goal_stalled":
      return typeof obj.goalId === "string" && typeof obj.reason === "string";
    case "goal_blocked":
      return typeof obj.goalId === "string" && typeof obj.reason === "string" && (obj.source === "agent" || obj.source === "system");
    case "oracle_started":
      return typeof obj.goalId === "string" && typeof obj.fingerprint === "string" && typeof obj.provider === "string" && typeof obj.model === "string" && typeof obj.reason === "string" && (obj.thinkingLevel === undefined || typeof obj.thinkingLevel === "string");
    case "oracle_result":
      return typeof obj.goalId === "string" && typeof obj.fingerprint === "string" && typeof obj.adviceId === "string" && (obj.disposition === "actionable" || obj.disposition === "needs_human" || obj.disposition === "insufficient_context") && typeof obj.summary === "string";
    case "oracle_failed":
      return typeof obj.goalId === "string" && typeof obj.fingerprint === "string" && typeof obj.attempt === "number" && (obj.errorCode === "config" || obj.errorCode === "provider" || obj.errorCode === "aborted" || obj.errorCode === "invalid_output") && typeof obj.message === "string";
    case "oracle_followup_attempted":
      return typeof obj.goalId === "string" && typeof obj.fingerprint === "string" && typeof obj.adviceId === "string" && typeof obj.firstToolName === "string";
    default:
      return false;
  }
}

function sanitizeEvent(event: GoalLedgerEvent, owned = false): GoalLedgerEvent {
  if (!("goalId" in event)) return event;
  const goalId = safeGoalId(event.goalId);
  // Parsed JSON is privately owned; avoid allocating a second object per line.
  // Caller-supplied append events still get a defensive copy.
  if (owned) { event.goalId = goalId; return event; }
  return { ...event, goalId };
}

export function reconstructGoalLedger(events: GoalLedgerEvent[]): ReconstructedLedgerState {
  // Inline accumulator allocation (no helper call on the measured path).
  return finalizeLedgerState(applyLedgerEvents({
    goals: new Map(),
    terminalGoals: new Map(),
    focusedGoalId: null,
    focusGeneration: 0,
    focusGenByGoal: new Map(),
  }, events));
}

/** Reconstruction state for a caller-supplied (bounded) event window. */
interface ReconstructAccumulator {
  goals: Map<string, ReconstructedGoalState>;
  terminalGoals: Map<string, ReconstructedGoalState>;
  focusedGoalId: string | null;
  focusGeneration: number;
  focusGenByGoal: Map<string, number>;
}

function applyLedgerEvents(acc: ReconstructAccumulator, events: GoalLedgerEvent[]): ReconstructAccumulator {
  // Locals instead of property chains: B3.reconstruct is measured over 10k
  // event lists and must hold the NAF 10x headroom (0.3ms at 5k).
  const goals = acc.goals;
  const terminalGoals = acc.terminalGoals;
  const focusGenByGoal = acc.focusGenByGoal;
  let focusedGoalId = acc.focusedGoalId;
  let focusGeneration = acc.focusGeneration;
  for (const event of events) {
    switch (event.type) {
      case "goal_created": {
        const state: ReconstructedGoalState = {
          goalId: event.goalId,
          latestStatus: "active",
          latestFocus: false,
          createdAt: event.at,
        };
        goals.set(event.goalId, state);
        break;
      }
      case "goal_focused": {
        focusedGoalId = event.goalId;
        focusGeneration++;
        const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
        if (state) focusGenByGoal.set(event.goalId, focusGeneration);
        break;
      }
      case "goal_unfocused": {
        focusedGoalId = null;
        focusGeneration++;
        break;
      }
      case "goal_paused": {
        const state = goals.get(event.goalId);
        if (state) {
          state.latestStatus = event.status ?? "paused";
          state.latestPauseReason = event.reason;
          state.latestPauseSuggestedAction = event.suggestedAction;
        }
        break;
      }
      case "goal_resumed": {
        const state = goals.get(event.goalId);
        if (state) {
          state.latestStatus = "active";
          state.resumedAt = event.at;
          delete state.latestPauseReason;
          delete state.latestPauseSuggestedAction;
        }
        break;
      }
      case "goal_tweaked": {
        const state = goals.get(event.goalId);
        if (state) state.tweakedAt = event.at;
        break;
      }
      case "completion_requested": {
        // No status change until audit_result or goal_completed
        break;
      }
      case "audit_started":
      case "audit_skipped":
      case "audit_result": {
        const state = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
        if (state && auditApplies(state.latestAuditId, event)) {
          state.latestAuditId = event.auditId;
          state.latestAuditorResult = event.type === "audit_result"
            ? {verdict: event.verdict, report: event.report, at: event.at} : undefined;
        }
        break;
      }
      case "goal_completed": {
        let state = goals.get(event.goalId);
        if (!state) {
          state = { goalId: event.goalId, latestStatus: "complete", latestFocus: false };
        }
        state.latestStatus = "complete";
        state.completedAt = event.at;
        terminalGoals.set(event.goalId, state);
        goals.delete(event.goalId);
        break;
      }
      case "goal_aborted": {
        let state = goals.get(event.goalId);
        if (!state) {
          state = { goalId: event.goalId, latestStatus: "aborted", latestFocus: false };
        }
        state.latestStatus = "aborted";
        state.abortedAt = event.at;
        terminalGoals.set(event.goalId, state);
        goals.delete(event.goalId);
        break;
      }
      case "oracle_started":
      case "oracle_failed":
      case "oracle_followup_attempted": {
        // Bounded metadata only; no reconstructed state change.
        break;
      }
      case "oracle_result": {
        const oracleState = goals.get(event.goalId) ?? terminalGoals.get(event.goalId);
        if (oracleState) {
          oracleState.latestOracleResult = {
            fingerprint: event.fingerprint,
            adviceId: event.adviceId,
            disposition: event.disposition,
            summary: event.summary,
            at: event.at,
          };
        }
        break;
      }
    }
  }
  acc.focusedGoalId = focusedGoalId;
  acc.focusGeneration = focusGeneration;
  return acc;
}

/** Materialize focus flags once (O(goals)), clearing focus on terminal goals. */
function finalizeLedgerState(acc: ReconstructAccumulator): ReconstructedLedgerState {
  const { goals, terminalGoals, focusGenByGoal } = acc;
  const focusGeneration = acc.focusGeneration;
  // Materialize the generation-based focus flags (O(goals) once, not per event).
  for (const g of goals.values()) g.latestFocus = focusGenByGoal.get(g.goalId) === focusGeneration;
  for (const g of terminalGoals.values()) g.latestFocus = focusGenByGoal.get(g.goalId) === focusGeneration;

  // If the focused goal was moved to terminal (e.g., aborted/completed), clear focus.
  if (acc.focusedGoalId && !goals.has(acc.focusedGoalId)) {
    acc.focusedGoalId = null;
  }

  return { focusedGoalId: acc.focusedGoalId, goals, terminalGoals };
}

type AuditEvent = Extract<GoalLedgerEvent, {type: "audit_started" | "audit_result" | "audit_skipped"}>;

/** New attempts supersede old verdicts; overlapping attempts match by identity. */
export function latestAuditForGoal(events: GoalLedgerEvent[], goalId: string): AuditEvent | undefined {
 let latest: AuditEvent | undefined;
 for (const event of events) {
  if ((event.type === "audit_started" || event.type === "audit_result" || event.type === "audit_skipped") && event.goalId === goalId && auditApplies(latest?.auditId, event)) latest = event;
 }
 return latest;
}

export function latestAuditorResultForGoal(events: GoalLedgerEvent[], goalId: string): {verdict: "approved" | "disapproved" | "error"; report: string; at: string} | undefined {
 const latest = latestAuditForGoal(events, goalId);
 return latest?.type === "audit_result" ? {verdict: latest.verdict, report: latest.report, at: latest.at} : undefined;
}

export function latestSettledAuditorResultForGoal(events: GoalLedgerEvent[], goalId: string): { verdict: "approved" | "disapproved" | "error"; report: string; at: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === "audit_result" && event.goalId === goalId) {
      return { verdict: event.verdict, report: event.report, at: event.at };
    }
  }
  return undefined;
}

export function latestEventsForGoal(events: GoalLedgerEvent[], goalId: string, limit = 10): GoalLedgerEvent[] {
  const result: GoalLedgerEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if ("goalId" in event && event.goalId === goalId) {
      result.unshift(event);
      if (result.length >= limit) break;
    }
  }
  return result;
}

export function latestGoalLifecycleEvent(events: GoalLedgerEvent[], goalId: string): GoalLedgerEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if ("goalId" in event && event.goalId === goalId) {
      return event;
    }
  }
  return undefined;
}
