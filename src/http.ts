// Language-agnostic mode: send the same HTTP requests to two versions of ANY web service
// and compare status, selected headers and the JSON/text body. Requests come from a list,
// a recorded HAR file or an OpenAPI spec.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { clip, firstTextDiff, normalizeText, toFunctionReports, type Item } from "./blackbox.js";
import { withGitBaseDir } from "./git.js";
import type { Difference, Report } from "./types.js";

export interface HttpReq {
  name?: string;
  group?: string;
  method?: string;
  /** path with optional query, e.g. "/users?limit=5" */
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpOptions {
  oldUrl: string;
  newUrl: string;
  /** commands that start each server; {port} / $PORT is the port to listen on */
  oldStart?: string;
  newStart?: string;
  oldCwd?: string;
  newCwd?: string;
  requests: HttpReq[];
  /** JSON keys ignored anywhere in bodies (e.g. "requestId,updatedAt") or exact paths like $.data[0].id */
  ignoreFields?: string[];
  /** response headers compared (default content-type, location, cache-control, content-disposition, allow, www-authenticate) */
  compareHeaders?: string[];
  /** also send POST/PUT/PATCH/DELETE (they change state on the servers!) */
  allowUnsafe?: boolean;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  concurrency?: number;
  maxRequests?: number;
  maxExamples?: number;
  startupTimeoutMs?: number;
}

interface Resp {
  status: number;
  headers: Record<string, string>;
  text: string;
  json?: unknown;
  error?: string;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_HEADERS = ["content-type", "location", "cache-control", "content-disposition", "allow", "www-authenticate"];

// ---------- request sources ----------

export async function loadRequests(src: { file?: string; har?: string; openapi?: string }): Promise<HttpReq[]> {
  const out: HttpReq[] = [];
  if (src.file) {
    const j = JSON.parse(readFileSync(src.file, "utf8")) as unknown;
    const arr = Array.isArray(j) ? j : (j as { requests?: unknown[] }).requests;
    if (!Array.isArray(arr)) throw new Error(`${src.file}: expected a JSON array of requests`);
    for (const r of arr) {
      if (typeof r === "string") {
        const m = /^(?:([A-Z]+)\s+)?(\S+)$/.exec(r.trim());
        if (m) out.push({ method: m[1] ?? "GET", path: m[2]! });
      } else out.push(r as HttpReq);
    }
  }
  if (src.har) out.push(...fromHar(JSON.parse(readFileSync(src.har, "utf8")) as Har));
  if (src.openapi) out.push(...fromOpenApi(JSON.parse(readFileSync(src.openapi, "utf8")) as Record<string, any>));
  if (!out.length) throw new Error("no requests: pass --requests <file.json>, --har <file.har> or --openapi <spec.json>");
  return out;
}

interface Har { log?: { entries?: { request: { method: string; url: string; headers?: { name: string; value: string }[]; postData?: { text?: string; mimeType?: string } } }[] } }

export function fromHar(h: Har): HttpReq[] {
  const keep = new Set(["content-type", "accept", "authorization", "x-api-key"]);
  const seen = new Set<string>();
  const out: HttpReq[] = [];
  for (const e of h.log?.entries ?? []) {
    const r = e.request;
    let u: URL;
    try { u = new URL(r.url); } catch { continue; }
    if (/\.(png|jpe?g|gif|svg|css|js|woff2?|ico|map)$/i.test(u.pathname)) continue;
    const headers: Record<string, string> = {};
    for (const x of r.headers ?? []) if (keep.has(x.name.toLowerCase())) headers[x.name.toLowerCase()] = x.value;
    let body: unknown;
    if (r.postData?.text) { try { body = JSON.parse(r.postData.text); } catch { body = r.postData.text; } }
    const req: HttpReq = { method: r.method.toUpperCase(), path: u.pathname + u.search, ...(Object.keys(headers).length ? { headers } : {}), ...(body !== undefined ? { body } : {}) };
    const key = JSON.stringify(req);
    if (!seen.has(key)) (seen.add(key), out.push(req));
  }
  return out;
}

type Spec = Record<string, any>;

function deref(spec: Spec, node: any, depth = 0): any {
  if (node && typeof node === "object" && typeof node.$ref === "string" && depth < 10) {
    const parts = node.$ref.replace(/^#\//, "").split("/").map((p: string) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    let cur: any = spec;
    for (const p of parts) cur = cur?.[p];
    return deref(spec, cur, depth + 1);
  }
  return node;
}

export function sample(spec: Spec, schemaIn: any, depth = 0): unknown {
  const s = deref(spec, schemaIn);
  if (!s || typeof s !== "object" || depth > 5) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.allOf)) return Object.assign({}, ...s.allOf.map((x: any) => sample(spec, x, depth + 1)));
  if (Array.isArray(s.oneOf) && s.oneOf.length) return sample(spec, s.oneOf[0], depth + 1);
  if (Array.isArray(s.anyOf) && s.anyOf.length) return sample(spec, s.anyOf[0], depth + 1);
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== "null") : s.type;
  switch (type) {
    case "string":
      switch (s.format) {
        case "date-time": return "2024-01-15T10:00:00Z";
        case "date": return "2024-01-15";
        case "uuid": return "123e4567-e89b-12d3-a456-426614174000";
        case "email": return "user@example.com";
        case "uri": case "url": return "https://example.com/x";
        default: return "x".repeat(Math.max(1, Math.min(s.minLength ?? 1, 20)));
      }
    case "integer": return s.minimum ?? 1;
    case "number": return s.minimum ?? 1.5;
    case "boolean": return true;
    case "array": return [sample(spec, s.items, depth + 1)];
    case "object":
    default: {
      if (!s.properties) return type === "object" ? {} : null;
      const req = new Set<string>(s.required ?? []);
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries<any>(s.properties)) if (req.has(k) || depth < 2) o[k] = sample(spec, v, depth + 1);
      return o;
    }
  }
}

