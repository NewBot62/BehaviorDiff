import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const server = join(process.cwd(), "dist", "src", "mcp.js");

function rpc(cwd: string, reqs: object[]): Promise<Record<number, any>> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [server], { cwd, stdio: ["pipe", "pipe", "inherit"] });
    const out: Record<number, any> = {};
    let buf = "";
    p.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = JSON.parse(line);
        out[m.id] = m;
        if (Object.keys(out).length === reqs.filter((r: any) => r.id !== undefined).length) (p.kill(), resolve(out));
      }
    });
    p.on("error", reject);
    for (const r of reqs) p.stdin.write(JSON.stringify(r) + "\n");
    setTimeout(() => (p.kill(), reject(new Error("mcp timeout"))), 60000);
  });
}

describe("mcp server", () => {
  it("lists tools and reports a behavior change in a git repo", async () => {
    const d = mkdtempSync(join(tmpdir(), "bdmcp-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    writeFileSync(join(d, "a.ts"), "export const f = (n: number) => n + 1;\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    writeFileSync(join(d, "a.ts"), "export const f = (n: number) => n + 2;\n");
    const r = await rpc(d, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "behavior_diff_changed", arguments: { base: "HEAD" } } },
    ]);
    expect(r[1].result.serverInfo.name).toBe("behaviordiff");
    expect(r[2].result.tools.map((t: any) => t.name)).toEqual(["behavior_diff_changed", "behavior_diff_files", "behavior_diff_package", "behavior_diff_command", "behavior_diff_http"]);
    const t = r[3].result.content[0].text as string;
    expect(t).toContain("behavior changed in 1");
    expect(t).toContain("f(");
    rmSync(d, { recursive: true, force: true });
  });
});
