import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSettingsSnapshot } from "../goal-settings.ts";

export interface GoalStorageContext {
	cwd: string;
	/** Plain snapshot for deferred readers; never capture an ExtensionContext. */
	goalStorageRoot?: string;
	sessionManager?: { getSessionId(): string | undefined };
}

// Host contexts change between hooks; the session manager owns their lifetime.
const roots = new WeakMap<object, { id: string | undefined; cwd: string; root: string }>();

export function goalStorageRoot(ctx: GoalStorageContext): string {
	if (ctx.goalStorageRoot !== undefined) return ctx.goalStorageRoot;
	// Low-level cwd-only callers retain the original zero-settings-I/O contract.
	// Host sessions resolve configuration once; detached readers take a snapshot.
	return ctx.sessionManager ? configuredGoalRoot(ctx) : path.resolve(ctx.cwd, ".pi/goals");
}

function configuredGoalRoot(ctx: GoalStorageContext): string {
	if (ctx.goalStorageRoot !== undefined) return ctx.goalStorageRoot;
	const manager = ctx.sessionManager;
	const id = manager?.getSessionId();
	const key = manager ?? ctx;
	const pinned = roots.get(key);
	if (pinned && pinned.id === id && pinned.cwd === ctx.cwd) return pinned.root;
	const settings = loadSettingsSnapshot(ctx.cwd);
	const source = settings.provenance.get("goalsRoot")?.source;
	const invalid = settings.diagnostics.find(d => d.settingPath === "goalsRoot" && source !== "environment" && (d.scope === "project" || source !== "project"));
	if (invalid) throw new Error(`Invalid goalsRoot: ${invalid.message}`);
	const configured = settings.value.goalsRoot;
	let root = path.resolve(ctx.cwd, ".pi/goals");
	if (configured !== undefined) {
		const expanded = configured === "~" ? os.homedir() : configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : configured;
		if (!path.isAbsolute(expanded) || expanded.includes("\0")) throw new Error("goalsRoot / PI_GOAL_ROOT must be an absolute path or ~/path; reload after correcting it.");
		root = projectGoalRoot(ctx.cwd, path.normalize(expanded));
		// Metadata lives inside an override without perturbing the pool's mtime.
		ensureRealDirectories(root, [".metadata"]);
	}
	roots.set(key, { id, cwd: ctx.cwd, root });
	return root;
}

/**
 * Goal storage is confined to the project: every goal file, ledger, lock and
 * snapshot Goal X reads or writes stays below ctx.cwd, the directory whose
 * safety the user already vouches for by running Pi there. A configured root
 * outside the project (including the project directory itself) is refused
 * rather than followed; directories between the project and the root are
 * created one at a time and must be real directories, never symlinks.
 */
function projectGoalRoot(cwd: string, configured: string): string {
	const project = path.resolve(cwd);
	const relative = path.relative(project, configured);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`goalsRoot / PI_GOAL_ROOT must name a directory inside the project (${project}), but ${configured} is ${relative ? "outside it" : "the project directory itself"}. Goal X keeps goal storage within the project directory; choose a subdirectory such as ${path.join(project, ".pi", "goals")} and reload.`);
	}
	ensureRealDirectories(project, relative.split(path.sep));
	return path.join(project, relative);
}

/** Create each component below `base` without following a symlinked or non-directory component. */
function ensureRealDirectories(base: string, components: readonly string[]): void {
	let dir = base;
	for (const part of components.filter(Boolean)) {
		dir = path.join(dir, part);
		try { fs.mkdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		const stat = fs.lstatSync(dir);
		if (stat.isSymbolicLink()) throw new Error(`Goal root is a symlink: ${dir}`);
		if (!stat.isDirectory()) throw new Error(`Goal root is not a directory: ${dir}`);
	}
}

export function goalStorageContext(ctx: GoalStorageContext): GoalStorageContext {
	return { cwd: ctx.cwd, goalStorageRoot: configuredGoalRoot(ctx) };
}

/** Logical paths stay compatible in saved goal files, independent of pool location. */
export function goalStoragePath(ctx: GoalStorageContext, logical: string): string {
	const relative = logical.replace(/\\/g, "/");
	if (relative !== ".pi/goals" && !relative.startsWith(".pi/goals/")) throw new Error(`Invalid goal storage path: ${logical}`);
	const root = goalStorageRoot(ctx);
	const result = path.resolve(root, relative.slice(".pi/goals".length + 1));
	const inside = path.relative(root, result);
	if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error(`Goal path escapes root: ${logical}`);
	return result;
}

export function isExternalGoalStorage(ctx: GoalStorageContext): boolean {
	return goalStorageRoot(ctx) !== path.resolve(ctx.cwd, ".pi/goals");
}

export function goalPoolSnapshotPath(ctx: GoalStorageContext): string {
	const root = goalStorageRoot(ctx);
	return root === path.resolve(ctx.cwd, ".pi/goals")
		? path.join(path.dirname(root), ".goals-pool-snapshot.json")
		: path.join(root, ".metadata", ".goals-pool-snapshot.json");
}

/** Validate managed ancestors on writes, without adding I/O to steady-state reads. */
export function ensureGoalStorageDirectory(ctx: GoalStorageContext, logical: string, verifyDefault = true): void {
	const root = goalStorageRoot(ctx);
	const target = goalStoragePath(ctx, logical);
	if (root === path.resolve(ctx.cwd, ".pi/goals")) {
		fs.mkdirSync(target, { recursive: true });
		if (verifyDefault && fs.lstatSync(target).isSymbolicLink()) throw new Error(`Goal directory is a symlink: ${target}`);
		return;
	}
	// An external pool removed during a session must not silently reappear.
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Goal root is a symlink: ${root}`);
	let dir = root;
	for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
		dir = path.join(dir, part);
		try { fs.mkdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Goal directory is a symlink: ${dir}`);
	}
}
