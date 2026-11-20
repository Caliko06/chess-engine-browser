import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("../", import.meta.url).pathname;
const outputDir = "/private/tmp/chess-web-coverage/v8-web-tests";
const result = spawnSync("pnpm", ["--filter", "web", "run", "coverage"], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, CHESS_WEB_COVERAGE_DIR: outputDir }
});

if (result.status !== 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const summaryPath = join(outputDir, "summary.json");
if (!existsSync(summaryPath)) {
  throw new Error(`missing coverage summary: ${summaryPath}`);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const expectedTargets = ["src/review-ui.ts", "src/review-workflow.ts", "src/review-store.ts"];
const actualTargets = summary.targets?.map((target) => target.source) ?? [];
if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) {
  throw new Error(`unexpected coverage targets: ${JSON.stringify(actualTargets)}`);
}
if (summary.coverageEngine !== "node-v8" || summary.thresholdsEnforced !== false) {
  throw new Error(`unexpected coverage posture: ${JSON.stringify(summary)}`);
}
for (const target of summary.targets) {
  if (target.metric !== "v8-function-coverage" || target.total <= 0 || target.covered <= 0) {
    throw new Error(`invalid target coverage: ${JSON.stringify(target)}`);
  }
}
if (!result.stdout.includes("Thresholds: none enforced.")) {
  throw new Error("coverage command did not print threshold posture");
}

console.log("P4.2 web coverage entry proof passed.");
