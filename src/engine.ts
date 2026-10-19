import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { build } from "esbuild";
import { analyze, type Analysis, type FnSig } from "./analyze.js";
import { generateInputs, type GenCtx } from "./inputs.js";
import { canonical, decode, encode } from "./serialize.js";
import type { CompareOptions, Difference, DiffKind, FunctionReport, Report } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const RUNNER = existsSync(join(here, "runner.js")) ? join(here, "runner.js") : join(here, "..", "dist", "src", "runner.js");

type CallResult =
  | { ok: true; value: unknown; after: unknown; logs: unknown; state?: unknown; second?: unknown }
  | { ok: false; err: { name: string; message: string }; after: unknown; logs: unknown; state?: unknown }
  | { timeout: true }
  | { crash: string }
  | { skipped: true };

interface ExportInfo {
  name: string;
  arity: number;
  isClass: boolean;
}

interface ChildOutcome {
  lines: Record<string, unknown>[];
  hung: boolean;
  exitedCleanly: boolean;
  stderr: string;
}

function spawnRunner(args: string[], tmp: string, startupMs: number, callMs: number): Promise<ChildOutcome> {
  return new Promise((res) => {
    const child = spawn(
      process.execPath,
      ["--permission", `--allow-fs-read=${dirname(RUNNER)}`, `--allow-fs-read=${tmp}`, "--no-warnings", RUNNER, ...args],
      { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", TZ: "UTC" } },
    );
    const lines: Record<string, unknown>[] = [];
    let buf = "";
    let stderr = "";
    let hung = false;
    let ready = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        hung = true;
        child.kill("SIGKILL");
      }, ready ? callMs : startupMs);
    };
    arm();
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const o = JSON.parse(line) as Record<string, unknown>;
          if (o.ready) ready = true;
          lines.push(o);
          arm();
        } catch {
          /* ignore garbage */
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 2000) stderr += d.toString();
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      res({ lines, hung, exitedCleanly: code === 0 && !hung, stderr });
    });
  });
}

async function listExports(bundle: string, tmp: string): Promise<ExportInfo[]> {
  const r = await spawnRunner(["list", bundle], tmp, 10000, 10000);
  const line = r.lines.find((l) => "exports" in l || "fatal" in l);
  if (!line || "fatal" in line) {
    throw new Error(`could not load module: ${(line?.fatal as string) ?? (r.stderr.trim().split("\n")[0] || "no output")}`);
  }
  return line.exports as ExportInfo[];
}

async function execFunction(bundle: string, name: string, inputsFile: string, total: number, tmp: string, callMs: number): Promise<CallResult[]> {
  const results: CallResult[] = new Array(total);
  let next = 0;
  let restarts = 0;
  while (next < total) {
    const r = await spawnRunner(["run", bundle, name, inputsFile, String(next), String(callMs)], tmp, 10000, callMs + 500);
    let finished = false;
    for (const l of r.lines) {
      if (typeof l.i === "number") {
        results[l.i] = l.r as CallResult;
        next = Math.max(next, l.i + 1);
      } else if (l.done) finished = true;
      else if (l.fatal) {
        for (let i = next; i < total; i++) results[i] = { crash: String(l.fatal) };
        return results;
      }
    }
    if (finished || next >= total) break;
    results[next] = r.hung ? { timeout: true } : { crash: (r.stderr.trim().split("\n").slice(-1)[0] ?? "process exited").slice(0, 200) };
    next++;
    if (++restarts >= 5) {
      for (let i = next; i < total; i++) results[i] = { skipped: true };
      break;
    }
  }
  return results;
}

function diffKind(a: CallResult, b: CallResult): DiffKind | null {
  if ("skipped" in a || "skipped" in b) return null;
  if ("timeout" in a || "timeout" in b) return "timeout" in a && "timeout" in b ? null : "timeout";
  if ("crash" in a || "crash" in b) return "crash" in a && "crash" in b ? null : "crash";
  if (a.ok !== b.ok) return "threw-vs-returned";
  if (a.ok && b.ok) {
    if (canonical(a.value) !== canonical(b.value)) return "return-value";
    if (canonical(a.second) !== canonical(b.second)) return "return-value";
  } else if (!a.ok && !b.ok) {
    if (a.err.name !== b.err.name) return "error-type";
    if (a.err.message !== b.err.message) return "error-message";
  }
  if (canonical(a.after) !== canonical(b.after)) return "input-mutation";
  if (canonical(a.state) !== canonical(b.state)) return "state-change";
  if (canonical(a.logs) !== canonical(b.logs)) return "logs";
  return null;
}

