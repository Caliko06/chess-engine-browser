use chess_board::{
    Color, File, LegalMoveError, Move, Piece, PieceKind, Position, PositionStatus, Rank, Square,
};
pub use chess_eval::MoveQuality;
use chess_eval::{
    BISHOP_VALUE, KNIGHT_VALUE, PAWN_VALUE, QUEEN_VALUE, ROOK_VALUE, classify_win_percent_loss,
    evaluate, win_percent,
};
use core::fmt;
use std::collections::HashMap;

pub mod engine;
pub mod explore;
mod see;
pub mod skill;
pub use explore::{
    EXPLORE_SOUND_MARGIN_CP, ReplyCandidate, ReplyCandidateRole, SacrificeAftermath,
    SideExploreCandidate, SideExploreReport,
};
pub use see::{
    HANGING_MATERIAL_THRESHOLD, move_hangs_material, move_leaves_piece_hanging,
    static_exchange_eval,
};

pub const MAX_M8_DEPTH: u8 = 6;
/// Hard ceiling for the play engine's iterative deepening. Decoupled from [`MAX_M8_DEPTH`],
/// which stays the fixed-depth window the reaction/forcing lenses rely on, so play can look
/// far deeper without disturbing lens semantics. The wall-clock budget is the real limiter;
/// this only bounds the loop and sizes the killer table.
pub const MAX_PLAY_DEPTH: u8 = 32;
pub const MATE_SCORE: i32 = 30_000;
/// Maximum number of plies exposed in a projected reaction line.
pub const MAX_REACTION_LINE_PLIES: u8 = MAX_M8_DEPTH;
/// Starting depth for projecting the deep lens's principal line. The deep value lives in the
/// candidate scores; the line is only an illustrative preview, so it is projected with a cheaper
/// fixed search (decreasing from here) rather than the full M8 depth.
const DEEP_PV_PROJECTION_DEPTH: u8 = 4;
const FUTILITY_FRONTIER_DEPTH: u8 = 1;
const FUTILITY_MARGIN: i32 = KNIGHT_VALUE;
const LMR_MIN_DEPTH: u8 = 2;
const LMR_SEARCHED_MOVE_THRESHOLD: usize = 2;
const LMR_DEPTH_REDUCTION: u8 = 1;
const MAX_QUIESCENCE_PLY: u8 = 16;
const QUIESCENCE_DELTA_MARGIN: i32 = 200;
const QUIESCENCE_BUDGET_DENOMINATOR: u64 = 2;
const MAX_EXTENSION_PLY: u8 = 4;
// Sized so the killer table covers every reachable ply (deepest iteration plus extensions).
const MAX_SEARCH_PLY: usize = MAX_PLAY_DEPTH as usize + MAX_EXTENSION_PLY as usize + 1;
const KILLER_MOVE_SLOTS: usize = 2;
/// Smallest score magnitude that still encodes a forced mate within the play search horizon.
/// Used both to gate LMR/futility near mate bounds and to stop iterative deepening early once a
/// decisive mate is proven.
const PLAY_MATE_THRESHOLD: i32 =
    MATE_SCORE - (MAX_PLAY_DEPTH as i32 + MAX_EXTENSION_PLY as i32 + MAX_QUIESCENCE_PLY as i32 + 1);

/// Move-ordering bands (higher is searched first). Captures sit above every quiet move so the
/// principal tactical lines are explored before stand-pat shuffles, which is what makes the
/// alpha-beta pruning actually bite.
const ORDER_TT_MOVE: i32 = 1_000_000;
const ORDER_CAPTURE_BASE: i32 = 100_000;
const ORDER_KILLER_PRIMARY: i32 = 90_000;
const ORDER_KILLER_SECONDARY: i32 = 80_000;
/// History scores are clamped below the killer band so a well-trodden quiet move can never
/// outrank a killer or a capture.
const ORDER_HISTORY_CEILING: i32 = ORDER_KILLER_SECONDARY - 1;
const BOARD_SQUARES: usize = 64;
const PROMOTION_VARIANTS: usize = 5;
const HISTORY_TABLE_SIZE: usize = BOARD_SQUARES * BOARD_SQUARES * PROMOTION_VARIANTS;
const FILES: [File; 8] = [
    File::A,
    File::B,
    File::C,
    File::D,
    File::E,
    File::F,
    File::G,
    File::H,
];
const RANKS: [Rank; 8] = [
    Rank::First,
    Rank::Second,
    Rank::Third,
    Rank::Fourth,
    Rank::Fifth,
    Rank::Sixth,
    Rank::Seventh,
    Rank::Eighth,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SearchConfig {
    pub max_depth: u8,
}

/// Limits for the play engine's iterative-deepening search.
///
/// `max_depth` caps the deepening loop (clamped to [`MAX_PLAY_DEPTH`]); `node_budget` is the total
/// interior-node allowance that actually decides when to stop. A node budget rather than a wall
/// clock keeps the engine deterministic, dependency-free, and clear of any foreign-function clock
/// import the project's hardening policy forbids — on a given host it tracks wall time closely
/// enough to serve as the "think for about a second" control. With `node_budget: None` the search
/// runs to `max_depth` unbounded, which is what the deterministic tests use.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SearchLimits {
    pub max_depth: u8,
    pub node_budget: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SearchResult {
    pub best_move: Option<Move>,
    pub score: i32,
    pub depth: u8,
    pub nodes: u64,
    pub tt_hits: u64,
}

/// A scored root move for the live reaction map.
///
/// `score` is an exact horizon minimax value from the perspective of the side to move at the
/// searched position (higher is better for that side). Each candidate is searched with a full
/// window so its score is not an alpha-beta bound shared across siblings.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReactionCandidate {
    pub mv: Move,
    pub score: i32,
    /// Whether the move leaves its piece hanging on the destination square — a static, depth-
    /// independent material check (see [`move_hangs_material`]). The lens colours such a candidate
    /// as a blunder even when it is the top-scored move, which the relative-score signal cannot do.
    pub hangs_material: bool,
    /// Forced-mate distance in full moves when this move forces mate *for the side playing it*
    /// (`Some(1)` delivers mate now, `Some(2)` mates next move), or `None` when the move is not a
    /// winning forced mate. Derived from the mate-magnitude score, so it only reports mates the
    /// search actually proved within its depth. The lens paints the imminent ones a distinct colour.
    pub mate_in: Option<u8>,
    /// Move-quality label for the arrow: the centipawn-loss band against the best candidate, with
    /// the top move upgraded to [`MoveQuality::Brilliant`] (a sound material sacrifice) or
    /// [`MoveQuality::Great`] (a uniquely critical move). Populated by [`annotate_candidates`].
    pub quality: MoveQuality,
}

/// Engine-backed reaction lines for a position: scored root candidates plus a projected principal
/// line. `mate_detected` is set only when the projected line reaches a checkmate position; it is
/// never inferred from a mate-magnitude score alone.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReactionLines {
    pub candidates: Vec<ReactionCandidate>,
    pub principal_line: Vec<Move>,
    pub mate_detected: bool,
    pub depth: u8,
    pub nodes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchError {
    InvalidDepth,
    InvalidPosition,
}

impl fmt::Display for SearchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDepth => formatter.write_str("search depth is outside the M8 range"),
            Self::InvalidPosition => formatter.write_str("position cannot be searched"),
        }
    }
}

impl std::error::Error for SearchError {}

impl From<LegalMoveError> for SearchError {
    fn from(_error: LegalMoveError) -> Self {
        Self::InvalidPosition
    }
}

pub fn search(position: &Position, config: SearchConfig) -> Result<SearchResult, SearchError> {
    if !(1..=MAX_M8_DEPTH).contains(&config.max_depth) {
        return Err(SearchError::InvalidDepth);
    }

    let root_side = position.side_to_move();
    let status = position.status()?;
    if position_is_static_draw(position) {
        return Ok(SearchResult {
            best_move: None,
            score: 0,
            depth: config.max_depth,
            nodes: 1,
            tt_hits: 0,
        });
    }
    if status != PositionStatus::Ongoing {
        return Ok(SearchResult {
            best_move: None,
            score: terminal_score(position, root_side, 0)?,
            depth: config.max_depth,
            nodes: 1,
            tt_hits: 0,
        });
    }

    let mut search_state = SearchState::default();
    search_state.set_root(position);
    let mut best_move = None;
    let mut best_score = i32::MIN;
    let mut nodes = 0_u64;
    let mut tt_hits = 0_u64;
    let mut alpha = i32::MIN + 1;
    let beta = i32::MAX;

    for mv in legal_moves_or_invalid(position)? {
        let child = position.after_known_legal_move(mv)?;
        let (score, child_nodes, child_tt_hits) = alpha_beta(
            &child,
            config.max_depth - 1,
            1,
            root_side,
            alpha,
            beta,
            &mut search_state,
        )?;
        nodes = nodes.saturating_add(child_nodes);
        tt_hits = tt_hits.saturating_add(child_tt_hits);
        if score > best_score {
            best_score = score;
            best_move = Some(mv);
        }
        alpha = alpha.max(best_score);
    }

    Ok(SearchResult {
        best_move,
        score: best_score,
        depth: config.max_depth,
        nodes,
        tt_hits,
    })
}

/// Order root moves with the previous iteration's best move first, then the shared ordering.
fn order_root_moves(
    moves: &mut [Move],
    position: &Position,
    previous_best: Option<Move>,
    ordering: &MoveOrdering,
) {
    moves.sort_by(|left, right| {
        ordering
            .move_order_key(position, 0, previous_best, *right)
            .cmp(&ordering.move_order_key(position, 0, previous_best, *left))
            .then_with(|| left.cmp(right))
    });
}

/// One root pass at `depth` that scores *every* legal move and returns them sorted best-first.
///
/// Unlike [`search_root_once`] (which keeps only the best move), this keeps the whole candidate
/// list for the deep lens. It shares a rising alpha across siblings for speed, so only the best
/// score is exact — the rest are alpha-beta bounds, deliberately traded for reaching real depth.
fn score_root_candidates(
    position: &Position,
    root_side: Color,
    depth: u8,
    previous_best: Option<Move>,
    search_state: &mut SearchState,
) -> Result<(Vec<ReactionCandidate>, u64), SearchError> {
    search_state.set_root(position);
    let mut moves = legal_moves_or_invalid(position)?;
    order_root_moves(
        &mut moves,
        position,
        previous_best,
        &search_state.move_ordering,
    );

    let mut alpha = i32::MIN + 1;
    let beta = i32::MAX;
    let mut nodes = 0_u64;
    let mut candidates = Vec::new();
    for mv in moves {
        let child = position.after_known_legal_move(mv)?;
        let extension = move_extension(position, mv, 0);
        let child_depth = (depth - 1).saturating_add(extension);
        let (score, child_nodes, _child_tt_hits) = alpha_beta_with_extensions(
            &child,
            child_depth,
            1,
            root_side,
            SearchWindow { alpha, beta },
            extension,
            search_state,
        )?;
        nodes = nodes.saturating_add(child_nodes);
        if search_state.aborted {
            break;
        }
        candidates.push(ReactionCandidate {
            mv,
            score,
            hangs_material: false,
            mate_in: None,
            quality: MoveQuality::Best,
        });
        alpha = alpha.max(score);
    }
    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.mv.cmp(&right.mv))
    });
    Ok((candidates, nodes))
}

/// Iterative-deepening root search for the deep lens: scores every root move to the deepest depth
/// the node budget allows, returning the sorted candidate list, the depth reached, and the node
/// count. Mirrors [`search_best`]'s loop (depth 1 unbounded, discard an aborted iteration, stop
/// early on a decisive mate) but keeps the full candidate list instead of only the best move.
fn deep_root_candidates(
    position: &Position,
    limits: SearchLimits,
) -> Result<(Vec<ReactionCandidate>, u8, u64), SearchError> {
    let mut search_state = SearchState::default();
    deep_root_candidates_with_state(position, limits, &mut search_state)
}

fn deep_root_candidates_with_state(
    position: &Position,
    limits: SearchLimits,
    search_state: &mut SearchState,
) -> Result<(Vec<ReactionCandidate>, u8, u64), SearchError> {
    search_state.reset_search_budget_state(limits.node_budget);
    let root_side = position.side_to_move();
    let max_depth = limits.max_depth.clamp(1, MAX_PLAY_DEPTH);
    // No interior TT reuse: this candidate set and its ranking feed the Explore/reaction surfaces
    // and the gate's anchor selection, and even ordering-seed noise was measured to surface gift
    // moves as off-turn "threats" (ADR-0163 F4.1 containment).
    let mut candidates: Vec<ReactionCandidate> = Vec::new();
    let mut completed_depth = 0_u8;
    let mut nodes = 0_u64;
    let mut previous_best: Option<Move> = None;

    for depth in 1..=max_depth {
        search_state.set_depth_node_budget(if depth >= 2 { limits.node_budget } else { None });
        search_state.aborted = false;
        let (iteration, iteration_nodes) =
            score_root_candidates(position, root_side, depth, previous_best, search_state)?;
        nodes = nodes.saturating_add(iteration_nodes);
        if search_state.aborted {
            break;
        }
        candidates = iteration;
        completed_depth = depth;
        previous_best = candidates.first().map(|candidate| candidate.mv);
        if candidates
            .first()
            .is_some_and(|candidate| candidate.score.abs() >= PLAY_MATE_THRESHOLD)
        {
            break;
        }
        if limits
            .node_budget
            .is_some_and(|budget| search_state.node_counter >= budget)
        {
            break;
        }
    }

    Ok((candidates, completed_depth.max(1), nodes))
}

