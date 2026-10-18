export type Truth = "unintended" | "intended" | "none";
export interface Row {
  case: string;
  fn: string;
  truth: Truth;
  /** true if the tool asks a human to look at this function */
  flagged: boolean;
  verdict?: string;
}

const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);

export function score(rows: Row[]) {
  const c = (p: (r: Row) => boolean) => rows.filter(p).length;
  const tp = c((r) => r.truth === "unintended" && r.flagged);
  const fn = c((r) => r.truth === "unintended" && !r.flagged);
  const fpIntended = c((r) => r.truth === "intended" && r.flagged);
  const fpNone = c((r) => r.truth === "none" && r.flagged);
  const flagged = tp + fpIntended + fpNone;
  const recall = pct(tp, tp + fn);
  const precision = pct(tp, flagged);
  return {
    functions: rows.length,
    regressions: tp + fn,
    caught: tp,
    recall,
    precision,
    f1: recall + precision ? (2 * recall * precision) / (recall + precision) : 0,
    flagged,
    falseAlarmsOnIntended: { flagged: fpIntended, of: c((r) => r.truth === "intended") },
    falseAlarmsOnRefactors: { flagged: fpNone, of: c((r) => r.truth === "none") },
    missed: rows.filter((r) => r.truth === "unintended" && !r.flagged).map((r) => `${r.case}:${r.fn}`),
  };
}
