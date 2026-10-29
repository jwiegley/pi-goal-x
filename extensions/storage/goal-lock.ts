/**
 * Short per-goal filesystem locks with ownership tokens.
 *
 * A lock is `.pi/goals/.locks/<goalId>.lock` holding { pid, startedAt, token },
 * created exclusively and verified. Creating a lock and recovering a stale
 * one are serialized by a short-lived ownership gate (`<lock>.gate`) created
 * the same way; a contender that finds a live owner waits without taking it.
 * A lock is stale only when its owner pid is dead or its payload is
 * malformed: age alone never lets one writer take over from a live one. A lock
 * is released only after its identity, token and bytes match what this holder
 * wrote, by claiming exactly that inode, so a successor's lock is never
 * removed. An abandoned gate fails closed; /goal-recovery reports it for
 * offline removal. Acquisition stays bounded and fails fast under contention;
 * the optimistic revision check (goal-service.ts) still detects stale writers.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GoalFileContext } from "./goal-files.ts";
import { ensureGoalStorageDirectory, goalStoragePath } from "./goal-root.ts";
import {
	assertSafeFileAncestors,
	claimRegularFile,
	discardClaimedRegularFile,
	discardCreatedRegularFile,
	openRegularFile,
	ProtectedFileChangedError,
	readRegularFile,
	restoreClaimedRegularFile,
	sameRegularFile,
	type ClaimedRegularFile,
	type ReadRegularFile,
	type RegularFileIdentity,
	writeAll,
} from "./safe-fs.ts";

export const GOAL_LOCK_DIR = ".pi/goals/.locks";
export const MAX_GOAL_LOCK_BYTES = 16 * 1024;

export interface GoalLock {
	release(): void;
}

function runWithCleanup<T>(
	body: () => T,
	cleanup: () => void,
	message: string,
	onCleanupFailure?: (error: unknown) => void,
): T {
	let bodyCompleted = false;
	let result: T | undefined;
	let bodyFailure: unknown;
	try {
		result = body();
		bodyCompleted = true;
	} catch (error) {
		bodyFailure = error;
	}
	try {
		cleanup();
	} catch (cleanupFailure) {
		if (!bodyCompleted) {
			throw new AggregateError(
				[bodyFailure, cleanupFailure],
				message,
				{ cause: bodyFailure },
			);
		}
		if (onCleanupFailure) {
			try {
				onCleanupFailure(cleanupFailure);
			} catch {
				// An observer must not turn a completed authoritative operation into a
				// retry signal. The original cleanup failure remains intentionally
				// non-fatal on this path.
			}
			return result as T;
		}
		throw cleanupFailure;
	}
	if (!bodyCompleted) throw bodyFailure;
	return result as T;
}

/**
 * Run a synchronous critical section without masking simultaneous failures.
 * A caller that supplies `onReleaseFailure` has an authoritative completed
 * result to preserve; its non-throwing diagnostic sink observes the stranded-
 * lock condition without falsely inviting a retry of an already-committed
 * mutation. Observer exceptions are suppressed for the same reason.
 */
export function withGoalLock<T>(
	lock: GoalLock,
	body: () => T,
	onReleaseFailure?: (error: unknown) => void,
): T {
	return runWithCleanup(
		body,
		() => lock.release(),
		"Goal-lock operation and release both failed.",
		onReleaseFailure,
	);
}

export interface GoalLockInspection {
	fileName: string;
	pid: number;
	startedAt: string;
	ageMs: number;
	identity: RegularFileIdentity;
	bytes: Buffer;
	token: string | undefined;
}

export class GoalLockRecoveryError extends Error {
	readonly stage: "validate" | "backup" | "revalidate" | "unlink";

	constructor(stage: "validate" | "backup" | "revalidate" | "unlink", message: string, options?: ErrorOptions) {
		super(message, options);
		this.stage = stage;
	}
}

const DEFAULT_ACQUIRE_ATTEMPTS = 8;
const DEFAULT_RELEASE_ATTEMPTS = 3;
const DEFAULT_RETRY_MS = 1;
const DEFAULT_STALE_TTL_MS = 30_000;

