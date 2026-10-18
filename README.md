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

## Status: Phase 1 (deterministic engine, no LLM)

Works today, with no API key and no network:

- bundles both versions (esbuild), so TS, JS and relative imports just work
- generates deterministic inputs from parameter types (interfaces, literal unions, arrays, records) plus **literals harvested from both versions**, so a change from `>= 18` to `> 18` is probed at 17, 18 and 19
- runs each version in a separate Node process under `--permission` (no file writes, no child processes), with a fixed clock, seeded `Math.random`, per-call timeouts, and recovery from hangs and `process.exit`
- reports difference kinds: `return-value`, `threw-vs-returned`, `error-type`, `error-message`, `input-mutation`, `logs`, `timeout`, `crash`
- exit code `1` when behavior changed, so it can gate CI

**What it can't do yet is tell whether a change was intended.** If a PR says "raise free shipping from 50 to 75", the correct output is "yes, shipping changed, as described". Phase 2 adds an LLM step that reads the PR description and classifies each difference as intended or unintended. The LLM never executes or compares anything; it only labels differences the engine already found. See [docs/PHASE2.md](docs/PHASE2.md).

## Benchmark

`bench/cases/` holds 29 small cases with known ground truth per function: 12 unintended regressions, 8 intended changes, 10 behavior-preserving refactors. Each has the PR description as intent.

```
npm run bench
```

Current deterministic baseline (every difference is flagged):

| metric | result |
|---|---|
| unintended regressions caught | 11 / 12 (recall 92%) |
| precision | 58% (11 real of 19 flagged) |
| intended changes flagged (noise) | 8 / 8 |
| behavior-preserving refactors flagged | 0 / 10 |

Read this as: the engine finds nearly every real regression and never cries wolf on a pure refactor, but because it can't see intent, 42% of what it flags is a change the author asked for. Closing that gap, cheaply, is the project's goal. A Phase 2 result only counts if precision rises clearly above this baseline at low recall loss, and the per-model cost is published with it.

Honest notes on the benchmark:
- The cases are small and written by the author, so they are *not* a measure of real-world accuracy. They are a regression harness and a fixed yardstick for comparing models. Real-PR cases (mined from public repositories) are planned.
- After the first run, two **generic** weaknesses in input generation were fixed (arrays of records sharing a key; one large array). Those fixes were informed by seeing which cases failed. The first-run numbers were recall 83% and 7/8 intended flagged.
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
