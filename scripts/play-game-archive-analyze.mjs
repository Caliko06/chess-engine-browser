#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { ownedChessCliBinary } from "./play-analyzer-shared.mjs";
import {
  createLocalStockfishBestMoveProvider,
  playStockfishBinaryEnv,
  resolvePlayStockfishBinary
} from "./play-local-stockfish-adapter.mjs";

const defaultOracleDepth = 10;
const earlyPlyLimit = 10;
const materialDropCp = 150;
const defaultMinRepeat = 2;
const queenFiles = new Set(["d"]);
const minorPieceHome = new Set(["b1", "g1", "b8", "g8", "c1", "f1", "c8", "f8"]);

function usage() {
  return [
    "Usage: node scripts/play-game-archive-analyze.mjs --input <archive.json|archive.jsonl> [--output <report.json>] [--depth <n>] [--min-repeat <n>] [--owned-engine] [--no-oracle]",
    "",
    `Oracle is optional and uses ${playStockfishBinaryEnv} when configured.`,
    "Owned-engine comparison is offline-only and shells out to chess-cli best-move."
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    depth: defaultOracleDepth,
    oracle: true,
    minRepeat: defaultMinRepeat,
    ownedEngine: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      args.input = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--output") {
      args.output = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--depth") {
      args.depth = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
    } else if (arg === "--no-oracle") {
      args.oracle = false;
    } else if (arg === "--min-repeat") {
      args.minRepeat = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
    } else if (arg === "--owned-engine") {
      args.ownedEngine = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.input === null) {
    throw new Error("--input is required");
  }
  if (!Number.isInteger(args.depth) || args.depth < 1 || args.depth > 30) {
    throw new Error("--depth must be an integer from 1 to 30");
  }
  if (!Number.isInteger(args.minRepeat) || args.minRepeat < 1 || args.minRepeat > 100) {
    throw new Error("--min-repeat must be an integer from 1 to 100");
  }
  return args;
}

function loadArchiveGames(path) {
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") {
    return [];
  }
  if (raw.startsWith("{")) {
    try {
      return gamesFromValue(JSON.parse(raw), path);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  const games = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (line.trim() === "") {
      continue;
    }
    games.push(...gamesFromValue(JSON.parse(line), `${path}:${String(index + 1)}`));
  }
  return games;
}

function gamesFromValue(value, source) {
  if (isRecord(value) && Array.isArray(value.games)) {
    return value.games.map((game) => normalizeGame(game, source));
  }
  if (isRecord(value) && Array.isArray(value.moves)) {
    return [normalizeGame(value, source)];
  }
  throw new Error(`invalid archive shape in ${source}`);
}

export function normalizeGame(value, source) {
  if (!isRecord(value) || !Array.isArray(value.moves)) {
    throw new Error(`invalid game record in ${source}`);
  }
  const id = typeof value.id === "string" && value.id !== "" ? value.id : `${basename(source)}#${String(value.moves.length)}`;
  const selectedSide = value.selectedSide === "black" ? "black" : "white";
  const moves = value.moves.map((move, index) => normalizeMove(move, index + 1, selectedSide, id));
  return {
    id,
    selectedSide,
    playMode: typeof value.playMode === "string" ? value.playMode : "unknown",
    aggressive: value.aggressive === true,
    result: typeof value.result === "string" ? value.result : null,
    termination:
      value.termination === "checkmate" ||
      value.termination === "stalemate" ||
      value.termination === "draw" ||
      value.termination === "resigned"
        ? value.termination
        : null,
    resignedSide: value.resignedSide === "black" || value.resignedSide === "white" ? value.resignedSide : null,
    resignedBy: value.resignedBy === "rival" || value.resignedBy === "user" ? value.resignedBy : null,
    startFen: typeof value.startFen === "string" ? value.startFen : moves[0]?.fenBefore ?? null,
    finalFen: typeof value.finalFen === "string" ? value.finalFen : moves.at(-1)?.fenAfter ?? null,
    pgn: typeof value.pgn === "string" ? value.pgn : "",
    moves
  };
}

