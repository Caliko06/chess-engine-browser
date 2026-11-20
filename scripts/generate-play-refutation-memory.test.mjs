import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generatePlayRefutationMemoryModule } from "./generate-play-refutation-memory.mjs";

const memory = {
  schema: 1,
  cases: [
    {
      positionKey: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -",
      move: "b8c6",
      advice: "do-not-prefer-without-new-tactical-proof",
      deltaCp: -180
    }
  ]
};

const generated = generatePlayRefutationMemoryModule(memory);
assertIncludes(generated, "generatedPlayRefutationMemoryCases", "exports generated cases");
assertIncludes(generated, '"move": "b8c6"', "carries memory move");
assertIncludes(generated, '"advice": "do-not-prefer-without-new-tactical-proof"', "carries advice");

const tempRoot = mkdtempSync(join(tmpdir(), "generate-play-refutation-memory-test-"));
const inputPath = join(tempRoot, "refutations.v1.json");
const outputPath = join(tempRoot, "play-refutation-memory.generated.ts");
writeFileSync(inputPath, `${JSON.stringify(memory)}\n`);
const result = spawnSync(
  process.execPath,
  ["scripts/generate-play-refutation-memory.mjs", "--input", inputPath, "--output", outputPath],
  { cwd: new URL("../", import.meta.url), encoding: "utf8" }
);
if (result.status !== 0) {
  throw new Error(`generator failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
}
assertEqual(readFileSync(outputPath, "utf8"), generated, "CLI output");
console.log("generate-play-refutation-memory.test.mjs passed.");

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)} in ${text}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
