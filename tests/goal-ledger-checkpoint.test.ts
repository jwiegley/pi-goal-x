import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  MAX_LEDGER_LINE_BYTES,
  LEDGER_CHECKPOINT_FILE,
  LEDGER_CHECKPOINT_VERSION,
  appendGoalEvents,
  goalLedgerCacheStats,
  goalLedgerPath,
  invalidateGoalLedgerCache,
  readGoalLedger,
  readGoalLedgerForGoal,
  type GoalLedgerContext,
  type GoalLedgerEvent,
} from "../extensions/goal-ledger.ts";

const mutableFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");

function tempCtx(t: test.TestContext): GoalLedgerContext {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-ledger-checkpoint-test-")));
  t.after(() => {
    invalidateGoalLedgerCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { cwd: dir };
}

function checkpointPath(ctx: GoalLedgerContext): string {
  return path.join(ctx.cwd, ".pi", "goals", LEDGER_CHECKPOINT_FILE);
}

function readCheckpoint(ctx: GoalLedgerContext): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(checkpointPath(ctx), "utf8")) as Record<string, unknown>;
}

function goalEvents(goalId: string, count: number, start = 0): GoalLedgerEvent[] {
  const events: GoalLedgerEvent[] = [];
  for (let i = start; i < start + count; i++) {
    events.push({ type: "task_complete", goalId, taskId: `t${i}`, evidence: `evidence ${i}`, at: `2026-09-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` });
  }
  return events;
}

/** Count ledger bytes read through descriptors opened on the ledger path. */
function probeLedgerReads<T>(ctx: GoalLedgerContext, body: () => T): { result: T; bytesRead: number } {
  const ledger = goalLedgerPath(ctx);
  const fds = new Set<number>();
  let bytesRead = 0;
  const { openSync, readSync, closeSync } = mutableFs;
  mutableFs.openSync = ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = openSync(file, flags, mode);
    if (String(file) === ledger) fds.add(fd);
    return fd;
  }) as typeof mutableFs.openSync;
  mutableFs.readSync = ((fd: number, ...rest: unknown[]) => {
    const count = (readSync as (...args: unknown[]) => number)(fd, ...rest);
    if (fds.has(fd)) bytesRead += count;
    return count;
  }) as typeof mutableFs.readSync;
  mutableFs.closeSync = ((fd: number) => {
    fds.delete(fd);
    return closeSync(fd);
  }) as typeof mutableFs.closeSync;
  syncBuiltinESMExports();
  try {
    return { result: body(), bytesRead };
  } finally {
    mutableFs.openSync = openSync;
    mutableFs.readSync = readSync;
    mutableFs.closeSync = closeSync;
    syncBuiltinESMExports();
  }
}

test("a goal read persists one single-goal checkpoint, and a cold read scans only bytes appended since", t => {
  const ctx = tempCtx(t);
  appendGoalEvents(ctx, [...goalEvents("g1", 2000), ...goalEvents("other", 2000)]);
  const first = readGoalLedgerForGoal(ctx, "g1");
  assert.equal(first.events.length, 64);
  assert.equal(first.truncated, true);
  assert.equal(first.validEvents, 4000);
  const checkpoint = readCheckpoint(ctx);
  assert.equal(checkpoint.version, LEDGER_CHECKPOINT_VERSION);
  assert.equal(checkpoint.format, "goal-ledger-goal-index");
  assert.equal(checkpoint.goalId, "g1");
  assert.ok((checkpoint.events as unknown[]).every((event) => (event as { goalId: string }).goalId === "g1"), "the checkpoint holds exactly one goal");

  const ledgerBytes = fs.statSync(goalLedgerPath(ctx)).size;
  appendGoalEvents(ctx, goalEvents("g1", 3, 2000));
  const appended = fs.statSync(goalLedgerPath(ctx)).size - ledgerBytes;
  invalidateGoalLedgerCache();
  const { result, bytesRead } = probeLedgerReads(ctx, () => readGoalLedgerForGoal(ctx, "g1"));
  assert.deepEqual(result.events.slice(-3).map((event) => (event as { taskId: string }).taskId), ["t2000", "t2001", "t2002"]);
  assert.equal(result.validEvents, 4003);
  assert.ok(bytesRead <= appended + 4 * 4096, `cold read scanned ${bytesRead} bytes for ${appended} appended bytes of ${ledgerBytes + appended}`);
});