function normalizeMove(value, fallbackPly, selectedSide, gameId) {
  if (!isRecord(value)) {
    throw new Error(`invalid move in ${gameId} at ply ${String(fallbackPly)}`);
  }
  const side = value.side === "black" ? "black" : "white";
  const coordinate = typeof value.coordinate === "string" ? value.coordinate : "";
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(coordinate)) {
    throw new Error(`invalid coordinate in ${gameId} at ply ${String(fallbackPly)}`);
  }
  const fenBefore = typeof value.fenBefore === "string" ? value.fenBefore : null;
  const fenAfter = typeof value.fenAfter === "string" ? value.fenAfter : null;
  const attribution = normalizeMoveAttribution(value.attribution);
  const actor = value.actor === "engine" ? "engine" : value.actor === "player" ? "player" : null;
  const moveSelectedSide =
    value.selectedSide === "black" || value.selectedSide === "white" ? value.selectedSide : selectedSide;
  if (fenBefore === null || fenAfter === null) {
    throw new Error(`missing fenBefore/fenAfter in ${gameId} at ply ${String(fallbackPly)}`);
  }
  return {
    ply: typeof value.ply === "number" ? value.ply : fallbackPly,
    actor,
    side,
    // Role is always derived from the selected side. The stored actor is execution
    // provenance and may be player for both sides in reaction-lens.
    role: side === moveSelectedSide ? "user" : "rival",
    selectedSide: moveSelectedSide,
    attribution,
    buildSha:
      typeof value.buildSha === "string" && value.buildSha !== ""
        ? value.buildSha
        : attribution?.buildSha ?? null,
    evaluatorBackend:
      typeof value.evaluatorBackend === "string"
        ? value.evaluatorBackend
        : attribution?.evaluatorBackend ?? "unknown",
    engineDepth: typeof value.engineDepth === "number" ? value.engineDepth : attribution?.engineDepth ?? null,
    aggressive: typeof value.aggressive === "boolean" ? value.aggressive : attribution?.aggressive ?? null,
    recommendationBeforeMove: normalizeRecommendationSnapshot(value.recommendationBeforeMove),
    coordinate,
    san: typeof value.san === "string" ? value.san : coordinate,
    fenBefore,
    fenAfter
  };
}

function normalizeMoveAttribution(value) {
  if (!isRecord(value)) {
    return null;
  }
  return {
    buildSha: typeof value.buildSha === "string" && value.buildSha !== "" ? value.buildSha : null,
    evaluatorBackend: typeof value.evaluatorBackend === "string" ? value.evaluatorBackend : "unknown",
    engineDepth: typeof value.engineDepth === "number" ? value.engineDepth : null,
    aggressive: typeof value.aggressive === "boolean" ? value.aggressive : null
  };
}

function normalizeRecommendationSnapshot(value) {
  if (!isRecord(value)) {
    return null;
  }
  const candidates = Array.isArray(value.candidates)
    ? value.candidates
        .filter((candidate) => isRecord(candidate) && typeof candidate.move === "string")
        .map((candidate) => ({
          move: candidate.move,
          kind: typeof candidate.kind === "string" ? candidate.kind : "unknown",
          exactScoreCp: typeof candidate.exactScoreCp === "number" ? candidate.exactScoreCp : null,
          sound: candidate.sound === true,
          sacrifice: candidate.sacrifice === true,
          aftermath: typeof candidate.aftermath === "string" ? candidate.aftermath : null,
          mateIn: typeof candidate.mateIn === "number" ? candidate.mateIn : null,
          continuation: typeof candidate.continuation === "string" ? candidate.continuation : null,
          rank: typeof candidate.rank === "number" ? candidate.rank : null
        }))
    : [];
  return {
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    buildSha: typeof value.buildSha === "string" ? value.buildSha : null,
    evaluatorBackend: typeof value.evaluatorBackend === "string" ? value.evaluatorBackend : "unknown",
    level: typeof value.level === "number" ? value.level : null,
    seq: typeof value.seq === "number" ? value.seq : null,
    nodeBudget: typeof value.nodeBudget === "number" ? value.nodeBudget : null,
    exploreMode: typeof value.exploreMode === "string" ? value.exploreMode : "unknown",
    aggressive: value.aggressive === true,
    userSide: value.userSide === "black" ? "black" : value.userSide === "white" ? "white" : "unknown",
    ply: typeof value.ply === "number" ? value.ply : null,
    fenBefore: typeof value.fenBefore === "string" ? value.fenBefore : null,
    primaryMove: typeof value.primaryMove === "string" ? value.primaryMove : null,
    primaryRenderState: typeof value.primaryRenderState === "string" ? value.primaryRenderState : "unknown",
    side: value.side === "black" ? "black" : value.side === "white" ? "white" : "unknown",
    onTurn: value.onTurn === true,
    candidates,
    replyCandidates: Array.isArray(value.replyCandidates) ? value.replyCandidates : [],
    principalLine: Array.isArray(value.principalLine) ? value.principalLine : [],
    principalLineFirst: typeof value.principalLineFirst === "string" ? value.principalLineFirst : null,
    replyCandidateFirst: typeof value.replyCandidateFirst === "string" ? value.replyCandidateFirst : null
  };
}