function show(v: unknown): string {
  const s = inspect(v, { depth: 4, breakLength: Infinity, maxArrayLength: 8, maxStringLength: 80 });
  return s.length > 160 ? s.slice(0, 157) + "..." : s;
}

function describe(r: CallResult, kind: DiffKind, other?: CallResult): string {
  if ("timeout" in r) return "<timeout>";
  if ("crash" in r) return `<crash: ${r.crash}>`;
  if ("skipped" in r) return "<skipped>";
  if (!r.ok) return `throws ${r.err.name}: ${r.err.message}`;
  if (kind === "input-mutation") return `args after call: ${show(decode(r.after))}`;
  if (kind === "logs") return `logs: ${show(r.logs)}`;
  if (kind === "state-change") return `object state after call: ${show(decode(r.state))}`;
  if (kind === "return-value" && other && "ok" in other && other.ok && canonical(r.value) === canonical(other.value) && r.second !== undefined) return `${show(decode(r.value))}, and on a second call on the same object: ${show(decode(r.second))}`;
  return show(decode(r.value));
}

function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  const worker = async () => {
    while (i < xs.length) {
      const k = i++;
      out[k] = await f(xs[k]!);
    }
  };
  return Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker)).then(() => out);
}

async function bundleFile(entry: string, outfile: string): Promise<void> {
  await build({
    entryPoints: [resolve(entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile,
    logLevel: "silent",
    banner: { js: "import { createRequire as __bd_cr } from 'node:module'; const require = __bd_cr(import.meta.url);" },
  });
}

export async function compareFiles(oldFile: string, newFile: string, opts: CompareOptions = {}): Promise<Report> {
  const maxInputs = opts.maxInputs ?? 400;
  const callMs = opts.callTimeoutMs ?? 1500;
  const maxExamples = opts.maxExamples ?? 5;
  const base: Report = { oldFile, newFile, functions: [], behaviorChanged: false };
  const tmp = mkdtempSync(join(tmpdir(), "behaviordiff-"));
  try {
    const oldB = join(tmp, "old.mjs");
    const newB = join(tmp, "new.mjs");
    try {
      await bundleFile(oldFile, oldB);
    } catch (e) {
      return { ...base, error: `old version does not build: ${firstLine(e)}` };
    }
    try {
      await bundleFile(newFile, newB);
    } catch (e) {
      return { ...base, behaviorChanged: true, error: `new version does not build: ${firstLine(e)}` };
    }
    let oldEx: ExportInfo[], newEx: ExportInfo[];
    try {
      [oldEx, newEx] = await Promise.all([listExports(oldB, tmp), listExports(newB, tmp)]);
    } catch (e) {
      return { ...base, error: firstLine(e) };
    }
    const oldA = analyze(readFileSync(oldFile, "utf8"), basename(oldFile));
    const newA = analyze(readFileSync(newFile, "utf8"), basename(newFile));
    const seed = { numbers: [] as number[], strings: [] as string[] };
    for (const f of opts.seedFiles ?? []) {
      try {
        const a = analyze(readFileSync(f, "utf8"), basename(f), { maxStrings: 120, maxNumbers: 60, maxStringLength: 60 });
        seed.numbers.push(...a.numbers);
        seed.strings.push(...a.strings);
      } catch {
        /* unreadable seed file: ignore */
      }
    }
    const ctx: GenCtx = {
      numbers: [...new Set([...newA.numbers, ...oldA.numbers, ...seed.numbers])].slice(0, 80),
      strings: [...new Set([...newA.strings, ...oldA.strings, ...seed.strings])].slice(0, 150),
    };

    const names = [...new Set([...oldEx.map((e) => e.name), ...newEx.map((e) => e.name)])]
      .filter((n) => !opts.functions || opts.functions.includes(n))
      .filter((n) => !opts.ignore?.includes(n))
      .sort();

    const reports = await mapLimit(names, 3, async (name): Promise<FunctionReport> => {
      const o = oldEx.find((e) => e.name === name);
      const n = newEx.find((e) => e.name === name);
      const empty = { tested: 0, differing: 0, kinds: {}, examples: [] };
      if (!o) return { name, status: "added", ...empty };
      if (!n) return { name, status: "removed", ...empty, note: "export removed" };
      const hashAt = name.indexOf("#");
      let generated: unknown[][];
      if (hashAt > 0) {
        // instance method: every call is [constructor args, method args] on a fresh instance
        const cls = name.slice(0, hashAt);
        const co = oldEx.find((e) => e.name === cls), cn = newEx.find((e) => e.name === cls);
        const ctors = buildInputs(newA.sigs.get(cls), oldA.sigs.get(cls), cn?.arity ?? 0, co?.arity ?? 0, ctx, 8, `${cls}:ctor`);
        const margs = buildInputs(newA.sigs.get(name), oldA.sigs.get(name), n.arity, o.arity, ctx, maxInputs, name);
        generated = margs.map((m, k) => [ctors[k % Math.max(ctors.length, 1)] ?? [], m]);
      } else {
        generated = buildInputs(newA.sigs.get(name), oldA.sigs.get(name), n.arity, o.arity, ctx, maxInputs, name);
      }
      const mine = opts.customInputs?.[name] ?? [];
      const inputs = mine.length ? [...mine, ...generated] : generated;
      const inputsFile = join(tmp, `in-${name.replace(/\W/g, "_")}.json`);
      writeFileSync(inputsFile, JSON.stringify(inputs.map((a) => encode(a))));
      const [ro, rn] = await Promise.all([
        execFunction(oldB, name, inputsFile, inputs.length, tmp, callMs),
        execFunction(newB, name, inputsFile, inputs.length, tmp, callMs),
      ]);
      const kinds: FunctionReport["kinds"] = {};
      const diffs: (Difference & { sz: number })[] = [];
      let tested = 0;
      let oldErrors = 0;
      const distinct = new Set<string>();
      for (let i = 0; i < inputs.length; i++) {
        const a = ro[i]!, b = rn[i]!;
        if (!a || !b || "skipped" in a || "skipped" in b) continue;
        tested++;
        if ("ok" in a) {
          if (!a.ok) oldErrors++;
          distinct.add(canonical("value" in a ? a.value : a.err));
        }
        const k = diffKind(a, b);
        if (!k) continue;
        kinds[k] = (kinds[k] ?? 0) + 1;
        const inp = inputs[i] as unknown[];
        const call = hashAt > 0
          ? `new ${name.slice(0, hashAt)}(${(inp[0] as unknown[]).map(show).join(", ")}).${name.slice(hashAt + 1)}(${(inp[1] as unknown[]).map(show).join(", ")})`
          : n.isClass
            ? `new ${name}(${inp.map(show).join(", ")})`
            : `${name}(${inp.map(show).join(", ")})`;
        diffs.push({ kind: k, call, old: describe(a, k, b), new: describe(b, k, a), sz: call.length });
      }
      diffs.sort((x, y) => x.sz - y.sz);
      const examples: Difference[] = [];
      const seenKind = new Set<string>();
      for (const d of diffs) if (!seenKind.has(d.kind)) (seenKind.add(d.kind), examples.push(strip(d)));
      for (const d of diffs) if (examples.length < maxExamples && !examples.some((e) => e.call === d.call)) examples.push(strip(d));
      const notes: string[] = [];
      if (o.arity !== n.arity) notes.push(`arity changed ${o.arity} -> ${n.arity}`);
      if (tested >= 10 && oldErrors / tested >= 0.9) notes.push("low coverage: nearly all generated inputs made the function throw");
      else if (tested >= 10 && distinct.size <= 1 && diffs.length === 0) notes.push("low coverage: every input produced the same outcome");
      const rep: FunctionReport = {
        name,
        status: diffs.length ? "changed" : "unchanged",
        tested,
        differing: diffs.length,
        kinds,
        examples: examples.slice(0, maxExamples),
      };
      if (notes.length) rep.note = notes.join("; ");
      return rep;
    });
    const functions = reports;
    return {
      ...base,
      functions,
      behaviorChanged: functions.some((f) => f.status === "changed" || f.status === "removed"),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function strip(d: Difference & { sz?: number }): Difference {
  return { kind: d.kind, call: d.call, old: d.old, new: d.new };
}

function firstLine(e: unknown): string {
  return String((e as Error)?.message ?? e).split("\n").find((l) => l.trim()) ?? "unknown error";
}

function buildInputs(ns: FnSig | undefined, os: FnSig | undefined, nArity: number, oArity: number, ctx: GenCtx, max: number, name: string): unknown[][] {
  const first = generateInputs(ns, nArity, ctx, max, name);
  if (!os || (ns && JSON.stringify(ns.params) === JSON.stringify(os.params))) return first;
  const second = generateInputs(os, oArity, ctx, Math.floor(max / 2), name + ":old");
  const seen = new Set(first.map((a) => canonical(encode(a))));
  return [...first, ...second.filter((a) => !seen.has(canonical(encode(a))))];
}

export type { Analysis };
