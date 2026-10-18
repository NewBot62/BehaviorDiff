// Benchmark runner. Every case has known ground truth per function:
//   unintended = regression the PR description does not cover (should be flagged)
//   intended   = change the description asks for              (should NOT be flagged)
//   none       = behavior-preserving                          (should NOT be flagged)
// The no-LLM baseline flags every behavior difference, so it can't tell
// "intended" from "unintended". That gap is what the LLM stage must close.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareFiles } from "../src/index.js";

type Truth = "unintended" | "intended" | "none";
interface Meta { title: string; description: string; expect: Record<string, Truth>; note?: string }

const casesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bench", "cases");
const names = readdirSync(casesDir).sort();

interface Row { case: string; fn: string; truth: Truth; flagged: boolean }
const rows: Row[] = [];
for (const name of names) {
  const meta = JSON.parse(readFileSync(join(casesDir, name, "meta.json"), "utf8")) as Meta;
  const report = await compareFiles(join(casesDir, name, "old.ts"), join(casesDir, name, "new.ts"));
  if (report.error) console.error(`!! ${name}: ${report.error}`);
  for (const [fn, truth] of Object.entries(meta.expect)) {
    const f = report.functions.find((x) => x.name === fn);
    rows.push({ case: name, fn, truth, flagged: f?.status === "changed" || f?.status === "removed" });
  }
}

const count = (p: (r: Row) => boolean) => rows.filter(p).length;
const tp = count((r) => r.truth === "unintended" && r.flagged);
const fn = count((r) => r.truth === "unintended" && !r.flagged);
const fpIntended = count((r) => r.truth === "intended" && r.flagged);
const fpNone = count((r) => r.truth === "none" && r.flagged);
const flagged = tp + fpIntended + fpNone;
const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);

const summary = {
  functions: rows.length,
  regressions: tp + fn,
  recall: pct(tp, tp + fn),
  precision: pct(tp, flagged),
  falseAlarmsOnIntended: { flagged: fpIntended, of: count((r) => r.truth === "intended") },
  falseAlarmsOnRefactors: { flagged: fpNone, of: count((r) => r.truth === "none") },
  missed: rows.filter((r) => r.truth === "unintended" && !r.flagged).map((r) => r.case),
};

console.log(`\nBaseline (deterministic, no LLM): ${rows.length} functions in ${names.length} cases`);
console.log(`  regressions caught : ${tp}/${tp + fn}  (recall ${summary.recall.toFixed(0)}%)`);
console.log(`  precision          : ${summary.precision.toFixed(0)}%  (${tp} real / ${flagged} flagged)`);
console.log(`  flagged but intended : ${fpIntended}/${summary.falseAlarmsOnIntended.of}   <- LLM intent stage must clear these`);
console.log(`  flagged refactors    : ${fpNone}/${summary.falseAlarmsOnRefactors.of}   <- should be 0`);
if (summary.missed.length) console.log(`  missed: ${summary.missed.join(", ")}`);

const outFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bench", "results", "baseline.json");
writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 2) + "\n");