function validateGameUnderstanding(game) {
  const errors = [];
  if (game.moves.length < 2) {
    errors.push("too-few-plies");
  }
  if (game.startFen !== null && game.moves[0]?.fenBefore !== game.startFen) {
    errors.push("start-fen-mismatch");
  }
  if (game.finalFen !== null && game.moves.at(-1)?.fenAfter !== game.finalFen) {
    errors.push("final-fen-mismatch");
  }
  for (const [index, move] of game.moves.entries()) {
    if (move.ply !== index + 1) {
      errors.push(`ply-index-mismatch:${String(index + 1)}`);
    }
    let fenSide = null;
    try {
      fenSide = sideToMove(move.fenBefore);
    } catch {
      errors.push(`invalid-fen-before:${String(move.ply)}`);
    }
    if (fenSide !== null && fenSide !== move.side) {
      errors.push(`side-to-move-mismatch:${String(move.ply)}`);
    }
    if (move.actor === null) {
      errors.push(`missing-actor:${String(move.ply)}`);
    } else {
      const expectedRole = move.side === game.selectedSide ? "user" : "rival";
      if (move.role !== expectedRole) {
        errors.push(`side-role-mismatch:${String(move.ply)}`);
      }
    }
    if (move.selectedSide !== game.selectedSide) {
      errors.push(`selected-side-at-ply-mismatch:${String(move.ply)}`);
    }
    if (move.attribution === null) {
      errors.push(`missing-move-time-attribution:${String(move.ply)}`);
    } else {
      if (typeof move.attribution.buildSha !== "string" || move.attribution.buildSha === "") {
        errors.push(`missing-move-build-sha:${String(move.ply)}`);
      }
      if (typeof move.attribution.engineDepth !== "number") {
        errors.push(`missing-move-engine-depth:${String(move.ply)}`);
      }
      if (typeof move.attribution.aggressive !== "boolean") {
        errors.push(`missing-move-aggressive:${String(move.ply)}`);
      }
    }
    const next = game.moves[index + 1];
    if (next !== undefined && move.fenAfter !== next.fenBefore) {
      errors.push(`fen-chain-break:${String(move.ply)}`);
    }
  }
  return {
    accepted: errors.length === 0,
    confidence: errors.length === 0 ? "high" : "low",
    errors
  };
}

