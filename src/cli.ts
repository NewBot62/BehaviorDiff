#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import {
  PROVIDERS,
  commitMessages,
  compareFiles,
  compareGitRef,
  comparePackages,
  defaultBase,
  formatMarkdown,
  formatProjectText,
  formatText,
  resolveConfig,
  reviewChanged,
  reviewFiles,
  reviewGitRef,
} from "./index.js";
import type { Report } from "./types.js";

const USAGE = `behaviordiff - compare what two versions of TS/JS code DO (not what the diff looks like)

What to compare:
  behaviordiff <old-file> <new-file>          two files
  behaviordiff --base <git-ref> <file>        a file at a git ref vs your working tree
  behaviordiff --changed [--base <git-ref>]   every modified file vs a ref (default: merge-base with main)
  behaviordiff --staged                       every staged file (HEAD vs working tree), e.g. in a pre-commit hook
  behaviordiff --pkg <name@old> <name@new>    two published npm versions: what changed in this upgrade?

Options:
  --format text|md|json   output format (default text)
  --max <n>               max generated inputs per function (default 400)
  --fn a,b                only these exported functions        --ignore a,b   skip these
  --timeout <ms>          per-call timeout (default 1500)
  --seed <files>          comma-separated files (e.g. tests) whose literals become inputs
                          (neighbouring test files are used automatically with --changed/--staged)
  --no-seed               do not look for neighbouring test files
  --include <p,p> / --exclude <p,p>   substring or *.ext filters for --changed/--staged
  --max-files <n>         files reviewed with --changed/--staged (default 30)
  --inputs <file.json>    your own argument lists per function: {"fn": [[arg1, arg2], ...]}
  --config <file>         settings file (default: ./behaviordiff.config.json if present)
  --expect-no-change      refactor check, no model: exit 1 if behavior differs anywhere
  --exit-zero             never fail (report only)

Intent review (optional; any OpenAI-compatible endpoint, a local model works too):
  --intent "<text>"       what the change is supposed to do (PR description, commit message)
  --intent-file <path>    read the intent from a file
  --intent-from-commits   with --changed: use the commit messages since the base as intent
  --provider <name>       ${Object.keys(PROVIDERS).join(" | ")}
  --base-url <url>        any OpenAI-compatible endpoint (overrides --provider)
  --model <id>            model id (or env LLM_MODEL)
  --max-cost <usd>        stop calling the model after this spend (default 0.05)
  --price-in/--price-out  USD per million tokens (else provider-reported cost)
  --redact-source         never send function source to the model, only observed differences
  Key from env <PROVIDER>_API_KEY (OPENROUTER_API_KEY, NVIDIA_API_KEY, ...) or LLM_API_KEY; never a flag.

Exit code: 0 nothing needs attention, 1 behavior changed (or, with an intent review,
a change is not explained by the intent), 2 error.`;

const splitList = (s: string | undefined) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