export function fromOpenApi(spec: Spec, allowUnsafeToo = true): HttpReq[] {
  const out: HttpReq[] = [];
  for (const [path, item0] of Object.entries<any>(spec.paths ?? {})) {
    const item = deref(spec, item0);
    for (const method of ["get", "head", "post", "put", "patch", "delete"]) {
      const op = deref(spec, item?.[method]);
      if (!op) continue;
      if (!allowUnsafeToo && !SAFE.has(method.toUpperCase())) continue;
      const params: any[] = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(spec, p));
      const group = `${method.toUpperCase()} ${path}`;
      const variants: { name: string; override?: { p: any; v: unknown } }[] = [{ name: "baseline" }];
      for (const p of params) {
        if (p.in !== "query" && p.in !== "path") continue;
        const sch = deref(spec, p.schema) ?? {};
        const alts: unknown[] = Array.isArray(sch.enum) ? sch.enum.slice(1, 4) : [];
        if (typeof sch.minimum === "number") alts.push(sch.minimum - 1, sch.minimum);
        if (typeof sch.maximum === "number") alts.push(sch.maximum, sch.maximum + 1);
        if (sch.type === "string" && p.in === "query") alts.push("");
        for (const v of alts.slice(0, 4)) variants.push({ name: `${p.name}=${String(v)}`, override: { p, v } });
      }
      for (const vr of variants.slice(0, 8)) {
        let url = path;
        const query: string[] = [];
        for (const p of params) {
          const val = vr.override && vr.override.p === p ? vr.override.v : (p.example ?? sample(spec, p.schema ?? { type: "string" }));
          if (p.in === "path") url = url.replace(`{${p.name}}`, encodeURIComponent(String(val)));
          else if (p.in === "query" && (p.required || vr.override?.p === p || p.example !== undefined)) query.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(String(val))}`);
        }
        const req: HttpReq = { group, method: method.toUpperCase(), path: url + (query.length ? "?" + query.join("&") : "") };
        const content = deref(spec, op.requestBody)?.content;
        if (content) {
          const json = content["application/json"] ?? Object.values<any>(content)[0];
          if (json) { req.body = sample(spec, json.schema); req.headers = { "content-type": "application/json" }; }
        }
        out.push(req);
      }
    }
  }
  return out;
}

// ---------- servers ----------

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((res) => {
    const c = net.connect(port, "127.0.0.1");
    c.on("connect", () => (c.destroy(), res(true)));
    c.on("error", () => res(false));
  });
}

export interface Server { url: string; stop(): void }

export async function startServer(cmd: string, cwd: string | undefined, timeoutMs = 60000): Promise<Server> {
  const port = await freePort();
  const line = cmd.replace(/\{port\}/g, String(port));
  const child: ChildProcess = spawn("sh", ["-c", line], { cwd, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let err = "";
  child.stderr?.on("data", (d: Buffer) => { if (err.length < 3000) err += d.toString(); });
  child.stdout?.on("data", (d: Buffer) => { if (err.length < 3000) err += d.toString(); });
  let exited = false;
  child.on("exit", () => (exited = true));
  const stop = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } };
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (exited) throw new Error(`server exited during startup: ${err.trim().split("\n").slice(-3).join(" | ")}`);
    if (await canConnect(port)) return { url: `http://127.0.0.1:${port}`, stop };
    await new Promise((r) => setTimeout(r, 150));
  }
  stop();
  throw new Error(`server did not listen on port ${port} within ${timeoutMs / 1000}s (command must use $PORT or {port}): ${err.trim().split("\n").slice(-2).join(" | ")}`);
}

// ---------- comparison ----------

async function send(base: string, r: HttpReq, o: HttpOptions): Promise<Resp> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000);
  try {
    const headers: Record<string, string> = { ...o.extraHeaders, ...r.headers };
    let body: string | undefined;
    if (r.body !== undefined && !SAFE.has((r.method ?? "GET").toUpperCase())) {
      body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      if (typeof r.body !== "string" && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    }
    const res = await fetch(base.replace(/\/$/, "") + r.path, { method: r.method ?? "GET", headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: ctl.signal });
    const text = (await res.text()).slice(0, 1_000_000);
    const hs: Record<string, string> = {};
    res.headers.forEach((v, k) => (hs[k.toLowerCase()] = v));
    let json: unknown;
    if (/json/i.test(hs["content-type"] ?? "") || /^\s*[{[]/.test(text)) { try { json = JSON.parse(text); } catch { /* text */ } }
    return { status: res.status, headers: hs, text, ...(json !== undefined ? { json } : {}) };
  } catch (e) {
    return { status: 0, headers: {}, text: "", error: (e as Error).name === "AbortError" ? "timeout" : String((e as Error).message) };
  } finally {
    clearTimeout(timer);
  }
}

interface JDiff { path: string; old?: unknown; new?: unknown; what: "changed" | "added" | "removed" }

export function diffJson(a: unknown, b: unknown, ignore: (p: string, key: string) => boolean, path = "$", out: JDiff[] = [], limit = 200): JDiff[] {
  if (out.length >= limit) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length) out.push({ path: p, new: b[i], what: "added" });
      else if (i >= b.length) out.push({ path: p, old: a[i], what: "removed" });
      else diffJson(a[i], b[i], ignore, p, out, limit);
    }
  } else if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const A = a as Record<string, unknown>, B = b as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
      const p = `${path}.${k}`;
      if (ignore(p, k)) continue;
      if (!(k in A)) out.push({ path: p, new: B[k], what: "added" });
      else if (!(k in B)) out.push({ path: p, old: A[k], what: "removed" });
      else diffJson(A[k], B[k], ignore, p, out, limit);
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, old: a, new: b, what: "changed" });
  return out;
}

