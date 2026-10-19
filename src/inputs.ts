// Deterministic input generation: typed pools + literals harvested from both
// versions of the code (so thresholds like `>= 18` get probed at 17/18/19).
import { encode, canonical } from "./serialize.js";
import type { FnSig, ParamInfo, Shape } from "./analyze.js";

export interface GenCtx {
  numbers: number[];
  strings: string[];
}

const BASE_NUMBERS = [0, 1, -1, 2, 3, 5, 10, 100, 0.5, -2.5, 1000, 1234.5, 1536, 999999, 1e6, 1e9, 0.001, 0.1234];
const BASE_STRINGS = ["", "a", "abc", "Hello World", "  padded  ", "123", "UPPER", "a,b,c", "ünï", "   ", "\t\n", "fooBar", "foo-bar", "foo_bar", "FooBar", "XMLHttpRequest", "foo2bar", "a1b2c3", "__foo", "$foo", "foo bar baz", "ÀÉÎ", "😀a", "foo.bar/baz", "1.5e3", "-5", "http://x.io/a?b=1"];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function uniq<T>(xs: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const k = canonical(encode(x));
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

function numberPool(ctx: GenCtx): number[] {
  const extra: number[] = [];
  for (const n of ctx.numbers) {
    extra.push(n);
    if (Number.isInteger(n) && Math.abs(n) < 1e9) extra.push(n - 1, n + 1);
  }
  return uniq([...BASE_NUMBERS, ...extra]).slice(0, 60);
}

function stringPool(ctx: GenCtx): string[] {
  // raw literals first (they are the most likely to hit a branch), then case/padding variants of the first few
  const variants: string[] = [];
  for (const s of ctx.strings.slice(0, 20)) {
    const up = s.toUpperCase();
    if (up !== s) variants.push(up);
    if (s.length) variants.push(` ${s} `);
  }
  return uniq([...BASE_STRINGS, ...ctx.strings, ...variants]).slice(0, 110);
}

export function valuesFor(shape: Shape, ctx: GenCtx, depth = 0): unknown[] {
  if (depth > 4) return [undefined];
  switch (shape.k) {
    case "number": return numberPool(ctx);
    case "string": return stringPool(ctx);
    case "boolean": return [true, false];
    case "null": return [null];
    case "undefined": return [undefined];
    case "date": return [new Date(0), new Date("2024-02-29T12:00:00Z"), new Date("2025-12-31T23:59:59Z")];
    case "literal": return [...shape.values];
    case "union": {
      const pools = shape.of.map((s) => valuesFor(s, ctx, depth + 1));
      const out: unknown[] = [];
      const max = Math.max(...pools.map((p) => p.length), 0);
      for (let i = 0; i < max; i++) for (const p of pools) if (i < p.length) out.push(p[i]);
      return uniq(out).slice(0, 60);
    }
    case "array": {
      const p = valuesFor(shape.of, ctx, depth + 1).slice(0, 12);
      const g = (i: number) => p[i % p.length];
      if (!p.length) return [[]];
      const arrays: unknown[][] = [
        [], [g(0)], [g(0), g(1)], [g(1), g(0)], [g(0), g(1), g(2)], [g(2), g(1), g(0)],
        [g(1), g(1), g(0)], [g(0), g(1), g(2), g(3), g(4), g(5)], [g(3), g(0), g(3)],
        // one large array: catches caps/limits/pagination that small arrays never reach
        Array.from({ length: 120 }, (_, i) => g(i)),
      ];
      // arrays of records: pairs that collide on one field but differ on another
      // (duplicates, keep-first vs keep-last, stable-sort ties, ...)
      const a = p[0], b = p[1];
      if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !(a instanceof Date)) {
        const keys = Object.keys(a as object);
        if (keys.length >= 2) {
          for (const k of keys) {
            const twin = { ...(a as object), [k]: (b as Record<string, unknown>)[k] };
            arrays.push([a, twin], [twin, a], [a, twin, a]);
          }
        }
      }
      return uniq(arrays);
    }
    case "tuple": {
      const pools = shape.of.map((s) => valuesFor(s, ctx, depth + 1));
      const n = Math.max(...pools.map((p) => p.length), 1);
      return uniq(Array.from({ length: Math.min(n, 12) }, (_, i) => pools.map((p) => p[i % Math.max(p.length, 1)])));
    }
    case "record": {
      const p = valuesFor(shape.of, ctx, depth + 1).slice(0, 6);
      const g = (i: number) => p[i % Math.max(p.length, 1)];
      return uniq([{}, { a: g(0) }, { a: g(0), b: g(1) }, { a: g(1), b: g(0), c: g(2) }]);
    }
    case "object": {
      const pools = shape.props.map((p) => valuesFor(p.shape, ctx, depth + 1));
      const rows = Math.min(10, Math.max(3, ...pools.map((p) => p.length)));
      const out: Record<string, unknown>[] = [];
      for (let r = 0; r < rows; r++) {
        const o: Record<string, unknown> = {};
        shape.props.forEach((prop, idx) => {
          const pool = pools[idx]!;
          if (prop.optional && r % 3 === 2) return;
          o[prop.name] = pool[(r * (idx + 1) + idx) % Math.max(pool.length, 1)];
        });
        out.push(o);
      }
      if (shape.props.every((p) => p.optional)) out.push({});
      return uniq(out);
    }
    case "options": {
      // one key at a time, then pairs: the cheapest way to reach every option branch
      const vals: unknown[] = [true, false, 0, 1, 2, 3, "en", "x", null];
      const out: Record<string, unknown>[] = [{}];
      for (const k of shape.keys) for (const v of vals) out.push({ [k]: v });
      for (let i = 0; i + 1 < shape.keys.length; i++) {
        out.push({ [shape.keys[i]!]: true, [shape.keys[i + 1]!]: true });
        out.push({ [shape.keys[i]!]: 2, [shape.keys[i + 1]!]: 1 });
      }
      if (shape.keys.length > 2) out.push(Object.fromEntries(shape.keys.map((k) => [k, true])));
      return uniq(out);
    }
    case "unknown":
    default: {
      return uniq([
        0, 1, -1, 2, 10, NaN, Infinity, "", "a", "abc", true, false, null, undefined, [], [1, 2, 3], {}, { a: 1 },
        0.001, 0.1234, 1.5, 999, 1000, 1234.5, 999999, 1e6, 1e9, 1e15, -1000, 123456789n,
        ...ctx.numbers.slice(0, 8), ...stringPool(ctx).slice(0, 70),
      ]);
    }
  }
}

