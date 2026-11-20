import { copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const outputDir = new URL("../.test-dist/", import.meta.url);

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
copyFileSync(new URL("app.js", outputDir), new URL("app", outputDir));
copyFileSync(new URL("play-ui.js", outputDir), new URL("play-ui", outputDir));
copyFileSync(new URL("play-wasm-executor.js", outputDir), new URL("play-wasm-executor", outputDir));
copyFileSync(new URL("review-browser-edge.js", outputDir), new URL("review-browser-edge", outputDir));
copyFileSync(new URL("review-store.js", outputDir), new URL("review-store", outputDir));
copyFileSync(new URL("review-ui.js", outputDir), new URL("review-ui", outputDir));
copyFileSync(new URL("review-wasm-executor.js", outputDir), new URL("review-wasm-executor", outputDir));
copyFileSync(new URL("review-workflow.js", outputDir), new URL("review-workflow", outputDir));
run("node", [".test-dist/app.test.js"]);
rmSync(outputDir, { recursive: true, force: true });
