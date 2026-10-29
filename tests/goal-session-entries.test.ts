import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { DRAFT_ENTRY, rehydrateDraft } from "../extensions/goal-drafting.ts";
import { FOCUS_ENTRY, STATE_ENTRY } from "../extensions/goal-format.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { latestActiveCustomEntries, type GoalSessionEntry } from "../extensions/goal-session-entries.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

type Manager = ExtensionContext["sessionManager"];

function custom(customType: string, data: unknown): GoalSessionEntry {
	return { type: "custom", customType, data };
}

/** An indexed host: answers latest-entry queries and refuses to materialize the branch. */
function indexedManager(entries: GoalSessionEntry[], calls: Array<{ customType: string; options: unknown }>): Manager {
	return {
		getBranch: () => { throw new Error("the active branch must not be materialized"); },
		getLatestCustomEntry: (customType: string, options: unknown) => {
			calls.push({ customType, options });
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i]!;
				if (entry.type === "custom" && entry.customType === customType) return entry;
			}
			return undefined;
		},
		getSessionId: () => "indexed-session",
		getCwd: () => "/",
	} as unknown as Manager;
}

test("indexed hosts answer each latest-entry query without reading the branch", () => {
	const calls: Array<{ customType: string; options: unknown }> = [];
	const entries = [
		custom(FOCUS_ENTRY, { version: 1, focusedGoalId: "old", reason: "selected" }),
		custom(STATE_ENTRY, { goal: { objective: "legacy" } }),
		custom(FOCUS_ENTRY, { version: 1, focusedGoalId: "new", reason: "selected" }),
	];
	const latest = latestActiveCustomEntries(indexedManager(entries, calls), [FOCUS_ENTRY, STATE_ENTRY]);
	assert.deepEqual(calls, [
		{ customType: FOCUS_ENTRY, options: { scope: "active" } },
		{ customType: STATE_ENTRY, options: { scope: "active" } },
	]);
	assert.deepEqual(latest.get(FOCUS_ENTRY)?.data, { version: 1, focusedGoalId: "new", reason: "selected" });
	assert.deepEqual(latest.get(STATE_ENTRY)?.data, { goal: { objective: "legacy" } });
});

test("indexed hosts consider only the newest entry of each type", () => {
	const calls: Array<{ customType: string; options: unknown }> = [];
	const entries = [custom(FOCUS_ENTRY, { version: 1, focusedGoalId: "valid" }), custom(FOCUS_ENTRY, "malformed")];
	const latest = latestActiveCustomEntries(indexedManager(entries, calls), [FOCUS_ENTRY], (_type, entry) => typeof entry.data === "object");
	assert.equal(latest.has(FOCUS_ENTRY), false);
});

test("hosts without the query fall back to one early-stopping reverse branch scan", () => {
	let branchReads = 0;
	let visited = 0;
	const entries = [
		custom("unrelated", {}),
		custom(FOCUS_ENTRY, { version: 1, focusedGoalId: "older-valid" }),
		custom(STATE_ENTRY, { goal: { objective: "legacy" } }),
		custom(FOCUS_ENTRY, "malformed"),
		{ type: "message" },
	];
	const manager = {
		getBranch: () => {
			branchReads++;
			return entries.map((entry) => new Proxy(entry, { get: (target, key) => { if (key === "type") visited++; return Reflect.get(target, key); } }));
		},
	} as unknown as Manager;
	const latest = latestActiveCustomEntries(manager, [FOCUS_ENTRY, STATE_ENTRY], (customType, entry) =>
		customType !== FOCUS_ENTRY || typeof entry.data === "object");
	assert.equal(branchReads, 1);
	assert.deepEqual(latest.get(FOCUS_ENTRY)?.data, { version: 1, focusedGoalId: "older-valid" });
	assert.deepEqual(latest.get(STATE_ENTRY)?.data, { goal: { objective: "legacy" } });
	assert.equal(visited, 4, "the scan stops before older entries once every type has an accepted entry");
});

test("session start and draft rehydration use indexed queries instead of the branch", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-session-entries-"));
	try {
		mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
		writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ autoSelectSingleGoal: false, disabled: true }));
		const goal = writeActiveGoalFile({ cwd }, createGoal({ objective: "Focus restored from the latest entry", autoContinue: false, sisyphus: false }));
		const calls: Array<{ customType: string; options: unknown }> = [];
		const entries: GoalSessionEntry[] = [
			custom(FOCUS_ENTRY, goalFocusDetails(null, "unfocused")),
			custom(DRAFT_ENTRY, { version: 1, mode: "goal", seed: "draft", startedAt: "earlier", auditorEnabled: true }),
			custom(FOCUS_ENTRY, goalFocusDetails(goal.id, "selected")),
			custom(DRAFT_ENTRY, { version: 1, mode: "goal", seed: "draft", startedAt: "earlier", auditorEnabled: true, clearedAt: "later" }),
		];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const pi = {
			registerTool: () => {},
			registerCommand: () => {},
			registerShortcut: () => {},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(event, handler); },
			appendEntry: (customType: string, data: unknown) => { entries.push(custom(customType, data)); },
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
		};
		const ctx = {
			cwd,
			hasUI: false,
			sessionManager: indexedManager(entries, calls),
			ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, onTerminalInput: () => () => {} },
			getSystemPrompt: () => "",
			isIdle: () => true,
			hasPendingMessages: () => false,
		} as unknown as ExtensionContext;
		goalExtension(pi as never);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		const core = (pi as unknown as { _goalCore: { focusedGoalId: string | null } & Parameters<typeof rehydrateDraft>[0] })._goalCore;
		assert.equal(core.focusedGoalId, goal.id);
		assert.ok(calls.some((call) => call.customType === FOCUS_ENTRY));
		assert.ok(calls.some((call) => call.customType === STATE_ENTRY));
		assert.ok(calls.some((call) => call.customType === DRAFT_ENTRY), "session start rehydrates drafts through the query");
		assert.ok(calls.every((call) => JSON.stringify(call.options) === JSON.stringify({ scope: "active" })));

		calls.length = 0;
		rehydrateDraft(core, ctx);
		assert.deepEqual(calls, [{ customType: DRAFT_ENTRY, options: { scope: "active" } }]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