test("a corrupt, foreign or outdated checkpoint is ignored and rebuilt from the ledger", t => {
  const ctx = tempCtx(t);
  appendGoalEvents(ctx, [
    { type: "completion_requested", goalId: "g1", at: "2026-09-01" },
    { type: "audit_result", goalId: "g1", verdict: "disapproved", report: "Not yet", at: "2026-09-02" },
    ...goalEvents("g1", 10),
  ]);
  const expected = readGoalLedgerForGoal(ctx, "g1");
  const valid = readCheckpoint(ctx);
  const damages: Array<(copy: Record<string, unknown>) => void> = [
    (copy) => { (copy.events as Array<{ evidence: string }>)[0]!.evidence = "tampered"; },
    (copy) => { copy.version = 4; },
    (copy) => { copy.goalId = "other"; },
    (copy) => { delete copy.projection; },
  ];
  for (const damage of damages) {
    const copy = structuredClone(valid);
    damage(copy);
    fs.writeFileSync(checkpointPath(ctx), JSON.stringify(copy));
    invalidateGoalLedgerCache();
    const rebuilt = readGoalLedgerForGoal(ctx, "g1");
    assert.deepEqual(rebuilt.events, expected.events);
    assert.deepEqual(rebuilt.latestAuditorResult, { verdict: "disapproved", report: "Not yet", at: "2026-09-02" });
    assert.equal(rebuilt.hasCompletionRequested, true);
    assert.deepEqual(readCheckpoint(ctx).digest, valid.digest, "the rebuild republishes a valid checkpoint");
  }
  fs.writeFileSync(checkpointPath(ctx), "not json");
  invalidateGoalLedgerCache();
  assert.deepEqual(readGoalLedgerForGoal(ctx, "g1").events, expected.events);
});

test("replacement, truncation, prefix edits and same-size rewrites force an authoritative rebuild", t => {
  const ctx = tempCtx(t);
  const ledger = () => goalLedgerPath(ctx);
  appendGoalEvents(ctx, goalEvents("g1", 50));
  readGoalLedgerForGoal(ctx, "g1");

  // Replaced by a different file (new inode) with different history.
  const replacement = `${ledger()}.replacement`;
  fs.writeFileSync(replacement, goalEvents("g1", 5, 100).map((event) => JSON.stringify(event)).join("\n") + "\n");
  fs.renameSync(replacement, ledger());
  assert.deepEqual(readGoalLedgerForGoal(ctx, "g1").events.map((event) => (event as { taskId: string }).taskId), ["t100", "t101", "t102", "t103", "t104"]);

  // Truncated in place.
  const lines = fs.readFileSync(ledger(), "utf8").split("\n");
  fs.writeFileSync(ledger(), lines.slice(0, 2).join("\n") + "\n");
  assert.equal(readGoalLedgerForGoal(ctx, "g1").validEvents, 2);

  // The head anchor changed and the ledger grew.
  fs.writeFileSync(ledger(), [JSON.stringify(goalEvents("g1", 1, 200)[0]), lines[1], lines[2]].join("\n") + "\n");
  assert.deepEqual(readGoalLedgerForGoal(ctx, "g1").events.map((event) => (event as { taskId: string }).taskId), ["t200", "t101", "t102"]);

  // Same size, new bytes: the changed timestamps reveal the rewrite.
  const before = fs.readFileSync(ledger(), "utf8");
  const rewritten = before.replace("t101", "t999");
  assert.equal(rewritten.length, before.length);
  const stat = fs.statSync(ledger());
  fs.writeFileSync(ledger(), rewritten);
  fs.utimesSync(ledger(), stat.atime, new Date(stat.mtimeMs + 5000));
  assert.ok(readGoalLedgerForGoal(ctx, "g1").events.some((event) => (event as { taskId: string }).taskId === "t999"));
});

