import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** behaviordiff.config.json (all keys optional; CLI flags win). */
export interface FileConfig {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  maxInputs?: number;
  timeoutMs?: number;
  /** extra files (tests) whose literals become inputs; neighbouring test files are found automatically */
  seed?: string[];
  /** exported functions to skip */
  ignore?: string[];
  /** your own argument lists per exported function: {"parseDuration": [["1h"], ["90m", {"long": true}]]} */
  inputs?: Record<string, unknown[][]>;
  provider?: string;
  model?: string;
  baseUrl?: string;
  maxCost?: number;
  redactSource?: boolean;
}

export const CONFIG_NAMES = ["behaviordiff.config.json", ".behaviordiffrc.json"];

export function loadConfig(cwd: string, explicit?: string): FileConfig {
  const path = explicit ?? CONFIG_NAMES.map((n) => join(cwd, n)).find(existsSync);
  if (!path) return {};
  if (!existsSync(path)) throw new Error(`config file not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch (e) {
    throw new Error(`cannot parse ${path}: ${(e as Error).message}`);
  }
}
