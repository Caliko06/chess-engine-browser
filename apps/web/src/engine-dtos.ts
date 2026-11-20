export type ColorDto = "white" | "black";

export type GameStatusDto = "ongoing" | "checkmate" | "stalemate" | "draw";

export type DrawReasonDto = "fifty-move" | "insufficient-material" | "threefold-repetition";

export type EngineStateDto = {
  readonly fen: string;
  readonly status: GameStatusDto;
  readonly drawReason?: DrawReasonDto | null;
  readonly sideToMove: ColorDto;
  readonly legalMoves: readonly string[];
};

export type MakeMoveRequestDto = {
  readonly fen: string;
  readonly mv: string;
};

export type MoveResultDto = {
  readonly appliedMove: string;
  readonly san: string;
  readonly state: EngineStateDto;
};

export type BestMoveRequestDto = {
  readonly fen: string;
  readonly depth: number;
};

export type BestMoveDto = {
  readonly bestMove: string | null;
  readonly depth: number;
  readonly scoreCp: number;
  readonly nodes: number;
  readonly ttHits: number;
  readonly principalLine?: readonly string[];
  readonly followedPlan?: boolean;
  readonly plan?: PlayAggressivePlanDto;
};

export type PlayAggressivePlanDto = {
  readonly version: 1;
  readonly side: ColorDto;
  readonly status: "followed" | "proposed" | "ignored" | "unavailable";
  readonly reason:
    | "matched-history-and-gate"
    | "new-line"
    | "no-previous-line"
    | "illegal-continuation"
    | "failed-objective-gate"
    | "no-projected-line"
    | "not-aggressive";
  readonly line: readonly string[];
  readonly expectedReply: string | null;
  readonly continuation: string | null;
  readonly degraded: boolean;
  readonly threatModel?: PlayAggressiveThreatModelDto;
};

export type PlayAggressiveThreatModelDto = {
  readonly version: 1;
  readonly side: ColorDto;
  readonly ownThreat: PlayAggressiveThreatSignalDto;
  readonly opponentDanger: PlayAggressiveThreatSignalDto;
  readonly followUp: PlayAggressiveThreatSignalDto;
  readonly risk: "bounded" | "caution" | "critical";
};

export type PlayAggressiveThreatSignalDto = {
  readonly kind: "mate" | "check" | "capture" | "king-pressure" | "quiet" | "none";
  readonly move: string | null;
  readonly mateIn: number | null;
};

export type AnalyzeRequestDto = {
  readonly fen: string;
  readonly depth: number;
};

export type AnalysisDto = {
  readonly state: EngineStateDto;
  readonly bestMove: string | null;
  readonly depth: number;
  readonly scoreCp: number;
  readonly nodes: number;
  readonly ttHits: number;
};

export type ReactionMapRequestDto = {
  readonly fen: string;
  readonly depth: number;
};

/// Arrow move-quality label, mirroring the categories players see in analysis: the centipawn-loss
/// bands plus the conditional "great"/"brilliant" tags. Measured against the best candidate.
export type MoveQualityDto =
  | "brilliant"
  | "great"
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder";

export type ReactionCandidateDto = {
  readonly move: string;
  readonly scoreCp: number;
  /// Static exchange (SEE) verdict from the engine: the move leaves its piece hanging on the
  /// destination square. Depth-independent, so it flags a blunder even when it is the top-scored
  /// candidate (which the relative-score colouring cannot).
  readonly hangs: boolean;
  /// Forced-mate distance in full moves when the move mates for the side playing it (1 = mate now,
  /// 2 = mate next move), else null. Drives the distinct "mating" arrow colour.
  readonly mateIn: number | null;
  /// Move-quality label for the arrow (see [[MoveQualityDto]]).
  readonly quality?: MoveQualityDto;
};

export type ReactionMapDto = {
  readonly state: EngineStateDto;
  readonly rootCandidates: readonly ReactionCandidateDto[];
  readonly principalLine: readonly string[];
  readonly projectedLine: readonly string[];
  readonly mateDetected: boolean;
  readonly depth: number;
  readonly nodes: number;
};

export type ForcingMapRequestDto = {
  readonly fen: string;
  readonly depth: number;
  readonly host: ColorDto;
};

export type ForcingKindDto = "mate" | "check" | "capture" | "defense";

export type ForcingCandidateDto = {
  readonly move: string;
  readonly kind: ForcingKindDto;
  readonly scoreCp: number;
  readonly sound: boolean;
  readonly mateIn: number | null;
};