function structuralLabels(game) {
  const labels = [];
  const visitsByPiece = new Map();
  for (const move of game.moves) {
    const pieceKey = `${move.side}:${move.coordinate.slice(0, 2)}`;
    const visits = visitsByPiece.get(pieceKey) ?? [];
    visitsByPiece.set(pieceKey, [...visits, move.ply]);
    const from = move.coordinate.slice(0, 2);
    const to = move.coordinate.slice(2, 4);
    const file = from[0];
    if (move.ply <= earlyPlyLimit && queenFiles.has(file) && move.san.includes("Q")) {
      labels.push(label(move, "early-queen-activity", "watch", { from, to }));
    }
    if (move.ply <= earlyPlyLimit && minorPieceHome.has(from)) {
      labels.push(label(move, "early-piece-development", "info", { from, to }));
    }
  }
  for (const [piece, plies] of visitsByPiece.entries()) {
    if (plies.length >= 2 && Math.min(...plies) <= earlyPlyLimit) {
      const [side, from] = piece.split(":");
      labels.push({
        ply: plies.at(-1),
        side,
        role: side === game.selectedSide ? "user" : "rival",
        kind: "repeated-early-piece-origin",
        severity: "watch",
        detail: { from, plies }
      });
    }
  }
  return labels;
}

function label(move, kind, severity, detail) {
  return {
    ply: move.ply,
    side: move.side,
    role: move.role,
    move: move.coordinate,
    positionKey: positionKeyFromFen(move.fenBefore),
    kind,
    severity,
    detail
  };
}

function positionKeyFromFen(fen) {
  const [pieces, side] = fen.split(/\s+/u);
  return `${pieces ?? "invalid"} ${side ?? "?"}`;
}

async function oracleLabels(game, provider, depth, evalByFen) {
  if (provider === null) {
    return [];
  }
  const labels = [];
  const evaluate = async (fen) => {
    const cached = evalByFen.get(fen);
    if (cached !== undefined) {
      return cached;
    }
    const result = await provider.bestMove(fen, depth);
    evalByFen.set(fen, result);
    return result;
  };
  for (const move of game.moves) {
    const before = await evaluate(move.fenBefore);
    const after = await evaluate(move.fenAfter);
    if (!before.ok || !after.ok) {
      labels.push(label(move, "oracle-unavailable-at-ply", "info", { depth }));
      continue;
    }
    const beforeCp = scoreForSide(before.value.scoreCp, sideToMove(move.fenBefore), move.side);
    const afterCp = scoreForSide(after.value.scoreCp, sideToMove(move.fenAfter), move.side);
    const deltaCp = afterCp - beforeCp;
    const severity = deltaCp <= -materialDropCp ? "fail" : "info";
    const scoreClassBefore = oracleScoreClass(beforeCp);
    const scoreClassAfter = oracleScoreClass(afterCp);
    const deltaClass = oracleDeltaClass(beforeCp, afterCp);
    labels.push(label(move, "oracle-move-delta", severity, {
      depth,
      bestBefore: before.value.bestMove,
      bestAfter: after.value.bestMove,
      moverCpBefore: beforeCp,
      moverCpAfter: afterCp,
      deltaCp,
      scoreClassBefore,
      scoreClassAfter,
      deltaClass,
      qualityBand: oracleQualityBand(deltaCp, deltaClass)
    }));
    const recommendationMatch = recommendationCandidateForMove(move);
    if (severity === "fail" && recommendationMatch !== null) {
      const { recommendation, candidate } = recommendationMatch;
      const isPrimary = recommendation.primaryMove === move.coordinate;
      labels.push(label(move, isPrimary ? "shallow-recommendation-failure" : "oracle-refuted-candidate", "fail", {
        depth,
        deltaCp,
        qualityBand: oracleQualityBand(deltaCp, deltaClass),
        recommendedMove: move.coordinate,
        recommendationRelation: isPrimary ? "primary" : "candidate",
        recommendationBuildSha: recommendation.buildSha,
        recommendationSeq: recommendation.seq,
        exploreMode: recommendation.exploreMode,
        nodeBudget: recommendation.nodeBudget,
        primaryMove: recommendation.primaryMove,
        primaryRenderState: recommendation.primaryRenderState,
        candidateExactScoreCp: candidate.exactScoreCp,
        candidateSound: candidate.sound,
        candidateKind: candidate.kind,
        candidateSacrifice: candidate.sacrifice,
        candidateAftermath: candidate.aftermath,
        principalLineFirst: recommendation.principalLineFirst,
        replyCandidateFirst: recommendation.replyCandidateFirst
      }));
    }
  }
  return labels;
}

