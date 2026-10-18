import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { analyze } from "./analyze.js";
import { classifyFunction } from "./classify.js";
import { compareFiles } from "./engine.js";
import { withGitBase } from "./git.js";
import { addUsage, emptyUsage, type LlmConfig } from "./llm.js";
import type { CompareOptions, Report } from "./types.js";

export interface ReviewOptions extends CompareOptions {
  intent: string;
  llm: LlmConfig;
  /** stop calling the model once this much has been spent (default 0.05 USD) */
  maxCostUsd?: number;
  /** review at most this many changed functions (default 20) */
  maxFunctions?: number;
  concurrency?: number;
}

function sourcesOf(file: string): Map<string, string> {
  try {
    return analyze(readFileSync(file, "utf8"), basename(file)).sources;
  } catch {
    return new Map();
  }
}

export async function classifyReport(report: Report, oldFile: string, newFile: string, opts: ReviewOptions): Promise<Report> {
  const oldSrc = sourcesOf(oldFile);
  const newSrc = sourcesOf(newFile);
  const usage = emptyUsage();
  let errors = 0;
  let skipped = 0;
  const maxCost = opts.maxCostUsd ?? 0.05;
  const queue = report.functions.filter((f) => f.status === "changed" || f.status === "removed");
  let idx = 0;
  const worker = async () => {
    while (idx < queue.length) {
      const n = idx++;
      const f = queue[n]!;
      if (n >= (opts.maxFunctions ?? 20) || usage.costUsd >= maxCost) {
        f.review = { verdict: "unclassified", reason: n >= (opts.maxFunctions ?? 20) ? "function limit reached" : "spend cap reached" };
        skipped++;
        continue;
      }
      try {
        const input: Parameters<typeof classifyFunction>[1] = { intent: opts.intent, fn: f };
        const o = oldSrc.get(f.name);
        const nw = newSrc.get(f.name);
        if (o) input.oldSource = o;
        if (nw) input.newSource = nw;
        const r = await classifyFunction(opts.llm, input);
        f.review = r.review;
        addUsage(usage, r.usage);
      } catch (e) {
        errors++;
        f.review = { verdict: "unclear", reason: `LLM error: ${(e as Error).message}`.slice(0, 300) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, Math.max(queue.length, 1)) }, worker));
  const attention = queue.filter((f) => f.review?.verdict !== "intended").length;
  return {
    ...report,
    intent: opts.intent,
    attention,
    llm: { model: opts.llm.model, calls: usage.calls, errors, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costUsd: usage.costUsd, skipped },
  };
}

export async function reviewFiles(oldFile: string, newFile: string, opts: ReviewOptions): Promise<Report> {
  const report = await compareFiles(oldFile, newFile, opts);
  return report.error ? report : classifyReport(report, oldFile, newFile, opts);
}

export async function reviewGitRef(ref: string, file: string, opts: ReviewOptions, cwd = process.cwd()): Promise<Report> {
  return withGitBase(ref, file, cwd, async (oldPath, newPath, rel) => {
    const base = await compareFiles(oldPath, newPath, opts);
    const r = base.error ? base : await classifyReport(base, oldPath, newPath, opts);
    return { ...r, oldFile: `${ref.length === 40 ? ref.slice(0, 7) : ref}:${rel}`, newFile: rel };
  });
}
