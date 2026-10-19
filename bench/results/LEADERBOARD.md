# Leaderboard

Known-truth benchmark (`bench/cases`). Each model labels the differences found by the deterministic engine, given the PR description. Higher precision and recall are better; flagged-intended and flagged-refactor should be 0. Cost is the measured total for the whole run, not an estimate.

| Model | Recall | Precision | Intended flagged | Refactors flagged | Runs | Cost (USD) | $ / 1000 reviews | Notes |
|---|---|---|---|---|---|---|---|---|
| *baseline (no LLM)* | 92% | 58% | 8/8 | 0/10 | - | 0 | 0 | flags every difference |
| `openai/gpt-oss-20b` | 83% | 100% | 0.0/8 | 0.0/10 | 1 | 0.0000 | 0.00 |  |
| `z-ai/glm-5.3` | 83% | 100% | 0.0/8 | 0.0/10 | 1 | 0.0000 | 0.00 |  |
| `nvidia/nemotron-3-super-120b-a12b` | 75% | 100% | 0.0/8 | 0.0/10 | 1 | 0.0000 | 0.00 |  |
| `google/diffusiongemma-26b-a4b-it` | 83% | 91% | 1.0/8 | 0.0/10 | 1 | 0.0000 | 0.00 | 2 unclear |

Caveats: 29 small hand-written cases, so differences of a few points between models are noise. See README for limits.