function ownedEngineLabels(game, options) {
  if (!options.ownedEngine) {
    return [];
  }
  const labels = [];
  for (const move of game.moves) {
    const result = ownedBestMove(move.fenBefore, game.aggressive);
    if (!result.ok) {
      labels.push(label(move, "owned-engine-unavailable-at-ply", "info", { reason: result.reason }));
      continue;
    }
    labels.push(label(move, "owned-engine-move-comparison", result.bestMove === move.coordinate ? "info" : "watch", {
      bestMove: result.bestMove,
      playedMove: move.coordinate,
      aggressive: game.aggressive,
      evaluatorBackend: result.evaluatorBackend,
      objectiveScoreCp: result.objectiveScoreCp
    }));
  }
  return labels;
}


function ownedBestMove(fen, aggressive) {
  const binary = ownedChessCliBinary();
  if (!binary.ok) {
    return { ok: false, reason: binary.reason };
  }
  const args = [
    "best-move",
    "--fen",
    fen
  ];
  if (aggressive) {
    args.push("--aggressive");
  }
  const result = spawnSync(binary.path, args, {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return { ok: false, reason: "chess-cli-failed" };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      ok: true,
      bestMove: typeof parsed.best_move === "string" ? parsed.best_move : null,
      evaluatorBackend: typeof parsed.evaluator_backend === "string" ? parsed.evaluator_backend : "unknown",
      objectiveScoreCp: typeof parsed.objective_score_cp === "number" ? parsed.objective_score_cp : null
    };
  } catch {
    return { ok: false, reason: "chess-cli-json-failed" };
  }
}

function scoreForSide(cpFromSideToMove, fenSideToMove, side) {
  const whiteCp = fenSideToMove === "white" ? cpFromSideToMove : -cpFromSideToMove;
  return side === "white" ? whiteCp : -whiteCp;
}

const mateScoreThresholdCp = 99_000;

function oracleScoreClass(scoreCp) {
  return Math.abs(scoreCp) >= mateScoreThresholdCp ? "mate" : "centipawn";
}

function oracleDeltaClass(beforeCp, afterCp) {
  return oracleScoreClass(beforeCp) === "centipawn" && oracleScoreClass(afterCp) === "centipawn"
    ? "centipawn"
    : "mate-transition";
}

function oracleQualityBand(deltaCp, deltaClass) {
  if (deltaClass === "mate-transition") {
    return "mate-transition";
  }
  const lossCp = Math.max(0, -deltaCp);
  if (lossCp === 0) {
    return "best";
  }
  if (lossCp <= 50) {
    return "good";
  }
  if (lossCp <= 150) {
    return "inaccuracy";
  }
  if (lossCp <= 300) {
    return "mistake";
  }
  return "blunder";
}

function recommendationCandidateForMove(move) {
  const recommendation = move.recommendationBeforeMove;
  if (
    recommendation === null ||
    move.role !== "user" ||
    recommendation.fenBefore !== move.fenBefore ||
    recommendation.side !== move.side ||
    recommendation.userSide !== move.selectedSide ||
    !recommendation.onTurn ||
    !recommendation.aggressive
  ) {
    return null;
  }
  const candidate = recommendation.candidates.find((entry) => entry.move === move.coordinate);
  return candidate === undefined ? null : { recommendation, candidate };
}

function sideToMove(fen) {
  const side = fen.split(/\s+/u)[1];
  if (side === "w") {
    return "white";
  }
  if (side === "b") {
    return "black";
  }
  throw new Error(`invalid FEN side to move: ${fen}`);
}

