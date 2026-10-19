#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { compareFiles, compareGitRef, formatMarkdown, formatText, resolveConfig, reviewFiles, reviewGitRef, PROVIDERS } from "./index.js";

const USAGE = `behaviordiff - compare the behavior of two versions of a TS/JS module

  behaviordiff <old-file> <new-file> [options]
  behaviordiff --base <git-ref> <file> [options]    (ref version vs working tree)

Options:
  --format text|md|json   output format (default text)
  --max <n>               max generated inputs per function (default 400)
  --fn a,b                only these exported functions
  --timeout <ms>          per-call timeout (default 1500)
  --seed <files>          comma-separated files (e.g. tests) whose literals are used as extra inputs

Intent review (optional, uses an OpenAI-compatible LLM endpoint):
  --intent "<text>"       what the change is supposed to do (e.g. the PR description)
  --intent-file <path>    read the intent from a file
  --provider <name>       ${Object.keys(PROVIDERS).join(" | ")}
  --base-url <url>        any OpenAI-compatible endpoint (overrides --provider)
  --model <id>            model id (or env LLM_MODEL)
  --max-cost <usd>        stop calling the model after this spend (default 0.05)
  --price-in/--price-out  USD per million tokens (else provider-reported cost)
  Key from env LLM_API_KEY (never a flag). Also LLM_PROVIDER, LLM_BASE_URL.

Exit code: 0 nothing needs attention, 1 behavior changed (or, with --intent,
a change is not explained by the intent), 2 error.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      format: { type: "string", default: "text" },
      max: { type: "string" },
      fn: { type: "string" },
      timeout: { type: "string" },
      seed: { type: "string" },
      intent: { type: "string" },
      "intent-file": { type: "string" },
      provider: { type: "string" },
      "base-url": { type: "string" },
      model: { type: "string" },
      "max-cost": { type: "string" },
      "price-in": { type: "string" },
      "price-out": { type: "string" },
      "json-mode": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return (console.log(USAGE), 0);
  const opts = {
    ...(values.max ? { maxInputs: Number(values.max) } : {}),
    ...(values.timeout ? { callTimeoutMs: Number(values.timeout) } : {}),
    ...(values.seed ? { seedFiles: values.seed.split(",") } : {}),
    ...(values.fn ? { functions: values.fn.split(",") } : {}),
  };
  const intent = values.intent ?? (values["intent-file"] ? readFileSync(values["intent-file"], "utf8") : undefined);
  const base = values.base;
  if (base ? positionals.length !== 1 : positionals.length !== 2) return (console.error(USAGE), 2);

  let report;
  if (intent !== undefined && intent.trim()) {
    const llm = resolveConfig({
      ...(values.provider ? { provider: values.provider } : {}),
      ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values["price-in"] ? { priceIn: Number(values["price-in"]) } : {}),
      ...(values["price-out"] ? { priceOut: Number(values["price-out"]) } : {}),
      ...(values["json-mode"] ? { jsonMode: true } : {}),
    });
    const ro = { ...opts, intent, llm, ...(values["max-cost"] ? { maxCostUsd: Number(values["max-cost"]) } : {}) };
    report = base ? await reviewGitRef(base, positionals[0]!, ro) : await reviewFiles(positionals[0]!, positionals[1]!, ro);
  } else {
    report = base ? await compareGitRef(base, positionals[0]!, opts) : await compareFiles(positionals[0]!, positionals[1]!, opts);
  }
  console.log(values.format === "json" ? JSON.stringify(report, null, 2) : values.format === "md" ? formatMarkdown(report) : formatText(report));
  if (report.error && !report.behaviorChanged) return 2;
  if (report.llm) return report.attention || report.error ? 1 : 0;
  return report.behaviorChanged ? 1 : 0;
}

main().then(
  (c) => process.exit(c),
  (e) => (console.error(String((e as Error).message ?? e)), process.exit(2)),
);
