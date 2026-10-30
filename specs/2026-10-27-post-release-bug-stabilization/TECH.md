# Technical plan

Implementation status: completed and published as [0.34.1](https://github.com/tmonk/pi-goal-x/releases/tag/v0.34.1). [PR #118](https://github.com/tmonk/pi-goal-x/pull/118) merged as `27d9facf49e66ee677770a74e26198a8bdcada8a`, preserving all five co-authored fix commits. [Main CI](https://github.com/tmonk/pi-goal-x/actions/runs/40541211633) passed the Linux Node 22.19/Pi 1.4 checks, and the [release workflow](https://github.com/tmonk/pi-goal-x/actions/runs/40541749002) published its tested tarball with provenance. The registry download matches the workflow tarball and GitHub asset and passed its installed-package regressions. The following sections retain the acceptance contract; exact release evidence is recorded in `MILESTONES.md`.

## 1. Evidence baseline

### 1.1 Repository and release state

This plan covers every open issue and pull request rechecked on 2026-10-27. At intake, GitHub main and the local checkout were `fe0e38f8cd03bfacc9baca730e9a902d3cff116e`, package 0.34.0, with `@earendil-works/pi-coding-agent` 1.4.0 installed. The signed [v0.34.0 tag](https://github.com/tmonk/pi-goal-x/releases/tag/v0.34.0) resolves to `8f0c28b08a152efef9da2728e7f8e96b02455506`; only ranking/spec/validation records changed between that commit and main. Pin both identities in the comparison artifacts rather than calling main the release tag.

The earlier planning run recorded the following passes on the unmodified baseline (see `MILESTONES.md`; these are historical results, not runs repeated by this plan revision):

- TypeScript and ESLint.
- 1,216 tests across 91 files, with zero failures or skips.
- All ten installed Pi 1.4 controls walkthrough cases.
- A live three-request draft, execution, independent-audit and archival lifecycle.
- The context gate, provider cross-check and retention measurement when those context commands run sequentially or in otherwise isolated workspaces.

The earlier run also recorded each bug PR type-checking and passing focused tests in temporary worktrees: #109 had 10 checks, #111 had 56, #116 had 89 and #117 had 99. Those results are preliminary evidence, not acceptance of the current heads. Fresh GitHub reads show zero check runs and zero commit statuses on all six heads below. CI is configured in `.github/workflows/ci.yml`; missing runs are not proof that checks are unconfigured, passing or waived. Diagnose the missing runs during intake and validate the actual candidate.

Running `context:gate` and `context:provider-check` concurrently initially produced a stale-checkpoint mismatch and a five-tools-versus-two-tools mismatch. Both passed immediately when rerun sequentially. The commands share and recursively delete `/tmp/goal-context-capture`, so one process can replace another's fixture. The harness must be isolated before its output is allowed to approve any product change.

### 1.2 Existing cache foundation

The current implementation already has two deliberate cache layers that the fixes must preserve:

- `goal-live-retention.ts` retains exact request-only goal-state tails by session, anchor and base-history fingerprint. Identical retries add no blocks. History rewrites, policy-bearing state changes, unsafe tool-result insertion, empty-to-nonempty history changes and bounded rollover reset retention.
- `goal-prompt-cache.ts` relocates an existing explicit provider cache marker from the transient live tail to real history. It does not enable caching, alter the requested retention tier, add markers or split a tool-call/result pair.

Existing tests cover literal-prefix reuse, retry stability, bounded block/byte growth, per-session separation, delayed tool results, compaction/history rewrites, marker placement for Anthropic and Bedrock, and real SDK serialization for Anthropic Messages, OpenAI Completions and OpenAI Responses shapes. At intake, the provider worker exercised eight cache-retention/serialization cases, while the context fixtures protect the stable system prefix across deltas, model changes and compaction.

These tests are a strong semantic base but do not yet produce one release artifact that compares 0.34.0 with the integrated branch and explains every prefix break. The first milestone adds that comparative gate before runtime fixes.

### 1.3 Issue #108 evidence

Issue #108 shows a genuine cache/correctness tension:

- the present reset on instruction-bearing goal-state changes prevents stale instructions from remaining in the retained prefix;
- deterministic experiments found repeatable prefix breaks in state-changing sequences;
- live provider trials reported variable cache-read ratios, and an experimental append-only policy/facts design improved those ratios;
- that experiment has not yet proved that cleared, cancelled or replaced instructions can never remain authoritative.

Therefore cache preservation is release-blocking, but the experimental design is not pre-approved. The mandatory outcome for 0.34.1 is no avoidable regression from 0.34.0. A retention optimization may join the patch only if the stricter semantic and cache gates in Milestone G pass; otherwise it remains an isolated follow-up and the bug fixes ship with the current safe invalidation policy.

### 1.4 Fresh inventory and evidence provenance

The repository issues API returned 11 open entries: five issues and six PRs. The separate open-PR collection returned the same six PRs. Both collections were below the 100-entry page limit. Read every body, every changed-file patch (including tests and feature proposals), all review submissions and inline comments, and each head's check runs and commit statuses. Issue/discussion comment counts are zero; inline comments are empty. #112 has one bot review explaining it could not review because of quota, which is not a code review.

| PR | Reviewed head (immutable commit link) | Changed files | Current decision |
| --- | --- | --- | --- |
| [#109](https://github.com/tmonk/pi-goal-x/pull/109) | [bfadada443f0](https://github.com/tmonk/pi-goal-x/commit/bfadada443f0a55f2a9b4ff375e3589f81343fc1) | 10 | Rewrite lifecycle implementation; inspect tests individually. |
| [#111](https://github.com/tmonk/pi-goal-x/pull/111) | [c0e004ec7a39](https://github.com/tmonk/pi-goal-x/commit/c0e004ec7a3946bd1398a28e78873b31d26c3cd8) | 3 | Small formula is a candidate; acceptance still requires full behavior coverage. |
| [#116](https://github.com/tmonk/pi-goal-x/pull/116) | [1553106860b9](https://github.com/tmonk/pi-goal-x/commit/1553106860b95488292b32c66f01bf67e0a5c7ab) | 5 | Rewrite the ownership boundary. |
| [#117](https://github.com/tmonk/pi-goal-x/pull/117) | [db82532d50fb](https://github.com/tmonk/pi-goal-x/commit/db82532d50fb8eecc29adbbc57e978f808798d99) | 6 | Reimplement or retain only independently sound planner parts. |
| [#96](https://github.com/tmonk/pi-goal-x/pull/96) | [0102f8e2bbc0](https://github.com/tmonk/pi-goal-x/commit/0102f8e2bbc0959bc1f2d27d55147419d6d42779) | 9 | Defer feature; GitHub reports merge conflicts. |
| [#112](https://github.com/tmonk/pi-goal-x/pull/112) | [1343fbaf6a60](https://github.com/tmonk/pi-goal-x/commit/1343fbaf6a600c294b23cf72b852a2885bd0bf96) | 8 | Include at the user's request, with default `false`; adapt only reviewed hunks and fill the diagnostics, persistence and cache-test gaps. |

Open issues: [#108](https://github.com/tmonk/pi-goal-x/issues/108), [#110](https://github.com/tmonk/pi-goal-x/issues/110), [#113](https://github.com/tmonk/pi-goal-x/issues/113), [#114](https://github.com/tmonk/pi-goal-x/issues/114), [#115](https://github.com/tmonk/pi-goal-x/issues/115). Refresh this inventory before implementation intake and before release; changed heads invalidate their earlier review, and new bugs must receive an explicit disposition.

Fresh, no-network probes on `fe0e38f` independently confirmed:

- `[complete, skipped]` returns `pending: 1` while `collectPending` returns zero nodes, and `blockCompletion` emits a false warning (#110).
- Pi 1.4's real `validateToolArguments` accepts the exact #115 object, but the registered executor rejects it without `isError: true`; an instrumented flush hook runs once before rejection. This confirms the validation/execution boundary, not a live model's behavior.
- Retention preserves an unchanged-policy append-only prefix and breaks that prefix when the state changes (#108). The contributor's 4/10 break count and live percentages are reported evidence, not independently reproduced measurements in this revision.

After the user's context-display request, reread #112 and all eight patches; its head is unchanged. The proposal defaults to `true`, while the latest user instruction requires `false`. A separate no-network probe confirmed that the current parser reports the setting as unknown and the prompt helper ignores `false`. Feeding the existing retention layer a fixture with only the context line omitted preserves the prior message prefix, appends one counter snapshot and adds nothing on retry. The earlier context line remains historical; a fresh hidden fixture has none. This tests the proposed representation against current retention, not an implemented setting or real provider cache hits.

### 1.5 Recent-release regression boundaries

[0.33.0](https://github.com/tmonk/pi-goal-x/releases/tag/v0.33.0) introduced configurable controls/pause order, current Pi request preparation, stale-audit-message protection and opt-in idle pacing. 0.34.0 narrowed support to Pi 1.4, changed context handling to `context_with_system`, fixed stale-run isolation, normalized task arguments and hardened Windows writes. Treat these as compatibility contracts to preserve, not proof that a newly reported bug was introduced in those releases. Use a release-to-release reproducer if an introduction date matters.

Existing suite families to extend are `goal-session-safety`, `goal-stale-continuation-golden`, `goal-deferred-archival`, `goal-turn-transaction`, `goal-mutation-boundary`, `goal-controls`, `goal-widget`, `goal-tool-inputs`, `goal-tasks`, `goal-live-retention`, `goal-prompt-cache`, their real-SDK workers, and the installed controls/lifecycle walkthroughs. Section 6 maps the cross-feature scenarios; preserve existing recovery, accounting and storage guarantees while adding missing boundaries.

## 2. Complete open-item disposition

| Item | Finding | Planned disposition |
| --- | --- | --- |
| Issue #108 | Cache reuse can improve, but the proposed policy/facts split is not yet safe enough to adopt. | Bring measurement and cache non-regression into this campaign. Prototype narrower fact-only invalidation only after the bug fixes, and ship it only if both semantic safety and deterministic reuse improve. |
| Issue #110 / PR #111 | The one-line pending-count correction is directionally sound. Coverage stops before the registered completion, auditor and prompt paths. | Independently reproduce, retain or rewrite the formula after review, and add end-to-end plus invariant coverage. |
| Issue #113 | `session_start` and `session_shutdown` mix stale host context with local cleanup; an early stale getter skips later cleanup. | Introduce plain session/storage snapshots, exact cache-retention ownership and an all-steps, idempotent teardown. Cover equivalent `session_tree` replacement behavior. |
| PR #109 | It contributes useful audit interruption scenarios, but does not reliably abort the controller/timers, can settle twice, can target a replacement goal, adds a stale-context shutdown write, and lets an older result hide a newer start. | Reimplement within the #113 lifecycle model. Retain independently sound tests or small hunks only after hunk-level review; do not merge the PR head unchanged. |
| Issue #114 / PR #116 | Pi listener ordering explains the bug. The patch protects only three actions and treats every visible overlay as focus-capturing. | Put an ownership guard around every Goal shortcut and validate native, custom capturing and non-capturing Pi focus surfaces. Reimplement if the narrower patch cannot meet that boundary. |
| Issue #115 / PR #117 | A pure normalization/planning boundary is the right architecture. The proposal still reports conflicts as ordinary success, misses real provider validation for `update_goal` and needs stronger no-side-effect guarantees. | Adapt or rewrite the planner before transaction flush, return `isError: true` for structural conflicts, and test the registered tool plus real SDK/provider path. |
| PR #96 | New `/goal-resume` behavior; behind and conflicting with main. | Defer as feature work. Do not mix any hunk into stabilization. |
| PR #112 | Small display-setting proposal, now explicitly in scope. Its default is `true`; effective-settings reporting and full persistence/cache behavior are not covered. | Default to `false`, reuse existing boolean settings and fresh-counter rendering, complete diagnostics and independent tests, and exclude the README hunk. Do not merge the proposed head unchanged. |
| Context harness collision | Shared temporary state can generate false cache/schema failures. | Fix first and prove concurrent isolation. |

The current bug PRs overlap directly only in `CHANGELOG.md`, but their runtime effects meet at the same lifecycle, prompt and provider boundaries. Implementation remains isolated by behavior; the changelog is consolidated only after the integrated behavior is final.

## 3. Release-wide invariants

These conditions apply to every implementation milestone, even when a particular PR does not mention caching.

### 3.1 Cache identity and ownership

- Treat a retained entry as a lease owned by an exact session/model identity and an extension-session generation, not merely a string that any late callback may clear.
- A teardown may release only leases recorded in its immutable outgoing-session snapshot and only when the retention layer still recognizes that generation as owner.
- A replacement session can reuse the same external session identifier. Once it has acquired a newer generation, delayed cleanup from the old generation must be a no-op.
- If ownership cannot be proved, do not call a broad `clear()`. Let the existing bounded session/tail eviction limits reclaim the entry.
- Preserve the current bounded safeguards: tracked sessions, retained tails and counter bytes must remain capped. Any changed limit needs its own memory and cache-reuse evidence.
- Ownership generations are internal lifecycle metadata. They must not become rotating provider cache keys or new prompt text, and repeated no-op lifecycle notifications must not manufacture new invalidations.
- Verify `context_with_system` → `before_provider_request` pairing: interleaved sessions must relocate markers using the transient blocks belonging to that request. Include same-ID replacement and different provider/model identities; do not assume a later lookup of the current session state is the original request's snapshot.
- Distinguish provider retention from local settings/pool/ledger/task/prompt memoization. Preserve the current disk freshness checks and bounds; a required local-cache refresh must not implicitly clear an unrelated provider prefix. Measure read/hash/rebuild work so a cache fix does not introduce repeated full-ledger scans.

### 3.2 Immutable and reusable provider prefixes

- Compare host system/developer text, tool order, descriptions and schemas byte for byte with 0.34.0 at the same fixture step. Intentional Pi prompt/tool deltas must still follow the 0.34.0 host behavior; this is not a rule forbidding the host from changing its tools.
- For implicit-prefix providers, compare the ordered model-visible `messages` or `input` blocks after real SDK conversion, along with separately checked system/instructions and tools. Preserve the preceding blocks exactly under unchanged-policy append-only transitions unless a documented safety reset applies. A full JSON document is not literally a prefix of its successor because of closing delimiters and other envelope fields; testing that would produce false failures.
- Identical retries must preserve the complete prompt representation and cache-affecting provider options and add no retained block. Capture raw envelopes too; exclude only explicitly documented transport-only nondeterminism from the comparison, never text, image/tool payloads, schemas or cache identity.
- For explicit-cache providers, compare marker count, cacheable boundary, content order and tier/TTL with the matching baseline transition. Breakpoints can advance as history grows. Preserve the host's existing behavior when the target already has a marker or no safe history exists, and preserve `cacheRetention: none`. Never put an extension breakpoint on transient/thinking content or damage tool-call/result structure.
- A bug fix may change only the smallest scenario-specific live state or newly appended tool result needed for its behavior. Unaffected fixtures must remain byte-identical.
- The requested default-off context display is an approved delta: remove only the context line in fresh counter blocks. Capture baseline defaults, candidate defaults and candidate explicit `true`; the last must match 0.34.0 counter text. Report the first changed block and lost matching bytes honestly, without stripping the line during comparison. Fewer counter bytes must not be confused with lost reuse of real history. A live toggle preserves older retained blocks and appends the new counter; no display-driven reset, changed stable prefix or new cache identity is allowed. Cold/reloaded cross-version requests cannot promise byte identity beyond a changed counter.

Bytes and block counts measure deterministic cache eligibility, not actual provider cached tokens. A fixed token estimate is an estimate. Real cache-read usage is a separate measurement; neither a semantic state parser nor a payload comparison proves how a live model interprets stale instructions.

### 3.3 Valid invalidations

Record one primary cause for a reset and any other conditions that also applied. Do not count several internal `reset()` calls on the same transition as several lost prefixes. Conversely, a reset that loses no bytes must still be visible as a retention event. The current code has more reset paths than just policy, history and capacity:

| Cause | Current trigger / expected contract |
| --- | --- |
| `history-rewrite` | Shortened/edited/filtered history, changed middle message, compaction or failed fingerprint serialization; protect full history, including image/tool content. |
| `identity-change` | Different provider/model/session or a genuinely replaced history; distinguish a cold new identity from a warm entry incorrectly evicted by another owner. Missing session identity uses the conservative existing `unidentified` behavior. |
| `policy-change` | Changed state block containing objective, contracts, active task instructions, scheduler rules or limits; removing prior instructions by omission also requires removal of their old tails. |
| `observation-removed` | Previously present counters become absent; old values must not survive as current. |
| `live-state-removed` | Goal context disappears on clear/completion/unfocus/disable according to the current prompt path; remove obsolete goal instructions. |
| `empty-history-reanchor` | Tails first anchored before any real history are reanchored once actual history exists. |
| `unsafe-tool-anchor` | A new/delayed tool result would place retained context inside a tool-result batch. Pairing correctness takes precedence over reuse. |
| `tail-capacity` / `counter-byte-capacity` | Existing 32-tail / 4,096-counter-byte limits; an identical request at capacity must not reset. |
| `session-eviction` / `owner-release` | Existing 16-session bound or release of a proven outgoing owner; no cross-generation eviction. |

For each fixture step, specify expected cause, maximum event count and longest reusable prefix independently of the implementation. Unclassified or unexpectedly frequent invalidation fails even if runtime labels it with an allowed cause. Task/status facts are not automatically safe merely because they look informational: they affect completion, scheduling and model decisions. An optimization must establish supersession and deletion semantics before avoiding the existing reset.

### 3.4 Code quality

- No PR is a merge queue entry. It is a source of reproduction details, design ideas and possible hunks.
- Runtime code must be minimal, typed, locally comprehensible, idempotent where callbacks can race, compatible with current architecture, and free of unrelated cleanup or feature work.
- Avoid timing sleeps, broad catches, hidden process-global state, silent schema changes and speculative dependencies.
- A contribution that needs safety patches around it is rewritten from the behavioral contract unless the retained subset can be reviewed independently.
- Reuse one authoritative path: one teardown/audit settlement boundary, one tool-input planner, the existing task walker, one early focus guard, and the existing settings/counter path. Remove the scattered checks, obsolete flags/helpers and duplicate implementations each replacement makes unnecessary in the same commit.
- Every new runtime branch, state field or abstraction needs a concrete invariant and test. Prefer a local function or typed record over a new framework, registry, dependency or compatibility mode. The lifecycle fix may need captured ownership state; it does not justify a general session framework. The context display needs no new cache, listener, timer, scheduling rule or environment variable.
- Cleanup stays within the touched behavior. Do not broaden the release into a settings rewrite, prompt redesign or repository-wide refactor. Remove temporary experiment paths before release; ship either the accepted cache implementation or the original safe path, with no parallel fallback mode added for this campaign.
- Record the maintenance result alongside the hunk review: what was consolidated/deleted, why any new mechanism remains necessary, and which old code/tests were superseded. Require simpler production control flow and focused behavior tests; do not enforce a net-negative line count or delete useful tests to meet a size target.

## 4. Implementation sequence

| Priority | Work | Exit evidence |
| --- | --- | --- |
| First prerequisite | A: reliable fixtures and cache comparison | Forced-overlap harness test, frozen release baseline and comparator negative controls. Independent bug reproducers may be written while this is prepared. |
| Highest bug priority | B: session/audit ownership; C: unusable `update_goal` | No cross-session mutation, full cleanup, truthful audit state, and exact provider-filled calls working through Pi. |
| Same patch | D: skipped-task completion; E: foreign focus | Registered completion and real TUI ownership regressions fixed without weakening existing behavior. |
| Requested narrow correction | F: default-off context display | Existing settings/UI path, persistence and reporting, unchanged accounting, and no display-driven cache invalidation. |
| Required investigation; conditional code | G: unnecessary cache loss | Quantified causes and keep/drop decision; ship an optimization only with safety, bounded-growth and reuse evidence. |
| Final gate | H: integrated scenarios and installed package | One reviewed candidate with passing required checks, simplified touched paths and traceable package/commit evidence. |

### Milestone A — isolate validation and freeze the cache baseline

#### A1. Remove shared context-capture state

1. Replace the module-global capture directory in `experiments/context/capture-context.mjs` with an invocation-owned `mkdtemp` workspace, or require a unique workspace supplied by the caller.
2. Thread that path through state materialization, host-tool construction, capture, real SDK construction and cleanup. A workspace per process is insufficient if two `captureOne` calls overlap in one process; make each capture own its fixture. Avoid changing process-global environment variables while other captures run.
3. Track whether the invocation created the directory. Never recursively remove a path it did not create, and validate any cleanup target before deletion.
4. Add a deterministic concurrency regression that starts the context gate and provider cross-check together. Use barriers around fixture creation/read/cleanup to force overlap, including opposite completion order and one failing capture. Assert both successful runs match their sequential outputs, distinct sentinel goals/settings never cross, failed-run cleanup leaves its sibling intact, and same-process concurrent captures work too. Scheduler luck is not evidence of isolation.
5. Keep ordinary CI output sequential for diagnosis. Isolation is a correctness invariant, not a requirement to interleave release logs.

#### A2. Add a deterministic cache-comparison report

Build one common report format from synthetic fixtures serialized by the real provider adapters. Extend the existing context fixtures, provider workers and test utilities; extract a small report/comparator module only where needed for reuse. Do not create a parallel capture framework or duplicate scenario/serialization code. The fixtures must exercise registered extension handlers and actual tool definitions; a unit test of `LiveTailRetention` alone misses composition/order defects. The report and commands are planned, not yet implemented. For every transition record:

- source/tag SHA, SDK/Node versions, lockfile hash, fixture version, provider/model/options and fixture step;
- hashes of raw system/developer content and ordered tool names/descriptions/schemas; a normalized schema digest may aid diagnosis but never replace the raw-order assertion;
- ordered serialized prompt blocks needed to calculate the exact longest common prefix, including the first divergent field/block and bytes before it;
- reusable message/block count, byte count and deterministic token estimate;
- whether a retry is byte-identical;
- retained-tail block count and bytes, total request bytes and cumulative added-tail bytes across the entire workflow;
- explicit marker positions, count and requested retention tier/TTL;
- every retention reset, prefix break and its classified reason, plus expected-versus-actual counts. Keep cold starts separate from regressions in warm reuse.

The report must cover at least:

- unchanged retry and append-only conversation;
- context visibility with omitted/default settings, explicit `false`/`true`, both toggle directions, settings reload and changing occupancy while hidden; classify only the approved fresh-counter difference from 0.34.0;
- goal start, objective/verification change, task progress, task clear/removal, pause, resume, scheduler wait/cancel, completion audit start/result and archival;
- tool call/result adjacency, delayed results and large text/image outputs;
- session/model separation, same-session-identifier generation replacement, compaction/history rewrite and bounded eviction;
- implicit caching and each explicit-marker SDK shape already supported by the worker.

Record provider coverage explicitly: OpenAI Responses (`input`) and Completions (`messages`) use implicit-prefix checks; Anthropic Messages and Anthropic-compatible Completions use `cache_control` checks; Bedrock uses separate `cachePoint` blocks. Preserve all three retention modes (`none`, `short`, `long`) where supported. Existing Bedrock shape tests are not evidence of a real Bedrock adapter run: any changed marker-handling branch needs a real SDK capture as well as its shape tests. No provider payload capture may silently dispatch a paid request. Account for SDK coalescing of adjacent same-role content at block boundaries without hiding edits to earlier content or changing role/tool order.

Pin fixture clock, IDs, settings, extension ordering and provider options. Capture physical workspace paths separately and map only the known fixture root/SDK root to the same logical paths in both reports; do not sort tool/schema fields, strip changing prompt lines or normalize differences away. Retain a raw payload sample so this mapping can be audited. Set a stable session cache identity for retries within each trial and separate identities between trials.

Generate a locked 0.34.0 report from `fe0e38f` (runtime-equivalent to release tag `8f0c28b`) using the same fixture driver, serializer dependencies and comparison code as the candidate. Changes to the fixture driver must run against both trees and be reviewed separately from production changes. Do not require new production APIs to run baseline cases; adapters may bridge test entry points without changing baseline semantics. The candidate gate fails when:

- an immutable-prefix hash changes;
- an unaffected transition loses reusable blocks/bytes;
- an identical retry changes or grows;
- a new or unclassified break appears;
- marker behavior, TTL/tier or tool-pair adjacency differs outside the fixture's approved boundary;
- the candidate grows beyond the existing memory bounds.

Do not bless a changed snapshot merely to make CI green. A baseline update requires a spec entry naming the behavior, the smallest expected payload delta and why changing previously cacheable content is necessary for correctness or an explicit product requirement. Milestone F authorizes only removal of the fresh context line; it authorizes no policy/history rewrite or extra retention reset. Per-track zero-delta expectations compare that track with its parent as well as the release baseline; the integrated report carries forward F's exact approved delta without treating unrelated differences as acceptable.

Test the comparator itself with deliberately bad captures: early prompt edit, tool reorder/schema edit, duplicate retry tail, over-limit retention, wrong-session release, missing scenario, unknown reset reason and a marker on a transient block. Every one must fail for the expected reason. A legitimate appended block, known compaction boundary and approved live-state correction must pass. Use at least 1,000 transitions for the bounded-growth corpus, with text, large tool outputs and image data already represented by the retention measurement.

#### A3. Wire the gate into the workflow

- Add `context:cache-report` and `context:cache-gate` commands for report generation and pinned-baseline comparison. Run the gate after each bug-track commit and on the combined head; a missing report/scenario is failure, never an empty success.
- Keep the existing retention, context gate and provider cross-check; the comparative report supplements rather than replaces them.
- Store synthetic deterministic artifacts in CI. Keep live-provider cache metrics separate so volatile provider routing does not rewrite the release baseline.
- Include the new gate and comparator self-tests in the existing `validate` job, fail on process errors/missing SDK or CLI/skip counts, and retain successful comparison artifacts as well as failure details. Exercise CI path selection when scripts, fixtures, SDK dependencies or cache code change. Benchmark the gate and retention overhead within the existing job's time budget.

Milestone A must be green before any runtime hunk is accepted.

### Milestone B — unify session teardown and audit settlement (#113 + #109)

#### B1. Separate live host context from durable identity

- Export one `isStaleExtensionContextError(error)` predicate from `goal-session-safety.ts` and reuse it in audit-message cleanup. Match only Pi's known stale-context signature; arbitrary exceptions remain failures.
- While the context is valid, capture an immutable session snapshot containing session identifier, `cwd`, resolved `goalStorageRoot`, goal identity when applicable, and cache-retention leases/generation owned by that session.
- Never retain `ExtensionContext` as a delayed storage handle. Deferred persistence uses the plain storage snapshot.
- On `session_start` or `session_tree` replacement, invalidate the outgoing generation before the first await, detach its owned resources and tear it down before publishing incoming state. `loadState` currently awaits disk reads before bumping the focus revision; stage loaded data and check generation before committing it, so a slower old load cannot overwrite a newer session.
- Give buffered turns an explicit original storage/goal/generation owner. `GoalService.flushTurn(ctx)` currently uses the caller's context, and `appendEvents` joins whichever turn buffer is active. Passing an old plain storage snapshot to `appendEvents` alone therefore does not isolate an audit. Add a narrow owner-bound settlement/flush route inside `GoalService`, preserving the single mutation boundary, revision checks and diagnostics. Outgoing work cannot join or flush an incoming turn, even when the goal IDs match across different roots.
- Separate context-free local cleanup, snapshot-backed storage work and live-context UI work. Local cleanup always runs; storage does not depend on a live UI context; UI calls run only while usable.
- Run all teardown steps even if one fails. Ignore only a recognized stale-context error, retain the first unexpected error, finish releasing later resources, then report/rethrow that error.

#### B2. Make teardown complete, idempotent and cache-safe

The one reset path used by start, tree replacement and shutdown must be safe to invoke more than once and must:

1. mark the outgoing generation closing so no new callbacks attach to it;
2. abort and settle its active completion audit;
3. stop audit animation and result-clear timers, then clear audit progress/result UI state;
4. stop scheduler timers and unsubscribe from its event bus;
5. clear continuation and network-retry timers/state;
6. unsubscribe terminal input and null the handle;
7. clear interruption/accounting state, queued audit transcript messages and session-scoped continuation markers;
8. clear widget registration/references locally even if host UI removal is unavailable;
9. conditionally release only the retention leases in the outgoing snapshot whose generation is still current.

There is no extension-wide retention clear in teardown. When the snapshot lacks a provable lease, leave bounded eviction to reclaim it. Context-dependent final accounting, transaction flush/persist and UI removal are best effort around the invariant, while unexpected storage errors stay diagnosable.

Cleanup operates on detached outgoing handles, not whichever controller, timer, widget or queue is currently stored on `core`. Null or retire handles before invoking a potentially throwing unsubscribe/abort. A duplicate or delayed teardown cannot clear newly installed resources. Flush pending work only against its captured owner; lock/revision/write failures produce a persistence diagnostic without skipping local cleanup or silently transferring the pending batch to the new session. Do not await an auditor indefinitely after abort.

#### B3. Give each audit a stable in-memory identity

Replace the bare controller as source of truth with one active-audit record containing at least a unique token, captured `goalId`/focus revision and audited state, plain storage context, owning session/transaction generation, controller and phase (`running`, `awaiting-choice`, `settling`, `settled`). An aborted controller or a cleared progress widget does not mean the user's Escape decision has settled.

Route every outcome through one idempotent finalizer:

- approval, disapproval or auditor error;
- a throwing auditor;
- user chooses complete without audit (`audit_skipped`);
- user continues after interrupt;
- focus/session replacement or shutdown.

The finalizer claims the outcome synchronously before any awaited work, writes only through the captured owner and rejects a second outcome. Teardown retires ownership and aborts the controller before settlement. Fence every progress callback, timer, dialog response and `finally` cleanup as well as the final promise result: an old audit cannot clear a new audit's spinner, modal depth, abort state or result card. Late callbacks can neither enqueue into a replacement transaction nor mutate/complete its goal.

Keep persistence best-effort and observable: distinguish an in-memory terminal attempt from a confirmed ledger append. On write failure, report diagnostics and leave disk-derived readers truthful; do not keep retrying an ambiguous append and create duplicates. Completion still requires the current goal/focus and authoritative revision, task and contract checks. A recorded audit approval is not proof that the subsequent completion/archive write succeeded. Never restore an old goal snapshot over a newer task list or resurrect an archived/deleted goal.

The registered two-session regression now proves that both audits can overlap and an older rejection is attributed to the newer unfinished audit. Add an optional `auditId` to new start/result/skip events, using one UUID per attempt. Derive latest lifecycle by the newest start and its matching outcome; old records without IDs retain chronological interpretation. Keep the same in-memory attempt record as the callback authority. No goal-file migration, prompt field, provider identity or additional session framework is needed.

#### B4. Derive newest audit state consistently

Create a single latest-audit lifecycle derivation over `audit_started`, `audit_result` and `audit_skipped`. Migrate user/model-facing readers in `goal-status.ts`, `goal-format.ts`, `goal-compaction.ts` and `goal-events.ts` to that lifecycle.

Keep the latest start and matching terminal event in the existing bounded runtime index, alongside the last settled result needed for historical rejection context. The long-running-audit regression proves a start can otherwise fall out of the 12-event window. Derived ledger checkpoints advance to version 4 and rebuild once from the unchanged JSONL ledger; they do not migrate authoritative records or clear provider retention. Reuse one matching predicate in reconstruction, indexing and lifecycle readers.

`[old result, newer audit_started]` means “latest audit has no recorded result,” never the old verdict. Persisted history cannot distinguish a live in-process audit from a hard-death orphan, so disk-derived wording stays neutral. Runtime UI may say “running” only when its token matches the active record. Keep a separately named latest-settled-result helper for prior-rejection context.

#### B5. Lifecycle regression matrix

Use deferred promises and explicit barriers, not sleeps:

- stale context at the first, middle and final context-dependent operation in start/tree/shutdown;
- an unexpected error followed by proof that all later local cleanup still ran;
- a real in-flight auditor receives abort on shutdown;
- teardown versus auditor resolution in both orders produces one outcome;
- goal A audit, focus switch to B, then every terminal outcome: only A may receive it and B is untouched;
- shutdown while the Escape decision dialog is pending settles once;
- goal A → B → A with the same goal ID, overlapping session loads, and an old progress/finally callback after a new audit starts cannot regain authority;
- two projects with equal goal/session IDs, custom `goalsRoot`, and an outgoing dirty transaction cannot cross-write or consume the new transaction;
- lock contention, revision conflict, ledger failure and archive failure preserve the correct incomplete/recoverable state, emit diagnostics and still release all resources;
- another writer changes tasks/contracts or clears the audited goal before approval; completion cannot overwrite that new state;
- auditor throw leaves no controller, timer, progress or stale result;
- old result followed by a newer start renders correctly in compact/verbose status, `get_goal`, list, prompt and compaction history;
- a persisted start without result remains readable without migration;
- a real Pi 1.4 reload/new-session worker emits no extension error and no old callback can fire after the replacement request;
- old-generation cleanup racing a new generation with the same external session identifier cannot clear the new retained prefix.

The #109 shutdown test currently installs a bare `AbortController` without starting a nested audit or even writing its start event. Replace that surrogate with a real pending auditor promise and assert abort, ledger ownership, durable outcome count, timer/subscription cleanup and late-callback behavior. Tests of a lifecycle helper must also pass through each reader; the PR's helper detects a newer start, but its status/history callers first select an older result and hide that start.

#### B6. Cache expectations

- Unrelated lifecycle fixtures remain byte-identical to 0.34.0.
- Audit-state changes may alter only the scenario live tail/new ledger-derived state, never the immutable provider prefix.
- Shutdown produces no provider payload by itself and may release only its exact leases.
- A stale audit callback produces no payload mutation and cannot cause a cache reset in the replacement session.

Run the cache comparison immediately after this track.

### Milestone C — normalize and classify `update_goal` once (#115 / #117)

1. Add a pure `planUpdateGoal` boundary before transaction flush, scheduler changes or goal mutation.
2. Normalize whitespace-only optional strings and arrays with no nonblank entries to absent. When `status` is present, ignore only an exact payload-free `ready` continuation.
3. Classify meaningful fields by action:
   - complete: `status` plus optional `completion_summary`;
   - blocked: `status`, required `reason` and optional `attempted_actions`;
   - paused: `status`, required `reason` and optional `suggested_action`;
   - ready/wait: `continuation` only.
4. Accept exactly one meaningful action. Reject no action, status plus a real wait, or nonblank fields belonging to another action. Name the conflicting fields in the repair message.
5. Return `isError: true` and `terminate: false` for structural rejection. Do not flush, mutate, append, reschedule or invalidate retention.
6. Dispatch an accepted plan through the existing flush and action handlers.

The planner should expose a discriminated union with typed `GoalContinuation`, not `GoalContinuation | unknown` (which collapses to `unknown`) followed by unchecked casts. Preserve meaningful text and the input object. Pi's schema validator still owns malformed types, nulls not permitted by the schema, unknown statuses and extra properties; add defensive coverage without widening the public schema. A `ready` object with an extra meaningful field is never normalized away. Error messages name the supplied conflicts and offer a repair compatible with filler-producing providers, rather than simply requiring every optional field to be omitted.

Coverage includes:

- a table of complete, blocked, paused, ready and wait with omitted, blank and meaningful optional values;
- the verbatim issue #115 object;
- Cartesian conflict cases and an all-filler/no-action case;
- input immutability and no goal/scheduler/ledger/cache mutation on every rejection;
- a dirty buffered task update before invalid `update_goal`: the rejection must not flush it, change revisions/accounting, call Oracle/auditor, arm timers or drop the buffer; a subsequent valid call flushes that same work once;
- the actual registered tool returning `isError: true` for conflicts;
- `validateToolArguments` in `tests/tool-input-sdk-worker.mjs` followed by real execution of the recorded object;
- `update_goal` in `experiments/context/provider-crosscheck.mjs` across all three OpenAI Responses strict-compat modes, with the captured payload accepted at the extension boundary.

Use a local scripted Responses server to return the exact issue arguments through the installed Pi tool-call path, then assert approval and deferred archival in the resulting goal/ledger. SDK validation alone and an outgoing-schema capture alone are different partial checks; include both and the combined path. For wait/ready tests, assert the actual scheduling decision/termination under `strictExecutionContract: true` and the existing opt-in response under the default `false`. Preserve blocked-goal consecutive-attempt/Oracle rules and pause reasons. The PR's wait test merely asserts that one old error string is absent, so an unrelated failure could make it pass.

Cache expectations:

- Do not redesign or reorder the public schema. The tool schema hash and immutable tool prefix must exactly match 0.34.0.
- Planning/normalization is runtime-only and cannot affect a provider request before the tool call.
- A rejected call appends only its ordinary error result through the existing host path; it does not reset the retained base or add a duplicate live tail.
- Unaffected provider fixtures and explicit-marker metadata remain byte-identical.

Run the cache comparison immediately after this track.

### Milestone D — make skipped terminal, not pending (#110 / #111)

Change the shared walker so `pending = total - rawComplete - rawSkipped`. Preserve the current display meaning of `complete` when `doneIncludesSkipped` is requested. Audit every consumer instead of patching only `taskCompletionBlockWarning`.

Coverage includes:

- nested trees across pending, in-progress, complete and skipped states;
- an empty tree, skipped parent with a pending child, completed parent with an in-progress child, reopened work, and each `doneIncludesSkipped`/`collectPending` combination;
- invariant `total = rawComplete + skipped + pending`, with collected pending nodes equal to `pending` regardless of display mode;
- completion warning: complete+skipped passes while any pending/in-progress node blocks;
- auditor task gate and active prompt omit a false TASK GATE for skipped-only work and retain it for real pending work;
- registered `update_goal({status: "complete"})` with `blockCompletion: true`, complete+skipped tasks and an approving auditor reaches deferred archival;
- the same tree with one pending node remains active and never starts the auditor;
- dashboard/status keeps skipped and completed counts distinct.

Use fixed-seed generated trees and an independent flatten-and-classify reference, not another copy of the recursive implementation. Check count additivity across sibling subtrees and input immutability. Keep task evidence/skip-policy validation and the independent auditor in the registered completion test; correcting terminal counts must not become an approval bypass.

Cache expectations:

- Internal counting alone does not change the tool/system prefix or unrelated serialized fixtures.
- Where skipped-only state previously produced the wrong gate text, the expected delta is confined to the smallest task/auditor live-state block.
- The corrected count must not cause an extra retention reset. If task facts are still reset under the existing safe policy, that break remains classified until Milestone G proves a narrower representation.

Run the cache comparison immediately after this track.

### Milestone E — enforce keyboard ownership for every shortcut (#114 / #116)

Add a narrow tri-state focus adapter: main editor, foreign focused surface, or unknown. Pi 1.4 publicly exposes `getFocusedComponent()` and supports `OverlayOptions.nonCapturing`; its `isOverlayFocused()` is protected, so do not assume it is a supported public extension API. Prefer verified editor identity or a narrow adapter over `hasOverlay()`, because a visible non-capturing overlay can coexist with editor ownership. Structural text accessors alone do not prove ownership: a custom foreign editor can implement `getText`/`setText` too. Establish the available host seam with a real Pi fixture before choosing the implementation; avoid broad private-field dependencies.

Implementation seam verified in the installed Pi 1.4 source: `CustomEditor.actionHandlers` is public, and Pi installs `app.clear` plus `onSubmit` on its main editor, copying them when replacing it with another CustomEditor. Query `getFocusedComponent()` through the widget's actual renderer and require this host app wiring; text accessors alone do not qualify. Missing renderer/focus access retains the embedding fallback. Native dialogs, foreign text editors and capturing overlays do not have the main editor's app wiring; a non-capturing overlay leaves the main editor focused. No protected focus field or editor wrapper is needed.

At the start of the terminal listener—after the existing Goal-owned modal guard and before Kitty repeat handling—return unhandled for a foreign owner. Apply the boundary to:

- pause and host-interrupt bookkeeping;
- auditor interrupt;
- dashboard expand/collapse and navigation;
- auditor toggle;
- configured goal-command shortcuts;
- debug shortcuts;
- Kitty repeat/release forms of all of the above.

Unknown/uninspectable hosts retain current behavior. Main-editor behavior, including remapped `app.interrupt`, custom pause keys and pause order, remains unchanged.

Test a matrix of main editor, native Pi select/input/editor dialogs, a focus-capturing custom overlay, a visible non-capturing overlay and an uninspectable host. Assert consumption and absence of every side effect: abort, pause event, goal mutation, audit cancellation, dashboard movement, command invocation or debug change. Add an installed Pi 1.4 walkthrough that opens both a foreign custom surface and native dialog, feeds Escape and a remapped Goal key, closes the surface, then proves the same keys work after editor focus returns.

Include a foreign editor with text accessors, nested/hidden overlays, focus restoration after resize, widget recreation or a missing widget reference, listener order where another extension consumes first, all pause-order settings, remapped host interrupt, and ordinary/Kitty press/repeat/release forms. Unknown-host fallback is a compatibility policy, not a reason to classify observable Pi 1.4 foreign focus as unknown. Verify only one action per physical press after returning to the main editor.

Cache expectations:

- Unaffected keyboard scenarios have zero provider-payload delta.
- Keys delivered to a foreign surface must not mutate goal state, schedule a request, append a live tail or invalidate retention.
- Fixed foreign-focus scenarios legitimately stop emitting the erroneous pause/abort/request sequence. Record those as corrected behavior with no request/state mutation from the foreign key; compare unaffected fixtures byte for byte rather than requiring the candidate to reproduce the buggy sequence.

Run the cache comparison immediately after this track.

### Milestone F — make context-usage display optional and off by default (#112)

Use the existing `showAutonomousRuns` plumbing as the pattern, with `showContextUsage` defaulting to **`false`** per the user's latest instruction. Do not take #112's default-on resolver or `!== false` rendering semantics unchanged.

Implementation stays in existing paths:

1. Add the boolean leaf to `goal-settings.ts`: type, allowlist, parser, layered resolution/provenance, sparse persistence and `effectiveSettingsReport`. Project overrides global; an absent value resolves to `false`. Preserve explicit values and remove overrides through existing reset behavior. No migration, eager default writes or separate settings cache.
2. Add one boolean row/value entry to the current `/goal-settings` menu. Reuse its mutation, scope switch and refresh hooks. Do not reinstall tools, reschedule work or add a per-setting refresh path for this display change.
3. In `goalPromptParts`, emit `contextUsageLine(contextUsage)` only when `settings?.showContextUsage === true`. Compose the existing counters without a placeholder or extra blank line. Leave `contextUsageLine`, context measurement and policy construction unchanged; keep this display flag out of `cachedPrompt`'s policy key and provider identity. `goalPrompt` and registered context injection inherit this single rendering decision.
4. Add a short `docs/advanced-usage.md` explanation of default-off, explicit opt-in and forward-only display behavior. Keep the run-allowance explanation and its “this setting” reference together. Exclude the PR's README addition and consolidate release notes later.

Extend existing tests; no new runtime subsystem or test framework is needed:

| Boundary | Required evidence |
| --- | --- |
| Rendering | Omitted settings, `{}` and explicit `false` omit the line; `true` reproduces the full 0.34.0 counters for the same fixture. Cover known/zero/unavailable occupancy and finite/unlimited run allowance with `showAutonomousRuns` on/off. Preserve all remaining bytes and lifetime/budget information. |
| Layering and persistence | Default `false`; global `true`/`false`; project values overriding the opposite global value; removing each override restores inheritance/default. Save/reload through actual mutation and persistence APIs without manually invalidating caches to conceal stale reads. Invalid values preserve disk bytes and follow existing diagnostics. Preserve unrelated settings and explicit `false`. |
| User/settings boundary | Drive the registered menu to change and reset both scopes, reload and inspect the effective-settings report. Assert value and provenance, not just row count. Verify no tool-profile reinstall, extra request, timer or scheduler mutation from this setting. |
| Accounting and lifecycle | Drive scripted provider usage and registered context/compaction events with display on/off. Compare goal usage, ledger/accounting, token-budget enforcement, autonomous runs, scheduler state and host compaction behavior. Calling the formatter alone does not prove these invariants. |
| Retention and providers | Through the registered hook and existing real SDK workers, capture default/off/on, true → false → true, identical retry, settings reload, compaction and bounded rollover. Stable policy/system/tools/cache options remain identical. No toggle-specific reset or duplicate retry tail; marker placement and tool-result adjacency stay correct. |

Visibility controls fresh counters only. Prior counters already sent remain historical under the existing “Latest snapshot supersedes earlier snapshots” text; hiding a field is not deletion of its underlying measurement or an instruction change. Retaining those blocks preserves the prefix and does not require a new supersession policy. A session starting off has no injected context line from this path. Do not purge old retained snapshots or rewrite persisted history just to hide previous observations.

While hidden, changing only occupancy must leave the rendered counters unchanged and add no retained block. Other usage/run changes still update their own counters normally. Test this separately from a toggle that correctly appends one new counter snapshot, and retain the existing independent reset rules for compaction, policy changes and capacity.

Default-off intentionally changes the first fresh counter relative to 0.34.0. Record the exact removed line and first divergence in the cache report; compare real-history reuse separately from counter size. Explicit `true` is the byte-identical counter control. Any additional policy/schema/cache-key change or reset fails the track. Do not promise identical cross-version payloads or hide their difference in the comparator. A source-baseline test must fail because the line is still shown/setting rejected, not because a new helper is missing. Targeted variants that change the default back to `true`, discard persisted `false` or clear retention on toggle must fail the corresponding guards.

Review/adapt only the minimal PR hunks that pass this contract. The new default, effective-settings report, independent tests and documentation placement require changes to the proposal. Run the cache comparison immediately after this track.

### Milestone G — maximize safe cache reuse (#108)

Milestones A–F establish the mandatory stabilization behavior and cache-preservation gates. The #108 investigation and measured disposition are required, even if no retention change ships. Evaluate a narrower invalidation design in its own commit so it can be dropped without disturbing bug fixes. Prioritize avoidable resets and redundant work demonstrated by the transition report before considering a broader representation change.

#### G1. Classify state structurally

- Compare typed goal-state components, not one rendered prompt string.
- Start with an explicit allowlist of candidate fact-only fields; every unclassified or instruction-bearing change keeps the current reset.
- Treat objective, verification contract, active task instructions, pause/clear/cancel semantics, scheduling commands, completion policy and auditor instructions as policy unless proven otherwise.
- Record why every transition is policy-bearing, append-only fact, history rewrite or identity change in the deterministic report.
- Compare repeated task-progress workflows of different tool-output sizes and lengths. Attribute lost reusable bytes to each reset cause and rank the avoidable cost. Keep safe identity/history/clear boundaries intact; do not remove resets globally to improve a percentage.

#### G2. Prototype versioned, self-superseding fact snapshots

If a field qualifies as fact-only:

- append a small complete snapshot of the selected factual fields with `goalId`, monotonic semantic revision/sequence and an explicit “latest revision supersedes all prior fact snapshots” contract; validate session generation internally without rendering it merely for ownership bookkeeping;
- encode cleared, removed, cancelled and empty values explicitly; omission cannot mean both “unchanged” and “deleted”;
- keep instructions that interpret the snapshot in the stable policy block and ensure they do not change per request;
- reject out-of-order, duplicate-revision and cross-goal snapshots;
- advance a revision only when represented facts change; identical retries, no-op updates and unchanged counters cannot produce new revisions or duplicate snapshots;
- retain exact tool-call/result adjacency and explicit marker placement;
- cap snapshot count/bytes and define rollover as a classified reset.

Do not append historical instruction blocks under a “superseded” label. If the model could still reasonably obey an older instruction, that component remains reset-on-change.

#### G3. Semantic adversarial tests

For every candidate fact field, test:

- set → update → clear;
- populated → empty and empty → populated;
- goal A → goal B with matching text;
- pause → resume, wait → cancel and scheduled → unscheduled;
- task pending → complete/skipped → removed/reopened;
- audit start → result → new start;
- compaction, retry, delayed tool result and bounded rollover.

At each step, use an independent fixture oracle to reconstruct the effective latest facts from the serialized request and compare them with source-of-truth state. Assert old instruction-bearing blocks are absent whenever their policy changed; a “superseded” label is not evidence that a model will ignore an old instruction. Review the composed text for conflicting requirements, including untrusted task titles/contracts. Programmatic state reconstruction proves representation consistency, not model obedience, so any design relying on the latter stays out of this patch.

#### G4. Cache acceptance gate

The optimization may ship only when all of these are true:

1. No semantic adversarial test fails and no state class remains ambiguous.
2. Immutable hashes, marker placement, tool adjacency and retry identity remain unchanged.
3. No unchanged scenario loses reusable history or gains a break. If a deliberately smaller fact representation reduces repeated live-state bytes, compare history reuse and total workflow cost rather than retaining redundant text merely to preserve an absolute byte count; document that exact representation delta.
4. At least one repeatable issue #108 sequence gains reusable prefix bytes/messages and the gain survives bounded-growth tests.
5. Retained tail count/bytes stay within current bounds or a separately justified tighter bound.
6. Paired live-provider trials, run close together with identical models/prompts and sufficient repeats, show no material regression. Any disagreement with deterministic results is investigated rather than averaged away.

Evaluate the entire workflow, including at least two capacity rollovers, rather than its best warm request. Report total input bytes/tokens, uncached input, cache reads, cache writes, request count, retained historical overhead, reset frequency and completion/cancellation correctness together. Use adapter-specific usage semantics so cached tokens are not double-counted or averaged as unweighted per-request percentages. Preserve raw usage and show the formula; unknown cache accounting stays unknown. A larger reusable prefix is not a win if added snapshots make total work materially more expensive.

For live evidence, fix the model/provider, request sequence, options and cache-retention tier; run at least five paired baseline/candidate warm sequences with balanced order and separate trial identities. Include implicit Responses and the explicit-cache path affected by the change; record interval/TTL, cold starts and reported cache availability. Predeclare a 5% increase in paired-median uncached input or total billed-input cost as a material-regression investigation threshold, not a license to accept deterministic prefix loss. Publish per-pair values and spread. If accounting/prices are unavailable, report tokens/bytes without inventing cost. Extend noisy trials or defer the optimization; missing credentials or inconclusive results do not block shipping the independently safe bug fixes.

If any condition fails, remove the G commit from 0.34.1. Keep the instrumentation and no-regression gate, document the rejected design in `MILESTONES.md`, and continue issue #108 separately. Cache hit rate never overrides stale-instruction safety.

### Milestone H — integrated regression and package validation

1. Rebase each accepted bug track onto current main and replay its red test against the 0.34.0 baseline.
2. Integrate the harness, lifecycle, tool-input, task, keyboard and context-display commits in that order.
3. Run the cache comparison after each commit and once on the combined head. If Milestone G is accepted, run once with and once without its commit to make its benefit and rollback boundary explicit.
4. Consolidate one Unreleased changelog section only after behavior is final. Do not change README.
5. Require GitHub CI on the exact integration commit; local focused passes are not a substitute.
6. Build and install the tarball into a clean temporary project, then rerun essential lifecycle, tool-input, skipped-task, keyboard, context-display and cache smokes against the installed package.
7. Review the final maintenance result across the release: replaced paths are removed, ownership/normalization have one authority, no temporary experiment mode remains, and every new runtime mechanism is necessary for an accepted invariant. Simplify or rewrite a track that fails this review before including it.

Dependency order is A → B → C/D/E/F → H; C, D, E and F have independently reviewable contracts but must all pass the combined scenarios. G branches from that stable result and has an explicit keep/drop decision, followed by H on the final candidate. Re-review any changed head/base and rerun only the affected gates during development; run the complete release ladder once the final source and package metadata are fixed.

## 5. Pull-request intake and contributor strategy

### 5.1 Required intake for every in-scope PR

Before retaining any contributor hunk:

1. reproduce the issue independently on main;
2. write the behavioral contract and a failing test that does not depend on the PR implementation;
3. review every changed line, dependency, public type/schema, error path and cache effect;
4. inspect contributor tests for false positives, mocked-away host/provider behavior, timing dependence and missing negative cases;
5. run the patch's focused tests, the independent red tests and the relevant real Pi/SDK boundary;
6. classify each hunk as keep, rewrite or reject with a short rationale;
7. prefer a fresh minimal implementation when retained code needs surrounding fixes to become understandable or safe;
8. preserve accurate credit for diagnosis, tests and design, without describing rewritten code as an unchanged merge;
9. validate the final integrated commit, not merely the source PR head.

The hunk ledger belongs in `MILESTONES.md` during implementation: source PR/head, file/hunk, keep/rewrite/reject, reason, replacement commit, independent regression, boundary-test result and cache-report result. Include removed/superseded production paths and justification for each added runtime mechanism. No unreviewed hunk crosses into the release branch. A new PR push invalidates the reviewed diff until its changes are checked again; review code and tests together, including deletion or weakening of an existing assertion.

### 5.2 Initial PR decisions

| PR | Initial decision | Evidence required before code retention |
| --- | --- | --- |
| #109 | Substantial rewrite | Exactly-once finalizer, real abort/timer cleanup, captured goal/storage identity, newest-audit derivation, same-session-generation cache race and real Pi reload. |
| #111 | Formula may be retained; no automatic cherry-pick | Independent walker invariant plus registered completion, auditor, prompt/status and cache-delta tests. If surrounding assumptions are unclear, rewrite the one-line correction. |
| #116 | Reimplement ownership boundary; selectively reuse clear fixtures | All shortcuts, actual focus ownership, capturing versus non-capturing overlays, Kitty forms, installed Pi walkthrough and zero payload/cache delta. |
| #117 | Adapt pure-planner idea or rewrite | `isError: true`, before-flush no-side-effect proof, immutable input, registered-tool execution, real SDK/provider validation and unchanged schema hash. |
| #96 | Reject from campaign | Feature work; no hunk or changelog fragment enters stabilization. |
| #112 | Adapt the small existing-path implementation; no unchanged merge | Default `false` in resolution and omitted-settings rendering; complete settings/reporting and save/reset/reload coverage; registered accounting/compaction invariants; explicit-true counter equivalence; default/toggle/retry cache evidence. Exclude README and unnecessary abstractions. |

Keep one implementation commit per behavior track, plus separate harness and optional cache-optimization commits. This creates clean review and rollback boundaries. Per the user's attribution correction, add `Co-authored-by` trailers to the corresponding fix commits for the retained or adapted contributions, including the original proposals behind rewritten fixes. Use each contributor's name/email from a GitHub-associated source commit and verify GitHub resolves the co-author to the intended account. Reword only commit metadata, preserve every existing commit tree, and push with an exact expected-head lease. Keep the hunk ledger's keep/rewrite decisions accurate; attribution does not mean an unchanged merge.

### 5.3 Concrete gaps in the reviewed proposals

| PR | Source-level finding | What the acceptance test must prove |
| --- | --- | --- |
| #109 | `settleInterruptedAudit` nulls the controller without aborting it, takes `core.state.goal`, catches every append failure and leaves animation cleanup to other paths. Old callbacks also touch shared progress before checking focus. | A genuinely running audit is aborted/retired, settles only its captured target, and cannot change a new audit; failed persistence remains observable. |
| #109 | `goal-format.ts`/`goal-status.ts` check `latestAuditorResultForGoal` before the new lifecycle helper. The reader tests omit `[old result, newer start]`. | Standard/verbose status, list/history, prompt and compaction agree on the latest attempt; old rejection context is explicitly historical. |
| #111 | The formula is appropriately small and contributor tests cover nested skipped counts and warning text, but do not drive completion or the independent auditor. | Correct counts reach the registered completion/auditor/archive path and preserve pending/in-progress/contract rejection. |
| #116 | The listener guards Escape and three action names; other command/dashboard/auditor/debug shortcuts still run. `hasOverlay()` rejects non-capturing overlays, and tests mock the private focus field instead of exercising Pi dispatch. | Every action respects real focus ownership, the actual focused surface receives the key, and main-editor controls resume correctly. |
| #117 | `flushGoalTransaction` precedes classification; rejection has no `isError`; `usedContinuation` ignores any object whose kind is ready; nonblank fields for a different lifecycle action can be silently dropped. | Exact filler passes; real conflicts and malformed input are rejected at the correct boundary without writes, hidden normalization or loss of pending work. |
| #117 | Wait coverage only excludes one error string; conflict coverage only counts remaining goal files; routing coverage matches source text. | Assert actual scheduler state, file/ledger bytes and revision, tool error flag, no auditor/Oracle calls, and successful subsequent repair through Pi's validator. |
| #112 | Resolver and helper rendering default to on; the latest instruction requires off. The effective-settings report has no new row, and the tests omit global/project reversal, persistence, override removal and actual menu mutation. | Default/omitted settings are off; explicit true restores the line; effective value and provenance survive every save/reset/reload path without touching other settings. |
| #112 | The “accounting unaffected” assertion only calls `contextUsageLine` directly. No registered context, retention, retry or compaction test proves the boundary. The docs insertion also displaces the run-allowance paragraph's referent. | Actual accounting, budget and scheduler outcomes agree with display on/off; default/toggle/hidden-occupancy payloads satisfy Milestone F; docs describe the right setting without expanding README. |

PR #96 remains deferred because it changes user-message delivery and continuation ordering. The user's later instruction brings #112 into scope and supersedes its earlier deferral, with default `false` overriding both the PR's proposal and the user's earlier default-on preference. Do not claim deterministic prevention of model-initiated pauses from a display change; test the requested output and unchanged runtime behavior, without adding a new heuristic or resuming explicitly paused work.

## 6. Validation ladder

Integrated session restoration uses the incoming durable draft entry as authority. Rehydration owns the drafting/execution profile decision; startup must not install a competing profile first or retain a different branch's memory draft. Preserve transient questionnaire context only when its saved draft identity matches.

### 6.1 Per-track loop

For each behavior track, including context visibility:

1. make the independent regression fail on `fe0e38f` for the expected reason;
2. implement the smallest fix;
3. run its focused unit/integration tests;
4. run the relevant installed Pi or real SDK/provider boundary;
5. run the deterministic cache comparison;
6. review the complete diff, remove superseded paths and update the hunk/maintenance ledger before starting the next track.

Do not accept a test that passes through longer sleeps. Race tests use barriers and exercise both orderings. Timeouts may bound a hung test but are not the mechanism that establishes the outcome. A red test must fail at the behavioral assertion, not because a new helper/import is absent on the old baseline. Record the command, baseline SHA, assertion, candidate SHA and result.

### 6.2 Combined source-tree gates

Run on the exact combined commit:

1. `npm run check`
2. `npm run lint`
3. `node scripts/ci-checks.mjs` — run the full suite/manifest, controls CLI, lifecycle CLI, installed-package regressions, context gate, provider cross-check, cache comparison and retention check through the existing two-worker runner. Each check keeps its own log; package/cache evidence goes into that run's directory. Failure or skipped required tests fails the command. Do not repeat these as separate CI steps.
4. `node --test scripts/test-ci.mjs scripts/test-publish-workflow.mjs`
5. `npm run bench:naf -- after naf` on baseline and candidate with the same dependency/fixture versions, then `npm run bench:gate:naf` using `PI_GOAL_BENCH_REFERENCE` pointed at that baseline run, as CI does. Run the two measurements sequentially after the other suites finish to avoid competing benchmark load. Include retention CPU/memory and local-cache read/rebuild measurements where the change touches those paths.
6. `npm audit --omit=dev`

CI repeats runtime gates on the declared minimum Node 22.19 with Pi 1.4. Results from local Node 26.10 remain supporting evidence only.

Remove the Windows job, `--windows` runner branch and `tests/windows` harness. Keep existing platform-independent persistence/error-path coverage and prior validation history. Linux is the sole CI platform; local macOS results remain separate supporting evidence. Keep the lockfile-keyed npm download cache and fail-safe runtime change detection. Retain successful evidence under one accurately named artifact. The installed-package check already packs the package, so remove `npm pack --dry-run` from CI.

### 6.3 Cache-specific release evidence

Archive:

- the baseline and candidate deterministic reports;
- their machine-readable diff and classified-break summary;
- explicit-marker and tool-schema hash results;
- per-track reports proving where no payload delta was expected;
- paired live-provider trial method, samples and interpretation if Milestone G is considered;
- the installed-package cache smoke result.

The release reviewer must be able to tell which changes preserved cache reuse, which deliberately invalidated it, and why, without inferring from an aggregate hit percentage.

### 6.4 Combined regression scenarios

All rows are required on the integrated candidate. Pairwise coverage supplements the focused matrices; it does not replace the explicit high-risk sequences below.

| Scenario | Required observable result / boundary |
| --- | --- |
| Recorded filler completion + nested complete/skipped tasks + approving auditor | Real SDK tool execution starts one audit, emits one outcome, completes once and archives only after the result is visible. Goal/system/tool prefixes change only where the corrected live result requires it. |
| Same completion with a genuinely pending child, absent required evidence, or auditor rejection | No false completion or archival. Task/evidence gate remains enforced; audit rejection keeps work actionable. Include tasks/contracts disabled settings with their existing semantics. |
| Audit running + dirty turn + session/project replacement + late progress/result/dialog cleanup | Old root receives only its own permitted settlement/flush, replacement state/timers/modal depth stay intact, no stale error, no duplicate event, no replacement cache release. Include same external IDs and A → B → A. |
| Foreign focused dialog during an audit, scheduler wait or provider-recovery delay | All Goal shortcuts return unhandled and cause no goal/audit/timer/accounting change; after focus returns, configured pause/host interrupt works once for each pause order. |
| Default-off context display + global/project changes + ordinary retry/compaction | No new context line unless explicitly enabled; exact values/provenance persist and reset correctly. Toggling changes fresh counters only, hidden occupancy changes add no tail, and accounting/budget/continuation outcomes remain the same. Compaction follows its normal boundary; toggling introduces none. Include an audit and a pending scheduler wait to detect accidental refresh side effects. |
| Task progress + provider failure/retry + later success | Failure cannot trigger an immediate continuation storm, charge another goal, duplicate terminal events or inject duplicate tails. Same-state retries preserve the eligible prefix; state updates have exactly their documented reset behavior. |
| Old checkpoint A while B is focused, both custom-message and prompt-trigger paths | Preserve 0.34.0 cancellation: no provider execution for stale A, no pause/charge of B; B's valid work starts in its own run. Exercise `agent_end`/`agent_settled` order and aborted startup. |
| Host prompt/tool-profile delta + compaction + audit display events | Preserve the current host instruction/tool profile from the first request, start a new prefix only at the documented boundary, and never insert display-only audits or retained tails inside tool-result pairs. Include executor and isolated auditor/Oracle contexts. |
| Lock contention/revision conflict/rename failure during flush, audit settlement or archival | No overwrite of external state, no partial task update, no fabricated durable success, complete cleanup and observable diagnostics. Keep brief Windows retry behavior bounded and current permissions intact. |
| Old persisted goal/ledger + newest unfinished audit + reload | Older saved records load without migration; all readers show the latest attempt honestly. Earlier verdicts cannot masquerade as the outcome of the newer start. |
| Long task loop + retention rollover + model switch + session eviction | Bounded memory and request overhead, no repeat reset on an unchanged request, no cross-owner eviction, correct explicit markers, and every prefix loss classified independently. |

Extend existing real-SDK workers instead of mocking away the failure boundary. A local scripted provider establishes actual host event ordering without paid or nondeterministic model calls. Test installed Pi TUI behavior with the existing terminal harness; RPC cannot prove keyboard ownership. Live external-provider trials are separately labeled and are required only for adopting G.

### 6.5 Guards against future regressions in these failure classes

- Maintain one small contract matrix mapping each issue/PR to its reproducer, generalized invariant, negative case, boundary test, cache scenario and CI command. Record this in the implementation log as tests land; incomplete rows block closing the corresponding bug.
- Use a fixed-seed state-machine corpus for start/switch/fork/reload, audit resolve/throw/abort, pause/resume, tool execution, retries and teardown. Assert state, ownership, durable events and resource counts after every transition, not just the final message. Persist the seed/trace for a failure. Use the existing Node test tooling unless a new dependency is independently justified.
- Reintroduce the specific count expression, pre-validation flush, missing focus guard and stale/audit ownership guard in temporary test copies to confirm the new regression fails. For context display, restore default-on, lose a saved `false` and clear retention on toggle in separate variants. Also remove/relocate a marker and alter early prompt content to prove the cache gate fails. This is a targeted test-quality check, not a repository-wide mutation-testing project.
- Avoid tests that only search implementation source or assert absence of an old error string. Prefer the registered tool/event listener and actual goal/ledger/request outcome. Snapshot assertions supplement invariants, and approved payload differences need a scenario-specific reason.
- Keep deterministic scenarios in mandatory PR CI with zero skipped required tests. A lost CLI, missing SDK, omitted manifest entry, empty cache report or expired test fixture cannot silently turn the check green. Investigate flakiness and isolate its cause instead of increasing sleeps or removing the gate.
- For subsequent bug fixes, reproduce first, identify the shared failure class, extend the matrix and rerun the relevant host/provider/cache boundaries. Do not claim a finite suite guarantees the absence of all future bugs; its purpose is executable contracts and reliable detection of recurrence and nearby failures.

## 7. Patch release

The user has approved merge and publication of 0.34.1. Finalize its changelog entry, pass the updated PR checks, merge with a merge commit to preserve the verified co-author history, and wait for main's integrated checks before tagging. Push an annotated `v0.34.1` tag at that tested main commit. The existing workflow owns ranking, packing, exact-artifact smoke, npm publication and GitHub release creation. Verify the registry download against the workflow's tarball digest, repeat the installed-artifact regressions, confirm `latest`, and record the release receipt. Do not bump another version or republish an existing package to work around propagation.

For the reviewed release candidate that has passed the integrated gates:

1. Consolidate the four reported-bug fixes, default-off context display, harness isolation and cache-safety work under Unreleased, crediting contributors and source PRs accurately. Explain the new default and explicit `showContextUsage: true` opt-in briefly in the changelog/advanced usage; record the code simplifications in the implementation log.
2. Prepare 0.34.1 as a bug-fix-first release. Include a Milestone G optimization only if all of its additional gates pass; otherwise keep the existing safe policy and ship the comparison guard.
3. Update package/lock metadata through the existing release process and build the tarball from the tested commit.
4. Install into a clean temporary project and repeat:
   - skipped-only completion through archival;
   - issue #115's recorded `update_goal` object through SDK validation;
   - foreign-dialog Escape/remapped shortcut behavior;
   - session reload with an in-flight audit;
   - context display off without configuration, explicit true/false persistence and reset, unchanged budget/accounting, and toggle/retry prefix retention;
   - same-session-generation cache isolation, retry identity and explicit-marker smoke.

   Assert the loaded extension path belongs to the extracted/installed tarball, not a symlink or import back into the source checkout. Pin the host/runtime used in the smoke and record tarball digest, package version, source SHA and results. Keep the package under test identical to the package published; any later runtime/manifest change reruns its affected gates.
5. Publish only after trusted-publishing validation succeeds on the tag. Verify registry metadata, tarball contents and the release workflow.
6. After the updated PR checks pass, close issues #110, #113, #114 and #115 and superseded PRs #109, #111, #112, #116 and #117. Use individual comments thanking each contributor, linking the relevant implementation/tests in #118, and stating that merge/release is still pending. Credit @adlternative, @Nyarlathoteppppp, @Has-X and @expoli in the PR description for the work actually retained or adapted.
7. Close or continue #108 according to evidence: close only if a proven optimization ships; otherwise link the cache report and follow-up scope. Record #112's adapted default-off implementation and credit with its exact tests when disposing of that PR. Leave #96 deferred.

Implementation and prior validation are recorded in the implementation log; the final CI cleanup and issue/PR disposition follow the latest user request. After publication, verify the installed registry artifact against the recorded digest and the same bug scenarios before declaring the release verified. Keep the previous published version and per-track commits as rollback references; a cache optimization can be removed independently if release evidence contradicts its measured benefit.

## 8. Stop conditions

Do not merge or release while any of these is true:

- one stale getter or throwing teardown step can skip later local cleanup;
- an outgoing load, transaction, progress callback, dialog response or `finally` can change a newer session or write into the wrong storage root;
- teardown can broadly clear retention or an old generation can invalidate a replacement session's prefix;
- an audit can settle twice, target the currently focused replacement goal, leave a timer/controller alive or mutate replacement cache state;
- issue #115 works only when bypassing SDK/provider validation, or rejection mutates state before classification;
- skipped-only tasks pass a helper but fail registered completion/auditor/prompt behavior;
- only default Escape is protected while remapped, dashboard, audit, command or debug shortcuts still leak into foreign surfaces;
- context visibility defaults on, explicit preferences fail to persist/reset/report correctly, or hiding counters changes accounting, budgets, continuation or compaction;
- a display toggle clears retention, changes the policy/schema/cache identity, or the new default changes more than its approved counter line;
- context/provider gates share writable state or fail under concurrent execution;
- an immutable system/tool/schema hash changes without an approved requirement;
- an unchanged scenario loses reusable prefix bytes/messages, a retry grows, marker behavior differs from its expected history transition, or a prefix break lacks an independently justified reason/count;
- a live cache regression materially disagrees with deterministic evidence and remains unexplained;
- a cache optimization leaves any stale or ambiguously superseded instruction visible;
- any retained PR hunk lacks independent tests, hunk-ledger review or cache-impact review;
- a fix leaves superseded production paths, duplicate state/logic, unexplained runtime machinery or a temporary experiment mode in the release;
- required CI is absent or failing on the exact integrated commit;
- a test passes only through source-text matching/absence of an old message, its targeted broken variant also passes, or the cache comparator accepts a known bad capture;
- package smoke tests accidentally load the source checkout, or the published artifact cannot be traced to the tested candidate.
