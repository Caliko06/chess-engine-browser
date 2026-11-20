use chess_board::{Color, LegalMoveError, Move, PgnGame, Position, PositionStatus, SanError};
use chess_coach::{
    CoachConfig, CoachError, EarlyMoveDivergence, EarlyMoveDivergenceConfig, EvidenceKind,
    ForkCandidateEvidence, ForkCandidateSourceKind, GameReview, KeyMoment, KeyMomentConfig,
    KeyMomentKind, MoveEvidence, MoveLabel, RetryConfig, RetryPosition, ReviewEntry, ReviewSummary,
    collect_fork_candidate_evidence, collect_key_moment_evidence, generate_retry_positions,
    review_pgn_game, select_early_move_divergences, select_key_moments,
};
use chess_eval::classify_win_percent_loss;
use chess_search::explore;
use chess_search::{
    EXPLORE_SOUND_MARGIN_CP, ForcingKind, ForcingReport, MoveQuality, ReactionLines,
    ReplyCandidate, ReplyCandidateRole, SacrificeAftermath, SearchConfig, SearchError,
    SearchLimits, SideExploreCandidate, SideExploreReport, forcing_moves, forcing_moves_deep,
    reaction_lines, reaction_lines_deep,
};
mod explanation;

use core::fmt;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::wasm_bindgen;

