# BehaviorDiff: usage guide

## The picture in one paragraph

BehaviorDiff answers one question: **"Did this change alter what the code does, and was that on purpose?"** An engine (no AI) runs the old and new version of your functions on the same generated inputs and lists every observable difference. An optional model (any OpenAI-compatible endpoint) then reads the PR description / commit message and labels each difference `intended`, `unintended` or `unclear`. The model never runs or compares code, so it cannot invent differences; it can only mislabel real ones.

```
 your repo (git) ──► engine (Node 22, local) ──► differences ──► [optional] model + your intent ──► report
   old vs new         generated inputs            facts            labels only                     terminal / PR comment / agent
```

## Who it is for

| You are | Use | Why |
|---|---|---|
| Reviewer of PRs with AI-written or large diffs | GitHub Action | A comment lists what *behaviorally* changed and what the PR text does not explain |
| Developer refactoring | `--changed --expect-no-change` | A hard gate: "this refactor changed nothing observable", no model, no cost |
| Developer before committing | `--staged` (pre-commit) | See behavior changes in the files you are about to commit |
| Maintainer upgrading dependencies | `--pkg lib@1.2.0 lib@1.3.0` | What did this upgrade (or Dependabot PR) change in the library's behavior? |
| User of a coding agent (Claude Code, Cursor, ...) | MCP server | The agent checks its own edits and catches accidental behavior changes |

## Requirements and environment

