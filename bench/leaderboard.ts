// Aggregate bench/results/*.json into bench/results/LEADERBOARD.md (one table per suite)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bench", "results");

interface Entry { model: string; date: string; runs: number; incomplete: boolean; suite?: string; summary: any; usage: any }
const all: Entry[] = readdirSync(dir)
  .filter((f) => f.startsWith("llm-") && f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Entry);

const f0 = (n: number) => n.toFixed(0);
const L = [
  "# Leaderboard",
  "",
  "Known-truth benchmarks (`bench/cases`, `bench/cases-hard`). Each model labels the differences found by the deterministic engine, given the PR description. Higher precision and recall are better; flagged-intended and flagged-refactor should be 0. Cost is measured from provider usage data (0 for free tiers). `unclear` verdicts count as flagged.",
  "",
];

for (const [suite, title, file, blurb] of [
  ["main", "Main suite (29 cases)", "baseline.json", "Explicit descriptions; the easier set."],
  ["hard", "Hard suite (12 cases)", "baseline-hard.json", "Unrelated descriptions, prompt injection, source-only differences, removed exports."],
] as const) {
  const entries = all.filter((e) => (e.suite ?? "main") === suite).sort((a, b) => b.summary.precision - a.summary.precision || b.summary.recall - a.summary.recall);
  if (!entries.length && !existsSync(join(dir, file))) continue;
  L.push(`## ${title}`, "", blurb, "", "| Model | Recall | Precision | Intended flagged | Refactors flagged | Runs | Cost (USD) | Wall time (s) | Notes |", "|---|---|---|---|---|---|---|---|---|");
  if (existsSync(join(dir, file))) {
    const b = JSON.parse(readFileSync(join(dir, file), "utf8")).summary;
    L.push(`| *baseline (no LLM)* | ${f0(b.recall)}% | ${f0(b.precision)}% | ${b.falseAlarmsOnIntended.flagged}/${b.falseAlarmsOnIntended.of} | ${b.falseAlarmsOnRefactors.flagged}/${b.falseAlarmsOnRefactors.of} | - | 0 | - | flags every difference |`);
  }
  for (const e of entries) {
    const s = e.summary, u = e.usage;
    const notes = [e.incomplete ? "INCOMPLETE" : "", u.errors ? `${u.errors} errors` : "", u.unclear ? `${u.unclear} unclear` : ""].filter(Boolean).join(", ");
    L.push(`| \`${e.model}\` | ${f0(s.recall)}% | ${f0(s.precision)}% | ${s.intendedFlagged.toFixed(1)}/${s.intendedTotal} | ${s.refactorsFlagged.toFixed(1)}/${s.refactorsTotal} | ${e.runs} | ${u.costUsd.toFixed(4)} | ${u.wallMs ? Math.round(u.wallMs / 1000) : "-"} | ${notes} |`);
  }
  L.push("");
}
L.push("Caveats: small hand-written suites (12 and 8-12 cases per class), so one case moves a metric by roughly 8 points and differences of a few points between models are noise. See README for limits.", "");
writeFileSync(join(dir, "LEADERBOARD.md"), L.join("\n"));
console.log(L.join("\n"));
