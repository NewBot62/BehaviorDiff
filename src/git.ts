import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { compareFiles } from "./engine.js";
import type { CompareOptions, Report } from "./types.js";

/** Check out `ref` into a temp worktree and call fn(oldPath, newPath, relPath); always cleans up. */
export async function withGitBase<T>(
  ref: string,
  file: string,
  cwd: string,
  fn: (oldPath: string, newPath: string, rel: string) => Promise<T>,
): Promise<T> {
  const git = (...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const root = git("rev-parse", "--show-toplevel");
  const rel = relative(root, resolve(cwd, file));
  const dir = mkdtempSync(join(tmpdir(), "behaviordiff-base-"));
  const wt = join(dir, "base");
  try {
    git("worktree", "add", "--detach", wt, ref);
    if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(wt, "node_modules"), "dir");
    return await fn(join(wt, rel), join(root, rel), rel);
  } finally {
    try {
      git("worktree", "remove", "--force", wt);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Check out `ref` once and call fn(baseRoot, repoRoot); always cleans up. For reviewing many files at once. */
export async function withGitBaseDir<T>(ref: string, cwd: string, fn: (baseRoot: string, repoRoot: string) => Promise<T>): Promise<T> {
  const git = (...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const root = git("rev-parse", "--show-toplevel");
  const dir = mkdtempSync(join(tmpdir(), "behaviordiff-base-"));
  const wt = join(dir, "base");
  try {
    git("worktree", "add", "--detach", wt, ref);
    if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(wt, "node_modules"), "dir");
    return await fn(wt, root);
  } finally {
    try {
      git("worktree", "remove", "--force", wt);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const short = (r: string) => (/^[0-9a-f]{40}$/.test(r) ? r.slice(0, 7) : r);

/** Compare `file` as of git `ref` against the working-tree version. */
export async function compareGitRef(ref: string, file: string, opts: CompareOptions = {}, cwd = process.cwd()): Promise<Report> {
  return withGitBase(ref, file, cwd, async (o, n, rel) => ({ ...(await compareFiles(o, n, opts)), oldFile: `${short(ref)}:${rel}`, newFile: rel }));
}
