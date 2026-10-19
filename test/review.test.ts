import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMessages, parseReview, resolveConfig, reviewFiles } from "../dist/src/index.js";

let server: Server;
let base: string;
let handler: (body: any) => { content: string; usage?: any; status?: number };
const seen: any[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = JSON.parse(b);
      seen.push({ body, auth: req.headers.authorization });
      const r = handler(body);
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: r.content } }], usage: r.usage ?? { prompt_tokens: 1000, completion_tokens: 50 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());

function pair(o: string, n: string) {
  const d = mkdtempSync(join(tmpdir(), "bdrev-"));
  writeFileSync(join(d, "o.ts"), o);
  writeFileSync(join(d, "n.ts"), n);
  return { d, o: join(d, "o.ts"), n: join(d, "n.ts") };
}
const cfg = (extra = {}) => ({ ...resolveConfig({ baseUrl: base, model: "test-model", apiKey: "sk-test" }), ...extra });

describe("parseReview", () => {
  it("handles fences, think blocks and prose", () => {
    expect(parseReview('<think>hmm {"verdict":"intended"}</think>\n```json\n{"verdict":"Unintended","reason":"r","unexplained":["x"]}\n```')).toEqual({ verdict: "unintended", reason: "r", unexplained: ["x"] });
    expect(parseReview('Sure! {"verdict":"intended","reason":"ok"} done')?.verdict).toBe("intended");
    expect(parseReview("no json")).toBeUndefined();
    expect(parseReview('{"verdict":"maybe"}')).toBeUndefined();
  });
});

describe("resolveConfig", () => {
  it("requires a key for remote endpoints but not localhost", () => {
    expect(() => resolveConfig({ provider: "openrouter", model: "m" }, {})).toThrow(/API key/);
    expect(resolveConfig({ provider: "ollama", model: "m" }, {}).baseUrl).toBe("http://localhost:11434/v1");
    expect(resolveConfig({}, { LLM_PROVIDER: "deepseek", LLM_MODEL: "m", LLM_API_KEY: "k" }).baseUrl).toBe("https://api.deepseek.com");
  });
});

describe("review pipeline", () => {
  it("sends intent + sources + evidence, only for changed functions, and records the verdict", async () => {
    seen.length = 0;
    handler = () => ({ content: '{"verdict":"intended","reason":"threshold moved as described"}' });
    const { d, o, n } = pair(
      "export const ship = (t: number) => (t >= 50 ? 0 : 5);\nexport const same = (x: number) => x;",
      "export const ship = (t: number) => (t >= 75 ? 0 : 5);\nexport const same = (x: number) => x;",
    );
    const r = await reviewFiles(o, n, { intent: "Raise free shipping from 50 to 75", llm: cfg() });
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe("Bearer sk-test");
    const prompt = seen[0].body.messages.map((m: any) => m.content).join("\n");
    expect(prompt).toContain("Raise free shipping from 50 to 75");
    expect(prompt).toContain("t >= 50");
    expect(prompt).toContain("t >= 75");
    expect(prompt).toContain("ship(50)");
    expect(r.functions.find((f) => f.name === "ship")!.review?.verdict).toBe("intended");
    expect(r.functions.find((f) => f.name === "same")!.review).toBeUndefined();
    expect(r.attention).toBe(0);
    expect(r.llm!.calls).toBe(1);
    rmSync(d, { recursive: true });
  });

  it("flags unintended changes and counts attention", async () => {
    handler = () => ({ content: '{"verdict":"unintended","reason":"empty input now NaN","unexplained":["avg([]) NaN"]}' });
    const { d, o, n } = pair(
      "export const avg = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);",
      "export const avg = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;",
    );
    const r = await reviewFiles(o, n, { intent: "simplify avg", llm: cfg() });
    expect(r.attention).toBe(1);
    expect(r.functions[0]!.review?.unexplained?.[0]).toContain("NaN");
    rmSync(d, { recursive: true });
  });

  it("stops at the spend cap and marks the rest unclassified", async () => {
    handler = () => ({ content: '{"verdict":"intended","reason":"ok"}', usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } });
    const mk = (i: number) => `export const f${i} = (x: number) => x + ${i};`;
    const mk2 = (i: number) => `export const f${i} = (x: number) => x + ${i} + 1;`;
    const { d, o, n } = pair([1, 2, 3, 4].map(mk).join("\n"), [1, 2, 3, 4].map(mk2).join("\n"));
    const r = await reviewFiles(o, n, { intent: "x", llm: cfg({ priceInPerM: 1 }), maxCostUsd: 1.5, concurrency: 1 });
    const v = r.functions.map((f) => f.review?.verdict);
    expect(v.filter((x) => x === "intended")).toHaveLength(2); // $1 + $1 crosses $1.5
    expect(v.filter((x) => x === "unclassified")).toHaveLength(2);
    expect(r.llm!.skipped).toBe(2);
    expect(r.llm!.costUsd).toBeCloseTo(2);
    expect(r.attention).toBe(2);
    rmSync(d, { recursive: true });
  });

  it("retries once on invalid JSON, then degrades to unclear instead of crashing", async () => {
    let calls = 0;
    handler = () => (calls++, { content: "I think it is fine." });
    const { d, o, n } = pair("export const f = (x: number) => x;", "export const f = (x: number) => x + 1;");
    const r = await reviewFiles(o, n, { intent: "x", llm: cfg() });
    expect(calls).toBe(2);
    expect(r.functions[0]!.review?.verdict).toBe("unclear");
    expect(r.attention).toBe(1);
    rmSync(d, { recursive: true });
  });

  it("survives HTTP errors without leaking the key", async () => {
    handler = () => ({ content: "bad key sk-test", status: 401 });
    const { d, o, n } = pair("export const f = (x: number) => x;", "export const f = (x: number) => x + 1;");
    const r = await reviewFiles(o, n, { intent: "x", llm: cfg() });
    const rv = r.functions[0]!.review!;
    expect(rv.verdict).toBe("unclear");
    expect(rv.reason).toContain("401");
    expect(rv.reason).not.toContain("sk-test");
    expect(r.llm!.errors).toBe(1);
    rmSync(d, { recursive: true });
  });

  it("keeps the stable instructions first in the prompt (cache-friendly)", () => {
    const a = buildMessages({ intent: "a", fn: { name: "f", status: "changed", tested: 1, differing: 1, kinds: {}, examples: [] } });
    const b = buildMessages({ intent: "b", fn: { name: "g", status: "changed", tested: 1, differing: 1, kinds: {}, examples: [] } });
    expect(a[0]).toEqual(b[0]);
    expect(a[1]!.content).not.toEqual(b[1]!.content);
  });
});

describe("failure reporting", () => {
  it("records sample error messages so a broken key is diagnosable", async () => {
    handler = () => ({ content: '{"error":"User not found."}', status: 401 });
    const { d, o, n } = pair("export const f = (x: number) => x;", "export const f = (x: number) => x + 1;");
    const r = await reviewFiles(o, n, { intent: "x", llm: cfg() });
    expect(r.llm!.errorSamples![0]).toContain("401");
    expect(JSON.stringify(r)).not.toContain("sk-test");
    rmSync(d, { recursive: true });
  });
});