test("goal facts stay exact beyond the retained window while memory and the checkpoint stay bounded", t => {
  const ctx = tempCtx(t);
  appendGoalEvents(ctx, [
    { type: "completion_requested", goalId: "g1", summary: "first request", at: "2026-09-01" },
    { type: "audit_started", goalId: "g1", auditId: "a1", at: "2026-09-01" },
    { type: "audit_result", goalId: "g1", auditId: "a1", verdict: "disapproved", report: "Missing tests", at: "2026-09-02" },
    { type: "goal_completed", goalId: "g1", archivePath: ".pi/goals/archived/goal_x_g1.md", at: "2026-09-03" },
  ]);
  for (let batch = 0; batch < 5; batch++) appendGoalEvents(ctx, goalEvents("g1", 1000, batch * 1000));
  // Many distinct goals must not grow memory or the checkpoint.
  const others: GoalLedgerEvent[] = [];
  for (let i = 0; i < 2000; i++) others.push({ type: "goal_created", goalId: `goal-${i}`, objective: "o", sisyphus: false, autoContinue: true, at: "2026-09-04" });
  appendGoalEvents(ctx, others);
  invalidateGoalLedgerCache();
  const goal = readGoalLedgerForGoal(ctx, "g1", { maxEvents: 4096 });
  assert.equal(goal.hasCompletionRequested, true);
  assert.deepEqual(goal.latestAuditorResult, { verdict: "disapproved", report: "Missing tests", at: "2026-09-02" });
  assert.equal(goal.completedAt, "2026-09-03");
  assert.equal(goal.completedArchivePath, ".pi/goals/archived/goal_x_g1.md");
  assert.equal(goal.truncated, true);
  assert.ok(goal.events.length <= 4096 + 4, "the window plus pinned audit/completion events");
  assert.ok(goal.events.some((event) => event.type === "completion_requested"), "the latest completion request is pinned");
  for (let i = 0; i < 40; i++) readGoalLedgerForGoal(ctx, `goal-${i}`);
  const stats = goalLedgerCacheStats();
  assert.ok(stats.entries <= 16, `cached ${stats.entries} goal indexes`);
  assert.ok(stats.bytes <= 8 * 1024 * 1024, `cached ${stats.bytes} bytes`);
  assert.ok(fs.statSync(checkpointPath(ctx)).size <= 10 * 1024 * 1024);
  assert.equal(readCheckpoint(ctx).goalId, "goal-39", "the single checkpoint follows the newest goal read");
});

test("oversized lines are malformed and never stop later events or appear in windows", t => {
  const ctx = tempCtx(t);
  appendGoalEvents(ctx, [{ type: "task_complete", goalId: "g1", taskId: "before", at: "2026-09-01" }]);
  fs.appendFileSync(goalLedgerPath(ctx), JSON.stringify({ type: "task_complete", goalId: "g1", taskId: "huge", evidence: "x".repeat(MAX_LEDGER_LINE_BYTES), at: "2026-09-01" }) + "\n");
  appendGoalEvents(ctx, [{ type: "task_complete", goalId: "g1", taskId: "after", at: "2026-09-02" }]);
  const whole = readGoalLedger(ctx);
  assert.equal(whole.malformed, 1);
  assert.deepEqual(whole.events.map((event) => (event as { taskId: string }).taskId), ["before", "after"]);
  const goal = readGoalLedgerForGoal(ctx, "g1");
  assert.equal(goal.malformed, 1);
  assert.deepEqual(goal.events.map((event) => (event as { taskId: string }).taskId), ["before", "after"]);
});

