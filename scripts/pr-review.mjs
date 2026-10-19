// Used by action.yml. Reviews every modified TS/JS file of a pull request:
// runs both versions, asks the model whether each difference matches the PR description,
// and posts ONE comment (updated in place). Advisory by default.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const env = process.env;
const MARKER = "<!-- behaviordiff-report -->";
const cli = join(env.BD_ACTION_PATH ?? ".", "dist", "src", "cli.js");
const dry = env.BD_DRY_RUN === "1";
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

if (!env.LLM_API_KEY && !env.BD_BASE_URL) {
  console.log("::notice::BehaviorDiff skipped: no LLM_API_KEY (secrets are not available to pull requests from forks).");
  process.exit(0);
}

const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
const pr = event.pull_request;
const baseRef = env.BD_BASE_REF || pr?.base?.ref;
if (!baseRef) {
  console.log("::notice::BehaviorDiff skipped: not a pull_request event.");
  process.exit(0);
}
const intent = [pr?.title, pr?.body].filter(Boolean).join("\n\n") || env.BD_INTENT || "";
if (!intent.trim()) {
  console.log("::notice::BehaviorDiff skipped: the pull request has no title/description to use as intent.");
  process.exit(0);
}

const remoteBase = `origin/${baseRef}`;
try { sh("git", ["rev-parse", "--verify", remoteBase]); } catch { sh("git", ["fetch", "--no-tags", "origin", baseRef]); }
const mergeBase = sh("git", ["merge-base", remoteBase, "HEAD"]);
const files = sh("git", ["diff", "--name-only", "--diff-filter=M", `${mergeBase}...HEAD`])
  .split("\n")
  .filter((f) => /\.(ts|tsx|mts|js|jsx|mjs|cjs|py)$/.test(f))
  .filter((f) => !/(\.d\.ts$|\.test\.|\.spec\.|(^|\/)(test_[^/]*|[^/]*_test|conftest|setup|__init__)\.py$|(^|\/)(node_modules|dist|build|__tests__|test|tests|venv|\.venv)\/)/.test(f))
  .slice(0, Number(env.BD_MAX_FILES ?? 15));

const tmp = mkdtempSync(join(tmpdir(), "bd-pr-"));
const intentFile = join(tmp, "intent.txt");
writeFileSync(intentFile, intent);

/** Test files next to a source file: their literals make good generated inputs. */
function seedsFor(f) {
  const dir = dirname(f);
  const base = basename(f).replace(/\.[^.]+$/, "");
  const out = [];
  for (const d of [dir, join(dir, "test"), join(dir, "tests"), join(dir, "__tests__"), "test", "tests"]) {
    if (!existsSync(d)) continue;
    let names = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (f.endsWith(".py")) { if (n === `test_${base}.py` || n === `${base}_test.py`) out.push(join(d, n)); continue; }
      if (new RegExp(`^${base}\\.(test|spec)\\.`).test(n) || (d !== dir && n.startsWith(base + ".")) || /^test\.(js|mjs|cjs|ts)$/.test(n)) out.push(join(d, n));
    }
  }
  return [...new Set(out)].slice(0, 4);
}

const parts = [];
let attention = 0;
let cost = 0;
for (const f of files) {
  const args = [cli, "--base", mergeBase, f, "--format", "json", "--intent-file", intentFile, "--provider", env.BD_PROVIDER || "openrouter", "--max-cost", env.BD_MAX_COST || "0.10"];
  const seeds = seedsFor(f);
  if (seeds.length) args.push("--seed", seeds.join(","));
  if (env.BD_MODEL) args.push("--model", env.BD_MODEL);
  if (env.BD_BASE_URL) args.push("--base-url", env.BD_BASE_URL);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", env });
  let report;
  try { report = JSON.parse(r.stdout); } catch { console.log(`::warning::BehaviorDiff failed on ${f}: ${(r.stderr || r.stdout).slice(0, 300)}`); continue; }
  if (!report.functions.some((x) => x.status === "changed" || x.status === "removed")) continue;
  attention += report.attention ?? 0;
  cost += report.llm?.costUsd ?? 0;
  const md = spawnSync(process.execPath, [join(env.BD_ACTION_PATH ?? ".", "dist", "src", "render-md.js")], { input: r.stdout, encoding: "utf8" });
  parts.push(md.stdout);
}

const body = parts.length
  ? `${MARKER}\n## BehaviorDiff\n${attention ? `**${attention} behavior change(s) are not explained by this PR's description.**` : "All behavior changes found match this PR's description."} Reviewed ${files.length} modified file(s), model cost $${cost.toFixed(4)}.\n\n${parts.join("\n")}\n<sub>Advisory only. Inputs are generated, so "no difference" is not proof of equivalence.</sub>`
  : `${MARKER}\n## BehaviorDiff\nNo behavior difference found in ${files.length} modified TS/JS file(s) on generated inputs.`;

if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, body + "\n");
if (dry || !pr || !env.GITHUB_TOKEN) {
  console.log(body);
} else {
  const repo = env.GITHUB_REPOSITORY;
  const gh = (args, input) => execFileSync("gh", args, { encoding: "utf8", input, env: { ...env, GH_TOKEN: env.GITHUB_TOKEN } });
  const comments = JSON.parse(gh(["api", `repos/${repo}/issues/${pr.number}/comments`, "--paginate", "--slurp"])).flat();
  const mine = comments.find((c) => c.body?.includes(MARKER) && c.user?.type === "Bot");
  const payload = JSON.stringify({ body });
  if (mine) gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${mine.id}`, "--input", "-"], payload);
  else gh(["api", "-X", "POST", `repos/${repo}/issues/${pr.number}/comments`, "--input", "-"], payload);
  console.log(`posted comment (${attention} need attention)`);
}
if (env.BD_FAIL_ON_ATTENTION === "true" && attention > 0) process.exit(1);
