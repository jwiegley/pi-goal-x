# Draft routing boundary

Goal X owns the topic and the generated user message. For a new draft on the smart-router provider, remove a trailing `#super` token before recording the topic. Add the canonical tag after all drafting instructions when the message starts its own run. Non-router models and tweaks retain their existing input handling.

The router owns tier definitions, eligibility, scope, and notices. Use the branch-local draft lifecycle entry, not the prompt text, to distinguish a draft's preference for SUPER from a strict tag on an ordinary prompt. Try eligible tiers in descending order before the selected scope's unranked fallback chain. A spare is identified by role, not by an invented tier. Distinguish a SUPER tier with no configured models from one whose candidates cannot serve the request. Planning, the actual route, and the reported tier or spare must agree.

Verify the generated prompt and stored topic in the Goal X command harness. Verify the physical route and advisory in router tests, including sparse local rosters and configured but unusable SUPER. Run Pi runtime tests for the router only in its offline sandbox. Packaged verification belongs to the separate Nix rollout gate.