- Node.js 22 or newer (it uses Node's permission model). Linux, macOS, Windows (WSL recommended).
- Your dependencies installed (`npm ci`): the engine executes your code.
- TS/JS (ESM, CommonJS, TypeScript) with exported functions, classes, or objects of functions.
- git for `--base/--changed/--staged`. npm for `--pkg`.
- Network only for the optional model call. With a local model nothing leaves your machine.
- Not a security sandbox: run it only on code you would run in your tests anyway (CI or a container).

## Install

```
npm install -g behaviordiff          # once published; until then: git clone, npm install, npm run build, npm link
behaviordiff --help
```

## Modes

```
behaviordiff old.ts new.ts                      # two files
behaviordiff --base origin/main src/pricing.ts  # a file vs a git ref
behaviordiff --changed                          # every modified file vs merge-base with main
behaviordiff --changed --base v1.4.0            # ... vs any ref
behaviordiff --staged                           # staged files (HEAD vs working tree)
behaviordiff --pkg left-pad@1.2.0 left-pad@1.3.0  # npm upgrade
behaviordiff --changed --expect-no-change       # refactor gate: exit 1 if anything differs
```

Exit codes: `0` nothing needs attention, `1` behavior changed (or, with a model, a change is not explained by the intent), `2` error. `--exit-zero` makes it advisory.

Test files next to a changed file (`foo.test.ts`, `test/foo.*`, `__tests__/`) are read automatically and their literals become inputs (`--no-seed` disables, `--seed a.test.ts` adds).

### What is compared

- exported functions (`export function f`, `export const f = ...`, `module.exports = fn`, `exports.f`)
- exported objects of functions: `utils.f`
- exported classes: constructor `C`, methods `C#m` (called on a fresh instance, then a second call on the same instance), statics `C.m`. Public instance state (own enumerable non-function properties) is compared after calls (`state-change`).

Difference kinds: `return-value`, `threw-vs-returned`, `error-type`, `error-message`, `input-mutation`, `state-change`, `logs`, `timeout`, `crash`.

## Intent review with a model

The key is read from the environment, never a flag: `<PROVIDER>_API_KEY` (`OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, ...) or `LLM_API_KEY`.

| Provider | `--provider` | Key env | Notes |
|---|---|---|---|
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | Hundreds of models, reports real cost. Cheap models work. |
| NVIDIA build.nvidia.com | `nvidia` | `NVIDIA_API_KEY` | Free endpoints with rate limits (e.g. `nvidia/llama-3.3-nemotron-super-49b-v1.5`, `openai/gpt-oss-20b`; availability changes) |
| OpenAI | `openai` | `OPENAI_API_KEY` | e.g. `gpt-5-mini` |
| Groq / DeepSeek / Mistral / Together / DeepInfra / Gemini | same name | `<NAME>_API_KEY` | OpenAI-compatible endpoints |
| Ollama (local) | `ollama` | none | `ollama pull qwen3:14b`; code stays on your machine |
| anything else | `--base-url https://host/v1` | `LLM_API_KEY` | vLLM, llama.cpp, LM Studio, proxies |

```
export NVIDIA_API_KEY=nvapi-...
behaviordiff --changed --intent-from-commits --provider nvidia --model openai/gpt-oss-20b
behaviordiff --base origin/main src/a.ts --intent "Raise free shipping from 50 to 75" --provider openrouter --model anthropic/claude-haiku-5.5
```

Honest accuracy (see README benchmark): on real-world code models catch most real regressions but still flag some intended changes. Treat labels as advice for a human. `--max-cost` (default $0.05) bounds spend. The verdict `intended` requires a verifiable quote from your intent text; otherwise it is downgraded to `unclear`.

**Privacy.** The model receives: the intent text, the function names, the observed old/new outputs for sample calls and, unless you pass `--redact-source`, the old/new source of changed functions only. Unchanged code is never sent.

## Recipes

### GitHub Actions (PR comment)

```yaml
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
      - run: npm ci
      - uses: NewBot62/BehaviorDiff@main
        with:
          provider: nvidia                 # or openrouter, openai, groq, ...
          api-key: ${{ secrets.NVIDIA_API_KEY }}
          model: openai/gpt-oss-20b
```

### Refactor gate in CI (no model, no secrets)

```yaml
      - run: npx behaviordiff --changed --base origin/${{ github.base_ref }} --expect-no-change
```
Use it only on refactor-only PRs (e.g. label-triggered).

### GitLab CI

```yaml
behaviordiff:
  image: node:22
  script:
    - git fetch origin $CI_MERGE_REQUEST_TARGET_BRANCH_NAME
    - npm ci
    - npx behaviordiff --changed --base origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME --format md --intent "$CI_MERGE_REQUEST_TITLE. $CI_MERGE_REQUEST_DESCRIPTION" --provider openrouter --model anthropic/claude-haiku-5.5 --exit-zero
  rules: [{ if: $CI_PIPELINE_SOURCE == "merge_request_event" }]
```
(set `OPENROUTER_API_KEY` as a masked CI variable)

### Pre-commit (git hook)

`.git/hooks/pre-commit`:
```sh
#!/bin/sh
npx behaviordiff --staged --exit-zero
```
Use `--expect-no-change` instead of `--exit-zero` to block commits that change behavior.

### Dependency upgrades

```
behaviordiff --pkg zod@3.22.0 zod@3.23.0
behaviordiff --pkg zod@3.22.0 zod@3.23.0 --intent "patch release: bug fixes only" --provider openrouter --model ...
```
It installs both versions (`--ignore-scripts`) into temp folders and compares the package entry point.

### Coding agents (MCP)

Claude Code:
```
claude mcp add behaviordiff -- npx -y -p behaviordiff behaviordiff-mcp
```
Cursor / other clients (`mcp.json`):
```json
{ "mcpServers": { "behaviordiff": { "command": "npx", "args": ["-y", "-p", "behaviordiff", "behaviordiff-mcp"],
  "env": { "BEHAVIORDIFF_PROVIDER": "openrouter", "BEHAVIORDIFF_MODEL": "anthropic/claude-haiku-5.5", "OPENROUTER_API_KEY": "..." } } } }
```
Tools: `behavior_diff_changed` (working tree vs base ref), `behavior_diff_files`, `behavior_diff_package`. The model env vars are optional: without them the agent still gets the factual differences and judges them itself, which is often the best setup (the agent already knows the intent).

## Configuration file

`behaviordiff.config.json` in the project root (CLI flags win):

```json
{
  "exclude": ["src/generated/", "*.stories.ts"],
  "maxFiles": 30,
  "maxInputs": 400,
  "timeoutMs": 1500,
  "ignore": ["main", "startServer"],
  "seed": ["test/fixtures.ts"],
  "inputs": {
    "parseDuration": [["1h"], ["90m", { "long": true }]],
    "Cart#add": [[[], [{ "sku": "a", "qty": 2 }]]]
  },
  "provider": "openrouter",
  "model": "anthropic/claude-haiku-5.5",
  "maxCost": 0.05,
  "redactSource": false
}
```

Custom `inputs` are argument lists tried in addition to generated ones. For instance methods an entry is `[constructorArgs, methodArgs]`.

## Limits

- Inputs are generated: "no difference" means none found on those inputs. Functions needing very specific shapes (parsers, domain strings) get low coverage unless you provide `inputs` or tests to seed from.
- Network, `crypto`, timers and file system are not controlled (writes are blocked, the clock and `Math.random` are fixed).
- Side-effecting module top-levels run on import. Private members and getters are not exercised.
- Models can mislabel. The engine's facts are reliable; the labels are advice.
