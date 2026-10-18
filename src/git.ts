import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { compareFiles } from "./engine.js";
import type { CompareOptions, Report } from "./types.js";

/** Compare `file` as of git `ref` against the working-tree version. */
export async function compareGitRef(ref: string, file: string, opts: CompareOptions = {}, cwd = process.cwd()): Promise<Report> {
  const git = (...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const root = git("rev-parse", "--show-toplevel");
  const rel = relative(root, resolve(cwd, file));
  const dir = mkdtempSync(join(tmpdir(), "behaviordiff-base-"));
  const wt = join(dir, "base");
  try {
    git("worktree", "add", "--detach", wt, ref);
    if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(wt, "node_modules"), "dir");
    const report = await compareFiles(join(wt, rel), join(root, rel), opts);
    return { ...report, oldFile: `${ref}:${rel}`, newFile: rel };
  } finally {
    try {
      git("worktree", "remove", "--force", wt);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
