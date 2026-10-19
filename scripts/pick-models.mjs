// Choose benchmark candidates from OpenRouter's live catalog (no stale hardcoded IDs).
//   node scripts/pick-models.mjs [maxModels=8] [--free]  ->  prints JSON array of model ids
// --free: only zero-price ":free" text models (usable on a free OpenRouter account, rate-limited),
//         newest first, one per vendor. No anchors (they are paid).
// Rule: text-in/text-out, context >= 32k, prompt <= $0.60/M and completion <= $3/M, not free,
// cheapest model per vendor (so the set spans vendors), plus the anchors in bench/models.json.
import { readFileSync } from "node:fs";
const max = Number(process.argv[2] ?? 8);
const provider = (process.argv.find((a) => a.startsWith("--provider=")) ?? "--provider=openrouter").split("=")[1];
if (provider === "nvidia") {
  // build.nvidia.com: OpenAI-compatible catalog (needs the key to list). Text chat models only.
  const key = process.env.LLM_API_KEY;
  if (!key) throw new Error("LLM_API_KEY is required to list NVIDIA models");
  const r = await fetch("https://integrate.api.nvidia.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`NVIDIA models endpoint HTTP ${r.status}`);
  const list = (await r.json()).data ?? [];
  const have = new Set(list.map((m) => m.id));
  const cfg = JSON.parse(readFileSync(new URL("../bench/models.json", import.meta.url), "utf8"));
  const picked = (cfg.nvidia_anchors ?? []).filter((id) => have.has(id));
  const used = new Set(picked.map((id) => id.split("/")[0]));
  const bad = /embed|rerank|guard|safety|reward|-vl\b|vl-|vision|video|audio|speech|tts|asr|parse|clip|retriev|ocr|detect|topic-control|cosmos|sdxl|stable|flux|image|molecul|fold|riva|canary|parakeet|translate|nemoguard|arctic-embed|bge|e5-|nvclip|paligemma|neva|kosmos|fuyu|deplot|llava/i;
  const good = /instruct|chat|-it\b|nemotron|llama|qwen|mistral|deepseek|gemma|phi|glm|kimi|gpt-oss|minimax|granite|yi-/i;
  const rest = list.filter((m) => good.test(m.id) && !bad.test(m.id)).sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  for (const m of rest) {
    if (picked.length >= max) break;
    const v = m.id.split("/")[0];
    if (used.has(v)) continue;
    used.add(v);
    picked.push(m.id);
  }
  if (!picked.length) throw new Error("no usable NVIDIA text models found");
  console.log(JSON.stringify(picked.slice(0, max)));
  process.exit(0);
}
const free = process.argv.includes("--free");
const anchors = free ? [] : JSON.parse(readFileSync(new URL("../bench/models.json", import.meta.url), "utf8")).anchors;
const res = await fetch("https://openrouter.ai/api/v1/models");
if (!res.ok) throw new Error(`models endpoint HTTP ${res.status}`);
const { data } = await res.json();
const ids = new Set(data.map((m) => m.id));
const picked = anchors.filter((a) => ids.has(a));
for (const a of anchors) if (!ids.has(a)) console.error(`anchor not found on OpenRouter, skipped: ${a}`);
const used = new Set(picked.map((id) => id.split("/")[0]));
const textOut = (m) => m.architecture?.output_modalities?.join() === "text" || (m.architecture?.modality ?? "").endsWith("->text");
if (free) {
  const fr = data
    .filter((m) => m.id.endsWith(":free") && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0)
    .filter((m) => textOut(m) && m.context_length >= 16000 && !/preview|beta|exp|guard|embed|-vl\b|vision|audio|omni|image/i.test(m.id))
    .filter((m) => !m.architecture?.input_modalities || m.architecture.input_modalities.join() === "text")
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const vendors = new Set();
  const out = [];
  for (const m of fr) {
    const v = m.id.split("/")[0];
    if (vendors.has(v)) continue;
    vendors.add(v);
    out.push(m.id);
    if (out.length >= max) break;
  }
  if (!out.length) throw new Error("no free text models found on OpenRouter");
  console.log(JSON.stringify(out));
  process.exit(0);
}
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
