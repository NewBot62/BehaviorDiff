import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareFiles, compareGitRef } from "../dist/src/index.js";
import { decode, encode } from "../dist/src/serialize.js";

function pair(oldSrc: string, newSrc: string, ext = "ts") {
  const d = mkdtempSync(join(tmpdir(), "bdtest-"));
  writeFileSync(join(d, `old.${ext}`), oldSrc);
  writeFileSync(join(d, `new.${ext}`), newSrc);
  return { d, o: join(d, `old.${ext}`), n: join(d, `new.${ext}`) };
}
const get = (r: Awaited<ReturnType<typeof compareFiles>>, name: string) => r.functions.find((f) => f.name === name)!;

describe("serialize", () => {
  it("round-trips awkward values", () => {
    const v = [NaN, -0, Infinity, undefined, 10n, new Date(0), new Map([[1, { a: 1 }]]), new Set([1, 2]), { $x: 1 }];
    const back = decode(JSON.parse(JSON.stringify(encode(v)))) as unknown[];
    expect(Object.is(back[0], NaN)).toBe(true);
    expect(Object.is(back[1], -0)).toBe(true);
    expect(back[3]).toBeUndefined();
    expect(back[4]).toBe(10n);
    expect((back[5] as Date).getTime()).toBe(0);
    expect((back[6] as Map<number, unknown>).get(1)).toEqual({ a: 1 });
    expect(back[8]).toEqual({ $x: 1 });
  });
  it("is key-order independent", () => {
    expect(JSON.stringify(encode({ a: 1, b: 2 }))).toBe(JSON.stringify(encode({ b: 2, a: 1 })));
  });
});

describe("engine", () => {
  it("reports no difference for equivalent code", async () => {
    const { d, o, n } = pair("export const f = (x: number) => x * 2;", "export function f(x: number) { return x + x; }");
    const r = await compareFiles(o, n);
    expect(get(r, "f").status).toBe("unchanged");
    expect(r.behaviorChanged).toBe(false);
    rmSync(d, { recursive: true });
  });

  it("finds a threshold change via literal harvesting", async () => {
    const { d, o, n } = pair("export const f = (a: number) => a >= 18;", "export const f = (a: number) => a > 18;");
    const f = get(await compareFiles(o, n), "f");
    expect(f.status).toBe("changed");
    expect(f.examples[0]!.call).toBe("f(18)");
    rmSync(d, { recursive: true });
  });

  it("detects input mutation, thrown errors and logs", async () => {
    const { d, o, n } = pair(
      `export const s = (a: number[]) => [...a].sort();
       export const t = (x: number) => x;
       export const l = (x: number) => x;`,
      `export const s = (a: number[]) => a.sort();
       export const t = (x: number) => { if (x < 0) throw new RangeError("neg"); return x; };
       export const l = (x: number) => { console.log("hi"); return x; };`,
    );
    const r = await compareFiles(o, n);
    expect(get(r, "s").kinds["input-mutation"]).toBeGreaterThan(0);
    expect(get(r, "t").kinds["threw-vs-returned"]).toBeGreaterThan(0);
    expect(get(r, "l").kinds["logs"]).toBeGreaterThan(0);
    rmSync(d, { recursive: true });
  });

  it("handles async functions", async () => {
    const { d, o, n } = pair("export async function f(x: number) { return x; }", "export async function f(x: number) { return x + 1; }");
    expect(get(await compareFiles(o, n), "f").status).toBe("changed");
    rmSync(d, { recursive: true });
  });

  it("is deterministic about time and randomness", async () => {
    const src = "export const f = (x: number) => [Math.random(), Date.now(), new Date().getFullYear(), x];";
    const { d, o, n } = pair(src, src);
    expect(get(await compareFiles(o, n), "f").status).toBe("unchanged");
    rmSync(d, { recursive: true });
  });

  it("survives an infinite loop in the new version", async () => {
    const { d, o, n } = pair(
      "export const f = (x: number) => x;",
      "export const f = (x: number) => { if (x === 5) { for (;;) {} } return x; };",
    );
    const f = get(await compareFiles(o, n, { callTimeoutMs: 300 }), "f");
    expect(f.status).toBe("changed");
    expect(f.kinds.timeout).toBeGreaterThan(0);
    rmSync(d, { recursive: true });
  }, 60000);

  it("survives process.exit in the new version", async () => {
    const { d, o, n } = pair("export const f = (x: number) => x;", "export const f = (x: number) => { if (x === 2) process.exit(3); return x; };");
    const f = get(await compareFiles(o, n), "f");
    expect(f.kinds.crash).toBeGreaterThan(0);
    rmSync(d, { recursive: true });
  }, 60000);

  it("blocks filesystem writes and child processes in code under test", async () => {
    const marker = join(tmpdir(), `bd-marker-${process.pid}`);
    const { d, o, n } = pair(
      "export const f = (x: number) => x;",
      `import { writeFileSync } from "node:fs";
       import { execSync } from "node:child_process";
       export const f = (x: number) => {
         try { writeFileSync(${JSON.stringify(marker)}, "pwned"); } catch {}
         try { execSync("touch ${marker}-exec"); } catch {}
         return x;
       };`,
    );
    await compareFiles(o, n);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(marker + "-exec")).toBe(false);
    rmSync(d, { recursive: true });
  });

  it("reports added/removed exports and build errors", async () => {
    const a = pair("export const a = (x: number) => x; export const gone = (x: number) => x;", "export const a = (x: number) => x; export const fresh = (x: number) => x;");
    const r = await compareFiles(a.o, a.n);
    expect(get(r, "gone").status).toBe("removed");
    expect(get(r, "fresh").status).toBe("added");
    expect(r.behaviorChanged).toBe(true);
    const b = pair("export const a = 1;", "export const a = ;");
    const r2 = await compareFiles(b.o, b.n);
    expect(r2.error).toMatch(/new version does not build/);
    rmSync(a.d, { recursive: true });
    rmSync(b.d, { recursive: true });
  });

  it("works on plain JavaScript", async () => {
    const { d, o, n } = pair("export function f(a, b) { return a + b; }", "export function f(a, b) { return a - b; }", "js");
    expect(get(await compareFiles(o, n), "f").status).toBe("changed");
    rmSync(d, { recursive: true });
  });
});

describe("git mode", () => {
  it("compares a ref against the working tree", async () => {
    const d = mkdtempSync(join(tmpdir(), "bdgit-"));
    const sh = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "pipe" });
    sh("init", "-q", "-b", "main");
    sh("config", "user.email", "t@example.invalid");
    sh("config", "user.name", "t");
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "src/m.ts"), "export const f = (x: number) => x * 2;\n");
    sh("add", ".");
    sh("commit", "-qm", "init");
    writeFileSync(join(d, "src/m.ts"), "export const f = (x: number) => x * 3;\n");
    const r = await compareGitRef("HEAD", "src/m.ts", {}, d);
    expect(r.oldFile).toBe("HEAD:src/m.ts");
    expect(get(r, "f").status).toBe("changed");
    expect(readFileSync(join(d, "src/m.ts"), "utf8")).toContain("x * 3");
    rmSync(d, { recursive: true, force: true });
  }, 60000);
});
