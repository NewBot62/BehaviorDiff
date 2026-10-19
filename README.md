# BehaviorDiff

> **Status: experimental alpha.** The deterministic engine and the GitHub Action work end to end. The LLM "is this change intended?" step cuts noise but is not accurate enough to trust blindly (see [Benchmark](#benchmark)). Treat its comments as advice for a human reviewer.

**Compare what two versions of your TypeScript/JavaScript code actually *do*, not what the diff looks like.**

AI assistants now write a large share of committed code, and reviewers can't read it all. A diff shows changed lines; it doesn't show that `discount(100)` quietly went from `90` to `100`. BehaviorDiff runs the old and new version of each exported function on the same generated inputs and reports every observable difference: return values, thrown errors, input mutation, logged output, timeouts.

```
$ behaviordiff old.ts new.ts

  CHANGED  avg  1/9 inputs differ  (return-value x1)
             avg([])
               old: 0
               new: NaN
  CHANGED  discount  1/14 inputs differ  (return-value x1)
             discount(100)
               old: 90
               new: 100
  ok       same  (196 inputs, no behavior difference)
```

Or compare a file against any git ref (e.g. in CI on a PR):

```
behaviordiff --base origin/main src/pricing.ts --format md
```

## What it does

**1. Deterministic engine (no LLM, no network).**
- bundles both versions (esbuild), so TS, JS and relative imports just work
- generates deterministic inputs from parameter types (interfaces, literal unions, arrays, records) plus **literals harvested from both versions**, so a change from `>= 18` to `> 18` is probed at 17, 18 and 19
- runs each version in a separate Node process under `--permission` (no file writes, no child processes), with a fixed clock, seeded `Math.random`, per-call timeouts, and recovery from hangs and `process.exit`
- reports difference kinds: `return-value`, `threw-vs-returned`, `error-type`, `error-message`, `input-mutation`, `logs`, `timeout`, `crash`

**2. Intent review (optional LLM step).** A difference is only a problem if the author didn't mean it. Give the PR description and a model labels each *changed* function `intended`, `unintended` or `unclear`, listing the differences the description doesn't cover. The model never runs or compares code; it only labels differences the engine already observed. Unchanged functions cost nothing.

```
export OPENROUTER_API_KEY=... # or NVIDIA_API_KEY, OPENAI_API_KEY, ... (named after --provider); LLM_API_KEY also works. Never pass keys as flags
behaviordiff --base origin/main src/pricing.ts \
  --intent "Raise free-shipping threshold from 50 to 75" \
  --provider openrouter --model anthropic/claude-haiku-5.5
```

Works with any OpenAI-compatible endpoint: `--provider openrouter|openai|deepseek|mistral|together|deepinfra|groq|gemini|nvidia|ollama` or `--base-url`. Local models (Ollama, llama.cpp, vLLM) need no key and keep code on your machine. A per-run spend cap (`--max-cost`, default $0.05) stops the calls; remaining functions are reported as `unclassified`, never silently skipped.

Exit code `1` when something needs attention, so it can gate CI.

## GitHub Action (pull requests)

```yaml
# .github/workflows/behaviordiff.yml in YOUR repo
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  behaviordiff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci                      # the Action runs your code, so your deps must be installed
      - uses: NewBot62/BehaviorDiff@main
        with:
          api-key: ${{ secrets.LLM_API_KEY }}
          model: anthropic/claude-haiku-5.5
```

It reviews modified TS/JS files, uses the PR title and body as the intent, and keeps one comment up to date. Use the plain `pull_request` event (not `pull_request_target`): the Action executes the PR's code in a runner, and fork PRs don't receive secrets, in which case it skips with a notice. Advisory unless you set `fail-on-attention: true`. The Action ran on a live pull request in this repository ([PR #1](https://github.com/NewBot62/BehaviorDiff/pull/1)): it accepted the described threshold change and flagged an unrelated `itemLabel` change. That is one example, not a measurement. It uses test files next to a changed file (`foo.test.ts`, `test.js`, `test/foo.*`) as extra input seeds.

## Benchmark

`bench/cases/` holds 29 small cases with known ground truth per function: 12 unintended regressions, 8 intended changes, 10 behavior-preserving refactors. Each has the PR description as intent.

```
npm run bench
```

Deterministic baseline (every difference is flagged, no LLM):

| metric | result |
|---|---|
| unintended regressions caught | 11 / 12 (recall 92%) |
| precision | 58% (11 real of 19 flagged) |
| intended changes flagged (noise) | 8 / 8 |
| behavior-preserving refactors flagged | 0 / 10 |

Read this as: the engine finds nearly every real regression and never cries wolf on a pure refactor, but because it can't see intent, 42% of what it flags is a change the author asked for. Closing that gap, cheaply, is the project's goal. A Phase 2 result only counts if precision rises clearly above this baseline at low recall loss, and the per-model cost is published with it.

### Model results (free NVIDIA endpoints, 3 runs each, averaged)

Full tables with every model and suite: [bench/results/LEADERBOARD.md](bench/results/LEADERBOARD.md). Summary for the two models run on all three suites:

| suite | baseline (no LLM) | `gpt-oss-20b` | `nemotron-3-super-120b` |
|---|---|---|---|
| main (29 synthetic cases) | recall 92%, precision 58% | 83% / 100% | 86% / 86% |
| hard (12 synthetic cases: injection, unrelated descriptions) | 100% / 58% | 76% / 100% | 81% / 94% |
| **real code (25 cases, untyped JS)** | 100% / **42%** | 90% / **60%** | 83% / **67%** |

Cost: $0 (free endpoints). What this shows, honestly:
- The LLM step helps: on real code it lifts precision from 42% to 60-67% while losing 10-17 points of recall. On the synthetic suites precision is near 100%, but those were written by the author and are easier.
- **It is not mature accuracy.** On real code roughly 4 of 10 flagged changes are still noise, and 10-17% of real regressions are missed. Run-to-run noise is large: the same model and prompt gave hard-suite recall 90% in one batch and 76% in another. Do not rank models from these tables.
- The real-code suite (`bench/cases-real`) has 25 cases from pretty-bytes, camelcase, ms and decamelize: 15 real commits with their real messages, 2 real regressions confirmed by later fixes in the same repositories (`pb-binary-REAL`, `cc-node6-REAL`), and 8 real commits with a regression injected by the author outside the described change (`*-MUT`). Only two real bugs exist in it; the recall figure mostly measures the injected ones. Some "intended" labels are debatable (e.g. `ms-months` also changes `365d` to `1y`, which the models flag).
- A prompt tweak that treated "wrong-type calls that now throw" as intended raised real-code precision by 4-7 points but cost 4-9 points of recall elsewhere, so it was reverted.
- The deterministic engine had to learn untyped JavaScript to get here: it reads option keys from the function body, infers number/string parameters from their use, understands `module.exports`, and can take literals from test files (`--seed`, used automatically by the Action). Before that, it found almost none of the real bug fixes. Those changes were driven by looking at this benchmark, so the engine numbers are not a clean held-out measurement.

Honest notes on the benchmark:
- Synthetic cases are small and author-written; they are a regression harness and a fixed yardstick, not real-world accuracy.
- `reg-password-maxlen-HARD` is a deliberate miss for the engine (needs a 64-character string).
- Wrong-type inputs (e.g. `fixedWidth: 'en'`) create "now throws" differences that the models often flag even though they are a normal consequence of adding an option. This is a known source of false alarms.

## Limits (please read)

- **Not a security sandbox.** Node's permission model blocks file writes and child processes, but not network access, and the code under test can read files you allow. Run it on code you'd run in your tests anyway, in CI or a container.
- Exported **functions** only. Classes, methods and module-level side effects are not exercised yet.
- Inputs are generated, not exhaustive. "No difference found" means none was found on the generated inputs, not proof of equivalence. Functions whose arguments need very specific shapes (parsers, domain strings) get low coverage; the report says so when nearly every input throws.
- The clock and `Math.random` are frozen; other nondeterminism (network, `crypto`, timers) is not controlled.

## Install and develop

```
npm install
npm test        # builds, then runs the test suite
npm run bench
node dist/src/cli.js --help
```

Requires Node 22+. MIT licensed.

Naming: the project is **BehaviorDiff**; the npm package and command are `behaviordiff` (npm requires lowercase).