export async function analyzeGames(games, options) {
  const stockfishConfig = options.oracle ? resolvePlayStockfishBinary() : { ok: false, reason: "disabled" };
  const provider = stockfishConfig.ok ? createLocalStockfishBestMoveProvider(stockfishConfig) : null;
  try {
    const accepted = [];
    const quarantined = [];
    const analyzed = [];
    const oracleEvalCache = new Map();
    for (const game of games) {
      const understanding = validateGameUnderstanding(game);
      if (!understanding.accepted) {
        quarantined.push({
          id: game.id,
          selectedSide: game.selectedSide,
          plies: game.moves.length,
          confidence: understanding.confidence,
          rejectionReasons: understanding.errors
        });
        continue;
      }
      accepted.push({ id: game.id, confidence: understanding.confidence });
      const labels = [
        ...structuralLabels(game),
        ...(await oracleLabels(game, provider, options.depth, oracleEvalCache)),
        ...ownedEngineLabels(game, options)
      ];
      analyzed.push({
        id: game.id,
        selectedSide: game.selectedSide,
        playMode: game.playMode,
        aggressive: game.aggressive,
        result: game.result,
        termination: game.termination,
        resignedSide: game.resignedSide,
        resignedBy: game.resignedBy,
        plies: game.moves.length,
        userPlies: game.moves.filter((move) => move.role === "user").length,
        rivalPlies: game.moves.filter((move) => move.role === "rival").length,
        trainingReadiness: trainingReadinessForGame(game),
        moves: game.moves.map((move) => ({
          ply: move.ply,
          actor: move.actor,
          side: move.side,
          role: move.role,
          selectedSide: move.selectedSide,
          move: move.coordinate,
          san: move.san,
          fenBefore: move.fenBefore,
          fenAfter: move.fenAfter,
          buildSha: move.buildSha,
          evaluatorBackend: move.evaluatorBackend,
          engineDepth: move.engineDepth,
          aggressive: move.aggressive,
          recommendationBeforeMove: move.recommendationBeforeMove
        })),
        labels
      });
    }
    const oracleCoverage = summarizeOracleCoverage(analyzed);
    const learningSignals = buildLearningSignals(analyzed, options);
    return {
      schema: 1,
      source: "play-game-archive-analysis",
      understanding: {
        accepted,
        quarantined,
        acceptedGames: accepted.length,
        quarantinedGames: quarantined.length
      },
      oracle: stockfishConfig.ok
        ? {
            status: oracleCoverage.unavailablePlies > 0 ? "degraded" : "enabled",
            depth: options.depth,
            env: playStockfishBinaryEnv,
            coverage: oracleCoverage
          }
        : { status: "unavailable", reason: stockfishConfig.reason },
      ownedEngine: options.ownedEngine
        ? { status: "enabled", command: "chess-cli best-move", binary: "target/release/chess-cli" }
        : { status: "disabled" },
      trainingReadiness: summarizeTrainingReadiness(analyzed),
      games: analyzed,
      learningSignals,
      observedPatterns: buildObservedPatterns(analyzed),
      engineFeedback: buildEngineFeedback(learningSignals, options.minRepeat),
      totals: summarize(analyzed)
    };
  } finally {
    await provider?.dispose();
  }
}

function summarizeOracleCoverage(games) {
  const byGame = games.map((game) => {
    const unavailablePlies = game.labels.filter((entry) => entry.kind === "oracle-unavailable-at-ply").length;
    return {
      id: game.id,
      plies: game.plies,
      unavailablePlies
    };
  });
  return {
    plies: byGame.reduce((sum, game) => sum + game.plies, 0),
    unavailablePlies: byGame.reduce((sum, game) => sum + game.unavailablePlies, 0),
    games: byGame
  };
}