function paramPools(params: ParamInfo[], ctx: GenCtx): unknown[][] {
  const pools: unknown[][] = [];
  for (const p of params) {
    if (p.rest) {
      const el = p.shape.k === "array" ? p.shape.of : p.shape;
      pools.push(uniq([undefined, ...valuesFor(el, ctx)]));
      pools.push(uniq([undefined, ...valuesFor(el, ctx)]));
      continue;
    }
    const vals = valuesFor(p.shape, ctx);
    pools.push(p.optional ? uniq([...vals, undefined]) : vals);
  }
  return pools;
}

/** Trailing `undefined`s are trimmed so optional params behave as "not passed". */
function trim(args: unknown[]): unknown[] {
  let n = args.length;
  while (n > 0 && args[n - 1] === undefined) n--;
  return args.slice(0, n);
}

export function generateInputs(sig: FnSig | undefined, arity: number, ctx: GenCtx, max: number, seedName: string): unknown[][] {
  const params: ParamInfo[] = sig?.params ?? Array.from({ length: arity }, (_, i) => ({ name: `a${i}`, optional: false, rest: false, shape: { k: "unknown" } as Shape }));
  if (params.length === 0) return [[]];
  const pools = paramPools(params, ctx);
  const total = pools.reduce((a, p) => a * Math.max(p.length, 1), 1);
  const out: unknown[][] = [];
  const pick = (idxs: number[]) => trim(idxs.map((i, k) => pools[k]![i % Math.max(pools[k]!.length, 1)]));

  if (total <= max) {
    const idx = pools.map(() => 0);
    for (let c = 0; c < total; c++) {
      out.push(pick(idx));
      for (let k = pools.length - 1; k >= 0; k--) {
        idx[k] = idx[k]! + 1;
        if (idx[k]! < pools[k]!.length) break;
        idx[k] = 0;
      }
    }
    return uniq(out);
  }

  const maxLen = Math.max(...pools.map((p) => p.length));
  for (let i = 0; i < maxLen; i++) out.push(pick(pools.map(() => i)));
  // One-at-a-time sweeps around several baselines (the first values plus seeded random ones):
  // finds single-parameter boundaries and parameter interactions (e.g. a size x an option).
  // Sweeps are interleaved so that truncation to `max` drops the same share of every parameter.
  const rng = mulberry32(hash(seedName));
  const baselines: number[][] = [pools.map(() => 0), pools.map(() => 1), ...Array.from({ length: 4 }, () => pools.map((p) => Math.floor(rng() * p.length)))];
  for (let i = 0; i < maxLen; i++) {
    for (const base of baselines) {
      for (let k = 0; k < pools.length; k++) {
        if (i >= pools[k]!.length) continue;
        const idx = [...base];
        idx[k] = i;
        out.push(pick(idx));
      }
    }
  }
  let guard = 0;
  let res = uniq(out);
  while (res.length < max && guard++ < max * 4) {
    out.push(pick(pools.map((p) => Math.floor(rng() * p.length))));
    if (guard % 25 === 0) res = uniq(out);
  }
  return uniq(out).slice(0, max);
}
