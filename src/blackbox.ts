// Shared helpers for the language-agnostic modes (`cmd` and `http`).
import type { Difference, DiffKind, FunctionReport } from "./types.js";

export interface Normalizer {
  pattern: string;
  replace?: string;
  flags?: string;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ISO = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns)\b/g;

/** Strip ANSI, replace volatile tokens (timestamps, UUIDs, durations, temp paths) and apply user rules. */
export function normalizeText(s: string, rules: Normalizer[] = [], literals: [string, string][] = []): string {
  let t = s.replace(/\r\n/g, "\n").replace(ANSI, "");
  for (const [from, to] of literals) if (from) t = t.split(from).join(to);
  t = t.replace(ISO, "<timestamp>").replace(UUID, "<uuid>").replace(DURATION, "<duration>");
  for (const r of rules) t = t.replace(new RegExp(r.pattern, r.flags ?? "g"), r.replace ?? "<normalized>");
  return t;
}

export function clip(s: string, n = 160): string {
  const one = s.replace(/\n/g, "⏎");
  return one.length > n ? one.slice(0, n - 3) + "..." : one;
}

/** First line where two texts differ, as "line N: old | new"; used to keep examples short. */
export function firstTextDiff(a: string, b: string): { old: string; new: string } {
  const A = a.split("\n"), B = b.split("\n");
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    if (A[i] !== B[i]) return { old: `line ${i + 1}: ${clip(A[i] ?? "(missing)")}`, new: `line ${i + 1}: ${clip(B[i] ?? "(missing)")}` };
  }
  return { old: "", new: "" };
}

export interface Item {
  group: string;
  diff?: Difference;
  nondeterministic?: boolean;
  failed?: string;
}

/** Group per-case results into one FunctionReport per group (so reports and intent review work unchanged). */
export function toFunctionReports(items: Item[], maxExamples = 5): FunctionReport[] {
  const groups = new Map<string, Item[]>();
  for (const it of items) (groups.get(it.group) ?? groups.set(it.group, []).get(it.group)!).push(it);
  const out: FunctionReport[] = [];
  for (const [name, xs] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const counted = xs.filter((x) => !x.nondeterministic && !x.failed);
    const diffs = counted.filter((x) => x.diff).map((x) => x.diff!);
    const kinds: Partial<Record<DiffKind, number>> = {};
    for (const d of diffs) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
    const examples: Difference[] = [];
    const seen = new Set<string>();
    const sorted = [...diffs].sort((a, b) => a.call.length - b.call.length);
    for (const d of sorted) if (!seen.has(d.kind)) (seen.add(d.kind), examples.push(d));
    for (const d of sorted) if (examples.length < maxExamples && !examples.includes(d)) examples.push(d);
    const notes: string[] = [];
    const flaky = xs.filter((x) => x.nondeterministic).length;
    if (flaky) notes.push(`${flaky} case(s) ignored: output differs between two runs of the same version`);
    const failed = xs.filter((x) => x.failed);
    if (failed.length) notes.push(`${failed.length} case(s) could not run: ${failed[0]!.failed}`);
    out.push({
      name,
      status: diffs.length ? "changed" : "unchanged",
      tested: counted.length,
      differing: diffs.length,
      kinds,
      examples: examples.slice(0, maxExamples),
      ...(notes.length ? { note: notes.join("; ") } : {}),
    });
  }
  return out;
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