function buildLearningSignals(games, options) {
  const byPattern = new Map();
  for (const game of games) {
    for (const entry of game.labels) {
      const key = signalKey(game, entry);
      const current = byPattern.get(key) ?? {
        patternId: key,
        selectedSide: game.selectedSide,
        role: entry.role,
        side: entry.side,
        move: entry.move ?? null,
        positionKey: entry.positionKey ?? null,
        kinds: new Set(),
        occurrences: 0,
        games: new Set(),
        failCount: 0,
        watchCount: 0,
        deltaCpTotal: 0,
        deltaCpCount: 0,
        mateTransitionCount: 0,
        examples: []
      };
      current.occurrences += 1;
      current.games.add(game.id);
      current.kinds.add(entry.kind);
      if (entry.severity === "fail") {
        current.failCount += 1;
      }
      if (entry.severity === "watch") {
        current.watchCount += 1;
      }
      if (entry.detail?.deltaClass === "mate-transition") {
        current.mateTransitionCount += 1;
      } else if (typeof entry.detail?.deltaCp === "number") {
        current.deltaCpTotal += entry.detail.deltaCp;
        current.deltaCpCount += 1;
      }
      if (current.examples.length < 3) {
        current.examples.push({
          gameId: game.id,
          ply: entry.ply,
          kind: entry.kind,
          positionKey: entry.positionKey ?? null,
          detail: entry.detail
        });
      }
      byPattern.set(key, current);
    }
  }
  return [...byPattern.values()]
    .filter((signal) => signal.occurrences >= options.minRepeat || signal.failCount > 0)
    .map((signal) => ({
      patternId: signal.patternId,
      selectedSide: signal.selectedSide,
      role: signal.role,
      side: signal.side,
      move: signal.move,
      positionKey: signal.positionKey,
      kinds: [...signal.kinds].sort(),
      occurrences: signal.occurrences,
      gameCount: signal.games.size,
      failCount: signal.failCount,
      watchCount: signal.watchCount,
      mateTransitionCount: signal.mateTransitionCount,
      averageDeltaCp:
        signal.deltaCpCount === 0 ? null : Math.round(signal.deltaCpTotal / signal.deltaCpCount),
      examples: signal.examples
    }))
    .sort((left, right) => right.failCount - left.failCount || right.occurrences - left.occurrences);
}

function buildObservedPatterns(games) {
  const byPattern = new Map();
  for (const game of games) {
    for (const entry of game.labels) {
      const role = typeof entry.role === "string" ? entry.role : "unknown";
      const side = typeof entry.side === "string" ? entry.side : "unknown";
      const kind = typeof entry.kind === "string" ? entry.kind : "unknown";
      const patternId = `${game.selectedSide}:${role}:${side}:${kind}`;
      const current = byPattern.get(patternId) ?? {
        patternId,
        selectedSide: game.selectedSide,
        role,
        side,
        kind,
        occurrences: 0,
        games: new Set(),
        failCount: 0,
        watchCount: 0,
        deltaCpTotal: 0,
        deltaCpCount: 0,
        mateTransitionCount: 0,
        qualityBands: new Map(),
        examples: []
      };
      current.occurrences += 1;
      current.games.add(game.id);
      if (entry.severity === "fail") {
        current.failCount += 1;
      }
      if (entry.severity === "watch") {
        current.watchCount += 1;
      }
      if (entry.detail?.deltaClass === "mate-transition") {
        current.mateTransitionCount += 1;
      } else if (typeof entry.detail?.deltaCp === "number") {
        current.deltaCpTotal += entry.detail.deltaCp;
        current.deltaCpCount += 1;
      }
      if (typeof entry.detail?.qualityBand === "string") {
        current.qualityBands.set(
          entry.detail.qualityBand,
          (current.qualityBands.get(entry.detail.qualityBand) ?? 0) + 1
        );
      }
      if (current.examples.length < 3) {
        current.examples.push({
          gameId: game.id,
          ply: entry.ply,
          move: entry.move ?? null,
          positionKey: entry.positionKey ?? null,
          detail: entry.detail ?? null
        });
      }
      byPattern.set(patternId, current);
    }
  }
  return [...byPattern.values()]
    .map((pattern) => ({
      patternId: pattern.patternId,
      selectedSide: pattern.selectedSide,
      role: pattern.role,
      side: pattern.side,
      kind: pattern.kind,
      occurrences: pattern.occurrences,
      gameCount: pattern.games.size,
      failCount: pattern.failCount,
      watchCount: pattern.watchCount,
      mateTransitionCount: pattern.mateTransitionCount,
      qualityBands: Object.fromEntries([...pattern.qualityBands.entries()].sort(([left], [right]) => left.localeCompare(right))),
      averageDeltaCp:
        pattern.deltaCpCount === 0 ? null : Math.round(pattern.deltaCpTotal / pattern.deltaCpCount),
      examples: pattern.examples
    }))
    .sort((left, right) =>
      right.failCount - left.failCount ||
      right.occurrences - left.occurrences ||
      left.patternId.localeCompare(right.patternId)
    );
}

