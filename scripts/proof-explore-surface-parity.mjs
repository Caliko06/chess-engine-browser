import { homedir } from "node:os";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  assertWasmBindgenCliVersion,
  repoRoot,
  run,
  writeEmbeddedWasmModule
} from "./beta-preview-support.mjs";

const evidencePath =
  `${homedir()}/chess-nnue/play-evidence/2026-07-15-7a8c7ef9-5b4f-4adc-ae78-cb9a097ed53c.jsonl`;
const outputRoot = "/private/tmp/chess-explore-surface-parity";
const recordedSeqs = new Set([76, 77, 81, 82, 86, 87]);
const budgets = [22_000, 60_000];

function assert(condition, message, context) {
  if (!condition) {
    throw new Error(`${message}${context === undefined ? "" : `: ${JSON.stringify(context)}`}`);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${process.env.PATH ?? ""}`
    },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

function evidenceRows() {
  const rows = [];
  const moveHistory = [];
  for (const line of readFileSync(evidencePath, "utf8").split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === "recommendation" && recordedSeqs.has(event.seq)) {
      rows.push({
        seq: event.seq,
        fen: event.fenBefore,
        side: event.userSide,
        aggressive: event.aggressive,
        historyFens: moveHistory.join("\n"),
        recordedPrimary: event.primaryMove,
        recordedRenderState: event.primaryRenderState,
        recordedCandidates: event.candidates
      });
    }
    if (event.type === "move") {
      moveHistory.push(event.fenBefore);
    }
  }
  assert(rows.length === recordedSeqs.size, "must load every named evidence row", {
    found: rows.map((row) => row.seq)
  });
  return rows;
}

function canonicalFromSideExplore(row, budget, sideExplore) {
  return {
    seq: row.seq,
    budget,
    fen: row.fen,
    side: row.side,
    onTurn: sideExplore.onTurn,
    primaryMove: sideExplore.candidates[0]?.move ?? null,
    candidates: sideExplore.candidates.map((candidate, index) => ({
      rank: index + 1,
      move: candidate.move,
      scoreCp: candidate.exactScoreCp,
      sound: candidate.sound,
      sacrifice: candidate.sacrifice
    })),
    principalLine: sideExplore.principalLine,
    planStatus: sideExplore.planStatus ?? null,
    planReason: sideExplore.planReason ?? null
  };
}

function canonicalKey(entry) {
  return `${entry.seq}:${entry.budget}`;
}

function normalizeForParity(entry) {
  return JSON.stringify({
    seq: entry.seq,
    budget: entry.budget,
    fen: entry.fen,
    side: entry.side,
    onTurn: entry.onTurn,
    primaryMove: entry.primaryMove,
    candidates: entry.candidates,
    principalLine: entry.principalLine,
    planStatus: entry.planStatus,
    planReason: entry.planReason
  });
}

function nativeEntries() {
  const output = runCapture("cargo", [
    "test",
    "--release",
    "-p",
    "chess-wasm-bridge",
    "--test",
    "explore_surface_parity",
    "--",
    "--ignored",
    "--nocapture"
  ]);
  const entries = new Map();
  for (const line of output.split("\n")) {
    if (!line.startsWith("PARITY_NATIVE ")) {
      continue;
    }
    const parsed = JSON.parse(line.slice("PARITY_NATIVE ".length));
    entries.set(canonicalKey(parsed), {
      seq: parsed.seq,
      budget: parsed.budget,
      fen: parsed.fen,
      side: parsed.side,
      onTurn: parsed.onTurn,
      primaryMove: parsed.primaryMove,
      candidates: parsed.candidates.map((candidate) => ({
        rank: candidate.rank,
        move: candidate.move,
        scoreCp: candidate.scoreCp,
        sound: candidate.sound,
        sacrifice: candidate.sacrifice
      })),
      principalLine: parsed.principalLine,
      planStatus: parsed.planStatus,
      planReason: parsed.planReason
    });
  }
  assert(entries.size === recordedSeqs.size * budgets.length, "native printer emitted wrong row count", {
    count: entries.size
  });
  return entries;
}

function prepareWasm() {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(join(outputRoot, "dist/pkg"), { recursive: true });
  run("node", ["scripts/audit-policy.mjs"]);
  run("pnpm", ["--filter", "web", "run", "build"]);
  assertWasmBindgenCliVersion("Explore surface parity");
  run("cargo", ["build", "-p", "chess-wasm-bridge", "--target", "wasm32-unknown-unknown", "--release"]);
  run("wasm-bindgen", [
    "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm",
    "--target",
    "bundler",
    "--out-dir",
    join(outputRoot, "dist/pkg")
  ]);
  writeEmbeddedWasmModule(outputRoot, { removeWasmAsset: true });
  return join(outputRoot, "dist/pkg/chess_wasm_bridge_embedded.mjs");
}

async function wasmEntries(rows) {
  const modulePath = prepareWasm();
  const wasm = await import(`file://${modulePath}?cacheBust=${Date.now()}`);
  const entries = new Map();
  for (const row of rows) {
    for (const budget of budgets) {
      const envelope = JSON.parse(
        wasm.side_explore_context_v2_json(
          row.fen,
          row.side,
          row.aggressive,
          row.historyFens,
          new Uint8Array(),
          budget,
          ""
        )
      );
      assert(envelope.ok === true, "wasm sideExplore v2 failed", { row, envelope });
      const canonical = canonicalFromSideExplore(row, budget, envelope.sideExplore);
      entries.set(canonicalKey(canonical), canonical);
    }
  }
  return entries;
}

function compareRecorded(rows, entries) {
  const results = [];
  for (const row of rows) {
    const actual = entries.get(`${row.seq}:22000`);
    assert(actual !== undefined, "missing 22k entry for recorded comparison", row);
    const recorded = row.recordedCandidates.map((candidate) => ({
      rank: candidate.rank,
      move: candidate.move,
      scoreCp: candidate.scoreCp,
      sound: candidate.sound,
      sacrifice: candidate.sacrifice
    }));
    results.push({
      seq: row.seq,
      recordedPrimary: row.recordedPrimary,
      actualPrimary: actual.primaryMove,
      recordedRenderState: row.recordedRenderState,
      candidatesMatch: JSON.stringify(recorded) === JSON.stringify(actual.candidates)
    });
  }
  return results;
}

const rows = evidenceRows();
const native = nativeEntries();
const wasm = await wasmEntries(rows);
const mismatches = [];
for (const [key, nativeEntry] of native) {
  const wasmEntry = wasm.get(key);
  if (wasmEntry === undefined || normalizeForParity(nativeEntry) !== normalizeForParity(wasmEntry)) {
    mismatches.push({ key, native: nativeEntry, wasm: wasmEntry ?? null });
  }
}
if (mismatches.length > 0) {
  console.error("PARITY_MISMATCH");
  console.error(JSON.stringify(mismatches, null, 2));
  process.exit(1);
}

const recorded = compareRecorded(rows, native);
for (const entry of [...native.values()].sort((a, b) => a.seq - b.seq || a.budget - b.budget)) {
  console.log(`PARITY_MATCH ${JSON.stringify(entry)}`);
}
for (const row of recorded) {
  console.log(`RECORDED_COMPARE ${JSON.stringify(row)}`);
}
const recordedMatches = recorded.filter((row) => row.candidatesMatch).length;
console.log(
  `Explore surface parity passed: native_wasm_rows=${native.size} recorded_22k_matches=${recordedMatches}/${recorded.length}`
);