async function main(): Promise<number> {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      changed: { type: "boolean" },
      staged: { type: "boolean" },
      pkg: { type: "boolean" },
      format: { type: "string", default: "text" },
      max: { type: "string" },
      fn: { type: "string" },
      ignore: { type: "string" },
      timeout: { type: "string" },
      seed: { type: "string" },
      "no-seed": { type: "boolean" },
      include: { type: "string" },
      exclude: { type: "string" },
      "max-files": { type: "string" },
      inputs: { type: "string" },
      config: { type: "string" },
      "expect-no-change": { type: "boolean" },
      "exit-zero": { type: "boolean" },
      intent: { type: "string" },
      "intent-file": { type: "string" },
      "intent-from-commits": { type: "boolean" },
      provider: { type: "string" },
      "base-url": { type: "string" },
      model: { type: "string" },
      "max-cost": { type: "string" },
      "price-in": { type: "string" },
      "price-out": { type: "string" },
      "json-mode": { type: "boolean" },
      "redact-source": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (v.help) return (console.log(USAGE), 0);
  const cwd = process.cwd();
  const cfg = loadConfig(cwd, v.config);

  const customInputs = v.inputs ? (JSON.parse(readFileSync(v.inputs, "utf8")) as Record<string, unknown[][]>) : cfg.inputs;
  const seedFiles = splitList(v.seed) ?? cfg.seed;
  const ignore = splitList(v.ignore) ?? cfg.ignore;
  const functions = splitList(v.fn);
  const maxInputs = v.max ? Number(v.max) : cfg.maxInputs;
  const timeout = v.timeout ? Number(v.timeout) : cfg.timeoutMs;
  const opts = {
    ...(maxInputs ? { maxInputs } : {}),
    ...(timeout ? { callTimeoutMs: timeout } : {}),
    ...(seedFiles ? { seedFiles } : {}),
    ...(functions ? { functions } : {}),
    ...(ignore ? { ignore } : {}),
    ...(customInputs ? { customInputs } : {}),
  };

  const project = !!(v.changed || v.staged);
  const need = v.pkg ? 2 : project ? 0 : v.base ? 1 : 2;
  if (positionals.length !== need) return (console.error(USAGE), 2);

  let intent = v.intent ?? (v["intent-file"] ? readFileSync(v["intent-file"], "utf8") : undefined);
  if (!intent && v["intent-from-commits"] && project) intent = commitMessages(cwd, v.base ?? defaultBase(cwd));
  if (v["expect-no-change"]) intent = undefined;
  const redactSource = v["redact-source"] ?? cfg.redactSource;
  const maxCost = v["max-cost"] ? Number(v["max-cost"]) : cfg.maxCost;
  const wantLlm = intent !== undefined && intent.trim() !== "";
  const llm = wantLlm
    ? resolveConfig({
        ...((v.provider ?? cfg.provider) ? { provider: (v.provider ?? cfg.provider)! } : {}),
        ...((v["base-url"] ?? cfg.baseUrl) ? { baseUrl: (v["base-url"] ?? cfg.baseUrl)! } : {}),
        ...((v.model ?? cfg.model) ? { model: (v.model ?? cfg.model)! } : {}),
        ...(v["price-in"] ? { priceIn: Number(v["price-in"]) } : {}),
        ...(v["price-out"] ? { priceOut: Number(v["price-out"]) } : {}),
        ...(v["json-mode"] ? { jsonMode: true } : {}),
      })
    : undefined;
  const ro = wantLlm && llm ? { ...opts, intent: intent!, llm, ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}), ...(redactSource ? { redactSource } : {}) } : undefined;

  const fmt = (r: Report) => (v.format === "md" ? formatMarkdown(r) : formatText(r));
  let failed: boolean;
  let err = false;

  if (project) {
    const include = splitList(v.include) ?? cfg.include;
    const exclude = splitList(v.exclude) ?? cfg.exclude;
    const maxFiles = v["max-files"] ? Number(v["max-files"]) : cfg.maxFiles;
    const rep = await reviewChanged(
      {
        ...opts,
        ...(v.base ? { base: v.base } : {}),
        ...(v.staged ? { staged: true } : {}),
        ...(include ? { include } : {}),
        ...(exclude ? { exclude } : {}),
        ...(maxFiles ? { maxFiles } : {}),
        ...(v["no-seed"] ? { autoSeed: false } : {}),
        ...(ro ? { intent: ro.intent, llm: ro.llm, ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}), ...(redactSource ? { redactSource } : {}) } : {}),
      },
      cwd,
    );
    if (v.format === "json") console.log(JSON.stringify(rep, null, 2));
    else if (v.format === "md") console.log(rep.files.filter((r) => r.behaviorChanged || r.error).map(formatMarkdown).join("\n") || "No behavior difference found on generated inputs.");
    else console.log(formatProjectText(rep, formatText));
    err = rep.files.some((r) => r.error && !r.behaviorChanged);
    failed = rep.attention !== undefined ? rep.attention > 0 : rep.behaviorChanged;
  } else {
    let report: Report;
    if (v.pkg) {
      report = await comparePackages(positionals[0]!, positionals[1]!, { ...opts, ...(ro ? { intent: ro.intent, llm: ro.llm, ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}) } : {}) });
    } else if (v.base) {
      report = ro ? await reviewGitRef(v.base, positionals[0]!, ro) : await compareGitRef(v.base, positionals[0]!, opts);
    } else {
      report = ro ? await reviewFiles(positionals[0]!, positionals[1]!, ro) : await compareFiles(positionals[0]!, positionals[1]!, opts);
    }
    console.log(v.format === "json" ? JSON.stringify(report, null, 2) : fmt(report));
    err = !!report.error && !report.behaviorChanged;
    failed = report.llm ? !!(report.attention || report.error) : report.behaviorChanged;
  }
  if (v["expect-no-change"]) console.log(failed ? "\nREFACTOR CHECK FAILED: behavior differs (see above)." : "\nREFACTOR CHECK PASSED: no behavior difference found on generated inputs.");
  if (err) return 2;
  return failed && !v["exit-zero"] ? 1 : 0;
}

main().then(
  (c) => process.exit(c),
  (e) => (console.error(String((e as Error).message ?? e)), process.exit(2)),
);
