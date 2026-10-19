// Python backend: the runner is src/py/runner.py (same JSON-lines protocol as the Node runner).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Analysis, FnSig } from "./analyze.js";
import type { Launcher } from "./engine.js";

const here = dirname(fileURLToPath(import.meta.url));
export const PY_RUNNER = [join(here, "py", "runner.py"), join(here, "..", "..", "src", "py", "runner.py"), join(here, "..", "src", "py", "runner.py")].find(existsSync) ?? join(here, "py", "runner.py");

/** python executable: $BEHAVIORDIFF_PYTHON, ./.venv, $VIRTUAL_ENV, else python3 */
export function pythonBin(cwd = process.cwd()): string {
  if (process.env.BEHAVIORDIFF_PYTHON) return process.env.BEHAVIORDIFF_PYTHON;
  for (const p of [join(cwd, ".venv", "bin", "python"), join(cwd, "venv", "bin", "python"), process.env.VIRTUAL_ENV ? join(process.env.VIRTUAL_ENV, "bin", "python") : ""]) if (p && existsSync(p)) return p;
  return "python3";
}

export function pythonLauncher(): Launcher {
  const bin = pythonBin();
  return (args) => ({
    cmd: bin,
    argv: ["-B", "-s", PY_RUNNER, ...args],
    env: { PATH: process.env.PATH ?? "", PYTHONHASHSEED: "0", PYTHONDONTWRITEBYTECODE: "1", TZ: "UTC", LC_ALL: "C.UTF-8", PYTHONIOENCODING: "utf-8", ...(process.env.VIRTUAL_ENV ? { VIRTUAL_ENV: process.env.VIRTUAL_ENV } : {}) },
  });
}

export function pyAnalysis(line: Record<string, unknown>): Analysis {
  const sigs = new Map<string, FnSig>(Object.entries((line.sigs ?? {}) as Record<string, FnSig>));
  const sources = new Map<string, string>(Object.entries((line.sources ?? {}) as Record<string, string>));
  return { sigs, sources, numbers: (line.numbers ?? []) as number[], strings: (line.strings ?? []) as string[] };
}

export function pyConsts(file: string): { numbers: number[]; strings: string[] } {
  const out = execFileSync(pythonBin(), ["-B", "-s", PY_RUNNER, "consts", file], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out.trim().split("\n")[0]!) as { numbers: number[]; strings: string[] };
}

/** sources of every public function/method, for the LLM review */
export function pySources(file: string): Map<string, string> {
  try {
    const out = execFileSync(pythonBin(), ["-B", "-s", PY_RUNNER, "list", file], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
    return pyAnalysis(JSON.parse(out.trim().split("\n")[0]!) as Record<string, unknown>).sources;
  } catch {
    return new Map();
  }
}
