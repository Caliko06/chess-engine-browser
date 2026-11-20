import { homedir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { writeEmbeddedWasmModule } from "./beta-preview-support.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const outputRoot = "/private/tmp/chess-adr0221-acceptance";
const pkgRoot = join(outputRoot, "dist/pkg");
const repeats = Number.parseInt(process.env.CHESS_ADR0221_REPEATS ?? "3", 10);
const modes = [
  { name: "fast", budget: 22_000, ceilingMs: 10_000 },
  { name: "deep", budget: 60_000, ceilingMs: 15_000 }
];

const cases = [
  ["start", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "white", false],
  ["greek-gift", "r1bq1rk1/pppnbppp/4p3/3pP1B1/3P3P/2NB4/PPP2PP1/R2QK1NR w KQ - 1 8", "white", false],
  ["sharp-middlegame", "2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1", "white", false],
  ["W1", "4k3/8/8/8/8/8/8/4KQ2 w - - 0 1", "white", false],
  ["W3", "4k3/8/8/8/8/8/8/R3K3 w - - 0 1", "white", false],
  ["W5", "8/4P1k1/4K3/8/8/8/8/8 w - - 0 1", "white", false],
  ["owner-incident-adr0221", "r2k1b1r/1ppBpp1p/8/p2pN1p1/Q2Pb1n1/P1P1P3/1P3BPP/RN2K2R b KQ - 0 14", "black", true],
  ["owner-adr0219", "8/1P3pk1/4p3/4P3/3P1PP1/8/3Q3K/6R1 b - - 0 46", "black", true]
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

function candidateMove(candidate) {
  return candidate?.move ?? candidate?.mv ?? null;
}

function candidateSound(candidate) {
  return candidate?.sound ?? null;
}

function candidateBrilliant(candidate) {
  return candidate?.prospectiveBrilliant ?? candidate?.prospective_brilliant ?? false;
}

function normalizeReport(report) {
  return {
    depth: report.depth,
    nodes: report.nodes,
    candidates: report.candidates,
    principalLine: report.principalLine ?? report.principal_line ?? [],
    topMove: candidateMove(report.candidates[0]),
    topSound: candidateSound(report.candidates[0]),
    topBrilliant: candidateBrilliant(report.candidates[0])
  };
}

function assertReport(label, mode, backend, ownerCase, elapsedMs, ceilingMs, rawReport) {
  const report = normalizeReport(rawReport);
  if (elapsedMs >= ceilingMs) {
    throw new Error(`${backend}/${mode}/${label} exceeded ceiling: ${elapsedMs.toFixed(1)}ms >= ${ceilingMs}ms`);
  }
  if (report.topMove === null) {
    throw new Error(`${backend}/${mode}/${label} returned no visible candidate`);
  }
  if (report.topSound === false && report.topBrilliant === true) {
    throw new Error(`${backend}/${mode}/${label} certified Brilliant on an unsound top candidate`);
  }
  if (ownerCase && report.principalLine.length === 0) {
    throw new Error(`${backend}/${mode}/${label} owner FEN returned an empty principal line`);
  }
  return report;
}

function summarize(backend, mode, label, samples, report) {
  return {
    phase: "ADR0221_ACCEPTANCE",
    backend,
    mode,
    label,
    medianMs: Number(percentile(samples, 50).toFixed(1)),
    maxMs: Number(Math.max(...samples).toFixed(1)),
    samplesMs: samples.map((sample) => Number(sample.toFixed(1))),
    depth: report.depth,
    nodes: report.nodes,
    topMove: report.topMove,
    topSound: report.topSound,
    principalLine: report.principalLine.slice(0, 5)
  };
}

function measureNative() {
  const summaries = [];
  for (const [label, fen, side, ownerCase] of cases) {
    for (const mode of modes) {
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
          String(mode.budget),
          "--aggressive"
        ]);
        const elapsed = performance.now() - started;
        samples.push(elapsed);
        report = assertReport(label, mode.name, "native-classical", ownerCase, elapsed, mode.ceilingMs, JSON.parse(stdout));
      }
      summaries.push(summarize("native-classical", mode.name, label, samples, report));
    }
  }
  return summaries;
}

async function measureWasm() {
  const summaries = [];
  const module = await import(`${pkgRoot}/chess_wasm_bridge_embedded.mjs?cache=${Date.now()}`);
  const backend = "embedded-wasm-classical";
  for (const [label, fen, side, ownerCase] of cases) {
    for (const mode of modes) {
      const samples = [];
      let report = null;
      for (let index = 0; index < repeats; index += 1) {
        const started = performance.now();
        const parsed = JSON.parse(
          module.side_explore_context_v2_json(
            fen,
            side,
            true,
            "",
            new Uint8Array(),
            mode.budget,
            ""
          )
        );
        const elapsed = performance.now() - started;
        samples.push(elapsed);
        if (!parsed.ok) {
          throw new Error(`${backend}/${mode.name}/${label} failed: ${JSON.stringify(parsed)}`);
        }
        report = assertReport(label, mode.name, backend, ownerCase, elapsed, mode.ceilingMs, parsed.sideExplore);
      }
      summaries.push(summarize(backend, mode.name, label, samples, report));
    }
  }
  return summaries;
}

function assertDeepBenefit(summaries) {
  const backends = [
    ...new Set(summaries.flatMap((summary) => (summary.status === "NOT_RUN" ? [] : [summary.backend])))
  ];
  for (const backend of backends) {
    const rows = summaries.filter((row) => row.backend === backend);
    const improved = rows.some((row) => {
      if (row.mode !== "deep") return false;
      const fast = rows.find((candidate) => candidate.mode === "fast" && candidate.label === row.label);
      return fast !== undefined && row.depth > fast.depth;
    });
    if (!improved) {
      throw new Error(`${backend} Deep did not complete an additional full depth on any acceptance FEN`);
    }
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

const summaries = [...measureNative(), ...(await measureWasm())];
assertDeepBenefit(summaries);
for (const summary of summaries) {
  console.log(JSON.stringify(summary));
}
