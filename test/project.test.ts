import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedFiles, reviewChanged } from "../dist/src/index.js";

const cli = join(process.cwd(), "dist", "src", "cli.js");

function repo() {
  const d = mkdtempSync(join(tmpdir(), "bdrepo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: d, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src", "price.ts"), "export function total(n: number): number { return n * 2; }\nexport function name(s: string): string { return s.trim(); }\n");
  writeFileSync(join(d, "src", "other.ts"), "export const same = (n: number) => n + 1;\n");
  writeFileSync(join(d, "src", "price.test.ts"), "import { total } from './price'; total(3);\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return { d, g };
}
const run = (d: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: d, encoding: "utf8" });

describe("whole-change review", () => {
  it("finds modified source files, skips tests, and reports only behavior changes", async () => {
    const { d, g } = repo();
    writeFileSync(join(d, "src", "price.ts"), "export function total(n: number): number { return n * 3; }\nexport function name(s: string): string { return s.trim(); }\n");
    writeFileSync(join(d, "src", "other.ts"), "export const same = (n: number) => 1 + n;\n"); // refactor
    writeFileSync(join(d, "src", "price.test.ts"), "import { total } from './price'; total(4);\n");
    const base = g("rev-parse", "HEAD").trim();
    const { files, skipped } = changedFiles(d, base, {});
    expect(files.sort()).toEqual(["src/other.ts", "src/price.ts"]);
    expect(skipped).toContain("src/price.test.ts");
    const r = await reviewChanged({ base }, d);
    expect(r.behaviorChanged).toBe(true);
    expect(r.files.find((f) => f.newFile === "src/price.ts")!.behaviorChanged).toBe(true);
    expect(r.files.find((f) => f.newFile === "src/other.ts")!.behaviorChanged).toBe(false);
    rmSync(d, { recursive: true, force: true });
  });

  it("CLI: --changed exits 1 on a change, --expect-no-change reports PASS for a refactor", () => {
    const { d, g } = repo();
    writeFileSync(join(d, "src", "other.ts"), "export const same = (n: number) => 1 + n;\n");
    const ok = run(d, "--expect-no-change", "--changed");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("REFACTOR CHECK PASSED");
    writeFileSync(join(d, "src", "price.ts"), "export function total(n: number): number { return n * 3; }\nexport function name(s: string): string { return s.trim(); }\n");
    const bad = run(d, "--expect-no-change", "--changed");
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("REFACTOR CHECK FAILED");
    expect(bad.stdout).toContain("total(");
    expect(run(d, "--changed", "--exit-zero").status).toBe(0);
    g("add", "src/price.ts");
    const staged = run(d, "--staged", "--format", "json");
    expect(JSON.parse(staged.stdout).files).toHaveLength(1);
    rmSync(d, { recursive: true, force: true });
  });

  it("config file: custom inputs and ignored functions", () => {
    const { d } = repo();
    writeFileSync(join(d, "src", "price.ts"), "export function total(n: number): number { return n === 12345 ? 0 : n * 2; }\nexport function name(s: string): string { return s.toUpperCase(); }\n");
    // blind generation never tries 12345 for a plain number param unless told
    writeFileSync(join(d, "behaviordiff.config.json"), JSON.stringify({ ignore: ["name"], inputs: { total: [[12345]] } }));
    const r = run(d, "--changed", "--format", "json");
    const rep = JSON.parse(r.stdout);
    const fns = rep.files[0].functions;
    expect(fns.find((f: { name: string }) => f.name === "name")).toBeUndefined();
    expect(fns.find((f: { name: string }) => f.name === "total").examples.some((e: { call: string }) => e.call === "total(12345)")).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
});
