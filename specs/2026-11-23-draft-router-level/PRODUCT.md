# Router level for a new goal's drafting prompt

John asked on 2026-11-23: "when I use `/goal` or `/sisyphus` to create a goal using pi-goal-x, I
always want the prompt this produces to be handled using the super tier."

## Behaviour

- `/goal` and `/sisyphus` end their drafting prompt with a last line `#super` when the selected
  model is `smart-router/auto` and Pi is idle. pi-smart-router reads a level tag as the last token
  of an idle input, removes it before the model sees the message, and plans the run at SUPER.
- The router takes the level of the last three planned prompts for runs that start without a
  prompt, so the goal's continuations after the draft is confirmed stay at SUPER until three
  lighter prompts have been planned.
- No tag is added in any other case, because nothing would remove it or it would do harm:
  - another model, picked by hand or a router's other model: the tag would reach the model as text;
  - `smart-router/local`: the router refuses a tagged level that has no local models;
  - Pi busy (the prompt is delivered as a steer): the router drops a steer's tag with a warning;
  - `/goal-tweak`, which revises an existing goal: not asked for.
- `/goal-direct` and `/sisyphus-direct` send no prompt, so there is nothing to tag.

## Not done

- No setting turns this off or names another level. Add one when someone needs it.
