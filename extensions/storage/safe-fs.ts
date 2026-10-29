import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { renameAtomicSync } from "./atomic-rename.ts";

/**
 * Descriptor-safe I/O below assumes `root` is a stable, private, user-owned
 * directory and every process mutating it cooperates with Goal-X protocols.
 * Unexpected symlinks and special files are rejected; final regular files use
 * O_NOFOLLOW plus fstat/path identity checks, and reads are bounded on one
 * descriptor. Node does not expose openat/renameat/unlinkat or conditional
 * final-name operations. A hostile or uncooperative same-UID process can race
 * checks by swapping an ancestor or final pathname, so protection against that
 * actor requires a native dirfd-based seam and is outside this contract.
 */

export interface RegularFileIdentity {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

export interface OpenedRegularFile {
	fd: number;
	identity: RegularFileIdentity;
}

export interface ReadRegularFile extends RegularFileIdentity {
	bytes: Buffer;
}

export interface ClaimedRegularFile {
	quarantineDir: string;
	quarantinePath: string;
	file: ReadRegularFile;
}

function containedRelative(root: string, target: string): string {
	const absoluteRoot = path.resolve(root);
	const absoluteTarget = path.resolve(target);
	const relative = path.relative(absoluteRoot, absoluteTarget);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Protected path escapes its root: ${absoluteTarget}`);
	}
	return relative;
}

function requireDirectory(directory: string): void {
	const stat = fs.lstatSync(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`Protected path has a non-directory or symlink ancestor: ${directory}`);
	}
}

/** Ensure a descendant directory without following a symlink at any managed component. */
export function ensureSafeDirectory(root: string, directory: string): void {
	const absoluteRoot = path.resolve(root);
	const relative = containedRelative(absoluteRoot, directory);
	try {
		requireDirectory(absoluteRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		fs.mkdirSync(absoluteRoot, { recursive: true, mode: 0o700 });
		requireDirectory(absoluteRoot);
	}
	let current = absoluteRoot;
	for (const component of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			requireDirectory(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				fs.mkdirSync(current, { mode: 0o700 });
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
			}
			requireDirectory(current);
		}
	}
}

/** Reject symlinks and non-directories in every managed ancestor of a file. */
export function assertSafeFileAncestors(root: string, filePath: string): void {
	const absoluteRoot = path.resolve(root);
	const relative = containedRelative(absoluteRoot, filePath);
	requireDirectory(absoluteRoot);
	let current = absoluteRoot;
	const components = relative.split(path.sep).filter(Boolean);
	for (const component of components.slice(0, -1)) {
		current = path.join(current, component);
		requireDirectory(current);
	}
}

function identityOf(stat: fs.Stats): RegularFileIdentity {
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
	};
}

/**
 * Remove only the inode created on an exclusive descriptor that is still open.
 * The open descriptor pins its identity while the canonical name is claimed;
 * a different canonical inode is restored without being deleted.
 */
export function discardCreatedRegularFile(
	root: string,
	filePath: string,
	fd: number,
	maxBytes: number,
	label: string,
): "removed" | "missing" | "replaced" {
	const created = fs.fstatSync(fd);
	let claim: ClaimedRegularFile;
	try {
		claim = claimRegularFile(root, filePath, maxBytes, label);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
	if (!sameRegularFile(claim.file, created)) {
		restoreClaimedRegularFile(root, filePath, claim);
		return "replaced";
	}
	discardClaimedRegularFile(root, claim);
	return "removed";
}

/**
 * A protected file or its path changed identity, size, timestamps or bytes
 * while it was being opened or read, typically because another process renamed,
 * replaced or removed it at that moment. Callers decide whether that is
 * contention to retry or a failure.
 */
export class ProtectedFileChangedError extends Error {}

/** Open one regular file descriptor without following the final path component. */
export function openRegularFile(
	root: string,
	filePath: string,
	flags: number,
	mode = 0o600,
): OpenedRegularFile {
	assertSafeFileAncestors(root, filePath);
	const fd = fs.openSync(filePath, flags | fs.constants.O_NOFOLLOW, mode);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) throw new Error(`Protected path is not a regular file: ${filePath}`);
		// Re-walk after open and require the pathname to still name this inode. This
		// closes ordinary ancestor/final swaps around O_NOFOLLOW; the managed root
		// itself remains the caller's trust boundary because Node exposes no openat.
		assertSafeFileAncestors(root, filePath);
		const linked = fs.lstatSync(filePath);
		if (linked.isSymbolicLink() || !linked.isFile() || linked.dev !== stat.dev || linked.ino !== stat.ino) {
			throw new ProtectedFileChangedError(`Protected path changed while it was being opened: ${filePath}`);
		}
		return { fd, identity: identityOf(stat) };
	} catch (error) {
		const failures: unknown[] = [error];
		if (
			(flags & fs.constants.O_CREAT) === fs.constants.O_CREAT
			&& (flags & fs.constants.O_EXCL) === fs.constants.O_EXCL
		) {
			try {
				discardCreatedRegularFile(root, filePath, fd, 0, "open-failed");
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
		}
		try {
			fs.closeSync(fd);
		} catch (closeError) {
			failures.push(closeError);
		}
		if (failures.length > 1) {
			throw new AggregateError(
				failures,
				`Protected file open failed and cleanup was incomplete: ${filePath}`,
				{ cause: error },
			);
		}
		throw error;
	}
}

function descriptorMatchesBytes(fd: number, expected: Buffer): boolean {
	const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected.length)));
	let position = 0;
	while (position < expected.length) {
		const length = Math.min(chunk.length, expected.length - position);
		const count = fs.readSync(fd, chunk, 0, length, position);
		if (count !== length || !chunk.subarray(0, count).equals(expected.subarray(position, position + count))) return false;
		position += count;
	}
	return true;
}

async function descriptorMatchesBytesAsync(handle: fs.promises.FileHandle, expected: Buffer): Promise<boolean> {
	const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected.length)));
	let position = 0;
	while (position < expected.length) {
		const length = Math.min(chunk.length, expected.length - position);
		const { bytesRead } = await handle.read(chunk, 0, length, position);
		if (
			bytesRead !== length
			|| !chunk.subarray(0, bytesRead).equals(expected.subarray(position, position + bytesRead))
		) return false;
		position += bytesRead;
	}
	return true;
}

/** Read a bounded regular file from the same descriptor used for validation. */
export function readRegularFile(
	root: string,
	filePath: string,
	maxBytes: number,
): ReadRegularFile {
	const opened = openRegularFile(
		root,
		filePath,
		fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
	);
	try {
		if (opened.identity.size > maxBytes) {
			throw new RangeError(`Protected file is ${opened.identity.size} bytes; the maximum is ${maxBytes}: ${filePath}`);
		}
		const bytes = Buffer.allocUnsafe(opened.identity.size);
		let used = 0;
		while (used < bytes.length) {
			const count = fs.readSync(opened.fd, bytes, used, bytes.length - used, used);
			if (count === 0) break;
			used += count;
		}
		const after = fs.fstatSync(opened.fd);
		if (
			after.dev !== opened.identity.dev
			|| after.ino !== opened.identity.ino
			|| after.size !== opened.identity.size
			|| after.mtimeMs !== opened.identity.mtimeMs
			|| after.ctimeMs !== opened.identity.ctimeMs
			|| used !== opened.identity.size
		) throw new ProtectedFileChangedError(`Protected file changed while it was being read: ${filePath}`);
		if (!descriptorMatchesBytes(opened.fd, bytes)) {
			throw new ProtectedFileChangedError(`Protected file changed while it was being read: ${filePath}`);
		}
		const verified = fs.fstatSync(opened.fd);
		if (
			verified.dev !== after.dev
			|| verified.ino !== after.ino
			|| verified.size !== after.size
			|| verified.mtimeMs !== after.mtimeMs
			|| verified.ctimeMs !== after.ctimeMs
		) throw new ProtectedFileChangedError(`Protected file changed while it was being read: ${filePath}`);
		assertSafeFileAncestors(root, filePath);
		const linked = fs.lstatSync(filePath);
		if (
			linked.isSymbolicLink()
			|| !linked.isFile()
			|| linked.dev !== verified.dev
			|| linked.ino !== verified.ino
			|| linked.size !== verified.size
			|| linked.mtimeMs !== verified.mtimeMs
			|| linked.ctimeMs !== verified.ctimeMs
		) {
			throw new ProtectedFileChangedError(`Protected path changed while it was being read: ${filePath}`);
		}
		return { ...identityOf(verified), bytes };
	} finally {
		try {
			fs.closeSync(opened.fd);
		} catch {
			// A read result or its primary validation failure remains authoritative;
			// never retry a descriptor whose close state is unspecified.
		}
	}
}

/** Async bounded read with the same descriptor/path validation as the sync seam. */
export async function readRegularFileAsync(
	root: string,
	filePath: string,
	maxBytes: number,
): Promise<ReadRegularFile> {
	assertSafeFileAncestors(root, filePath);
	const noFollow = fs.constants.O_NOFOLLOW ?? 0;
	const handle = await fs.promises.open(
		filePath,
		fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow,
	);
	try {
		const before = await handle.stat();
		if (!before.isFile()) {
			throw new Error(`Protected path is not a regular file: ${filePath}`);
		}
		if (before.size > maxBytes) {
			throw new RangeError(`Protected file is ${before.size} bytes; the maximum is ${maxBytes}: ${filePath}`);
		}
		const bytes = Buffer.allocUnsafe(before.size);
		let used = 0;
		while (used < bytes.length) {
			const { bytesRead } = await handle.read(
				bytes,
				used,
				bytes.length - used,
				used,
			);
			if (bytesRead === 0) break;
			used += bytesRead;
		}
		const after = await handle.stat();
		if (
			after.dev !== before.dev
			|| after.ino !== before.ino
			|| after.size !== before.size
			|| after.mtimeMs !== before.mtimeMs
			|| after.ctimeMs !== before.ctimeMs
			|| used !== before.size
		) throw new ProtectedFileChangedError(`Protected file changed while it was being read: ${filePath}`);
		if (!(await descriptorMatchesBytesAsync(handle, bytes))) {
			throw new ProtectedFileChangedError(`Protected file changed while it was being read: ${filePath}`);
		}
		const verified = await handle.stat();
		if (
			verified.dev !== after.dev
			|| verified.ino !== after.ino
			|| verified.size !== after.size
			|| verified.mtimeMs !== after.mtimeMs
			|| verified.ctimeMs !== after.ctimeMs
		) throw new ProtectedFileChangedError(`Protected file changed while it was being read: ${filePath}`);
		assertSafeFileAncestors(root, filePath);
		const linked = await fs.promises.lstat(filePath);
		if (
			linked.isSymbolicLink()
			|| !linked.isFile()
			|| linked.dev !== verified.dev
			|| linked.ino !== verified.ino
			|| linked.size !== verified.size
			|| linked.mtimeMs !== verified.mtimeMs
			|| linked.ctimeMs !== verified.ctimeMs
		) throw new ProtectedFileChangedError(`Protected path changed while it was being read: ${filePath}`);
		return { ...identityOf(verified), bytes };
	} finally {
		try {
			await handle.close();
		} catch {
			// Preserve the read/validation result and never retry an uncertain close.
		}
	}
}

export function writeAll(fd: number, bytes: Buffer): void {
	let written = 0;
	while (written < bytes.length) {
		const count = fs.writeSync(fd, bytes, written, bytes.length - written, null);
		if (count <= 0) throw new Error("Regular-file write made no progress.");
		written += count;
	}
}

export interface AtomicWriteOptions {
	/** Atomically rename over a prevalidated regular target. False uses no-clobber publication. */
	replace?: boolean;
}

function sameRegularFileIdentity(left: RegularFileIdentity, right: RegularFileIdentity): boolean {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.size === right.size
		&& left.mtimeMs === right.mtimeMs
		&& left.ctimeMs === right.ctimeMs;
}

/**
 * Publish bytes from an exclusive file inside an OS-random private directory.
 * The temporary pathname is never opened without O_EXCL/O_NOFOLLOW. When
 * `replace` is false, link(2) is the atomic no-clobber publication primitive;
 * an existing archive is preserved and the write fails with EEXIST. Ordinary
 * replacement validates an existing final target, then rename(2)s the verified
 * temp over it atomically so cooperating lock-free readers see old or new,
 * never an intentional absent-name interval. A replaced file keeps its
 * permission bits; a new file is private to its owner.
 */
export function atomicWriteRegularFile(
	root: string,
	filePath: string,
	bytes: Buffer,
	options: AtomicWriteOptions = {},
): void {
	const parent = path.dirname(filePath);
	ensureSafeDirectory(root, parent);
	assertSafeFileAncestors(root, filePath);
	let priorMode: number | undefined;
	if (options.replace !== false && process.platform !== "win32") {
		try {
			const prior = fs.lstatSync(filePath);
			if (prior.isFile()) priorMode = prior.mode & 0o777;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const tempDir = fs.mkdtempSync(path.join(parent, `.${path.basename(filePath)}.write-`));
	const tempPath = path.join(tempDir, "content");
	let fd: number | null = null;
	let published = false;
	let writeFailed = false;
	let writeFailure: unknown;
	try {
		const opened = openRegularFile(
			root,
			tempPath,
			fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
		);
		fd = opened.fd;
		// open(2) applies the umask; set the replaced file's bits explicitly.
		if (priorMode !== undefined) fs.fchmodSync(fd, priorMode);
		writeAll(fd, bytes);
		fs.fsyncSync(fd);
		const beforeVerify = fs.fstatSync(fd);
		if (!beforeVerify.isFile() || beforeVerify.size !== bytes.length) {
			throw new Error(`Exclusive temporary file changed while it was being written: ${tempPath}`);
		}
		const verified = Buffer.allocUnsafe(bytes.length);
		let verifiedBytes = 0;
		while (verifiedBytes < verified.length) {
			const count = fs.readSync(fd, verified, verifiedBytes, verified.length - verifiedBytes, verifiedBytes);
			if (count === 0) break;
			verifiedBytes += count;
		}
		const afterVerify = fs.fstatSync(fd);
		const beforeIdentity = identityOf(beforeVerify);
		const afterIdentity = identityOf(afterVerify);
		if (
			verifiedBytes !== bytes.length
			|| !verified.equals(bytes)
			|| !sameRegularFileIdentity(beforeIdentity, afterIdentity)
		) throw new Error(`Exclusive temporary bytes changed before publication: ${tempPath}`);

		assertSafeFileAncestors(root, filePath);
		const publicationFd = fd;
		const publicationCommitted = (): boolean => {
			try {
				assertSafeFileAncestors(root, filePath);
				const beforeRead = identityOf(fs.fstatSync(publicationFd));
				const publishedBytes = Buffer.allocUnsafe(bytes.length);
				let used = 0;
				while (used < publishedBytes.length) {
					const count = fs.readSync(
						publicationFd,
						publishedBytes,
						used,
						publishedBytes.length - used,
						used,
					);
					if (count === 0) break;
					used += count;
				}
				const afterRead = identityOf(fs.fstatSync(publicationFd));
				const target = fs.lstatSync(filePath);
				return !target.isSymbolicLink()
					&& target.isFile()
					&& used === bytes.length
					&& publishedBytes.equals(bytes)
					&& sameRegularFileIdentity(beforeRead, afterRead)
					&& afterRead.dev === afterIdentity.dev
					&& afterRead.ino === afterIdentity.ino
					&& afterRead.size === afterIdentity.size
					&& afterRead.mtimeMs === afterIdentity.mtimeMs
					&& target.dev === afterRead.dev
					&& target.ino === afterRead.ino
					&& target.size === afterRead.size;
			} catch {
				return false;
			}
		};
		if (options.replace === false) {
			// link(2) supplies no-clobber publication for archives and other names
			// whose pre-existence must remain an error.
			try {
				fs.linkSync(tempPath, filePath);
			} catch (error) {
				if (!publicationCommitted()) throw error;
			}
		} else {
			try {
				const target = fs.lstatSync(filePath);
				if (target.isSymbolicLink() || !target.isFile()) {
					throw new Error(`Protected path is a symbolic link or not a regular file: ${filePath}`);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			// Within the private/cooperating state-directory contract, rename(2) is
			// the atomic replacement primitive: readers observe the old inode or the
			// fully verified new inode, never a deliberate missing canonical name.
			try {
				// Windows sharing violations are retried briefly; POSIX renames once.
				renameAtomicSync(tempPath, filePath);
			} catch (error) {
				// A local filesystem/wrapper error can be reported after the atomic
				// rename took effect. Adopt only when the canonical name, open fd, and
				// verified bytes still prove that this exact publication committed.
				if (!publicationCommitted()) throw error;
			}
		}
		// The canonical name now identifies the verified temporary inode, so the
		// write is committed before any best-effort descriptor/private-name cleanup.
		// close(2) errors leave descriptor state unspecified: detach the descriptor
		// before closing so finally never retries it, and never report a committed
		// additive write as failed (which would make a caller apply the delta twice).
		published = true;
		const publishedFd = fd;
		fd = null;
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// The committed canonical file is authoritative. Preserve an unremoved
			// private name for manual cleanup instead of misreporting publication.
		}
		try {
			fs.closeSync(publishedFd);
		} catch {
			// Do not retry an fd whose close state is unknown, and do not turn a
			// committed write into a retryable application-level failure.
		}
	} catch (error) {
		writeFailed = true;
		writeFailure = error;
	}

	const cleanupFailures: unknown[] = [];
	if (fd !== null) {
		const failedFd = fd;
		fd = null;
		try {
			fs.closeSync(failedFd);
		} catch (error) {
			// close(2) leaves descriptor state unspecified. Record the failure, but
			// never retry the fd and never let it prevent the remaining rollback.
			cleanupFailures.push(error);
		}
	}
	if (!published) {
		try {
			fs.unlinkSync(tempPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				cleanupFailures.push(error);
			}
		}
	}
	try {
		fs.rmdirSync(tempDir);
	} catch (error) {
		if (writeFailed && (error as NodeJS.ErrnoException).code !== "ENOENT") {
			cleanupFailures.push(error);
		}
	}
	if (writeFailed) {
		if (cleanupFailures.length > 0) {
			throw new AggregateError(
				[writeFailure, ...cleanupFailures],
				`Atomic write failed and rollback was incomplete: ${filePath}`,
				{ cause: writeFailure },
			);
		}
		throw writeFailure;
	}
}

export function sameRegularFile(
	left: Pick<RegularFileIdentity, "dev" | "ino">,
	right: Pick<RegularFileIdentity, "dev" | "ino">,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/** Atomically remove the canonical name and read the claimed inode by a random private name. */
export function claimRegularFile(
	root: string,
	filePath: string,
	maxBytes: number,
	label: string,
): ClaimedRegularFile {
	assertSafeFileAncestors(root, filePath);
	const linked = fs.lstatSync(filePath);
	if (linked.isSymbolicLink() || !linked.isFile()) {
		throw new Error(`Protected path is a symbolic link or not a regular file: ${filePath}`);
	}
	const quarantineDir = fs.mkdtempSync(
		path.join(path.dirname(filePath), `.${path.basename(filePath)}.${label}-${process.pid}-${randomUUID()}-`),
	);
	const quarantinePath = path.join(quarantineDir, path.basename(filePath));
	assertSafeFileAncestors(root, quarantinePath);
	try {
		fs.renameSync(filePath, quarantinePath);
	} catch (error) {
		try {
			fs.rmdirSync(quarantineDir);
		} catch {
			// Preserve the original claim failure.
		}
		throw error;
	}
	try {
		return { quarantineDir, quarantinePath, file: readRegularFile(root, quarantinePath, maxBytes) };
	} catch (error) {
		try {
			// link() is the no-clobber restore primitive available in Node: a
			// successor at filePath makes it fail with EEXIST and remains untouched.
			fs.linkSync(quarantinePath, filePath);
			fs.unlinkSync(quarantinePath);
			fs.rmdirSync(quarantineDir);
		} catch {
			// Keep the random quarantine if a successor appeared or the claimed
			// object is not linkable. Never destroy an entry that was not validated.
		}
		throw error;
	}
}

/** Restore a claimed regular inode without overwriting a newly-created canonical path. */
export function restoreClaimedRegularFile(root: string, filePath: string, claim: ClaimedRegularFile): void {
	assertSafeFileAncestors(root, filePath);
	assertSafeFileAncestors(root, claim.quarantinePath);
	fs.linkSync(claim.quarantinePath, filePath);
	fs.unlinkSync(claim.quarantinePath);
	try {
		fs.rmdirSync(claim.quarantineDir);
	} catch {
		// The claimed inode is restored; an empty private directory is harmless.
	}
}

/** Delete only the random claimed name; a successor at the canonical path is untouched. */
export function discardClaimedRegularFile(root: string, claim: ClaimedRegularFile): void {
	assertSafeFileAncestors(root, claim.quarantinePath);
	const current = readRegularFile(root, claim.quarantinePath, claim.file.size);
	if (!sameRegularFile(current, claim.file) || !current.bytes.equals(claim.file.bytes)) {
		throw new Error(`Quarantined file changed before deletion: ${claim.quarantinePath}`);
	}
	fs.unlinkSync(claim.quarantinePath);
	try {
		fs.rmdirSync(claim.quarantineDir);
	} catch {
		// The protected inode is gone; an empty private directory is harmless.
	}
}
