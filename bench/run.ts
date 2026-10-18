// Deterministic baseline: every behavior difference is flagged (no LLM).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareFiles } from "../src/index.js";
import { score, type Row, type Truth } from "./score.js";

interface Meta { title: string; description: string; expect: Record<string, Truth>; note?: string }

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bench");
const casesDir = join(root, "cases");
const names = readdirSync(casesDir).sort();

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

const s = score(rows);
console.log(`\nBaseline (deterministic, no LLM): ${s.functions} functions in ${names.length} cases`);
console.log(`  regressions caught : ${s.caught}/${s.regressions}  (recall ${s.recall.toFixed(0)}%)`);
console.log(`  precision          : ${s.precision.toFixed(0)}%  (${s.caught} real / ${s.flagged} flagged)`);
console.log(`  flagged but intended : ${s.falseAlarmsOnIntended.flagged}/${s.falseAlarmsOnIntended.of}   <- LLM intent stage must clear these`);
console.log(`  flagged refactors    : ${s.falseAlarmsOnRefactors.flagged}/${s.falseAlarmsOnRefactors.of}   <- should be 0`);
if (s.missed.length) console.log(`  missed: ${s.missed.join(", ")}`);
writeFileSync(join(root, "results", "baseline.json"), JSON.stringify({ summary: s, rows }, null, 2) + "\n");
