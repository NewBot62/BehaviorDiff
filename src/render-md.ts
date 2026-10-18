// stdin: JSON report -> stdout: markdown (used by scripts/pr-review.mjs)
import { formatMarkdown } from "./report.js";
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => process.stdout.write(formatMarkdown(JSON.parse(s))));
