// Runs inside a child process started with `node --permission` (no fs write,
// no child_process, no workers). Streams one JSON line per call to fd 1.
import { writeSync, readFileSync } from "node:fs";
import { format } from "node:util";
import { pathToFileURL } from "node:url";
import { encode, decode } from "./serialize.js";

function out(o: unknown): void {
  const line = JSON.stringify(o) + "\n";
  let off = 0;
  const buf = Buffer.from(line);
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
    }
  }
}

process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});

const [, , mode, bundle, fnName, inputsFile, startArg, timeoutArg] = process.argv;

// Determinism: fixed clock, seeded Math.random reset before every call.
const FIXED = Date.UTC(2024, 5, 15, 12, 0, 0);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FIXED);
    else super(...(args as ConstructorParameters<typeof Date>));
  }
  static override now(): number {
    return FIXED;
  }
}
(globalThis as { Date: unknown }).Date = FixedDate;
let seed = 42;
function resetRandom(): void {
  seed = 42;
}
Math.random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

let logs: string[] = [];
for (const m of ["log", "info", "warn", "error", "debug"] as const) {
  console[m] = (...a: unknown[]) => {
    if (logs.length < 20) logs.push(`${m}: ${format(...a)}`.slice(0, 300));
  };
}
process.stdout.write = ((c: unknown) => (logs.push(`stdout: ${String(c)}`.slice(0, 300)), true)) as never;
process.stderr.write = ((c: unknown) => (logs.push(`stderr: ${String(c)}`.slice(0, 300)), true)) as never;

const TIMEOUT = Symbol("timeout");

async function main(): Promise<void> {
  const ns = (await import(pathToFileURL(bundle!).href)) as Record<string, unknown>;
  if (mode === "list") {
    const exports: { name: string; arity: number; isClass: boolean }[] = [];
    const members = (o: object) =>
      Object.getOwnPropertyNames(o).filter((k) => {
        if (k === "constructor" || k === "prototype" || k === "length" || k === "name" || k === "caller" || k === "arguments") return false;
        const d = Object.getOwnPropertyDescriptor(o, k)!;
        return typeof d.value === "function"; // accessors are not called
      });
    for (const [name, v] of Object.entries(ns)) {
      // exported plain objects of functions (`export const utils = { a() {}, b: () => {} }`): utils.a, utils.b
      if (v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype) {
        for (const m of members(v)) exports.push({ name: `${name}.${m}`, arity: ((v as Record<string, Function>)[m] as Function).length, isClass: false });
        continue;
      }
      if (typeof v !== "function") continue;
      const isClass = /^class[\s{]/.test(Function.prototype.toString.call(v));
      exports.push({ name, arity: (v as Function).length, isClass });
      if (isClass) {
        for (const m of members((v as { prototype: object }).prototype)) exports.push({ name: `${name}#${m}`, arity: ((v as { prototype: Record<string, Function> }).prototype[m] as Function).length, isClass: false });
        for (const m of members(v as object)) exports.push({ name: `${name}.${m}`, arity: ((v as unknown as Record<string, Function>)[m] as Function).length, isClass: false });
      }
    }
    out({ exports });
    return;
  }
  // Targets: plain function `f`, class `C` (construct; the result is the instance state),
  // instance method `C#m` (inputs are [constructorArgs, methodArgs]) and static method `C.m`.
  const hash = fnName!.indexOf("#");
  const dot = fnName!.indexOf(".");
  const clsName = hash > 0 ? fnName!.slice(0, hash) : dot > 0 ? fnName!.slice(0, dot) : undefined;
  const memberName = hash > 0 ? fnName!.slice(hash + 1) : dot > 0 ? fnName!.slice(dot + 1) : undefined;
  const cls = clsName ? (ns[clsName] as Record<string, unknown> & (new (...a: unknown[]) => Record<string, unknown>)) : undefined;
  const isCtor = !clsName && /^class[\s{]/.test(Function.prototype.toString.call(ns[fnName!]));
  const snapshot = (inst: unknown): unknown => {
    try {
      return inst && typeof inst === "object" ? Object.fromEntries(Object.entries(inst as object).filter(([, v]) => typeof v !== "function")) : inst;
    } catch {
      return "<unreadable state>";
    }
  };
  const fn = ns[fnName!] as (...a: unknown[]) => unknown;
  const inputs = JSON.parse(readFileSync(inputsFile!, "utf8")) as unknown[];
  const start = Number(startArg ?? 0);
  const callTimeout = Number(timeoutArg ?? 1500);
  out({ ready: 1 });
  for (let i = start; i < inputs.length; i++) {
    const decoded = decode(inputs[i]) as unknown[];
    const args = hash > 0 ? (decoded[1] as unknown[]) : decoded;
    resetRandom();
    logs = [];
    let res: Record<string, unknown>;
    let inst: Record<string, unknown> | undefined;
    let second: unknown;
    try {
      let r: unknown;
      if (hash > 0) {
        inst = new cls!(...(decoded[0] as unknown[]));
        r = (inst[memberName!] as (...a: unknown[]) => unknown).apply(inst, args);
        if (r && typeof (r as Promise<unknown>).then === "function") r = await (r as Promise<unknown>);
        // call again on the same instance with the next generated arguments: exposes differences in how state accumulates (push vs unshift, caching, counters)
        second = encode((inst[memberName!] as (...a: unknown[]) => unknown).apply(inst, (decode(inputs[(i + 1) % inputs.length]) as unknown[][])[1]!));
      } else if (dot > 0) {
        r = (cls![memberName!] as (...a: unknown[]) => unknown).apply(cls, args);
      } else if (isCtor) {
        inst = new (fn as unknown as new (...a: unknown[]) => Record<string, unknown>)(...args);
        r = snapshot(inst);
      } else {
        r = fn(...args);
      }
      if (r && typeof (r as Promise<unknown>).then === "function") {
        let timer: NodeJS.Timeout | undefined;
        const to = new Promise<symbol>((resolve) => (timer = setTimeout(() => resolve(TIMEOUT), callTimeout)));
        r = await Promise.race([r as Promise<unknown>, to]);
        clearTimeout(timer);
        if (r === TIMEOUT) {
          out({ i, r: { timeout: true } });
          continue;
        }
      }
      res = { ok: true, value: encode(r), after: encode(args), logs: logs.slice(), ...(hash > 0 ? { state: encode(snapshot(inst)), second } : {}) };
    } catch (e) {
      const err = e as { name?: unknown; message?: unknown } | null;
      res = {
        ok: false,
        err: { name: String(err?.name ?? typeof e), message: String(err?.message ?? e).slice(0, 300) },
        after: encode(args),
        logs: logs.slice(),
        ...(hash > 0 && inst ? { state: encode(snapshot(inst)) } : {}),
      };
    }
    out({ i, r: res });
  }
  out({ done: 1 });
}

main().then(
  () => process.exit(0),
  (e) => {
    out({ fatal: String((e as Error)?.message ?? e).slice(0, 500) });
    process.exit(0);
  },
);
