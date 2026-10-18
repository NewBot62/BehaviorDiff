export { compareFiles } from "./engine.js";
export { compareGitRef } from "./git.js";
export { reviewFiles, reviewGitRef, classifyReport, type ReviewOptions } from "./review.js";
export { resolveConfig, chat, PROVIDERS, type LlmConfig, type ConfigInput } from "./llm.js";
export { buildMessages, parseReview, classifyFunction, SYSTEM_PROMPT } from "./classify.js";
export { formatText, formatMarkdown } from "./report.js";
export type { Report, FunctionReport, Difference, DiffKind, CompareOptions, Review, Verdict, LlmSummary } from "./types.js";
