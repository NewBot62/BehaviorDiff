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

export type Verdict = "intended" | "unintended" | "unclear" | "unclassified";

export interface Review {
  verdict: Verdict;
  reason: string;
  /** differences the model says the stated intent does not cover */
  unexplained?: string[];
}

export interface LlmSummary {
  model: string;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** first distinct error messages (never contain the API key) */
  errorSamples?: string[];
  /** functions not reviewed because the spend cap or function cap was hit */
  skipped: number;
}

export interface FunctionReport {
  name: string;
  status: FunctionStatus;
  tested: number;
  differing: number;
  kinds: Partial<Record<DiffKind, number>>;
  examples: Difference[];
  note?: string;
  review?: Review;
}

export interface Report {
  oldFile: string;
  newFile: string;
  functions: FunctionReport[];
  /** true if any function changed behavior or an export was removed */
  behaviorChanged: boolean;
  error?: string;
  /** present when an intent review ran */
  intent?: string;
  llm?: LlmSummary;
  /** changed functions whose review is not "intended" (needs a human) */
  attention?: number;
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
