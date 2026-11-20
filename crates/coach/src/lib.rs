use chess_board::{
    Color, File, Move, PgnGame, Piece, PieceKind, Position, PositionStatus, Rank, Square,
};
use chess_search::{MATE_SCORE, MAX_M8_DEPTH, SearchConfig, SearchError, search};
use core::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CoachConfig {
    pub search_depth: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MoveLabel {
    Best,
    Good,
    Inaccuracy,
    Mistake,
    Blunder,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReviewEntry {
    pub ply: usize,
    pub played_move: Move,
    pub san: String,
    pub best_move: Option<Move>,
    pub best_score_cp: i32,
    pub played_score_cp: i32,
    pub cp_loss: u32,
    pub label: MoveLabel,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReviewSummary {
    pub total_moves: usize,
    pub best: usize,
    pub good: usize,
    pub inaccuracies: usize,
    pub mistakes: usize,
    pub blunders: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GameReview {
    pub entries: Vec<ReviewEntry>,
    pub summary: ReviewSummary,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeyMomentKind {
    CentipawnLoss,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KeyMomentConfig {
    pub max_moments: usize,
    pub minimum_label: MoveLabel,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeyMoment {
    pub rank: usize,
    pub entry_index: usize,
    pub kind: KeyMomentKind,
    pub entry: ReviewEntry,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceKind {
    LocalSearchSwing,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MoveEvidence {
    pub rank: usize,
    pub entry_index: usize,
    pub ply: usize,
    pub kind: EvidenceKind,
    pub played_move: Move,
    pub san: String,
    pub best_move: Option<Move>,
    pub best_score_cp: i32,
    pub played_score_cp: i32,
    pub cp_loss: u32,
    pub label: MoveLabel,
}

pub const EARLY_MOVE_DIVERGENCE_MAX_PLIES: usize = 10;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EarlyMoveDivergenceConfig {
    pub minimum_cp_loss: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EarlyMoveDivergence {
    pub entry_index: usize,
    pub ply: usize,
    pub played_move: Move,
    pub san: String,
    pub local_best_move: Move,
    pub best_score_cp: i32,
    pub played_score_cp: i32,
    pub cp_loss: u32,
    pub label: MoveLabel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetryConfig {
    pub max_positions: usize,
    pub minimum_label: MoveLabel,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetryPosition {
    pub rank: usize,
    pub entry_index: usize,
    pub ply: usize,
    pub fen_before: String,
    pub played_move: Move,
    pub best_move: Option<Move>,
    pub san: String,
    pub label: MoveLabel,
    pub cp_loss: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ForkCandidateSourceKind {
    BestMoveAfterPosition,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ForkTarget {
    pub square: Square,
    pub piece: Piece,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForkCandidateEvidence {
    pub rank: usize,
    pub entry_index: usize,
    pub ply: usize,
    pub source_kind: ForkCandidateSourceKind,
    pub best_move: Move,
    pub moved_piece: Piece,
    pub destination: Square,
    pub targets: Vec<ForkTarget>,
    pub cp_loss: u32,
    pub label: MoveLabel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoachError {
    InvalidDepth,
    IllegalMove,
    InvalidPosition,
    SearchFailed,
    InconsistentReview,
}

impl fmt::Display for CoachError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDepth => formatter.write_str("coach search depth is outside 2..=6"),
            Self::IllegalMove => formatter.write_str("coach input contains an illegal move"),
            Self::InvalidPosition => formatter.write_str("coach position cannot be reviewed"),
            Self::SearchFailed => formatter.write_str("coach search failed"),
            Self::InconsistentReview => {
                formatter.write_str("coach review does not match the supplied game history")
            }
        }
    }
}

impl std::error::Error for CoachError {}

pub fn review_coordinate_game(
    moves: &[Move],
    config: CoachConfig,
) -> Result<GameReview, CoachError> {
    if !(2..=MAX_M8_DEPTH).contains(&config.search_depth) {
        return Err(CoachError::InvalidDepth);
    }

    let mut position = Position::startpos();
    let mut entries = Vec::with_capacity(moves.len());
    let mut summary = ReviewSummary::default();

    for (index, played_move) in moves.iter().copied().enumerate() {
        let san = position
            .move_to_san(played_move)
            .map_err(|_error| CoachError::IllegalMove)?;
        let root_search = search(
            &position,
            SearchConfig {
                max_depth: config.search_depth,
            },
        )
        .map_err(map_search_error)?;
        let child = position
            .after_legal_move(played_move)
            .map_err(|_error| CoachError::IllegalMove)?;
        let best_score_cp = root_search.score;
        let played_score_cp = if root_search.best_move == Some(played_move) {
            best_score_cp
        } else {
            score_played_child(&child, config.search_depth)?
        };
        let cp_loss = centipawn_loss(best_score_cp, played_score_cp);
        let label = label_for_loss(cp_loss);

        summary.record(label);
        entries.push(ReviewEntry {
            ply: index + 1,
            played_move,
            san,
            best_move: root_search.best_move,
            best_score_cp,
            played_score_cp,
            cp_loss,
            label,
        });
        position = child;
    }

    Ok(GameReview { entries, summary })
}

pub fn review_pgn_game(game: &PgnGame, config: CoachConfig) -> Result<GameReview, CoachError> {
    review_coordinate_game(game.moves(), config)
}

pub fn select_key_moments(review: &GameReview, config: KeyMomentConfig) -> Vec<KeyMoment> {
    if config.max_moments == 0 {
        return Vec::new();
    }

    let mut moments = review
        .entries
        .iter()
        .cloned()
        .enumerate()
        .filter(|(_index, entry)| {
            label_severity(entry.label) >= label_severity(config.minimum_label)
        })
        .collect::<Vec<_>>();
    moments.sort_by(|(left_index, left), (right_index, right)| {
        label_severity(right.label)
            .cmp(&label_severity(left.label))
            .then_with(|| right.cp_loss.cmp(&left.cp_loss))
            .then_with(|| left_index.cmp(right_index))
    });

    moments
        .into_iter()
        .take(config.max_moments)
        .enumerate()
        .map(|(rank_index, (entry_index, entry))| KeyMoment {
            rank: rank_index + 1,
            entry_index,
            kind: KeyMomentKind::CentipawnLoss,
            entry,
        })
        .collect()
}

pub fn collect_key_moment_evidence(moments: &[KeyMoment]) -> Vec<MoveEvidence> {
    moments
        .iter()
        .filter(|moment| moment.entry.cp_loss > 0)
        .map(|moment| MoveEvidence {
            rank: moment.rank,
            entry_index: moment.entry_index,
            ply: moment.entry.ply,
            kind: EvidenceKind::LocalSearchSwing,
            played_move: moment.entry.played_move,
            san: moment.entry.san.clone(),
            best_move: moment.entry.best_move,
            best_score_cp: moment.entry.best_score_cp,
            played_score_cp: moment.entry.played_score_cp,
            cp_loss: moment.entry.cp_loss,
            label: moment.entry.label,
        })
        .collect()
}

pub fn select_early_move_divergences(
    review: &GameReview,
    config: EarlyMoveDivergenceConfig,
) -> Vec<EarlyMoveDivergence> {
    review
        .entries
        .iter()
        .enumerate()
        .filter_map(|(entry_index, entry)| {
            let local_best_move = entry.best_move?;
            if entry.ply == 0
                || entry.ply > EARLY_MOVE_DIVERGENCE_MAX_PLIES
                || entry.played_move == local_best_move
                || entry.cp_loss == 0
                || entry.cp_loss < config.minimum_cp_loss
            {
                return None;
            }

            Some(EarlyMoveDivergence {
                entry_index,
                ply: entry.ply,
                played_move: entry.played_move,
                san: entry.san.clone(),
                local_best_move,
                best_score_cp: entry.best_score_cp,
                played_score_cp: entry.played_score_cp,
                cp_loss: entry.cp_loss,
                label: entry.label,
            })
        })
        .collect()
}

pub fn generate_retry_positions(
    moves: &[Move],
    review: &GameReview,
    config: RetryConfig,
) -> Result<Vec<RetryPosition>, CoachError> {
    if config.max_positions == 0 {
        return Ok(Vec::new());
    }

    let moments = select_key_moments(
        review,
        KeyMomentConfig {
            max_moments: config.max_positions,
            minimum_label: config.minimum_label,
        },
    );
    let fen_before = replay_fens_before_moves(moves)?;
    if moments.is_empty() {
        return Ok(Vec::new());
    }

    moments
        .into_iter()
        .map(|moment| retry_position_from_moment(moment, moves, &fen_before))
        .collect()
}

pub fn collect_fork_candidate_evidence(
    retry_positions: &[RetryPosition],
) -> Result<Vec<ForkCandidateEvidence>, CoachError> {
    retry_positions
        .iter()
        .filter_map(fork_candidate_from_retry_position)
        .collect()
}

fn score_played_child(child: &Position, search_depth: u8) -> Result<i32, CoachError> {
    match child
        .status()
        .map_err(|_error| CoachError::InvalidPosition)?
    {
        PositionStatus::Checkmate => Ok(MATE_SCORE - 1),
        PositionStatus::Stalemate => Ok(0),
        PositionStatus::Ongoing => {
            let child_search = search(
                child,
                SearchConfig {
                    max_depth: search_depth - 1,
                },
            )
            .map_err(map_search_error)?;
            Ok(-child_search.score)
        }
    }
}

fn fork_candidate_from_retry_position(
    retry: &RetryPosition,
) -> Option<Result<ForkCandidateEvidence, CoachError>> {
    let best_move = retry.best_move?;
    let position = match Position::from_fen(&retry.fen_before) {
        Ok(position) => position,
        Err(_error) => return Some(Err(CoachError::InvalidPosition)),
    };
    let after = match position.after_legal_move(best_move) {
        Ok(after) => after,
        Err(_error) => return None,
    };
    let moved_piece = after.piece_at(best_move.to())?;
    let targets = qualifying_fork_targets(&after, best_move.to(), moved_piece);
    if targets.len() < 2 {
        return None;
    }
    let moved_piece_is_capturable =
        match moved_piece_is_immediately_capturable(&after, best_move.to(), moved_piece) {
            Ok(value) => value,
            Err(error) => return Some(Err(error)),
        };
    if moved_piece_is_capturable {
        return None;
    }

    Some(Ok(ForkCandidateEvidence {
        rank: retry.rank,
        entry_index: retry.entry_index,
        ply: retry.ply,
        source_kind: ForkCandidateSourceKind::BestMoveAfterPosition,
        best_move,
        moved_piece,
        destination: best_move.to(),
        targets,
        cp_loss: retry.cp_loss,
        label: retry.label,
    }))
}

fn qualifying_fork_targets(
    position: &Position,
    attacker_square: Square,
    attacker: Piece,
) -> Vec<ForkTarget> {
    let attacked_targets = attacked_enemy_targets(position, attacker_square, attacker);
    let has_king_target = attacked_targets
        .iter()
        .any(|target| target.piece.kind() == PieceKind::King);
    attacked_targets
        .into_iter()
        .filter(|target| is_qualifying_fork_target(*target, has_king_target))
        .filter(|target| !target_is_defended(position, *target))
        .collect()
}

const fn is_qualifying_fork_target(target: ForkTarget, has_king_target: bool) -> bool {
    match target.piece.kind() {
        PieceKind::King
        | PieceKind::Queen
        | PieceKind::Rook
        | PieceKind::Bishop
        | PieceKind::Knight => true,
        PieceKind::Pawn => has_king_target,
    }
}

fn target_is_defended(position: &Position, target: ForkTarget) -> bool {
    if target.piece.kind() == PieceKind::King {
        return false;
    }

    for rank in RANKS {
        for file in FILES {
            let defender_square = Square::new(file, rank);
            if defender_square == target.square {
                continue;
            }
            let Some(defender) = position.piece_at(defender_square) else {
                continue;
            };
            if defender.color() == target.piece.color()
                && piece_attacks_square(position, defender_square, defender, target.square)
            {
                return true;
            }
        }
    }

    false
}

fn moved_piece_is_immediately_capturable(
    position: &Position,
    destination: Square,
    moved_piece: Piece,
) -> Result<bool, CoachError> {
    if position.piece_at(destination) != Some(moved_piece) {
        return Ok(true);
    }
    let legal_replies = position
        .legal_moves()
        .map_err(|_error| CoachError::InvalidPosition)?;
    Ok(legal_replies
        .into_iter()
        .any(|reply| reply.to() == destination))
}

fn attacked_enemy_targets(
    position: &Position,
    attacker_square: Square,
    attacker: Piece,
) -> Vec<ForkTarget> {
    let mut targets = Vec::new();
    for rank in RANKS {
        for file in FILES {
            let target_square = Square::new(file, rank);
            let Some(target_piece) = position.piece_at(target_square) else {
                continue;
            };
            if target_piece.color() == attacker.color()
                || !piece_attacks_square(position, attacker_square, attacker, target_square)
            {
                continue;
            }
            targets.push(ForkTarget {
                square: target_square,
                piece: target_piece,
            });
        }
    }
    targets.sort_by_key(|target| target.square.to_algebraic());
    targets
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
        PieceKind::King => file_delta.abs() <= 1 && rank_delta.abs() <= 1,
        PieceKind::Queen => {
            is_clear_diagonal(position, attacker_square, target_square)
                || is_clear_orthogonal(position, attacker_square, target_square)
        }
        PieceKind::Rook => is_clear_orthogonal(position, attacker_square, target_square),
        PieceKind::Bishop => is_clear_diagonal(position, attacker_square, target_square),
        PieceKind::Knight => {
            matches!((file_delta.abs(), rank_delta.abs()), (1, 2) | (2, 1))
        }
        PieceKind::Pawn => {
            rank_delta == pawn_attack_rank_delta(attacker.color()) && file_delta.abs() == 1
        }
    }
}

fn is_clear_diagonal(position: &Position, from: Square, to: Square) -> bool {
    let (from_file, from_rank) = square_coordinates(from);
    let (to_file, to_rank) = square_coordinates(to);
    let file_delta = to_file - from_file;
    let rank_delta = to_rank - from_rank;
    if file_delta.abs() != rank_delta.abs() {
        return false;
    }
    is_clear_ray(
        position,
        from_file,
        from_rank,
        to_file,
        to_rank,
        file_delta.signum(),
        rank_delta.signum(),
    )
}

fn is_clear_orthogonal(position: &Position, from: Square, to: Square) -> bool {
    let (from_file, from_rank) = square_coordinates(from);
    let (to_file, to_rank) = square_coordinates(to);
    let file_delta = to_file - from_file;
    let rank_delta = to_rank - from_rank;
    if file_delta != 0 && rank_delta != 0 {
        return false;
    }
    is_clear_ray(
        position,
        from_file,
        from_rank,
        to_file,
        to_rank,
        file_delta.signum(),
        rank_delta.signum(),
    )
}

fn is_clear_ray(
    position: &Position,
    from_file: i8,
    from_rank: i8,
    to_file: i8,
    to_rank: i8,
    file_step: i8,
    rank_step: i8,
) -> bool {
    let mut file = from_file + file_step;
    let mut rank = from_rank + rank_step;
    while file != to_file || rank != to_rank {
        let Some(square) = square_from_coordinates(file, rank) else {
            return false;
        };
        if position.piece_at(square).is_some() {
            return false;
        }
        file += file_step;
        rank += rank_step;
    }
    true
}

const fn pawn_attack_rank_delta(color: Color) -> i8 {
    match color {
        Color::White => 1,
        Color::Black => -1,
    }
}

fn square_coordinates(square: Square) -> (i8, i8) {
    (
        coordinate_index(square.file(), FILES),
        coordinate_index(square.rank(), RANKS),
    )
}

fn coordinate_index<T: Eq + Copy, const LEN: usize>(value: T, values: [T; LEN]) -> i8 {
    values
        .iter()
        .position(|candidate| *candidate == value)
        .and_then(|index| i8::try_from(index).ok())
        .unwrap_or(0)
}

fn square_from_coordinates(file: i8, rank: i8) -> Option<Square> {
    let file = FILES.get(usize::try_from(file).ok()?).copied()?;
    let rank = RANKS.get(usize::try_from(rank).ok()?).copied()?;
    Some(Square::new(file, rank))
}

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

fn replay_fens_before_moves(moves: &[Move]) -> Result<Vec<String>, CoachError> {
    let mut position = Position::startpos();
    let mut fen_before = Vec::with_capacity(moves.len());

    for mv in moves {
        fen_before.push(position.to_fen());
        position = position
            .after_legal_move(*mv)
            .map_err(|_error| CoachError::IllegalMove)?;
    }

    Ok(fen_before)
}

fn retry_position_from_moment(
    moment: KeyMoment,
    moves: &[Move],
    fen_before: &[String],
) -> Result<RetryPosition, CoachError> {
    let Some(expected_move) = moves.get(moment.entry_index).copied() else {
        return Err(CoachError::InconsistentReview);
    };
    if moment.entry.ply != moment.entry_index + 1 || moment.entry.played_move != expected_move {
        return Err(CoachError::InconsistentReview);
    }
    let Some(fen) = fen_before.get(moment.entry_index) else {
        return Err(CoachError::InconsistentReview);
    };

    Ok(RetryPosition {
        rank: moment.rank,
        entry_index: moment.entry_index,
        ply: moment.entry.ply,
        fen_before: fen.clone(),
        played_move: moment.entry.played_move,
        best_move: moment.entry.best_move,
        san: moment.entry.san,
        label: moment.entry.label,
        cp_loss: moment.entry.cp_loss,
    })
}

fn centipawn_loss(best_score_cp: i32, played_score_cp: i32) -> u32 {
    let loss = best_score_cp.saturating_sub(played_score_cp);
    if loss <= 0 {
        0
    } else {
        u32::try_from(loss).unwrap_or(u32::MAX)
    }
}

fn label_for_loss(cp_loss: u32) -> MoveLabel {
    match cp_loss {
        0 => MoveLabel::Best,
        1..=50 => MoveLabel::Good,
        51..=150 => MoveLabel::Inaccuracy,
        151..=300 => MoveLabel::Mistake,
        _ => MoveLabel::Blunder,
    }
}

const fn label_severity(label: MoveLabel) -> u8 {
    match label {
        MoveLabel::Best => 0,
        MoveLabel::Good => 1,
        MoveLabel::Inaccuracy => 2,
        MoveLabel::Mistake => 3,
        MoveLabel::Blunder => 4,
    }
}

impl ReviewSummary {
    fn record(&mut self, label: MoveLabel) {
        self.total_moves += 1;
        match label {
            MoveLabel::Best => self.best += 1,
            MoveLabel::Good => self.good += 1,
            MoveLabel::Inaccuracy => self.inaccuracies += 1,
            MoveLabel::Mistake => self.mistakes += 1,
            MoveLabel::Blunder => self.blunders += 1,
        }
    }
}

fn map_search_error(error: SearchError) -> CoachError {
    match error {
        SearchError::InvalidDepth => CoachError::InvalidDepth,
        SearchError::InvalidPosition => CoachError::InvalidPosition,
    }
}

#[cfg(test)]
mod tests {
    use super::{MoveLabel, centipawn_loss, label_for_loss, score_played_child};
    use chess_board::Position;
    use chess_search::MATE_SCORE;

    #[test]
    fn centipawn_loss_clamps_negative_deltas_to_zero() {
        assert_eq!(centipawn_loss(25, 50), 0);
        assert_eq!(centipawn_loss(50, 50), 0);
        assert_eq!(centipawn_loss(300, 50), 250);
    }

    #[test]
    fn label_thresholds_match_phase_two_contract() {
        assert_eq!(label_for_loss(0), MoveLabel::Best);
        assert_eq!(label_for_loss(1), MoveLabel::Good);
        assert_eq!(label_for_loss(50), MoveLabel::Good);
        assert_eq!(label_for_loss(51), MoveLabel::Inaccuracy);
        assert_eq!(label_for_loss(150), MoveLabel::Inaccuracy);
        assert_eq!(label_for_loss(151), MoveLabel::Mistake);
        assert_eq!(label_for_loss(300), MoveLabel::Mistake);
        assert_eq!(label_for_loss(301), MoveLabel::Blunder);
    }

    #[test]
    fn played_child_terminal_scores_match_phase_two_contract() {
        let checkmate =
            Position::from_fen("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1").expect("test FEN must parse");
        let stalemate =
            Position::from_fen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1").expect("test FEN must parse");

        assert_eq!(score_played_child(&checkmate, 3), Ok(MATE_SCORE - 1));
        assert_eq!(score_played_child(&stalemate, 3), Ok(0));
    }
}
