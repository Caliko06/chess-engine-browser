import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertWasmBindgenCliVersion,
  repoRoot,
  run,
  writeEmbeddedWasmModule
} from "./beta-preview-support.mjs";

const evidenceRoot = join(repoRoot, "tmp/play-evidence");
const outputRoot = join(repoRoot, "target/proofs/replay-evidence-trust");
const materialGapCp = 300;
const rescoreBudget = 240_000;

function assert(condition, message, context) {
  if (!condition) {
    throw new Error(`${message}${context === undefined ? "" : `: ${JSON.stringify(context)}`}`);
  }
}

function parseArgs(argv) {
  const files = [];
  let expectZero = false;
  let candidateBuildSha = null;
  let candidateWasmSha256 = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("missing value for --file");
      }
      files.push(value);
      index += 1;
    } else if (arg === "--expect-zero") {
      expectZero = true;
    } else if (arg === "--candidate-build-sha") {
      candidateBuildSha = argv[index + 1] ?? null;
      if (candidateBuildSha === null || candidateBuildSha.startsWith("--")) {
        throw new Error("missing value for --candidate-build-sha");
      }
      index += 1;
    } else if (arg === "--candidate-wasm-sha256") {
      candidateWasmSha256 = argv[index + 1] ?? null;
      if (candidateWasmSha256 === null || candidateWasmSha256.startsWith("--")) {
        throw new Error("missing value for --candidate-wasm-sha256");
      }
      index += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  const selectorsComplete = candidateBuildSha !== null && candidateWasmSha256 !== null;
  assert(
    selectorsComplete || (candidateBuildSha === null && candidateWasmSha256 === null),
    "candidate artifact requires both --candidate-build-sha and --candidate-wasm-sha256"
  );
  assert(!expectZero || selectorsComplete, "--expect-zero requires an exact candidate artifact identity");
  if (candidateWasmSha256 !== null) {
    assert(/^[a-f0-9]{64}$/u.test(candidateWasmSha256), "candidate WASM SHA-256 must be 64 lowercase hex characters");
  }
  return {
    files,
    expectZero,
    candidateIdentity: selectorsComplete ? { buildSha: candidateBuildSha, wasmSha256: candidateWasmSha256 } : null
  };
}

