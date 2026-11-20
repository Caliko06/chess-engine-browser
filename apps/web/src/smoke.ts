import type { AnalysisDto, BestMoveDto, MoveResultDto } from "./engine-dtos.js";
import { createInitialShell, startFen } from "./shell.js";

export const phaseZeroMarker = "phase-0-scaffold";
export const m12BoundaryMarker = "m12-wasm-dto-boundary";

const shell = createInitialShell();

const bestMove: BestMoveDto = {
  bestMove: "a2a3",
  depth: 1,
  scoreCp: 0,
  nodes: 20,
  ttHits: 0
};

const moveResult: MoveResultDto = {
  appliedMove: "e2e4",
  san: "e4",
  state: {
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    status: "ongoing",
    sideToMove: "black",
    legalMoves: []
  }
};

const analysis: AnalysisDto = {
  state: shell.state,
  bestMove: bestMove.bestMove,
  depth: bestMove.depth,
  scoreCp: bestMove.scoreCp,
  nodes: bestMove.nodes,
  ttHits: bestMove.ttHits
};

export const m12Smoke = {
  startFen,
  commandCount: shell.commands.length,
  appliedMove: moveResult.appliedMove,
  analysisDepth: analysis.depth
} as const;