/// Compute engine-backed reaction lines for `position`: every legal root move scored with a full
/// window, plus a projected principal line reconstructed from real best-move search.
///
/// Candidates are sorted by score descending (ties broken by coordinate for determinism). The
/// projected line's first move equals the top candidate. `mate_detected` is true only when the
/// projected line reaches a checkmate position within the depth budget.
/// Fills in each candidate's derived annotations on the final candidate list: the static exchange
/// hanging check on the move's destination, and the forced-mate distance read off the score. Runs
/// once (not inside the scoring loop), so the extra cost is one cheap static pass per lens update
/// regardless of search depth.
fn annotate_candidates(position: &Position, candidates: &mut [ReactionCandidate]) {
    for candidate in candidates.iter_mut() {
        candidate.hangs_material = move_hangs_material(position, candidate.mv);
        candidate.mate_in = host_mate_in_moves(candidate.score);
    }
    classify_candidate_quality(candidates);
}

/// Smallest win-percent edge over the second-best move for the top move to count as
/// [`MoveQuality::Great`]: a uniquely critical move whose alternatives clearly drop the outcome.
const GREAT_SECOND_BEST_GAP: f64 = 10.0;
/// A sound sacrifice is only [`MoveQuality::Brilliant`] while the side is not already comfortably
/// winning without it; above this win percentage the move is merely the best, not surprising.
pub(crate) const BRILLIANT_ALREADY_WINNING: f64 = 95.0;
/// ...and only while the sacrifice still keeps the side at least equal afterwards (chess.com's "you
/// should not be in a bad position after" condition).
pub(crate) const BRILLIANT_STILL_OK: f64 = 50.0;

/// Assign each sorted candidate its [`MoveQuality`]: the win-percent-loss band against the best
/// candidate, then an upgrade of the top move to Brilliant or Great. Candidates must already be
/// sorted best-first with `hangs_material` populated.
fn classify_candidate_quality(candidates: &mut [ReactionCandidate]) {
    let Some(best_cp) = candidates.first().map(|candidate| candidate.score) else {
        return;
    };
    for candidate in candidates.iter_mut() {
        candidate.quality = classify_win_percent_loss(best_cp, candidate.score);
    }
    refine_top_quality(candidates);
}

/// Upgrade the top candidate to [`MoveQuality::Brilliant`] when it is a sound material sacrifice (it
/// hangs material by the static exchange check yet keeps the side between equal and not-already-
/// winning), or to [`MoveQuality::Great`] when it is the lone critical move — a non-sacrifice whose
/// win percentage clears the second-best by [`GREAT_SECOND_BEST_GAP`]. Otherwise the top move keeps
/// its band (`Best`, since it loses nothing against itself).
fn refine_top_quality(candidates: &mut [ReactionCandidate]) {
    let Some(top) = candidates.first() else {
        return;
    };
    let best_win = win_percent(top.score);
    let best_hangs = top.hangs_material;
    let second_win = candidates
        .get(1)
        .map(|candidate| win_percent(candidate.score));

    let upgraded =
        if best_hangs && (BRILLIANT_STILL_OK..BRILLIANT_ALREADY_WINNING).contains(&best_win) {
            Some(MoveQuality::Brilliant)
        } else if !best_hangs
            && second_win.is_some_and(|second| best_win - second >= GREAT_SECOND_BEST_GAP)
        {
            Some(MoveQuality::Great)
        } else {
            None
        };

    if let Some(quality) = upgraded {
        candidates[0].quality = quality;
    }
}

pub fn reaction_lines(
    position: &Position,
    config: SearchConfig,
) -> Result<ReactionLines, SearchError> {
    if !(1..=MAX_M8_DEPTH).contains(&config.max_depth) {
        return Err(SearchError::InvalidDepth);
    }

    let root_side = position.side_to_move();
    let status = position.status()?;
    if position_is_static_draw(position) || status != PositionStatus::Ongoing {
        return Ok(ReactionLines {
            candidates: Vec::new(),
            principal_line: Vec::new(),
            mate_detected: status == PositionStatus::Checkmate,
            depth: config.max_depth,
            nodes: 1,
        });
    }

    let mut search_state = SearchState::default();
    search_state.set_root(position);
    let mut nodes = 0_u64;
    let mut candidates = Vec::new();
    for mv in legal_moves_or_invalid(position)? {
        let child = position.after_known_legal_move(mv)?;
        let (score, child_nodes, _child_tt_hits) = alpha_beta(
            &child,
            config.max_depth - 1,
            1,
            root_side,
            i32::MIN + 1,
            i32::MAX,
            &mut search_state,
        )?;
        nodes = nodes.saturating_add(child_nodes);
        candidates.push(ReactionCandidate {
            mv,
            score,
            hangs_material: false,
            mate_in: None,
            quality: MoveQuality::Best,
        });
    }
    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.mv.cmp(&right.mv))
    });

    annotate_candidates(position, &mut candidates);

    let mut principal_line = Vec::new();
    let mut mate_detected = false;
    if let Some(best) = candidates.first() {
        principal_line.push(best.mv);
        let mut current = position.after_known_legal_move(best.mv)?;
        let mut remaining = config.max_depth - 1;
        loop {
            let current_status = current.status_trusted();
            if current_status != PositionStatus::Ongoing {
                mate_detected = current_status == PositionStatus::Checkmate;
                break;
            }
            if remaining < 1 || principal_line.len() >= usize::from(MAX_REACTION_LINE_PLIES) {
                break;
            }
            let continuation = search(
                &current,
                SearchConfig {
                    max_depth: remaining,
                },
            )?;
            nodes = nodes.saturating_add(continuation.nodes);
            let Some(next) = continuation.best_move else {
                break;
            };
            principal_line.push(next);
            current = current.after_known_legal_move(next)?;
            remaining -= 1;
        }
    }

    Ok(ReactionLines {
        candidates,
        principal_line,
        mate_detected,
        depth: config.max_depth,
        nodes,
    })
}

/// Deep ("ultra-instinct") reaction lines: the same candidate map and projected line as
/// [`reaction_lines`], but scored by an iterative-deepening root search under `limits.node_budget`
/// instead of a fixed shallow depth, so it reaches grandmaster depth in roughly a second. The best
/// candidate and the `depth` reached are exact; lower candidates' scores are alpha-beta bounds (see
/// [`score_root_candidates`]). The projected line is seeded by the deep best move and then extended
/// with the fast fixed-depth search, which keeps the projection cheap.
pub fn reaction_lines_deep(
    position: &Position,
    limits: SearchLimits,
) -> Result<ReactionLines, SearchError> {
    let status = position.status()?;
    let reported_depth = limits.max_depth.clamp(1, MAX_PLAY_DEPTH);
    if status != PositionStatus::Ongoing {
        return Ok(ReactionLines {
            candidates: Vec::new(),
            principal_line: Vec::new(),
            mate_detected: status == PositionStatus::Checkmate,
            depth: reported_depth,
            nodes: 1,
        });
    }

    let (mut candidates, depth, mut nodes) = deep_root_candidates(position, limits)?;
    annotate_candidates(position, &mut candidates);

    let mut principal_line = Vec::new();
    let mut mate_detected = false;
    if let Some(best) = candidates.first() {
        principal_line.push(best.mv);
        let mut current = position.after_known_legal_move(best.mv)?;
        // Project the line with the fast fixed search at decreasing depth, seeded by the deep best
        // move. A modest starting depth keeps the projection cheap (one full M8 search per ply
        // would dominate the whole lens).
        let mut remaining = DEEP_PV_PROJECTION_DEPTH;
        loop {
            let current_status = current.status_trusted();
            if current_status != PositionStatus::Ongoing {
                mate_detected = current_status == PositionStatus::Checkmate;
                break;
            }
            if remaining < 1 || principal_line.len() >= usize::from(MAX_REACTION_LINE_PLIES) {
                break;
            }
            let continuation = search(
                &current,
                SearchConfig {
                    max_depth: remaining,
                },
            )?;
            nodes = nodes.saturating_add(continuation.nodes);
            let Some(next) = continuation.best_move else {
                break;
            };
            principal_line.push(next);
            current = current.after_known_legal_move(next)?;
            remaining -= 1;
        }
    }

    Ok(ReactionLines {
        candidates,
        principal_line,
        mate_detected,
        depth,
        nodes,
    })
}

/// Forcing classification for a single root move.
///
/// `Mate` is a move that leads to a forced mate within the depth budget. `Check` covers any move
/// that gives check (including checking captures), `Capture` covers the remaining captures, and
/// `Defense` covers every quiet move. The kind alone does not decide ordering: see
/// [`ForcingCandidate::tier`], which only promotes a check or capture above quiet moves when it is
/// *sound* (does not hang material relative to the best available option).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ForcingKind {
    Mate,
    Check,
    Capture,
    Defense,
}

/// A classified, scored root move for the forcing lens.
///
/// `score` is the host's full-window minimax value after the move (higher is better for the host)
/// and already accounts for the opponent's best reply. `sound` is true when the move does not fall
/// more than [`FORCING_SOUNDNESS_MARGIN`] below the best non-mating option, so a check or capture
/// that hangs material without compensation is flagged unsound and ranked below sound development.
/// `mate_in` is the host's forced-mate distance in full moves when `kind` is `Mate`, otherwise
/// `None`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ForcingCandidate {
    pub mv: Move,
    pub kind: ForcingKind,
    pub score: i32,
    pub sound: bool,
    pub mate_in: Option<u8>,
}

impl ForcingCandidate {
    /// Ordering tier (lower is shown first): a forced mate, then sound forcing moves (check before
    /// capture), then sound quiet moves, then speculative forcing moves that lose material without
    /// compensation, and finally speculative quiet moves. This is what keeps the lens from blindly
    /// surfacing a check that hangs the position just because it is a check.
    const fn tier(self) -> u8 {
        if matches!(self.kind, ForcingKind::Mate) {
            return 0;
        }
        match (self.sound, self.kind) {
            (true, ForcingKind::Check) => 1,
            (true, ForcingKind::Capture) => 2,
            (true, ForcingKind::Defense) => 3,
            (false, ForcingKind::Check) => 5,
            (false, ForcingKind::Capture) => 6,
            (false, ForcingKind::Defense) => 7,
            (_, ForcingKind::Mate) => 0,
        }
    }
}

/// The forcing lens report for a position from a chosen host side.
///
/// `on_turn` is false when it is not the host's move; in that case `candidates` is empty because
/// the lens only surfaces forcing options the host can play right now.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForcingReport {
    pub host: Color,
    pub on_turn: bool,
    pub candidates: Vec<ForcingCandidate>,
    pub depth: u8,
    pub nodes: u64,
}

/// Smallest positive score that still encodes a forced mate for the side to move, mirroring the
/// internal mate-window bound used by the search.
const POSITIVE_MATE_BOUND: i32 = MATE_SCORE - (MAX_M8_DEPTH as i32 + MAX_QUIESCENCE_PLY as i32 + 1);

/// How far below the best non-mating option a forcing move may fall and still count as "sound".
/// One pawn tolerates positional gambits while demoting checks or captures that hang material.
const FORCING_SOUNDNESS_MARGIN: i32 = PAWN_VALUE;

/// Converts a host-perspective root score into a forced-mate distance in full moves, or `None`
/// when the score is not a mate-magnitude value.
fn host_mate_in_moves(score: i32) -> Option<u8> {
    if score < POSITIVE_MATE_BOUND {
        return None;
    }
    let plies = (MATE_SCORE - score).max(1);
    Some(u8::try_from((plies + 1) / 2).unwrap_or(u8::MAX))
}

/// Classify and order the host's forcing options for `position`.
///
/// Candidates are sorted by [`ForcingCandidate::tier`] (forced mate, then sound checks/captures,
/// then sound quiet moves, then speculative forcing moves), then by shorter forced mate, then by
/// host score descending, then by coordinate for determinism. Soundness is measured against the
/// best non-mating option, so a check that hangs material without compensation drops below quiet
/// development instead of leading the list. A sacrifice only rises when the search — deeper at
/// higher `max_depth` — confirms it keeps the host's score. When it is not the host's turn the
/// report carries `on_turn: false` and no candidates.
pub fn forcing_moves(
    position: &Position,
    config: SearchConfig,
    host: Color,
) -> Result<ForcingReport, SearchError> {
    if !(1..=MAX_M8_DEPTH).contains(&config.max_depth) {
        return Err(SearchError::InvalidDepth);
    }

    if position.side_to_move() != host {
        return Ok(ForcingReport {
            host,
            on_turn: false,
            candidates: Vec::new(),
            depth: config.max_depth,
            nodes: 0,
        });
    }

    let status = position.status()?;
    if position_is_static_draw(position) || status != PositionStatus::Ongoing {
        return Ok(ForcingReport {
            host,
            on_turn: true,
            candidates: Vec::new(),
            depth: config.max_depth,
            nodes: 1,
        });
    }

    let mut search_state = SearchState::default();
    search_state.set_root(position);
    let mut nodes = 0_u64;
    let mut scored: Vec<(Move, ForcingKind, i32, Option<u8>)> = Vec::new();
    for mv in legal_moves_or_invalid(position)? {
        let child = position.after_known_legal_move(mv)?;
        let gives_check = child.is_check();
        let is_capture = position.is_capture(mv);
        let (score, child_nodes, _child_tt_hits) = alpha_beta(
            &child,
            config.max_depth - 1,
            1,
            host,
            i32::MIN + 1,
            i32::MAX,
            &mut search_state,
        )?;
        nodes = nodes.saturating_add(child_nodes);
        let mate_in = host_mate_in_moves(score);
        let kind = if mate_in.is_some() {
            ForcingKind::Mate
        } else if gives_check {
            ForcingKind::Check
        } else if is_capture {
            ForcingKind::Capture
        } else {
            ForcingKind::Defense
        };
        scored.push((mv, kind, score, mate_in));
    }

    Ok(ForcingReport {
        host,
        on_turn: true,
        candidates: assemble_forcing_candidates(scored),
        depth: config.max_depth,
        nodes,
    })
}

