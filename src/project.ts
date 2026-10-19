// Whole-change review: every modified TS/JS file between a base and the working tree
// (or the staged files), in one go. Used by `behaviordiff --changed` / `--staged`.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { compareFiles } from "./engine.js";
import { withGitBaseDir } from "./git.js";
import { addUsage, emptyUsage, type LlmConfig, type Usage } from "./llm.js";
import { classifyReport } from "./review.js";
import { seedsFor } from "./seeds.js";
import type { CompareOptions, Report } from "./types.js";

export interface ProjectOptions extends CompareOptions {
  /** git ref to compare against (default: merge-base with origin/main|main|master, else HEAD) */
  base?: string;
  /** only staged files, compared HEAD vs working tree */
  staged?: boolean;
  /** extra glob-ish filters (substring or *.ext patterns) */
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  /** include seed files (neighbouring tests) automatically (default true) */
  autoSeed?: boolean;
  /** with an intent, label each change with an LLM */
  intent?: string;
  llm?: LlmConfig;
  maxCostUsd?: number;
  /** do not send function source to the model, only the observed differences */
  redactSource?: boolean;
}

export interface ProjectReport {
  base: string;
  files: Report[];
  skippedFiles: string[];
  behaviorChanged: boolean;
  /** changed functions the intent does not explain (only with an intent review) */
  attention?: number;
  llmUsage?: Usage;
  intent?: string;
}

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;
const SKIP = /((^|\/)(test_[^/]*|[^/]*_test|conftest|setup|manage|__init__|__main__)\.py$|(^|\/)(venv|\.venv|site-packages|migrations)\/|\.d\.ts$|\.test\.|\.spec\.|(^|\/)(node_modules|dist|build|coverage|__tests__|test|tests|__mocks__)\/|\.config\.|(^|\/)(vite|jest|webpack|rollup)\.)/;

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function defaultBase(cwd: string): string {
  for (const r of ["origin/main", "origin/master", "main", "master"]) {
    try {
      git(cwd, "rev-parse", "--verify", "--quiet", r);
      return git(cwd, "merge-base", r, "HEAD");
    } catch {
      /* try next */
    }
  }
  return "HEAD";
}

const matches = (f: string, pats: string[]) =>
  pats.some((p) => (p.startsWith("*.") ? f.endsWith(p.slice(1)) : f.includes(p.replace(/\*+/g, ""))));

export function changedFiles(cwd: string, base: string, o: Pick<ProjectOptions, "staged" | "include" | "exclude" | "maxFiles">): { files: string[]; skipped: string[] } {
  const args = o.staged ? ["diff", "--cached", "--name-only", "--diff-filter=M"] : ["diff", "--name-only", "--diff-filter=M", base];
  const all = git(cwd, ...args).split("\n").filter(Boolean);
  const files: string[] = [];
  const skipped: string[] = [];
  for (const f of all) {
    const ok = CODE.test(f) && !SKIP.test(f) && (!o.include?.length || matches(f, o.include)) && !(o.exclude?.length && matches(f, o.exclude));
    (ok ? files : skipped).push(f);
  }
  const max = o.maxFiles ?? 30;
  if (files.length > max) skipped.push(...files.splice(max).map((f) => `${f} (over the ${max}-file limit)`));
  return { files, skipped };
}

export function commitMessages(cwd: string, base: string): string {
  try {
    return git(cwd, "log", "--format=%s%n%b", `${base}..HEAD`).trim();
  } catch {
    return "";
  }
}

export async function reviewChanged(opts: ProjectOptions = {}, cwd = process.cwd()): Promise<ProjectReport> {
  const base = opts.base ?? (opts.staged ? "HEAD" : defaultBase(cwd));
  const { files, skipped } = changedFiles(cwd, base, opts);
  const reports: Report[] = [];
  const usage = emptyUsage();
  let attention = 0;
  await withGitBaseDir(base, cwd, async (baseRoot, root) => {
    for (const f of files) {
      const seeds = opts.autoSeed === false ? [] : seedsFor(join(root, f), root);
      const co: CompareOptions = { ...opts, seedFiles: [...(opts.seedFiles ?? []), ...seeds] };
      let rep = await compareFiles(join(baseRoot, f), join(root, f), co);
      rep = { ...rep, oldFile: `${base.length === 40 ? base.slice(0, 7) : base}:${f}`, newFile: f };
      if (opts.intent && opts.llm && rep.functions.some((x) => x.status === "changed" || x.status === "removed")) {
        const { intent, llm, maxCostUsd, redactSource } = opts;
        rep = await classifyReport(rep, join(baseRoot, f), join(root, f), { ...co, intent, llm, ...(maxCostUsd !== undefined ? { maxCostUsd: Math.max(0, maxCostUsd - usage.costUsd) } : {}), ...(redactSource ? { redactSource } : {}) });
        if (rep.llm) addUsage(usage, { calls: rep.llm.calls, promptTokens: rep.llm.promptTokens, completionTokens: rep.llm.completionTokens, costUsd: rep.llm.costUsd });
        attention += rep.attention ?? 0;
      }
      reports.push(rep);
    }
  });
  return {
    base,
    files: reports,
    skippedFiles: skipped,
    behaviorChanged: reports.some((r) => r.behaviorChanged),
    ...(opts.intent && opts.llm ? { attention, llmUsage: usage, intent: opts.intent } : {}),
  };
}

export function formatProjectText(p: ProjectReport, formatFile: (r: Report) => string): string {
  const changed = p.files.filter((r) => r.behaviorChanged || r.error);
  const L: string[] = [];
  L.push(`behaviordiff: ${p.files.length} modified file(s) vs ${p.base.length === 40 ? p.base.slice(0, 7) : p.base}; behavior changed in ${changed.length}`);
  for (const r of changed) L.push("", formatFile(r));
  if (p.skippedFiles.length) L.push("", `skipped (not source, tests, or over the limit): ${p.skippedFiles.join(", ")}`);
  if (p.attention !== undefined) L.push("", p.attention ? `${p.attention} change(s) are not explained by the stated intent.` : "All behavior changes match the stated intent.", p.llmUsage ? `model cost $${p.llmUsage.costUsd.toFixed(4)} (${p.llmUsage.calls} call(s))` : "");
  else if (!changed.length) L.push("", "No behavior difference found on generated inputs.");
  return L.join("\n");
}