function safeLockName(goalId: string): string {
	return goalId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function checkedLockFileName(fileName: string): string {
	if (path.basename(fileName) !== fileName || !/^[A-Za-z0-9._-]+\.lock$/.test(fileName)) {
		throw new Error(`Unsafe goal lock name: ${fileName}`);
	}
	return fileName;
}

function checkedGateFileName(fileName: string): string {
	if (path.basename(fileName) !== fileName || !/^[A-Za-z0-9._-]+\.lock\.gate$/.test(fileName)) {
		throw new Error(`Unsafe goal-lock gate name: ${fileName}`);
	}
	return fileName;
}

function lockDir(ctx: GoalFileContext): string {
	return goalStoragePath(ctx, GOAL_LOCK_DIR);
}

function lockPathForName(ctx: GoalFileContext, fileName: string): string {
	return path.join(lockDir(ctx), checkedLockFileName(fileName));
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function sleepMs(ms: number): void {
	const buffer = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(buffer, 0, 0, ms);
}

interface OwnershipPayload {
	pid: number;
	startedAt: string;
	token: string;
}

interface OwnershipFile {
	fd: number | null;
	identity: RegularFileIdentity;
	payload: OwnershipPayload;
	bytes: Buffer;
}

function validOwnershipToken(value: unknown): value is string {
	return typeof value === "string"
		&& /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function createOwnershipFile(ctx: GoalFileContext, filePath: string): OwnershipFile {
	ensureGoalStorageDirectory(ctx, GOAL_LOCK_DIR);
	const payload: OwnershipPayload = {
		pid: process.pid,
		startedAt: new Date().toISOString(),
		token: randomUUID(),
	};
	const bytes = Buffer.from(JSON.stringify(payload), "utf8");
	const opened = openRegularFile(
		ctx.cwd,
		filePath,
		fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
	);
	try {
		// No fsync: a lock or gate whose bytes a crash loses reads as malformed,
		// which is exactly how a dead owner's file is treated anyway.
		writeAll(opened.fd, bytes);
		const beforeRead = fs.fstatSync(opened.fd);
		const verified = Buffer.allocUnsafe(bytes.length);
		let used = 0;
		while (used < verified.length) {
			const count = fs.readSync(opened.fd, verified, used, verified.length - used, used);
			if (count === 0) break;
			used += count;
		}
		const after = fs.fstatSync(opened.fd);
		if (
			!beforeRead.isFile()
			|| !after.isFile()
			|| beforeRead.dev !== after.dev
			|| beforeRead.ino !== after.ino
			|| beforeRead.size !== after.size
			|| beforeRead.mtimeMs !== after.mtimeMs
			|| beforeRead.ctimeMs !== after.ctimeMs
			|| used !== bytes.length
			|| !verified.equals(bytes)
		) throw new Error(`Goal-lock ownership bytes changed during creation: ${filePath}`);
		assertSafeFileAncestors(ctx.cwd, filePath);
		const linked = fs.lstatSync(filePath);
		if (
			linked.isSymbolicLink()
			|| !linked.isFile()
			|| linked.dev !== after.dev
			|| linked.ino !== after.ino
			|| linked.size !== after.size
			|| linked.mtimeMs !== after.mtimeMs
			|| linked.ctimeMs !== after.ctimeMs
		) throw new Error(`Goal-lock ownership path changed during creation: ${filePath}`);
		return {
			fd: opened.fd,
			identity: {
				dev: after.dev,
				ino: after.ino,
				size: after.size,
				mtimeMs: after.mtimeMs,
				ctimeMs: after.ctimeMs,
			},
			payload,
			bytes,
		};
	} catch (error) {
		// O_EXCL created this inode. If validation/fsync fails, conditionally
		// claim that exact inode so a failed acquisition does not strand a live
		// PID token. A raced successor is restored and never removed.
		const failures: unknown[] = [error];
		try {
			discardCreatedRegularFile(
				ctx.cwd,
				filePath,
				opened.fd,
				MAX_GOAL_LOCK_BYTES,
				"create-failed",
			);
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
		try {
			fs.closeSync(opened.fd);
		} catch (closeError) {
			failures.push(closeError);
		}
		if (failures.length > 1) {
			throw new AggregateError(
				failures,
				`Goal-lock ownership creation failed and cleanup was incomplete: ${filePath}`,
				{ cause: error },
			);
		}
		throw error;
	}
}

interface ReadOwnershipFile extends RegularFileIdentity {
	bytes: Buffer;
	pid: number;
	startedAt: string;
	token: string | undefined;
}

function readOwnershipFile(ctx: GoalFileContext, filePath: string): ReadOwnershipFile {
	return ownershipFromRegularFile(readRegularFile(ctx.cwd, filePath, MAX_GOAL_LOCK_BYTES));
}

function ownershipFromRegularFile(file: ReadRegularFile): ReadOwnershipFile {
	let raw: unknown;
	try {
		raw = JSON.parse(file.bytes.toString("utf8")) as unknown;
	} catch {
		raw = null;
	}
	const object = raw && typeof raw === "object" && !Array.isArray(raw)
		? raw as Record<string, unknown>
		: null;
	return {
		...file,
		pid: typeof object?.pid === "number" ? object.pid : 0,
		startedAt: typeof object?.startedAt === "string" ? object.startedAt : "",
		token: validOwnershipToken(object?.token) ? object.token : undefined,
	};
}

function ageOf(file: ReadOwnershipFile, now: number): number {
	const startedMs = new Date(file.startedAt).getTime();
	return Number.isFinite(startedMs)
		? Math.max(0, now - startedMs)
		: Math.max(0, now - file.mtimeMs);
}

function stale(file: ReadOwnershipFile, _now: number, _ttlMs: number): boolean {
	// Age is diagnostic only. A live owner may legitimately hold a goal lock for
	// longer than the historical TTL; stealing it would overlap two writers.
	// Dead/malformed owners remain immediately recoverable.
	return !pidAlive(file.pid);
}

/**
 * Holders release without the gate, so a lock can vanish, or change identity
 * as its holder claims it for removal, while a contender or the recovery scan
 * reads it. That is contention to retry, not a failure.
 */
function releasedWhileRead(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof ProtectedFileChangedError;
}

/**
 * A contender that finds a live owner waits without taking the gate, so
 * contention costs one checked read per attempt. The gate is taken only to
 * create the lock or to recover a stale one, and both decisions are made
 * again under it.
 */
function heldByLiveOwner(ctx: GoalFileContext, filePath: string, ttlMs: number): boolean {
	try {
		return !stale(readOwnershipFile(ctx, filePath), Date.now(), ttlMs);
	} catch (error) {
		if (releasedWhileRead(error)) return false;
		throw error;
	}
}

function sameOpenedBytes(left: ReadOwnershipFile, right: ReadOwnershipFile): boolean {
	return sameRegularFile(left, right) && left.bytes.equals(right.bytes);
}

function claimOwnershipFile(
	ctx: GoalFileContext,
	filePath: string,
	expected: ReadOwnershipFile,
	label: string,
): { claim: ClaimedRegularFile; current: ReadOwnershipFile } {
	const claim = claimRegularFile(ctx.cwd, filePath, MAX_GOAL_LOCK_BYTES, label);
	const current = ownershipFromRegularFile(claim.file);
	if (!sameOpenedBytes(current, expected)) {
		try {
			restoreClaimedRegularFile(ctx.cwd, filePath, claim);
		} catch {
			// A successor already owns the canonical path. Keep the mismatched
			// quarantine for manual recovery; never overwrite or unlink the successor.
		}
		throw new Error(`Goal lock changed before removal: ${path.basename(filePath)}`);
	}
	return { claim, current };
}

function removeOwnershipFile(ctx: GoalFileContext, filePath: string, expected: ReadOwnershipFile, label: string): void {
	const claimed = claimOwnershipFile(ctx, filePath, expected, label);
	discardClaimedRegularFile(ctx.cwd, claimed.claim);
}

function gatePath(lockPath: string): string {
	return `${lockPath}.gate`;
}

function closeOwnershipFile(owned: OwnershipFile): void {
	if (owned.fd === null) return;
	const fd = owned.fd;
	// A failed close has unspecified descriptor state; never retry the same fd.
	owned.fd = null;
	fs.closeSync(fd);
}

function releaseOwnershipFile(ctx: GoalFileContext, filePath: string, owned: OwnershipFile): void {
	try {
		const current = readOwnershipFile(ctx, filePath);
		if (
			sameRegularFile(current, owned.identity)
			&& current.token === owned.payload.token
			&& current.bytes.equals(owned.bytes)
		) removeOwnershipFile(ctx, filePath, current, "release");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	closeOwnershipFile(owned);
}

function releaseOwnershipFileWithRetries(
	ctx: GoalFileContext,
	filePath: string,
	owned: OwnershipFile,
	attempts = DEFAULT_RELEASE_ATTEMPTS,
	retryMs = DEFAULT_RETRY_MS,
): void {
	let failure: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			releaseOwnershipFile(ctx, filePath, owned);
			return;
		} catch (error) {
			failure = error;
			if (attempt + 1 < attempts) sleepMs(retryMs);
		}
	}
	throw failure ?? new Error(`Could not release goal-lock ownership path: ${filePath}`);
}

function acquireGate(
	ctx: GoalFileContext,
	lockPath: string,
	attempts = DEFAULT_ACQUIRE_ATTEMPTS,
	retryMs = DEFAULT_RETRY_MS,
): OwnershipFile {
	const filePath = gatePath(lockPath);
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return createOwnershipFile(ctx, filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Fail closed on abandoned gates. Reaping this guard would itself need
			// another guard and recreates the compare-then-delete race it prevents.
			// The recovery report exposes a stranded gate for offline manual repair
			// after every Goal-X writer has stopped.
			sleepMs(retryMs);
		}
	}
	throw new Error(`Timed out acquiring the goal-lock ownership gate (${attempts} attempts).`);
}

function withGate<T>(ctx: GoalFileContext, lockPath: string, body: () => T): T {
	const gate = acquireGate(ctx, lockPath);
	return runWithCleanup(
		body,
		() => releaseOwnershipFileWithRetries(ctx, gatePath(lockPath), gate),
		"Goal-lock recovery and ownership-gate release both failed.",
	);
}

export function inspectGoalLock(
	ctx: GoalFileContext,
	fileName: string,
	now = Date.now(),
	ttlMs = DEFAULT_STALE_TTL_MS,
): GoalLockInspection | null {
	const filePath = lockPathForName(ctx, fileName);
	return inspectOwnershipPath(ctx, fileName, filePath, now, ttlMs);
}

/** Inspect an abandoned cooperative ownership gate without acquiring itself. */
export function inspectGoalLockGate(
	ctx: GoalFileContext,
	fileName: string,
	now = Date.now(),
	ttlMs = DEFAULT_STALE_TTL_MS,
): GoalLockInspection | null {
	const checked = checkedGateFileName(fileName);
	return inspectOwnershipPath(ctx, checked, path.join(lockDir(ctx), checked), now, ttlMs);
}

function inspectOwnershipPath(
	ctx: GoalFileContext,
	fileName: string,
	filePath: string,
	now: number,
	ttlMs: number,
): GoalLockInspection | null {
	let file: ReadOwnershipFile;
	try {
		file = readOwnershipFile(ctx, filePath);
	} catch (error) {
		if (releasedWhileRead(error)) return null;
		throw error;
	}
	if (!stale(file, now, ttlMs)) return null;
	return {
		fileName,
		pid: file.pid,
		startedAt: file.startedAt,
		ageMs: ageOf(file, now),
		identity: file,
		bytes: file.bytes,
		token: file.token,
	};
}

/** Back up and remove one stale lock while blocking cooperative successors. */
export function recoverStaleGoalLock(
	ctx: GoalFileContext,
	fileName: string,
	backup: (bytes: Buffer) => void,
): void {
	const lockPath = lockPathForName(ctx, fileName);
	withGate(ctx, lockPath, () => recoverOwnershipPath(
		ctx,
		lockPath,
		() => inspectGoalLock(ctx, fileName),
		backup,
	));
}

function recoverOwnershipPath(
	ctx: GoalFileContext,
	filePath: string,
	inspect: () => GoalLockInspection | null,
	backup: (bytes: Buffer) => void,
): void {
	let before: GoalLockInspection;
	try {
		const inspected = inspect();
		if (!inspected) throw new Error("lock is no longer stale");
		before = inspected;
	} catch (error) {
		throw new GoalLockRecoveryError("validate", error instanceof Error ? error.message : String(error), { cause: error });
	}
	try {
		backup(Buffer.from(before.bytes));
	} catch (error) {
		throw new GoalLockRecoveryError("backup", error instanceof Error ? error.message : String(error), { cause: error });
	}
	let after: GoalLockInspection;
	try {
		const inspected = inspect();
		if (!inspected || !sameRegularFile(before.identity, inspected.identity) || !before.bytes.equals(inspected.bytes)) {
			throw new Error("lock changed while its recovery backup was being created");
		}
		after = inspected;
	} catch (error) {
		throw new GoalLockRecoveryError("revalidate", error instanceof Error ? error.message : String(error), { cause: error });
	}
	try {
		removeOwnershipFile(ctx, filePath, {
			...after.identity,
			bytes: after.bytes,
			pid: after.pid,
			startedAt: after.startedAt,
			token: after.token,
		}, "recovery");
	} catch (error) {
		throw new GoalLockRecoveryError("unlink", error instanceof Error ? error.message : String(error), { cause: error });
	}
}

function acquireMainOwnershipUnderGate(
	ctx: GoalFileContext,
	filePath: string,
	ttlMs: number,
): OwnershipFile | null {
	try {
		return createOwnershipFile(ctx, filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	let current: ReadOwnershipFile;
	try {
		current = readOwnershipFile(ctx, filePath);
	} catch (error) {
		if (releasedWhileRead(error)) return null;
		throw error;
	}
	if (!stale(current, Date.now(), ttlMs)) return null;
	removeOwnershipFile(ctx, filePath, current, "stale-lock");
	return createOwnershipFile(ctx, filePath);
}

function goalLockHandle(
	ctx: GoalFileContext,
	filePath: string,
	ownership: OwnershipFile,
	pendingGate: OwnershipFile | null,
	retryMs: number,
): GoalLock {
	let mainReleased = false;
	let gateReleased = pendingGate === null;
	return {
		release(): void {
			if (!mainReleased) {
				// A pending gate remains held until the main lock has definitely left
				// the canonical path, then each resource can be retried independently.
				releaseOwnershipFileWithRetries(
					ctx,
					filePath,
					ownership,
					DEFAULT_RELEASE_ATTEMPTS,
					retryMs,
				);
				mainReleased = true;
			}
			if (!gateReleased && pendingGate) {
				releaseOwnershipFileWithRetries(
					ctx,
					gatePath(filePath),
					pendingGate,
					DEFAULT_RELEASE_ATTEMPTS,
					retryMs,
				);
				gateReleased = true;
			}
		},
	};
}

/** Acquire a per-goal lock with bounded contention and stale-owner recovery. */
export function acquireGoalLock(
	ctx: GoalFileContext,
	goalId: string,
	opts: { attempts?: number; retryMs?: number; staleTtlMs?: number } = {},
): GoalLock {
	const attempts = opts.attempts ?? DEFAULT_ACQUIRE_ATTEMPTS;
	const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
	const ttlMs = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
	const fileName = `${safeLockName(goalId)}.lock`;
	const filePath = lockPathForName(ctx, fileName);
	ensureGoalStorageDirectory(ctx, GOAL_LOCK_DIR);

	for (let attempt = 0; attempt < attempts; attempt++) {
		if (heldByLiveOwner(ctx, filePath, ttlMs)) {
			sleepMs(retryMs);
			continue;
		}
		const gate = acquireGate(ctx, filePath, attempts, retryMs);
		let owned: OwnershipFile | null;
		try {
			owned = acquireMainOwnershipUnderGate(ctx, filePath, ttlMs);
		} catch (error) {
			try {
				releaseOwnershipFileWithRetries(
					ctx,
					gatePath(filePath),
					gate,
					DEFAULT_RELEASE_ATTEMPTS,
					retryMs,
				);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					`Goal-lock acquisition and ownership-gate release both failed: ${fileName}`,
					{ cause: error },
				);
			}
			throw error;
		}
		try {
			releaseOwnershipFileWithRetries(
				ctx,
				gatePath(filePath),
				gate,
				DEFAULT_RELEASE_ATTEMPTS,
				retryMs,
			);
		} catch (error) {
			// Main ownership is committed. Retain the failed gate lease in the
			// returned handle instead of throwing away both live-PID tokens.
			if (owned) return goalLockHandle(ctx, filePath, owned, gate, retryMs);
			throw error;
		}
		if (owned) return goalLockHandle(ctx, filePath, owned, null, retryMs);
		sleepMs(retryMs);
	}
	throw new Error(`Timed out acquiring the goal lock for ${goalId} (${attempts} attempts). Another writer may hold it.`);
}
