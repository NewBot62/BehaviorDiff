// Choose benchmark candidates from OpenRouter's live catalog (no stale hardcoded IDs).
//   node scripts/pick-models.mjs [maxModels=8]  ->  prints JSON array of model ids
// Rule: text-in/text-out, context >= 32k, prompt <= $0.60/M and completion <= $3/M, not free,
// cheapest model per vendor (so the set spans vendors), plus the anchors in bench/models.json.
import { readFileSync } from "node:fs";
const max = Number(process.argv[2] ?? 8);
const anchors = JSON.parse(readFileSync(new URL("../bench/models.json", import.meta.url), "utf8")).anchors;
const res = await fetch("https://openrouter.ai/api/v1/models");
if (!res.ok) throw new Error(`models endpoint HTTP ${res.status}`);
const { data } = await res.json();
const ids = new Set(data.map((m) => m.id));
const picked = anchors.filter((a) => ids.has(a));
for (const a of anchors) if (!ids.has(a)) console.error(`anchor not found on OpenRouter, skipped: ${a}`);
const used = new Set(picked.map((id) => id.split("/")[0]));
const cands = data
  .filter((m) => m.architecture?.output_modalities?.join() === "text" || (m.architecture?.modality ?? "").endsWith("->text"))
  .filter((m) => m.context_length >= 32000)
  .map((m) => ({ id: m.id, p: Number(m.pricing?.prompt) * 1e6, c: Number(m.pricing?.completion) * 1e6 }))
  .filter((m) => m.p > 0 && m.p <= 0.6 && m.c > 0 && m.c <= 3 && !m.id.includes(":") && !m.id.startsWith("~") && !/preview|beta|exp/i.test(m.id))
  .sort((a, b) => a.p + 3 * a.c - (b.p + 3 * b.c));
for (const m of cands) {
  if (picked.length >= max) break;
  const vendor = m.id.split("/")[0];
  if (used.has(vendor)) continue;
  used.add(vendor);
  picked.push(m.id);
}
console.log(JSON.stringify(picked));