export type ForcingMapDto = {
  readonly state: EngineStateDto;
  readonly host: ColorDto;
  readonly onTurn: boolean;
  readonly candidates: readonly ForcingCandidateDto[];
  readonly depth: number;
  readonly nodes: number;
};

export type MoveLabelDto = "best" | "good" | "inaccuracy" | "mistake" | "blunder";

export type ReviewPgnRequestDto = {
  readonly pgn: string;
  readonly depth: number;
};

export type ReviewSummaryDto = {
  readonly totalMoves: number;
  readonly best: number;
  readonly good: number;
  readonly inaccuracies: number;
  readonly mistakes: number;
  readonly blunders: number;
};

export type ReviewEntryDto = {
  readonly ply: number;
  readonly playedMove: string;
  readonly san: string;
  readonly bestMove: string | null;
  readonly bestScoreCp: number;
  readonly playedScoreCp: number;
  readonly cpLoss: number;
  readonly label: MoveLabelDto;
};

export type GameReviewDto = {
  readonly summary: ReviewSummaryDto;
  readonly entries: readonly ReviewEntryDto[];
};

export type KeyMomentKindDto = "centipawn-loss";

export type EvidenceKindDto = "local-search-swing";

export type PieceKindDto = "king" | "queen" | "rook" | "bishop" | "knight" | "pawn";

export type PieceDto = {
  readonly color: ColorDto;
  readonly kind: PieceKindDto;
};

export type ForkCandidateSourceKindDto = "best-move-after-position";

export type KeyMomentDto = {
  readonly rank: number;
  readonly entryIndex: number;
  readonly kind: KeyMomentKindDto;
  readonly ply: number;
  readonly playedMove: string;
  readonly san: string;
  readonly bestMove: string | null;
  readonly bestScoreCp: number;
  readonly playedScoreCp: number;
  readonly cpLoss: number;
  readonly label: MoveLabelDto;
};

export type MoveEvidenceDto = {
  readonly rank: number;
  readonly entryIndex: number;
  readonly ply: number;
  readonly kind: EvidenceKindDto;
  readonly playedMove: string;
  readonly san: string;
  readonly bestMove: string | null;
  readonly bestScoreCp: number;
  readonly playedScoreCp: number;
  readonly cpLoss: number;
  readonly label: MoveLabelDto;
};

export type EarlyMoveDivergenceDto = {
  readonly entryIndex: number;
  readonly ply: number;
  readonly playedMove: string;
  readonly san: string;
  readonly localBestMove: string;
  readonly bestScoreCp: number;
  readonly playedScoreCp: number;
  readonly cpLoss: number;
  readonly label: MoveLabelDto;
};

export type ForkTargetDto = {
  readonly square: string;
  readonly piece: PieceDto;
};

export type ForkCandidateDto = {
  readonly rank: number;
  readonly entryIndex: number;
  readonly ply: number;
  readonly sourceKind: ForkCandidateSourceKindDto;
  readonly bestMove: string;
  readonly movedPiece: PieceDto;
  readonly destination: string;
  readonly targets: readonly ForkTargetDto[];
  readonly cpLoss: number;
  readonly label: MoveLabelDto;
};

export type RetryPositionDto = {
  readonly rank: number;
  readonly entryIndex: number;
  readonly ply: number;
  readonly fenBefore: string;
  readonly playedMove: string;
  readonly bestMove: string | null;
  readonly san: string;
  readonly label: MoveLabelDto;
  readonly cpLoss: number;
};

export type ReviewArtifactsDto = {
  readonly keyMoments: readonly KeyMomentDto[];
  readonly evidence: readonly MoveEvidenceDto[];
  readonly forkCandidates: readonly ForkCandidateDto[];
  readonly earlyMoveDivergences: readonly EarlyMoveDivergenceDto[];
  readonly retryPositions: readonly RetryPositionDto[];
};

export type ReviewPgnWithArtifactsDto = {
  readonly review: GameReviewDto;
  readonly artifacts: ReviewArtifactsDto;
};

export type SideExploreRequestDto = {
  readonly fen: string;
  readonly side: ColorDto;
};

/// Aftermath of a sound sacrifice: how the opponent's best reply treats the offered material.
/// `accepted` = the opponent recaptures yet the line still holds; `defended` = the opponent declines.
/// `null` for non-sacrifice candidates (ADR-0154 Packet C).
export type SideExploreAftermath = "accepted" | "defended";

