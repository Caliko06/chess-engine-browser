import type {
  ColorDto,
  GameReviewDto,
  MoveLabelDto,
  PieceKindDto,
  ReviewArtifactsDto,
  ReviewEntryDto,
  ReviewSummaryDto
} from "./engine-dtos.js";

type RecordValue = Record<string, unknown>;

const maxEntriesPerReview = 512;

export function validateGameReviewDto(value: unknown): GameReviewDto | null {
  if (!isRecord(value) || !exactKeys(value, ["summary", "entries"])) {
    return null;
  }
  const summary = validateSummary(value.summary);
  if (summary === null || !Array.isArray(value.entries)) {
    return null;
  }
  if (value.entries.length > maxEntriesPerReview) {
    return null;
  }

  const entries: ReviewEntryDto[] = [];
  for (const entry of value.entries) {
    const validated = validateEntry(entry);
    if (validated === null) {
      return null;
    }
    entries.push(validated);
  }
  return { summary, entries };
}

export function validateCurrentReviewArtifactsDto(value: unknown): ReviewArtifactsDto | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "keyMoments",
      "evidence",
      "forkCandidates",
      "earlyMoveDivergences",
      "retryPositions"
    ]) ||
    !Array.isArray(value.keyMoments) ||
    !Array.isArray(value.evidence) ||
    !Array.isArray(value.forkCandidates) ||
    !Array.isArray(value.earlyMoveDivergences) ||
    !Array.isArray(value.retryPositions) ||
    value.keyMoments.length > maxEntriesPerReview ||
    value.evidence.length > maxEntriesPerReview ||
    value.forkCandidates.length > maxEntriesPerReview ||
    value.earlyMoveDivergences.length > maxEntriesPerReview ||
    value.retryPositions.length > maxEntriesPerReview
  ) {
    return null;
  }

  const keyMoments = validateArray(value.keyMoments, validateKeyMoment);
  const evidence = validateArray(value.evidence, validateMoveEvidence);
  const forkCandidates = validateArray(value.forkCandidates, validateForkCandidate);
  const earlyMoveDivergences = validateArray(
    value.earlyMoveDivergences,
    validateEarlyMoveDivergence
  );
  const retryPositions = validateArray(value.retryPositions, validateRetryPosition);
  return keyMoments === null ||
    evidence === null ||
    forkCandidates === null ||
    earlyMoveDivergences === null ||
    retryPositions === null
    ? null
    : { keyMoments, evidence, forkCandidates, earlyMoveDivergences, retryPositions };
}

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
}

function validateArray<T>(values: readonly unknown[], validate: (value: unknown) => T | null): T[] | null {
  const result: T[] = [];
  for (const value of values) {
    const validated = validate(value);
    if (validated === null) {
      return null;
    }
    result.push(validated);
  }
  return result;
}

function validateSummary(value: unknown): ReviewSummaryDto | null {
  const keys = ["totalMoves", "best", "good", "inaccuracies", "mistakes", "blunders"] as const;
  if (!isRecord(value) || !exactKeys(value, keys)) {
    return null;
  }
  const totalMoves = countField(value, "totalMoves");
  const best = countField(value, "best");
  const good = countField(value, "good");
  const inaccuracies = countField(value, "inaccuracies");
  const mistakes = countField(value, "mistakes");
  const blunders = countField(value, "blunders");
  if (
    totalMoves === null ||
    best === null ||
    good === null ||
    inaccuracies === null ||
    mistakes === null ||
    blunders === null
  ) {
    return null;
  }
  return { totalMoves, best, good, inaccuracies, mistakes, blunders };
}

function validateEntry(value: unknown): ReviewEntryDto | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "ply",
      "playedMove",
      "san",
      "bestMove",
      "bestScoreCp",
      "playedScoreCp",
      "cpLoss",
      "label"
    ])
  ) {
    return null;
  }
  if (
    !isCount(value.ply) ||
    typeof value.playedMove !== "string" ||
    typeof value.san !== "string" ||
    !(typeof value.bestMove === "string" || value.bestMove === null) ||
    !isInteger(value.bestScoreCp) ||
    !isInteger(value.playedScoreCp) ||
    !isCount(value.cpLoss) ||
    !isMoveLabel(value.label)
  ) {
    return null;
  }
  return {
    ply: value.ply,
    playedMove: value.playedMove,
    san: value.san,
    bestMove: value.bestMove,
    bestScoreCp: value.bestScoreCp,
    playedScoreCp: value.playedScoreCp,
    cpLoss: value.cpLoss,
    label: value.label
  };
}

