import type { Report } from "./types.js";

export function formatText(r: Report): string {
  const L: string[] = [`behaviordiff  ${r.oldFile}  ->  ${r.newFile}`, ""];
  if (r.error) L.push(`ERROR: ${r.error}`, "");
  for (const f of r.functions) {
    if (f.status === "unchanged") L.push(`  ok       ${f.name}  (${f.tested} inputs, no behavior difference)${f.note ? "  [" + f.note + "]" : ""}`);
    else if (f.status === "added") L.push(`  added    ${f.name}`);
    else if (f.status === "removed") L.push(`  REMOVED  ${f.name}  (export no longer exists)`);
    else if (f.status === "skipped") L.push(`  skipped  ${f.name}  (${f.note})`);
    else {
      const kinds = Object.entries(f.kinds).map(([k, n]) => `${k} x${n}`).join(", ");
      L.push(`  CHANGED  ${f.name}  ${f.differing}/${f.tested} inputs differ  (${kinds})${f.note ? "  [" + f.note + "]" : ""}`);
      for (const e of f.examples) L.push(`             ${e.call}`, `               old: ${e.old}`, `               new: ${e.new}`);
    }
  }
  L.push("", r.behaviorChanged ? "RESULT: behavior changed" : "RESULT: no behavior difference found on generated inputs");
  return L.join("\n");
}

export function formatMarkdown(r: Report): string {
  const L: string[] = [`### behaviordiff: \`${r.oldFile}\` → \`${r.newFile}\``, ""];
  if (r.error) L.push(`> **Error:** ${r.error}`, "");
  const changed = r.functions.filter((f) => f.status === "changed" || f.status === "removed");
  L.push(
    changed.length
      ? `**${changed.length} function(s) changed behavior.** Check each against the intent of this change.`
      : "No behavior difference found on generated inputs.",
    "",
  );
  for (const f of changed) {
    L.push(`<details><summary><code>${f.name}</code>: ${f.status === "removed" ? "export removed" : `${f.differing}/${f.tested} inputs differ`}</summary>`, "");
    if (f.examples.length) {
      L.push("| call | old | new |", "|---|---|---|");
      for (const e of f.examples) L.push(`| \`${esc(e.call)}\` | \`${esc(e.old)}\` | \`${esc(e.new)}\` |`);
    }
    L.push("", "</details>", "");
  }
  return L.join("\n");
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/`/g, "'");
