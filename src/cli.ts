#!/usr/bin/env node
import { parseArgs } from "node:util";
import { compareFiles, compareGitRef, formatMarkdown, formatText } from "./index.js";

const USAGE = `behaviordiff - compare the behavior of two versions of a TS/JS module

  behaviordiff <old-file> <new-file> [options]
  behaviordiff --base <git-ref> <file> [options]    (ref version vs working tree)

Options:
  --format text|md|json   output format (default text)
  --max <n>               max generated inputs per function (default 300)
  --fn a,b                only these exported functions
  --timeout <ms>          per-call timeout (default 1500)
  -h, --help

Exit code: 0 no difference, 1 behavior changed, 2 error.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      format: { type: "string", default: "text" },
      max: { type: "string" },
      fn: { type: "string" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return (console.log(USAGE), 0);
  const opts = {
    ...(values.max ? { maxInputs: Number(values.max) } : {}),
    ...(values.timeout ? { callTimeoutMs: Number(values.timeout) } : {}),
    ...(values.fn ? { functions: values.fn.split(",") } : {}),
  };
  let report;
  if (values.base) {
    if (positionals.length !== 1) return (console.error(USAGE), 2);
    report = await compareGitRef(values.base, positionals[0]!, opts);
  } else {
    if (positionals.length !== 2) return (console.error(USAGE), 2);
    report = await compareFiles(positionals[0]!, positionals[1]!, opts);
  }
  console.log(values.format === "json" ? JSON.stringify(report, null, 2) : values.format === "md" ? formatMarkdown(report) : formatText(report));
  if (report.error && !report.behaviorChanged) return 2;
  return report.behaviorChanged ? 1 : 0;
}

main().then(
  (c) => process.exit(c),
  (e) => (console.error(String((e as Error).message ?? e)), process.exit(2)),
);
