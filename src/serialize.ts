// Lossless, canonical (sorted-keys) JSON encoding of arbitrary JS values.
// Shared by the parent process and the sandboxed runner.

const MAX_DEPTH = 12;

export function encode(v: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (v === undefined) return { $u: 1 };
  if (v === null) return null;
  switch (typeof v) {
    case "boolean":
    case "string":
      return v;
    case "number":
      if (Number.isNaN(v)) return { $n: "NaN" };
      if (v === Infinity) return { $n: "Infinity" };
      if (v === -Infinity) return { $n: "-Infinity" };
      if (Object.is(v, -0)) return { $n: "-0" };
      return v;
    case "bigint":
      return { $b: v.toString() };
    case "symbol":
      return { $s: v.description ?? "" };
    case "function":
      return { $f: v.name || "anonymous" };
  }
  const o = v as object;
  if (seen.has(o)) return { $cycle: 1 };
  if (depth > MAX_DEPTH) return { $deep: 1 };
  seen.add(o);
  try {
    const rec = (x: unknown) => encode(x, seen, depth + 1);
    if (o instanceof Date) return { $d: Number.isNaN(o.getTime()) ? "Invalid" : o.toISOString() };
    if (o instanceof RegExp) return { $r: String(o) };
    if (o instanceof Error) return { $e: { name: o.name, message: o.message } };
    if (o instanceof Map) return { $m: Array.from(o.entries(), ([k, x]) => [rec(k), rec(x)]) };
    if (o instanceof Set) return { $set: Array.from(o.values(), rec) };
    if (o instanceof Promise) return { $p: 1 };
    if (ArrayBuffer.isView(o) && !(o instanceof DataView)) {
      return { $ta: o.constructor.name, v: Array.from(o as unknown as ArrayLike<number | bigint>, rec) };
    }
    if (Array.isArray(o)) return Array.from(o, rec);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      out[k.startsWith("$") ? "$" + k : k] = rec((o as Record<string, unknown>)[k]);
    }
    const proto = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) {
      return { $c: proto?.constructor?.name ?? "?", v: out };
    }
    return out;
  } finally {
    seen.delete(o);
  }
}

export function decode(e: unknown): unknown {
  if (e === null || typeof e !== "object") return e;
  if (Array.isArray(e)) return e.map(decode);
  const o = e as Record<string, unknown>;
  if ("$u" in o) return undefined;
  if ("$n" in o) return { NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0 }[o.$n as string];
  if ("$b" in o) return BigInt(o.$b as string);
  if ("$s" in o) return Symbol(o.$s as string);
  if ("$d" in o) return o.$d === "Invalid" ? new Date(NaN) : new Date(o.$d as string);
  if ("$r" in o) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(o.$r as string);
    return m ? new RegExp(m[1]!, m[2]) : /(?:)/;
  }
  if ("$e" in o) {
    const x = o.$e as { name: string; message: string };
    const err = new Error(x.message);
    err.name = x.name;
    return err;
  }
  if ("$t" in o) return (o.$t as unknown[]).map(decode);
  if ("$by" in o) return `b'${String(o.$by)}'`;
  if ("$m" in o) return new Map((o.$m as [unknown, unknown][]).map(([k, v]) => [decode(k), decode(v)]));
  if ("$set" in o) return new Set((o.$set as unknown[]).map(decode));
  if ("$ta" in o) {
    const C = (globalThis as unknown as Record<string, { from(a: unknown[]): unknown }>)[o.$ta as string];
    return C ? C.from((o.v as unknown[]).map(decode)) : [];
  }
  if ("$c" in o) return decodeObject(o.v as Record<string, unknown>);
  if ("$f" in o || "$p" in o || "$cycle" in o || "$deep" in o) return undefined;
  return decodeObject(o);
}

function decodeObject(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) out[k.startsWith("$$") ? k.slice(1) : k] = decode(o[k]);
  return out;
}

export function canonical(e: unknown): string {
  return JSON.stringify(e);
}
