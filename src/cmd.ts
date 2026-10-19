// Language-agnostic mode: run two versions of ANY program (Go, Rust, Python, Java, shell, ...)
// on the same cases and compare exit code, stdout, stderr and files written.
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { clip, firstTextDiff, normalizeText, shellQuote, toFunctionReports, type Item, type Normalizer } from "./blackbox.js";
import { withGitBaseDir } from "./git.js";
import type { Difference, DiffKind, Report } from "./types.js";

export interface CmdCase {
  name?: string;
  /** reports are grouped by this (default: first non-flag argument, i.e. the sub-command) */
  group?: string;
  args?: string[];
  stdin?: string;
  env?: Record<string, string>;
  /** files created in the working directory before the run */
  files?: Record<string, string>;
  /** matrix: every {placeholder} in args/stdin is replaced by each value (cartesian product) */
  vars?: Record<string, (string | number | boolean)[]>;
}

export interface CmdOptions {
  /** command line of the old version, e.g. "./old/tool" or "python old.py" */
  oldCmd: string;
  newCmd: string;
  cases: CmdCase[];
  /** directory the old / new command is run from (default: a fresh temp dir per case) */
  oldRoot?: string;
  newRoot?: string;
  /** directory copied into each case's working dir before running */
  fixtures?: string;
  timeoutMs?: number;
  normalize?: Normalizer[];
  /** compare files the program wrote (default true) */
  checkFiles?: boolean;
  /** run the old version twice and ignore cases whose output is not stable (default true) */
  flakeCheck?: boolean;
  maxCases?: number;
  concurrency?: number;
  maxExamples?: number;
}

interface Outcome {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  files: Record<string, string>;
  failed?: string;
}

export function expandCases(cases: CmdCase[], max = 500): CmdCase[] {
  const out: CmdCase[] = [];
  for (const c of cases) {
    if (!c.vars || !Object.keys(c.vars).length) {
      out.push(c);
      continue;
    }
    let combos: Record<string, string>[] = [{}];
    for (const [k, vs] of Object.entries(c.vars)) combos = combos.flatMap((acc) => vs.map((v) => ({ ...acc, [k]: String(v) })));
    for (const combo of combos) {
      const sub = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in combo ? combo[k]! : m));
      const { vars: _v, ...rest } = c;
      out.push({ ...rest, ...(c.args ? { args: c.args.map(sub) } : {}), ...(c.stdin !== undefined ? { stdin: sub(c.stdin) } : {}), name: `${c.name ?? ""}${c.name ? " " : ""}${Object.values(combo).join(",")}`.trim() });
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

function listFiles(dir: string): Record<string, string> {
  const res: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (Object.keys(res).length >= 50) return;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const buf = readFileSync(p);
        res[relative(dir, p)] = statSync(p).size > 20000 ? `<${statSync(p).size} bytes>` : buf.toString("utf8");
      }
    }
  };
  walk(dir);
  return res;
}

function runOnce(cmd: string, c: CmdCase, root: string | undefined, fixtures: string | undefined, timeoutMs: number, checkFiles: boolean): Promise<Outcome> {
  const cwd = mkdtempSync(join(tmpdir(), "bd-case-"));
  const runDir = root ?? cwd;
  try {
    if (fixtures) cpSync(fixtures, cwd, { recursive: true });
    for (const [f, content] of Object.entries(c.files ?? {})) {
      const p = join(cwd, f);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
    }
  } catch (e) {
    rmSync(cwd, { recursive: true, force: true });
    return Promise.resolve({ code: null, signal: null, timedOut: false, stdout: "", stderr: "", files: {}, failed: String((e as Error).message) });
  }
  // when run from a project root the temp dir is passed as $BD_WORKDIR so the program can still use a scratch dir
  const line = `${cmd} ${(c.args ?? []).map(shellQuote).join(" ")}`;
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", line], {
      cwd: runDir,
      env: { PATH: process.env.PATH ?? "", HOME: cwd, TMPDIR: cwd, BD_WORKDIR: cwd, TZ: "UTC", LC_ALL: "C.UTF-8", NO_COLOR: "1", TERM: "dumb", ...c.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    const cap = 200_000;
    const timer = setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), timeoutMs);
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < cap) stderr += d.toString(); });
    child.stdin.on("error", () => {});
    child.stdin.end(c.stdin ?? "");
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let files: Record<string, string> = {};
      if (checkFiles) try { files = listFiles(cwd); } catch { /* ignore */ }
      rmSync(cwd, { recursive: true, force: true });
      resolve({ code, signal, timedOut, stdout, stderr, files });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      resolve({ code: null, signal: null, timedOut: false, stdout: "", stderr: "", files: {}, failed: e.message });
    });
  });
}

function norm(o: Outcome, rules: Normalizer[], roots: string[]): Outcome {
  const lit: [string, string][] = roots.filter(Boolean).map((r) => [r, "<root>"]);
  const n = (s: string) => normalizeText(s, rules, lit);
  return { ...o, stdout: n(o.stdout), stderr: n(o.stderr), files: Object.fromEntries(Object.entries(o.files).map(([k, v]) => [k, n(v)])) };
}

const same = (a: Outcome, b: Outcome) => a.code === b.code && a.timedOut === b.timedOut && a.stdout === b.stdout && a.stderr === b.stderr && JSON.stringify(a.files) === JSON.stringify(b.files);

