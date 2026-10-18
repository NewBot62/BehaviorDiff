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
    const exports = Object.entries(ns)
      .filter(([, v]) => typeof v === "function")
      .map(([name, v]) => ({
        name,
        arity: (v as Function).length,
        isClass: /^class[\s{]/.test(Function.prototype.toString.call(v)),
      }));
    out({ exports });
    return;
  }
  const fn = ns[fnName!] as (...a: unknown[]) => unknown;
  const inputs = JSON.parse(readFileSync(inputsFile!, "utf8")) as unknown[];
  const start = Number(startArg ?? 0);
  const callTimeout = Number(timeoutArg ?? 1500);
  out({ ready: 1 });
  for (let i = start; i < inputs.length; i++) {
    const args = decode(inputs[i]) as unknown[];
    resetRandom();
    logs = [];
    let res: Record<string, unknown>;
    try {
      let r = fn(...args);
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
      res = { ok: true, value: encode(r), after: encode(args), logs: logs.slice() };
    } catch (e) {
      const err = e as { name?: unknown; message?: unknown } | null;
      res = {
        ok: false,
        err: { name: String(err?.name ?? typeof e), message: String(err?.message ?? e).slice(0, 300) },
        after: encode(args),
        logs: logs.slice(),
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
