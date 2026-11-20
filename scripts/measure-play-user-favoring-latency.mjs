import { homedir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { writeEmbeddedWasmModule } from "./beta-preview-support.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const outputRoot = "/private/tmp/chess-play-user-favoring-latency";
const pkgRoot = join(outputRoot, "dist/pkg");
const repeats = Number.parseInt(process.env.CHESS_PLAY_LATENCY_REPEATS ?? "3", 10);
const targetsMs = new Map([
  [1, 500],
  [3, 2_000],
  [5, 5_000]
]);
const cases = [
  {
    label: "target-final",
    fen: "8/6k1/1R6/7P/6P1/7K/5r2/8 b - - 0 46",
    engineSide: "black",
    userSide: "white",
    historyFens: "",
    previousLine: ""
  },
  {
    label: "contextual-opening",
    fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    engineSide: "white",
    userSide: "black",
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
  return result.stdout;
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function prepareWasm() {
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
  return `file://${join(pkgRoot, "chess_wasm_bridge_embedded.mjs")}`;
}

if (!Number.isInteger(repeats) || repeats < 3) {
  throw new Error("CHESS_PLAY_LATENCY_REPEATS must be an integer >= 3");
}

const modulePath = prepareWasm();
const module = await import(`${modulePath}?cache=${Date.now()}`);
if (typeof module.best_move_user_context_json !== "function") {
  throw new Error("WASM module does not export best_move_user_context_json");
}

let failed = false;
for (const testCase of cases) {
  for (const [level, depth, budget] of [
    [1, 1, 60_000],
    [3, 12, 60_000],
    [5, 16, 120_000]
  ]) {
    const samples = [];
    let report = null;
    for (let index = 0; index < repeats; index += 1) {
      const started = performance.now();
      report = JSON.parse(
        module.best_move_user_context_json(
          testCase.fen,
          depth,
          true,
          testCase.engineSide,
          testCase.userSide,
          testCase.historyFens,
          testCase.previousLine,
          budget
        )
      );
      samples.push(performance.now() - started);
      if (!report.ok) {
        throw new Error(`${testCase.label} level ${level} failed: ${JSON.stringify(report)}`);
      }
    }
    const medianMs = percentile(samples, 50);
    const p95Ms = percentile(samples, 95);
    const targetMs = targetsMs.get(level);
    const passed = targetMs !== undefined && p95Ms <= targetMs;
    failed ||= !passed;
    console.log(
      JSON.stringify({
        label: testCase.label,
        level,
        budget,
        target_p95_ms: targetMs,
        median_ms: Number(medianMs.toFixed(1)),
        p95_ms: Number(p95Ms.toFixed(1)),
        samples_ms: samples.map((sample) => Number(sample.toFixed(1))),
        best_move: report.bestMove?.bestMove ?? null,
        depth: report.bestMove?.depth ?? null,
        nodes: report.bestMove?.nodes ?? null,
        passed
      })
    );
  }
}

if (failed) {
  process.exitCode = 1;
}