/// Build the ordered, soundness-classified forcing candidates from `(move, kind, score, mate_in)`
/// tuples. Shared by the fast and deep forcing lenses.
///
/// The soundness baseline is the best score reachable by a non-mating move: the value of the
/// position under best play that is not itself a forced mate. A forcing move is sound only when it
/// stays within one pawn of that baseline, which is what stops a material-hanging check from
/// outranking real development. Candidates are then ordered by [`ForcingCandidate::tier`], shorter
/// mate, score, and coordinate.
fn assemble_forcing_candidates(
    scored: Vec<(Move, ForcingKind, i32, Option<u8>)>,
) -> Vec<ForcingCandidate> {
    let baseline = scored
        .iter()
        .filter(|(_, _, _, mate_in)| mate_in.is_none())
        .map(|(_, _, score, _)| *score)
        .max()
        .unwrap_or(i32::MIN + 1);
    let sound_floor = baseline.saturating_sub(FORCING_SOUNDNESS_MARGIN);
    let mut candidates: Vec<ForcingCandidate> = scored
        .into_iter()
        .map(|(mv, kind, score, mate_in)| ForcingCandidate {
            mv,
            kind,
            score,
            sound: matches!(kind, ForcingKind::Mate) || score >= sound_floor,
            mate_in,
        })
        .collect();
    candidates.sort_by(|left, right| {
        left.tier()
            .cmp(&right.tier())
            .then_with(|| {
                left.mate_in
                    .unwrap_or(u8::MAX)
                    .cmp(&right.mate_in.unwrap_or(u8::MAX))
            })
            .then_with(|| right.score.cmp(&left.score))
            .then_with(|| left.mv.cmp(&right.mv))
    });
    candidates
}

/// Mate distance in full moves for a deep-search score, using the wider play-depth mate window
/// (deep search can prove mates beyond the fixed M8 horizon). Returns `None` for non-mate scores.
fn deep_mate_in_moves(score: i32) -> Option<u8> {
    if score < PLAY_MATE_THRESHOLD {
        return None;
    }
    let plies = (MATE_SCORE - score).max(1);
    Some(u8::try_from((plies + 1) / 2).unwrap_or(u8::MAX))
}

/// Deep ("ultra-instinct") forcing lens: classifies and ranks the host's forcing options like
/// [`forcing_moves`], but the per-move scores come from the iterative-deepening root search under
/// `limits.node_budget`, so it finds the best forcing shot / forced mate at grandmaster depth.
///
/// Because the deep root search shares a rising alpha, only the best line's score is exact; the
/// soundness flag on lower-ranked moves is therefore approximate. The fast lens
/// ([`forcing_moves`]) remains the exact classifier; this one trades that precision for depth.
pub fn forcing_moves_deep(
    position: &Position,
    limits: SearchLimits,
    host: Color,
) -> Result<ForcingReport, SearchError> {
    let reported_depth = limits.max_depth.clamp(1, MAX_PLAY_DEPTH);
    if position.side_to_move() != host {
        return Ok(ForcingReport {
            host,
            on_turn: false,
            candidates: Vec::new(),
            depth: reported_depth,
            nodes: 0,
        });
    }
    if position.status()? != PositionStatus::Ongoing {
        return Ok(ForcingReport {
            host,
            on_turn: true,
            candidates: Vec::new(),
            depth: reported_depth,
            nodes: 1,
        });
    }

    let (scored_candidates, depth, nodes) = deep_root_candidates(position, limits)?;
    let mut scored: Vec<(Move, ForcingKind, i32, Option<u8>)> =
        Vec::with_capacity(scored_candidates.len());
    for candidate in &scored_candidates {
        let child = position.after_known_legal_move(candidate.mv)?;
        let mate_in = deep_mate_in_moves(candidate.score);
        let kind = if mate_in.is_some() {
            ForcingKind::Mate
        } else if child.is_check() {
            ForcingKind::Check
        } else if position.is_capture(candidate.mv) {
            ForcingKind::Capture
        } else {
            ForcingKind::Defense
        };
        scored.push((candidate.mv, kind, candidate.score, mate_in));
    }

    Ok(ForcingReport {
        host,
        on_turn: true,
        candidates: assemble_forcing_candidates(scored),
        depth,
        nodes,
    })
}

/// Exact value of a leaf or terminal node, reusable by any visit that needs no more depth.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TtEntry {
    depth_remaining: u8,
    score: i32,
}

struct MoveOrdering {
    killer_moves: [[Option<Move>; KILLER_MOVE_SLOTS]; MAX_SEARCH_PLY],
    history_scores: [[i32; HISTORY_TABLE_SIZE]; 2],
}

impl Default for MoveOrdering {
    fn default() -> Self {
        Self {
            killer_moves: [[None; KILLER_MOVE_SLOTS]; MAX_SEARCH_PLY],
            history_scores: [[0; HISTORY_TABLE_SIZE]; 2],
        }
    }
}

#[derive(Default)]
struct SearchState {
    tt: HashMap<u64, TtEntry>,
    move_ordering: MoveOrdering,
    /// Total interior-node allowance for this search. `None` disables the budget entirely, which is
    /// what the fixed-depth `search()` and the lenses use so they stay exhaustive and deterministic.
    node_budget: Option<u64>,
    /// Counts interior nodes entered, compared against `node_budget` to decide when to abort.
    node_counter: u64,
    /// Remaining q-node allowance for the current budgeted search.
    quiescence_node_budget_remaining: Option<u64>,
    /// Set once the budget is exhausted; every subsequent interior node returns immediately.
    aborted: bool,
    /// Ancestor hashes for the currently searched root-to-node line. Repetition scores are
    /// path-dependent, so they are read from here and never cached in the TT.
    path_hashes: Vec<u64>,
}

impl SearchState {
    fn set_root(&mut self, position: &Position) {
        self.path_hashes.clear();
        self.path_hashes.push(position.zobrist_hash());
    }

    fn reset_search_budget_state(&mut self, node_budget: Option<u64>) {
        self.quiescence_node_budget_remaining =
            node_budget.map(|budget| budget / QUIESCENCE_BUDGET_DENOMINATOR);
    }

    fn set_depth_node_budget(&mut self, node_budget: Option<u64>) {
        self.node_budget = node_budget;
        if node_budget.is_none() {
            return;
        }
        if self.quiescence_node_budget_remaining.is_none() {
            self.quiescence_node_budget_remaining = node_budget.map(|budget| {
                budget.saturating_sub(self.node_counter) / QUIESCENCE_BUDGET_DENOMINATOR
            });
        }
    }

    fn ensure_quiescence_budget(&mut self) {
        if self.node_budget.is_some() && self.quiescence_node_budget_remaining.is_none() {
            self.quiescence_node_budget_remaining = self.node_budget.map(|budget| {
                budget.saturating_sub(self.node_counter) / QUIESCENCE_BUDGET_DENOMINATOR
            });
        }
    }

    fn trip_quiescence_budget_if_exhausted(&mut self) -> bool {
        let Some(remaining) = self.quiescence_node_budget_remaining.as_mut() else {
            return false;
        };
        if *remaining == 0 {
            return true;
        }
        *remaining = remaining.saturating_sub(1);
        false
    }

    fn repetition_draw(&self, hash: u64) -> bool {
        self.path_hashes
            .iter()
            .filter(|entry| **entry == hash)
            .count()
            >= 2
    }
}

fn position_is_static_draw(position: &Position) -> bool {
    position.is_fifty_move_draw() || position.has_insufficient_material()
}

#[derive(Clone, Copy)]
struct SearchWindow {
    alpha: i32,
    beta: i32,
}

#[derive(Clone, Copy)]
struct RegularMoveContext {
    depth_remaining: u8,
    root_side: Color,
    alpha: i32,
    beta: i32,
    maximizing: bool,
    searched_move_count: usize,
}

#[derive(Clone, Copy)]
struct QuiescenceChildContext {
    root_side: Color,
    ply_from_root: u8,
    quiescence_ply: u8,
    parent_in_check: bool,
}

impl MoveOrdering {
    #[cfg(test)]
    fn ordered_legal_moves(
        &self,
        position: &Position,
        ply_from_root: u8,
        seed_move: Option<Move>,
    ) -> Result<Vec<Move>, SearchError> {
        let mut moves = legal_moves_or_invalid(position)?;
        self.order_moves(position, ply_from_root, seed_move, &mut moves);
        Ok(moves)
    }

    /// Sorts an already generated legal move list in search order (see [`Self::move_order_key`]).
    fn order_moves(
        &self,
        position: &Position,
        ply_from_root: u8,
        seed_move: Option<Move>,
        moves: &mut [Move],
    ) {
        moves.sort_by(|left, right| {
            self.move_order_key(position, ply_from_root, seed_move, *right)
                .cmp(&self.move_order_key(position, ply_from_root, seed_move, *left))
                .then_with(|| left.cmp(right))
        });
    }

    /// Single ordering score (higher is searched first): the seeded best move, then captures by
    /// MVV-LVA, then killers, then quiet moves by history. Captures always outrank quiet moves,
    /// which is the fix that lets alpha-beta prune effectively.
    fn move_order_key(
        &self,
        position: &Position,
        ply_from_root: u8,
        seed_move: Option<Move>,
        mv: Move,
    ) -> i32 {
        if seed_move == Some(mv) {
            return ORDER_TT_MOVE;
        }
        if captured_piece(position, mv).is_some() {
            return ORDER_CAPTURE_BASE + capture_order_score(position, mv);
        }
        match self.killer_rank(ply_from_root, mv) {
            2 => ORDER_KILLER_PRIMARY,
            1 => ORDER_KILLER_SECONDARY,
            _ => self
                .history_score(position.side_to_move(), mv)
                .min(ORDER_HISTORY_CEILING),
        }
    }

    fn killer_rank(&self, ply_from_root: u8, mv: Move) -> u8 {
        let Some(killers) = self.killer_moves.get(usize::from(ply_from_root)) else {
            return 0;
        };
        if killers[0] == Some(mv) {
            2
        } else if killers[1] == Some(mv) {
            1
        } else {
            0
        }
    }

    fn history_score(&self, side_to_move: Color, mv: Move) -> i32 {
        self.history_scores[color_index(side_to_move)][move_history_index(mv)]
    }

    fn record_beta_cutoff(
        &mut self,
        position: &Position,
        mv: Move,
        depth_remaining: u8,
        ply_from_root: u8,
    ) {
        if captured_piece(position, mv).is_some() {
            return;
        }

        self.record_killer(ply_from_root, mv);
        self.record_history(position.side_to_move(), mv, depth_remaining);
    }

    fn record_killer(&mut self, ply_from_root: u8, mv: Move) {
        let Some(killers) = self.killer_moves.get_mut(usize::from(ply_from_root)) else {
            return;
        };
        if killers[0] == Some(mv) {
            return;
        }
        if killers[1] == Some(mv) {
            killers[1] = killers[0];
            killers[0] = Some(mv);
            return;
        }
        killers[1] = killers[0];
        killers[0] = Some(mv);
    }

    fn record_history(&mut self, side_to_move: Color, mv: Move, depth_remaining: u8) {
        let history_entry =
            &mut self.history_scores[color_index(side_to_move)][move_history_index(mv)];
        *history_entry = history_entry.saturating_add(history_bonus(depth_remaining));
    }
}

fn alpha_beta(
    position: &Position,
    depth_remaining: u8,
    ply_from_root: u8,
    root_side: Color,
    alpha: i32,
    beta: i32,
    search_state: &mut SearchState,
) -> Result<(i32, u64, u64), SearchError> {
    alpha_beta_with_extensions(
        position,
        depth_remaining,
        ply_from_root,
        root_side,
        SearchWindow { alpha, beta },
        0,
        search_state,
    )
}

