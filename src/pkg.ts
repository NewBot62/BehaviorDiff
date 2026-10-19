// Compare two published versions of an npm package: "what changed in behavior in this upgrade?"
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareFiles } from "./engine.js";
import { classifyReport } from "./review.js";
import type { LlmConfig } from "./llm.js";
import type { CompareOptions, Report } from "./types.js";

/** "lodash@4.17.20" -> {name:"lodash", version:"4.17.20"}; "@scope/pkg@1.0.0" works too. */
export function parseSpec(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: "latest" };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) || "latest" };
}

function pickExport(e: unknown, depth = 0): string | undefined {
  if (typeof e === "string") return e;
  if (!e || typeof e !== "object" || depth > 4) return undefined;
  const o = e as Record<string, unknown>;
  for (const k of ["import", "node", "default", "require", "module"]) {
    const r = pickExport(o[k], depth + 1);
    if (r) return r;
  }
  return undefined;
}

/** Entry file of an installed package (exports["."], module, main, index.js). */
export function entryOf(pkgDir: string): string {
  const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
  const ex = pj.exports as Record<string, unknown> | string | undefined;
  const fromExports = typeof ex === "string" ? ex : ex && typeof ex === "object" ? pickExport("." in ex ? ex["."] : ex) : undefined;
  const rel = fromExports ?? (typeof pj.module === "string" ? pj.module : undefined) ?? (typeof pj.main === "string" ? pj.main : undefined) ?? "index.js";
  for (const c of [rel, `${rel}.js`, join(rel, "index.js")]) {
    const p = join(pkgDir, c);
    if (existsSync(p) && !/\.d\.ts$/.test(p) && /\.(c|m)?js$/.test(p)) return p;
  }
  throw new Error(`cannot find a JavaScript entry for ${String(pj.name)}@${String(pj.version)} (looked at ${rel})`);
}

function install(spec: string, dir: string): { dir: string; version: string } {
  const { name, version } = parseSpec(spec);
  execFileSync("npm", ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--loglevel=error", `${name}@${version}`], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const pkgDir = join(dir, "node_modules", name);
  const v = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string }).version;
  return { dir: pkgDir, version: v };
}

export interface PkgOptions extends CompareOptions {
  intent?: string;
  llm?: LlmConfig;
  maxCostUsd?: number;
  redactSource?: boolean;
}

export async function comparePackages(oldSpec: string, newSpec: string, opts: PkgOptions = {}): Promise<Report> {
  const tmp = mkdtempSync(join(tmpdir(), "behaviordiff-pkg-"));
  try {
    const a = install(oldSpec, join(tmp, "old"));
    const b = install(newSpec, join(tmp, "new"));
    const oldEntry = entryOf(a.dir);
    const newEntry = entryOf(b.dir);
    const name = parseSpec(oldSpec).name;
    let rep = await compareFiles(oldEntry, newEntry, opts);
    rep = { ...rep, oldFile: `${name}@${a.version}`, newFile: `${name}@${b.version}` };
    if (opts.intent && opts.llm && rep.functions.some((f) => f.status === "changed" || f.status === "removed")) {
      const { intent, llm } = opts;
      rep = await classifyReport(rep, oldEntry, newEntry, { ...opts, intent, llm });
    }
    return rep;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
