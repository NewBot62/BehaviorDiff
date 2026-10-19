# Leaderboard

Known-truth benchmark (`bench/cases`). Each model labels the differences found by the deterministic engine, given the PR description. Higher precision and recall are better; flagged-intended and flagged-refactor should be 0. Cost is the measured total for the whole run, not an estimate.

| Model | Recall | Precision | Intended flagged | Refactors flagged | Runs | Cost (USD) | $ / 1000 reviews | Notes |
|---|---|---|---|---|---|---|---|---|
| *baseline (no LLM)* | 92% | 58% | 8/8 | 0/10 | - | 0 | 0 | flags every difference |

Caveats: 29 small hand-written cases, so differences of a few points between models are noise. See README for limits.
