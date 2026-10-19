#!/usr/bin/env node
// Minimal MCP server (stdio, JSON-RPC 2.0, newline-delimited) so coding agents can check their own edits:
// "did my refactor change behavior?" Tools: behavior_diff_changed, behavior_diff_files, behavior_diff_package.
import { createInterface } from "node:readline";
import { loadConfig } from "./config.js";
import { comparePackages } from "./pkg.js";
import { compareFiles } from "./engine.js";
import { formatMarkdown, formatText } from "./report.js";
import { formatProjectText, reviewChanged } from "./project.js";
import { reviewFiles } from "./review.js";
import { resolveConfig, type LlmConfig } from "./llm.js";
import type { Report } from "./types.js";

const TOOLS = [
  {
    name: "behavior_diff_changed",
    description:
      "Run the old and the new version of every modified TS/JS file in the git working tree on generated inputs and report which exported functions now behave differently (return values, thrown errors, mutation). Use it after refactoring or editing code to verify that behavior did not change unintentionally. With `intent` and an LLM configured it also says which differences the intent explains.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: "git ref to compare against (default: merge-base with main/master; use HEAD for uncommitted edits only)" },
        staged: { type: "boolean", description: "only staged files" },
        include: { type: "array", items: { type: "string" }, description: "only files whose path contains one of these strings" },
        intent: { type: "string", description: "what the change is supposed to do (optional, enables intended/unintended labels)" },
        cwd: { type: "string", description: "repository directory (default: the server's working directory)" },
      },
    },
  },
  {
    name: "behavior_diff_files",
    description: "Compare the behavior of two versions of one TS/JS module given as two file paths.",
    inputSchema: {
      type: "object",
      properties: { old_file: { type: "string" }, new_file: { type: "string" }, intent: { type: "string" } },
      required: ["old_file", "new_file"],
    },
  },
  {
    name: "behavior_diff_package",
    description: "Compare two published npm versions of a package (e.g. lodash@4.17.20 vs lodash@4.17.21): which exported functions behave differently after the upgrade.",
    inputSchema: {
      type: "object",
      properties: { old: { type: "string", description: "name@version" }, new: { type: "string", description: "name@version" } },
      required: ["old", "new"],
    },
  },
];

function llmFromEnv(): LlmConfig | undefined {
  if (!process.env.LLM_MODEL && !process.env.BEHAVIORDIFF_MODEL) return undefined;
  try {
    return resolveConfig({ ...(process.env.BEHAVIORDIFF_MODEL ? { model: process.env.BEHAVIORDIFF_MODEL } : {}), ...(process.env.BEHAVIORDIFF_PROVIDER ? { provider: process.env.BEHAVIORDIFF_PROVIDER } : {}) });
  } catch {
    return undefined;
  }
}

const text = (s: string, isError = false) => ({ content: [{ type: "text", text: s }], ...(isError ? { isError: true } : {}) });

async function callTool(name: string, a: Record<string, unknown>) {
  const llm = typeof a.intent === "string" && a.intent.trim() ? llmFromEnv() : undefined;
  const intent = llm ? String(a.intent) : undefined;
  const note = typeof a.intent === "string" && a.intent.trim() && !llm ? "\n\n(Intent given but no model configured: set BEHAVIORDIFF_MODEL and BEHAVIORDIFF_PROVIDER plus the provider's API key in the MCP server environment to get intended/unintended labels.)" : "";
  if (name === "behavior_diff_changed") {
    const cwd = typeof a.cwd === "string" ? a.cwd : process.cwd();
    const cfg = loadConfig(cwd);
    const rep = await reviewChanged(
      {
        ...(typeof a.base === "string" ? { base: a.base } : {}),
        ...(a.staged === true ? { staged: true } : {}),
        ...(Array.isArray(a.include) ? { include: a.include.map(String) } : cfg.include ? { include: cfg.include } : {}),
        ...(cfg.exclude ? { exclude: cfg.exclude } : {}),
        ...(cfg.ignore ? { ignore: cfg.ignore } : {}),
        ...(cfg.inputs ? { customInputs: cfg.inputs } : {}),
        ...(intent && llm ? { intent, llm } : {}),
      },
      cwd,
    );
    return text(formatProjectText(rep, formatText) + note);
  }
  if (name === "behavior_diff_files") {
    const o = String(a.old_file), n = String(a.new_file);
    const rep: Report = intent && llm ? await reviewFiles(o, n, { intent, llm }) : await compareFiles(o, n);
    return text(formatMarkdown(rep) + note);
  }
  if (name === "behavior_diff_package") {
    const rep = await comparePackages(String(a.old), String(a.new));
    return text(formatMarkdown(rep));
  }
  return text(`unknown tool ${name}`, true);
}

type Req = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

async function handle(r: Req) {
  const ok = (result: unknown) => r.id !== undefined && send({ jsonrpc: "2.0", id: r.id, result });
  const fail = (code: number, message: string) => r.id !== undefined && send({ jsonrpc: "2.0", id: r.id, error: { code, message } });
  try {
    switch (r.method) {
      case "initialize":
        return ok({ protocolVersion: (r.params?.protocolVersion as string) ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "behaviordiff", version: "0.1.0" } });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        const p = r.params ?? {};
        try {
          return ok(await callTool(String(p.name), (p.arguments as Record<string, unknown>) ?? {}));
        } catch (e) {
          return ok(text(`behaviordiff error: ${(e as Error).message}`, true));
        }
      }
      default:
        if (r.method.startsWith("notifications/")) return;
        return fail(-32601, `method not found: ${r.method}`);
    }
  } catch (e) {
    return fail(-32603, (e as Error).message);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let req: Req;
  try {
    req = JSON.parse(line) as Req;
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  void handle(req);
});
