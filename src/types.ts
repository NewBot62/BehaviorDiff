export type DiffKind =
  | "return-value"
  | "threw-vs-returned"
  | "error-type"
  | "error-message"
  | "input-mutation"
  | "logs"
  | "timeout"
  | "crash";

export interface Difference {
  kind: DiffKind;
  call: string;
  old: string;
  new: string;
}

export type FunctionStatus = "unchanged" | "changed" | "added" | "removed" | "skipped" | "error";

export interface FunctionReport {
  name: string;
  status: FunctionStatus;
  tested: number;
  differing: number;
  kinds: Partial<Record<DiffKind, number>>;
  examples: Difference[];
  note?: string;
}

export interface Report {
  oldFile: string;
  newFile: string;
  functions: FunctionReport[];
  /** true if any function changed behavior or an export was removed */
  behaviorChanged: boolean;
  error?: string;
}

export interface CompareOptions {
  /** max generated inputs per function (default 300) */
  maxInputs?: number;
  /** per-call timeout in ms (default 1500) */
  callTimeoutMs?: number;
  /** only these exported functions */
  functions?: string[];
  /** examples kept per function (default 5) */
  maxExamples?: number;
}
