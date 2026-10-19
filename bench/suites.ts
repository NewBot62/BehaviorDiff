import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompareOptions } from "../src/index.js";

export type SuiteName = "main" | "hard" | "real";
export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bench");

export const SUITES: Record<SuiteName, { dir: string; baseline: string; prefix: string }> = {
  main: { dir: "cases", baseline: "baseline.json", prefix: "" },
  hard: { dir: "cases-hard", baseline: "baseline-hard.json", prefix: "hard-" },
  real: { dir: "cases-real", baseline: "baseline-real.json", prefix: "real-" },
};

export function suiteOf(arg: string | undefined): SuiteName {
  return arg === "hard" || arg === "real" ? arg : "main";
}

export interface CaseFiles {
  oldFile: string;
  newFile: string;
  opts: CompareOptions;
}

/** old.* / new.* in the case dir (ts or js); meta.seed lists extra files (tests) whose literals become inputs. */
export function caseFiles(dir: string, meta: { seed?: string[] }): CaseFiles {
  const find = (stem: string) => {
    const f = readdirSync(dir).find((n) => n.startsWith(stem + "."));
    if (!f) throw new Error(`${dir}: no ${stem}.* file`);
    return join(dir, f);
  };
  const seedFiles = (meta.seed ?? []).map((s) => join(dir, s)).filter(existsSync);
  return { oldFile: find("old"), newFile: find("new"), opts: seedFiles.length ? { seedFiles } : {} };
}

export const readMeta = <T,>(dir: string) => JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as T;