export type OpeningProvenanceDto = {
  readonly eco: string;
  readonly name: string;
};

export type OpeningStatusDto = {
  readonly status: "available" | "unavailable";
  readonly eco: string | null;
  readonly name: string | null;
  readonly move: string | null;
};

export type SideExploreCandidateDto = {
  readonly move: string;
  readonly kind: ForcingKindDto;
  /// Full-window exact score in centipawns signed from `side` (positive = good for `side`).
  readonly exactScoreCp: number;
  readonly quality?: MoveQualityDto;
  readonly sound: boolean;
  readonly sacrifice: boolean;
  readonly mateIn: number | null;
  readonly aftermath: SideExploreAftermath | null;
  /// Coordinate of the aggressor's follow-up move that justifies an accepted sacrifice, or `null`.
  readonly continuation: string | null;
  readonly prospectiveBrilliant: boolean;
  readonly opening?: OpeningProvenanceDto | null;
};

export type SideExploreReplyDto = {
  readonly move: string;
  readonly role?: "objective-primary" | "alternative";
  readonly kind: ForcingKindDto;
  readonly quality: MoveQualityDto;
  readonly sound: boolean;
  readonly sacrifice: boolean;
  readonly mateIn: number | null;
};

export type SideExplorePlanStatusDto = "none" | "followed" | "replaced";
export type SideExplorePlanReasonDto =
  | "no-previous-line"
  | "matched-history-and-gate"
  | "illegal-continuation"
  | "live-board-recomputed";

export type ExplanationPieceDto = "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";

export type SideExploreExplanationSquareDto = {
  readonly square: string;
  readonly piece: ExplanationPieceDto;
};

/// Board facts about the first candidate, used to write the plain-language recommendation.
/// On-turn only. "En prise" = the enemy wins material by capturing the piece (static exchange > 0).
export type SideExploreExplanationDto = {
  /// The side to move is in check now.
  readonly inCheck: boolean;
  /// The side's own pieces currently en prise (max 3, most valuable first, never the king).
  readonly threatened: readonly SideExploreExplanationSquareDto[];
  readonly best: {
    readonly move: string;
    readonly piece: ExplanationPieceDto;
    readonly captured: ExplanationPieceDto | null;
    readonly promotion: ExplanationPieceDto | null;
    readonly castle: "king" | "queen" | null;
    readonly check: boolean;
    /// Checkmate on the board after the move (not mate-in-N).
    readonly mate: boolean;
    /// Opponent pieces newly en prise after the move (max 2, most valuable first).
    readonly threats: readonly SideExploreExplanationSquareDto[];
    readonly savesThreatened: boolean;
    /// The moved piece itself is en prise after the move.
    readonly hangs: boolean;
  };
  /// Side minus opponent material at the end of the principal line minus the same at the start.
  readonly lineMaterialCp: number;
};

export type SideExploreDto = {
  readonly state: EngineStateDto;
  readonly side: ColorDto;
  readonly onTurn: boolean;
  /// Off-turn only: the opponent's bounded neutral legal variants. A reply with role
  /// `objective-primary` is the exact rival defence used for projection; alternatives never govern
  /// the selected-side plan. The role is optional only for legacy test doubles.
  /// Empty on-turn.
  readonly replyCandidates: readonly SideExploreReplyDto[];
  readonly candidates: readonly SideExploreCandidateDto[];
  readonly openingStatus?: OpeningStatusDto;
  readonly principalLine: readonly string[];
  readonly mateDetected: boolean;
  readonly depth: number;
  readonly nodes: number;
  readonly soundMarginCp: number;
  readonly explanation?: SideExploreExplanationDto;
  readonly planStatus?: SideExplorePlanStatusDto;
  readonly planReason?: SideExplorePlanReasonDto;
};

export type WasmBridgeError =
  | "invalid-fen"
  | "invalid-pgn"
  | "invalid-move"
  | "invalid-depth"
  | "invalid-position"
  | "search-failed";

/**
 * Everything a play engine call can fail with. The first group is the Rust bridge contract
 * (`WasmBridgeError`, also used by the review flow). The other two never come from Rust:
 * `cancelled` is a search the UI abandoned on purpose (new move, new game, view change) and is
 * not a fault; `invalid-response` means the bridge answered with a payload that failed validation.
 */
export type PlayEngineError = WasmBridgeError | "cancelled" | "invalid-response";
