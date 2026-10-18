import type { Report } from "./types.js";

const label = (v: string) => v.toUpperCase();

export function formatText(r: Report): string {
  const L: string[] = [`behaviordiff  ${r.oldFile}  ->  ${r.newFile}`, ""];
  if (r.intent) L.push(`intent: ${r.intent.split("\n")[0]!.slice(0, 120)}`, "");
  if (r.error) L.push(`ERROR: ${r.error}`, "");
  for (const f of r.functions) {
    if (f.status === "unchanged") L.push(`  ok       ${f.name}  (${f.tested} inputs, no behavior difference)${f.note ? "  [" + f.note + "]" : ""}`);
    else if (f.status === "added") L.push(`  added    ${f.name}`);
    else if (f.status === "skipped") L.push(`  skipped  ${f.name}  (${f.note})`);
    else {
      const kinds = Object.entries(f.kinds).map(([k, n]) => `${k} x${n}`).join(", ");
      if (f.status === "removed") L.push(`  REMOVED  ${f.name}  (export no longer exists)`);
      else L.push(`  CHANGED  ${f.name}  ${f.differing}/${f.tested} inputs differ  (${kinds})${f.note ? "  [" + f.note + "]" : ""}`);
      if (f.review) {
        L.push(`           => ${label(f.review.verdict)}: ${f.review.reason}`);
        for (const u of f.review.unexplained ?? []) L.push(`              - not covered by intent: ${u}`);
      }
      for (const e of f.examples) L.push(`             ${e.call}`, `               old: ${e.old}`, `               new: ${e.new}`);
    }
  }
  L.push("");
  if (r.llm) {
    const changed = r.functions.filter((f) => f.status === "changed" || f.status === "removed").length;
    L.push(
      r.attention
        ? `RESULT: ${r.attention} of ${changed} changed function(s) need attention (not explained by the intent)`
        : `RESULT: ${changed} changed function(s), all explained by the intent`,
      `model ${r.llm.model}: ${r.llm.calls} call(s), ${r.llm.promptTokens}+${r.llm.completionTokens} tokens, $${r.llm.costUsd.toFixed(5)}${r.llm.skipped ? `, ${r.llm.skipped} not reviewed (cap)` : ""}${r.llm.errors ? `, ${r.llm.errors} error(s)` : ""}`,
    );
  } else {
    L.push(r.behaviorChanged ? "RESULT: behavior changed" : "RESULT: no behavior difference found on generated inputs");
  }
  return L.join("\n");
}

export const COMMENT_MARKER = "<!-- behaviordiff-report -->";

export function formatMarkdown(r: Report): string {
  const L: string[] = [`### BehaviorDiff: \`${r.oldFile}\` → \`${r.newFile}\``, ""];
  if (r.error) L.push(`> **Error:** ${r.error}`, "");
  const changed = r.functions.filter((f) => f.status === "changed" || f.status === "removed");
  if (!changed.length) L.push("No behavior difference found on generated inputs.", "");
  else if (r.llm) {
    L.push(
      r.attention
        ? `**${r.attention} of ${changed.length} changed function(s) are not explained by the stated intent.**`
        : `${changed.length} changed function(s); all are explained by the stated intent.`,
      "",
    );
  } else {
    L.push(`**${changed.length} function(s) changed behavior.** Check each against the intent of this change.`, "");
  }
  const icon = (v?: string) => (v === "intended" ? "✅" : v === "unintended" ? "⚠️" : v ? "❓" : "");
  for (const f of changed) {
    const head = f.status === "removed" ? "export removed" : `${f.differing}/${f.tested} inputs differ`;
    L.push(`<details${f.review && f.review.verdict !== "intended" ? " open" : ""}><summary>${icon(f.review?.verdict)} <code>${f.name}</code>: ${head}${f.review ? ` — ${f.review.verdict}` : ""}</summary>`, "");
    if (f.review) {
      L.push(esc2(f.review.reason), "");
      for (const u of f.review.unexplained ?? []) L.push(`- not covered by intent: ${esc2(u)}`);
      if (f.review.unexplained?.length) L.push("");
    }
    if (f.examples.length) {
      L.push("| call | old | new |", "|---|---|---|");
      for (const e of f.examples) L.push(`| \`${esc(e.call)}\` | \`${esc(e.old)}\` | \`${esc(e.new)}\` |`);
    }
    L.push("", "</details>", "");
  }
  if (r.llm) L.push(`<sub>model \`${r.llm.model}\` · ${r.llm.calls} call(s) · $${r.llm.costUsd.toFixed(4)}</sub>`, "");
  return L.join("\n");
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/`/g, "'").replace(/\n/g, " ");
const esc2 = (s: string) => s.replace(/</g, "&lt;");
