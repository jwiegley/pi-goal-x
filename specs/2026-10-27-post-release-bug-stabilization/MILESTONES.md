# Implementation log

## 2026-10-27 — planning audit

- Started from main `fe0e38f` (package 0.34.0). Versions 0.33.0 and 0.34.0 were both released on 2026-10-24 and form the relevant large-change baseline.
- Read every open issue (#108, #110, #113, #114 and #115), every open PR (#96, #109, #111, #112, #116 and #117), their comments/reviews, and the complete patches for the four bug-fix PRs.
- Found no issue comments, no substantive PR reviews and no reported CI checks on the open PR heads.
- Initially classified #108 as follow-up design work and #96/#112 as feature work. The later cache-quality steering below supersedes #108's deferral: measurement and non-regression are now in scope, while an unproven retention redesign remains conditional.
- Preserved the pre-existing untracked `specs/2026-10-01-open-pr-disposition/` directory unchanged.

## Baseline and branch validation

- Main typecheck and lint pass on local Node 26.10.0/npm 11.19.1.
- `scripts/ci-checks.mjs` passes: 1,216 tests in 91 files with zero failures/skips, ten Pi 1.4 controls walkthroughs, and a live three-request draft/execution/audit lifecycle that archives successfully.
- Sequential context gate and provider cross-check pass. Retention measurement completes for text, tool-output and image histories at 64 KiB, 1 MiB and 4 MiB.
- In isolated temporary worktrees:
  - PR #109 passes typecheck plus 10 audit-interruption checks.
  - PR #111 passes typecheck plus 56 task checks.
  - PR #116 passes typecheck plus 89 widget checks.
  - PR #117 passes typecheck plus 99 core/scheduler/objective checks.
- These focused passes do not change the PR dispositions. The missing cross-boundary, race, host, provider and cache cases are material.

## Failed attempt that exposed a harness bug

- Ran typecheck, lint, context gate, provider cross-check and retention measurement in parallel.
- Typecheck, lint and retention passed, while the context gate reported stale-checkpoint baseline drift and the provider cross-check saw only two of five expected goal tools.
- Both context commands passed when rerun sequentially, with byte-identical baseline data and six real SDK payload captures.
- Root cause: both commands mutate and recursively delete the hard-coded `/tmp/goal-context-capture`. Their processes can replace each other's fixture between capture and assertion.
- The technical plan now makes per-invocation workspace isolation and a concurrent regression the first implementation milestone.

## Bug-design findings

- PR #109's shutdown settlement uses the currently focused goal, does not reliably abort the controller or stop the animation, and lacks an exactly-once guard. Its lifecycle reader notices a newer start, but existing status/history readers prefer an older result and hide that state. Integrate the behavior with #113 through a fresh lifecycle design.
- PR #117's pure normalization direction is useful, but structural rejection remains `isError: false`, provider-boundary coverage omits `update_goal`, and classification must precede transaction flush to prove no side effects.
- PR #116 addresses default Escape for only three actions, while all Goal shortcuts run before the focused component. `hasOverlay()` also includes non-capturing overlays. Actual focus ownership must guard the whole listener.
- PR #111's count formula is sound in isolation. Registered completion, auditor, prompt, nested-tree and count-invariant coverage is still required.

## 2026-10-27 — cache and PR-quality plan revision

The user made two release constraints explicit:

1. maximize safe cache reuse and avoid changes that needlessly invalidate retained prefixes;
2. include PR code only when it is exceptionally well written and independently tested, otherwise implement the behavior afresh.

Following the repository steering order, `PRODUCT.md` was updated first, then `TECH.md`, then this log. No runtime, test, README or changelog file was changed during this revision.

### Cache audit

- `goal-live-retention.ts` already preserves exact request-only tails using session/anchor/base-history fingerprints. Identical retries add no blocks.
- Retention intentionally resets for policy/state changes, history rewrites, unsafe tool-result insertion, empty-to-nonempty history changes and bounded rollover.
- Current safeguards cap retained live tails at 32, tracked sessions at 16 and counter bytes at 4,096.
- `goal-prompt-cache.ts` relocates a pre-existing explicit marker from a transient live tail to real history. It does not enable caching, change TTL/tier, add a marker, place one on thinking, or split a tool-call/result pair.
- Unit and SDK coverage already exercises literal prefixes, unchanged retries, reset cases, per-session isolation, bounded growth, delayed results, large payloads, Anthropic/Bedrock marker behavior, OpenAI shapes and compaction.
- The missing release evidence is a single deterministic 0.34.0-versus-candidate artifact that reports immutable hashes, exact longest reusable prefix, block/byte/token estimates, marker metadata and a reason for every break.
- Issue #108 reports deterministic prefix breaks in state-changing sequences and variable live cache-read measurements. Its experimental append-only approach appears promising but has not proved safe supersession for cleared, cancelled or instruction-bearing state.

### Important correction to the original lifecycle plan

The first draft said teardown should clear all live-tail retention owned by the extension instance. That is too broad.

A delayed old-session cleanup could run after a replacement session with the same external identifier has retained a useful prefix. An extension-wide or key-only clear would then destroy the new entry and reduce cache hits. The revised plan:

- gives each outgoing session immutable retention leases with an ownership generation;
- conditionally releases only exact leases still owned by that generation;
- makes late cleanup a no-op after a newer generation acquires the identity;
- avoids broad clear when ownership is uncertain and relies on bounded eviction instead.

This correction is now a release-blocking lifecycle and cache invariant.

### Cache plan decisions

- Cache comparison is added before product implementation and rerun after every behavior track.
- All four fixes must preserve byte-identical host/system/tool/schema prefixes. None requires a public schema change.
- #113/#109 may alter only session/audit live state and must not clear or mutate the replacement session's cache.
- #115/#117 keeps the public `update_goal` schema hash unchanged; normalization remains a runtime-only pre-flush boundary.
- #110/#111 changes only the incorrect skipped-task scenario state, without an extra retention reset.
- #114/#116 is required to produce zero provider-payload or cache delta.
- #108 is reclassified as:
  - mandatory deterministic measurement and no-regression protection for 0.34.1;
  - optional, isolated fact-only retention optimization if adversarial semantic tests and a strict reuse gate both pass;
  - separate follow-up if either safety or measurable improvement remains uncertain.
- Deterministic serialized-prefix evidence is authoritative. Paired live cache-read trials remain supporting evidence because provider routing, TTL and cache thresholds are variable.

### PR acceptance decisions

- PR heads will not be merged or cherry-picked merely because their focused suites pass.
- Each issue is reproduced independently and receives a behavior-first red test before contributor code is evaluated.
- Every contributor hunk is recorded as keep, rewrite or reject with rationale, independent test evidence and cache impact.
- #109 requires a substantial rewrite.
- #111's small formula can be retained only if the complete walker and registered-flow contract passes; otherwise it is rewritten.
- #116's ownership boundary is reimplemented broadly, with only independently useful fixtures considered for reuse.
- #117's pure-planner idea may be adapted, but schema, error and before-flush behavior require independent implementation evidence.
- #96 and #112 contribute no hunks to this bug-fix campaign.
- Credit remains accurate for useful diagnosis, design and tests even when implementation is rewritten. Co-author trailers are reserved for material authored code actually retained.

## 2026-10-27 — full inventory and implementation-plan recheck

Updated `PRODUCT.md` first, then `TECH.md`, then this log in response to the renewed request to consider all open issues/PRs, defer features, maximize safe cache reuse and accept only thoroughly reviewed code. The earlier audit and test results above are preserved as historical evidence; they were not rerun or newly claimed by this revision.

### Fresh evidence

- GitHub's open-issues collection returned five issues (#108, #110, #113, #114, #115) and six PRs (#96, #109, #111, #112, #116, #117); the separate PR collection agreed. Read all bodies, all changed-file patches including both feature PRs, review submissions and inline comments. All collections fit on their requested 100-entry pages.
- All six pinned PR heads have zero check runs and zero commit statuses. Discussion counts and inline comments are zero. #112's one review submission says its bot reviewer had insufficient quota; it supplies no review evidence. The repository does configure PR CI, so missing runs are an intake problem to investigate, not an exemption.
- Recorded every reviewed head and source link in TECH §1.4. #96 is conflicting according to GitHub and remains deferred along with #112. No PR was merged, changed, approved or commented on.
- Verified remote/local main as `fe0e38f8cd03bfacc9baca730e9a902d3cff116e`. The v0.34.0 annotated tag resolves to `8f0c28b08a152efef9da2728e7f8e96b02455506`. `git diff --stat v0.34.0..HEAD` contains only ranking/spec/validation records, establishing runtime/dependency/test equivalence rather than conflating main with the release tag.
- Read the 0.33.0/0.34.0 release notes and current context, retention, cache-marker, lifecycle, task, tool-input, persistence, TUI API and CI code. The plan now preserves those releases' behavior through an explicit cross-feature matrix.

### Independent baseline probes executed in this revision

Ran a no-network `node --experimental-strip-types --input-type=module` probe importing the current real modules and Pi validator. All assertions confirmed the expected current defects/boundaries:

| Probe | Observed baseline result |
| --- | --- |
| Complete + skipped task list | `pending: 1`, `pendingTasks.length: 0`, and a false `blockCompletion` warning. |
| Exact #115 JSON, including `completion_summary: "…"` | Accepted by Pi 1.4 `validateToolArguments`; rejected by the registered `update_goal` executor, with no `isError` flag. |
| Flush ordering on that rejected call | An instrumented `flushGoalTransaction` hook was called once before rejection. This proves ordering, not the later dirty-buffer regression, which remains to be implemented. |
| Retention across appended conversation | Unchanged policy retains the preceding message prefix; a changed state block breaks it as currently designed. |

These are baseline observations, not passing-after bug-fix tests. No production or test implementation, full-suite rerun, paid provider trial or package publication occurred in this revision. The issue author's exact 4/10 prefix-break sequence and live cache percentages remain attributed reports; they have not been independently reproduced here.

### Corrections and strengthened decisions

- Plain storage snapshots are insufficient on their own: `GoalService.appendEvents` can append to the currently active turn buffer, and `flushTurn` uses its supplied storage context. The plan now requires original transaction/root ownership as well as session ownership, with dirty-buffer and project-switch regressions.
- Session generation must be invalidated before an awaited load. The current load increments focus revision after disk reads; late loads, progress callbacks, timers and `finally` blocks require guards before touching replacement state.
- Audit state must survive the Escape decision period after the controller is cleared. The plan distinguishes running/awaiting-choice/settling/settled, fences all callbacks, requires real pending-auditor tests and separates in-memory settlement from a durable ledger result.
- Overlapping audits of one persisted goal are an explicit race investigation. An in-memory token alone cannot be assumed to correlate cross-process ledger events. Resolve a demonstrated ambiguity through existing ownership/revision rules or a documented backward-compatible design before accepting the fix.
- The keyboard design now recognizes that Pi 1.4's `isOverlayFocused` is protected and that text accessors do not uniquely identify the main editor. A real TUI fixture must establish the usable ownership seam; native dialogs, foreign editors, non-capturing overlays and every configured action are covered.
- Cache comparison now uses ordered serialized model input plus system/tools/options, not whole JSON-envelope prefix matching. Raw-order hashes remain authoritative over normalized schema digests. Deterministic payload reuse is cache eligibility, not measured provider cache hits.
- Expanded the reset taxonomy to cover every existing retention branch, including absent observations, removed goal context, empty-history reanchoring, unsafe result anchors, identity loss and capacity/session eviction. Allowed labels cannot excuse extra reset counts.
- Required negative controls for the cache comparator and targeted broken-code variants for new bug tests. Added total/cumulative request overhead and at least two rollovers to optimization acceptance so growing context cannot masquerade as improved efficiency.
- Added a required #108 measured disposition, predeclared paired-trial method, cost/usage interpretation and a clean drop path for an inconclusive optimization. Stable schemas, prompt prefixes, cache identities and disabled-cache behavior remain protected.
- Added combined release regressions for provider filler + skipped tasks + audit, stale checkpoints, retries, strict/default scheduling, remapped controls/pause order, compaction and storage failures. Future fixes must extend the same contract matrix.
- Consolidated the full-suite command under the existing CI runner to avoid duplicate runs, added focused native Windows persistence evidence, and required installed-package tests to prove they load the tarball rather than the source checkout.

### Plan status and next work

The complete plan is ready for review; implementation remains unstarted. The existing spec-index entry remains `ready_for_review`, and the older untracked open-PR-disposition directory is preserved.

Validation of this revision: refreshed the open inventory once more and confirmed all issue update timestamps and all six PR heads were unchanged. Plan structure, all issue/PR source links, milestone A–G coverage, spec registration, edited-line whitespace and release/main runtime equivalence checks passed. Required future tests/commands are explicitly distinguished from completed baseline probes. No runtime, README, changelog or dependency file was edited.

When implementation starts:

1. Capture independent failing bug regressions and isolate the context harness with forced-overlap tests.
2. Freeze a 0.34.0 cache report and verify that its comparator rejects known bad captures.
3. Implement session/audit ownership and `update_goal` normalization, then complete the skipped-task and all-shortcut focus tracks; review each retained contributor hunk and run its cache/boundary gates.
4. Run the combined scenario matrix and investigate #108 with an explicit optimization keep/drop decision.
5. Validate the exact integrated candidate, then its installed package, with traceable source/artifact evidence before any release or issue/PR disposition is executed.

## 2026-10-27 — include context display with default off; require simpler code

The user explicitly brought `showContextUsage` into this stabilization campaign and clarified the desired default from on to **off** while planning was in progress. The current contract is `showContextUsage: false` by default; explicit `true` restores the existing line. This supersedes #112's deferral in all earlier entries above, its contributor default-on proposal and the initial default-on preference. Other feature work, including #96, remains deferred.

Updated `PRODUCT.md` first for each behavior change, then `TECH.md`, then this log. TECH now has Milestone F for context display, G for the conditional #108 optimization and H for integrated release validation. This remains a planning revision; no setting or runtime fix has been implemented.

### Evidence and decisions

- Reread #112's body and all eight changed-file patches through GitHub. Its head is still `1343fbaf6a600c294b23cf72b852a2885bd0bf96`. Its small use of existing settings and prompt-counter paths is suitable for independent review/adaptation, but the head is not accepted unchanged.
- The proposal's resolver and omitted-settings renderer both default on and need changing. It omits `effectiveSettingsReport`, lacks full global/project, persistence/reset and actual menu coverage, and tests “accounting unaffected” only by calling a formatter. The advanced-usage insertion also breaks the placement of the run-allowance explanation. The plan specifies the missing boundaries and excludes the README hunk.
- Required runtime scope is one boolean through existing settings/provenance/persistence/reporting/menu code and one condition in `goalPromptParts`. Reuse current mutation/refresh hooks. No new timer, listener, dependency, environment variable, cache, schema, scheduler heuristic or generic visibility framework is justified.
- Default/explicit false omits the fresh context line, including unavailable occupancy; explicit true reproduces the old counters. Preserve lifetime usage, run information, policy, accounting, budget enforcement, continuation and compaction.
- Toggling affects future snapshots. Existing retained observations remain historical under the current latest-snapshot wording; the setting is not retroactive redaction. A toggle must not purge retention, change policy memoization or rotate cache identity. The release comparison records the intentional default counter difference without normalizing it away or claiming cross-version identity beyond the changed line.
- Every fix must simplify its touched production path and remove the implementation it supersedes. The hunk ledger and final release review must identify consolidation/removal and justify added runtime mechanisms. Keep cleanup local, reuse existing test/capture infrastructure and remove temporary experimental modes. Meaningful tests may increase line count; smaller production complexity is the acceptance criterion.

### No-network baseline probe

Ran `node --experimental-strip-types --input-type=module` against the current real modules, with assertions for:

- current parser treats `showContextUsage` as unknown, and the current helper ignores explicit false;
- a synthetic fresh-counter fixture with only the context line omitted preserves the preceding message prefix in `LiveTailRetention`, appends exactly one counter snapshot and adds nothing on identical retry;
- the previously sent context line remains in a historical retained snapshot, while the latest snapshot omits it;
- starting with the hidden fixture injects no context line from this path.

All assertions passed. The omission was constructed in the probe as a fixture; it is not an implemented setting, a passing-after regression, registered-provider validation or measured cache-hit evidence. Full runtime suites and paid provider trials were not rerun for these document edits.

### Status

Implementation remains unstarted and the spec remains ready for review. The existing spec-index entry and historical open-PR-disposition directory are unchanged. Plan validation passed: default-off requirements and renderer contract agree; milestones A–H and all five issue/six PR links are present; #112 is included in every current disposition table; spec registration is unique; Markdown fences, conflict-marker and edited-line whitespace checks pass. No runtime, test, README, changelog or dependency file was changed. Future implementation must execute the settings, accounting, compaction, cache and installed-package gates now specified.

## Implementation — A: isolated captures and comparative cache gate

- Started `codex/post-release-stabilization` from `fe0e38f`; refreshed all open issues/PRs, with the same five issues and six PRs. No contributor head was merged.
- Replaced the shared capture root with invocation-owned temporary directories. Provider cross-checks inspect the live fixture before its owner cleans up; concurrent captures never mutate environment overrides.
- Added forced-overlap/failure cleanup regressions, exact-payload comparator negative controls and a pinned-release comparison using the same driver and SDK on both source trees. Reports are generated as CI artifacts, avoiding a large checked-in payload snapshot.
- Passed context gate (24 fixtures), provider cross-check (six actual SDK captures plus Responses compatibility), TypeScript, ESLint, four new harness/comparator checks and the cache gate (384 adapter scenarios; 1,000 retention transitions, 32 bounded rollovers). No network provider dispatch occurs.
- The first archive run could not identify its Git SHA because an extracted archive has no `.git`; fixed metadata handling and reran successfully. The gate assigns the verified pinned release SHA to the archived report.
- Runtime behavior and all contributor code remain untouched at this milestone. The capture/report modules reuse existing fixtures and adapters; no production cache abstraction was added.

## Implementation — B: session ownership and completion audit settlement

- Independently reproduced stale start/tree/shutdown cleanup failures, a real pending audit not aborted on shutdown, an unhandled auditor exception/timer, an older verdict masking a newer start, and two registered sessions attributing an older rejection to a newer audit.
- Updated PRODUCT then TECH for the demonstrated cross-session audit-ID requirement. New audit events carry an optional internal UUID; legacy ledger/checkpoints remain readable. Latest-attempt derivation and checkpoint reconstruction share matching rules and avoid repeated full-ledger scans.
- Replaced bare audit controller/abort flags and duplicated completion/skip branches with one attempt record and idempotent settlement. Original storage is captured before awaits, outcomes append durably outside unrelated turn buffers, and failed persistence is visible. Revision checks prevent approval from overwriting changed requirements; completion preserves current usage.
- Unified start/tree/shutdown cleanup, detached terminal handles before invoking them, invalidated pending operations before async loads, and fenced late progress, timers, modal answers and cache releases. Buffered turns pin their original storage; failed outgoing writes emit diagnostics before detachment.
- PR #109 runtime hunks were rewritten, rather than merged. Its reported behavior is credited; the new tests use genuinely pending audits and actual registered handlers.
- Passed focused lifecycle/transaction/session-safety regressions, 73 completion/settings/ledger/status/compaction checks, installed Pi session-safety workers (including stale reload and delegated sessions), TypeScript/ESLint and the 384-scenario release cache comparison with no payload delta.
- Added default/external-root project-switch tests, same-external-ID late callbacks/cache eviction, Escape-dialog replacement, changed-task approval rejection and real EISDIR ledger failure. Corrected the external-root fixture to include the required stored focus root; the production focus-isolation rule was preserved.
- Native Windows validation remains a release gate; local results are macOS/Pi 1.4 evidence, not a Windows claim.

## Implementation — C: classify update_goal before flushing

- Both independent registered regressions failed before the fix: the verbatim #115 object never reached the auditor, and structural conflicts returned no error flag (with the pre-validation flush still present).
- Added one pure typed planner in the existing tool-input module. It recognizes exact payload-free ready filler beside status, removes only blank optional input, names real field conflicts and preserves input objects. The executor now dispatches that plan after validation and before its existing flush; public schemas/descriptions/order are unchanged.
- Reimplemented #117's behavior from the contract. No contributor head or source-text assertion was adopted. Meaningful wait/lifecycle conflicts and malformed/payload-bearing ready objects remain errors.
- Passed action/planner matrices, dirty-buffer repair, strict/default actual scheduler assertions, real SDK argument validation, the existing tool-input worker and a new local Responses server. The latter sends the exact recorded arguments through Pi's installed tool path, runs the real nested independent auditor and archives in exactly two provider requests.
- Extended Responses schema capture to include update_goal in all three strict-compatibility modes. TypeScript, ESLint, provider cross-check and the 384-scenario cache comparison pass with zero payload/schema delta.

## Implementation — D: skipped tasks are terminal

- The independent flat-reference invariant and registered completion tests failed on the old counter: complete+skipped trees reported pending work and produced false task gates.
- Corrected the existing shared walker with `total - rawComplete - rawSkipped`; no second counting path or task-status change was introduced. This is the minimal correction identified in #110/#111, independently verified and credited.
- Added fixed-seed generated nested trees across both display and pending-collection modes, immutability and count-additivity checks, and real completion/auditor/prompt/deferred-archive positives and negatives. A pending child under a skipped parent still blocks; auditor rejection still blocks completion.
- Extended the local Responses regression to combine the exact filler object with complete+skipped blocking tasks and the real nested auditor. All 80 focused task/auditor/SDK checks and TypeScript pass; the cache gate still reports no unrelated payload delta.

## Implementation — E: keyboard focus ownership

- Registered real TUI dispatch tests failed before the fix because Goal consumed Escape/remapped pause instead of delivering them to foreign focused surfaces.
- Added one early listener guard and one narrow renderer query. Pi 1.4 exposes getFocusedComponent and publicly wires app.clear/onSubmit on its main CustomEditor, copying app wiring to replacements. This avoids private focus fields and does not mistake text accessors or non-capturing overlays for ownership.
- Reimplemented #116's boundary for all shortcuts; no per-action guard list or generic focus framework was added. Missing focus inspection preserves the embedding fallback.
- Passed 123 controls/widget/TUI checks, command-key and foreign-editor negatives, widget recreation and non-capturing-overlay positives. The installed Pi CLI walkthrough opens another extension's native dialog and capturing overlay, sends Escape/F6, verifies the goal stays active and proves F6 pauses after focus returns.
- TypeScript/ESLint and the release cache gate pass with no payload delta. Added the walkthrough to ordinary CI; fixed legacy component stubs through the documented unknown-focus fallback instead of weakening real TUI assertions.

## Implementation — F: context display off by default

- Independent regressions failed before implementation because the setting was unknown and default/false still rendered the context line.
- Added one boolean through existing parsing, resolution, sparse persistence, provenance, effective reporting and menu paths. Only explicit true renders context occupancy; the policy fragment/cache key, accounting and formatter remain unchanged. No refresh subsystem, timer or default-setting writes were added.
- Adapted #112's narrow settings/rendering idea with the requested false default, completed its missing diagnostics and boundary tests, corrected documentation placement and excluded its README hunk.
- Passed default/zero/unavailable occupancy and run-display matrices; opposite global/project overrides, invalid writes, saved false and inheritance; actual menu edits/reset of both scopes; registered usage/budget/compaction equality; and real SDK on/off/toggle/retry tests across four adapter shapes and three retention tiers. Hidden occupancy changes add no tail or payload difference.
- The cache comparison now includes explicit true/false controls: 408 adapter scenarios pass, with exactly 276 approved counter-block removals and byte-identical explicit-true controls. Raw provider blocks are retained and checked structurally; no line is normalized away from the report.
- The context size baseline changed only after verifying all 24 semantic rows and system/tool/child-request metrics were unchanged. Fourteen active counter fixtures each lose 30 content characters / 31 serialized characters (434 serialized characters total); estimates decrease by seven or eight tokens per affected fixture. The committed size baseline records that approved default change. Context gate, TypeScript/ESLint and focused integration checks pass.

## Implementation review — bounded audit index correction

- A broader regression exposed a remaining lifecycle bug: after 20 task events, the 12-event runtime index lost the newest audit start and resurrected an older verdict. The new test failed independently, including the cache-reload path.
- The existing bounded index now pins the newest start, its matching current outcome and the last settled result needed for historical rejection context. Indexing, reconstruction and readers share the same attempt-matching predicate. Reloaded duplicate event objects are removed from the bounded view without scanning the full ledger.
- Derived checkpoint format advances from 3 to 4 and rebuilds once from the unchanged authoritative JSONL. This necessary local-cache refresh does not clear provider retention or migrate goal files/ledger records. Focused checkpoint/lifecycle tests pass, including a completed long audit followed by another session's late outcome.
- Also fenced before-provider callbacks whose session manager is no longer the owner, preserving the context/provider pairing across sessions.

## Implementation — G: measured cache disposition

- Independently reproduced #108's exact deterministic shape: task setup plus three completions cause four prefix breaks in ten follow-up requests; ordinary work transitions preserve the prefix.
- The composed state changes active task instructions and completion gates, so an append-only facts redesign is not accepted for this patch. No speculative optimization, alternate production mode or stale instruction path ships. Live-provider trials are not claimed; they are conditional on adopting that redesign.
- Added the measured transition/cost trace to the shared release report, with reset-classification, lost-reuse and redundant-counter negative controls. The 1,000-transition bounded corpus now includes large text and image content.
- An 80-request occupancy-only control appends 79 counters and hits two ordinary capacity resets when visible (328,188 cumulative request bytes). With visibility off it appends zero counters, causes zero resets and sends 155,280 cumulative bytes. These synthetic byte measurements are not provider token prices or measured cache-hit percentages.
- Release comparison still requires stable system/tools/options and exact approved counter deltas; explicit true remains the old-output control. Dependency fingerprints ensure baseline/candidate use the same locked dependencies, allowing only release-version metadata to differ.

## Implementation — H: release candidate and integrated validation

Prepared package/lock metadata for 0.34.1 and consolidated user-facing changes in Unreleased. README and the historical untracked spec remain untouched. Added an installed-tarball gate that installs pinned peers into an isolated project, proves the extension is not linked/imported from the checkout, repeats lifecycle/input/task/focus/context regressions and runs the real Responses/auditor archival path. CI keeps successful cache/package evidence and adds focused native Windows sharing/persistence/session tests on Node 22.19/Pi 1.4; publication validation now includes the cache gate.

### Contributor hunk disposition at integration

All reviewed source heads are pinned in TECH §1.4. No source PR head was merged or cherry-picked.

| Source | File/hunk disposition | Replacement and independent boundary |
| --- | --- | --- |
| #109 | Rewrite completion/state/events/readers; replace surrogate controller and incomplete reader tests. No unchanged runtime hunk retained. | `1a49f52`, `e089dff`; real pending audit, project/root ownership, modal/timer races, bounded-index/checkpoint reload and installed Pi workers. |
| #111 | Keep the independently verified counting expression only; replace/extend contributor tests and changelog fragment. | `0bc8acc`; flat-reference nested invariants, real completion/auditor/prompt/archive and combined Responses call. |
| #112 | Adapt existing boolean settings/rendering pattern, rewrite default/render condition, reporting/docs and tests; reject README hunk. | `3e43a76`; both scopes/save/reset/provenance, actual menu, usage/budget/compaction and four real adapter shapes/three cache tiers. |
| #116 | Rewrite the three-action/private-overlay boundary as one early guard using public Pi app/focus wiring; replace mock-focus tests. | `eddef67`; real TUI delivery, non-capturing overlay, foreign text accessors and installed CLI native/custom dialog walkthrough. |
| #117 | Rewrite planner/executor integration before flush, explicit error result and actual boundary tests; schema unchanged. | `5acd25f`; dirty transaction, immutable input/conflicts, real SDK validation and local Responses server with the real nested auditor. |
| #96 | Reject every feature hunk from this campaign. | Deferred; no command/message-delivery feature enters 0.34.1. |

Each runtime track reuses an existing boundary and removes superseded logic. There is no extra cache/visibility/session framework or new production dependency. Audit identity and the bounded index fields are required by failing cross-session/long-history regressions; the task correction and focus guard remain local. Baseline/candidate cache gates have passed after each track; final CI, package, benchmark and deliberate broken-variant results are recorded below as they complete.

### Integrated corrections and test-quality evidence

The first combined run found 14 failures: a real draft-profile restoration regression, a stale-host probe that unnecessarily required an idle API on narrow embeddings, four new tests importing full SDK surfaces through the fast unit adapters, and assertions/fixtures written for the superseded interruption and filler contracts. The next run reduced this to two golden-context fixtures that incorrectly replaced the session-manager identity between startup and context delivery. Corrected those fixtures to model Pi's stable manager, preserved their actual stale-checkpoint assertions, and added unknown-old-manager and unseen-stale-shutdown negatives. No failing behavioral requirement was removed.

Draft rehydration now makes the single authoritative profile decision from the incoming branch. It preserves an unconfirmed draft when returning to its saved branch, drops another branch's in-memory draft without tombstoning its saved entry, and retains questionnaire echo only for the same saved draft. This replaces the overlapping startup/profile and memory-draft branches. A dedicated navigation regression covers rejection on the wrong branch and successful confirmation after returning.

Separated pure cache comparison from SDK payload capture and moved SDK-bound isolation checks into the existing child-process worker pattern. This keeps the fast test adapters small. Removed the obsolete source-text completion-routing assertion; registered executor/auditor and actual Responses tests cover that behavior. The package gate installs the actual tarball and pinned peers, then copies the installed bytes outside node_modules because native Node refuses TypeScript stripping within that directory. It verifies both paths, uses no checkout runtime imports, retains logs/digest, and includes real adapter marker/visibility smoke.

- TypeScript, ESLint and all 11 workflow/runner checks pass. Production dependency audit reports zero vulnerabilities; package dry-run passes.
- The 105-row baseline/candidate non-agent benchmark uses the same installed dependencies and corrected B10 fixture. The regression gate passes. Generated measurement artifacts were preserved outside the checkout rather than overwriting an older spec's committed results.
- The fixed seed `0x113115` exercises 120 registered lifecycle transitions: project switching/reload, actual pending audits, failure/abort/late result, focus replacement, pause/resume, buffered task writes, invalid input and idempotent context retries. Every transition checks goal ownership, at-most-one durable audit outcome, mandatory settlement of retired attempts and resource cleanup. Failure includes its seed and trace.
- Nine temporary broken-source variants fail at behavioral assertions: old skipped-count formula, flush before classification, missing focus guard, unguarded late audit progress, omitted-settings default on, resolver default on, lost persisted false, retention cleared on refresh, and unseen stale shutdown retiring its live replacement. Copies are deleted afterwards; evidence is in `goal-mutation-evidence-bmr89jlt` under the local temporary directory.
- Serialized-payload negative controls independently reject changed early system/history/schema content and removed/relocated explicit markers. The actual 408-scenario comparison still allows exactly 276 requested counter deltas, with explicit-true controls unchanged and 1,000 bounded transitions.

### Executable regression contract matrix

| Item | Reproducer / generalized invariant | Negative and real boundary | Cache / ordinary gate |
| --- | --- | --- | --- |
| #113 / #109 | `goal-stabilization-lifecycle`: pending shutdown, cross-project writes, same external IDs, overlapping and long audit attempts, newest unfinished reader; fixed-seed trace | Unexpected teardown throw, EISDIR persistence, external revision, late progress/dialog/shutdown; installed Pi reload/session workers | Exact owner leases and retry identity; full suite, lifecycle CLI, Windows persistence |
| #115 / #117 | `goal-update-goal`: exact recorded filler, pure action matrix, immutable input and dirty-buffer repair | Meaningful wait/field conflicts, strict/default scheduler; local Responses tool call and real independent auditor | Unchanged public schemas/options; provider/schema capture, full suite |
| #110 / #111 | `goal-task-count`: 300 fixed-seed nested trees against independent flat traversal | Pending child, rejecting auditor, evidence/contract gates; combined actual Responses audit and archival | Existing reset classification; full suite and packed artifact |
| #114 / #116 | `goal-keyboard-focus`: actual TUI dispatch for every Goal shortcut | Foreign text accessors, non-capturing overlay, widget recreation; installed Pi native/custom dialog walkthrough | No provider payload change; controls CLI and full suite |
| #112 | `goal-context-usage` / layered settings: default/true/false, both scopes, sparse false, inheritance, actual menu | Registered accounting/budget/compaction equality; four real adapter shapes × three retention tiers, toggles/retries/hidden occupancy | Exact default-line removal only, no toggle reset; cache comparison and packed artifact |
| #108 | Four state/task breaks in ten requests reproduced; bounded 1,000-transition corpus | Removed markers/early-content changes rejected; no speculative facts redesign adopted | 408 serialized scenarios, measured counter overhead and same-machine benchmark |
| Capture isolation | Two concurrent captures retain distinct settings/goals | Failure cleanup cannot remove a sibling at its read barrier; real SDK worker | Context/provider gates may run concurrently; mandatory full-suite entry |

Final exact-commit Linux/minimum-Node and native Windows CI, refreshed full-suite/package evidence, and publication status follow below. No release/tag/issue disposition is claimed by these local results.

### Final review: disabled replacement must retire the running auditor

Review of the skip path found that a second valid completion after disabling the auditor could leave the previous nested auditor/controller and animation running. The independent registered regression failed because the original signal was not aborted. Moved the existing replacement-cancellation call ahead of the skip decision; no new state or branch was needed. The test now proves the prior attempt settles once, the disabled attempt settles once, the goal completes, resources clear, and a late approval cannot add another outcome.

Before this correction, exact source commit `95179d8` passed all 1,257 local tests with zero skips, both installed Pi CLI suites, the expanded packed-artifact smoke, context/provider/cache gates and native Windows CI. Those results are supporting evidence only; the corrected commit must pass the integrated checks again. PR #118 contains the integration branch and its required Linux/Windows validation.

### Combined boundary matrix completion

Expanded the real TUI dispatch test to all three foreign surfaces during ordinary work, a genuinely pending audit, a scheduler wait and provider-recovery delay, across together/goal-first/turn-first pause orders (36 cases). Each verifies unchanged goal/file/ledger, controller/progress/timer, interrupt/debug state and command dispatch; recovery remains scheduled. Main-editor pause works afterwards, including the two-step turn-first behavior and non-capturing overlays. Context toggles now also run during an actual audit and scheduler wait, preserving their controller/timer/state and the exact retained prefix. These additions pass without production changes and are repeated by the packed-artifact gate.

### Final review: stop retired startup dialogs before the next UI step

A barrier-driven regression found one remaining startup interleaving: an old multi-goal resume selector could return after replacement and open its next confirmation for the replacement's paused goal. The test failed at the unexpected-confirmation assertion. One owner check after the selector now ends that retired startup before another dialog can open. No new state or abstraction was added; the replacement stays paused with its modal depth unchanged. Focused lifecycle, type and lint gates pass. The preceding commit passed all 1,293 tests with zero skips, both installed CLI suites and the expanded packed-artifact smoke; final integrated CI is refreshed for this guard.

### Command-shortcut ownership correction

A delayed command-shortcut input also survived session replacement: its answered path could invoke the command against replacement state, and its cancel/error paths decremented a replacement modal. All three registered regressions failed independently. Shortcut dispatch now checks the existing focus revision, while cleanup and error notifications check the existing session-owner identity. The core shares that same owner record with the input listener; no second generation counter or new abstraction is introduced. A positive regression proves a legitimate command that changes focus still releases its own modal. Type/lint and focused lifecycle/control tests pass. The exact tarball publication gate also passed locally against the downloaded CI artifact; CI run 40531410780 passed before this runtime correction and must now be refreshed.

## Verified implementation and release candidate

Final production code is `584a469152bae62ca1fae59a158e12f75011a3c3`, on `codex/post-release-stabilization`, [PR #118](https://github.com/tmonk/pi-goal-x/pull/118). [CI run 40532597453](https://github.com/tmonk/pi-goal-x/actions/runs/40532597453) passed both jobs on 2026-10-27. GitHub tested merge commit `da0c9bb722bea3a23a2b7bdcd4256d3ef7471614` combining that head with unchanged main `fe0e38f`; local source checks use the branch head. No source PR head was accepted unchanged, and the five issues/six source PRs were rechecked without new pushes or scope changes.

| Gate | Verified result |
| --- | --- |
| Full source suite / manifest | 1,298 passed, zero failures/skips; 87 unit + 1 integration + 9 e2e entry files |
| Minimum runtime / host | Linux Node 22.19.0, Pi 1.4.0; type/lint, 12 workflow/runner tests after the final publication-gate addition |
| Native Windows | 35 sharing/persistence/session/transaction tests passed, zero skips, Node 22.19.0 |
| Installed Pi workflows | All 11 terminal-control cases and the three-request draft/execution/independent-audit/archive lifecycle passed |
| Packed artifact | 133 source-independent runtime/TUI/adapter tests, zero skips, plus the real two-request Responses/auditor archival worker |
| Context / provider | All 24 semantic fixtures and six outgoing real-SDK request shapes passed, including three Responses schema-compatibility modes |
| Release cache comparison | 408 adapter scenarios, exactly 276 requested counter-block removals; explicit true, immutable prefixes/tools/options and markers preserved; 1,000 bounded transitions |
| Benchmark | Same-runner baseline/candidate, 105 rows, no regressions; existing cache read/rebuild and cold-start invariants passed |
| Dependency/package checks | Production audit: zero vulnerabilities; pack dry-run passed; no production dependency added |
| Test quality | Nine deliberately broken variants caught at behavioral assertions; payload controls reject missing/moved markers and early-content/schema edits |

Local macOS Node 26.10 repeats the full suite, CLI/package/context/provider/cache and retention gates; those results are kept distinct from minimum-Node Linux and native Windows evidence. No paid live-provider hit rate or optimization is claimed. The default-off occupancy control eliminates counter-only snapshots/resets; #108's instruction-bearing task updates retain their existing safe resets.

### Artifact traceability

The Linux CI tarball for 0.34.1 has SHA-256 `67a4f6cd8325c533f49b1766ce08836f5dd293e82be60206047bb01f725682ec` and integrity `sha512-Neme4bSR2nxsKfkH4Yia9ht6C88LPbYRU0NSsBGVngRJwzX3yqQ3Opm9yV+PP9H8cUfhkU5JwHcGAJJ++SZbuA==`. CI retains its package, installation log, runtime/Responses tests, cache reports/comparison and control traces. Downloaded copies are under `/tmp/pi-goal-ci-evidence-40532597453`; local packed/runtime and mutation evidence lives in the invocation-owned temporary directories identified by the gate output. These temporary paths are supporting evidence; the linked CI run is the review reference.

The local archive SHA-256 is `aa4bd6c2a10f90c8bc2f836b98266ea210801f063323d199d970cde7b1d30178`. Comparing the archives found identical file sets, file-content hashes, modes, uid/gid and mtimes; compressed archive identity differs. Publication therefore runs the same expanded regression smoke against its already-packed `TARBALL`, after applying release ranking and before upload/publish. The smoke accepts an explicit tarball without repacking, records its own digest, and installs/executes those exact bytes. A workflow ordering/binding guard complements the actual installed-tarball execution. Trusted publishing still packs once and publishes that tested file; any new runtime/package change must rerun the gates.

### Maintenance effect and remaining release operations

The production diff touches 19 existing files: 533 added lines and 591 removed, a net removal of 58 lines. This is supporting evidence, not a line-count acceptance target. Completion has one commit path and one attempt-scoped finalizer; session events share teardown; drafting has one authoritative rehydration/profile decision; every shortcut shares one focus guard and delayed command inputs share the existing session owner; task counting remains one walker; context visibility remains one existing-path boolean. Audit identity and bounded index fields are justified by cross-session and long-history failing regressions. No alternate retention mode, visibility subsystem, framework or production dependency ships.

Implementation completion criteria are satisfied and the spec is ready for review. Main, published npm versions, release tags and the original issue/PR states have not been changed. Merge/release approval, trusted-publication rehearsal, tagging/publication, registry-artifact verification and subsequent issue/superseded-PR disposition remain release operations. Keep #108 open unless a separately proven optimization ships; keep #96 deferred. Do not call this an already published or registry-verified release.

The final publication-input mode also installs and passes against the downloaded final CI tarball without repacking; its report must retain the exact CI digest above. The final documentation-only commit changes no production/package bytes. Required CI on that commit may use the existing prose-only exemption; the complete runtime evidence is pinned to the source and merge commits above.

### Final-repeat harness races (CI run 40533318279)

The documentation-only repeat passed all 1,298 runtime tests and the real lifecycle, but caught two intermittent harness failures. The controls settings cases read missing persisted values while their final save interaction was still open in the captured terminal. The native Windows test timed out before its external helper announced readiness; its first startup included compiling embedded C# with Add-Type, while later startups succeeded.

The terminal bridge now acknowledges delivery of each tagged action; human-paced input waits for that acknowledgement before its existing delay. Settings mutations wait for their actual persisted values before asserting or advancing. The former assertions are preserved; no wait bound was increased. Final settings snapshots are retained with the terminal evidence. The Windows holder uses System.IO.File.Open directly in PowerShell, retaining the same real deny-delete sharing mode, ready/release barrier, startup bound, native-failure count and preservation/cleanup assertions while removing runtime C# compilation. These are test-driver changes only; production/package bytes remain those of 584a469. Added a temporary 250ms transport-delay experiment for both affected actual CLI cases to validate delivery/persistence barriers under slow input; its outcome and refreshed CI follow below. The preceding green run remains supporting evidence, not acceptance of the failed repeat.

The 250ms delayed-transport experiment passed both affected actual Pi cases. Reintroducing the original timing-only driver under the identical delay made those cases fail, confirming that the new delivery/persistence barriers address the observed failure class. Both temporary source trees were removed, and evidence remains in `goal-pty-delayed-evidence-d4nliinv` and `goal-pty-old-evidence-*` under the local temporary directory. The normal 11-case walkthrough also passed locally with the new barriers.

[CI run 40534580680](https://github.com/tmonk/pi-goal-x/actions/runs/40534580680) then passed both Linux and native Windows jobs on integration commit `b5837ceaceaf03938fdd57736cb3ef2b62ba45b2`. This refresh includes the full 1,298-test suite, 133 packed-artifact tests, actual Pi terminal/lifecycle workflows, provider/cache checks and 105-row benchmark, with no skipped required tests. Native Windows sharing checks passed with the direct PowerShell lock holder and unchanged time bounds. The failed repeat remains documented; no runtime assertion or platform gate was removed or weakened. The spec is ready for review again. Production bytes remain those of 584a469; merge/publication and issue/PR closure remain pending release operations.


## Final CI and contributor cleanup

The user requested a plain-language PR description, explicit contributor credit, individual issue/PR closure comments and simpler, faster CI without Windows. PRODUCT.md was updated first, then TECH.md. This direction supersedes the earlier native Windows release requirement; the previous successes and harness failure remain historical evidence.

Removed the Windows job, runner mode and native PowerShell test harness. Kept the existing platform-independent persistence/error tests. Moved installed-package, context, provider, cache and retention checks into the existing two-worker runner alongside the full suite and actual Pi walkthroughs. Each keeps its log and package/cache evidence in the same run directory; benchmarks still run sequentially afterwards to avoid competing load. Removed the redundant package dry run because the installed-package check already packs and installs the artifact. Kept minimum Node/Pi, lockfile-keyed npm caching, safe change detection, dependency audit and exact-publication-tarball validation. Renamed the always-retained artifact from `validation-failure` to `validation`.

The PR will credit @adlternative (#109), @Nyarlathoteppppp (#111), @Has-X (#112) and @expoli (#116/#117) for their specific contributions. Superseded PRs and the four fixed reports will be closed only after the revised checks pass, with comments pointing to #118 and the relevant tests and explaining that merge/release is pending. #108 remains open for the unproven cache design change; #96 remains deferred feature work. Validation and actual closure results follow below.

Local validation of the revised runner passed on macOS/Node 26.10/Pi 1.4: all eight checks completed in 77.1 seconds, including 1,298 source tests in 97 files with zero skips, all eleven Pi controls cases, the three-request draft/execution/audit lifecycle, 133 installed-package tests, 24 context fixtures, nine real adapter payload checks, 408 release cache scenarios, 276 exact approved context-line removals, 1,000 bounded transitions and retention measurements. Type checking, lint, twelve workflow/runner tests, five ranking tests, dependency audit and diff whitespace checks also passed. Evidence: `/var/folders/2_/4klqy60x2rb_vpg4whtr27f40000gn/T/pi-goal-ci-ruP5Qq`. Required Linux/minimum-Node validation and benchmark results are recorded in [PR #118's checks](https://github.com/tmonk/pi-goal-x/pull/118/checks); local results do not substitute for that run. No production file or dependency changed in this cleanup.

Disposition comments will use immutable links to the tested commit's regression files. Their issue/PR timelines record the actual closures, independently of the pending 0.34.1 merge and publication. The PR description records the final CI run and contributor credit.


## GitHub co-author attribution

The user clarified that PR-description mentions are insufficient: the contributors must receive GitHub's commit attribution. Verified each name/email against the GitHub-associated author of the original PR commit. Added `Co-authored-by` to the five corresponding fix commits for @adlternative, @Nyarlathoteppppp, @Has-X and @expoli. This credits the retained or adapted contributions without changing the recorded keep/rewrite decisions or importing any source PR head.

| Source PR | Contributor | Original fix commit | Commit with attribution |
| --- | --- | --- | --- |
| #109 | @adlternative | `1a49f52` | `946906d` |
| #117 | @expoli | `5acd25f` | `1561434` |
| #111 | @Nyarlathoteppppp | `0bc8acc` | `eb72b0a` |
| #116 | @expoli | `eddef67` | `084ec43` |
| #112 | @Has-X | `3e43a76` | `d2d7024` |

All 19 existing commit trees were checked byte for byte during the metadata rewrite; their authors, committers, timestamps and file contents were preserved. The previous head `3ff6537` is retained under a local recovery ref. Only PRODUCT.md, TECH.md and this attribution record change after the rewrite. The runtime and cache code are identical to the successful Linux validation in [CI run 40537519838](https://github.com/tmonk/pi-goal-x/actions/runs/40537519838). GitHub's PR commit-author records will verify the four account associations after the guarded push; the final PR checks track the updated head.

The previous cleanup is complete: PRs #109/#111/#112/#116/#117 and issues #110/#113/#114/#115 were closed with individual thanks, immutable fix/test links and a clear statement that merge/release is pending. #108 remains open and #96 remains deferred.

## Approved patch release

The user authorized merging #118 to main and publishing a patch release. GitHub confirms @adlternative, @Nyarlathoteppppp, @Has-X and @expoli as co-authors on the five corresponding fix commits. [CI run 40539398945](https://github.com/tmonk/pi-goal-x/actions/runs/40539398945) passed on `8fb11cb7a89543e290099277006e1b3b74ee0b30`; every rewritten implementation tree is identical to its previously tested tree.

Release preflight found npm `latest` at 0.34.0, no published 0.34.1, no `v0.34.1` tag, matching package/lock metadata at 0.34.1, and #118 mergeable against unchanged main `fe0e38f`. Finalized the changelog date and release heading. The existing workflow will publish from the tested main tag, preserve automated ranking badge updates, smoke-test its exact tarball and verify registry integrity. Merge, tag, workflow and installed-registry verification results follow as they complete.

### 0.34.1 merged, published and verified

[Final PR CI](https://github.com/tmonk/pi-goal-x/actions/runs/40540656693) passed on `49675e4`. #118 merged with a merge commit, `27d9facf49e66ee677770a74e26198a8bdcada8a`, preserving all five co-authored fixes and GitHub's association with @adlternative, @Nyarlathoteppppp, @Has-X and @expoli. [Main CI](https://github.com/tmonk/pi-goal-x/actions/runs/40541211633) then passed on that exact merge commit. The signed annotated `v0.34.1` tag points to it.

[Publication run 40541749002](https://github.com/tmonk/pi-goal-x/actions/runs/40541749002) succeeded on its first attempt: ranking, source validation, 1,298 tests, provider/context/cache gates, production audit, exact-tarball 133-test smoke, trusted npm publication with provenance, registry verification and GitHub release creation. Registry metadata took about three minutes to appear; the existing verification polls completed without another publish. Automated ranking commit `9d53f44` updated only the README ranking badges/text and ranking assets.

Downloaded the workflow artifact through the GitHub connector and checked its ZIP SHA-256 against GitHub's artifact metadata. Independently downloaded npm's 0.34.1 tarball and the GitHub release asset: both match the tested workflow tarball byte for byte. Registry version and `latest` are both 0.34.1. The registry download passed all 133 installed-package tests with zero failures/skips and the real Responses/auditor completion-and-archival smoke on local Node 26.10/Pi 1.4. Publication used Node 24; minimum-runtime validation used Node 22.19. No paid live-provider cache-hit claim is made.

| Release evidence | Value |
| --- | --- |
| Source/tag commit | `27d9facf49e66ee677770a74e26198a8bdcada8a` |
| Tarball SHA-256 | `1e46fc3245e9dd4e7e26b67fe9a065f6c33bf0764c43f674a88011b138e215f4` |
| npm SHA-1 | `bdf3915bdbb0cb238c3e23322c07825dbb82f6ff` |
| npm integrity | `sha512-uWtllp3/WjNBbb6YqPduiEsr2K6FGewTty4C94j7yjpvOcKKI4tuJobee2dF5TY8gXvQsLGyKR38sd1WA3TkJQ==` |
| Publication artifact | `12750044097` (`npm-v0.34.1-1`); ZIP SHA-256 `103a04b8a1d7cf4c1f906a813691a9f2142aa7a6e8d6b65df0d13076c8340f85` |
| Registry receipt artifact | `12751745539` (`registry-v0.34.1-1`) |
| Local evidence | `/tmp/pi-goal-release-0.34.1.ddmj6w/verification.json`, `workflow/`, `registry-smoke/` |

Updated the GitHub release notes with the fixes, default-off context display and contributor credit. The implementation and release are complete. #108 remains open for the unproven cache design change; #96 remains deferred. This final record changes spec documents only and does not change the released package.
