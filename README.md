# BehaviorDiff

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
export LLM_API_KEY=...        # never pass keys as flags
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

It reviews modified TS/JS files, uses the PR title and body as the intent, and keeps one comment up to date. Use the plain `pull_request` event (not `pull_request_target`): the Action executes the PR's code in a runner, and fork PRs don't receive secrets, in which case it skips with a notice. Advisory unless you set `fail-on-attention: true`. The Action is new and has only been tested locally with a stub model, not yet on a live PR.

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

### First model results (main suite, free NVIDIA endpoints, 1 run each)

| model | recall | precision | intended changes wrongly flagged | wall time |
|---|---|---|---|---|
| baseline (no LLM) | 92% | 58% | 8 / 8 | - |
| `openai/gpt-oss-20b` | 83% | 100% | 0 / 8 | 91 s |
| `z-ai/glm-5.3` | 83% | 100% | 0 / 8 | 590 s |
| `nvidia/nemotron-3-super-120b-a12b` | 75% | 100% | 0 / 8 | 242 s |
| `google/diffusiongemma-26b-a4b-it` | 83% | 91% | 1 / 8 | 106 s |

What this does and does not show:
- The intent step works on this suite: three of four models cleared every intended change (precision 58% to 100%) while losing one regression (92% to 83%). The cost was $0 on free endpoints.
- **It is a weak result statistically.** There are 12 regressions and 8 intended changes, one run per model, so one case moves a number by about 8 points. The 100% precision rests on 10 true positives; its 95% interval reaches down to roughly 70%. Do not rank models from this table.
- All four models made the same mistake: `label()` changes `||` to `??` under the description "Modernize with nullish coalescing", and every model called the empty-string difference intended. The description names the mechanism, not the behavior, and models tend to accept a stated mechanism as the explanation. A paired case in the hard suite (`h-nullish-explicit-intended`) uses the same diff with a description that states the behavior.
- One miss in every column (`reg-password-maxlen-HARD`) comes from the deterministic engine, not the models: no generated string has 64 characters, so the model was never asked.
- The main suite is easy: descriptions are explicit and written by the author. The **hard suite** (`bench/cases-hard`) adds unrelated descriptions, prompt injection in the description and in a code comment, differences visible only in the source, and removed exports. It has not been run on any model yet.

Honest notes on the benchmark:
- The cases are small and written by the author, so they are *not* a measure of real-world accuracy. They are a regression harness and a fixed yardstick for comparing models. Real-PR cases (mined from public repositories) are planned.
- Input generation was improved three times after looking at failing cases: arrays of records sharing a key, one large array, and whitespace-only strings (the last after the hard suite's `isValidUsername` case slipped through). All three are generic edge cases, but they were found by looking at this benchmark, so the baseline numbers are not a clean held-out measurement. The first-ever run had recall 83% and 7/8 intended flagged.
- `reg-password-maxlen-HARD` is a deliberate miss: the regression only appears for a 64-character string, which no generated input has. An LLM that reads the diff should catch it. If it doesn't, that is a result.

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
