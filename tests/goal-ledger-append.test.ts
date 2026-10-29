import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { GoalService, type GoalServiceRef } from "../extensions/goal-service.ts";
import { createGoal, type GoalRecord } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import {
  MAX_LEDGER_LINE_BYTES,
  appendGoalEvent,
  appendGoalEvents,
  goalLedgerPath,
  readGoalLedger,
  type GoalLedgerContext,
  type GoalLedgerEvent,
} from "../extensions/goal-ledger.ts";

const ledgerModule = new URL("../extensions/goal-ledger.ts", import.meta.url).href;
const posix = process.platform !== "win32";

function tempCtx(t: test.TestContext): GoalLedgerContext {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goal-ledger-append-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { cwd: dir };
}

function lockPath(ctx: GoalLedgerContext): string {
  return path.join(ctx.cwd, ".pi/goals/.goal-events.lock.sqlite");
}

function event(goalId: string, taskId: string): GoalLedgerEvent {
  return { type: "task_complete", goalId, taskId, evidence: "e".repeat(64), at: "2026-10-29T00:00:00.000Z" };
}

test("appends from concurrent processes never interleave or get lost", async t => {
  const ctx = tempCtx(t);
  const writer = `
    const { appendGoalEvents } = await import(${JSON.stringify(ledgerModule)});
    const [cwd, name] = process.argv.slice(1);
    for (let i = 0; i < 150; i++) {
      const batch = [];
      for (let j = 0; j <= i % 3; j++) batch.push({ type: "task_complete", goalId: name, taskId: name + "-" + i + "-" + j, evidence: "x".repeat(200 + (i % 7) * 50), at: "2026-10-29" });
      const result = appendGoalEvents({ cwd }, batch);
      if (!result.ok) { console.error(String(result.error)); process.exit(3); }
    }
  `;
  const children = ["w1", "w2", "w3", "w4"].map((name) => new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", writer, ctx.cwd, name], { stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  }));
  assert.deepEqual(await Promise.all(children), [0, 0, 0, 0]);
  const perWriter = 50 * (1 + 2 + 3); // 150 batches of 1, 2 and 3 events in turn
  const ledger = readGoalLedger(ctx, { maxEvents: 4096 });
  assert.equal(ledger.malformed, 0, "no line was torn or interleaved");
  assert.equal(ledger.validEvents, 4 * perWriter);
  assert.equal(new Set(ledger.events.map((e) => (e as { taskId: string }).taskId)).size, 4 * perWriter, "every event was recorded exactly once");
});

test("a torn final line never swallows the next batch", t => {
  const ctx = tempCtx(t);
  assert.equal(appendGoalEvent(ctx, event("g1", "first")).ok, true);
  fs.appendFileSync(goalLedgerPath(ctx), '{"type":"task_complete","goalId":"g1","taskId":"to');
  assert.equal(appendGoalEvents(ctx, [event("g1", "second"), event("g1", "third")]).ok, true);
  const ledger = readGoalLedger(ctx);
  assert.equal(ledger.malformed, 1, "only the torn line is lost");
  assert.deepEqual(ledger.events.map((e) => (e as { taskId: string }).taskId), ["first", "second", "third"]);
});

test("events longer than the reader's line limit are refused before anything is written", t => {
  const ctx = tempCtx(t);
  const huge: GoalLedgerEvent = { type: "task_complete", goalId: "g1", taskId: "huge", evidence: "x".repeat(MAX_LEDGER_LINE_BYTES), at: "2026-10-29" };
  const result = appendGoalEvents(ctx, [event("g1", "small"), huge]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error instanceof RangeError);
  assert.equal(fs.existsSync(goalLedgerPath(ctx)), false, "a refused batch writes nothing");
});

test("a symlinked ledger, a symlinked lock or a foreign lock database is refused", t => {
  const ctx = tempCtx(t);
  const outside = tempCtx(t);
  fs.mkdirSync(path.join(ctx.cwd, ".pi/goals"), { recursive: true });
  const target = path.join(outside.cwd, "elsewhere.jsonl");
  fs.writeFileSync(target, "");
  fs.symlinkSync(target, goalLedgerPath(ctx));
  const linked = appendGoalEvent(ctx, event("g1", "x"));
  assert.equal(linked.ok, false);
  assert.equal(fs.readFileSync(target, "utf8"), "", "the symlink target is untouched");
  fs.unlinkSync(goalLedgerPath(ctx));

  const lockTarget = path.join(outside.cwd, "lock.sqlite");
  fs.writeFileSync(lockTarget, "");
  fs.rmSync(lockPath(ctx), { force: true }); // the refused append above created the real lock
  fs.symlinkSync(lockTarget, lockPath(ctx));
  const linkedLock = appendGoalEvent(ctx, event("g1", "x"));
  assert.equal(linkedLock.ok, false);
  if (!linkedLock.ok) assert.match(String(linkedLock.error), /not a regular file/);
  fs.unlinkSync(lockPath(ctx));

  const foreign = new DatabaseSync(lockPath(ctx));
  foreign.exec("CREATE TABLE unrelated (value TEXT)");
  foreign.close();
  const refused = appendGoalEvent(ctx, event("g1", "x"));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(String(refused.error), /unrecognized goal ledger lock database/);
  assert.equal(fs.existsSync(goalLedgerPath(ctx)), false, "nothing is appended without the lock");
});

test("the lock database is private and reused across appends", t => {
  const ctx = tempCtx(t);
  assert.equal(appendGoalEvent(ctx, event("g1", "a")).ok, true);
  assert.equal(appendGoalEvent(ctx, event("g1", "b")).ok, true);
  if (posix) assert.equal(fs.statSync(lockPath(ctx)).mode & 0o777, 0o600);
  const db = new DatabaseSync(lockPath(ctx));
  try {
    assert.equal((db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id, 0x5049474c);
  } finally {
    db.close();
  }
  assert.equal(readGoalLedger(ctx).validEvents, 2);
});

test("a failed batch is diagnosed once and never retried event by event", t => {
  const ctx = tempCtx(t);
  const goal = writeActiveGoalFile(ctx, createGoal({ objective: "Ledger batch", autoContinue: false, sisyphus: false }));
  const diagnostics: Array<{ eventType?: string; message: string }> = [];
  let focused: GoalRecord | null = goal;
  const pool = new Map([[goal.id, goal]]);
  const ref = {
    getFocused: () => focused,
    setFocused: (next: GoalRecord | null) => { focused = next; if (next) pool.set(next.id, next); },
    getPool: () => pool,
    replacePool: () => {},
    getFocusedGoalId: () => focused?.id ?? null,
    assignFocusedGoalId: () => {},
    focusToken: (goalId: string) => ({ goalId, revision: 0 }),
    isTokenCurrent: () => true,
    appendFocusEntry: () => {},
    onFocusedGoalLost: () => {},
    onReconciled: () => {},
    onFocusChanged: () => {},
    onDiagnostic: (diagnostic: { eventType?: string; message: string }) => { diagnostics.push(diagnostic); },
  } as unknown as GoalServiceRef;
  // A directory at the ledger path makes every append fail.
  fs.mkdirSync(goalLedgerPath(ctx), { recursive: true });
  const result = new GoalService(ref).apply(ctx, {
    reconcile: false,
    mutate: (g) => ({ ...g, objective: "Still written" }),
    ledger: (written) => [event(written.id, "one"), event(written.id, "two")],
  });
  assert.equal(result.ok, true, "the authoritative write stands");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.eventType, "batch");
  assert.match(diagnostics[0]!.message, /was not retried/);
});
