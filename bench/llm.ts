// Run the known-truth benchmark through the intent classifier for ONE model.
//   node dist/bench/llm.js --provider openrouter --model anthropic/claude-haiku-5.5 --runs 2
// Key from env LLM_API_KEY. Writes bench/results/llm-<model>.json
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chat, classifyReport, compareFiles, resolveConfig, type Report } from "../src/index.js";
import { score, type Row, type Truth } from "./score.js";

interface Meta { title: string; description: string; expect: Record<string, Truth>; note?: string }

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    runs: { type: "string", default: "2" },
    "max-cost": { type: "string", default: "0.5" },
    concurrency: { type: "string", default: "4" },
    "price-in": { type: "string" },
    "price-out": { type: "string" },
    "json-mode": { type: "boolean" },
    only: { type: "string" },
    label: { type: "string" },
  },
});

const llm = resolveConfig({
  ...(values.provider ? { provider: values.provider } : {}),
  ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
  ...(values.model ? { model: values.model } : {}),
  ...(values["price-in"] ? { priceIn: Number(values["price-in"]) } : {}),
  ...(values["price-out"] ? { priceOut: Number(values["price-out"]) } : {}),
  ...(values["json-mode"] ? { jsonMode: true } : {}),
});
const runs = Number(values.runs);
const maxCost = Number(values["max-cost"]);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bench");
const casesDir = join(root, "cases");
const names = readdirSync(casesDir).sort().filter((n) => !values.only || n.includes(values.only));

// Preflight: one tiny call. A bad key, no credit or unknown model must fail loudly,
// never produce a table of "unclear" verdicts that looks like a result.
try {
  await chat({ ...llm, maxTokens: 20 }, [{ role: "user", content: "Reply with the single word OK." }]);
} catch (e) {
  console.error(`PREFLIGHT FAILED for ${llm.model}: ${(e as Error).message}`);
  process.exit(1);
}

// Deterministic part runs once; only the labelling is repeated per run.
const base = new Map<string, { meta: Meta; report: Report }>();
for (const name of names) {
  const meta = JSON.parse(readFileSync(join(casesDir, name, "meta.json"), "utf8")) as Meta;
  base.set(name, { meta, report: await compareFiles(join(casesDir, name, "old.ts"), join(casesDir, name, "new.ts")) });
}

const t0 = Date.now();
const errorSamples = new Set<string>();
let totalReviews = 0;
let spent = 0, calls = 0, pt = 0, ct = 0, errors = 0, unclassified = 0, unclear = 0;
const perRun: ReturnType<typeof score>[] = [];
const allRows: Row[][] = [];

for (let r = 0; r < runs; r++) {
  const rows: Row[] = [];
  for (const name of names) {
    const { meta, report } = base.get(name)!;
    const rep = await classifyReport(structuredClone(report), join(casesDir, name, "old.ts"), join(casesDir, name, "new.ts"), {
      intent: meta.description,
      llm,
      maxCostUsd: Math.max(maxCost - spent, 0),
      maxFunctions: 50,
      concurrency: Number(values.concurrency),
    });
    spent += rep.llm?.costUsd ?? 0;
    calls += rep.llm?.calls ?? 0;
    pt += rep.llm?.promptTokens ?? 0;
    ct += rep.llm?.completionTokens ?? 0;
    errors += rep.llm?.errors ?? 0;
    for (const m of rep.llm?.errorSamples ?? []) if (errorSamples.size < 3) errorSamples.add(m);
    totalReviews += rep.functions.filter((f) => f.review).length;
    for (const [fn, truth] of Object.entries(meta.expect)) {
      const f = rep.functions.find((x) => x.name === fn);
      const changed = f?.status === "changed" || f?.status === "removed";
      const verdict = f?.review?.verdict;
      if (verdict === "unclassified") unclassified++;
      if (verdict === "unclear") unclear++;
      rows.push({ case: name, fn, truth, flagged: changed && verdict !== "intended", ...(verdict ? { verdict } : {}) });
    }
  }
  allRows.push(rows);
  perRun.push(score(rows));
  console.log(`run ${r + 1}/${runs}: recall ${perRun[r]!.recall.toFixed(0)}%  precision ${perRun[r]!.precision.toFixed(0)}%  spent $${spent.toFixed(4)}`);
}

if (totalReviews && errors / totalReviews >= 0.2) {
  console.error(`INVALID RUN for ${llm.model}: ${errors} of ${totalReviews} reviews failed; results not saved.`);
  for (const m of errorSamples) console.error(`  sample error: ${m}`);
  process.exit(1);
}

const mean = (f: (s: ReturnType<typeof score>) => number) => perRun.reduce((a, s) => a + f(s), 0) / perRun.length;
const summary = {
  recall: mean((s) => s.recall),
  precision: mean((s) => s.precision),
  f1: mean((s) => s.f1),
  intendedFlagged: mean((s) => s.falseAlarmsOnIntended.flagged),
  intendedTotal: perRun[0]!.falseAlarmsOnIntended.of,
  refactorsFlagged: mean((s) => s.falseAlarmsOnRefactors.flagged),
  refactorsTotal: perRun[0]!.falseAlarmsOnRefactors.of,
  regressions: perRun[0]!.regressions,
};
const out = {
  model: llm.model,
  provider: values.provider ?? values["base-url"] ?? "env",
  label: values.label ?? llm.model,
  date: new Date().toISOString(),
  runs,
  incomplete: unclassified > 0,
  summary,
  usage: { errorSamples: [...errorSamples], calls, promptTokens: pt, completionTokens: ct, costUsd: spent, errors, unclear, unclassified, wallMs: Date.now() - t0 },
  perRun,
  rows: allRows,
};
mkdirSync(join(root, "results"), { recursive: true });
const slug = llm.model.replace(/[^a-zA-Z0-9._-]+/g, "_");
writeFileSync(join(root, "results", `llm-${slug}.json`), JSON.stringify(out, null, 2) + "\n");
console.log(`\n${llm.model}: recall ${summary.recall.toFixed(0)}%  precision ${summary.precision.toFixed(0)}%  cost $${spent.toFixed(4)}  calls ${calls}  errors ${errors}${out.incomplete ? "  INCOMPLETE (spend cap hit)" : ""}`);
