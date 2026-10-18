# Phase 2: intent classification with cheap, swappable models

## Goal
Take the differences the engine found plus the PR description, and label each *intended* or *unintended*, at a per-PR cost low enough that nobody minds running it on every PR. No vendor lock-in.

## Design rules
1. **The LLM only labels.** Execution, comparison and reporting stay deterministic. The model cannot invent differences, only classify existing ones.
2. **Call only for changed functions.** Unchanged functions and pure refactors cost nothing.
3. **Small, structured prompt.** Per changed function: PR description, old and new source of that function, up to ~5 example differences. Output: JSON `{verdict, reason}`.
4. **Stable prefix first** (instructions + schema), variable part last, so providers with prompt caching bill the prefix at the cached rate.
5. **Spend cap per PR** (default a few cents) and a `--max-functions` limit; over the cap, fall back to "unclassified".
6. **One OpenAI-compatible adapter.** Base URL + model + key from env. That one interface covers OpenRouter, DeepSeek, Mistral, Together, DeepInfra, Gemini's compatible endpoint, OpenAI, and local Ollama/llama.cpp (the privacy option: code never leaves the machine).

## Benchmark protocol
- Run the 29-case suite per model, 2 runs each, temperature 0; report recall on unintended, precision, intended-flagged, refactor-flagged, and measured token cost.
- Candidate set (verify current prices before running): a few small/cheap hosted models from different vendors, one mid-tier, and one local model.
- Budget: about $10 total on a pooled-credit provider such as OpenRouter. API key goes in a GitHub Actions secret (`LLM_API_KEY`), never in chat or the repo.
- Publish the full table, including models that do badly.

## Kill gate
If no cheap model raises precision materially above the 58% baseline without losing recall, say so publicly and stop or change approach. A tool that is no better than flagging everything isn't worth shipping.

## After that
Real-PR benchmark mined from public repos (revert commits and "fix regression" follow-ups give natural ground truth); GitHub Action that comments on PRs; class/method support.
