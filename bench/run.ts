// Deterministic baseline: every behavior difference is flagged (no LLM).
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareFiles } from "../src/index.js";
import { score, type Row, type Truth } from "./score.js";
import { SUITES, caseFiles, readMeta, root, suiteOf } from "./suites.js";

interface Meta { title: string; description: string; expect: Record<string, Truth>; note?: string; seed?: string[] }

const suite = suiteOf(process.argv.find((a) => a.startsWith("--suite="))?.split("=")[1]);
const casesDir = join(root, SUITES[suite].dir);
const names = readdirSync(casesDir).sort();

const rows: Row[] = [];
for (const name of names) {
  const meta = readMeta<Meta>(join(casesDir, name));
  const cf = caseFiles(join(casesDir, name), meta);
  const report = await compareFiles(cf.oldFile, cf.newFile, cf.opts);
  if (report.error) console.error(`!! ${name}: ${report.error}`);
  for (const [fn, truth] of Object.entries(meta.expect)) {
    const f = report.functions.find((x) => x.name === fn);
    rows.push({ case: name, fn, truth, flagged: f?.status === "changed" || f?.status === "removed" });
  }
}

const s = score(rows);
console.log(`\nBaseline [${suite}] (deterministic, no LLM): ${s.functions} functions in ${names.length} cases`);
console.log(`  regressions caught : ${s.caught}/${s.regressions}  (recall ${s.recall.toFixed(0)}%)`);
console.log(`  precision          : ${s.precision.toFixed(0)}%  (${s.caught} real / ${s.flagged} flagged)`);
console.log(`  flagged but intended : ${s.falseAlarmsOnIntended.flagged}/${s.falseAlarmsOnIntended.of}   <- LLM intent stage must clear these`);
console.log(`  flagged refactors    : ${s.falseAlarmsOnRefactors.flagged}/${s.falseAlarmsOnRefactors.of}   <- should be 0`);
if (s.missed.length) console.log(`  missed: ${s.missed.join(", ")}`);
writeFileSync(join(root, "results", SUITES[suite].baseline), JSON.stringify({ summary: s, rows }, null, 2) + "\n");