function validateKeyMoment(value: unknown): ReviewArtifactsDto["keyMoments"][number] | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "rank",
      "entryIndex",
      "kind",
      "ply",
      "playedMove",
      "san",
      "bestMove",
      "bestScoreCp",
      "playedScoreCp",
      "cpLoss",
      "label"
    ]) ||
    !isPositiveCount(value.rank) ||
    !isCount(value.entryIndex) ||
    value.kind !== "centipawn-loss" ||
    !isCount(value.ply) ||
    typeof value.playedMove !== "string" ||
    typeof value.san !== "string" ||
    !(typeof value.bestMove === "string" || value.bestMove === null) ||
    !isInteger(value.bestScoreCp) ||
    !isInteger(value.playedScoreCp) ||
    !isCount(value.cpLoss) ||
    !isMoveLabel(value.label)
  ) {
    return null;
  }
  return {
    rank: value.rank,
    entryIndex: value.entryIndex,
    kind: value.kind,
    ply: value.ply,
    playedMove: value.playedMove,
    san: value.san,
    bestMove: value.bestMove,
    bestScoreCp: value.bestScoreCp,
    playedScoreCp: value.playedScoreCp,
    cpLoss: value.cpLoss,
    label: value.label
  };
}

function validateMoveEvidence(value: unknown): ReviewArtifactsDto["evidence"][number] | null {
  const validated = validateKeyMomentLike(value, "local-search-swing");
  return validated === null
    ? null
    : {
        rank: validated.rank,
        entryIndex: validated.entryIndex,
        ply: validated.ply,
        kind: "local-search-swing",
        playedMove: validated.playedMove,
        san: validated.san,
        bestMove: validated.bestMove,
        bestScoreCp: validated.bestScoreCp,
        playedScoreCp: validated.playedScoreCp,
        cpLoss: validated.cpLoss,
        label: validated.label
      };
}

function validateKeyMomentLike(
  value: unknown,
  kind: "local-search-swing"
): Omit<ReviewArtifactsDto["evidence"][number], "kind"> | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "rank",
      "entryIndex",
      "ply",
      "kind",
      "playedMove",
      "san",
      "bestMove",
      "bestScoreCp",
      "playedScoreCp",
      "cpLoss",
      "label"
    ]) ||
    !isPositiveCount(value.rank) ||
    !isCount(value.entryIndex) ||
    !isCount(value.ply) ||
    value.kind !== kind ||
    typeof value.playedMove !== "string" ||
    typeof value.san !== "string" ||
    !(typeof value.bestMove === "string" || value.bestMove === null) ||
    !isInteger(value.bestScoreCp) ||
    !isInteger(value.playedScoreCp) ||
    !isCount(value.cpLoss) ||
    !isMoveLabel(value.label)
  ) {
    return null;
  }
  return {
    rank: value.rank,
    entryIndex: value.entryIndex,
    ply: value.ply,
    playedMove: value.playedMove,
    san: value.san,
    bestMove: value.bestMove,
    bestScoreCp: value.bestScoreCp,
    playedScoreCp: value.playedScoreCp,
    cpLoss: value.cpLoss,
    label: value.label
  };
}

function validateEarlyMoveDivergence(
  value: unknown
): ReviewArtifactsDto["earlyMoveDivergences"][number] | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "entryIndex",
      "ply",
      "playedMove",
      "san",
      "localBestMove",
      "bestScoreCp",
      "playedScoreCp",
      "cpLoss",
      "label"
    ]) ||
    !isCount(value.entryIndex) ||
    !isCount(value.ply) ||
    typeof value.playedMove !== "string" ||
    typeof value.san !== "string" ||
    typeof value.localBestMove !== "string" ||
    !isInteger(value.bestScoreCp) ||
    !isInteger(value.playedScoreCp) ||
    !isCount(value.cpLoss) ||
    !isMoveLabel(value.label)
  ) {
    return null;
  }
  return {
    entryIndex: value.entryIndex,
    ply: value.ply,
    playedMove: value.playedMove,
    san: value.san,
    localBestMove: value.localBestMove,
    bestScoreCp: value.bestScoreCp,
    playedScoreCp: value.playedScoreCp,
    cpLoss: value.cpLoss,
    label: value.label
  };
}