fn alpha_beta_with_extensions(
    position: &Position,
    depth_remaining: u8,
    ply_from_root: u8,
    root_side: Color,
    window: SearchWindow,
    extension_plies: u8,
    search_state: &mut SearchState,
) -> Result<(i32, u64, u64), SearchError> {
    let mut alpha = window.alpha;
    let mut beta = window.beta;
    if search_state.aborted {
        return Ok((0, 0, 0));
    }
    search_state.node_counter = search_state.node_counter.saturating_add(1);
    if search_state
        .node_budget
        .is_some_and(|budget| search_state.node_counter > budget)
    {
        search_state.aborted = true;
        return Ok((0, 0, 0));
    }
    let hash = position.zobrist_hash();
    if position_is_static_draw(position) || search_state.repetition_draw(hash) {
        return Ok((0, 1, 0));
    }
    if let Some(entry) = search_state.tt.get(&hash).copied()
        && entry.depth_remaining >= depth_remaining
    {
        return Ok((entry.score, 0, 1));
    }

    // The node's only legal move generation: an empty list is the terminal check (mate when in
    // check, stalemate otherwise), and the same list feeds quiescence or the move loop below.
    let mut moves = position.legal_moves_trusted();
    if moves.is_empty() {
        if is_in_check(position, position.side_to_move()) {
            return Ok((mated_score(position, root_side, ply_from_root), 1, 0));
        }
        cache_exact_tt_entry(search_state, hash, depth_remaining, 0);
        return Ok((0, 1, 0));
    }

    if depth_remaining == 0 {
        if !is_in_check(position, position.side_to_move())
            && !moves
                .iter()
                .any(|mv| captured_piece(position, *mv).is_some())
        {
            let score = static_score(position, root_side);
            cache_exact_tt_entry(search_state, hash, depth_remaining, score);
            return Ok((score, 1, 0));
        }
        let (score, q_nodes) = quiescence_with_legal_moves(
            position,
            root_side,
            ply_from_root,
            SearchWindow { alpha, beta },
            0,
            Some(moves),
            search_state,
        )?;
        search_state.node_counter = search_state.node_counter.saturating_add(q_nodes);
        if search_state
            .node_budget
            .is_some_and(|budget| search_state.node_counter > budget)
        {
            search_state.aborted = true;
        }
        return Ok((score, q_nodes, 0));
    }

    search_state
        .move_ordering
        .order_moves(position, ply_from_root, None, &mut moves);
    let maximizing = position.side_to_move() == root_side;
    let mut nodes = 0_u64;
    let mut tt_hits = 0_u64;

    if maximizing {
        let mut best = i32::MIN;
        let mut searched_move_count = 0_usize;
        for mv in moves {
            let child = position.after_known_legal_move(mv)?;
            if should_prune_regular_move(
                position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining,
                    root_side,
                    alpha,
                    beta,
                    maximizing,
                    searched_move_count,
                },
                extension_plies,
            )? {
                continue;
            }
            let (score, child_nodes, child_tt_hits) = search_regular_child(
                position,
                &child,
                mv,
                ply_from_root,
                RegularMoveContext {
                    depth_remaining,
                    root_side,
                    alpha,
                    beta,
                    maximizing,
                    searched_move_count,
                },
                extension_plies,
                search_state,
            )?;
            searched_move_count = searched_move_count.saturating_add(1);
            nodes = nodes.saturating_add(child_nodes);
            tt_hits = tt_hits.saturating_add(child_tt_hits);
            best = best.max(score);
            alpha = alpha.max(best);
            if beta <= alpha {
                search_state.move_ordering.record_beta_cutoff(
                    position,
                    mv,
                    depth_remaining,
                    ply_from_root,
                );
                break;
            }
        }
        Ok((best, nodes, tt_hits))
    } else {
        let mut best = i32::MAX;
        let mut searched_move_count = 0_usize;
        for mv in moves {
            let child = position.after_known_legal_move(mv)?;
            if should_prune_regular_move(
                position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining,
                    root_side,
                    alpha,
                    beta,
                    maximizing,
                    searched_move_count,
                },
                extension_plies,
            )? {
                continue;
            }
            let (score, child_nodes, child_tt_hits) = search_regular_child(
                position,
                &child,
                mv,
                ply_from_root,
                RegularMoveContext {
                    depth_remaining,
                    root_side,
                    alpha,
                    beta,
                    maximizing,
                    searched_move_count,
                },
                extension_plies,
                search_state,
            )?;
            searched_move_count = searched_move_count.saturating_add(1);
            nodes = nodes.saturating_add(child_nodes);
            tt_hits = tt_hits.saturating_add(child_tt_hits);
            best = best.min(score);
            beta = beta.min(best);
            if beta <= alpha {
                search_state.move_ordering.record_beta_cutoff(
                    position,
                    mv,
                    depth_remaining,
                    ply_from_root,
                );
                break;
            }
        }
        Ok((best, nodes, tt_hits))
    }
}

/// Leaf evaluation from `root_side`'s perspective.
fn static_score(position: &Position, root_side: Color) -> i32 {
    match root_side {
        Color::White => evaluate(position),
        Color::Black => -evaluate(position),
    }
}

fn terminal_score(
    position: &Position,
    root_side: Color,
    ply_from_root: u8,
) -> Result<i32, SearchError> {
    match position.status_trusted() {
        PositionStatus::Ongoing => Ok(static_score(position, root_side)),
        PositionStatus::Stalemate => Ok(0),
        PositionStatus::Checkmate => Ok(mated_score(position, root_side, ply_from_root)),
    }
}

/// Score of a position whose side to move is checkmated, from `root_side`'s perspective.
fn mated_score(position: &Position, root_side: Color, ply_from_root: u8) -> i32 {
    let score = MATE_SCORE - i32::from(ply_from_root);
    if position.side_to_move() == root_side {
        -score
    } else {
        score
    }
}

fn cache_exact_tt_entry(
    search_state: &mut SearchState,
    hash: u64,
    depth_remaining: u8,
    score: i32,
) {
    search_state.tt.insert(
        hash,
        TtEntry {
            depth_remaining,
            score,
        },
    );
}

/// A move that drives a pawn to the brink of promotion: an actual promotion, or a pawn stepping onto
/// the rank one short of promoting. Either side's promotion press qualifies — the danger is the queen
/// that appears, whoever owns the pawn.
fn is_promotion_press(position: &Position, mv: Move) -> bool {
    let Some(piece) = position.piece_at(mv.from()) else {
        return false;
    };
    if piece.kind() != PieceKind::Pawn {
        return false;
    }
    let (_, to_rank) = square_coordinates(mv.to());
    match piece.color() {
        // Seventh rank (index 6) or the promotion square (index 7) for White; mirror for Black.
        Color::White => to_rank >= 6,
        Color::Black => to_rank <= 1,
    }
}

fn move_extension(position: &Position, mv: Move, extension_plies: u8) -> u8 {
    // A pawn crashing through to promotion is forcing for either side. Extend so the queen that
    // appears (or is threatened next ply) is actually searched instead of sitting just past the
    // horizon, where the leaf eval underweights it. This is what stops the search from ignoring an
    // enemy passer racing to promote in advanced positions.
    u8::from(extension_plies < MAX_EXTENSION_PLY && is_promotion_press(position, mv))
}

fn should_prune_regular_move(
    position: &Position,
    child: &Position,
    mv: Move,
    context: RegularMoveContext,
    extension_plies: u8,
) -> Result<bool, SearchError> {
    if move_extension(position, mv, extension_plies) > 0 {
        return Ok(false);
    }
    should_prune_frontier_futility(position, child, mv, context)
}

fn should_prune_frontier_futility(
    position: &Position,
    child: &Position,
    mv: Move,
    context: RegularMoveContext,
) -> Result<bool, SearchError> {
    if !futility_frontier_enabled(position, child, mv, context)? {
        return Ok(false);
    }

    let score = static_score(position, context.root_side);
    if context.maximizing {
        Ok(score.saturating_add(FUTILITY_MARGIN) <= context.alpha)
    } else {
        Ok(score.saturating_sub(FUTILITY_MARGIN) >= context.beta)
    }
}

fn futility_frontier_enabled(
    position: &Position,
    child: &Position,
    mv: Move,
    context: RegularMoveContext,
) -> Result<bool, SearchError> {
    if context.searched_move_count == 0
        || context.depth_remaining != FUTILITY_FRONTIER_DEPTH
        || is_in_check(position, position.side_to_move())
        || active_bound_has_ambiguous_mate_window(context.alpha, context.beta, context.maximizing)
        || !is_quiet_non_tactical_move(position, child, mv)?
    {
        return Ok(false);
    }

    Ok(true)
}

fn search_regular_child(
    position: &Position,
    child: &Position,
    mv: Move,
    ply_from_root: u8,
    context: RegularMoveContext,
    extension_plies: u8,
    search_state: &mut SearchState,
) -> Result<(i32, u64, u64), SearchError> {
    let child_ply_from_root = ply_from_root.saturating_add(1);
    let extension = move_extension(position, mv, extension_plies);
    let child_extension_plies = extension_plies.saturating_add(extension);
    let full_depth = (context.depth_remaining - 1).saturating_add(extension);

    if !should_reduce_regular_move(position, child, mv, context, extension_plies)? {
        return alpha_beta_child_with_parent_on_path(
            position,
            child,
            full_depth,
            child_ply_from_root,
            context,
            child_extension_plies,
            search_state,
        );
    }

    let reduced_depth = full_depth - LMR_DEPTH_REDUCTION;
    let (reduced_score, reduced_nodes, reduced_tt_hits) = alpha_beta_child_with_parent_on_path(
        position,
        child,
        reduced_depth,
        child_ply_from_root,
        context,
        child_extension_plies,
        search_state,
    )?;
    if !reduced_score_crosses_active_bound(reduced_score, context) {
        return Ok((reduced_score, reduced_nodes, reduced_tt_hits));
    }

    let (full_score, full_nodes, full_tt_hits) = alpha_beta_child_with_parent_on_path(
        position,
        child,
        full_depth,
        child_ply_from_root,
        context,
        child_extension_plies,
        search_state,
    )?;
    Ok((
        full_score,
        reduced_nodes.saturating_add(full_nodes),
        reduced_tt_hits.saturating_add(full_tt_hits),
    ))
}

fn alpha_beta_child_with_parent_on_path(
    parent: &Position,
    child: &Position,
    depth_remaining: u8,
    ply_from_root: u8,
    context: RegularMoveContext,
    extension_plies: u8,
    search_state: &mut SearchState,
) -> Result<(i32, u64, u64), SearchError> {
    search_state.path_hashes.push(parent.zobrist_hash());
    let result = alpha_beta_with_extensions(
        child,
        depth_remaining,
        ply_from_root,
        context.root_side,
        SearchWindow {
            alpha: context.alpha,
            beta: context.beta,
        },
        extension_plies,
        search_state,
    );
    search_state.path_hashes.pop();
    result
}

fn should_reduce_late_move(
    position: &Position,
    child: &Position,
    mv: Move,
    context: RegularMoveContext,
) -> Result<bool, SearchError> {
    if !late_move_reduction_enabled(position, child, mv, context)? {
        return Ok(false);
    }

    Ok(true)
}

fn should_reduce_regular_move(
    position: &Position,
    child: &Position,
    mv: Move,
    context: RegularMoveContext,
    extension_plies: u8,
) -> Result<bool, SearchError> {
    if move_extension(position, mv, extension_plies) > 0 {
        return Ok(false);
    }
    should_reduce_late_move(position, child, mv, context)
}

fn late_move_reduction_enabled(
    position: &Position,
    child: &Position,
    mv: Move,
    context: RegularMoveContext,
) -> Result<bool, SearchError> {
    if context.depth_remaining < LMR_MIN_DEPTH
        || context.searched_move_count < LMR_SEARCHED_MOVE_THRESHOLD
        || is_in_check(position, position.side_to_move())
        || active_bound_has_ambiguous_mate_window(context.alpha, context.beta, context.maximizing)
        || !is_quiet_non_tactical_move(position, child, mv)?
    {
        return Ok(false);
    }

    Ok(true)
}

fn reduced_score_crosses_active_bound(reduced_score: i32, context: RegularMoveContext) -> bool {
    if context.maximizing {
        reduced_score > context.alpha
    } else {
        reduced_score < context.beta
    }
}

fn is_quiet_non_tactical_move(
    position: &Position,
    child: &Position,
    mv: Move,
) -> Result<bool, SearchError> {
    // Equivalent to `status_trusted() == Ongoing && !in_check` without pricing the child's full
    // legal move list: checkmate implies check, stalemate implies no legal move.
    Ok(captured_piece(position, mv).is_none()
        && mv.promotion().is_none()
        && !is_in_check(child, child.side_to_move())
        && child.has_any_legal_move_trusted())
}

fn active_bound_has_ambiguous_mate_window(alpha: i32, beta: i32, maximizing: bool) -> bool {
    if maximizing {
        is_positive_mate_bound(alpha)
    } else {
        is_negative_mate_bound(beta)
    }
}

fn is_positive_mate_bound(bound: i32) -> bool {
    bound >= PLAY_MATE_THRESHOLD
}

fn is_negative_mate_bound(bound: i32) -> bool {
    bound <= -PLAY_MATE_THRESHOLD
}