function signalKey(game, entry) {
  const move = typeof entry.move === "string" ? entry.move : "none";
  const role = typeof entry.role === "string" ? entry.role : "unknown";
  const side = typeof entry.side === "string" ? entry.side : "unknown";
  const positionKey = typeof entry.positionKey === "string" ? entry.positionKey : "no-position";
  return `${game.selectedSide}:${role}:${side}:${positionKey}:${move}`;
}

function buildEngineFeedback(signals, minRepeat) {
  return signals.map((signal) => {
    const hasOracleFailure = signal.failCount > 0;
    const repeatedWatch = signal.role === "user" && signal.occurrences >= minRepeat;
    const advice = hasOracleFailure
      ? "do-not-prefer-without-new-tactical-proof"
      : repeatedWatch
        ? "review-before-repeating"
        : "observe";
    return {
      patternId: signal.patternId,
      advice,
      severity: hasOracleFailure ? "fail" : repeatedWatch ? "watch" : "info",
      message: feedbackMessage(signal, advice),
      evidence: {
        occurrences: signal.occurrences,
        gameCount: signal.gameCount,
        failCount: signal.failCount,
        watchCount: signal.watchCount,
        averageDeltaCp: signal.averageDeltaCp,
        kinds: signal.kinds
      }
    };
  });
}

function feedbackMessage(signal, advice) {
  const move = signal.move === null ? "this pattern" : signal.move;
  if (advice === "do-not-prefer-without-new-tactical-proof") {
    return `${move} has repeated negative oracle evidence; do not prefer it again unless fresh search proves the tactic.`;
  }
  if (advice === "review-before-repeating") {
    return `${move} is a repeated watch pattern; require stewardship or oracle review before making it a preferred strategy.`;
  }
  return `${move} is observed but not yet actionable.`;
}

function summarize(games) {
  const labels = games.flatMap((game) => game.labels);
  return {
    games: games.length,
    plies: games.reduce((sum, game) => sum + game.plies, 0),
    labels: labels.length,
    failLabels: labels.filter((entry) => entry.severity === "fail").length,
    watchLabels: labels.filter((entry) => entry.severity === "watch").length
  };
}

function summarizeTrainingReadiness(games) {
  const moves = games.reduce((sum, game) => sum + (game.trainingReadiness?.moves ?? 0), 0);
  const withBuildSha = games.reduce((sum, game) => sum + (game.trainingReadiness?.movesWithBuildSha ?? 0), 0);
  const withRecommendationSnapshot = games.reduce(
    (sum, game) => sum + (game.trainingReadiness?.movesWithRecommendationSnapshot ?? 0),
    0
  );
  return {
    status: moves > 0 && withBuildSha === moves && withRecommendationSnapshot > 0
      ? "evidence-ready"
      : "consultive-only",
    moves,
    movesWithBuildSha: withBuildSha,
    movesWithRecommendationSnapshot: withRecommendationSnapshot,
    note:
      "evidence-ready means archive attribution and at least one per-ply recommendation snapshot are present; it is not an automatic training approval."
  };
}

function trainingReadinessForGame(game) {
  const withBuildSha = game.moves.filter((move) => typeof move.buildSha === "string" && move.buildSha !== "").length;
  const withRecommendationSnapshot = game.moves.filter((move) => move.recommendationBeforeMove !== null).length;
  return {
    moves: game.moves.length,
    movesWithBuildSha: withBuildSha,
    movesWithRecommendationSnapshot: withRecommendationSnapshot
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const games = loadArchiveGames(args.input);
    const report = await analyzeGames(games, args);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output === null) {
      process.stdout.write(json);
    } else {
      writeFileSync(args.output, json);
      console.log(`play-game-archive-analysis=${args.output}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  }
}