function compare(a: Outcome, b: Outcome, call: string): Difference | undefined {
  const mk = (kind: DiffKind, o: string, n: string): Difference => ({ kind, call, old: o, new: n });
  if (a.timedOut !== b.timedOut) return mk("timeout", a.timedOut ? "<timeout>" : `exit ${a.code}`, b.timedOut ? "<timeout>" : `exit ${b.code}`);
  if (a.code !== b.code || a.signal !== b.signal) return mk("exit-code", `exit ${a.code ?? a.signal}${a.stderr ? ", stderr: " + clip(a.stderr.trim().split("\n").pop() ?? "", 100) : ""}`, `exit ${b.code ?? b.signal}${b.stderr ? ", stderr: " + clip(b.stderr.trim().split("\n").pop() ?? "", 100) : ""}`);
  if (a.stdout !== b.stdout) {
    const d = firstTextDiff(a.stdout, b.stdout);
    return mk("stdout", `stdout ${d.old}`, `stdout ${d.new}`);
  }
  if (a.stderr !== b.stderr) {
    const d = firstTextDiff(a.stderr, b.stderr);
    return mk("stderr", `stderr ${d.old}`, `stderr ${d.new}`);
  }
  const names = [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort();
  for (const f of names) {
    if (a.files[f] !== b.files[f]) {
      const d = firstTextDiff(a.files[f] ?? "", b.files[f] ?? "");
      return mk("files", a.files[f] === undefined ? `file ${f} not written` : `file ${f} ${d.old}`, b.files[f] === undefined ? `file ${f} not written` : `file ${f} ${d.new}`);
    }
  }
  return undefined;
}

async function mapLimit<T, R>(xs: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]!, k); } }));
  return out;
}

export async function compareCommands(opts: CmdOptions): Promise<Report> {
  const timeout = opts.timeoutMs ?? 10000;
  const cases = expandCases(opts.cases, opts.maxCases ?? 500);
  const rules = opts.normalize ?? [];
  const roots = [opts.oldRoot ?? "", opts.newRoot ?? ""];
  const base: Report = { oldFile: opts.oldCmd, newFile: opts.newCmd, functions: [], behaviorChanged: false };
  if (!cases.length) return { ...base, error: "no cases: provide a cases file (see docs/USAGE.md) or --case" };
  const items = await mapLimit(cases, opts.concurrency ?? 4, async (c): Promise<Item> => {
    const group = c.group ?? (c.args?.[0] ?? "(no args)");
    const call = `${opts.newCmd.split("/").pop()!.split(/\s+/)[0]} ${(c.args ?? []).map(shellQuote).join(" ")}${c.stdin ? `  <<< ${clip(c.stdin, 40)}` : ""}`.trim();
    const [ra, rb] = await Promise.all([
      runOnce(opts.oldCmd, c, opts.oldRoot, opts.fixtures, timeout, opts.checkFiles ?? true),
      runOnce(opts.newCmd, c, opts.newRoot, opts.fixtures, timeout, opts.checkFiles ?? true),
    ]);
    if (ra.failed || rb.failed) return { group, failed: ra.failed ?? rb.failed! };
    const a = norm(ra, rules, roots), b = norm(rb, rules, roots);
    if (same(a, b)) return { group };
    if (opts.flakeCheck !== false) {
      const again = norm(await runOnce(opts.oldCmd, c, opts.oldRoot, opts.fixtures, timeout, opts.checkFiles ?? true), rules, roots);
      if (!same(a, again)) return { group, nondeterministic: true };
    }
    const d = compare(a, b, call);
    return d ? { group, diff: d } : { group };
  });
  const functions = toFunctionReports(items, opts.maxExamples ?? 5);
  return { ...base, functions, behaviorChanged: functions.some((f) => f.status === "changed") };
}

/** Build and compare two git versions of a program: `ref` (old) vs the working tree (new). */
export async function compareCommandsGit(ref: string, o: { build?: string; cmd: string } & Omit<CmdOptions, "oldCmd" | "newCmd">, cwd = process.cwd()): Promise<Report> {
  return withGitBaseDir(ref, cwd, async (baseRoot, root) => {
    if (o.build) {
      for (const dir of [baseRoot, root]) {
        try {
          execFileSync("sh", ["-c", o.build], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], timeout: 600000 });
        } catch (e) {
          const msg = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split("\n").slice(-3).join(" | ");
          return { oldFile: ref, newFile: "working tree", functions: [], behaviorChanged: false, error: `build failed in ${dir === root ? "working tree" : "base " + ref}: ${msg}` };
        }
      }
    }
    const r = await compareCommands({ ...o, oldCmd: o.cmd, newCmd: o.cmd, oldRoot: baseRoot, newRoot: root });
    return { ...r, oldFile: `${ref}:${o.cmd}`, newFile: `working tree:${o.cmd}` };
  });
}

export function loadCases(path: string): CmdCase[] {
  if (!existsSync(path)) throw new Error(`cases file not found: ${path}`);
  const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const arr = Array.isArray(j) ? j : (j as { cases?: unknown }).cases;
  if (!Array.isArray(arr)) throw new Error(`${path}: expected a JSON array of cases or {"cases": [...]}`);
  return arr.map((c) => (typeof c === "string" ? { args: c.split(/\s+/).filter(Boolean) } : (c as CmdCase)));
}
