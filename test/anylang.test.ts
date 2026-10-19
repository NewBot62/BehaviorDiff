import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareCommands, compareFiles, compareHttp, diffJson, expandCases, fromHar, fromOpenApi } from "../dist/src/index.js";

const hasPython = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function tmp() {
  return mkdtempSync(join(tmpdir(), "bdany-"));
}

describe.skipIf(!hasPython)("python functions", () => {
  const OLD = `
from dataclasses import dataclass
def discount(price: float, age: int) -> float:
    return price * 0.9 if age >= 65 else price
def avg(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0
def same(s: str) -> str:
    return s.strip()
def evil(x: int) -> str:
    try:
        open("/tmp/bd-should-not-exist.txt", "w").write("x")
        return "wrote"
    except PermissionError:
        return "blocked"
class Cart:
    def __init__(self):
        self.items = []
    def add(self, name: str):
        self.items.append(name)
        return len(self.items)
`;
  it("finds changed return values, thresholds, empty-list behavior and state order", async () => {
    const d = tmp();
    writeFileSync(join(d, "old.py"), OLD);
    writeFileSync(join(d, "new.py"), OLD.replace("age >= 65", "age > 65").replace("if xs else 0", "if xs else float('nan')").replace("self.items.append(name)", "self.items.insert(0, name)"));
    const r = await compareFiles(join(d, "old.py"), join(d, "new.py"));
    const f = (n: string) => r.functions.find((x) => x.name === n)!;
    expect(f("discount").status).toBe("changed");
    expect(f("discount").examples.some((e) => e.call.includes("65"))).toBe(true);
    expect(f("avg").status).toBe("changed");
    expect(f("same").status).toBe("unchanged");
    expect(f("Cart#add").status).toBe("changed");
    expect(f("evil").status).toBe("unchanged"); // blocked in both, nothing written
    rmSync(d, { recursive: true });
  });
});

describe("cmd mode (any language)", () => {
  it("expands matrices", () => {
    expect(expandCases([{ args: ["{a}", "{b}"], vars: { a: [1, 2], b: ["x"] } }]).map((c) => c.args)).toEqual([["1", "x"], ["2", "x"]]);
  });
  it("compares exit code, stdout, stderr and files; ignores flaky output", async () => {
    const d = tmp();
    const mk = (name: string, body: string) => {
      writeFileSync(join(d, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(d, name), 0o755);
      return join(d, name);
    };
    const a = mk("a", 'case "$1" in greet) echo "hello $2";; fail) echo oops >&2; exit 1;; file) echo v1 > out.txt;; rnd) head -c4 /dev/urandom | od -An -tx1;; same) echo same;; esac');
    const b = mk("b", 'case "$1" in greet) echo "Hello $2";; fail) echo oops >&2; exit 2;; file) echo v2 > out.txt;; rnd) head -c4 /dev/urandom | od -An -tx1;; same) echo same;; esac');
    const r = await compareCommands({ oldCmd: a, newCmd: b, cases: [{ args: ["greet", "bob"] }, { args: ["fail"] }, { args: ["file"] }, { args: ["rnd"] }, { args: ["same"] }] });
    const f = (n: string) => r.functions.find((x) => x.name === n)!;
    expect(f("greet").kinds.stdout).toBe(1);
    expect(f("fail").kinds["exit-code"]).toBe(1);
    expect(f("file").kinds.files).toBe(1);
    expect(f("same").status).toBe("unchanged");
    expect(f("rnd").status).toBe("unchanged"); // output differs run to run: ignored, not reported
    expect(f("rnd").note).toMatch(/ignored/);
    rmSync(d, { recursive: true });
  });
});

describe("http mode (any language)", () => {
  it("diffs JSON bodies by path and ignores volatile fields", () => {
    const ds = diffJson({ a: 1, b: { c: [1, 2] }, id: "x" }, { a: 2, b: { c: [1, 3, 4] }, id: "y", n: 1 }, (p, k) => k === "id");
    expect(ds.map((d) => `${d.what}:${d.path}`)).toEqual(["changed:$.a", "changed:$.b.c[1]", "added:$.b.c[2]", "added:$.n"]);
  });
  it("builds requests from OpenAPI and HAR", () => {
    const reqs = fromOpenApi({ paths: { "/u/{id}": { get: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }, { name: "sort", in: "query", schema: { enum: ["asc", "desc"] } }] } } } });
    expect(reqs[0]!.path).toBe("/u/1");
    expect(reqs.some((r) => r.path.includes("sort=desc"))).toBe(true);
    const har = fromHar({ log: { entries: [{ request: { method: "GET", url: "http://h/x?y=1", headers: [{ name: "Cookie", value: "s" }] } }] } });
    expect(har).toEqual([{ method: "GET", path: "/x?y=1" }]);
  });
  it("compares two live servers", async () => {
    const d = tmp();
    const srv = (v: string) =>
      writeFileSync(join(d, `s${v}.mjs`), `import http from "node:http"; http.createServer((q,r)=>{ if(q.url==="/a"){r.setHeader("content-type","application/json"); r.end(JSON.stringify({total:${v==="1"?1:2}, rid: Math.random()}));} else {r.statusCode=${v==="1"?404:410}; r.end("x");}}).listen(process.env.PORT)`);
    srv("1");
    srv("2");
    const r = await compareHttp({ oldUrl: "", newUrl: "", oldStart: `node ${join(d, "s1.mjs")}`, newStart: `node ${join(d, "s2.mjs")}`, requests: [{ path: "/a" }, { path: "/b" }, { method: "POST", path: "/a" }] });
    const f = (n: string) => r.functions.find((x) => x.name === n)!;
    expect(f("GET /a").kinds.body).toBe(1);
    expect(f("GET /a").examples[0]!.old).toContain("$.total = 1");
    expect(f("GET /b").kinds.status).toBe(1);
    expect(f("GET /a").note).toMatch(/skipped/); // POST not sent without --allow-unsafe
    rmSync(d, { recursive: true });
  }, 60000);
});
