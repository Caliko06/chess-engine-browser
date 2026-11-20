import { homedir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { writeEmbeddedWasmModule } from "./beta-preview-support.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const outputRoot = "/private/tmp/chess-explore-aggressive-latency-provisional";
const pkgRoot = join(outputRoot, "dist/pkg");
const repeats = Number.parseInt(process.env.CHESS_EXPLORE_LATENCY_REPEATS ?? "3", 10);
const concurrentFallback = process.env.CHESS_EXPLORE_LATENCY_CONCURRENT_FALLBACK !== "0";
const modes = [
  { name: "fast", budget: 22_000 },
  { name: "deep", budget: 44_000 }
];
const cases = [
  ["start", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "white", true],
  ["greek-gift", "r1bq1rk1/pppnbppp/4p3/3pP1B1/3P3P/2NB4/PPP2PP1/R2QK1NR w KQ - 1 8", "white", true],
  ["sharp-middlegame", "2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1", "white", true],
  ["owner-adr0221", "r2k1b1r/1ppBpp1p/8/p2pN1p1/Q2Pb1n1/P1P1P3/1P3BPP/RN2K2R b KQ - 0 14", "black", true],
  ["owner-adr0219", "8/1P3pk1/4p3/4P3/3P1PP1/8/3Q3K/6R1 b - - 0 46", "black", true],
  ["owner-adr0220", "7r/k1pr4/3p1p2/Pp2pN2/4P1n1/1P6/4K2p/2R5 w - - 0 35", "white", true],
  ["king-pawn-promotion", "8/4P1k1/4K3/8/8/8/8/8 w - - 0 1", "white", false]
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

function normalizeSideExplore(report) {
  return {
    move: report.candidates?.[0]?.move ?? null,
    candidates: (report.candidates ?? []).map((candidate) => ({
      move: candidate.move,
      sound: candidate.sound,
      scoreCp: candidate.exactScoreCp ?? null,
      sacrifice: candidate.sacrifice ?? false,
      mateIn: candidate.mateIn ?? null
    })),
    principalLine: report.principalLine ?? [],
    depth: report.depth,
    nodes: report.nodes
  };
}

function normalizeBestMove(report) {
  return {
    move: report.bestMove ?? null,
    candidates: [],
    principalLine: report.principalLine ?? [],
    depth: report.depth,
    nodes: report.nodes
  };
}

async function measureSamples(fn) {
  const samples = [];
  let report = null;
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    report = await fn();
    samples.push(performance.now() - started);
  }
  return {
    samplesMs: samples.map((sample) => Number(sample.toFixed(1))),
    p95Ms: Number(percentile(samples, 95).toFixed(1)),
    medianMs: Number(percentile(samples, 50).toFixed(1)),
    ...report
  };
}

function workerCall(modulePath, payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      import { parentPort, workerData } from "node:worker_threads";
      const module = await import(workerData.modulePath);
      const weights = new Uint8Array(workerData.weights);
      const started = performance.now();
      let envelope;
      if (workerData.op === "fallback") {
        envelope = JSON.parse(module.best_move_json(workerData.fen, 1, false, 60000));
      } else {
        envelope = JSON.parse(module.side_explore_context_v2_json(
          workerData.fen,
          workerData.side,
          workerData.aggressive,
          "",
          weights,
          workerData.budget,
          ""
        ));
      }
      parentPort.postMessage({ elapsedMs: performance.now() - started, envelope });
      `,
      {
        eval: true,
        workerData: {
          ...payload,
          modulePath: `${modulePath}?worker=${Date.now()}-${Math.random()}`,
          weights: Array.from(payload.weights)
        }
      }
    );
    worker.once("message", (message) => resolve(message));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

async function measureCombined(modulePath, payload) {
  const samples = [];
  let rich = null;
  let fallback = null;
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    const [fallbackResult, richResult] = concurrentFallback
      ? await Promise.all([
          workerCall(modulePath, { ...payload, op: "fallback" }),
          workerCall(modulePath, { ...payload, op: "rich" })
        ])
      : [null, await workerCall(modulePath, { ...payload, op: "rich" })];
    samples.push(performance.now() - started);
    fallback = fallbackResult;
    rich = richResult;
  }
  if ((concurrentFallback && !fallback?.envelope.ok) || !rich?.envelope.ok) {
    throw new Error(`combined route failed: ${JSON.stringify({ fallback, rich })}`);
  }
  return {
    samplesMs: samples.map((sample) => Number(sample.toFixed(1))),
    p95Ms: Number(percentile(samples, 95).toFixed(1)),
    medianMs: Number(percentile(samples, 50).toFixed(1)),
    fallbackSuppressedBeforeDeadline: !concurrentFallback,
    fallbackElapsedMs: fallback === null ? null : Number(fallback.elapsedMs.toFixed(1)),
    richElapsedMs: Number(rich.elapsedMs.toFixed(1)),
    fallback: fallback === null ? null : normalizeBestMove(fallback.envelope.bestMove),
    rich: normalizeSideExplore(rich.envelope.sideExplore)
  };
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

const modulePath = prepareWasm();
const module = await import(`${modulePath}?cache=${Date.now()}`);
if (typeof module.side_explore_context_v2_json !== "function") {
  throw new Error("measurement requires side_explore_context_v2_json");
}
if (typeof module.side_explore_context_json === "function" && process.env.CHESS_FORCE_V1_MEASURE === "1") {
  throw new Error("v1 measurement is forbidden for this packet");
}
const backend = { name: "wasm-classical", weights: new Uint8Array() };

for (const [label, fen, side, aggressive] of cases) {
  const fallback = await measureSamples(() => {
    const parsed = JSON.parse(module.best_move_json(fen, 1, false, 60_000));
    if (!parsed.ok) throw new Error(`fallback failed: ${JSON.stringify(parsed)}`);
    return normalizeBestMove(parsed.bestMove);
  });
  console.log(JSON.stringify({ route: "fallback", backend: backend.name, label, fen, side, aggressive, ...fallback }));

  for (const mode of modes) {
    const payload = { fen, side, aggressive, budget: mode.budget, weights: backend.weights };
    const rich = await measureSamples(() => {
      const parsed = JSON.parse(
        module.side_explore_context_v2_json(fen, side, aggressive, "", backend.weights, mode.budget, "")
      );
      if (!parsed.ok) throw new Error(`rich failed: ${JSON.stringify(parsed)}`);
      return normalizeSideExplore(parsed.sideExplore);
    });
    console.log(JSON.stringify({ route: `rich-${mode.name}`, backend: backend.name, label, fen, side, aggressive, budget: mode.budget, ...rich }));
    const combined = await measureCombined(modulePath, payload);
    console.log(JSON.stringify({ route: `combined-${mode.name}`, backend: backend.name, label, fen, side, aggressive, budget: mode.budget, ...combined }));
  }
}
