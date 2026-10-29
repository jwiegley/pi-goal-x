import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Restoring a session reads the log in goal-focus.ts.
const source = ["goal-state.ts", "goal-focus.ts"]
	.map((name) => readFileSync(new URL(`../extensions/${name}`, import.meta.url), "utf8"))
	.join("\n");

test("goal updates do not append full state snapshots to the session", () => {
	assert.doesNotMatch(source, /appendEntry\(STATE_ENTRY/);
	// Legacy state entries are still read (for focus migration), never written.
	assert.match(source, /latestActiveCustomEntries\(ctx\.sessionManager, \[FOCUS_ENTRY, STATE_ENTRY\]/);
});
