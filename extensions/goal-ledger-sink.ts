import { appendGoalEvent, appendGoalEvents, type GoalLedgerEvent } from "./goal-ledger.ts";
import type { GoalDiagnostic, GoalServiceContext } from "./goal-service-types.ts";

/** Append one batch once; an ambiguous failure must never be retried per event. */
export function appendLedgerEventsBestEffort(ctx: GoalServiceContext, events: GoalLedgerEvent[], onDiagnostic: (diagnostic: GoalDiagnostic) => void): boolean {
	if (events.length === 0) return true;
	const append = events.length === 1 ? appendGoalEvent(ctx, events[0]!) : appendGoalEvents(ctx, events);
	if (append.ok) return true;
	const first = events[0]!;
	onDiagnostic({
		severity: "warning",
		source: "ledger",
		goalId: "goalId" in first ? first.goalId : undefined,
		eventType: events.length === 1 ? first.type : "batch",
		message: events.length === 1
			? `Ledger append failed for ${first.type}${"goalId" in first ? ` (goal ${first.goalId})` : ""}: ${String(append.error)}`
			: `Ledger batch append failed for ${events.length} events; the ambiguous batch was not retried: ${String(append.error)}`,
	});
	return false;
}

/** Recovery needs the exact append result before removing its pending marker. */
export function appendRecoveryLedgerEvents(ctx: GoalServiceContext, events: GoalLedgerEvent[]) {
	return appendGoalEvents(ctx, events);
}