const js = (v: unknown) => clip(JSON.stringify(v) ?? "undefined", 60);

function summarize(ds: JDiff[]): { old: string; new: string } {
  const top = ds.slice(0, 3);
  const more = ds.length > 3 ? ` (+${ds.length - 3} more fields)` : "";
  return {
    old: top.map((d) => (d.what === "added" ? `${d.path} absent` : `${d.path} = ${js(d.old)}`)).join("; ") + more,
    new: top.map((d) => (d.what === "removed" ? `${d.path} absent` : `${d.path} = ${js(d.new)}`)).join("; ") + more,
  };
}

async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]!); } }));
  return out;
}

export async function compareHttp(opts: HttpOptions): Promise<Report> {
  const base: Report = { oldFile: opts.oldStart ?? opts.oldUrl, newFile: opts.newStart ?? opts.newUrl, functions: [], behaviorChanged: false };
  const servers: Server[] = [];
  try {
    let oldUrl = opts.oldUrl, newUrl = opts.newUrl;
    try {
      if (opts.oldStart) { const s = await startServer(opts.oldStart, opts.oldCwd, opts.startupTimeoutMs); servers.push(s); oldUrl = s.url; }
      if (opts.newStart) { const s = await startServer(opts.newStart, opts.newCwd, opts.startupTimeoutMs); servers.push(s); newUrl = s.url; }
    } catch (e) {
      return { ...base, error: (e as Error).message };
    }
    if (!oldUrl || !newUrl) return { ...base, error: "http needs --old <url> --new <url> (or --old-start/--new-start commands, or --base <ref> --start <command>)" };
    const reqs = opts.requests.filter((r) => opts.allowUnsafe || SAFE.has((r.method ?? "GET").toUpperCase())).slice(0, opts.maxRequests ?? 300);
    const skippedUnsafe = opts.requests.length - opts.requests.filter((r) => opts.allowUnsafe || SAFE.has((r.method ?? "GET").toUpperCase())).length;
    if (!reqs.length) return { ...base, error: "no safe requests to send (POST/PUT/PATCH/DELETE need --allow-unsafe: they change state on both servers)" };
    const userIgnore = (opts.ignoreFields ?? []);
    const names = new Set(userIgnore.filter((x) => !x.startsWith("$")));
    const paths = new Set(userIgnore.filter((x) => x.startsWith("$")));
    const hdrs = (opts.compareHeaders ?? DEFAULT_HEADERS).map((h) => h.toLowerCase());
    const items = await mapLimit(reqs, opts.concurrency ?? 4, async (r): Promise<Item> => {
      const method = (r.method ?? "GET").toUpperCase();
      const group = r.group ?? `${method} ${r.path.split("?")[0]!.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{24})(?=\/|$)/gi, "/{id}")}`;
      const call = `${method} ${r.path}`;
      const safe = SAFE.has(method);
      const a1 = await send(oldUrl, r, opts);
      const a2 = safe ? await send(oldUrl, r, opts) : undefined;
      const b = await send(newUrl, r, opts);
      if (a1.error && !b.error && a1.error !== "timeout") return { group, failed: `old server: ${a1.error}` };
      if (a1.error && b.error) return { group };
      const mk = (kind: Difference["kind"], o: string, n: string): Item => ({ group, diff: { kind, call, old: o, new: n } });
      if (a1.error || b.error) return mk("status", a1.error ? `<${a1.error}>` : `status ${a1.status}`, b.error ? `<${b.error}>` : `status ${b.status}`);
      if (a1.status !== b.status) return mk("status", `status ${a1.status}${a1.text ? " " + clip(a1.text, 60) : ""}`, `status ${b.status}${b.text ? " " + clip(b.text, 60) : ""}`);
      for (const h of hdrs) {
        const x = a1.headers[h], y = b.headers[h];
        if (x !== y && !(a2 && a2.headers[h] !== x)) return mk("headers", `${h}: ${x ?? "(absent)"}`, `${h}: ${y ?? "(absent)"}`);
      }
      // volatile = differs between two runs of the OLD server
      const volatile = new Set<string>();
      if (a2?.json !== undefined && a1.json !== undefined) for (const d of diffJson(a1.json, a2.json, () => false)) volatile.add(d.path);
      const ignore = (p: string, k: string) => names.has(k) || paths.has(p) || volatile.has(p);
      if (a1.json !== undefined && b.json !== undefined) {
        const ds = diffJson(a1.json, b.json, ignore);
        if (!ds.length) return { group };
        const s = summarize(ds);
        return mk("body", s.old, s.new);
      }
      const na = normalizeText(a1.text), nb = normalizeText(b.text);
      if (a2 && normalizeText(a2.text) !== na) return { group, nondeterministic: true };
      if (na !== nb) {
        const d = firstTextDiff(na, nb);
        return mk("body", `body ${d.old}`, `body ${d.new}`);
      }
      return { group };
    });
    const functions = toFunctionReports(items, opts.maxExamples ?? 5);
    if (skippedUnsafe && functions[0]) functions[0].note = [functions[0].note, `${skippedUnsafe} non-GET request(s) skipped (use --allow-unsafe)`].filter(Boolean).join("; ");
    return { ...base, functions, behaviorChanged: functions.some((f) => f.status === "changed") };
  } finally {
    for (const s of servers) s.stop();
  }
}

/** `ref` (old) vs working tree (new): optionally build both, start both servers, compare. */
export async function compareHttpGit(ref: string, o: { start: string; build?: string } & Omit<HttpOptions, "oldUrl" | "newUrl">, cwd = process.cwd()): Promise<Report> {
  return withGitBaseDir(ref, cwd, async (baseRoot, root) => {
    if (o.build) {
      for (const dir of [baseRoot, root]) {
        try {
          execFileSync("sh", ["-c", o.build], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], timeout: 600000 });
        } catch (e) {
          const msg = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim().split("\n").slice(-3).join(" | ");
          return { oldFile: ref, newFile: "working tree", functions: [], behaviorChanged: false, error: `build failed in ${dir === root ? "working tree" : "base " + ref}: ${msg}` };
        }
      }
    }
    const r = await compareHttp({ ...o, oldUrl: "", newUrl: "", oldStart: o.start, newStart: o.start, oldCwd: baseRoot, newCwd: root });
    return { ...r, oldFile: `${ref}:${o.start}`, newFile: `working tree:${o.start}` };
  });
}