/// Total interior-node allowance the play search spends per move. The engine deepens iteratively
/// until this budget is exhausted, so the depth it reaches scales with the position instead of
/// being a fixed ply count. A node budget rather than a wall clock keeps the engine deterministic
/// and free of any foreign-function clock import the hardening policy forbids.
///
/// Reverted 400_000 -> 60_000 on 2026-07-01 after a timed depth/latency sweep (release build,
/// `chess-cli best-move --aggressive`) showed the 2026-06-30 increase was a mis-calibration:
///   60_000  -> depth 5, ~2.4 s native
///   100_000 -> depth 5, ~3.9 s native
///   250_000 -> depth 6, ~9.8 s native
///   400_000 -> depth 6, ~15-19 s native (~30-38 s WASM)
/// The 250_000 -> 400_000 step bought *no* extra depth, and 60_000 -> 400_000 bought a single ply
/// (5 -> 6) at ~6x the wall-clock. Aggressive best-move runs at only ~25k nps (a third of the
/// deep lens) because the per-node aggressive-plan machinery (threat model + reaction lines) is
/// heavy, so the real ceiling on play strength is that per-node cost and the eval quality, NOT the node count. Throwing nodes at it just adds latency. 60_000
/// keeps depth 5 in quiet middlegames at ~2.4 s native / ~5 s WASM.
const PLAY_NODE_BUDGET: u64 = 60_000;
const MAX_CONTEXT_HISTORY_FENS: usize = 1024;
const MAX_CONTEXT_LINE_MOVES: usize = chess_search::MAX_REACTION_LINE_PLIES as usize;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineStateDto {
    pub fen: String,
    pub status: GameStatusDto,
    pub draw_reason: Option<DrawReasonDto>,
    pub side_to_move: ColorDto,
    pub legal_moves: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MakeMoveRequestDto {
    pub fen: String,
    pub mv: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MakeMoveContextRequestDto {
    pub fen: String,
    pub mv: String,
    pub history_fens: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MoveResultDto {
    pub applied_move: String,
    pub san: String,
    pub state: EngineStateDto,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BestMoveRequestDto {
    pub fen: String,
    pub depth: u8,
    /// When true the play search runs with the aggressive personality, biased toward attacking the
    /// enemy king and keeping pieces on. The aggressor is implicit: the side to move in `fen`.
    pub aggressive: bool,
    pub node_budget: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BestMoveContextRequestDto {
    pub fen: String,
    pub depth: u8,
    pub aggressive: bool,
    pub node_budget: u32,
    /// Explicit side the owned Play engine is about to move for. In normal opponent Play this is
    /// the side opposite the selected player.
    pub side: ColorDto,
    /// Previous game positions before `fen`, serialized as newline-delimited FENs by the web layer.
    pub history_fens: String,
    /// Previous aggressive principal line, serialized as comma-delimited coordinate moves.
    pub previous_line: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BestMoveDto {
    pub best_move: Option<String>,
    pub depth: u8,
    pub score_cp: i32,
    pub nodes: u64,
    pub tt_hits: u64,
    pub principal_line: Option<Vec<String>>,
    pub followed_plan: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnalyzeRequestDto {
    pub fen: String,
    pub depth: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnalysisDto {
    pub state: EngineStateDto,
    pub best_move: Option<String>,
    pub depth: u8,
    pub score_cp: i32,
    pub nodes: u64,
    pub tt_hits: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReactionMapRequestDto {
    pub fen: String,
    pub depth: u8,
    /// When true, run the deep ("ultra-instinct") lens: iterative deepening under the play node
    /// budget instead of the fixed M8 depth.
    pub deep: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReactionCandidateDto {
    pub mv: String,
    pub score_cp: i32,
    /// Whether the move statically hangs its piece on the destination square (SEE-based). Drives the
    /// lens "hanging" arrow colour independently of the search score.
    pub hangs: bool,
    /// Forced-mate distance in full moves when the move mates for the side playing it, else `None`.
    /// Drives the distinct "mating" arrow colour for the imminent (one- or two-move) mates.
    pub mate_in: Option<u8>,
    /// Move-quality label for the arrow (best/excellent/good/inaccuracy/mistake/blunder, plus the
    /// conditional great/brilliant tags), measured against the best candidate.
    pub quality: MoveQualityDto,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReactionMapDto {
    pub state: EngineStateDto,
    pub root_candidates: Vec<ReactionCandidateDto>,
    pub principal_line: Vec<String>,
    pub mate_detected: bool,
    pub depth: u8,
    pub nodes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForcingMapRequestDto {
    pub fen: String,
    pub depth: u8,
    pub host: ColorDto,
    /// When true, run the deep ("ultra-instinct") lens: iterative deepening under the play node
    /// budget instead of the fixed M8 depth.
    pub deep: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ForcingKindDto {
    Mate,
    Check,
    Capture,
    Defense,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForcingCandidateDto {
    pub mv: String,
    pub kind: ForcingKindDto,
    pub score_cp: i32,
    pub sound: bool,
    pub mate_in: Option<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForcingMapDto {
    pub state: EngineStateDto,
    pub host: ColorDto,
    pub on_turn: bool,
    pub candidates: Vec<ForcingCandidateDto>,
    pub depth: u8,
    pub nodes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SideExploreRequestDto {
    pub fen: String,
    pub side: ColorDto,
    /// Mirrors the play engine's aggressive toggle. When true the on-turn lens runs the win-biased
    /// aggressive personality; when false it stays neutral, so the default Explore carries no bias.
    pub aggressive: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SideExploreContextRequestDto {
    pub fen: String,
    pub side: ColorDto,
    pub aggressive: bool,
    pub history_fens: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SideExploreContextV2RequestDto {
    pub fen: String,
    pub side: ColorDto,
    pub aggressive: bool,
    pub history_fens: String,
    pub node_budget: u32,
    pub previous_line: String,
}

/// A candidate from the side-oriented Explore lens with exact score, soundness, and sacrifice tags.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SideExploreCandidateDto {
    pub mv: String,
    pub kind: ForcingKindDto,
    /// Full-window exact score in centipawns, signed from `side` (positive = good for `side`).
    pub exact_score_cp: i32,
    pub quality: MoveQualityDto,
    /// True when `exact_score_cp` is within [`EXPLORE_SOUND_MARGIN_CP`] of the best candidate.
    pub sound: bool,
    /// True when the move is SEE-negative yet search-confirmed sound (verified sacrifice).
    pub sacrifice: bool,
    pub mate_in: Option<u8>,
    /// Aftermath of a sound sacrifice — `"accepted"` (opponent recaptures, the line still holds) or
    /// `"defended"` (opponent declines the offer). `None` for non-sacrifice candidates (ADR-0154 C).
    pub aftermath: Option<&'static str>,
    /// The aggressor's follow-up move (coordinate) that justifies an accepted sacrifice. `None` when
    /// this is not a sacrifice or no continuation was projected.
    pub continuation: Option<String>,
    pub prospective_brilliant: bool,
    pub opening: Option<OpeningProvenanceDto>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpeningProvenanceDto {
    pub eco: String,
    pub name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpeningStatusDto {
    pub status: &'static str,
    pub eco: Option<String>,
    pub name: Option<String>,
    pub mv: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SideExploreReplyDto {
    pub mv: String,
    pub role: &'static str,
    pub kind: ForcingKindDto,
    pub quality: MoveQualityDto,
    pub sound: bool,
    pub sacrifice: bool,
    pub mate_in: Option<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SideExploreDto {
    pub state: EngineStateDto,
    pub side: ColorDto,
    pub on_turn: bool,
    /// Off-turn only: the opponent's bounded neutral legal variants. Exactly one carries the
    /// `objective-primary` role when exact reply re-scoring completes; alternatives never govern
    /// the selected-side projection. Empty on-turn.
    pub reply_candidates: Vec<SideExploreReplyDto>,
    pub candidates: Vec<SideExploreCandidateDto>,
    pub opening_status: OpeningStatusDto,
    pub principal_line: Vec<String>,
    pub mate_detected: bool,
    pub depth: u8,
    pub nodes: u64,
    /// Centipawn threshold used to tag candidates as sound. Provided for UI display.
    pub sound_margin_cp: i32,
    /// Board facts for the plain-language sentence about the first candidate. On-turn only.
    pub explanation: Option<explanation::SideExplanationDto>,
    pub plan_status: Option<&'static str>,
    pub plan_reason: Option<&'static str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewPgnRequestDto {
    pub pgn: String,
    pub depth: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewSummaryDto {
    pub total_moves: usize,
    pub best: usize,
    pub good: usize,
    pub inaccuracies: usize,
    pub mistakes: usize,
    pub blunders: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewEntryDto {
    pub ply: usize,
    pub played_move: String,
    pub san: String,
    pub best_move: Option<String>,
    pub best_score_cp: i32,
    pub played_score_cp: i32,
    pub cp_loss: u32,
    pub label: MoveLabelDto,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GameReviewDto {
    pub summary: ReviewSummaryDto,
    pub entries: Vec<ReviewEntryDto>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewPgnWithArtifactsDto {
    pub review: GameReviewDto,
    pub artifacts: ReviewArtifactsDto,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewArtifactsDto {
    pub key_moments: Vec<KeyMomentDto>,
    pub evidence: Vec<MoveEvidenceDto>,
    pub fork_candidates: Vec<ForkCandidateDto>,
    pub early_move_divergences: Vec<EarlyMoveDivergenceDto>,
    pub retry_positions: Vec<RetryPositionDto>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeyMomentDto {
    pub rank: usize,
    pub entry_index: usize,
    pub kind: String,
    pub ply: usize,
    pub played_move: String,
    pub san: String,
    pub best_move: Option<String>,
    pub best_score_cp: i32,
    pub played_score_cp: i32,
    pub cp_loss: u32,
    pub label: MoveLabelDto,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MoveEvidenceDto {
    pub rank: usize,
    pub entry_index: usize,
    pub ply: usize,
    pub kind: String,
    pub played_move: String,
    pub san: String,
    pub best_move: Option<String>,
    pub best_score_cp: i32,
    pub played_score_cp: i32,
    pub cp_loss: u32,
    pub label: MoveLabelDto,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EarlyMoveDivergenceDto {
    pub entry_index: usize,
    pub ply: usize,
    pub played_move: String,
    pub san: String,
    pub local_best_move: String,
    pub best_score_cp: i32,
    pub played_score_cp: i32,
    pub cp_loss: u32,
    pub label: MoveLabelDto,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForkCandidateDto {
    pub rank: usize,
    pub entry_index: usize,
    pub ply: usize,
    pub source_kind: String,
    pub best_move: String,
    pub moved_piece: PieceDto,
    pub destination: String,
    pub targets: Vec<ForkTargetDto>,
    pub cp_loss: u32,
    pub label: MoveLabelDto,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForkTargetDto {
    pub square: String,
    pub piece: PieceDto,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PieceDto {
    pub color: ColorDto,
    pub kind: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetryPositionDto {
    pub rank: usize,
    pub entry_index: usize,
    pub ply: usize,
    pub fen_before: String,
    pub played_move: String,
    pub best_move: Option<String>,
    pub san: String,
    pub label: MoveLabelDto,
    pub cp_loss: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MoveLabelDto {
    Best,
    Good,
    Inaccuracy,
    Mistake,
    Blunder,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MoveQualityDto {
    Brilliant,
    Great,
    Best,
    Excellent,
    Good,
    Inaccuracy,
    Mistake,
    Blunder,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ColorDto {
    White,
    Black,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GameStatusDto {
    Ongoing,
    Checkmate,
    Stalemate,
    Draw,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DrawReasonDto {
    FiftyMove,
    InsufficientMaterial,
    ThreefoldRepetition,
}

#[non_exhaustive]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WasmBridgeError {
    InvalidFen,
    InvalidPgn,
    InvalidMove,
    InvalidDepth,
    InvalidPosition,
    SearchFailed,
}

const ARTIFACT_MAX_MOMENTS: usize = 5;
const REACTION_MAP_MAX_CANDIDATES: usize = 6;
const FORCING_MAP_MAX_CANDIDATES: usize = 8;
const ARTIFACT_MINIMUM_LABEL: MoveLabel = MoveLabel::Inaccuracy;
const EARLY_DIVERGENCE_MINIMUM_CP_LOSS: u32 = 51;

impl fmt::Display for WasmBridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidFen => "invalid FEN",
            Self::InvalidPgn => "invalid PGN",
            Self::InvalidMove => "invalid move",
            Self::InvalidDepth => "invalid search depth",
            Self::InvalidPosition => "invalid position",
            Self::SearchFailed => "search failed",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for WasmBridgeError {}

pub fn new_game() -> EngineStateDto {
    // The start position is a fixed, valid position: failing here is a board bug, not user input,
    // and must not be papered over with an "ongoing" state that has no legal moves.
    state_dto(&Position::startpos()).expect("the start position always has a valid state")
}

pub fn make_move(request: MakeMoveRequestDto) -> Result<MoveResultDto, WasmBridgeError> {
    make_move_with_history(MakeMoveContextRequestDto {
        fen: request.fen,
        mv: request.mv,
        history_fens: String::new(),
    })
}

pub fn make_move_with_history(
    request: MakeMoveContextRequestDto,
) -> Result<MoveResultDto, WasmBridgeError> {
    let position = parse_position(&request.fen)?;
    let mv = Move::from_coordinate(&request.mv).map_err(|_error| WasmBridgeError::InvalidMove)?;
    let san = position.move_to_san(mv).map_err(map_san_error)?;
    let child = position
        .after_legal_move(mv)
        .map_err(map_legal_move_error)?;
    let history_positions = parse_context_history(&request.history_fens, &position)?;
    let mut history_hashes = history_positions
        .iter()
        .map(Position::zobrist_hash)
        .collect::<Vec<_>>();
    history_hashes.push(position.zobrist_hash());

    Ok(MoveResultDto {
        applied_move: mv.to_coordinate(),
        san,
        state: state_dto_with_history(&child, &history_hashes)?,
    })
}

pub fn best_move(request: BestMoveRequestDto) -> Result<BestMoveDto, WasmBridgeError> {
    let position = parse_position(&request.fen)?;
    search_position(
        &position,
        request.depth,
        request.aggressive,
        play_node_budget(request.node_budget),
    )
}

pub fn analyze(request: AnalyzeRequestDto) -> Result<AnalysisDto, WasmBridgeError> {
    let position = parse_position(&request.fen)?;
    // Analysis is always neutral; the aggressive personality only colours the engine's own play.
    let best = search_position(&position, request.depth, false, PLAY_NODE_BUDGET)?;
    Ok(AnalysisDto {
        state: state_dto(&position)?,
        best_move: best.best_move,
        depth: best.depth,
        score_cp: best.score_cp,
        nodes: best.nodes,
        tt_hits: best.tt_hits,
    })
}

pub fn reaction_map(request: ReactionMapRequestDto) -> Result<ReactionMapDto, WasmBridgeError> {
    let position = parse_position(&request.fen)?;
    if request.depth == 0 {
        return Err(WasmBridgeError::InvalidDepth);
    }
    let lines = if request.deep {
        // Deep lens: iterative deepening under the play node budget (~1s), grandmaster depth.
        reaction_lines_deep(&position, deep_lens_limits()).map_err(map_search_error)?
    } else {
        // Fast lens runs on the fixed M8 window; a higher play-strength selection is clamped down
        // so it never trips InvalidDepth.
        let depth = request.depth.min(chess_search::MAX_M8_DEPTH);
        reaction_lines(&position, SearchConfig { max_depth: depth }).map_err(map_search_error)?
    };
    reaction_map_dto(&position, lines)
}

pub fn forcing_map(request: ForcingMapRequestDto) -> Result<ForcingMapDto, WasmBridgeError> {
    let position = parse_position(&request.fen)?;
    if request.depth == 0 {
        return Err(WasmBridgeError::InvalidDepth);
    }
    let host = color_from_dto(request.host);
    let report = if request.deep {
        forcing_moves_deep(&position, deep_lens_limits(), host).map_err(map_search_error)?
    } else {
        let depth = request.depth.min(chess_search::MAX_M8_DEPTH);
        forcing_moves(&position, SearchConfig { max_depth: depth }, host)
            .map_err(map_search_error)?
    };
    forcing_map_dto(&position, report)
}

/// Search limits for the deep lens. Its own, smaller budget (the lens scores *every* candidate, so
/// it does far more work per node than the single-line play search) keeps it responsive — a couple
/// of seconds even in sharp positions where quiescence balloons — while still deepening well past
/// the fixed M8 lens in calmer positions.
///
/// Recalibrated 250_000 -> 60_000 on 2026-07-01 after a timed depth/latency sweep (release build,
/// `chess-cli side-explore --aggressive`) exposed the 2026-06-30 value as pure latency with no
/// depth payoff:
///   22_000  -> depth 3, ~0.65 s native
///   60_000  -> depth 4, ~0.71 s native
///   100_000 -> depth 4, ~1.06 s native
///   250_000 -> depth 4, ~2.5-3.4 s native (~5-6 s WASM)
/// Depth plateaus at 4 from 60_000 onward in quiet middlegames; the 60_000 -> 250_000 range spends
/// ~4x the wall-clock for the *same* depth. 60_000 also beats the pre-2026-06-30 value of 22_000
/// (depth 4 vs 3) at essentially the same latency, so it is the genuine sweet spot: ~0.7-0.8 s
/// native / ~1.5 s WASM. Deeper judgment must come from eval quality, not more nodes on a
/// plateau.
const DEEP_LENS_NODE_BUDGET: u64 = 60_000;

fn deep_lens_limits() -> SearchLimits {
    SearchLimits {
        max_depth: chess_search::MAX_PLAY_DEPTH,
        node_budget: Some(DEEP_LENS_NODE_BUDGET),
    }
}

pub fn side_explore_call(
    request: SideExploreRequestDto,
) -> Result<SideExploreDto, WasmBridgeError> {
    let position = parse_position(&request.fen)?;
    let side = color_from_dto(request.side);
    let report = explore::side_explore(
        &position,
        &[],
        DEEP_LENS_NODE_BUDGET,
        side,
        request.aggressive,
    )
    .map_err(map_search_error)?;
    side_explore_dto(&position, report, request.aggressive)
}

pub fn side_explore_context_call(
    request: SideExploreContextRequestDto,
) -> Result<SideExploreDto, WasmBridgeError> {
    let position = parse_position(&request.fen)?;
    let side = color_from_dto(request.side);
    let history_positions = parse_context_history(&request.history_fens, &position)?;
    let history_hashes = history_positions
        .iter()
        .map(Position::zobrist_hash)
        .collect::<Vec<_>>();
    let report = explore::side_explore(
        &position,
        &history_hashes,
        DEEP_LENS_NODE_BUDGET,
        side,
        request.aggressive,
    )
    .map_err(map_search_error)?;
    side_explore_dto(&position, report, request.aggressive)
}

pub fn side_explore_context_v2_call(
    request: SideExploreContextV2RequestDto,
) -> Result<SideExploreDto, WasmBridgeError> {
    let position = parse_position(&request.fen)?;
    let side = color_from_dto(request.side);
    let history_positions = parse_context_history(&request.history_fens, &position)?;
    let history_hashes = history_positions
        .iter()
        .map(Position::zobrist_hash)
        .collect::<Vec<_>>();
    let previous_line = parse_context_line(&request.previous_line)?;
    let planned = if request.aggressive {
        planned_continuation_from_context(&position, side, &history_positions, &previous_line)?
    } else {
        None
    };
    let budget = if request.node_budget == 0 {
        DEEP_LENS_NODE_BUDGET
    } else {
        u64::from(request.node_budget)
    };
    let report =
        explore::side_explore(&position, &history_hashes, budget, side, request.aggressive)
            .map_err(map_search_error)?;
    let (plan_status, plan_reason) =
        side_explore_plan_status(&position, &previous_line, planned, &report);
    let mut dto = side_explore_dto(&position, report, request.aggressive)?;
    dto.plan_status = Some(plan_status);
    dto.plan_reason = Some(plan_reason);
    Ok(dto)
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn side_explore_json(fen: &str, side: &str, aggressive: bool) -> String {
    let Some(side_dto) = parse_color(side) else {
        return error_result_json(WasmBridgeError::InvalidPosition);
    };
    match side_explore_call(SideExploreRequestDto {
        fen: fen.to_owned(),
        side: side_dto,
        aggressive,
    }) {
        Ok(result) => side_explore_result_json(&result),
        Err(error) => error_result_json(error),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn side_explore_context_json(
    fen: &str,
    side: &str,
    aggressive: bool,
    history_fens: &str,
) -> String {
    let Some(side_dto) = parse_color(side) else {
        return error_result_json(WasmBridgeError::InvalidPosition);
    };
    match side_explore_context_call(SideExploreContextRequestDto {
        fen: fen.to_owned(),
        side: side_dto,
        aggressive,
        history_fens: history_fens.to_owned(),
    }) {
        Ok(result) => side_explore_result_json(&result),
        Err(error) => error_result_json(error),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn side_explore_context_v2_json(
    fen: &str,
    side: &str,
    aggressive: bool,
    history_fens: &str,
    node_budget: u32,
    previous_line: &str,
) -> String {
    let Some(side_dto) = parse_color(side) else {
        return error_result_json(WasmBridgeError::InvalidPosition);
    };
    match side_explore_context_v2_call(SideExploreContextV2RequestDto {
        fen: fen.to_owned(),
        side: side_dto,
        aggressive,
        history_fens: history_fens.to_owned(),
        node_budget,
        previous_line: previous_line.to_owned(),
    }) {
        Ok(result) => side_explore_result_json(&result),
        Err(error) => error_result_json(error),
    }
}

pub fn review_pgn(request: ReviewPgnRequestDto) -> Result<GameReviewDto, WasmBridgeError> {
    let (_game, review) = review_pgn_core(request)?;
    Ok(game_review_dto(review))
}

pub fn review_pgn_with_artifacts(
    request: ReviewPgnRequestDto,
) -> Result<ReviewPgnWithArtifactsDto, WasmBridgeError> {
    let (game, review) = review_pgn_core(request)?;
    let artifacts = review_artifacts_dto(game.moves(), &review)?;
    Ok(ReviewPgnWithArtifactsDto {
        review: game_review_dto(review),
        artifacts,
    })
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn review_pgn_json(pgn: &str, depth: u8) -> String {
    match review_pgn(ReviewPgnRequestDto {
        pgn: pgn.to_owned(),
        depth,
    }) {
        Ok(review) => review_result_json(&review),
        Err(error) => error_result_json(error),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn review_pgn_with_artifacts_json(pgn: &str, depth: u8) -> String {
    match review_pgn_with_artifacts(ReviewPgnRequestDto {
        pgn: pgn.to_owned(),
        depth,
    }) {
        Ok(review) => review_with_artifacts_result_json(&review),
        Err(error) => error_result_json(error),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn reaction_map_json(fen: &str, depth: u8, deep: bool) -> String {
    match reaction_map(ReactionMapRequestDto {
        fen: fen.to_owned(),
        depth,
        deep,
    }) {
        Ok(result) => reaction_map_result_json(&result),
        Err(error) => error_result_json(error),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn forcing_map_json(fen: &str, depth: u8, host: &str, deep: bool) -> String {
    let Some(host) = parse_color(host) else {
        return error_result_json(WasmBridgeError::InvalidPosition);
    };
    match forcing_map(ForcingMapRequestDto {
        fen: fen.to_owned(),
        depth,
        host,
        deep,
    }) {
        Ok(result) => forcing_map_result_json(&result),
        Err(error) => error_result_json(error),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn new_game_json() -> String {
    engine_state_result_json(&new_game())
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn position_json(fen: &str) -> String {
    match parse_position(fen) {
        Ok(position) => match state_dto(&position) {
            Ok(state) => engine_state_result_json(&state),
            Err(error) => error_result_json(error),
        },
        Err(error) => error_result_json(error),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn make_move_json(fen: &str, mv: &str) -> String {
    match make_move(MakeMoveRequestDto {
        fen: fen.to_owned(),
        mv: mv.to_owned(),
    }) {
        Ok(result) => move_result_json(&result),
        Err(error) => error_result_json(error),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn make_move_context_json(fen: &str, mv: &str, history_fens: &str) -> String {
    match make_move_with_history(MakeMoveContextRequestDto {
        fen: fen.to_owned(),
        mv: mv.to_owned(),
        history_fens: history_fens.to_owned(),
    }) {
        Ok(result) => move_result_json(&result),
        Err(error) => error_result_json(error),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn best_move_json(fen: &str, depth: u8, aggressive: bool, node_budget: u32) -> String {
    match best_move(BestMoveRequestDto {
        fen: fen.to_owned(),
        depth,
        aggressive,
        node_budget,
    }) {
        Ok(result) => best_move_result_json(&result),
        Err(error) => error_result_json(error),
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn best_move_context_json(
    fen: &str,
    depth: u8,
    aggressive: bool,
    side: &str,
    history_fens: &str,
    previous_line: &str,
    node_budget: u32,
) -> String {
    let Some(side_dto) = parse_color(side) else {
        return error_result_json(WasmBridgeError::InvalidPosition);
    };
    match best_move_context(BestMoveContextRequestDto {
        fen: fen.to_owned(),
        depth,
        aggressive,
        node_budget,
        side: side_dto,
        history_fens: history_fens.to_owned(),
        previous_line: previous_line.to_owned(),
    }) {
        Ok(result) => best_move_result_json(&result),
        Err(error) => error_result_json(error),
    }
}

thread_local! {
    /// The play engine keeps its transposition table and histories between moves of one game,
    /// plus that game's line (positions up to its last search) to tell a continuation from a new game.
    static PLAY_ENGINE: std::cell::RefCell<(chess_search::engine::Engine, Vec<u64>)> =
        std::cell::RefCell::new((chess_search::engine::Engine::new(PLAY_ENGINE_HASH_MB), Vec::new()));
}

const PLAY_ENGINE_HASH_MB: usize = 16;

/// The opponent's reply from the full engine at an adjustable strength `level`
/// (1 to `chess_search::skill::MAX_LEVEL`). `history_fens` holds the game positions before `fen`;
/// `node_budget` caps the full-strength search; `seed` drives the weaker levels' sampling.
pub fn engine_move(
    fen: &str,
    history_fens: &str,
    level: u8,
    node_budget: u32,
    seed: u32,
) -> Result<BestMoveDto, WasmBridgeError> {
    let position = parse_position(fen)?;
    let history_hashes = parse_context_history(history_fens, &position)?
        .iter()
        .map(Position::zobrist_hash)
        .collect::<Vec<_>>();
    let result = PLAY_ENGINE.with(|engine| {
        let (engine, line) = &mut *engine.borrow_mut();
        // Anything but a continuation of the last searched line (new game, undo, loaded FEN)
        // starts clean, so one game's tables never steer another's moves.
        if line.is_empty() || !history_hashes.starts_with(line) {
            engine.new_game();
        }
        line.clone_from(&history_hashes);
        line.push(position.zobrist_hash());
        chess_search::skill::think_at_level(
            engine,
            &position,
            &history_hashes,
            level,
            Some(play_node_budget(node_budget)),
            u64::from(seed),
        )
    });
    Ok(BestMoveDto {
        best_move: result.best_move.map(|mv| mv.to_coordinate()),
        depth: result.depth,
        score_cp: result.score_cp,
        nodes: result.nodes,
        tt_hits: 0,
        principal_line: None,
        followed_plan: None,
    })
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn engine_move_json(
    fen: &str,
    history_fens: &str,
    level: u8,
    node_budget: u32,
    seed: u32,
) -> String {
    match engine_move(fen, history_fens, level, node_budget, seed) {
        Ok(result) => best_move_result_json(&result),
        Err(error) => error_result_json(error),
    }
}

fn review_pgn_core(request: ReviewPgnRequestDto) -> Result<(PgnGame, GameReview), WasmBridgeError> {
    if request.depth < 2 || request.depth > chess_search::MAX_M8_DEPTH {
        return Err(WasmBridgeError::InvalidDepth);
    }

    let game = PgnGame::from_pgn(&request.pgn).map_err(|_error| WasmBridgeError::InvalidPgn)?;
    let review = review_pgn_game(
        &game,
        CoachConfig {
            search_depth: request.depth,
        },
    )
    .map_err(map_coach_error)?;
    Ok((game, review))
}

fn parse_position(fen: &str) -> Result<Position, WasmBridgeError> {
    Position::from_fen(fen).map_err(|_error| WasmBridgeError::InvalidFen)
}

fn search_position(
    position: &Position,
    depth: u8,
    aggressive: bool,
    node_budget: u64,
) -> Result<BestMoveDto, WasmBridgeError> {
    if depth == 0 || depth > chess_search::MAX_PLAY_DEPTH {
        return Err(WasmBridgeError::InvalidDepth);
    }
    engine_best_move(position, &[], aggressive, node_budget)
}

/// The owned Play move for the side to move: Explore's top candidate on the playing engine, so
/// aggressive play is the most attacking sound move and neutral play is the engine's best.
fn engine_best_move(
    position: &Position,
    history_hashes: &[u64],
    aggressive: bool,
    node_budget: u64,
) -> Result<BestMoveDto, WasmBridgeError> {
    let report = explore::side_explore(
        position,
        history_hashes,
        node_budget,
        position.side_to_move(),
        aggressive,
    )
    .map_err(map_search_error)?;
    let top = report.candidates.first();
    Ok(BestMoveDto {
        best_move: top.map(|candidate| candidate.mv.to_coordinate()),
        depth: report.depth,
        score_cp: top.map_or(0, |candidate| candidate.exact_score),
        nodes: report.nodes,
        tt_hits: 0,
        principal_line: Some(
            report
                .principal_line
                .iter()
                .map(|mv| mv.to_coordinate())
                .collect(),
        ),
        followed_plan: Some(false),
    })
}

fn parse_context_history(
    text: &str,
    current_position: &Position,
) -> Result<Vec<Position>, WasmBridgeError> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let mut positions = Vec::new();
    for fen in text.lines() {
        if positions.len() >= MAX_CONTEXT_HISTORY_FENS {
            return Err(WasmBridgeError::InvalidPosition);
        }
        positions.push(parse_position(fen)?);
    }
    let mut chain = positions.iter();
    let Some(mut previous) = chain.next() else {
        return Ok(positions);
    };
    for next in chain {
        let reachable = previous
            .legal_moves()
            .map_err(map_legal_move_error)?
            .into_iter()
            .filter_map(|mv| previous.after_legal_move(mv).ok())
            .any(|candidate| candidate == *next);
        if !reachable {
            return Err(WasmBridgeError::InvalidPosition);
        }
        previous = next;
    }
    if previous != current_position {
        let reachable = previous
            .legal_moves()
            .map_err(map_legal_move_error)?
            .into_iter()
            .filter_map(|mv| previous.after_legal_move(mv).ok())
            .any(|candidate| candidate == *current_position);
        if !reachable {
            return Err(WasmBridgeError::InvalidPosition);
        }
    }
    Ok(positions)
}

fn parse_context_line(text: &str) -> Result<Vec<Move>, WasmBridgeError> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let mut moves = Vec::new();
    for coordinate in text.split(',') {
        if moves.len() >= MAX_CONTEXT_LINE_MOVES {
            return Err(WasmBridgeError::InvalidPosition);
        }
        moves.push(
            Move::from_coordinate(coordinate).map_err(|_error| WasmBridgeError::InvalidMove)?,
        );
    }
    Ok(moves)
}

fn planned_continuation_from_context(
    position: &Position,
    side: Color,
    history: &[Position],
    previous_line: &[Move],
) -> Result<Option<Move>, WasmBridgeError> {
    if previous_line.len() < 3 || history.len() < 2 || position.side_to_move() != side {
        return Ok(None);
    }
    let previous_root = &history[history.len() - 2];
    if previous_root.side_to_move() != side {
        return Ok(None);
    }
    let Ok(after_first) = previous_root.after_legal_move(previous_line[0]) else {
        return Ok(None);
    };
    if after_first.zobrist_hash() != history[history.len() - 1].zobrist_hash() {
        return Ok(None);
    }
    let Ok(after_reply) = after_first.after_legal_move(previous_line[1]) else {
        return Ok(None);
    };
    if after_reply.zobrist_hash() == position.zobrist_hash() {
        Ok(Some(previous_line[2]))
    } else {
        Ok(None)
    }
}

pub fn best_move_context(
    request: BestMoveContextRequestDto,
) -> Result<BestMoveDto, WasmBridgeError> {
    let position = parse_position(&request.fen)?;
    let side = color_from_dto(request.side);
    if position.side_to_move() != side {
        return Err(WasmBridgeError::InvalidPosition);
    }
    let history_positions = parse_context_history(&request.history_fens, &position)?;
    let history_hashes = history_positions
        .iter()
        .map(Position::zobrist_hash)
        .collect::<Vec<_>>();
    parse_context_line(&request.previous_line)?;
    if request.depth == 0 || request.depth > chess_search::MAX_PLAY_DEPTH {
        return Err(WasmBridgeError::InvalidDepth);
    }
    engine_best_move(
        &position,
        &history_hashes,
        request.aggressive,
        play_node_budget(request.node_budget),
    )
}

fn play_node_budget(node_budget: u32) -> u64 {
    if node_budget == 0 {
        PLAY_NODE_BUDGET
    } else {
        u64::from(node_budget)
    }
}

fn reaction_map_dto(
    position: &Position,
    lines: ReactionLines,
) -> Result<ReactionMapDto, WasmBridgeError> {
    let state = state_dto(position)?;
    let root_candidates = lines
        .candidates
        .into_iter()
        .take(REACTION_MAP_MAX_CANDIDATES)
        .map(|candidate| ReactionCandidateDto {
            mv: candidate.mv.to_coordinate(),
            score_cp: candidate.score,
            hangs: candidate.hangs_material,
            mate_in: candidate.mate_in,
            quality: move_quality_dto(candidate.quality),
        })
        .collect();
    let principal_line = lines
        .principal_line
        .iter()
        .map(|mv| mv.to_coordinate())
        .collect();
    Ok(ReactionMapDto {
        state,
        root_candidates,
        principal_line,
        mate_detected: lines.mate_detected,
        depth: lines.depth,
        nodes: lines.nodes,
    })
}

fn forcing_map_dto(
    position: &Position,
    report: ForcingReport,
) -> Result<ForcingMapDto, WasmBridgeError> {
    let state = state_dto(position)?;
    let candidates = report
        .candidates
        .into_iter()
        .take(FORCING_MAP_MAX_CANDIDATES)
        .map(|candidate| ForcingCandidateDto {
            mv: candidate.mv.to_coordinate(),
            kind: forcing_kind_dto(candidate.kind),
            score_cp: candidate.score,
            sound: candidate.sound,
            mate_in: candidate.mate_in,
        })
        .collect();
    Ok(ForcingMapDto {
        state,
        host: color_dto(report.host),
        on_turn: report.on_turn,
        candidates,
        depth: report.depth,
        nodes: report.nodes,
    })
}

fn side_explore_dto(
    position: &Position,
    report: SideExploreReport,
    aggressive: bool,
) -> Result<SideExploreDto, WasmBridgeError> {
    let state = state_dto(position)?;
    let on_turn = report.on_turn;
    let reply_candidates = report
        .reply_candidates
        .into_iter()
        .map(side_explore_reply_dto)
        .collect();
    let candidates = side_explore_candidate_dtos(report.candidates);
    let principal_line: Vec<String> = report
        .principal_line
        .iter()
        .map(|mv| mv.to_coordinate())
        .collect();
    let explanation = candidates.first().filter(|_| on_turn).and_then(|first| {
        explanation::explain_first_candidate(position, &first.mv, &principal_line)
    });
    let mut dto = SideExploreDto {
        state,
        side: color_dto(report.side),
        on_turn,
        reply_candidates,
        candidates,
        opening_status: OpeningStatusDto {
            status: "unavailable",
            eco: None,
            name: None,
            mv: None,
        },
        principal_line,
        mate_detected: report.mate_detected,
        depth: report.depth,
        nodes: report.nodes,
        sound_margin_cp: EXPLORE_SOUND_MARGIN_CP,
        explanation,
        plan_status: None,
        plan_reason: None,
    };
    annotate_opening_provenance(position, &mut dto, aggressive);
    Ok(dto)
}

/// Grades every candidate against the best exact score among them. Aggressive mode may put a
/// sound move up to the sound margin below the best first, so the first candidate is not the
/// reference: grading against it would call every candidate "best".
fn side_explore_candidate_dtos(
    candidates: Vec<SideExploreCandidate>,
) -> Vec<SideExploreCandidateDto> {
    let Some(best) = candidates.iter().map(|c| c.exact_score).max() else {
        return Vec::new();
    };
    candidates
        .into_iter()
        .map(|c| SideExploreCandidateDto {
            mv: c.mv.to_coordinate(),
            kind: forcing_kind_dto(c.kind),
            exact_score_cp: c.exact_score,
            quality: move_quality_dto(classify_win_percent_loss(best, c.exact_score)),
            sound: c.sound,
            sacrifice: c.sacrifice,
            mate_in: c.mate_in,
            aftermath: c.aftermath.map(sacrifice_aftermath_label),
            continuation: c.continuation.map(|mv| mv.to_coordinate()),
            prospective_brilliant: c.prospective_brilliant,
            opening: None,
        })
        .collect()
}

fn annotate_opening_provenance(position: &Position, dto: &mut SideExploreDto, aggressive: bool) {
    if !aggressive || !dto.on_turn || dto.state.side_to_move != dto.side {
        return;
    }

    for candidate in &mut dto.candidates {
        if !opening_eligible_candidate(candidate) {
            continue;
        }
        let Some(opening) = opening_for_candidate(position, &candidate.mv) else {
            continue;
        };
        candidate.opening = Some(opening.clone());
        if dto.opening_status.status == "unavailable" {
            dto.opening_status = OpeningStatusDto {
                status: "available",
                eco: Some(opening.eco),
                name: Some(opening.name),
                mv: Some(candidate.mv.clone()),
            };
        }
    }
}

fn opening_eligible_candidate(candidate: &SideExploreCandidateDto) -> bool {
    candidate.sound
        && candidate.exact_score_cp >= 0
        && matches!(
            candidate.quality,
            MoveQualityDto::Brilliant
                | MoveQualityDto::Great
                | MoveQualityDto::Best
                | MoveQualityDto::Excellent
                | MoveQualityDto::Good
        )
        && (!candidate.sacrifice
            || candidate.aftermath.is_some() && candidate.continuation.is_some())
}

fn opening_for_candidate(
    position: &Position,
    coordinate_move: &str,
) -> Option<OpeningProvenanceDto> {
    let mut best_match: Option<(usize, OpeningProvenanceDto)> = None;
    for line in include_str!("../../../data/openings/explore-aggressive-v1.tsv").lines() {
        if line.is_empty() || line.starts_with('#') || line == "eco\tname\tpgn" {
            continue;
        }
        let mut columns = line.split('\t');
        let eco = columns.next()?;
        let name = columns.next()?;
        let pgn = columns.next()?;
        if columns.next().is_some() {
            continue;
        }
        if catalog_line_matches_candidate(position, coordinate_move, pgn) {
            let ply_count = pgn
                .split_whitespace()
                .filter(|token| !token.ends_with('.'))
                .count();
            if best_match
                .as_ref()
                .is_none_or(|(best_ply_count, _)| ply_count < *best_ply_count)
            {
                best_match = Some((
                    ply_count,
                    OpeningProvenanceDto {
                        eco: eco.to_owned(),
                        name: name.to_owned(),
                    },
                ));
            }
        }
    }
    best_match.map(|(_, opening)| opening)
}

fn catalog_line_matches_candidate(position: &Position, coordinate_move: &str, pgn: &str) -> bool {
    let mut replay = Position::startpos();
    for token in pgn.split_whitespace() {
        if token.ends_with('.') {
            continue;
        }
        let Ok(mv) = replay.parse_san(token) else {
            return false;
        };
        if replay == *position && mv.to_coordinate() == coordinate_move {
            return true;
        }
        let Ok(next) = replay.after_legal_move(mv) else {
            return false;
        };
        replay = next;
    }
    false
}

fn side_explore_plan_status(
    position: &Position,
    previous_line: &[Move],
    planned: Option<Move>,
    report: &SideExploreReport,
) -> (&'static str, &'static str) {
    if previous_line.is_empty() {
        return ("none", "no-previous-line");
    }
    let Some(planned) = planned else {
        if previous_line
            .get(2)
            .is_some_and(|mv| position.after_legal_move(*mv).is_err())
        {
            return ("replaced", "illegal-continuation");
        }
        return ("replaced", "live-board-recomputed");
    };
    let matches_recomputed_plan = report.principal_line.first().copied() == Some(planned)
        || report
            .candidates
            .iter()
            .any(|candidate| candidate.mv == planned);
    let planned_candidate_is_sound = report
        .candidates
        .iter()
        .find(|candidate| candidate.mv == planned)
        .is_some_and(|candidate| {
            candidate.sound && (!candidate.sacrifice || candidate.aftermath.is_some())
        });
    if matches_recomputed_plan && planned_candidate_is_sound {
        ("followed", "matched-history-and-gate")
    } else {
        ("replaced", "live-board-recomputed")
    }
}

fn side_explore_reply_dto(reply: ReplyCandidate) -> SideExploreReplyDto {
    SideExploreReplyDto {
        mv: reply.mv.to_coordinate(),
        role: match reply.role {
            ReplyCandidateRole::ObjectivePrimary => "objective-primary",
            ReplyCandidateRole::Alternative => "alternative",
        },
        kind: forcing_kind_dto(reply.kind),
        quality: move_quality_dto(reply.quality),
        sound: reply.sound,
        sacrifice: reply.sacrifice,
        mate_in: reply.mate_in,
    }
}

const fn sacrifice_aftermath_label(aftermath: SacrificeAftermath) -> &'static str {
    match aftermath {
        SacrificeAftermath::Accepted => "accepted",
        SacrificeAftermath::Defended => "defended",
    }
}

const fn forcing_kind_dto(kind: ForcingKind) -> ForcingKindDto {
    match kind {
        ForcingKind::Mate => ForcingKindDto::Mate,
        ForcingKind::Check => ForcingKindDto::Check,
        ForcingKind::Capture => ForcingKindDto::Capture,
        ForcingKind::Defense => ForcingKindDto::Defense,
    }
}

fn game_review_dto(review: GameReview) -> GameReviewDto {
    GameReviewDto {
        summary: review_summary_dto(review.summary),
        entries: review.entries.into_iter().map(review_entry_dto).collect(),
    }
}

const fn review_summary_dto(summary: ReviewSummary) -> ReviewSummaryDto {
    ReviewSummaryDto {
        total_moves: summary.total_moves,
        best: summary.best,
        good: summary.good,
        inaccuracies: summary.inaccuracies,
        mistakes: summary.mistakes,
        blunders: summary.blunders,
    }
}

fn review_entry_dto(entry: ReviewEntry) -> ReviewEntryDto {
    ReviewEntryDto {
        ply: entry.ply,
        played_move: entry.played_move.to_coordinate(),
        san: entry.san,
        best_move: entry.best_move.map(|mv| mv.to_coordinate()),
        best_score_cp: entry.best_score_cp,
        played_score_cp: entry.played_score_cp,
        cp_loss: entry.cp_loss,
        label: move_label_dto(entry.label),
    }
}

fn review_artifacts_dto(
    moves: &[Move],
    review: &GameReview,
) -> Result<ReviewArtifactsDto, WasmBridgeError> {
    let moments = select_key_moments(
        review,
        KeyMomentConfig {
            max_moments: ARTIFACT_MAX_MOMENTS,
            minimum_label: ARTIFACT_MINIMUM_LABEL,
        },
    );
    let evidence = collect_key_moment_evidence(&moments);
    let early_move_divergences = select_early_move_divergences(
        review,
        EarlyMoveDivergenceConfig {
            minimum_cp_loss: EARLY_DIVERGENCE_MINIMUM_CP_LOSS,
        },
    );
    let retry_positions = generate_retry_positions(
        moves,
        review,
        RetryConfig {
            max_positions: ARTIFACT_MAX_MOMENTS,
            minimum_label: ARTIFACT_MINIMUM_LABEL,
        },
    )
    .map_err(map_coach_error)?;
    let fork_candidates =
        collect_fork_candidate_evidence(&retry_positions).map_err(map_coach_error)?;

    Ok(ReviewArtifactsDto {
        key_moments: moments.into_iter().map(key_moment_dto).collect(),
        evidence: evidence.into_iter().map(move_evidence_dto).collect(),
        fork_candidates: fork_candidates
            .into_iter()
            .map(fork_candidate_dto)
            .collect(),
        early_move_divergences: early_move_divergences
            .into_iter()
            .map(early_move_divergence_dto)
            .collect(),
        retry_positions: retry_positions
            .into_iter()
            .map(retry_position_dto)
            .collect(),
    })
}

fn key_moment_dto(moment: KeyMoment) -> KeyMomentDto {
    KeyMomentDto {
        rank: moment.rank,
        entry_index: moment.entry_index,
        kind: key_moment_kind_json(moment.kind).to_owned(),
        ply: moment.entry.ply,
        played_move: moment.entry.played_move.to_coordinate(),
        san: moment.entry.san,
        best_move: moment.entry.best_move.map(|mv| mv.to_coordinate()),
        best_score_cp: moment.entry.best_score_cp,
        played_score_cp: moment.entry.played_score_cp,
        cp_loss: moment.entry.cp_loss,
        label: move_label_dto(moment.entry.label),
    }
}

fn move_evidence_dto(evidence: MoveEvidence) -> MoveEvidenceDto {
    MoveEvidenceDto {
        rank: evidence.rank,
        entry_index: evidence.entry_index,
        ply: evidence.ply,
        kind: evidence_kind_json(evidence.kind).to_owned(),
        played_move: evidence.played_move.to_coordinate(),
        san: evidence.san,
        best_move: evidence.best_move.map(|mv| mv.to_coordinate()),
        best_score_cp: evidence.best_score_cp,
        played_score_cp: evidence.played_score_cp,
        cp_loss: evidence.cp_loss,
        label: move_label_dto(evidence.label),
    }
}

fn early_move_divergence_dto(divergence: EarlyMoveDivergence) -> EarlyMoveDivergenceDto {
    EarlyMoveDivergenceDto {
        entry_index: divergence.entry_index,
        ply: divergence.ply,
        played_move: divergence.played_move.to_coordinate(),
        san: divergence.san,
        local_best_move: divergence.local_best_move.to_coordinate(),
        best_score_cp: divergence.best_score_cp,
        played_score_cp: divergence.played_score_cp,
        cp_loss: divergence.cp_loss,
        label: move_label_dto(divergence.label),
    }
}

fn fork_candidate_dto(candidate: ForkCandidateEvidence) -> ForkCandidateDto {
    ForkCandidateDto {
        rank: candidate.rank,
        entry_index: candidate.entry_index,
        ply: candidate.ply,
        source_kind: fork_candidate_source_kind_json(candidate.source_kind).to_owned(),
        best_move: candidate.best_move.to_coordinate(),
        moved_piece: piece_dto(candidate.moved_piece),
        destination: candidate.destination.to_algebraic(),
        targets: candidate
            .targets
            .into_iter()
            .map(|target| ForkTargetDto {
                square: target.square.to_algebraic(),
                piece: piece_dto(target.piece),
            })
            .collect(),
        cp_loss: candidate.cp_loss,
        label: move_label_dto(candidate.label),
    }
}

fn piece_dto(piece: chess_board::Piece) -> PieceDto {
    PieceDto {
        color: color_dto(piece.color()),
        kind: piece_kind_json(piece.kind()).to_owned(),
    }
}

fn retry_position_dto(position: RetryPosition) -> RetryPositionDto {
    RetryPositionDto {
        rank: position.rank,
        entry_index: position.entry_index,
        ply: position.ply,
        fen_before: position.fen_before,
        played_move: position.played_move.to_coordinate(),
        best_move: position.best_move.map(|mv| mv.to_coordinate()),
        san: position.san,
        label: move_label_dto(position.label),
        cp_loss: position.cp_loss,
    }
}

const fn move_label_dto(label: MoveLabel) -> MoveLabelDto {
    match label {
        MoveLabel::Best => MoveLabelDto::Best,
        MoveLabel::Good => MoveLabelDto::Good,
        MoveLabel::Inaccuracy => MoveLabelDto::Inaccuracy,
        MoveLabel::Mistake => MoveLabelDto::Mistake,
        MoveLabel::Blunder => MoveLabelDto::Blunder,
    }
}

fn state_dto(position: &Position) -> Result<EngineStateDto, WasmBridgeError> {
    state_dto_with_history(position, &[])
}

fn state_dto_with_history(
    position: &Position,
    history_hashes: &[u64],
) -> Result<EngineStateDto, WasmBridgeError> {
    let legal_moves = position
        .legal_moves()
        .map_err(map_legal_move_error)?
        .into_iter()
        .map(|mv| mv.to_coordinate())
        .collect();
    let position_status = position.status().map_err(map_legal_move_error)?;
    let draw_reason = match position_status {
        PositionStatus::Ongoing => draw_reason(position, history_hashes),
        PositionStatus::Checkmate | PositionStatus::Stalemate => None,
    };

    Ok(EngineStateDto {
        fen: position.to_fen(),
        status: status_dto(position_status, draw_reason),
        draw_reason,
        side_to_move: color_dto(position.side_to_move()),
        legal_moves,
    })
}

fn draw_reason(position: &Position, history_hashes: &[u64]) -> Option<DrawReasonDto> {
    if position.is_fifty_move_draw() {
        return Some(DrawReasonDto::FiftyMove);
    }
    if position.has_insufficient_material() {
        return Some(DrawReasonDto::InsufficientMaterial);
    }
    (history_hashes
        .iter()
        .filter(|hash| **hash == position.zobrist_hash())
        .count()
        >= 2)
        .then_some(DrawReasonDto::ThreefoldRepetition)
}

fn status_dto(status: PositionStatus, draw_reason: Option<DrawReasonDto>) -> GameStatusDto {
    match status {
        PositionStatus::Ongoing if draw_reason.is_some() => GameStatusDto::Draw,
        PositionStatus::Ongoing => GameStatusDto::Ongoing,
        PositionStatus::Checkmate => GameStatusDto::Checkmate,
        PositionStatus::Stalemate => GameStatusDto::Stalemate,
    }
}

fn color_dto(color: chess_board::Color) -> ColorDto {
    match color {
        chess_board::Color::White => ColorDto::White,
        chess_board::Color::Black => ColorDto::Black,
    }
}

const fn color_from_dto(color: ColorDto) -> chess_board::Color {
    match color {
        ColorDto::White => chess_board::Color::White,
        ColorDto::Black => chess_board::Color::Black,
    }
}

fn parse_color(text: &str) -> Option<ColorDto> {
    match text {
        "white" => Some(ColorDto::White),
        "black" => Some(ColorDto::Black),
        _ => None,
    }
}

fn map_legal_move_error(error: LegalMoveError) -> WasmBridgeError {
    match error {
        LegalMoveError::InvalidPosition => WasmBridgeError::InvalidPosition,
        LegalMoveError::NodeCountOverflow => WasmBridgeError::InvalidPosition,
        _ => WasmBridgeError::InvalidPosition,
    }
}

fn map_san_error(error: SanError) -> WasmBridgeError {
    match error {
        SanError::LegalMove(error) => map_legal_move_error(error),
        SanError::Empty | SanError::InvalidMove | SanError::AmbiguousMove => {
            WasmBridgeError::InvalidMove
        }
        _ => WasmBridgeError::InvalidMove,
    }
}

fn map_search_error(error: SearchError) -> WasmBridgeError {
    match error {
        SearchError::InvalidDepth => WasmBridgeError::InvalidDepth,
        SearchError::InvalidPosition => WasmBridgeError::InvalidPosition,
    }
}

fn map_coach_error(error: CoachError) -> WasmBridgeError {
    match error {
        CoachError::InvalidDepth => WasmBridgeError::InvalidDepth,
        CoachError::IllegalMove => WasmBridgeError::InvalidMove,
        CoachError::InvalidPosition => WasmBridgeError::InvalidPosition,
        CoachError::SearchFailed | CoachError::InconsistentReview => WasmBridgeError::SearchFailed,
    }
}

fn review_result_json(review: &GameReviewDto) -> String {
    let mut output = String::from(r#"{"ok":true,"review":"#);
    push_game_review_json(&mut output, review);
    output.push('}');
    output
}

fn review_with_artifacts_result_json(review: &ReviewPgnWithArtifactsDto) -> String {
    let mut output = String::from(r#"{"ok":true,"reviewWithArtifacts":"#);
    push_review_with_artifacts_json(&mut output, review);
    output.push('}');
    output
}

fn engine_state_result_json(state: &EngineStateDto) -> String {
    let mut output = String::from(r#"{"ok":true,"state":"#);
    push_engine_state_json(&mut output, state);
    output.push('}');
    output
}

fn move_result_json(result: &MoveResultDto) -> String {
    let mut output = String::from(r#"{"ok":true,"move":"#);
    push_move_result_json(&mut output, result);
    output.push('}');
    output
}

fn best_move_result_json(result: &BestMoveDto) -> String {
    let mut output = String::from(r#"{"ok":true,"bestMove":"#);
    push_best_move_json(&mut output, result);
    output.push('}');
    output
}

fn reaction_map_result_json(result: &ReactionMapDto) -> String {
    let mut output = String::from(r#"{"ok":true,"reactionMap":"#);
    push_reaction_map_json(&mut output, result);
    output.push('}');
    output
}

fn forcing_map_result_json(result: &ForcingMapDto) -> String {
    let mut output = String::from(r#"{"ok":true,"forcingMap":"#);
    push_forcing_map_json(&mut output, result);
    output.push('}');
    output
}

fn side_explore_result_json(result: &SideExploreDto) -> String {
    let mut output = String::from(r#"{"ok":true,"sideExplore":"#);
    push_side_explore_json(&mut output, result);
    output.push('}');
    output
}

fn push_side_explore_json(output: &mut String, result: &SideExploreDto) {
    output.push('{');
    output.push_str(r#""state":"#);
    push_engine_state_json(output, &result.state);
    push_string_field(output, "side", color_json(result.side), true);
    push_bool_field(output, "onTurn", result.on_turn);
    output.push_str(r#","replyCandidates":["#);
    push_array(
        output,
        &result.reply_candidates,
        push_side_explore_reply_json,
    );
    output.push_str(r#"],"candidates":["#);
    push_array(output, &result.candidates, push_side_explore_candidate_json);
    output.push_str(r#"],"openingStatus":"#);
    push_opening_status_json(output, &result.opening_status);
    output.push_str(r#","principalLine":["#);
    push_coordinate_array(output, &result.principal_line);
    output.push(']');
    push_bool_field(output, "mateDetected", result.mate_detected);
    push_u8_field(output, "depth", result.depth);
    push_u64_field(output, "nodes", result.nodes);
    push_i32_field(output, "soundMarginCp", result.sound_margin_cp);
    if let Some(explanation) = &result.explanation {
        output.push_str(r#","explanation":"#);
        explanation::push_explanation_json(output, explanation);
    }
    if let (Some(status), Some(reason)) = (result.plan_status, result.plan_reason) {
        push_string_field(output, "planStatus", status, true);
        push_string_field(output, "planReason", reason, true);
    }
    output.push('}');
}

fn push_side_explore_candidate_json(output: &mut String, candidate: &SideExploreCandidateDto) {
    output.push('{');
    push_string_field(output, "move", &candidate.mv, false);
    push_string_field(output, "kind", forcing_kind_json(candidate.kind), true);
    push_i32_field(output, "exactScoreCp", candidate.exact_score_cp);
    push_string_field(
        output,
        "quality",
        move_quality_json(candidate.quality),
        true,
    );
    push_bool_field(output, "sound", candidate.sound);
    push_bool_field(output, "sacrifice", candidate.sacrifice);
    push_bool_field(
        output,
        "prospectiveBrilliant",
        candidate.prospective_brilliant,
    );
    output.push_str(r#","mateIn":"#);
    match candidate.mate_in {
        Some(distance) => output.push_str(&distance.to_string()),
        None => output.push_str("null"),
    }
    output.push_str(r#","aftermath":"#);
    match candidate.aftermath {
        Some(label) => {
            output.push('"');
            output.push_str(label);
            output.push('"');
        }
        None => output.push_str("null"),
    }
    output.push_str(r#","continuation":"#);
    match &candidate.continuation {
        Some(coordinate) => {
            output.push('"');
            output.push_str(coordinate);
            output.push('"');
        }
        None => output.push_str("null"),
    }
    output.push_str(r#","opening":"#);
    match &candidate.opening {
        Some(opening) => push_opening_provenance_json(output, opening),
        None => output.push_str("null"),
    }
    output.push('}');
}

fn push_opening_status_json(output: &mut String, status: &OpeningStatusDto) {
    output.push('{');
    push_string_field(output, "status", status.status, false);
    output.push_str(r#","eco":"#);
    match &status.eco {
        Some(eco) => push_json_string(output, eco),
        None => output.push_str("null"),
    }
    output.push_str(r#","name":"#);
    match &status.name {
        Some(name) => push_json_string(output, name),
        None => output.push_str("null"),
    }
    output.push_str(r#","move":"#);
    match &status.mv {
        Some(mv) => push_json_string(output, mv),
        None => output.push_str("null"),
    }
    output.push('}');
}

fn push_opening_provenance_json(output: &mut String, opening: &OpeningProvenanceDto) {
    output.push('{');
    push_string_field(output, "eco", &opening.eco, false);
    push_string_field(output, "name", &opening.name, true);
    output.push('}');
}

fn push_side_explore_reply_json(output: &mut String, reply: &SideExploreReplyDto) {
    output.push('{');
    push_string_field(output, "move", &reply.mv, false);
    push_string_field(output, "role", reply.role, true);
    push_string_field(output, "kind", forcing_kind_json(reply.kind), true);
    push_string_field(output, "quality", move_quality_json(reply.quality), true);
    push_bool_field(output, "sound", reply.sound);
    push_bool_field(output, "sacrifice", reply.sacrifice);
    output.push_str(r#","mateIn":"#);
    match reply.mate_in {
        Some(distance) => output.push_str(&distance.to_string()),
        None => output.push_str("null"),
    }
    output.push('}');
}

fn error_result_json(error: WasmBridgeError) -> String {
    let mut output = String::from(r#"{"ok":false,"error":"#);
    push_json_string(&mut output, error_json(error));
    output.push('}');
    output
}

fn push_engine_state_json(output: &mut String, state: &EngineStateDto) {
    output.push('{');
    push_string_field(output, "fen", &state.fen, false);
    push_string_field(output, "status", status_json(state.status), true);
    output.push_str(",\"drawReason\":");
    match state.draw_reason {
        Some(reason) => push_json_string(output, draw_reason_json(reason)),
        None => output.push_str("null"),
    }
    push_string_field(output, "sideToMove", color_json(state.side_to_move), true);
    output.push_str(r#","legalMoves":["#);
    for (index, mv) in state.legal_moves.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        push_json_string(output, mv);
    }
    output.push_str("]}");
}

fn push_move_result_json(output: &mut String, result: &MoveResultDto) {
    output.push('{');
    push_string_field(output, "appliedMove", &result.applied_move, false);
    push_string_field(output, "san", &result.san, true);
    output.push_str(r#","state":"#);
    push_engine_state_json(output, &result.state);
    output.push('}');
}

fn push_best_move_json(output: &mut String, result: &BestMoveDto) {
    output.push('{');
    output.push_str(r#""bestMove":"#);
    match &result.best_move {
        Some(best_move) => push_json_string(output, best_move),
        None => output.push_str("null"),
    }
    push_u8_field(output, "depth", result.depth);
    push_i32_field(output, "scoreCp", result.score_cp);
    push_u64_field(output, "nodes", result.nodes);
    push_u64_field(output, "ttHits", result.tt_hits);
    if let Some(line) = &result.principal_line {
        output.push_str(r#","principalLine":["#);
        push_coordinate_array(output, line);
        output.push(']');
    }
    if let Some(followed_plan) = result.followed_plan {
        push_bool_field(output, "followedPlan", followed_plan);
    }
    output.push('}');
}

fn push_reaction_map_json(output: &mut String, result: &ReactionMapDto) {
    output.push('{');
    output.push_str(r#""state":"#);
    push_engine_state_json(output, &result.state);
    output.push_str(r#","rootCandidates":["#);
    push_array(
        output,
        &result.root_candidates,
        push_reaction_candidate_json,
    );
    output.push_str(r#"],"principalLine":["#);
    push_coordinate_array(output, &result.principal_line);
    output.push_str(r#"],"projectedLine":["#);
    push_coordinate_array(output, &result.principal_line);
    output.push(']');
    push_bool_field(output, "mateDetected", result.mate_detected);
    push_u8_field(output, "depth", result.depth);
    push_u64_field(output, "nodes", result.nodes);
    output.push('}');
}

fn push_reaction_candidate_json(output: &mut String, candidate: &ReactionCandidateDto) {
    output.push('{');
    push_string_field(output, "move", &candidate.mv, false);
    push_i32_field(output, "scoreCp", candidate.score_cp);
    push_bool_field(output, "hangs", candidate.hangs);
    output.push_str(r#","mateIn":"#);
    match candidate.mate_in {
        Some(distance) => output.push_str(&distance.to_string()),
        None => output.push_str("null"),
    }
    push_string_field(
        output,
        "quality",
        move_quality_json(candidate.quality),
        true,
    );
    output.push('}');
}

const fn move_quality_dto(quality: MoveQuality) -> MoveQualityDto {
    match quality {
        MoveQuality::Brilliant => MoveQualityDto::Brilliant,
        MoveQuality::Great => MoveQualityDto::Great,
        MoveQuality::Best => MoveQualityDto::Best,
        MoveQuality::Excellent => MoveQualityDto::Excellent,
        MoveQuality::Good => MoveQualityDto::Good,
        MoveQuality::Inaccuracy => MoveQualityDto::Inaccuracy,
        MoveQuality::Mistake => MoveQualityDto::Mistake,
        MoveQuality::Blunder => MoveQualityDto::Blunder,
    }
}

const fn move_quality_json(quality: MoveQualityDto) -> &'static str {
    match quality {
        MoveQualityDto::Brilliant => "brilliant",
        MoveQualityDto::Great => "great",
        MoveQualityDto::Best => "best",
        MoveQualityDto::Excellent => "excellent",
        MoveQualityDto::Good => "good",
        MoveQualityDto::Inaccuracy => "inaccuracy",
        MoveQualityDto::Mistake => "mistake",
        MoveQualityDto::Blunder => "blunder",
    }
}

fn push_forcing_map_json(output: &mut String, result: &ForcingMapDto) {
    output.push('{');
    output.push_str(r#""state":"#);
    push_engine_state_json(output, &result.state);
    push_string_field(output, "host", color_json(result.host), true);
    push_bool_field(output, "onTurn", result.on_turn);
    output.push_str(r#","candidates":["#);
    push_array(output, &result.candidates, push_forcing_candidate_json);
    output.push(']');
    push_u8_field(output, "depth", result.depth);
    push_u64_field(output, "nodes", result.nodes);
    output.push('}');
}

fn push_forcing_candidate_json(output: &mut String, candidate: &ForcingCandidateDto) {
    output.push('{');
    push_string_field(output, "move", &candidate.mv, false);
    push_string_field(output, "kind", forcing_kind_json(candidate.kind), true);
    push_i32_field(output, "scoreCp", candidate.score_cp);
    push_bool_field(output, "sound", candidate.sound);
    output.push_str(r#","mateIn":"#);
    match candidate.mate_in {
        Some(distance) => output.push_str(&distance.to_string()),
        None => output.push_str("null"),
    }
    output.push('}');
}

const fn forcing_kind_json(kind: ForcingKindDto) -> &'static str {
    match kind {
        ForcingKindDto::Mate => "mate",
        ForcingKindDto::Check => "check",
        ForcingKindDto::Capture => "capture",
        ForcingKindDto::Defense => "defense",
    }
}

fn push_coordinate_array(output: &mut String, values: &[String]) {
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        push_json_string(output, value);
    }
}

fn push_game_review_json(output: &mut String, review: &GameReviewDto) {
    output.push('{');
    output.push_str(r#""summary":"#);
    push_summary_json(output, &review.summary);
    output.push_str(r#","entries":["#);
    for (index, entry) in review.entries.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        push_entry_json(output, entry);
    }
    output.push_str("]}");
}

fn push_review_with_artifacts_json(output: &mut String, review: &ReviewPgnWithArtifactsDto) {
    output.push('{');
    output.push_str(r#""review":"#);
    push_game_review_json(output, &review.review);
    output.push_str(r#","artifacts":"#);
    push_artifacts_json(output, &review.artifacts);
    output.push('}');
}

fn push_artifacts_json(output: &mut String, artifacts: &ReviewArtifactsDto) {
    output.push('{');
    output.push_str(r#""keyMoments":["#);
    push_array(output, &artifacts.key_moments, push_key_moment_json);
    output.push_str(r#"],"evidence":["#);
    push_array(output, &artifacts.evidence, push_move_evidence_json);
    output.push_str(r#"],"forkCandidates":["#);
    push_array(output, &artifacts.fork_candidates, push_fork_candidate_json);
    output.push_str(r#"],"earlyMoveDivergences":["#);
    push_array(
        output,
        &artifacts.early_move_divergences,
        push_early_move_divergence_json,
    );
    output.push_str(r#"],"retryPositions":["#);
    push_array(output, &artifacts.retry_positions, push_retry_position_json);
    output.push_str("]}");
}

fn push_array<T>(output: &mut String, values: &[T], push_value: fn(&mut String, &T)) {
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        push_value(output, value);
    }
}

fn push_key_moment_json(output: &mut String, moment: &KeyMomentDto) {
    output.push('{');
    push_usize_field(output, "rank", moment.rank, false);
    push_usize_field(output, "entryIndex", moment.entry_index, true);
    push_string_field(output, "kind", &moment.kind, true);
    push_usize_field(output, "ply", moment.ply, true);
    push_string_field(output, "playedMove", &moment.played_move, true);
    push_string_field(output, "san", &moment.san, true);
    push_optional_string_field(output, "bestMove", moment.best_move.as_deref());
    push_i32_field(output, "bestScoreCp", moment.best_score_cp);
    push_i32_field(output, "playedScoreCp", moment.played_score_cp);
    push_u32_field(output, "cpLoss", moment.cp_loss);
    push_string_field(output, "label", move_label_json(moment.label), true);
    output.push('}');
}

fn push_move_evidence_json(output: &mut String, evidence: &MoveEvidenceDto) {
    output.push('{');
    push_usize_field(output, "rank", evidence.rank, false);
    push_usize_field(output, "entryIndex", evidence.entry_index, true);
    push_usize_field(output, "ply", evidence.ply, true);
    push_string_field(output, "kind", &evidence.kind, true);
    push_string_field(output, "playedMove", &evidence.played_move, true);
    push_string_field(output, "san", &evidence.san, true);
    push_optional_string_field(output, "bestMove", evidence.best_move.as_deref());
    push_i32_field(output, "bestScoreCp", evidence.best_score_cp);
    push_i32_field(output, "playedScoreCp", evidence.played_score_cp);
    push_u32_field(output, "cpLoss", evidence.cp_loss);
    push_string_field(output, "label", move_label_json(evidence.label), true);
    output.push('}');
}

fn push_early_move_divergence_json(output: &mut String, divergence: &EarlyMoveDivergenceDto) {
    output.push('{');
    push_usize_field(output, "entryIndex", divergence.entry_index, false);
    push_usize_field(output, "ply", divergence.ply, true);
    push_string_field(output, "playedMove", &divergence.played_move, true);
    push_string_field(output, "san", &divergence.san, true);
    push_string_field(output, "localBestMove", &divergence.local_best_move, true);
    push_i32_field(output, "bestScoreCp", divergence.best_score_cp);
    push_i32_field(output, "playedScoreCp", divergence.played_score_cp);
    push_u32_field(output, "cpLoss", divergence.cp_loss);
    push_string_field(output, "label", move_label_json(divergence.label), true);
    output.push('}');
}

fn push_fork_candidate_json(output: &mut String, candidate: &ForkCandidateDto) {
    output.push('{');
    push_usize_field(output, "rank", candidate.rank, false);
    push_usize_field(output, "entryIndex", candidate.entry_index, true);
    push_usize_field(output, "ply", candidate.ply, true);
    push_string_field(output, "sourceKind", &candidate.source_kind, true);
    push_string_field(output, "bestMove", &candidate.best_move, true);
    output.push_str(r#","movedPiece":"#);
    push_piece_json(output, &candidate.moved_piece);
    push_string_field(output, "destination", &candidate.destination, true);
    output.push_str(r#","targets":["#);
    push_array(output, &candidate.targets, push_fork_target_json);
    output.push(']');
    push_u32_field(output, "cpLoss", candidate.cp_loss);
    push_string_field(output, "label", move_label_json(candidate.label), true);
    output.push('}');
}

fn push_fork_target_json(output: &mut String, target: &ForkTargetDto) {
    output.push('{');
    push_string_field(output, "square", &target.square, false);
    output.push_str(r#","piece":"#);
    push_piece_json(output, &target.piece);
    output.push('}');
}

fn push_piece_json(output: &mut String, piece: &PieceDto) {
    output.push('{');
    push_string_field(output, "color", color_json(piece.color), false);
    push_string_field(output, "kind", &piece.kind, true);
    output.push('}');
}

fn push_retry_position_json(output: &mut String, retry: &RetryPositionDto) {
    output.push('{');
    push_usize_field(output, "rank", retry.rank, false);
    push_usize_field(output, "entryIndex", retry.entry_index, true);
    push_usize_field(output, "ply", retry.ply, true);
    push_string_field(output, "fenBefore", &retry.fen_before, true);
    push_string_field(output, "playedMove", &retry.played_move, true);
    push_optional_string_field(output, "bestMove", retry.best_move.as_deref());
    push_string_field(output, "san", &retry.san, true);
    push_string_field(output, "label", move_label_json(retry.label), true);
    push_u32_field(output, "cpLoss", retry.cp_loss);
    output.push('}');
}

fn push_summary_json(output: &mut String, summary: &ReviewSummaryDto) {
    output.push('{');
    push_usize_field(output, "totalMoves", summary.total_moves, false);
    push_usize_field(output, "best", summary.best, true);
    push_usize_field(output, "good", summary.good, true);
    push_usize_field(output, "inaccuracies", summary.inaccuracies, true);
    push_usize_field(output, "mistakes", summary.mistakes, true);
    push_usize_field(output, "blunders", summary.blunders, true);
    output.push('}');
}

fn push_entry_json(output: &mut String, entry: &ReviewEntryDto) {
    output.push('{');
    push_usize_field(output, "ply", entry.ply, false);
    push_string_field(output, "playedMove", &entry.played_move, true);
    push_string_field(output, "san", &entry.san, true);
    output.push_str(r#","bestMove":"#);
    match &entry.best_move {
        Some(best_move) => push_json_string(output, best_move),
        None => output.push_str("null"),
    }
    push_i32_field(output, "bestScoreCp", entry.best_score_cp);
    push_i32_field(output, "playedScoreCp", entry.played_score_cp);
    push_u32_field(output, "cpLoss", entry.cp_loss);
    push_string_field(output, "label", move_label_json(entry.label), true);
    output.push('}');
}

fn push_usize_field(output: &mut String, name: &str, value: usize, comma: bool) {
    if comma {
        output.push(',');
    }
    push_json_string(output, name);
    output.push(':');
    output.push_str(&value.to_string());
}

fn push_u8_field(output: &mut String, name: &str, value: u8) {
    output.push(',');
    push_json_string(output, name);
    output.push(':');
    output.push_str(&value.to_string());
}

fn push_i32_field(output: &mut String, name: &str, value: i32) {
    output.push(',');
    push_json_string(output, name);
    output.push(':');
    output.push_str(&value.to_string());
}

fn push_u32_field(output: &mut String, name: &str, value: u32) {
    output.push(',');
    push_json_string(output, name);
    output.push(':');
    output.push_str(&value.to_string());
}

fn push_u64_field(output: &mut String, name: &str, value: u64) {
    output.push(',');
    push_json_string(output, name);
    output.push(':');
    output.push_str(&value.to_string());
}

fn push_bool_field(output: &mut String, name: &str, value: bool) {
    output.push(',');
    push_json_string(output, name);
    output.push(':');
    output.push_str(if value { "true" } else { "false" });
}

fn push_string_field(output: &mut String, name: &str, value: &str, comma: bool) {
    if comma {
        output.push(',');
    }
    push_json_string(output, name);
    output.push(':');
    push_json_string(output, value);
}

fn push_optional_string_field(output: &mut String, name: &str, value: Option<&str>) {
    output.push(',');
    push_json_string(output, name);
    output.push(':');
    match value {
        Some(text) => push_json_string(output, text),
        None => output.push_str("null"),
    }
}

fn push_json_string(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str(r#"\""#),
            '\\' => output.push_str(r#"\\"#),
            '\n' => output.push_str(r#"\n"#),
            '\r' => output.push_str(r#"\r"#),
            '\t' => output.push_str(r#"\t"#),
            '\u{08}' => output.push_str(r#"\b"#),
            '\u{0c}' => output.push_str(r#"\f"#),
            '\0'..='\u{1f}' => push_control_escape(output, character),
            _ => output.push(character),
        }
    }
    output.push('"');
}

fn push_control_escape(output: &mut String, character: char) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let code = character as usize;
    output.push_str(r#"\u00"#);
    output.push(HEX[(code >> 4) & 0x0f] as char);
    output.push(HEX[code & 0x0f] as char);
}

const fn move_label_json(label: MoveLabelDto) -> &'static str {
    match label {
        MoveLabelDto::Best => "best",
        MoveLabelDto::Good => "good",
        MoveLabelDto::Inaccuracy => "inaccuracy",
        MoveLabelDto::Mistake => "mistake",
        MoveLabelDto::Blunder => "blunder",
    }
}

const fn key_moment_kind_json(kind: KeyMomentKind) -> &'static str {
    match kind {
        KeyMomentKind::CentipawnLoss => "centipawn-loss",
    }
}

const fn evidence_kind_json(kind: EvidenceKind) -> &'static str {
    match kind {
        EvidenceKind::LocalSearchSwing => "local-search-swing",
    }
}

const fn fork_candidate_source_kind_json(kind: ForkCandidateSourceKind) -> &'static str {
    match kind {
        ForkCandidateSourceKind::BestMoveAfterPosition => "best-move-after-position",
    }
}

const fn color_json(color: ColorDto) -> &'static str {
    match color {
        ColorDto::White => "white",
        ColorDto::Black => "black",
    }
}

const fn status_json(status: GameStatusDto) -> &'static str {
    match status {
        GameStatusDto::Ongoing => "ongoing",
        GameStatusDto::Checkmate => "checkmate",
        GameStatusDto::Stalemate => "stalemate",
        GameStatusDto::Draw => "draw",
    }
}

const fn draw_reason_json(reason: DrawReasonDto) -> &'static str {
    match reason {
        DrawReasonDto::FiftyMove => "fifty-move",
        DrawReasonDto::InsufficientMaterial => "insufficient-material",
        DrawReasonDto::ThreefoldRepetition => "threefold-repetition",
    }
}

const fn piece_kind_json(kind: chess_board::PieceKind) -> &'static str {
    match kind {
        chess_board::PieceKind::King => "king",
        chess_board::PieceKind::Queen => "queen",
        chess_board::PieceKind::Rook => "rook",
        chess_board::PieceKind::Bishop => "bishop",
        chess_board::PieceKind::Knight => "knight",
        chess_board::PieceKind::Pawn => "pawn",
    }
}

const fn error_json(error: WasmBridgeError) -> &'static str {
    match error {
        WasmBridgeError::InvalidFen => "invalid-fen",
        WasmBridgeError::InvalidPgn => "invalid-pgn",
        WasmBridgeError::InvalidMove => "invalid-move",
        WasmBridgeError::InvalidDepth => "invalid-depth",
        WasmBridgeError::InvalidPosition => "invalid-position",
        WasmBridgeError::SearchFailed => "search-failed",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ColorDto, EngineStateDto, ForcingCandidateDto, ForcingKindDto, ForcingMapDto,
        ForcingMapRequestDto, ForkCandidateDto, ForkTargetDto, GameStatusDto, MoveLabelDto,
        MoveQualityDto, OpeningProvenanceDto, OpeningStatusDto, PieceDto, ReactionCandidateDto,
        ReactionMapDto, ReactionMapRequestDto, ReviewArtifactsDto, SideExploreCandidateDto,
        SideExploreDto, best_move_context_json, catalog_line_matches_candidate, forcing_map,
        fork_candidate_dto, game_review_dto, new_game, opening_eligible_candidate,
        opening_for_candidate, planned_continuation_from_context, push_artifacts_json,
        push_forcing_map_json, push_reaction_map_json, push_side_explore_json, reaction_map,
        side_explore_candidate_dtos, side_explore_context_v2_json, side_explore_plan_status,
    };
    use chess_board::{Color, Move, Piece, PieceKind, Position, Square};
    use chess_coach::{
        ForkCandidateEvidence, ForkCandidateSourceKind, ForkTarget, GameReview, MoveLabel,
        ReviewEntry, ReviewSummary,
    };
    use chess_search::{ForcingKind, SideExploreCandidate};

    fn mv(text: &str) -> Move {
        Move::from_coordinate(text).expect("test move should parse")
    }

    fn square(text: &str) -> Square {
        Square::from_algebraic(text).expect("test square should parse")
    }

    #[test]
    fn explore_aggressive_opening_catalog_has_pinned_header_and_range() {
        let catalog = include_str!("../../../data/openings/explore-aggressive-v1.tsv");
        let rows = catalog
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect::<Vec<_>>();

        assert!(
            catalog.contains("292fd0468068f58bb244f7fe1c3e573e493c3c53"),
            "catalog must pin the approved source revision"
        );
        assert!(
            catalog.contains("CC0 Public Domain Dedication"),
            "catalog must quote the approved source license statement"
        );
        assert_eq!(rows.first(), Some(&"eco\tname\tpgn"));
        assert!(
            (24..=48).contains(&(rows.len() - 1)),
            "catalog row count must stay inside ADR-0260 range"
        );
    }

    #[test]
    fn explore_aggressive_opening_catalog_rows_replay_from_startpos() {
        let catalog = include_str!("../../../data/openings/explore-aggressive-v1.tsv");
        let mut row_count = 0;

        for (line_number, line) in catalog.lines().enumerate() {
            if line.is_empty() || line.starts_with('#') || line == "eco\tname\tpgn" {
                continue;
            }
            let columns = line.split('\t').collect::<Vec<_>>();
            assert_eq!(
                columns.len(),
                3,
                "bad TSV shape at line {}",
                line_number + 1
            );
            assert!(
                columns[0].len() == 3 && columns[0].chars().all(|ch| ch.is_ascii_alphanumeric()),
                "bad ECO at line {}",
                line_number + 1
            );
            let mut position = Position::startpos();
            for token in columns[2].split_whitespace() {
                if token.ends_with('.') {
                    continue;
                }
                let mv = position
                    .parse_san(token)
                    .unwrap_or_else(|_| panic!("bad SAN {token} at line {}", line_number + 1));
                position = position
                    .after_legal_move(mv)
                    .unwrap_or_else(|_| panic!("illegal move {token} at line {}", line_number + 1));
            }
            row_count += 1;
        }

        assert_eq!(row_count, 27);
    }

    fn opening_candidate(
        exact_score_cp: i32,
        quality: MoveQualityDto,
        sound: bool,
        sacrifice: bool,
        aftermath: Option<&'static str>,
        continuation: Option<&str>,
    ) -> SideExploreCandidateDto {
        SideExploreCandidateDto {
            mv: "e2e4".to_owned(),
            kind: ForcingKindDto::Defense,
            exact_score_cp,
            quality,
            sound,
            sacrifice,
            mate_in: None,
            aftermath,
            continuation: continuation.map(str::to_owned),
            prospective_brilliant: false,
            opening: None,
        }
    }

    #[test]
    fn opening_candidate_gate_requires_all_adr_0260_safety_fields() {
        assert!(opening_eligible_candidate(&opening_candidate(
            0,
            MoveQualityDto::Good,
            true,
            false,
            None,
            None
        )));
        assert!(!opening_eligible_candidate(&opening_candidate(
            -1,
            MoveQualityDto::Good,
            true,
            false,
            None,
            None
        )));
        assert!(!opening_eligible_candidate(&opening_candidate(
            0,
            MoveQualityDto::Inaccuracy,
            true,
            false,
            None,
            None
        )));
        assert!(!opening_eligible_candidate(&opening_candidate(
            0,
            MoveQualityDto::Good,
            false,
            false,
            None,
            None
        )));
        assert!(!opening_eligible_candidate(&opening_candidate(
            0,
            MoveQualityDto::Good,
            true,
            true,
            Some("accepted"),
            None
        )));
        assert!(opening_eligible_candidate(&opening_candidate(
            0,
            MoveQualityDto::Good,
            true,
            true,
            Some("accepted"),
            Some("g1f3")
        )));
    }

    #[test]
    fn opening_catalog_matches_only_existing_next_move_prefixes() {
        let start = Position::startpos();
        let pgn = "1. e4 c5";

        assert!(catalog_line_matches_candidate(&start, "e2e4", pgn));
        assert!(!catalog_line_matches_candidate(&start, "d2d4", pgn));

        let after_e4 = start
            .after_legal_move(mv("e2e4"))
            .expect("e4 must be legal");
        assert!(catalog_line_matches_candidate(&after_e4, "c7c5", pgn));
        assert_eq!(
            opening_for_candidate(&start, "e2e4"),
            Some(OpeningProvenanceDto {
                eco: "B20".to_owned(),
                name: "Sicilian Defense".to_owned()
            })
        );
    }

    #[test]
    fn side_explore_json_serializes_opening_status_without_mutating_core_fields() {
        let dto = SideExploreDto {
            state: EngineStateDto {
                fen: "start".to_owned(),
                status: GameStatusDto::Ongoing,
                draw_reason: None,
                side_to_move: ColorDto::White,
                legal_moves: vec!["e2e4".to_owned()],
            },
            side: ColorDto::White,
            on_turn: true,
            reply_candidates: Vec::new(),
            candidates: vec![SideExploreCandidateDto {
                opening: Some(OpeningProvenanceDto {
                    eco: "B20".to_owned(),
                    name: "Sicilian Defense".to_owned(),
                }),
                ..opening_candidate(12, MoveQualityDto::Best, true, false, None, None)
            }],
            opening_status: OpeningStatusDto {
                status: "available",
                eco: Some("B20".to_owned()),
                name: Some("Sicilian Defense".to_owned()),
                mv: Some("e2e4".to_owned()),
            },
            principal_line: vec!["e2e4".to_owned(), "c7c5".to_owned()],
            mate_detected: false,
            depth: 2,
            nodes: 99,
            sound_margin_cp: 50,
            explanation: None,
            plan_status: None,
            plan_reason: None,
        };
        let mut output = String::new();

        push_side_explore_json(&mut output, &dto);

        assert!(output.contains(r#""quality":"best""#), "{output}");
        assert!(
            output.contains(r#""opening":{"eco":"B20","name":"Sicilian Defense"}"#),
            "{output}"
        );
        assert!(
            output.contains(
                r#""openingStatus":{"status":"available","eco":"B20","name":"Sicilian Defense","move":"e2e4"}"#
            ),
            "{output}"
        );
        assert!(
            output.contains(r#""principalLine":["e2e4","c7c5"]"#),
            "{output}"
        );
        assert!(output.contains(r#""nodes":99"#), "{output}");
    }

    #[test]
    fn review_entry_mapping_preserves_absent_best_move() {
        let review = GameReview {
            entries: vec![ReviewEntry {
                ply: 1,
                played_move: mv("a2a3"),
                san: "a3".to_owned(),
                best_move: None,
                best_score_cp: -5,
                played_score_cp: -10,
                cp_loss: 5,
                label: MoveLabel::Good,
            }],
            summary: ReviewSummary {
                total_moves: 1,
                best: 0,
                good: 1,
                inaccuracies: 0,
                mistakes: 0,
                blunders: 0,
            },
        };

        let dto = game_review_dto(review);

        assert_eq!(dto.entries[0].best_move, None);
        assert_eq!(dto.entries[0].label, MoveLabelDto::Good);
    }

    #[test]
    fn fork_candidate_mapping_preserves_board_facts() {
        let dto = fork_candidate_dto(ForkCandidateEvidence {
            rank: 2,
            entry_index: 4,
            ply: 5,
            source_kind: ForkCandidateSourceKind::BestMoveAfterPosition,
            best_move: mv("e5f7"),
            moved_piece: Piece::new(Color::White, PieceKind::Knight),
            destination: square("f7"),
            targets: vec![
                ForkTarget {
                    square: square("d8"),
                    piece: Piece::new(Color::Black, PieceKind::Queen),
                },
                ForkTarget {
                    square: square("h8"),
                    piece: Piece::new(Color::Black, PieceKind::Rook),
                },
            ],
            cp_loss: 420,
            label: MoveLabel::Blunder,
        });

        assert_eq!(dto.rank, 2);
        assert_eq!(dto.entry_index, 4);
        assert_eq!(dto.ply, 5);
        assert_eq!(dto.source_kind, "best-move-after-position");
        assert_eq!(dto.best_move, "e5f7");
        assert_eq!(dto.moved_piece.color, ColorDto::White);
        assert_eq!(dto.moved_piece.kind, "knight");
        assert_eq!(dto.destination, "f7");
        assert_eq!(dto.targets[0].square, "d8");
        assert_eq!(dto.targets[0].piece.color, ColorDto::Black);
        assert_eq!(dto.targets[0].piece.kind, "queen");
        assert_eq!(dto.targets[1].square, "h8");
        assert_eq!(dto.targets[1].piece.kind, "rook");
        assert_eq!(dto.cp_loss, 420);
        assert_eq!(dto.label, MoveLabelDto::Blunder);
    }

    #[test]
    fn reaction_map_exposes_truncated_candidates_and_a_consistent_line() {
        let startpos = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let map = reaction_map(ReactionMapRequestDto {
            fen: startpos.to_owned(),
            depth: 2,
            deep: false,
        })
        .expect("reaction map must run");

        assert_eq!(map.state.fen, startpos);
        assert_eq!(map.root_candidates.len(), 6, "candidates must be truncated");
        assert_eq!(
            map.principal_line.first(),
            Some(&map.root_candidates[0].mv),
            "projected line must begin with the top candidate"
        );
        assert!(!map.mate_detected, "the opening is not a forced mate line");
        assert_eq!(map.depth, 2);
    }

    #[test]
    fn reaction_map_reports_terminal_mate_for_a_mating_move() {
        let map = reaction_map(ReactionMapRequestDto {
            fen: "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1".to_owned(),
            depth: 2,
            deep: false,
        })
        .expect("reaction map must run");

        assert_eq!(map.principal_line, vec!["a1a8".to_owned()]);
        assert!(map.mate_detected, "the mating line reaches checkmate");
    }

    #[test]
    fn reaction_map_json_serializes_engine_lines() {
        let map = ReactionMapDto {
            state: EngineStateDto {
                fen: "8/8/8/8/8/8/8/k6K w - - 0 1".to_owned(),
                status: GameStatusDto::Ongoing,
                draw_reason: None,
                side_to_move: ColorDto::White,
                legal_moves: vec!["h1g1".to_owned()],
            },
            root_candidates: vec![ReactionCandidateDto {
                mv: "h1g1".to_owned(),
                score_cp: 12,
                hangs: false,
                mate_in: None,
                quality: MoveQualityDto::Best,
            }],
            principal_line: vec!["h1g1".to_owned(), "a1b1".to_owned()],
            mate_detected: false,
            depth: 2,
            nodes: 7,
        };
        let mut output = String::new();

        push_reaction_map_json(&mut output, &map);

        assert_eq!(
            output,
            r#"{"state":{"fen":"8/8/8/8/8/8/8/k6K w - - 0 1","status":"ongoing","drawReason":null,"sideToMove":"white","legalMoves":["h1g1"]},"rootCandidates":[{"move":"h1g1","scoreCp":12,"hangs":false,"mateIn":null,"quality":"best"}],"principalLine":["h1g1","a1b1"],"projectedLine":["h1g1","a1b1"],"mateDetected":false,"depth":2,"nodes":7}"#
        );
    }

    #[test]
    fn side_explore_context_rejects_disconnected_history_before_repetition_scoring() {
        let start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let disconnected = "8/8/8/8/8/8/4K3/7k w - - 0 1";
        let current = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        let history = format!("{start}\n{disconnected}");

        let result = side_explore_context_v2_json(current, "black", true, &history, 22_000, "");

        assert_eq!(result, r#"{"ok":false,"error":"invalid-position"}"#);
    }

    #[test]
    fn side_explore_plan_status_does_not_follow_an_unsafe_matching_candidate() {
        let position = Position::startpos();
        let planned = mv("e2e4");
        let report = chess_search::SideExploreReport {
            side: Color::White,
            on_turn: true,
            reply_candidates: Vec::new(),
            candidates: vec![chess_search::SideExploreCandidate {
                mv: planned,
                kind: chess_search::ForcingKind::Defense,
                exact_score: -100,
                sound: false,
                sacrifice: false,
                mate_in: None,
                aftermath: None,
                continuation: None,
                prospective_brilliant: false,
            }],
            principal_line: vec![planned],
            mate_detected: false,
            depth: 1,
            nodes: 1,
        };

        assert_eq!(
            side_explore_plan_status(
                &position,
                &[planned, mv("e7e5"), planned],
                Some(planned),
                &report
            ),
            ("replaced", "live-board-recomputed")
        );

        let mut unproven_sacrifice = report.clone();
        unproven_sacrifice.candidates[0].sound = true;
        unproven_sacrifice.candidates[0].sacrifice = true;
        assert_eq!(
            side_explore_plan_status(
                &position,
                &[planned, mv("e7e5"), planned],
                Some(planned),
                &unproven_sacrifice
            ),
            ("replaced", "live-board-recomputed")
        );
    }

    #[test]
    fn best_move_context_json_returns_a_move_for_the_engine_side() {
        let after_user_move = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        let result = best_move_context_json(after_user_move, 1, false, "black", "", "", 1_000);

        assert!(result.contains(r#""ok":true"#), "{result}");
        assert!(result.contains(r#""bestMove":"#), "{result}");
    }

    #[test]
    fn new_game_is_the_start_position_with_its_twenty_moves() {
        let state = new_game();

        assert_eq!(state.fen, Position::startpos().to_fen());
        assert_eq!(state.status, GameStatusDto::Ongoing);
        assert_eq!(state.side_to_move, ColorDto::White);
        assert_eq!(state.legal_moves.len(), 20);
    }

    fn explore_candidate(coordinate: &str, exact_score: i32) -> SideExploreCandidate {
        SideExploreCandidate {
            mv: mv(coordinate),
            kind: ForcingKind::Defense,
            exact_score,
            sound: true,
            sacrifice: false,
            mate_in: None,
            aftermath: None,
            continuation: None,
            prospective_brilliant: false,
        }
    }

    #[test]
    fn explore_quality_is_graded_against_the_best_score_not_the_first_candidate() {
        // Aggressive order observed natively after 1.e4 e5 (300 k nodes): Bc4 +23 first, then
        // Nc3 +42, Nf3 +42, d4 +40. Grading against the first candidate called all four "best".
        let dtos = side_explore_candidate_dtos(vec![
            explore_candidate("f1c4", 23),
            explore_candidate("b1c3", 42),
            explore_candidate("g1f3", 42),
            explore_candidate("d2d4", 40),
        ]);
        let qualities: Vec<_> = dtos.iter().map(|dto| dto.quality).collect();

        assert_eq!(
            qualities,
            vec![
                MoveQualityDto::Excellent,
                MoveQualityDto::Best,
                MoveQualityDto::Best,
                MoveQualityDto::Excellent,
            ]
        );
        assert!(side_explore_candidate_dtos(Vec::new()).is_empty());
    }

    #[test]
    fn aggressive_explore_marks_best_only_the_top_scored_candidates() {
        let after_e4_e5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
        for aggressive in [false, true] {
            let dto = super::side_explore_context_v2_call(super::SideExploreContextV2RequestDto {
                fen: after_e4_e5.to_owned(),
                side: ColorDto::White,
                aggressive,
                history_fens: String::new(),
                node_budget: 100_000,
                previous_line: String::new(),
            })
            .expect("explore runs");
            let best = dto
                .candidates
                .iter()
                .map(|c| c.exact_score_cp)
                .max()
                .expect("candidates exist");
            for candidate in &dto.candidates {
                assert_eq!(
                    candidate.quality == MoveQualityDto::Best,
                    candidate.exact_score_cp == best,
                    "aggressive={aggressive} {candidate:?}"
                );
            }
        }
    }

    #[test]
    fn best_move_json_reports_line_and_has_no_plan() {
        let result = super::best_move_json(
            "1nbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1",
            1,
            false,
            0,
        );

        assert!(result.contains(r#""ok":true"#), "{result}");
        assert!(result.contains(r#""principalLine":["#), "{result}");
        assert!(result.contains(r#""followedPlan":false"#), "{result}");
        assert!(!result.contains(r#""plan":"#), "{result}");
        assert!(!result.contains(r#""threatModel":"#), "{result}");
    }

    #[test]
    fn best_move_context_matches_previous_line_against_history() {
        let start = Position::from_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
            .expect("start must parse");
        let after_engine =
            Position::from_fen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")
                .expect("after engine must parse");
        let current =
            Position::from_fen("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2")
                .expect("current must parse");
        let line = [
            Move::from_coordinate("e2e4").expect("move parses"),
            Move::from_coordinate("e7e5").expect("move parses"),
            Move::from_coordinate("d1f3").expect("move parses"),
        ];

        assert_eq!(
            planned_continuation_from_context(
                &current,
                Color::White,
                &[start, after_engine],
                &line
            )
            .expect("context match must run"),
            Some(Move::from_coordinate("d1f3").expect("move parses"))
        );
    }

    #[test]
    fn forcing_map_surfaces_a_mate_in_one_for_the_host() {
        let map = forcing_map(ForcingMapRequestDto {
            fen: "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1".to_owned(),
            depth: 2,
            host: ColorDto::White,
            deep: false,
        })
        .expect("forcing map must run");

        assert!(map.on_turn, "white is on turn");
        assert_eq!(map.host, ColorDto::White);
        let top = map.candidates.first().expect("a candidate must exist");
        assert_eq!(top.mv, "a1a8");
        assert_eq!(top.kind, ForcingKindDto::Mate);
        assert_eq!(top.mate_in, Some(1));
    }

    #[test]
    fn forcing_map_is_idle_when_the_host_is_not_on_turn() {
        let map = forcing_map(ForcingMapRequestDto {
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_owned(),
            depth: 2,
            host: ColorDto::Black,
            deep: false,
        })
        .expect("forcing map must run");

        assert!(!map.on_turn, "black is not on turn at the start");
        assert!(map.candidates.is_empty());
    }

    #[test]
    fn forcing_map_json_serializes_classified_candidates() {
        let map = ForcingMapDto {
            state: EngineStateDto {
                fen: "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1".to_owned(),
                status: GameStatusDto::Ongoing,
                draw_reason: None,
                side_to_move: ColorDto::White,
                legal_moves: vec!["a1a8".to_owned()],
            },
            host: ColorDto::White,
            on_turn: true,
            candidates: vec![
                ForcingCandidateDto {
                    mv: "a1a8".to_owned(),
                    kind: ForcingKindDto::Mate,
                    score_cp: 29_999,
                    sound: true,
                    mate_in: Some(1),
                },
                ForcingCandidateDto {
                    mv: "h1g2".to_owned(),
                    kind: ForcingKindDto::Defense,
                    score_cp: 8,
                    sound: true,
                    mate_in: None,
                },
            ],
            depth: 2,
            nodes: 11,
        };
        let mut output = String::new();

        push_forcing_map_json(&mut output, &map);

        assert_eq!(
            output,
            r#"{"state":{"fen":"6k1/5ppp/8/8/8/8/8/R6K w - - 0 1","status":"ongoing","drawReason":null,"sideToMove":"white","legalMoves":["a1a8"]},"host":"white","onTurn":true,"candidates":[{"move":"a1a8","kind":"mate","scoreCp":29999,"sound":true,"mateIn":1},{"move":"h1g2","kind":"defense","scoreCp":8,"sound":true,"mateIn":null}],"depth":2,"nodes":11}"#
        );
    }

    #[test]
    fn artifact_json_serializes_fork_candidate_facts() {
        let artifacts = ReviewArtifactsDto {
            key_moments: Vec::new(),
            evidence: Vec::new(),
            fork_candidates: vec![ForkCandidateDto {
                rank: 2,
                entry_index: 4,
                ply: 5,
                source_kind: "best-move-after-position".to_owned(),
                best_move: "e5f7".to_owned(),
                moved_piece: PieceDto {
                    color: ColorDto::White,
                    kind: "knight".to_owned(),
                },
                destination: "f7".to_owned(),
                targets: vec![
                    ForkTargetDto {
                        square: "d8".to_owned(),
                        piece: PieceDto {
                            color: ColorDto::Black,
                            kind: "queen".to_owned(),
                        },
                    },
                    ForkTargetDto {
                        square: "h8".to_owned(),
                        piece: PieceDto {
                            color: ColorDto::Black,
                            kind: "rook".to_owned(),
                        },
                    },
                ],
                cp_loss: 420,
                label: MoveLabelDto::Blunder,
            }],
            early_move_divergences: Vec::new(),
            retry_positions: Vec::new(),
        };
        let mut output = String::new();

        push_artifacts_json(&mut output, &artifacts);

        assert_eq!(
            output,
            r#"{"keyMoments":[],"evidence":[],"forkCandidates":[{"rank":2,"entryIndex":4,"ply":5,"sourceKind":"best-move-after-position","bestMove":"e5f7","movedPiece":{"color":"white","kind":"knight"},"destination":"f7","targets":[{"square":"d8","piece":{"color":"black","kind":"queen"}},{"square":"h8","piece":{"color":"black","kind":"rook"}}],"cpLoss":420,"label":"blunder"}],"earlyMoveDivergences":[],"retryPositions":[]}"#
        );
    }
}
