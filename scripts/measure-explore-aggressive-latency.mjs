import { homedir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { writeEmbeddedWasmModule } from "./beta-preview-support.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const outputRoot = "/private/tmp/chess-explore-aggressive-latency";
const pkgRoot = join(outputRoot, "dist/pkg");
const repeats = Number.parseInt(process.env.CHESS_EXPLORE_LATENCY_REPEATS ?? "3", 10);
const cases = [
  {
    label: "supplied-endgame-off-turn",
    fen: "8/6k1/1R6/7P/6P1/7K/5r2/8 b - - 0 46",
    side: "white",
    historyFens: "",
    previousLine: ""
  },
  {
    label: "connected-opening-on-turn",
    fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    side: "white",
    historyFens:
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1\nrnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    previousLine: "e2e4,e7e5,d1f3"
  }
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${homedir()}/.cargo/bin:${homedir()}/.rustup/toolchains/stable-aarch64-apple-darwin/bin:${process.env.PATH ?? ""}`
    }
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}${result.stderr}`);
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

if (!Number.isInteger(repeats) || repeats < 3) {
  throw new Error("CHESS_EXPLORE_LATENCY_REPEATS must be an integer >= 3");
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(pkgRoot, { recursive: true });
run("cargo", ["build", "-p", "chess-wasm-bridge", "--target", "wasm32-unknown-unknown", "--release"]);
run("wasm-bindgen", [
  "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm",
  "--target",
  "bundler",
  "--out-dir",
  pkgRoot
]);
writeEmbeddedWasmModule(outputRoot, { assertExpectedImports: true, removeWasmAsset: true });
const module = await import(`file://${join(pkgRoot, "chess_wasm_bridge_embedded.mjs")}?cache=${Date.now()}`);
if (typeof module.side_explore_context_v2_json !== "function") {
  throw new Error("WASM module does not export side_explore_context_v2_json");
}

for (const testCase of cases) {
  for (const [mode, budget] of [["fast", 22_000], ["deep", 44_000]]) {
    const samples = [];
    let report = null;
    for (let index = 0; index < repeats; index += 1) {
      const started = performance.now();
      report = JSON.parse(
        module.side_explore_context_v2_json(
          testCase.fen,
          testCase.side,
          true,
          testCase.historyFens,
          new Uint8Array(),
          budget,
          testCase.previousLine
        )
      );
      samples.push(performance.now() - started);
      if (!report.ok) {
        throw new Error(`${testCase.label} ${mode} failed: ${JSON.stringify(report)}`);
      }
    }
    console.log(JSON.stringify({
      label: testCase.label,
      mode,
      budget,
      median_ms: Number(percentile(samples, 50).toFixed(1)),
      p95_ms: Number(percentile(samples, 95).toFixed(1)),
      samples_ms: samples.map((sample) => Number(sample.toFixed(1))),
      top: report.sideExplore?.candidates?.[0]?.move ?? null,
      projectedReply: report.sideExplore?.replyCandidates?.[0]?.move ?? null,
      nodes: report.sideExplore?.nodes ?? null,
      depth: report.sideExplore?.depth ?? null,
      planStatus: report.sideExplore?.planStatus ?? null,
      planReason: report.sideExplore?.planReason ?? null
    }));
  }
}
