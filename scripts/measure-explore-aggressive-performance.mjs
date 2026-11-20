import { homedir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { writeEmbeddedWasmModule } from "./beta-preview-support.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const outputRoot = "/private/tmp/chess-explore-aggressive-performance";
const pkgRoot = join(outputRoot, "dist/pkg");
const repeats = Number.parseInt(process.env.CHESS_EXPLORE_PERF_REPEATS ?? "5", 10);
const budget = 60_000;

const cases = [
  ["start", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "white"],
  ["greek-gift", "r1bq1rk1/pppnbppp/4p3/3pP1B1/3P3P/2NB4/PPP2PP1/R2QK1NR w KQ - 1 8", "white"],
  ["sharp-middlegame", "2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1", "white"],
  ["W1", "4k3/8/8/8/8/8/8/4KQ2 w - - 0 1", "white"],
  ["W3", "4k3/8/8/8/8/8/8/R3K3 w - - 0 1", "white"],
  ["W5", "8/4P1k1/4K3/8/8/8/8/8 w - - 0 1", "white"]
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
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(backend, label, samples, report) {
  return {
    backend,
    label,
    median_ms: Number(percentile(samples, 50).toFixed(1)),
    p95_ms: Number(percentile(samples, 95).toFixed(1)),
    samples_ms: samples.map((sample) => Number(sample.toFixed(1))),
    depth: report.depth,
    total_nodes: report.nodes,
    candidate_count: report.candidates.length,
    best_move: report.candidates[0]?.move ?? report.candidates[0]?.mv ?? null
  };
}

function measureNative() {
  for (const [label, fen, side] of cases) {
    const samples = [];
    let report = null;
    for (let index = 0; index < repeats; index += 1) {
      const started = performance.now();
      const stdout = run("target/release/chess-cli", [
        "side-explore",
        "--fen",
        fen,
        "--side",
        side,
        "--budget",
        String(budget),
        "--aggressive"
      ]);
      samples.push(performance.now() - started);
      report = JSON.parse(stdout);
    }
    console.log(JSON.stringify(summarize("native-classical", label, samples, report)));
  }
}

async function measureWasm() {
  const module = await import(`${pkgRoot}/chess_wasm_bridge_embedded.mjs?cache=${Date.now()}`);
  for (const [label, fen, side] of cases) {
    const samples = [];
    let report = null;
    for (let index = 0; index < repeats; index += 1) {
      const started = performance.now();
      const parsed = JSON.parse(
        module.side_explore_context_json(fen, side, true, "", new Uint8Array())
      );
      samples.push(performance.now() - started);
      if (!parsed.ok) throw new Error(`wasm-classical ${label} failed: ${JSON.stringify(parsed)}`);
      report = parsed.sideExplore;
    }
    console.log(JSON.stringify(summarize("wasm-classical", label, samples, report)));
  }
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(pkgRoot, { recursive: true });
run("cargo", ["build", "-p", "chess-cli", "--release"]);
run("cargo", ["build", "-p", "chess-wasm-bridge", "--target", "wasm32-unknown-unknown", "--release"]);
run("wasm-bindgen", [
  "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm",
  "--target",
  "bundler",
  "--out-dir",
  pkgRoot
]);
writeEmbeddedWasmModule(outputRoot, { assertExpectedImports: true, removeWasmAsset: true });
measureNative();
await measureWasm();
