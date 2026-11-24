# Router level for a new goal's drafting prompt

John asked on 2026-11-23: "when I use `/goal` or `/sisyphus` to create a goal using pi-goal-x, I
always want the prompt this produces to be handled using the super tier."

## Behaviour

- When Pi is idle and a `smart-router` model is selected, `/goal` and `/sisyphus` end their
  generated drafting prompt with one `#super` token. This includes `auto`, `work`, `personal`,
  and `local`. An explicit trailing `#super` in the command is routing metadata: it is removed
  from the topic before Goal X stores or quotes it. A mention inside the topic remains text.
- The router resolves the request within the selected model and session scope. If SUPER is
  usable, it handles the draft. If the roster defines no SUPER tier there, the router silently
  uses the highest usable tier, or the ordinary local selection on an untiered local roster.
- If the roster defines SUPER but cannot use it, the router checks lower tiers in descending
  order. An advisory identifies the selected tier and why SUPER was unavailable. If no tier
  can serve the draft, try the selected scope's unranked fallback chain last. Name the spare's
  role, not a tier. Local-only routing has no such chain. If no permitted route remains, return
  the normal refusal. An ordinary `#super` request outside a draft keeps its normal semantics.
- Pi cannot replan an active run for a steer. Goal X does not append a routing tag to a steer,
  to a `/goal-tweak` prompt, or to a message for a non-router model. `/goal-direct` and
  `/sisyphus-direct` send no drafting prompt. Goal execution after drafting is unchanged.

## Not done

- No setting turns this off or names another level. Add one when someone needs it.