function validateForkCandidate(value: unknown): ReviewArtifactsDto["forkCandidates"][number] | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "rank",
      "entryIndex",
      "ply",
      "sourceKind",
      "bestMove",
      "movedPiece",
      "destination",
      "targets",
      "cpLoss",
      "label"
    ]) ||
    !isPositiveCount(value.rank) ||
    !isCount(value.entryIndex) ||
    !isCount(value.ply) ||
    value.sourceKind !== "best-move-after-position" ||
    typeof value.bestMove !== "string" ||
    typeof value.destination !== "string" ||
    !Array.isArray(value.targets) ||
    value.targets.length < 2 ||
    value.targets.length > maxEntriesPerReview ||
    !isCount(value.cpLoss) ||
    !isMoveLabel(value.label)
  ) {
    return null;
  }

  const movedPiece = validatePiece(value.movedPiece);
  const targets = validateArray(value.targets, validateForkTarget);
  return movedPiece === null || targets === null
    ? null
    : {
        rank: value.rank,
        entryIndex: value.entryIndex,
        ply: value.ply,
        sourceKind: "best-move-after-position",
        bestMove: value.bestMove,
        movedPiece,
        destination: value.destination,
        targets,
        cpLoss: value.cpLoss,
        label: value.label
      };
}

function validateForkTarget(
  value: unknown
): ReviewArtifactsDto["forkCandidates"][number]["targets"][number] | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["square", "piece"]) ||
    typeof value.square !== "string"
  ) {
    return null;
  }

  const piece = validatePiece(value.piece);
  return piece === null ? null : { square: value.square, piece };
}

function validatePiece(
  value: unknown
): ReviewArtifactsDto["forkCandidates"][number]["movedPiece"] | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["color", "kind"]) ||
    !isColor(value.color) ||
    !isPieceKind(value.kind)
  ) {
    return null;
  }
  return { color: value.color, kind: value.kind };
}

function validateRetryPosition(value: unknown): ReviewArtifactsDto["retryPositions"][number] | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "rank",
      "entryIndex",
      "ply",
      "fenBefore",
      "playedMove",
      "bestMove",
      "san",
      "label",
      "cpLoss"
    ]) ||
    !isPositiveCount(value.rank) ||
    !isCount(value.entryIndex) ||
    !isCount(value.ply) ||
    typeof value.fenBefore !== "string" ||
    typeof value.playedMove !== "string" ||
    !(typeof value.bestMove === "string" || value.bestMove === null) ||
    typeof value.san !== "string" ||
    !isMoveLabel(value.label) ||
    !isCount(value.cpLoss)
  ) {
    return null;
  }
  return {
    rank: value.rank,
    entryIndex: value.entryIndex,
    ply: value.ply,
    fenBefore: value.fenBefore,
    playedMove: value.playedMove,
    bestMove: value.bestMove,
    san: value.san,
    label: value.label,
    cpLoss: value.cpLoss
  };
}

function isMoveLabel(value: unknown): value is MoveLabelDto {
  return (
    value === "best" ||
    value === "good" ||
    value === "inaccuracy" ||
    value === "mistake" ||
    value === "blunder"
  );
}

function isColor(value: unknown): value is ColorDto {
  return value === "white" || value === "black";
}

function isPieceKind(value: unknown): value is PieceKindDto {
  return (
    value === "king" ||
    value === "queen" ||
    value === "rook" ||
    value === "bishop" ||
    value === "knight" ||
    value === "pawn"
  );
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isCount(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isPositiveCount(value: unknown): value is number {
  return isCount(value) && value > 0;
}

function countField(value: RecordValue, key: string): number | null {
  const field = value[key];
  return isCount(field) ? field : null;
}