fn quiescence(
    position: &Position,
    root_side: Color,
    ply_from_root: u8,
    alpha: i32,
    beta: i32,
    quiescence_ply: u8,
    search_state: &mut SearchState,
) -> Result<(i32, u64), SearchError> {
    quiescence_with_legal_moves(
        position,
        root_side,
        ply_from_root,
        SearchWindow { alpha, beta },
        quiescence_ply,
        None,
        search_state,
    )
}

/// Quiescence node. `legal_moves` is the node's complete legal list when the caller already
/// generated it (the main search frontier); otherwise it is generated here at most once.
/// Terminal detection comes from that list (empty: mate in check, stalemate otherwise); a node
/// that stands pat without searching only asks whether any legal move exists.
fn quiescence_with_legal_moves(
    position: &Position,
    root_side: Color,
    ply_from_root: u8,
    window: SearchWindow,
    quiescence_ply: u8,
    legal_moves: Option<Vec<Move>>,
    search_state: &mut SearchState,
) -> Result<(i32, u64), SearchError> {
    let SearchWindow {
        mut alpha,
        mut beta,
    } = window;
    let stand_pat = static_score(position, root_side);
    search_state.ensure_quiescence_budget();
    if search_state.trip_quiescence_budget_if_exhausted() {
        return Ok((stand_pat, 0));
    }
    let hash = position.zobrist_hash();
    if position_is_static_draw(position) || search_state.repetition_draw(hash) {
        return Ok((0, 1));
    }

    let in_check = is_in_check(position, position.side_to_move());
    let maximizing = position.side_to_move() == root_side;
    let mut nodes = 1_u64;
    let moves = if in_check {
        let evasions = legal_moves.unwrap_or_else(|| position.legal_moves_trusted());
        if evasions.is_empty() {
            return Ok((mated_score(position, root_side, ply_from_root), nodes));
        }
        evasions
    } else {
        let stands_pat = if quiescence_ply >= MAX_QUIESCENCE_PLY {
            true
        } else if maximizing {
            alpha = alpha.max(stand_pat);
            beta <= alpha
        } else {
            beta = beta.min(stand_pat);
            beta <= alpha
        };
        if stands_pat {
            let has_legal_move = legal_moves.map_or_else(
                || position.has_any_legal_move_trusted(),
                |moves| !moves.is_empty(),
            );
            if !has_legal_move {
                return Ok((0, nodes));
            }
            return Ok((stand_pat, nodes));
        }
        let legal_moves = legal_moves.unwrap_or_else(|| position.legal_moves_trusted());
        if legal_moves.is_empty() {
            return Ok((0, nodes));
        }
        ordered_captures(position, legal_moves)
    };

    if maximizing {
        let mut best = if in_check { i32::MIN } else { stand_pat };
        for mv in moves {
            if should_delta_prune_quiescence_capture(
                position, mv, stand_pat, alpha, beta, maximizing, in_check,
            ) {
                continue;
            }
            let child = position.after_known_legal_move(mv)?;
            let (score, child_nodes) = quiescence_child_score(
                position,
                &child,
                SearchWindow { alpha, beta },
                QuiescenceChildContext {
                    root_side,
                    ply_from_root,
                    quiescence_ply,
                    parent_in_check: in_check,
                },
                search_state,
            )?;
            nodes = nodes.saturating_add(child_nodes);
            best = best.max(score);
            alpha = alpha.max(best);
            if beta <= alpha {
                break;
            }
        }
        Ok((best, nodes))
    } else {
        let mut best = if in_check { i32::MAX } else { stand_pat };
        for mv in moves {
            if should_delta_prune_quiescence_capture(
                position, mv, stand_pat, alpha, beta, maximizing, in_check,
            ) {
                continue;
            }
            let child = position.after_known_legal_move(mv)?;
            let (score, child_nodes) = quiescence_child_score(
                position,
                &child,
                SearchWindow { alpha, beta },
                QuiescenceChildContext {
                    root_side,
                    ply_from_root,
                    quiescence_ply,
                    parent_in_check: in_check,
                },
                search_state,
            )?;
            nodes = nodes.saturating_add(child_nodes);
            best = best.min(score);
            beta = beta.min(best);
            if beta <= alpha {
                break;
            }
        }
        Ok((best, nodes))
    }
}

fn quiescence_child_score(
    parent: &Position,
    child: &Position,
    window: SearchWindow,
    context: QuiescenceChildContext,
    search_state: &mut SearchState,
) -> Result<(i32, u64), SearchError> {
    let child_ply_from_root = context.ply_from_root.saturating_add(1);
    if context.parent_in_check && context.quiescence_ply >= MAX_QUIESCENCE_PLY {
        if search_state.trip_quiescence_budget_if_exhausted() {
            return Ok((static_score(child, context.root_side), 0));
        }
        // One early-exit legality probe instead of a full status generation.
        let score = if child.has_any_legal_move_trusted() {
            static_score(child, context.root_side)
        } else if is_in_check(child, child.side_to_move()) {
            mated_score(child, context.root_side, child_ply_from_root)
        } else {
            0
        };
        return Ok((score, 1));
    }
    search_state.path_hashes.push(parent.zobrist_hash());
    let result = quiescence(
        child,
        context.root_side,
        child_ply_from_root,
        window.alpha,
        window.beta,
        context.quiescence_ply.saturating_add(1),
        search_state,
    );
    search_state.path_hashes.pop();
    result
}

fn should_delta_prune_quiescence_capture(
    position: &Position,
    mv: Move,
    stand_pat: i32,
    alpha: i32,
    beta: i32,
    maximizing: bool,
    in_check: bool,
) -> bool {
    if in_check || mv.promotion().is_some() || !side_has_delta_pruning_material(position) {
        return false;
    }
    let Some(victim) = captured_piece(position, mv) else {
        return false;
    };
    let margin = piece_value(victim.kind()).saturating_add(QUIESCENCE_DELTA_MARGIN);
    if maximizing {
        stand_pat.saturating_add(margin) <= alpha
    } else {
        stand_pat.saturating_sub(margin) >= beta
    }
}

fn side_has_delta_pruning_material(position: &Position) -> bool {
    let side = position.side_to_move();
    let mut count = 0_usize;
    for rank in RANKS {
        for file in FILES {
            let square = Square::new(file, rank);
            if position.piece_at(square).is_some_and(|piece| {
                piece.color() == side && !matches!(piece.kind(), PieceKind::King | PieceKind::Pawn)
            }) {
                count += 1;
                if count > 1 {
                    return true;
                }
            }
        }
    }
    false
}

/// Legal moves through the trusted board path. Sound because every public search entry point
/// validates the root with `position.status()?` before any tree walk, and every other position
/// the search touches is board-derived from that validated root.
fn legal_moves_or_invalid(position: &Position) -> Result<Vec<Move>, SearchError> {
    let moves = position.legal_moves_trusted();
    if moves.is_empty() {
        return Err(SearchError::InvalidPosition);
    }
    Ok(moves)
}

#[cfg(test)]
fn ordered_capture_moves(position: &Position) -> Result<Vec<Move>, SearchError> {
    Ok(ordered_captures(position, position.legal_moves_trusted()))
}

/// The captures of an already generated legal list, ordered by MVV-LVA.
fn ordered_captures(position: &Position, legal_moves: Vec<Move>) -> Vec<Move> {
    let mut captures = legal_moves
        .into_iter()
        .filter(|mv| captured_piece(position, *mv).is_some())
        .collect::<Vec<_>>();
    captures.sort_by(|left, right| {
        capture_order_score(position, *right)
            .cmp(&capture_order_score(position, *left))
            .then_with(|| left.cmp(right))
    });
    captures
}

fn capture_order_score(position: &Position, mv: Move) -> i32 {
    let victim_value = captured_piece(position, mv).map_or(0, |piece| piece_value(piece.kind()));
    let attacker_value = position
        .piece_at(mv.from())
        .map_or(0, |piece| piece_value(piece.kind()));
    (victim_value * 10).saturating_sub(attacker_value)
}

fn captured_piece(position: &Position, mv: Move) -> Option<Piece> {
    if let Some(piece) = position.piece_at(mv.to()) {
        return Some(piece);
    }

    let moving_piece = position.piece_at(mv.from())?;
    if moving_piece.kind() == PieceKind::Pawn && mv.from().file() != mv.to().file() {
        return position
            .piece_at(Square::new(mv.to().file(), mv.from().rank()))
            .filter(|piece| {
                piece.kind() == PieceKind::Pawn && piece.color() != moving_piece.color()
            });
    }

    None
}

fn is_in_check(position: &Position, color: Color) -> bool {
    let Some(king_square) = king_square(position, color) else {
        return false;
    };
    for rank in RANKS {
        for file in FILES {
            let attacker_square = Square::new(file, rank);
            let Some(attacker) = position.piece_at(attacker_square) else {
                continue;
            };
            if attacker.color() != color
                && piece_attacks_square(position, attacker_square, attacker, king_square)
            {
                return true;
            }
        }
    }
    false
}

fn king_square(position: &Position, color: Color) -> Option<Square> {
    for rank in RANKS {
        for file in FILES {
            let square = Square::new(file, rank);
            if position
                .piece_at(square)
                .is_some_and(|piece| piece.color() == color && piece.kind() == PieceKind::King)
            {
                return Some(square);
            }
        }
    }
    None
}

fn piece_attacks_square(
    position: &Position,
    attacker_square: Square,
    attacker: Piece,
    target_square: Square,
) -> bool {
    let (from_file, from_rank) = square_coordinates(attacker_square);
    let (to_file, to_rank) = square_coordinates(target_square);
    let file_delta = to_file - from_file;
    let rank_delta = to_rank - from_rank;

    match attacker.kind() {
        PieceKind::King => file_delta.abs().max(rank_delta.abs()) == 1,
        PieceKind::Queen => {
            attacks_like_bishop(file_delta, rank_delta)
                .is_some_and(|step| path_is_clear(position, attacker_square, target_square, step))
                || attacks_like_rook(file_delta, rank_delta).is_some_and(|step| {
                    path_is_clear(position, attacker_square, target_square, step)
                })
        }
        PieceKind::Rook => attacks_like_rook(file_delta, rank_delta)
            .is_some_and(|step| path_is_clear(position, attacker_square, target_square, step)),
        PieceKind::Bishop => attacks_like_bishop(file_delta, rank_delta)
            .is_some_and(|step| path_is_clear(position, attacker_square, target_square, step)),
        PieceKind::Knight => {
            matches!((file_delta.abs(), rank_delta.abs()), (1, 2) | (2, 1))
        }
        PieceKind::Pawn => match attacker.color() {
            Color::White => rank_delta == 1 && file_delta.abs() == 1,
            Color::Black => rank_delta == -1 && file_delta.abs() == 1,
        },
    }
}

fn attacks_like_bishop(file_delta: i8, rank_delta: i8) -> Option<(i8, i8)> {
    (file_delta.abs() == rank_delta.abs() && file_delta != 0)
        .then_some((file_delta.signum(), rank_delta.signum()))
}

fn attacks_like_rook(file_delta: i8, rank_delta: i8) -> Option<(i8, i8)> {
    ((file_delta == 0) ^ (rank_delta == 0)).then_some((file_delta.signum(), rank_delta.signum()))
}

fn path_is_clear(
    position: &Position,
    attacker_square: Square,
    target_square: Square,
    step: (i8, i8),
) -> bool {
    let (mut file, mut rank) = square_coordinates(attacker_square);
    let (target_file, target_rank) = square_coordinates(target_square);
    loop {
        file += step.0;
        rank += step.1;
        if file == target_file && rank == target_rank {
            return true;
        }
        let Some(square) = square_from_coordinates(file, rank) else {
            return false;
        };
        if position.piece_at(square).is_some() {
            return false;
        }
    }
}

fn square_coordinates(square: Square) -> (i8, i8) {
    (file_index(square.file()), rank_index(square.rank()))
}

fn square_from_coordinates(file: i8, rank: i8) -> Option<Square> {
    let file = FILES.get(usize::try_from(file).ok()?).copied()?;
    let rank = RANKS.get(usize::try_from(rank).ok()?).copied()?;
    Some(Square::new(file, rank))
}

const fn file_index(file: File) -> i8 {
    match file {
        File::A => 0,
        File::B => 1,
        File::C => 2,
        File::D => 3,
        File::E => 4,
        File::F => 5,
        File::G => 6,
        File::H => 7,
    }
}

const fn rank_index(rank: Rank) -> i8 {
    match rank {
        Rank::First => 0,
        Rank::Second => 1,
        Rank::Third => 2,
        Rank::Fourth => 3,
        Rank::Fifth => 4,
        Rank::Sixth => 5,
        Rank::Seventh => 6,
        Rank::Eighth => 7,
    }
}

const fn square_index(square: Square) -> usize {
    (rank_index(square.rank()) as usize * 8) + file_index(square.file()) as usize
}

const fn color_index(color: Color) -> usize {
    match color {
        Color::White => 0,
        Color::Black => 1,
    }
}

const fn promotion_index(mv: Move) -> usize {
    match mv.promotion() {
        None => 0,
        Some(chess_board::PromotionPiece::Queen) => 1,
        Some(chess_board::PromotionPiece::Rook) => 2,
        Some(chess_board::PromotionPiece::Bishop) => 3,
        Some(chess_board::PromotionPiece::Knight) => 4,
    }
}

