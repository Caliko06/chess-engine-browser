import type {
  GameReviewDto,
  MoveLabelDto,
  ReviewArtifactsDto,
  ReviewEntryDto,
  ReviewPgnRequestDto,
  ReviewSummaryDto,
  WasmBridgeError
} from "./engine-dtos";
import { createInitialShell, type ShellCommandId } from "./shell";

export const reviewRequestTypeCheck: ReviewPgnRequestDto = {
  pgn: "1. a3 *",
  depth: 3
};

export const labelTypeCheck: MoveLabelDto = "best";

export const summaryTypeCheck: ReviewSummaryDto = {
  totalMoves: 1,
  best: 1,
  good: 0,
  inaccuracies: 0,
  mistakes: 0,
  blunders: 0
};

export const entryTypeCheck: ReviewEntryDto = {
  ply: 1,
  playedMove: "a2a3",
  san: "a3",
  bestMove: null,
  bestScoreCp: 0,
  playedScoreCp: 0,
  cpLoss: 0,
  label: labelTypeCheck
};

export const reviewTypeCheck: GameReviewDto = {
  summary: summaryTypeCheck,
  entries: [entryTypeCheck]
};

export const artifactsTypeCheck: ReviewArtifactsDto = {
  keyMoments: [],
  evidence: [],
  forkCandidates: [
    {
      rank: 1,
      entryIndex: 0,
      ply: 1,
      sourceKind: "best-move-after-position",
      bestMove: "e5f7",
      movedPiece: { color: "white", kind: "knight" },
      destination: "f7",
      targets: [
        { square: "d8", piece: { color: "black", kind: "queen" } },
        { square: "h8", piece: { color: "black", kind: "rook" } }
      ],
      cpLoss: 450,
      label: "blunder"
    }
  ],
  earlyMoveDivergences: [],
  retryPositions: []
};

export const invalidPgnErrorTypeCheck: WasmBridgeError = "invalid-pgn";

export const shellReviewCommandTypeCheck: ShellCommandId = "review-pgn";

export const shellIncludesReviewCommand = createInitialShell().commands.includes("review-pgn");