function evidenceFiles(selectedFiles) {
  if (selectedFiles.length > 0) {
    return selectedFiles;
  }
  return readdirSync(evidenceRoot)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(evidenceRoot, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

function prepareWasm() {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(join(outputRoot, "dist/pkg"), { recursive: true });
  assertWasmBindgenCliVersion("Replay evidence trust");
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

function buildCli() {
  run("cargo", ["build", "-p", "chess-cli", "--release"]);
}

function bestMoveScoreForSide(afterFen, side, cache) {
  const key = `${side}:${afterFen}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const result = spawnSync(
    "target/release/chess-cli",
    ["best-move", "--fen", afterFen, "--budget", String(rescoreBudget)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:/opt/homebrew/sbin:${process.env.PATH ?? ""}`
      }
    }
  );
  if (result.status !== 0) {
    throw new Error(`best-move failed for ${afterFen}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  assert(typeof parsed.objective_score_cp === "number", "best-move output missing objective_score_cp", parsed);
  const scoreForCandidateSide =
    sideToFenToken(side) === parsed.fen.split(" ")[1]
      ? parsed.objective_score_cp
      : -parsed.objective_score_cp;
  cache.set(key, scoreForCandidateSide);
  return scoreForCandidateSide;
}

function sideToFenToken(side) {
  return side === "white" ? "w" : "b";
}

function isProjectedOffTurn(row) {
  return row.fenBefore.split(" ")[1] !== sideToFenToken(row.side);
}

function candidateRecords(event) {
  if (!Array.isArray(event.candidates)) {
    return [];
  }
  return event.candidates
    .filter((candidate, index) =>
      candidate !== null &&
      typeof candidate === "object" &&
      typeof candidate.move === "string" &&
      typeof candidate.scoreCp === "number" &&
      candidate.sound === true
    )
    .map((candidate, index) => ({
      move: candidate.move,
      scoreCp: candidate.scoreCp,
      sound: candidate.sound === true,
      rank: typeof candidate.rank === "number" ? candidate.rank : index + 1
    }));
}

function hasExactIdentity(event, identity) {
  return identity !== null && event.buildSha === identity.buildSha && event.wasmSha256 === identity.wasmSha256;
}

function replayEvents(path, candidateIdentity) {
  const events = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (line.trim() === "") {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`${basename(path)}:${String(index + 1)} malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const selected = hasExactIdentity(event, candidateIdentity);
    if (selected) {
      assert(typeof event.fenBefore === "string" && event.fenBefore !== "", "selected row missing fenBefore", {
        file: basename(path), line: index + 1
      });
      assert(event.type === "recommendation" || event.type === "move", "selected row has unsupported type", {
        file: basename(path), line: index + 1, type: event.type ?? null
      });
      if (event.type === "recommendation") {
        assert(Array.isArray(event.candidates), "selected recommendation missing candidates", {
          file: basename(path), line: index + 1
        });
        for (const [candidateIndex, candidate] of event.candidates.entries()) {
          if (candidate?.sound === true) {
            assert(
              typeof candidate.move === "string" && typeof candidate.scoreCp === "number",
              "selected sound candidate is malformed",
              { file: basename(path), line: index + 1, candidateIndex }
            );
          }
        }
      } else {
        assert(typeof event.move === "string" && event.move !== "", "selected move missing move", {
          file: basename(path), line: index + 1
        });
      }
    }
    if (typeof event.fenBefore !== "string") {
      continue;
    }
    const side = typeof event.userSide === "string" ? event.userSide : event.fenBefore.split(" ")[1] === "w" ? "white" : "black";
    if (event.type === "recommendation") {
      events.push({
        type: "recommendation",
        line: index + 1,
        seq: event.seq ?? null,
        buildSha: typeof event.buildSha === "string" ? event.buildSha : "unknown",
        wasmSha256: typeof event.wasmSha256 === "string" ? event.wasmSha256 : "unknown",
        selected,
        fenBefore: event.fenBefore,
        side,
        primaryRenderState: event.primaryRenderState ?? "unknown",
        candidates: candidateRecords(event),
      });
    } else if (event.type === "move" && typeof event.move === "string") {
      events.push({
        type: "move",
        line: index + 1,
        seq: event.seq ?? null,
        buildSha: typeof event.buildSha === "string" ? event.buildSha : "unknown",
        wasmSha256: typeof event.wasmSha256 === "string" ? event.wasmSha256 : "unknown",
        selected,
        fenBefore: event.fenBefore,
        side,
        move: event.move,
        actor: event.actor ?? "unknown"
      });
    }
  }
  return events;
}

function certifiedEvent(file, row, candidate, rescoreCp, gapCp, source) {
  return {
    file: basename(file),
    line: row.line,
    seq: row.seq,
    buildSha: row.buildSha,
    fenBefore: row.fenBefore,
    side: row.side,
    move: candidate.move,
    rank: candidate.rank,
    scoreCp: candidate.scoreCp,
    rescoreCp,
    gapCp,
    source,
    primaryRenderState: row.primaryRenderState ?? null
  };
}

function diagnosticEvent(file, row, candidate, rescoreCp, gapCp, source) {
  return {
    file: basename(file),
    line: row.line,
    seq: row.seq,
    buildSha: row.buildSha,
    fenBefore: row.fenBefore,
    move: candidate.move,
    source,
    scoreCp: candidate.scoreCp,
    rescoreCp,
    gapCp
  };
}

function applyMove(wasm, fen, move) {
  const envelope = JSON.parse(wasm.make_move_json(fen, move));
  if (envelope.ok !== true) {
    return null;
  }
  return envelope.move.state.fen;
}

function applyEligibleMove(wasm, row, candidate, file) {
  const afterFen = applyMove(wasm, row.fenBefore, candidate.move);
  if (afterFen === null && row.selected) {
    throw new Error(`selected eligible candidate is illegal: ${basename(file)}:${String(row.line)} ${candidate.move}`);
  }
  return afterFen;
}

function assertCandidateAcceptance(summary) {
  assert(summary.candidateRecommendationRows > 0, "candidate population has zero replayable recommendation rows", summary);
  assert(summary.candidateRescoredCandidates > 0, "candidate population has zero rescored eligible candidates", summary);
  assert(summary.candidateCertifiedBlunders === 0, "candidate population contains certified blunders", summary);
}

function summarizeByBuild(events) {
  const counts = new Map();
  for (const event of events) {
    counts.set(event.buildSha, (counts.get(event.buildSha) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([buildSha, count]) => ({ buildSha, count }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = evidenceFiles(args.files);
  const modulePath = prepareWasm();
  buildCli();
  const wasm = await import(`file://${modulePath}?cacheBust=${Date.now()}`);
  const scoreCache = new Map();
  const certified = [];
  const diagnostics = [];
  let recommendationRows = 0;
  let checkedCandidates = 0;
  let followedMovesChecked = 0;
  let exactCandidateRows = 0;
  let candidateRecommendationRows = 0;
  let candidateRescoredCandidates = 0;
  let candidateCertifiedBlunders = 0;
  let unreplayableProjected = 0;

  const allAnomalies = [];

  for (const file of files) {
    const fileEvents = [];
    const fileAnomalies = [];
    const priorCandidates = new Map();
    for (const row of replayEvents(file, args.candidateIdentity)) {
      if (row.selected) {
        exactCandidateRows += 1;
      }
      if (row.type === "recommendation") {
        recommendationRows += 1;
        const offTurn = isProjectedOffTurn(row);
        if (offTurn) {
          unreplayableProjected += 1;
          console.log(`UNREPLAYABLE_PROJECTED ${JSON.stringify({ file: basename(file), line: row.line, seq: row.seq, selected: row.selected })}`);
          continue;
        }
        if (row.selected) {
          candidateRecommendationRows += 1;
        }
        for (const candidate of row.candidates) {
          priorCandidates.set(`${row.fenBefore}:${candidate.move}`, { ...candidate, selected: row.selected });
        }
        for (const candidate of row.candidates) {
          checkedCandidates += 1;
          const afterFen = applyEligibleMove(wasm, row, candidate, file);
          if (afterFen === null) {
            console.log(`UNREPLAYABLE_ILLEGAL ${JSON.stringify({ file: basename(file), line: row.line, move: candidate.move, selected: false })}`);
            continue;
          }
          const afterToken = afterFen.split(" ")[1];
          if (afterToken === sideToFenToken(row.side)) {
            // ADR-0254: a candidate whose applied move leaves the turn on the row's
            // own side is a cross-side evidence anomaly (e.g. a recorded userSide
            // toggle between adjacent rows from the same startpos), not a crash.
            // Classify and skip rescoring this candidate; never silently drop it.
            fileAnomalies.push({ file: basename(file), seq: row.seq, side: row.side, move: candidate.move });
            continue;
          }
          const rescoreCp = bestMoveScoreForSide(afterFen, row.side, scoreCache);
          if (row.selected) {
            candidateRescoredCandidates += 1;
          }
          const gapCp = candidate.scoreCp - rescoreCp;
          if (gapCp >= materialGapCp) {
            fileEvents.push(certifiedEvent(file, row, candidate, rescoreCp, gapCp, "recommendation"));
            if (row.selected) {
              candidateCertifiedBlunders += 1;
            }
          }
          if (candidate.move === "h5h4" || candidate.move === "h8h5" || candidate.move === "h4h3") {
            diagnostics.push(diagnosticEvent(file, row, candidate, rescoreCp, gapCp, "recommendation"));
          }
        }
        continue;
      }

      const followed = priorCandidates.get(`${row.fenBefore}:${row.move}`);
      if (followed !== undefined) {
        followedMovesChecked += 1;
        const candidate = followed;
        const followedRow = { ...row, selected: row.selected && candidate.selected };
        checkedCandidates += 1;
        const afterFen = applyEligibleMove(wasm, followedRow, candidate, file);
        if (afterFen === null) {
          console.log(`UNREPLAYABLE_ILLEGAL ${JSON.stringify({ file: basename(file), line: row.line, move: candidate.move, selected: false })}`);
          continue;
        }
        const afterToken = afterFen.split(" ")[1];
        if (afterToken === sideToFenToken(row.side)) {
          // ADR-0254: same classification as above, for the followed-move
          // certification path (this is the G001 historical anomaly: seq 933/934
          // side toggle followed by seq 935's e2e4 recorded as a black-side move).
          fileAnomalies.push({ file: basename(file), seq: row.seq, side: row.side, move: candidate.move });
          continue;
        }
        const rescoreCp = bestMoveScoreForSide(afterFen, row.side, scoreCache);
        if (followedRow.selected) {
          candidateRescoredCandidates += 1;
        }
        const gapCp = candidate.scoreCp - rescoreCp;
        if (gapCp >= materialGapCp) {
          fileEvents.push(certifiedEvent(file, row, candidate, rescoreCp, gapCp, "followed-move"));
          if (followedRow.selected) {
            candidateCertifiedBlunders += 1;
          }
        }
        if (candidate.move === "h5h4" || candidate.move === "h8h5" || candidate.move === "h4h3") {
          diagnostics.push(diagnosticEvent(file, row, candidate, rescoreCp, gapCp, "followed-move"));
        }
      }
    }
    for (const anomaly of fileAnomalies) {
      console.log(`CROSS_SIDE_ANOMALY ${JSON.stringify(anomaly)}`);
    }
    for (const event of fileEvents) {
      console.log(`CERTIFIED_BLUNDER ${JSON.stringify(event)}`);
    }
    console.log(
      `REPLAY_FILE ${JSON.stringify({
        file: basename(file),
        certifiedBlunders: fileEvents.length,
        crossSideAnomalies: fileAnomalies.length
      })}`
    );
    certified.push(...fileEvents);
    allAnomalies.push(...fileAnomalies);
  }

  const summary = {
    files: files.length,
    recommendationRows,
    checkedCandidates,
    followedMovesChecked,
    certifiedBlunders: certified.length,
    crossSideAnomalies: allAnomalies.length,
    exactCandidateRows,
    candidateRecommendationRows,
    candidateRescoredCandidates,
    candidateCertifiedBlunders,
    unreplayableProjected,
    byBuildSha: summarizeByBuild(certified)
  };
  for (const event of diagnostics) {
    console.log(`REPLAY_DIAGNOSTIC ${JSON.stringify(event)}`);
  }
  console.log(`REPLAY_SUMMARY ${JSON.stringify(summary)}`);
  if (args.expectZero) {
    assertCandidateAcceptance(summary);
  }
}

export {
  applyEligibleMove,
  assertCandidateAcceptance,
  candidateRecords,
  hasExactIdentity,
  isProjectedOffTurn,
  parseArgs,
  replayEvents
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
