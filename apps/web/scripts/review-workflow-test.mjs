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
copyFileSync(new URL("review-store.js", outputDir), new URL("review-store", outputDir));
copyFileSync(new URL("review-workflow.js", outputDir), new URL("review-workflow", outputDir));
run("node", [".test-dist/review-workflow.test.js"]);
rmSync(outputDir, { recursive: true, force: true });
