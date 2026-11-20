import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(scriptDir);
const defaultOutputDir = "/private/tmp/chess-web-coverage/v8-web-tests";
const outputDir = process.env.CHESS_WEB_COVERAGE_DIR ?? defaultOutputDir;
const testScripts = [
  "smoke-test.mjs",
  "review-store-test.mjs",
  "review-workflow-test.mjs",
  "review-ui-test.mjs",
  "review-wasm-executor-test.mjs",
  "review-browser-edge-test.mjs",
  "play-wasm-executor-test.mjs",
  "play-ui-test.mjs",
  "app-test.mjs"
];
const targets = [
  { source: "src/play-board.ts", compiled: [".test-dist/play-board.js"] },
  { source: "src/play-ui.ts", compiled: [".test-dist/play-ui", ".test-dist/play-ui.js"] },
  {
    source: "src/play-wasm-executor.ts",
    compiled: [".test-dist/play-wasm-executor", ".test-dist/play-wasm-executor.js"]
  },
  { source: "src/review-ui.ts", compiled: [".test-dist/review-ui", ".test-dist/review-ui.js"] },
  {
    source: "src/review-workflow.ts",
    compiled: [".test-dist/review-workflow", ".test-dist/review-workflow.js"]
  },
  { source: "src/review-store.ts", compiled: [".test-dist/review-store", ".test-dist/review-store.js"] }
];

function runTestScript(script) {
  const result = spawnSync(process.execPath, [join("scripts", script)], {
    cwd: webRoot,
    stdio: "inherit",
    env: { ...process.env, NODE_V8_COVERAGE: outputDir }
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function coverageFiles() {
  if (!existsSync(outputDir)) {
    return [];
  }
  return readdirSync(outputDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(outputDir, name));
}

function normalizePath(value) {
  const filePath = value.startsWith("file://") ? fileURLToPath(value) : value;
  return filePath.split(sep).join("/");
}

function matchesCompiledTarget(url, target) {
  return target.compiled.some((compiled) => url.endsWith(compiled));
}

function functionKey(fn) {
  const firstRange = fn.ranges[0];
  return `${fn.functionName}:${String(firstRange?.startOffset ?? 0)}:${String(
    firstRange?.endOffset ?? 0
  )}`;
}

function collectCoverage() {
  const byTarget = new Map(targets.map((target) => [target.source, new Map()]));
  for (const file of coverageFiles()) {
    const payload = JSON.parse(readFileSync(file, "utf8"));
    for (const script of payload.result ?? []) {
      const url = normalizePath(String(script.url ?? ""));
      const target = targets.find((candidate) => matchesCompiledTarget(url, candidate));
      if (target === undefined) {
        continue;
      }
      const functions = byTarget.get(target.source);
      if (functions === undefined) {
        continue;
      }
      for (const fn of script.functions ?? []) {
        const key = functionKey(fn);
        const existing = functions.get(key) ?? false;
        const covered = (fn.ranges ?? []).some((range) => Number(range.count ?? 0) > 0);
        functions.set(key, existing || covered);
      }
    }
  }
  return targets.map((target) => {
    const functions = byTarget.get(target.source) ?? new Map();
    const total = functions.size;
    const covered = [...functions.values()].filter(Boolean).length;
    return {
      source: target.source,
      metric: "v8-function-coverage",
      covered,
      total,
      percent: total === 0 ? 0 : Number(((covered / total) * 100).toFixed(2))
    };
  });
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

for (const script of testScripts) {
  runTestScript(script);
}

const summary = {
  command: "pnpm --filter web run coverage",
  coverageEngine: "node-v8",
  thresholdsEnforced: false,
  outputDir,
  targets: collectCoverage()
};
const missingTargets = summary.targets.filter((target) => target.total === 0);
if (missingTargets.length > 0) {
  throw new Error(`Coverage missing for ${missingTargets.map((target) => target.source).join(", ")}`);
}

writeFileSync(join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log("Web coverage measurement complete.");
console.log(`Coverage output: ${outputDir}`);
console.log("Thresholds: none enforced.");
for (const target of summary.targets) {
  console.log(
    `- ${target.source}: ${String(target.covered)}/${String(target.total)} functions (${String(
      target.percent
    )}%)`
  );
}
