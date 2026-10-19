# Leaderboard

Known-truth benchmark (`bench/cases`). Each model labels the differences found by the deterministic engine, given the PR description. Higher precision and recall are better; flagged-intended and flagged-refactor should be 0. Cost is the measured total for the whole run, not an estimate.

| Model | Recall | Precision | Intended flagged | Refactors flagged | Runs | Cost (USD) | $ / 1000 reviews | Notes |
|---|---|---|---|---|---|---|---|---|
| *baseline (no LLM)* | 92% | 58% | 8/8 | 0/10 | - | 0 | 0 | flags every difference |
| `anthropic/claude-haiku-5.5` | 92% | 58% | 8.0/8 | 0.0/10 | 2 | 0.0000 | 0.00 | 38 errors, 38 unclear |
| `deepseek/deepseek-v4.1-flash-1017` | 92% | 58% | 8.0/8 | 0.0/10 | 2 | 0.0000 | 0.00 | 38 errors, 38 unclear |
| `google/gemma-3-4b-it` | 92% | 58% | 8.0/8 | 0.0/10 | 2 | 0.0000 | 0.00 | 38 errors, 38 unclear |
| `inclusionai/ling-3.0-flash` | 92% | 58% | 8.0/8 | 0.0/10 | 2 | 0.0000 | 0.00 | 38 errors, 38 unclear |
| `meta-llama/llama-3.1-8b-instruct` | 92% | 58% | 8.0/8 | 0.0/10 | 2 | 0.0000 | 0.00 | 38 errors, 38 unclear |
| `mistralai/mistral-nemo` | 92% | 58% | 8.0/8 | 0.0/10 | 2 | 0.0000 | 0.00 | 38 errors, 38 unclear |
| `nex-agi/nex-n2.5-mini` | 92% | 58% | 8.0/8 | 0.0/10 | 2 | 0.0000 | 0.00 | 38 errors, 38 unclear |
| `openai/gpt-6-luna` | 92% | 58% | 8.0/8 | 0.0/10 | 2 | 0.0000 | 0.00 | 38 errors, 38 unclear |

Caveats: 29 small hand-written cases, so differences of a few points between models are noise. See README for limits.