const fn move_history_index(mv: Move) -> usize {
    (((square_index(mv.from()) * BOARD_SQUARES) + square_index(mv.to())) * PROMOTION_VARIANTS)
        + promotion_index(mv)
}

const fn history_bonus(depth_remaining: u8) -> i32 {
    let depth = depth_remaining as i32;
    depth * depth
}

const fn piece_value(kind: PieceKind) -> i32 {
    match kind {
        PieceKind::King => 0,
        PieceKind::Queen => QUEEN_VALUE,
        PieceKind::Rook => ROOK_VALUE,
        PieceKind::Bishop => BISHOP_VALUE,
        PieceKind::Knight => KNIGHT_VALUE,
        PieceKind::Pawn => PAWN_VALUE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    #[test]
    fn reaction_lines_flag_a_candidate_that_hangs_a_piece() {
        // White can develop the knight safely or shove the queen to d5, where the c6 pawn takes it.
        let position = position("4k3/8/2p5/8/8/5N2/8/3QK3 w - - 0 1");
        let lines = reaction_lines(&position, SearchConfig { max_depth: 2 })
            .expect("reaction lines must run");

        let hanging = lines
            .candidates
            .iter()
            .find(|candidate| candidate.mv.to_coordinate() == "d1d5")
            .expect("the queen sortie must be a candidate");
        assert!(
            hanging.hangs_material,
            "stepping the queen onto a pawn's diagonal must be flagged as hanging"
        );

        let safe = lines
            .candidates
            .iter()
            .find(|candidate| candidate.mv.to_coordinate() == "f3d4")
            .expect("a quiet knight move must be a candidate");
        assert!(
            !safe.hangs_material,
            "a safe knight move must not be flagged as hanging"
        );
    }

    fn synthetic_candidate(
        coordinate: &str,
        score: i32,
        hangs_material: bool,
    ) -> ReactionCandidate {
        ReactionCandidate {
            mv: Move::from_coordinate(coordinate).expect("move must parse"),
            score,
            hangs_material,
            mate_in: None,
            quality: MoveQuality::Best,
        }
    }

    #[test]
    fn reaction_lines_label_every_candidate_quality() {
        let start = Position::startpos();
        let lines =
            reaction_lines(&start, SearchConfig { max_depth: 2 }).expect("reaction lines must run");

        let top = lines.candidates.first().expect("a candidate must exist");
        assert!(
            matches!(
                top.quality,
                MoveQuality::Best
                    | MoveQuality::Excellent
                    | MoveQuality::Great
                    | MoveQuality::Brilliant
            ),
            "the best opening candidate must not be labelled a mistake"
        );
    }

    #[test]
    fn classify_candidate_quality_marks_a_sound_sacrifice_brilliant() {
        // Top move hangs material by SEE yet stays clearly winning (and is not already crushing):
        // exactly the sound sacrifice that earns Brilliant.
        let mut candidates = vec![
            synthetic_candidate("d1h5", 150, true),
            synthetic_candidate("b1c3", -40, false),
        ];
        classify_candidate_quality(&mut candidates);
        assert_eq!(candidates[0].quality, MoveQuality::Brilliant);
    }

    #[test]
    fn classify_candidate_quality_marks_a_lone_critical_move_great() {
        // A non-sacrifice whose win percentage clears the only alternative by a wide margin.
        let mut candidates = vec![
            synthetic_candidate("e2e4", 80, false),
            synthetic_candidate("a2a3", -160, false),
        ];
        classify_candidate_quality(&mut candidates);
        assert_eq!(candidates[0].quality, MoveQuality::Great);
    }

    #[test]
    fn classify_candidate_quality_does_not_call_an_already_winning_sacrifice_brilliant() {
        // A "sacrifice" while already completely winning is not surprising; it stays Best.
        let mut candidates = vec![
            synthetic_candidate("d1h5", 1_200, true),
            synthetic_candidate("b1c3", 900, false),
        ];
        classify_candidate_quality(&mut candidates);
        assert_eq!(candidates[0].quality, MoveQuality::Best);
    }

    #[test]
    fn reaction_lines_report_mate_distance_for_a_mating_candidate() {
        // White rook on a1, Black king boxed on g8 by its own pawns: Ra8 is mate in one.
        let position = position("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1");
        let lines = reaction_lines(&position, SearchConfig { max_depth: 2 })
            .expect("reaction lines must run");

        let mate = lines
            .candidates
            .iter()
            .find(|candidate| candidate.mv.to_coordinate() == "a1a8")
            .expect("the mating move must be a candidate");
        assert_eq!(
            mate.mate_in,
            Some(1),
            "Ra8 delivers mate now, so it is mate in one move"
        );

        let quiet = lines
            .candidates
            .iter()
            .find(|candidate| candidate.mv.to_coordinate() == "h1g1")
            .expect("a non-mating king move must be a candidate");
        assert_eq!(
            quiet.mate_in, None,
            "a move that does not force mate has no mate distance"
        );
    }

    #[test]
    fn exact_tt_entry_reuses_score_for_sufficient_depth() {
        let position = Position::startpos();
        let mut search_state = SearchState::default();
        search_state.tt.insert(
            position.zobrist_hash(),
            TtEntry {
                depth_remaining: 3,
                score: 123,
            },
        );

        let result = alpha_beta(&position, 3, 0, Color::White, -10, 10, &mut search_state)
            .expect("search must run");

        assert_eq!(result, (123, 0, 1));
    }

    #[test]
    fn path_repetition_scores_draw_without_tt_cache() {
        let position = position("4k3/8/8/8/8/8/8/R3K3 w - - 0 1");
        let mut search_state = SearchState {
            path_hashes: vec![position.zobrist_hash(), position.zobrist_hash()],
            ..SearchState::default()
        };

        let result = alpha_beta(
            &position,
            2,
            2,
            Color::White,
            i32::MIN + 1,
            i32::MAX,
            &mut search_state,
        )
        .expect("search must run");

        assert_eq!(result, (0, 1, 0));
        assert!(
            search_state.tt.is_empty(),
            "path-dependent repetition draws must not be cached as exact TT entries"
        );
    }

    #[test]
    fn one_prior_path_occurrence_is_not_a_threefold_draw() {
        let position = position("4k3/8/8/8/8/8/8/R3K3 w - - 0 1");
        let search_state = SearchState {
            path_hashes: vec![position.zobrist_hash()],
            ..SearchState::default()
        };

        assert!(
            !search_state.repetition_draw(position.zobrist_hash()),
            "the current node is only the second occurrence; threefold requires two prior matches"
        );
    }

    #[test]
    fn stalemate_terminal_is_cached_as_exact_tt_entry() {
        let position = position("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
        let mut search_state = SearchState::default();

        let first = alpha_beta(
            &position,
            1,
            0,
            Color::Black,
            i32::MIN + 1,
            i32::MAX,
            &mut search_state,
        )
        .expect("search must run");

        assert_eq!(first, (0, 1, 0));
        assert_eq!(
            search_state.tt.get(&position.zobrist_hash()),
            Some(&TtEntry {
                depth_remaining: 1,
                score: 0,
            })
        );

        let second = alpha_beta(
            &position,
            1,
            0,
            Color::Black,
            i32::MIN + 1,
            i32::MAX,
            &mut search_state,
        )
        .expect("search must run");

        assert_eq!(second, (0, 0, 1));
    }

    #[test]
    fn checkmate_terminal_is_not_cached_as_exact_tt_entry() {
        let position = position("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
        let mut search_state = SearchState::default();

        let first = alpha_beta(
            &position,
            1,
            0,
            Color::Black,
            i32::MIN + 1,
            i32::MAX,
            &mut search_state,
        )
        .expect("search must run");

        assert_eq!(first, (-MATE_SCORE, 1, 0));
        assert!(
            search_state.tt.is_empty(),
            "ply-adjusted checkmate score must not be cached"
        );

        let second = alpha_beta(
            &position,
            1,
            0,
            Color::Black,
            i32::MIN + 1,
            i32::MAX,
            &mut search_state,
        )
        .expect("search must run");

        assert_eq!(second, (-MATE_SCORE, 1, 0));
        assert!(
            search_state.tt.is_empty(),
            "repeated checkmate search must not produce a TT hit"
        );
    }

    #[test]
    fn checkmate_score_preserves_ply_distance() {
        let position = position("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
        let near = terminal_score(&position, Color::Black, 1).expect("near mate score must run");
        let far = terminal_score(&position, Color::Black, 3).expect("far mate score must run");

        assert_eq!(near, -(MATE_SCORE - 1));
        assert_eq!(far, -(MATE_SCORE - 3));
        assert_ne!(near, far, "mate scores must retain ply distance");
    }

    #[test]
    fn frontier_futility_requires_a_previously_searched_move() {
        let position = Position::startpos();
        let mv = Move::from_coordinate("a2a3").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");
        let alpha = static_score(&position, Color::White).saturating_add(FUTILITY_MARGIN);

        assert!(
            !should_prune_frontier_futility(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: FUTILITY_FRONTIER_DEPTH,
                    root_side: Color::White,
                    alpha,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: 0,
                },
            )
            .expect("frontier futility check must run")
        );
    }

    #[test]
    fn frontier_futility_prunes_eligible_quiet_moves_after_a_searched_move() {
        let position = Position::startpos();
        let mv = Move::from_coordinate("a2a3").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");
        let alpha = static_score(&position, Color::White).saturating_add(FUTILITY_MARGIN);

        assert!(
            should_prune_frontier_futility(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: FUTILITY_FRONTIER_DEPTH,
                    root_side: Color::White,
                    alpha,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: 1,
                },
            )
            .expect("frontier futility check must run")
        );
    }

    #[test]
    fn frontier_futility_rejects_parent_in_check() {
        let position = position("4r2k/8/8/8/8/8/8/4K3 w - - 0 1");
        let mv = Move::from_coordinate("e1d1").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");
        let alpha = static_score(&position, Color::White).saturating_add(FUTILITY_MARGIN);

        assert!(
            !should_prune_frontier_futility(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: FUTILITY_FRONTIER_DEPTH,
                    root_side: Color::White,
                    alpha,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: 1,
                },
            )
            .expect("frontier futility check must run")
        );
    }

    #[test]
    fn frontier_futility_rejects_quiet_checking_moves() {
        let position = position("7k/8/6K1/8/8/8/8/R7 w - - 0 1");
        let mv = Move::from_coordinate("a1h1").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");
        let alpha = static_score(&position, Color::White).saturating_add(FUTILITY_MARGIN);

        assert!(
            !is_quiet_non_tactical_move(&position, &child, mv)
                .expect("quiet non-tactical classification must run")
        );
        assert!(
            !should_prune_frontier_futility(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: FUTILITY_FRONTIER_DEPTH,
                    root_side: Color::White,
                    alpha,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: 1,
                },
            )
            .expect("frontier futility check must run")
        );
    }

    #[test]
    fn frontier_futility_rejects_non_capture_promotions() {
        let position = position("7k/P7/6K1/8/8/8/8/8 w - - 0 1");
        let mv = Move::from_coordinate("a7a8q").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");
        let alpha = static_score(&position, Color::White).saturating_add(FUTILITY_MARGIN);

        assert!(
            !is_quiet_non_tactical_move(&position, &child, mv)
                .expect("quiet non-tactical classification must run")
        );
        assert!(
            !should_prune_frontier_futility(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: FUTILITY_FRONTIER_DEPTH,
                    root_side: Color::White,
                    alpha,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: 1,
                },
            )
            .expect("frontier futility check must run")
        );
    }

    #[test]
    fn frontier_futility_rejects_terminal_children() {
        let position = position("7k/4Q3/6K1/8/8/8/8/8 w - - 0 1");
        let mv = Move::from_coordinate("e7f7").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");
        let alpha = static_score(&position, Color::White).saturating_add(FUTILITY_MARGIN);

        assert_eq!(
            child.status().expect("status must run"),
            PositionStatus::Stalemate
        );
        assert!(
            !is_quiet_non_tactical_move(&position, &child, mv)
                .expect("quiet non-tactical classification must run")
        );
        assert!(
            !should_prune_frontier_futility(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: FUTILITY_FRONTIER_DEPTH,
                    root_side: Color::White,
                    alpha,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: 1,
                },
            )
            .expect("frontier futility check must run")
        );
    }

    #[test]
    fn frontier_futility_rejects_active_mate_bounds() {
        let position = Position::startpos();
        let mv = Move::from_coordinate("a2a3").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");

        assert!(
            !should_prune_frontier_futility(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: FUTILITY_FRONTIER_DEPTH,
                    root_side: Color::White,
                    alpha: MATE_SCORE - 1,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: 1,
                },
            )
            .expect("frontier futility check must run")
        );
    }

    #[test]
    fn late_move_reduction_requires_searched_move_threshold() {
        let position = Position::startpos();
        let mv = Move::from_coordinate("a2a3").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");

        assert!(
            !should_reduce_late_move(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: LMR_MIN_DEPTH,
                    root_side: Color::White,
                    alpha: i32::MIN + 1,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: LMR_SEARCHED_MOVE_THRESHOLD - 1,
                },
            )
            .expect("LMR eligibility must run")
        );
    }

    #[test]
    fn late_move_reduction_reduces_eligible_quiet_move_after_threshold() {
        let position = Position::startpos();
        let mv = Move::from_coordinate("a2a3").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");

        assert!(
            should_reduce_late_move(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: LMR_MIN_DEPTH,
                    root_side: Color::White,
                    alpha: i32::MIN + 1,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: LMR_SEARCHED_MOVE_THRESHOLD,
                },
            )
            .expect("LMR eligibility must run")
        );
    }

    #[test]
    fn late_move_reduction_rejects_parent_in_check() {
        let position = position("4r2k/8/8/8/8/8/8/4K3 w - - 0 1");
        let mv = Move::from_coordinate("e1d1").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");

        assert!(
            !should_reduce_late_move(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: LMR_MIN_DEPTH,
                    root_side: Color::White,
                    alpha: i32::MIN + 1,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: LMR_SEARCHED_MOVE_THRESHOLD,
                },
            )
            .expect("LMR eligibility must run")
        );
    }

    #[test]
    fn late_move_reduction_rejects_quiet_checking_moves() {
        let position = position("7k/8/6K1/8/8/8/8/R7 w - - 0 1");
        let mv = Move::from_coordinate("a1h1").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");

        assert!(
            !should_reduce_late_move(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: LMR_MIN_DEPTH,
                    root_side: Color::White,
                    alpha: i32::MIN + 1,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: LMR_SEARCHED_MOVE_THRESHOLD,
                },
            )
            .expect("LMR eligibility must run")
        );
    }

    #[test]
    fn late_move_reduction_rejects_non_capture_promotions() {
        let position = position("7k/P7/6K1/8/8/8/8/8 w - - 0 1");
        let mv = Move::from_coordinate("a7a8q").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");

        assert!(
            !should_reduce_late_move(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: LMR_MIN_DEPTH,
                    root_side: Color::White,
                    alpha: i32::MIN + 1,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: LMR_SEARCHED_MOVE_THRESHOLD,
                },
            )
            .expect("LMR eligibility must run")
        );
    }

    #[test]
    fn late_move_reduction_rejects_terminal_children() {
        let position = position("7k/4Q3/6K1/8/8/8/8/8 w - - 0 1");
        let mv = Move::from_coordinate("e7f7").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");

        assert_eq!(
            child.status().expect("status must run"),
            PositionStatus::Stalemate
        );
        assert!(
            !should_reduce_late_move(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: LMR_MIN_DEPTH,
                    root_side: Color::White,
                    alpha: i32::MIN + 1,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: LMR_SEARCHED_MOVE_THRESHOLD,
                },
            )
            .expect("LMR eligibility must run")
        );
    }

    #[test]
    fn late_move_reduction_rejects_active_mate_bounds() {
        let position = Position::startpos();
        let mv = Move::from_coordinate("a2a3").expect("move must parse");
        let child = position.after_legal_move(mv).expect("move must apply");

        assert!(
            !should_reduce_late_move(
                &position,
                &child,
                mv,
                RegularMoveContext {
                    depth_remaining: LMR_MIN_DEPTH,
                    root_side: Color::White,
                    alpha: MATE_SCORE - 1,
                    beta: i32::MAX,
                    maximizing: true,
                    searched_move_count: LMR_SEARCHED_MOVE_THRESHOLD,
                },
            )
            .expect("LMR eligibility must run")
        );
    }

    #[test]
    fn late_move_research_triggers_when_reduced_score_crosses_active_bound() {
        assert!(reduced_score_crosses_active_bound(
            5,
            RegularMoveContext {
                depth_remaining: LMR_MIN_DEPTH,
                root_side: Color::White,
                alpha: 4,
                beta: i32::MAX,
                maximizing: true,
                searched_move_count: LMR_SEARCHED_MOVE_THRESHOLD,
            },
        ));
        assert!(reduced_score_crosses_active_bound(
            -5,
            RegularMoveContext {
                depth_remaining: LMR_MIN_DEPTH,
                root_side: Color::White,
                alpha: i32::MIN + 1,
                beta: -4,
                maximizing: false,
                searched_move_count: LMR_SEARCHED_MOVE_THRESHOLD,
            },
        ));
    }

    #[test]
    fn extension_capacity_is_reflected_in_search_bounds() {
        // MAX_SEARCH_PLY is sized so the killer table covers every reachable ply.
        assert_eq!(
            MAX_SEARCH_PLY,
            usize::from(MAX_PLAY_DEPTH) + usize::from(MAX_EXTENSION_PLY) + 1
        );
        // PLAY_MATE_THRESHOLD is derived from the search extension budget.
        assert_eq!(
            PLAY_MATE_THRESHOLD,
            MATE_SCORE
                - i32::from(MAX_PLAY_DEPTH)
                - i32::from(MAX_EXTENSION_PLY)
                - i32::from(MAX_QUIESCENCE_PLY)
                - 1
        );
    }

    #[test]
    fn leaf_in_check_with_no_captures_searches_quiet_evasions() {
        let position = position("4r1k1/8/8/8/8/8/8/4K3 w - - 0 1");
        let mut search_state = SearchState::default();

        let (_score, nodes, tt_hits) = alpha_beta(
            &position,
            0,
            0,
            Color::White,
            i32::MIN + 1,
            i32::MAX,
            &mut search_state,
        )
        .expect("search must run");

        assert!(nodes > 1, "in-check leaf must search legal evasions");
        assert_eq!(tt_hits, 0);
        assert!(
            search_state.tt.is_empty(),
            "in-check leaf must not cache stand-pat score"
        );
    }

    #[test]
    fn quiescence_in_check_does_not_stand_pat_cutoff() {
        let position = position("4r1k1/8/8/8/8/8/8/4K3 w - - 0 1");
        let stand_pat = static_score(&position, Color::White);
        let mut search_state = SearchState::default();

        let (_score, nodes, tt_hits) = alpha_beta(
            &position,
            0,
            0,
            Color::White,
            stand_pat - 10,
            stand_pat - 5,
            &mut search_state,
        )
        .expect("search must run");

        assert!(nodes > 1, "in-check leaf must not beta-cut on stand-pat");
        assert_eq!(tt_hits, 0);
    }

    #[test]
    fn quiescence_in_check_cap_scores_one_evasion_ply() {
        let position = position("4r1k1/8/8/8/8/8/8/4K3 w - - 0 1");
        let legal_evasions = position.legal_moves().expect("legal moves must generate");
        let mut search_state = SearchState::default();

        let (_score, nodes) = quiescence(
            &position,
            Color::White,
            0,
            i32::MIN + 1,
            i32::MAX,
            MAX_QUIESCENCE_PLY,
            &mut search_state,
        )
        .expect("quiescence must run");

        assert_eq!(nodes, 1 + u64::try_from(legal_evasions.len()).unwrap());
    }

    #[test]
    fn quiescence_budget_guard_returns_stand_pat() {
        let position = position("6k1/8/8/8/8/8/4q3/4Q2K w - - 0 1");
        let stand_pat = static_score(&position, Color::White);
        let mut search_state = SearchState {
            node_budget: Some(10),
            node_counter: 10,
            ..SearchState::default()
        };

        let (score, nodes) = quiescence(
            &position,
            Color::White,
            0,
            i32::MIN + 1,
            i32::MAX,
            0,
            &mut search_state,
        )
        .expect("quiescence must run");

        assert_eq!(score, stand_pat);
        assert_eq!(nodes, 0);
    }

    #[test]
    fn quiescence_delta_pruning_uses_mirrored_bounds_and_exemptions() {
        let delta_position = position("6k1/8/8/8/8/8/4q3/4QR1K w - - 0 1");
        let capture = Move::from_coordinate("e1e2").expect("move parses");
        assert!(should_delta_prune_quiescence_capture(
            &delta_position,
            capture,
            0,
            2_000,
            i32::MAX,
            true,
            false
        ));
        assert!(should_delta_prune_quiescence_capture(
            &delta_position,
            capture,
            0,
            i32::MIN + 1,
            -2_000,
            false,
            false
        ));
        assert!(!should_delta_prune_quiescence_capture(
            &delta_position,
            capture,
            0,
            2_000,
            i32::MAX,
            true,
            true
        ));

        let low_material = position("6k1/8/8/8/8/8/4q3/4Q2K w - - 0 1");
        let low_material_capture = Move::from_coordinate("e1e2").expect("move parses");
        assert!(!should_delta_prune_quiescence_capture(
            &low_material,
            low_material_capture,
            0,
            2_000,
            i32::MAX,
            true,
            false
        ));

        let promotion = position("1r4k1/P7/8/8/8/8/7K/6RQ w - - 0 1");
        let capture_promotion = Move::from_coordinate("a7b8q").expect("move parses");
        assert!(!should_delta_prune_quiescence_capture(
            &promotion,
            capture_promotion,
            0,
            2_000,
            i32::MAX,
            true,
            false
        ));
    }

    #[test]
    fn quiescence_measures_three_ply_capture_chain() {
        let position = position("6k1/8/8/5n2/Q2q4/4B3/8/6K1 w - - 0 1");
        let after_white_bishop_captures = position
            .after_legal_move(Move::from_coordinate("e3d4").expect("move must parse"))
            .expect("white bishop capture must apply");
        let after_black_knight_recaptures = after_white_bishop_captures
            .after_legal_move(Move::from_coordinate("f5d4").expect("move must parse"))
            .expect("black knight recapture must apply");
        let after_white_queen_recaptures = after_black_knight_recaptures
            .after_legal_move(Move::from_coordinate("a4d4").expect("move must parse"))
            .expect("white queen recapture must apply");
        let transient_score = static_score(&after_black_knight_recaptures, Color::White);
        let full_capture_score = static_score(&after_white_queen_recaptures, Color::White);
        let mut search_state = SearchState::default();

        let (score, _nodes) = quiescence(
            &after_black_knight_recaptures,
            Color::White,
            2,
            i32::MIN + 1,
            i32::MAX,
            2,
            &mut search_state,
        )
        .expect("quiescence must run");

        assert_ne!(
            score, transient_score,
            "quiescence must not stop on the transient queen-trade score"
        );
        assert_eq!(
            score, full_capture_score,
            "quiescence must measure the final legal recapture"
        );
    }

    #[test]
    fn in_check_detector_respects_slider_blockers() {
        let open_file = position("4r2k/8/8/8/8/8/8/4K3 w - - 0 1");
        let blocked_file = position("4r2k/8/8/8/4P3/8/8/4K3 w - - 0 1");
        let open_diagonal = position("k7/8/8/8/7b/8/8/4K3 w - - 0 1");
        let blocked_diagonal = position("k7/8/8/8/7b/6P1/8/4K3 w - - 0 1");

        assert!(is_in_check(&open_file, Color::White));
        assert!(!is_in_check(&blocked_file, Color::White));
        assert!(is_in_check(&open_diagonal, Color::White));
        assert!(!is_in_check(&blocked_diagonal, Color::White));
    }

    #[test]
    fn in_check_detector_respects_pawn_direction_and_knights() {
        let black_pawn_attacks_down = position("7k/8/8/8/8/8/3p4/4K3 w - - 0 1");
        let black_pawn_wrong_direction = position("7k/8/8/8/8/4K3/3p4/8 w - - 0 1");
        let knight_check = position("7k/8/8/8/8/5n2/8/4K3 w - - 0 1");

        assert!(is_in_check(&black_pawn_attacks_down, Color::White));
        assert!(!is_in_check(&black_pawn_wrong_direction, Color::White));
        assert!(is_in_check(&knight_check, Color::White));
    }

    #[test]
    fn piece_attack_detector_covers_king_and_queen_geometry() {
        let empty = position("7k/8/8/8/8/8/8/4K3 w - - 0 1");
        let queen = Piece::new(Color::Black, PieceKind::Queen);
        let king = Piece::new(Color::Black, PieceKind::King);

        assert!(piece_attacks_square(
            &empty,
            Square::new(File::E, Rank::Eighth),
            queen,
            Square::new(File::E, Rank::First)
        ));
        assert!(piece_attacks_square(
            &empty,
            Square::new(File::H, Rank::Fourth),
            queen,
            Square::new(File::E, Rank::First)
        ));
        assert!(piece_attacks_square(
            &empty,
            Square::new(File::D, Rank::Second),
            king,
            Square::new(File::E, Rank::First)
        ));
        assert!(!piece_attacks_square(
            &empty,
            Square::new(File::D, Rank::Third),
            king,
            Square::new(File::E, Rank::First)
        ));
    }

    #[test]
    fn move_ordering_prefers_legal_killers_then_history_after_generating_moves() {
        let position = Position::startpos();
        let legal_moves = position.legal_moves().expect("legal moves must generate");
        let killer = Move::from_coordinate("g1f3").expect("killer move must parse");
        let history = Move::from_coordinate("b1c3").expect("history move must parse");
        let illegal = Move::from_coordinate("a1a8").expect("illegal move must parse");
        let mut ordering = MoveOrdering::default();

        assert!(legal_moves.contains(&killer));
        assert!(legal_moves.contains(&history));
        assert!(!legal_moves.contains(&illegal));

        ordering.killer_moves[1][0] = Some(killer);
        ordering.killer_moves[1][1] = Some(illegal);
        ordering.history_scores[0][move_history_index(history)] = 64;

        let ordered = ordering
            .ordered_legal_moves(&position, 1, None)
            .expect("ordered legal moves must generate");

        assert_eq!(ordered.first(), Some(&killer));
        assert_eq!(ordered.get(1), Some(&history));
        assert!(ordered.iter().all(|mv| legal_moves.contains(mv)));
    }

    #[test]
    fn history_scores_keep_equal_priority_moves_in_original_legal_order() {
        let position = Position::startpos();
        let legal_moves = position.legal_moves().expect("legal moves must generate");
        let first = Move::from_coordinate("a2a3").expect("move must parse");
        let second = Move::from_coordinate("a2a4").expect("move must parse");
        let mut ordering = MoveOrdering::default();

        assert!(legal_moves.starts_with(&[first, second]));

        ordering.history_scores[0][move_history_index(first)] = 32;
        ordering.history_scores[0][move_history_index(second)] = 32;

        let ordered = ordering
            .ordered_legal_moves(&position, 1, None)
            .expect("ordered legal moves must generate");

        assert_eq!(ordered.first(), Some(&first));
        assert_eq!(ordered.get(1), Some(&second));
    }

    #[test]
    fn quiescence_capture_ordering_remains_mvv_lva() {
        let position = position("3qk3/8/8/8/3Q3p/8/8/4K3 w - - 0 1");
        let captures = ordered_capture_moves(&position).expect("captures must generate");
        let coordinates = captures
            .into_iter()
            .map(|mv| mv.to_coordinate())
            .collect::<Vec<_>>();

        assert_eq!(coordinates, vec!["d4d8".to_string(), "d4h4".to_string()]);
    }

    #[test]
    fn history_scores_distinguish_promotion_choices_from_same_squares() {
        let queen_promotion = Move::from_coordinate("a7a8q").expect("move must parse");
        let knight_promotion = Move::from_coordinate("a7a8n").expect("move must parse");

        assert_ne!(
            move_history_index(queen_promotion),
            move_history_index(knight_promotion)
        );
    }

    #[test]
    fn reaction_lines_score_all_legal_root_moves_sorted_by_score() {
        let start = Position::startpos();
        let legal = start.legal_moves().expect("legal moves must generate");
        let lines =
            reaction_lines(&start, SearchConfig { max_depth: 2 }).expect("reaction lines must run");

        assert_eq!(lines.candidates.len(), legal.len());
        assert!(
            lines
                .candidates
                .iter()
                .all(|candidate| legal.contains(&candidate.mv)),
            "every candidate must be a legal root move"
        );
        assert!(
            lines
                .candidates
                .windows(2)
                .all(|pair| pair[0].score >= pair[1].score),
            "candidates must be sorted by score descending"
        );
    }

    #[test]
    fn reaction_lines_top_candidate_matches_root_search_score() {
        let start = Position::startpos();
        let lines =
            reaction_lines(&start, SearchConfig { max_depth: 2 }).expect("reaction lines must run");
        let root = search(&start, SearchConfig { max_depth: 2 }).expect("search must run");

        let top = lines.candidates.first().expect("a candidate must exist");
        assert_eq!(
            top.score, root.score,
            "top candidate score must equal the exact root search score"
        );
        assert_eq!(
            lines.principal_line.first(),
            Some(&top.mv),
            "projected line must begin with the top candidate"
        );
    }

    #[test]
    fn reaction_lines_projected_line_moves_are_legal_from_each_position() {
        let start = Position::startpos();
        let lines =
            reaction_lines(&start, SearchConfig { max_depth: 3 }).expect("reaction lines must run");

        let mut current = start;
        for mv in &lines.principal_line {
            let legal = current.legal_moves().expect("legal moves must generate");
            assert!(
                legal.contains(mv),
                "projected line move {} must be legal from the live position",
                mv.to_coordinate()
            );
            current = current
                .after_legal_move(*mv)
                .expect("projected move must apply");
        }
    }

    #[test]
    fn reaction_lines_report_terminal_mate_only_from_a_checkmate_line() {
        let mate_in_one = position("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1");
        let lines = reaction_lines(&mate_in_one, SearchConfig { max_depth: 2 })
            .expect("reaction lines must run");

        assert_eq!(
            lines.principal_line,
            vec![Move::from_coordinate("a1a8").expect("mating move must parse")],
            "projected line must be the single mating move"
        );
        assert!(
            lines.mate_detected,
            "mate must be reported when the line reaches checkmate"
        );

        let quiet = Position::startpos();
        let quiet_lines =
            reaction_lines(&quiet, SearchConfig { max_depth: 2 }).expect("reaction lines must run");
        assert!(
            !quiet_lines.mate_detected,
            "a non-terminal line must not report mate"
        );
    }

    #[test]
    fn reaction_lines_on_terminal_position_have_no_candidates() {
        let checkmate = position("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
        let lines = reaction_lines(&checkmate, SearchConfig { max_depth: 2 })
            .expect("reaction lines must run");

        assert!(lines.candidates.is_empty());
        assert!(lines.principal_line.is_empty());
        assert!(lines.mate_detected, "checkmate root must report mate");
    }

    #[test]
    fn reaction_lines_reject_out_of_range_depth() {
        let start = Position::startpos();
        assert_eq!(
            reaction_lines(&start, SearchConfig { max_depth: 0 }),
            Err(SearchError::InvalidDepth)
        );
        assert_eq!(
            reaction_lines(
                &start,
                SearchConfig {
                    max_depth: MAX_M8_DEPTH + 1
                }
            ),
            Err(SearchError::InvalidDepth)
        );
    }

    #[test]
    fn forcing_moves_surface_a_mate_in_one_first() {
        let mate_in_one = position("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1");
        let report = forcing_moves(&mate_in_one, SearchConfig { max_depth: 2 }, Color::White)
            .expect("forcing moves must run");

        assert!(report.on_turn, "white is on turn");
        let top = report.candidates.first().expect("a candidate must exist");
        assert_eq!(top.kind, ForcingKind::Mate);
        assert_eq!(top.mate_in, Some(1));
        assert_eq!(top.mv.to_coordinate(), "a1a8");
    }

    #[test]
    fn forcing_moves_are_empty_when_it_is_not_the_host_turn() {
        let start = Position::startpos();
        let report = forcing_moves(&start, SearchConfig { max_depth: 2 }, Color::Black)
            .expect("forcing moves must run");

        assert!(!report.on_turn, "black is not on turn at the start");
        assert!(report.candidates.is_empty());
    }

    #[test]
    fn forcing_moves_on_terminal_position_have_no_candidates() {
        let checkmate = position("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
        let report = forcing_moves(&checkmate, SearchConfig { max_depth: 2 }, Color::Black)
            .expect("forcing moves must run");

        assert!(report.on_turn, "black is the side to move");
        assert!(report.candidates.is_empty());
    }

    #[test]
    fn forcing_moves_order_tiers_from_most_to_least_forcing() {
        let tactical =
            position("r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1");
        let report = forcing_moves(&tactical, SearchConfig { max_depth: 2 }, Color::White)
            .expect("forcing moves must run");

        let tiers: Vec<u8> = report.candidates.iter().map(|c| c.tier()).collect();
        assert!(
            tiers.windows(2).all(|pair| pair[0] <= pair[1]),
            "candidates must be ordered by non-decreasing tier"
        );
        // Every sound move ranks ahead of every speculative (unsound) move.
        let last_sound = report.candidates.iter().rposition(|c| c.sound);
        let first_unsound = report.candidates.iter().position(|c| !c.sound);
        if let (Some(last_sound), Some(first_unsound)) = (last_sound, first_unsound) {
            assert!(
                last_sound < first_unsound,
                "no sound move may appear after a speculative one"
            );
        }
    }

    #[test]
    fn forcing_moves_demote_a_check_that_hangs_the_queen() {
        // White is up a queen; Qg7+ (b2-g7) is a legal check but the king simply captures it, so
        // it must not be surfaced above the quiet moves that keep the extra queen.
        let position = position("6k1/5p1p/8/8/8/8/1Q6/K7 w - - 0 1");
        let report = forcing_moves(&position, SearchConfig { max_depth: 2 }, Color::White)
            .expect("forcing moves must run");

        let index = report
            .candidates
            .iter()
            .position(|c| c.mv.to_coordinate() == "b2g7")
            .expect("the hanging check must be a candidate");
        let hanging = report.candidates[index];
        assert_eq!(hanging.kind, ForcingKind::Check);
        assert!(
            !hanging.sound,
            "a check that loses the queen must be unsound"
        );
        assert!(index > 0, "the hanging check must not lead the list");
        assert!(
            report.candidates[..index].iter().any(|c| c.sound),
            "a sound move must precede the hanging check"
        );
    }

    #[test]
    fn forcing_moves_reject_out_of_range_depth() {
        let start = Position::startpos();
        assert_eq!(
            forcing_moves(&start, SearchConfig { max_depth: 0 }, Color::White),
            Err(SearchError::InvalidDepth)
        );
        assert_eq!(
            forcing_moves(
                &start,
                SearchConfig {
                    max_depth: MAX_M8_DEPTH + 1
                },
                Color::White
            ),
            Err(SearchError::InvalidDepth)
        );
    }

    #[test]
    fn captures_outrank_quiet_moves_in_ordering() {
        // White pawn e4 may capture d5 or quietly push to e5.
        let position = position("4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1");
        let ordering = MoveOrdering::default();
        let capture = Move::from_coordinate("e4d5").expect("move must parse");
        let quiet = Move::from_coordinate("e4e5").expect("move must parse");

        assert!(
            ordering.move_order_key(&position, 0, None, capture)
                > ordering.move_order_key(&position, 0, None, quiet),
            "a capture must be ordered ahead of a quiet move"
        );
    }

    #[test]
    fn seed_move_is_ordered_ahead_of_an_unseeded_capture() {
        let position = position("4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1");
        let ordering = MoveOrdering::default();
        let quiet = Move::from_coordinate("e4e5").expect("move must parse");
        let capture = Move::from_coordinate("e4d5").expect("move must parse");

        assert!(
            ordering.move_order_key(&position, 0, Some(quiet), quiet)
                > ordering.move_order_key(&position, 0, Some(quiet), capture),
            "the iterative-deepening seed must be searched first"
        );
    }

    // A small budget keeps these tests fast in debug while still exercising the iterative-deepening
    // deep-lens path (the production budget lives in the bridge, not here).
    const DEEP_LENS_LIMITS: SearchLimits = SearchLimits {
        max_depth: MAX_PLAY_DEPTH,
        node_budget: Some(1_500),
    };

    #[test]
    fn deep_reaction_lines_rank_candidates_and_seed_the_line() {
        let start = Position::startpos();
        let lines = reaction_lines_deep(&start, DEEP_LENS_LIMITS).expect("deep reaction must run");

        assert_eq!(
            lines.candidates.len(),
            start.legal_moves().expect("legal moves").len()
        );
        let best = lines.candidates.first().expect("a best candidate");
        assert_eq!(
            lines.principal_line.first().copied(),
            Some(best.mv),
            "the projected line must start from the top candidate"
        );
        // Candidates are sorted best-first.
        assert!(
            lines
                .candidates
                .windows(2)
                .all(|pair| pair[0].score >= pair[1].score)
        );
    }

    #[test]
    fn deep_reaction_lines_are_deterministic() {
        let position = position("8/8/8/4k3/8/8/4K3/4R3 w - - 0 1");
        let first =
            reaction_lines_deep(&position, DEEP_LENS_LIMITS).expect("deep reaction must run");
        let second =
            reaction_lines_deep(&position, DEEP_LENS_LIMITS).expect("deep reaction must run");
        assert_eq!(first, second);
    }

    #[test]
    fn deep_reaction_lines_respect_the_node_budget() {
        // A tiny budget must bound the work; the deepest completed depth is reported and a legal
        // position always yields candidates. (The "reaches past the fixed M8 horizon" property is
        // verified end-to-end against the real WASM build, where the production budget applies.)
        let start = Position::startpos();
        let lines = reaction_lines_deep(
            &start,
            SearchLimits {
                max_depth: MAX_PLAY_DEPTH,
                node_budget: Some(800),
            },
        )
        .expect("deep reaction must run");

        assert!(!lines.candidates.is_empty());
        assert!(lines.depth >= 1);
    }

    #[test]
    fn deep_forcing_lens_flags_a_mate_in_one_for_the_host() {
        let position = position("7k/8/5K2/8/8/8/8/6Q1 w - - 0 1");
        let report = forcing_moves_deep(&position, DEEP_LENS_LIMITS, Color::White)
            .expect("deep forcing must run");

        assert!(report.on_turn);
        let top = report.candidates.first().expect("a forcing candidate");
        assert_eq!(top.kind, ForcingKind::Mate);
        assert_eq!(top.mate_in, Some(1));
        assert_eq!(top.mv, Move::from_coordinate("g1g7").expect("move parses"));
    }

    #[test]
    fn deep_forcing_lens_is_idle_when_not_the_host_turn() {
        let position = position("7k/8/5K2/8/8/8/8/6Q1 w - - 0 1");
        let report = forcing_moves_deep(&position, DEEP_LENS_LIMITS, Color::Black)
            .expect("deep forcing must run");

        assert!(!report.on_turn);
        assert!(report.candidates.is_empty());
    }
}
