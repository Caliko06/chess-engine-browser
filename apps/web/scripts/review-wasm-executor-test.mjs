import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const outputDir = new URL("../.test-dist/", import.meta.url);
const sourceUrl = new URL("../src/review-wasm-executor.ts", import.meta.url);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(outputDir, { recursive: true, force: true });
run("pnpm", [
  "exec",
  "tsc",
  "-p",
  "tsconfig.json",
  "--noEmit",
  "false",
  "--outDir",
  ".test-dist"
]);
copyFileSync(new URL("review-wasm-executor.js", outputDir), new URL("review-wasm-executor", outputDir));
run("node", [".test-dist/review-wasm-executor.test.js"]);

const source = readFileSync(sourceUrl, "utf8");
const forbidden = [
  "fake",
  "fixture",
  "sample",
  "localStorage",
  "fetch(",
  "WebSocket",
  "Worker",
  "ServiceWorker"
];
for (const token of forbidden) {
  if (source.includes(token)) {
    console.error(`review-wasm-executor.ts contains forbidden token: ${token}`);
    process.exit(1);
  }
}

rmSync(outputDir, { recursive: true, force: true });
