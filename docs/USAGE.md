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
| Team in **any language** (Go, Rust, Java, PHP, Ruby, C#...) | `behaviordiff cmd` / `behaviordiff http` | Compare two builds of a CLI or two versions of an API on the same cases/requests |
| Team **rewriting or migrating** a service (e.g. Node to Go, monolith to microservice) | `behaviordiff http` with a HAR recording | Replay real traffic against old and new and see every response that differs |

## Requirements and environment

- Node.js 22 or newer (it uses Node's permission model). Linux, macOS, Windows (WSL recommended).
- Your dependencies installed (`npm ci`): the engine executes your code.
- Function level: TypeScript/JavaScript (ESM, CommonJS) and **Python 3.9+** (functions, classes, dataclasses; type hints guide the inputs). Python needs `python3` on PATH (or `BEHAVIORDIFF_PYTHON`, or a `.venv` in the project).
- Any other language: black-box modes `cmd` (programs) and `http` (web services), see below.
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

## Any language: black-box modes

For code that is not TS/JS/Python, compare what the **program** or **service** does. Nothing about the language matters: only inputs and observable outputs.

### `behaviordiff cmd`: two versions of a program

```
behaviordiff cmd --old ./tool-v1 --new ./tool-v2 --cases cases.json
behaviordiff cmd --base origin/main --build "make build" --run "./bin/tool" --cases cases.json   # old = git ref, new = working tree
behaviordiff cmd --old "python old.py" --new "python new.py" --case "--lines" --case "convert --to json"
```

`cases.json`:

```json
[
  { "args": ["greet", "Bob"] },
  { "args": ["count", "--lines"], "stdin": "a b\nc\n" },
  { "args": ["convert", "{fmt}"], "vars": { "fmt": ["json", "yaml", "csv"] }, "files": { "in.txt": "hello" } },
  { "args": ["--fail"], "env": { "MODE": "strict" }, "group": "errors" }
]
```

- compares exit code, stdout, stderr and **files the program wrote** (each case runs in a fresh temp dir; `--fixtures dir` is copied into it first)
- `vars` expands a matrix (`{fmt}` is replaced by each value)
- timestamps, UUIDs, durations, ANSI colors and temp paths are normalized automatically; add your own with `--normalize 'pattern=>replacement'` (repeatable)
- **flaky outputs are filtered**: the old version is run twice, and a case whose output differs between those runs is ignored and counted in a note (disable with `--no-flake-check`)
- `--base` builds both trees with `--build` (run in each tree: include `npm ci`/`pip install`/`go build` as needed) and runs `--run` from each tree root
- the program runs with your user permissions: it is **not sandboxed** in this mode, run it only on programs/cases you would run anyway

### `behaviordiff http`: two versions of a web service

```
# two servers already running
behaviordiff http --old http://localhost:3000 --new http://localhost:3001 --openapi openapi.json

# start both for you (the command must listen on $PORT or {port})
behaviordiff http --old-start "node old/server.js" --new-start "node new/server.js" --requests reqs.json

# old = git ref, new = working tree
behaviordiff http --base origin/main --build "npm ci" --start "node server.js" --har traffic.har --ignore-fields requestId,updatedAt
```

Request sources (combine freely):
- `--requests reqs.json`: `["GET /users/1", {"method":"GET","path":"/search?q=a","headers":{"authorization":"Bearer t"}}]`
- `--har file.har`: replay **recorded real traffic** (export from browser devtools, Charles, mitmproxy); static assets are skipped
- `--openapi spec.json`: generates requests per operation from the spec (examples, enums, min/max boundaries, request-body samples)

What is compared: status code, selected headers (`--headers content-type,location,...`), and the body: JSON by **path** (`$.items[2].price: 10 -> 12`, added/removed fields), other bodies as text.
- **Volatile fields are detected automatically**: each request is sent twice to the old server and fields that differ between the two answers (ids, timestamps, tokens) are ignored. Add more with `--ignore-fields name,$.exact.path`.
- Only `GET/HEAD/OPTIONS` are sent by default. `--allow-unsafe` also sends POST/PUT/PATCH/DELETE (this changes state on both servers: use test databases).
- Each report line is grouped per endpoint (`GET /users/{id}`).

### Python functions

```
behaviordiff old.py new.py
behaviordiff --changed            # also picks up modified .py files; test_*.py / *_test.py are used as input seeds
```

- functions, classes (`C`, `C#method`, `C.static`), dataclasses; inputs follow type hints (`list[float]`, `Optional[int]`, `Literal[...]`, dataclass fields) and literals found in the module and its tests
- files inside a package keep their relative imports working
- sandbox: file writes, deleting/renaming, subprocesses and **network are blocked** (Python audit hook); time, `random` and `uuid` are fixed; `PYTHONHASHSEED=0`
- the module must be importable by `python3` with its dependencies installed (point `BEHAVIORDIFF_PYTHON` at a venv interpreter if needed)
- custom inputs in `behaviordiff.config.json` work the same way: `{"inputs": {"discount": [[100, 70]]}}`

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
Tools: `behavior_diff_changed` (working tree vs base ref), `behavior_diff_files`, `behavior_diff_package`, `behavior_diff_command` (any program), `behavior_diff_http` (any web service). The model env vars are optional: without them the agent still gets the factual differences and judges them itself, which is often the best setup (the agent already knows the intent).

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
- `cmd` and `http` modes only see what your cases/requests exercise; they do not sandbox the program. HTTP mode compares JSON arrays by position.
- Models can mislabel. The engine's facts are reliable; the labels are advice.
