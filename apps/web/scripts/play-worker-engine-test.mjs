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
copyFileSync(new URL("play-worker-engine.js", outputDir), new URL("play-worker-engine", outputDir));
copyFileSync(new URL("play-wasm-executor.js", outputDir), new URL("play-wasm-executor", outputDir));
run("node", [".test-dist/play-worker-engine.test.js"]);
rmSync(outputDir, { recursive: true, force: true });
