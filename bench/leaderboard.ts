// Aggregate bench/results/*.json into bench/results/LEADERBOARD.md
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bench", "results");
const base = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8")).summary;

interface Entry { model: string; date: string; runs: number; incomplete: boolean; summary: any; usage: any }
const entries: Entry[] = readdirSync(dir)
  .filter((f) => f.startsWith("llm-") && f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Entry)
  .sort((a, b) => b.summary.precision - a.summary.precision || b.summary.recall - a.summary.recall);

const f0 = (n: number) => n.toFixed(0);
const L = [
  "# Leaderboard",
  "",
  "Known-truth benchmark (`bench/cases`). Each model labels the differences found by the deterministic engine, given the PR description. Higher precision and recall are better; flagged-intended and flagged-refactor should be 0. Cost is the measured total for the whole run, not an estimate.",
  "",
  "| Model | Recall | Precision | Intended flagged | Refactors flagged | Runs | Cost (USD) | $ / 1000 reviews | Notes |",
  "|---|---|---|---|---|---|---|---|---|",
  `| *baseline (no LLM)* | ${f0(base.recall)}% | ${f0(base.precision)}% | ${base.falseAlarmsOnIntended.flagged}/${base.falseAlarmsOnIntended.of} | ${base.falseAlarmsOnRefactors.flagged}/${base.falseAlarmsOnRefactors.of} | - | 0 | 0 | flags every difference |`,
];
for (const e of entries) {
  const s = e.summary;
  const u = e.usage;
  const perReview = u.calls ? (u.costUsd / u.calls) * 1000 : 0;
  const notes = [e.incomplete ? "INCOMPLETE" : "", u.errors ? `${u.errors} errors` : "", u.unclear ? `${u.unclear} unclear` : ""].filter(Boolean).join(", ");
  L.push(`| \`${e.model}\` | ${f0(s.recall)}% | ${f0(s.precision)}% | ${s.intendedFlagged.toFixed(1)}/${s.intendedTotal} | ${s.refactorsFlagged.toFixed(1)}/${s.refactorsTotal} | ${e.runs} | ${u.costUsd.toFixed(4)} | ${perReview.toFixed(2)} | ${notes} |`);
}
L.push("", "Caveats: 29 small hand-written cases, so differences of a few points between models are noise. See README for limits.", "");
writeFileSync(join(dir, "LEADERBOARD.md"), L.join("\n"));
console.log(L.join("\n"));
