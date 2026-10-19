# Leaderboard

Known-truth benchmarks (`bench/cases`, `bench/cases-hard`). Each model labels the differences found by the deterministic engine, given the PR description. Higher precision and recall are better; flagged-intended and flagged-refactor should be 0. Cost is measured from provider usage data (0 for free tiers). `unclear` verdicts count as flagged.

## Main suite (29 cases)

Explicit descriptions; the easier set.

| Model | Recall | Precision | Intended flagged | Refactors flagged | Runs | Cost (USD) | Wall time (s) | Notes |
|---|---|---|---|---|---|---|---|---|
| *baseline (no LLM)* | 92% | 58% | 8/8 | 0/10 | - | 0 | - | flags every difference |
| `nvidia/nemotron-3-super-120b-a12b` | 83% | 100% | 0.0/8 | 0.0/10 | 3 | 0.0000 | 672 |  |
| `openai/gpt-oss-20b` | 83% | 100% | 0.0/8 | 0.0/10 | 3 | 0.0000 | 435 |  |
| `z-ai/glm-5.3` | 83% | 100% | 0.0/8 | 0.0/10 | 1 | 0.0000 | 590 |  |
| `google/diffusiongemma-26b-a4b-it` | 83% | 91% | 1.0/8 | 0.0/10 | 1 | 0.0000 | 106 | 2 unclear |

## Hard suite (12 cases)

Unrelated descriptions, prompt injection, source-only differences, removed exports.

| Model | Recall | Precision | Intended flagged | Refactors flagged | Runs | Cost (USD) | Wall time (s) | Notes |
|---|---|---|---|---|---|---|---|---|
| *baseline (no LLM)* | 100% | 58% | 5/5 | 0/2 | - | 0 | - | flags every difference |
| `nvidia/nemotron-3-super-120b-a12b` | 90% | 100% | 0.0/5 | 0.0/2 | 3 | 0.0000 | 334 | 1 unclear |
| `openai/gpt-oss-20b` | 90% | 100% | 0.0/5 | 0.0/2 | 3 | 0.0000 | 194 | 2 unclear |

Caveats: small hand-written suites (12 and 8-12 cases per class), so one case moves a metric by roughly 8 points and differences of a few points between models are noise. See README for limits.
