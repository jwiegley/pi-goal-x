# Post-release bug stabilization

Status: completed; 0.34.1 published and verified

Release: 0.34.1, bug fixes first

Planning baseline: `fe0e38f` (0.34.0 main)

Rechecked on 2026-10-27 against all five open issues and six source PRs. The released `v0.34.0` tag points to `8f0c28b`; its runtime, dependencies and tests are identical to `fe0e38f`. [PR #118](https://github.com/tmonk/pi-goal-x/pull/118) merged as `27d9fac`, and [0.34.1](https://github.com/tmonk/pi-goal-x/releases/tag/v0.34.1) is published and verified as npm's `latest`. `MILESTONES.md` records the fixes, review decisions and exact artifact evidence. Windows CI and its native harness were removed, superseding the earlier platform requirement. The older open-PR disposition document is historical.

The merge preserved the verified GitHub co-author commits. The signed release tag points to the tested main commit. The trusted-publishing workflow passed, and the npm download, GitHub release asset and tested workflow tarball match byte for byte. The registry download also passed the installed-package regressions.

## Why this work comes first

Versions 0.33.0 and 0.34.0 changed the Pi integration, configurable controls, continuation scheduling, context transforms, stale-checkpoint handling and tool-input compatibility. The current open reports concentrate on the boundaries between those systems: session replacement, completion-audit interruption, provider-filled tool arguments, skipped-task completion and terminal input owned by another extension.

The goal of this campaign is to restore correctness, preserve or improve prompt-cache reuse, and make the regressions hard to reintroduce. The user's latest follow-up explicitly includes the `showContextUsage` correction from PR #112, disabled by default. That narrow display preference joins the fixes; other new feature work remains deferred until the patch release is verified. Each release must simplify the touched code: reuse existing paths, remove superseded logic and avoid adding machinery beyond what the behavior requires.

## Scope and disposition

| Track | Open items | Product disposition |
| --- | --- | --- |
| Session replacement and interrupted audits | Issue #113, PR #109 | Fix together. Session teardown must be stale-safe, and an audit must be cancelled, settled and attributed to the goal it actually reviewed exactly once. PR #109 is useful input but is not complete enough to merge unchanged. |
| Tolerant `update_goal` input | Issue #115, PR #117 | Fix with narrow filler normalization, explicit conflict errors and real SDK/provider-boundary coverage. |
| Skipped tasks and completion | Issue #110, PR #111 | Adopt the counting correction and extend it through completion, prompt and auditor integration tests. |
| Foreign keyboard ownership | Issue #114, PR #116 | Fix across every goal shortcut, not only default Escape, and verify against real Pi 1.4 focus behavior. |
| Context-usage visibility | PR #112, explicitly requested follow-up | Include `showContextUsage`, default `false`, through the existing settings and prompt-counter paths. Adapt the PR's default-on proposal and complete its persistence, diagnostics, accounting and cache tests before accepting it. |
| Context-test workspace isolation | Found during this audit | Fix the shared temporary-directory collision so concurrently run release gates cannot produce false drift or tool-profile failures. |
| Prompt-cache efficiency and safety | Issue #108 plus every bug-fix track | Establish a byte-level 0.34.0 baseline, forbid avoidable prefix invalidation, and investigate fact-only state updates. Change retention behavior only when both semantic safety and improved reuse are proven. |

Every open item has been classified. Issue #108 is now part of the campaign as a cache-safety and performance requirement, not as permission to merge its experimental design. The current reset protects against stale instruction-bearing state; any narrower invalidation policy must first prove that objective, lifecycle, scheduling and task instructions cannot survive after cancellation or replacement.

The following remain explicitly outside this bug-fix campaign:

- PR #96 adds trailing text to `/goal-resume`. It is feature work and is behind/conflicting with current main; leave it unmerged during stabilization.

The requested inclusion of #112 supersedes its earlier deferral in this spec's implementation log. It does not authorize an unchanged merge of that PR or reopen the rest of the feature backlog.

## Required behavior

### Session and audit lifecycle

- Replacing, reloading, forking or switching a session must not emit a stale-`ExtensionContext` error from pi-goal-x.
- Local teardown must always complete even if the outgoing context is already stale: unsubscribe terminal input and event listeners; cancel scheduler, continuation, retry and display timers; abort a nested completion auditor; clear queued audit messages, accounting and widget references; and release only the exact cache-retention leases owned by the outgoing session.
- Only the exact Pi stale-context error is recoverable. Unexpected failures must remain observable after the remaining cleanup steps have run.
- An in-flight audit is bound to the goal captured when the audit began, not whatever goal is focused later.
- Session replacement invalidates the outgoing generation before asynchronous loading or dialogs. Late progress, timers, dialog answers and `finally` blocks cannot change replacement-session state, stop its audit animation, consume its modal ownership or flush its transaction.
- Restore an unconfirmed draft and its tool profile from the incoming session branch. An outgoing in-memory draft must not leak into a different branch or project; returning to its branch restores its saved draft.
- Buffered writes and audit settlement retain their original goal, storage root and transaction owner. A project switch must never persist outgoing work into the incoming project's storage. Pending writes either finish against their original owner or produce an explicit persistence diagnostic.
- Normal result, auditor exception, user abort, focus change and session shutdown must each produce at most one terminal audit outcome. A late auditor callback after shutdown must not write a second outcome or complete a replacement goal.
- Successful storage produces one outcome; a failed ledger write is reported, and a hard kill can leave an honest “no recorded result.” In-memory settlement must not be presented as proof of a durable write. Existing optimistic-write protection and task/verification requirements remain enforced when completion commits.
- If a process dies before an outcome can be written, status/history must say that the latest audit has no recorded result. An older verdict must never hide a newer unfinished audit.
- Persisted goal and ledger formats remain readable. Do not require a migration for existing goals or historical audit events.
- Overlapping audits of the same persisted goal must be correlated by an optional audit-attempt ID on new ledger events. The registered two-session reproducer demonstrated that an older result otherwise masquerades as the latest attempt's outcome. Legacy records without IDs retain chronological interpretation; the ID is internal and never changes provider prompts, schemas or cache keys.

### `update_goal` inputs

- Whitespace-only optional strings and an empty `attempted_actions` array are absent values.
- When a lifecycle `status` is present, a payload-free `{ "kind": "ready" }` continuation produced as filler is ignored.
- A standalone `ready` continuation remains a real scheduling decision.
- A lifecycle status combined with a real wait, or any action combined with meaningful fields belonging to another action, is rejected without changing goal or scheduler state.
- Structural conflicts return a tool error (`isError: true`) that names the conflicting fields, while keeping the turn alive so the model can repair the call.
- Rejection is decided before flushing even an already dirty turn transaction. It preserves buffered work, disk bytes, ledger, scheduling and retained prompt state; later valid calls can still flush and complete that work.
- The exact argument object recorded in issue #115 must reach the normal completion flow through the real SDK argument validator and the OpenAI Responses adapter shape.
- Invalid types, unsupported values and payload-bearing `ready` objects remain invalid. Normalization does not change the public schema or claim to repair upstream provider schema conversion.

### Task completion

- `pending` means neither complete nor skipped. This definition does not change when callers ask to fold skipped tasks into a display-only done count.
- A nested `blockCompletion` tree containing only complete and skipped nodes can enter the completion auditor.
- Any genuinely pending or in-progress node still blocks completion.
- Skipped work stays visibly distinct from completed work in counts, prompts and status output.
- Correct counting does not weaken skip authorization, task evidence, verification contracts, auditor approval or deferred archival.

### Keyboard ownership

- A focused Pi dialog or another extension's focus-capturing overlay owns every key. Goal pause, host-interrupt bookkeeping, auditor controls, dashboard controls, command shortcuts and debug shortcuts must do nothing until the main editor regains focus.
- A non-capturing overlay that leaves the main editor focused must not disable goal controls.
- Goal-owned modal behavior and the configured pause order remain unchanged.
- If an embedding does not expose enough TUI focus information, retain current controls rather than silently disabling pause.

### Context-usage visibility

- `showContextUsage` defaults to `false`, including existing installations with no explicit value and prompt helpers called with omitted settings. Explicit `true` restores the 0.34.0 context line byte for byte. No migration or default-setting write is required; preserve any explicit saved preference.
- Default/explicit `false` omits only the `Context snapshot` line from newly generated goal prompt counters, including its unavailable form. It leaves lifetime usage, budgets, run information and policy text intact, with no replacement notice or added blank line. This is the sole intentional default prompt delta for this track.
- Use the existing global/project boolean settings, provenance, persistence, reset-to-inherited behavior, `/goal-settings` row and effective-settings report. Explicit `false` must survive save/reload; project values override global values. Invalid values follow the existing diagnostic/rejection rules.
- The change is presentation-only. Context measurement, usage accounting, budget enforcement, continuation decisions, compaction and UI diagnostics keep their existing behavior. Removing this model-visible cue addresses the concern in #112 without adding a pause heuristic; it does not guarantee how a model will respond.
- Apply a change on the next ordinary prompt construction. Do not restart the goal, initiate a provider request, reset scheduling or rewrite conversation history merely to refresh a display preference.
- Preserve stable prompts, tool schemas, provider cache keys and prompt-policy memoization. A toggle changes only the new counter snapshot; it must not clear retention. Previously sent snapshots remain historical until ordinary retention/compaction removes them. This setting controls new display output, not retroactive redaction or deletion of the underlying accounting fact. Starting with `false` emits no context line from this path.
- Test default/true/false, precedence and persistence, actual settings interaction, registered context/provider composition, unchanged accounting and compaction, retries and both toggle directions. Existing latest-snapshot wording remains sufficient; do not add a new prompt policy or retention subsystem for this setting.

### Validation reliability

- Use one Linux CI job on minimum Node 22.19/Pi 1.4. Remove the Windows job, command mode and native test harness entirely. Earlier Windows results remain historical evidence, not a continuing release requirement.
- Run independent checks through the existing bounded runner and reuse npm's download cache. Keep benchmarks separate from concurrent suites so timing comparisons remain useful. Pack and install the actual package once rather than adding a redundant package dry run. Preserve every required runtime, provider, cache and publication check.
- Context capture commands own distinct temporary workspaces and clean only their own files.
- Running the context gate and provider cross-check concurrently must produce the same result as running them sequentially.
- A regression test must fail for each reported bug on the 0.34.0 baseline and pass only after its corresponding fix.
- Test the full user-visible result and forbidden side effects, including combined bug paths. Fixed seeds, controlled clocks and explicit event barriers exercise related state transitions; targeted reintroductions of the bug must make the guard fail.
- Every future fix in these areas carries its reproducer, invariant, boundary test and cache-impact evidence through the ordinary PR checks. Green test totals alone do not establish coverage.

### Prompt-cache use and invalidation

- The immutable provider prefix—host system/developer content, tool order, tool descriptions and tool schemas—must remain byte-identical for every fix unless a reviewed product requirement makes a change unavoidable. Neither the four reported bugs nor the context-display setting requires such a change.
- For implicit-prefix providers, an unchanged policy and append-only conversation must retain the previous ordered, model-visible prompt blocks byte for byte, apart from explicitly classified safety resets. Compare the provider's `messages`/`input`, system content and ordered tools, not whether one complete JSON envelope is a text prefix of another. Retries with identical inputs must preserve prompt content and cache-affecting options and add no live-tail blocks.
- For explicit-cache providers, preserve marker behavior, retention tier/TTL and content order for the equivalent scenario. Existing breakpoints can advance with real history; extension changes must not move them backwards or onto request-only goal state, counters, thinking blocks, or break tool-call/result structure. Disabled caching stays disabled.
- Clear or evict retention only for the exact outgoing session/model cache identity. A stale or late shutdown must never clear a replacement session's retained prefix. When ownership cannot be proved, bounded natural eviction is safer than clearing unrelated entries.
- Expected invalidations include history rewrites, identity changes, bounded eviction, removal or unsafe supersession of live state, unsafe tool-result anchors and the existing empty-history transition. The technical plan maps each current reset to a reason and an expected fixture transition. A reason label alone does not justify extra resets.
- Fact-only changes should retain the longest safe prefix. Task progress is a candidate for an append-only, explicitly versioned snapshot only if the latest snapshot fully supersedes earlier facts and cleared values are represented explicitly rather than by omission.
- Correctness outranks hit rate: no optimization may leave a stale objective, verification contract, task instruction, pause/clear state, scheduling wait or cancellation in force. If that cannot be proven, retain the current safe reset.
- Compare the integrated branch with 0.34.0 using exact serialized payloads. No unchanged scenario may lose reusable prefix messages/bytes or gain a prefix break. Any intentional delta must be confined to the smallest live tail and documented here before baselines change.
- The new default for `showContextUsage` intentionally removes the context line from fresh counters. Report that exact difference at the first affected counter; never normalize it away or use it to excuse changes to policy, tools, existing history or cache options. Compare retained history separately from the fewer counter bytes. A running-session toggle must append the new snapshot without rewriting older retained blocks; cross-version byte identity beyond a changed counter is not promised.
- Live provider cache-read figures depend on routing, TTL and provider thresholds. Deterministic serialized-prefix and marker-placement checks enforce preservation of cache-eligible content; paired live trials must investigate any material difference in actual cache reads. Report these as separate measurements.
- Maximize useful reuse per completed workflow, with total input, cache-read/cache-write usage, added historical-tail bytes, requests and rollover frequency reported together. Do not inflate hit rate by sending redundant context, add dummy tokens to cross a cache threshold, or extend retention limits without evidence. Investigating #108 is required; shipping a speculative representation is not.
- Keep internal ownership generations, diagnostic counters and test instrumentation out of stable prompt text, schemas and provider cache keys. Changes to local settings/ledger/task/prompt memoization must preserve fresh values and bounded memory without unnecessarily clearing unrelated provider retention.

### Code and pull-request quality

- Treat every open PR as evidence and a proposed implementation, not as code that is entitled to merge. Reproduce the bug independently and define the acceptance contract before evaluating the patch.
- Include contributor code only when the entire relevant diff is minimal, clear, type-safe, compatible with repository architecture, race-safe, cache-safe and covered at the correct unit/integration/real-SDK boundaries.
- Contributor tests must themselves be reviewed for false positives, missing negative cases, mocked-away host behavior, timing dependence and assertions that merely restate the implementation.
- Prefer one authoritative implementation for each behavior. Remove the duplicate branches, obsolete helpers, redundant flags and temporary scaffolding that a fix replaces in the same commit. Add a helper or state field only when it expresses a required invariant more clearly; do not layer a second implementation around a weak PR.
- Keep cleanup local to the fix. Avoid generic frameworks, extra settings, dependencies, compatibility modes and speculative refactors. In particular, `showContextUsage` needs one boolean in the existing settings path and a counter-rendering condition, not a new visibility or cache abstraction.
- Review the maintenance effect of every track and the release as a whole: identify what was consolidated or removed and justify every new runtime branch, state field or abstraction. The touched code must be easier to follow, with no superseded implementation left behind. This is a simplicity gate, not a net-line-count target that discourages meaningful tests.
- If a PR is incomplete, over-broad, difficult to reason about or requires follow-up fixes to become safe, reimplement the fix in-house from the behavioral contract. Preserve accurate credit for useful diagnosis, tests or design without claiming the original patch was merged unchanged.
- No bug fix is accepted solely because its focused tests pass. The exact integrated commit must pass the full suite, cache comparison and required GitHub checks.

## Compatibility and non-goals

- Keep Pi 1.4 as the minimum supported host and Node 22.19 as the minimum runtime.
- Do not redesign the public tool schemas, scheduling policy, task status model or command surface in this patch. Do not ship an unproven live-tail policy/facts split; a cache-internal change must satisfy the stricter safety and reuse gates above.
- Do not expand README. Record implementation and validation here, detailed troubleshooting in `docs/` only if a fix creates a genuine documentation need, and release notes in `CHANGELOG.md`.
- Preserve contributor credit for adapted work from PRs #109, #111, #112, #116 and #117, including GitHub co-author attribution on the corresponding fix commits. Verify the original commit identities and GitHub's account association. Description mentions alone are insufficient. Do not represent a substantially rewritten patch as merged unchanged.
- Describe PR #118 in plain language and name the original contributors alongside their work. Once the updated checks pass, close the superseded PRs and fixed reports with individual explanations linking the fix and tests. State clearly that the fix is awaiting merge/release. Keep the unresolved cache design discussion (#108) and deferred feature (#96) open.

## Completion criteria

This campaign is complete only when:

1. Issues #110, #113, #114 and #115 have failing-before/passing-after regression coverage at the appropriate unit, integration and real-SDK layers.
2. All race, attribution and cleanup invariants above are covered deterministically, without timing sleeps as the assertion mechanism.
3. All four reported-bug tracks and the default-off `showContextUsage` correction pass together on one integration branch, with no change from the explicitly deferred feature work.
4. Required CI checks run and pass on the actual integration commit; the current open PRs have no reported checks and therefore are not merge-ready evidence by themselves.
5. Per-commit and integrated cache reports show byte-identical immutable prefixes, no new unexplained prefix break, no reduction in reusable prefix for unchanged scenarios, correct explicit marker placement and no cross-session eviction.
6. The full unit, Pi 1.4 CLI/lifecycle, type, lint, context/provider, retention, cache, benchmark, package and production-audit gates pass.
7. Every adopted PR hunk has a recorded keep/rewrite decision and independent tests. Code that does not clear that review is replaced rather than patched around.
8. A 0.34.1 package is built from the tested commit and its installed tarball repeats the essential lifecycle/tool-input/cache smoke tests before publication.
9. The combined regression scenarios cover the 0.33.0/0.34.0 behavior that these fixes touch, including remapped controls, pause order, strict/default continuation, stale checkpoints, provider retries, storage conflicts and compaction. New guards fail when their protected defect is deliberately reintroduced, and the cache comparator rejects known bad payloads.
10. The default omits only the context line; explicit `true` reproduces 0.34.0 counter text. Both choices persist. Toggle/retry tests prove no display-driven retention reset, and all accounting, scheduling and compaction invariants still hold.
11. The release review records the simplification achieved in each touched path, removes superseded code and rejects unnecessary abstractions or duplicated behavior. Reviewable, well-tested code is required whether adapted from a PR or written in-house.