test("a final line without its newline is read once it parses and indexed exactly once when completed", t => {
  const ctx = tempCtx(t);
  appendGoalEvents(ctx, goalEvents("g1", 2));
  readGoalLedgerForGoal(ctx, "g1");
  const partial = JSON.stringify(goalEvents("g1", 1, 2)[0]);
  fs.appendFileSync(goalLedgerPath(ctx), partial);
  assert.equal(readGoalLedgerForGoal(ctx, "g1").events.length, 3, "a complete JSON object without its newline is visible");
  fs.appendFileSync(goalLedgerPath(ctx), "\n");
  invalidateGoalLedgerCache();
  const completed = readGoalLedgerForGoal(ctx, "g1");
  assert.deepEqual(completed.events.map((event) => (event as { taskId: string }).taskId), ["t0", "t1", "t2"]);
  assert.equal(completed.validEvents, 3);
});

test("incremental, checkpointed and rebuilt indexes agree with whole-history projections", async t => {
  const ctx = tempCtx(t);
  const { buildLedgerIndex } = await import("../extensions/goal-ledger-index.ts");
  const { oracleStateForFingerprint } = await import("../extensions/goal-oracle.ts");
  const { goalActivityEvents, goalOracleState, goalRuntimeEvents } = await import("../extensions/goal-ledger.ts");
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const goals = ["a", "b", "c"];
  const all: GoalLedgerEvent[] = [];
  const next = (i: number): GoalLedgerEvent => {
    const goalId = goals[Math.floor(random() * goals.length)]!;
    const at = `2026-09-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}T00:00:00.000Z`;
    const pick = Math.floor(random() * 9);
    if (pick === 0) return { type: "audit_started", goalId, auditId: `a${i}`, at };
    if (pick === 1) return { type: "audit_result", goalId, auditId: `a${i - 1}`, verdict: random() < 0.5 ? "approved" : "disapproved", report: `report ${i} ✓`, at };
    if (pick === 2) return { type: "completion_requested", goalId, at };
    if (pick === 3) return { type: "oracle_failed", goalId, fingerprint: random() < 0.5 ? "fp1" : "fp2", attempt: 1, errorCode: "provider", message: "offline", at };
    if (pick === 4) return { type: "goal_paused", goalId, reason: random() < 0.5 ? "wait" : "later", at };
    if (pick === 5) return { type: "goal_resumed", goalId, reason: "resume", at };
    return { type: "task_complete", goalId, taskId: `t${i % 7}`, evidence: "é".repeat(i % 5), at };
  };
  const expected = (goalId: string) => {
    const index = buildLedgerIndex(all).get(goalId)!;
    const same = (x?: GoalLedgerEvent, y?: GoalLedgerEvent) => JSON.stringify(x) === JSON.stringify(y);
    const prior = same(index.settledAudit, index.audit) ? undefined : index.settledAudit;
    const pinned = [prior, index.completion, index.auditStarted, index.audit];
    return {
      runtime: [...pinned.filter((event, k): event is GoalLedgerEvent => !!event && !index.recent.some(other => same(event, other)) && !pinned.slice(0, k).some(other => same(event, other))), ...index.recent],
      activity: index.activity,
    };
  };
  const check = (label: string) => {
    for (const goalId of goals) {
      const want = expected(goalId);
      assert.deepEqual(goalRuntimeEvents(ctx, goalId), want.runtime, `${label}: runtime events for ${goalId}`);
      assert.deepEqual(goalActivityEvents(ctx, goalId), want.activity, `${label}: activity for ${goalId}`);
      for (const fingerprint of ["fp1", "fp2"]) assert.deepEqual(goalOracleState(ctx, goalId, fingerprint), oracleStateForFingerprint(all, goalId, fingerprint));
    }
  };
  for (let round = 0; round < 6; round++) {
    const batch: GoalLedgerEvent[] = [];
    for (let i = 0; i < 400; i++) batch.push(next(all.length + i));
    appendGoalEvents(ctx, batch);
    all.push(...batch);
    check(`warm round ${round}`);
    if (round % 2 === 1) {
      invalidateGoalLedgerCache();
      check(`cold round ${round}`);
    }
  }
  fs.rmSync(checkpointPath(ctx));
  invalidateGoalLedgerCache();
  check("rebuilt");
});
