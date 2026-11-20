//! Static exchange evaluation (SEE) and a move-level hanging-material check.
//!
//! SEE answers one question without any search: if a capture sequence plays out on a single square,
//! with each side always bringing its least valuable attacker and stopping once continuing would
//! lose material, what is the net material for the side that strikes first? Because it is purely
//! static it is depth-independent and deterministic — which is exactly what the reaction lens needs
//! to flag a suggestion that drops a piece even when the shallow search score has not yet resolved
//! the loss, and to catch the case the relative-score colouring cannot: a *best* move that itself
//! hangs material (every alternative is measured against it, so nothing looks worse).
//!
//! The board is a mailbox, so attackers are found by scanning leaper offsets and slider rays from
//! the target square. X-ray attackers (a rook behind a rook, a queen behind a bishop) fall out for
//! free: a square whose piece has already entered the exchange is treated as empty when the next
//! attacker is sought, so the piece behind it is revealed.

use chess_board::{Color, File, Move, Piece, PieceKind, Position, Rank, Square};
use chess_eval::{BISHOP_VALUE, KNIGHT_VALUE, PAWN_VALUE, QUEEN_VALUE, ROOK_VALUE};

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

/// King value for the swap algorithm. Large enough that the minimax never trades into capturing a
/// defended king (an illegal move), so a king only takes part as the final, unanswered capture.
const KING_SEE_VALUE: i32 = 1_000_000;

/// A move is treated as hanging material when the opponent can win at least this much (in
/// centipawns) by capturing the just-moved piece on its destination square. Set above a pawn so a
/// gambit or an even trade does not trip it; a dropped minor piece or worse does.
pub const HANGING_MATERIAL_THRESHOLD: i32 = 200;

const KNIGHT_OFFSETS: [(i8, i8); 8] = [
    (1, 2),
    (2, 1),
    (2, -1),
    (1, -2),
    (-1, -2),
    (-2, -1),
    (-2, 1),
    (-1, 2),
];
const KING_OFFSETS: [(i8, i8); 8] = [
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
    (1, -1),
];
const DIAGONAL_DIRECTIONS: [(i8, i8); 4] = [(-1, -1), (-1, 1), (1, -1), (1, 1)];
const ORTHOGONAL_DIRECTIONS: [(i8, i8); 4] = [(-1, 0), (0, -1), (0, 1), (1, 0)];

const fn piece_see_value(kind: PieceKind) -> i32 {
    match kind {
        PieceKind::Pawn => PAWN_VALUE,
        PieceKind::Knight => KNIGHT_VALUE,
        PieceKind::Bishop => BISHOP_VALUE,
        PieceKind::Rook => ROOK_VALUE,
        PieceKind::Queen => QUEEN_VALUE,
        PieceKind::King => KING_SEE_VALUE,
    }
}

/// Returns whether `mv` leaves the moved piece hanging on its destination — i.e. after the move the
/// opponent can win [`HANGING_MATERIAL_THRESHOLD`] or more by capturing on that square under optimal
/// recapture play. Illegal or non-applicable moves report `false`.
///
/// This scopes the signal to the piece the move just placed (or promoted). For the complementary
/// case — moving a defender away and leaving a *different* own piece hanging — see
/// [`move_leaves_piece_hanging`].
#[must_use]
pub fn move_hangs_material(parent: &Position, mv: Move) -> bool {
    let Ok(child) = parent.after_legal_move(mv) else {
        return false;
    };
    // After the move it is the opponent's turn; they are the side that would capture.
    let opponent = child.side_to_move();
    move_hangs_material_on_child(&child, mv, opponent)
}

/// Returns whether `mv` abandons a defender and leaves any *other* own piece newly hanging — i.e.
/// after the move the opponent can win [`HANGING_MATERIAL_THRESHOLD`] or more on a square that is
/// not `mv`'s destination, **and** that piece was not already at that exposure level before the
/// move. Complements [`move_hangs_material`], which only checks the moved piece.
///
/// Purely static: no search, depth-independent. The gate uses this alongside the objective score
/// so that a move that looks acceptable on a shallow search but silently exposes material is caught
/// before it is played.
#[must_use]
pub fn move_leaves_piece_hanging(parent: &Position, mv: Move) -> bool {
    let Ok(child) = parent.after_legal_move(mv) else {
        return false;
    };
    let opponent = child.side_to_move();
    move_leaves_piece_hanging_on_child(parent, mv, &child, opponent)
}

fn move_hangs_material_on_child(child: &Position, mv: Move, opponent: Color) -> bool {
    static_exchange_eval(child, mv.to(), opponent) >= HANGING_MATERIAL_THRESHOLD
}

fn move_leaves_piece_hanging_on_child(
    parent: &Position,
    mv: Move,
    child: &Position,
    opponent: Color,
) -> bool {
    let mover = parent.side_to_move();
    for rank in RANKS {
        for file in FILES {
            let square = Square::new(file, rank);
            if square == mv.to() {
                continue; // covered by move_hangs_material
            }
            let Some(piece) = child.piece_at(square) else {
                continue;
            };
            if piece.color() != mover {
                continue;
            }
            // Only flag pieces that were safe before this move. Pieces already exposed before are
            // not the move's fault and do not contribute to the hanging signal.
            if static_exchange_eval(parent, square, opponent) >= HANGING_MATERIAL_THRESHOLD {
                continue;
            }
            if static_exchange_eval(child, square, opponent) >= HANGING_MATERIAL_THRESHOLD {
                return true;
            }
        }
    }
    false
}

/// Static exchange evaluation: the net material, in centipawns, that `attacking_side` gains by
/// initiating a capture sequence on `target`, assuming both sides always recapture with their least
/// valuable attacker and stop once continuing would cost material. Returns `0` when `target` is
/// empty or `attacking_side` has no attacker (no capture happens).
#[must_use]
pub fn static_exchange_eval(position: &Position, target: Square, attacking_side: Color) -> i32 {
    let Some(victim) = position.piece_at(target) else {
        return 0;
    };

    let mut removed: Vec<Square> = Vec::new();
    let mut target_piece = victim;
    let Some((mut from, mut attacker_kind)) =
        least_valuable_attacker(position, target, attacking_side, &removed, target_piece)
    else {
        return 0;
    };

    // `gain[n]` is the negamax-pending material balance after the n-th capture. `gain[0]` is the
    // first victim's value; each later entry is "the value now sitting on the square minus what the
    // opponent already stands to net", which the fold at the end resolves into the optimal line.
    let mut gain = [0_i32; 32];
    gain[0] = piece_see_value(victim.kind());
    let mut side = attacking_side;
    let mut depth = 0_usize;

    loop {
        depth += 1;
        if depth >= gain.len() {
            depth -= 1;
            break;
        }
        gain[depth] = piece_see_value(attacker_kind) - gain[depth - 1];
        removed.push(from);
        target_piece = Piece::new(side, attacker_kind);
        side = side.opposite();
        match least_valuable_attacker(position, target, side, &removed, target_piece) {
            Some((next_from, next_kind)) => {
                from = next_from;
                attacker_kind = next_kind;
            }
            None => break,
        }
    }

    // Fold the swap list back: at each step the side to move would only continue the exchange when
    // it does not worsen its own result, so each balance is `-max(-balance, deeper)`.
    while depth > 1 {
        depth -= 1;
        gain[depth - 1] = -i32::max(-gain[depth - 1], gain[depth]);
    }
    gain[0]
}

/// Finds the lowest-valued `side` piece that attacks `target`, ignoring squares in `removed` (the
/// pieces already consumed earlier in the exchange). Re-scanning against `removed` is what surfaces
/// X-ray attackers.
fn least_valuable_attacker(
    position: &Position,
    target: Square,
    side: Color,
    removed: &[Square],
    target_piece: Piece,
) -> Option<(Square, PieceKind)> {
    let mut best: Option<(Square, PieceKind)> = None;
    let mut consider = |square: Square, kind: PieceKind| {
        if see_capture_is_legal(position, target, side, square, kind, removed, target_piece)
            && best.is_none_or(|(_, current)| piece_see_value(kind) < piece_see_value(current))
        {
            best = Some((square, kind));
        }
    };

    // Pawns attack the target from the two squares diagonally behind it, relative to their march.
    let pawn_rank_delta = match side {
        Color::White => -1,
        Color::Black => 1,
    };
    for file_delta in [-1, 1] {
        if let Some(origin) = target.offset(file_delta, pawn_rank_delta) {
            if !removed.contains(&origin) && is_piece(position, origin, side, PieceKind::Pawn) {
                consider(origin, PieceKind::Pawn);
            }
        }
    }

    for (file_delta, rank_delta) in KNIGHT_OFFSETS {
        if let Some(origin) = target.offset(file_delta, rank_delta) {
            if !removed.contains(&origin) && is_piece(position, origin, side, PieceKind::Knight) {
                consider(origin, PieceKind::Knight);
            }
        }
    }

    for (file_delta, rank_delta) in KING_OFFSETS {
        if let Some(origin) = target.offset(file_delta, rank_delta) {
            if !removed.contains(&origin) && is_piece(position, origin, side, PieceKind::King) {
                consider(origin, PieceKind::King);
            }
        }
    }

    for direction in DIAGONAL_DIRECTIONS {
        if let Some((square, piece_kind)) = first_piece_on_ray(position, target, direction, removed)
        {
            if is_piece(position, square, side, piece_kind)
                && matches!(piece_kind, PieceKind::Bishop | PieceKind::Queen)
            {
                consider(square, piece_kind);
            }
        }
    }

    for direction in ORTHOGONAL_DIRECTIONS {
        if let Some((square, piece_kind)) = first_piece_on_ray(position, target, direction, removed)
        {
            if is_piece(position, square, side, piece_kind)
                && matches!(piece_kind, PieceKind::Rook | PieceKind::Queen)
            {
                consider(square, piece_kind);
            }
        }
    }

    best
}

fn see_capture_is_legal(
    position: &Position,
    target: Square,
    side: Color,
    from: Square,
    kind: PieceKind,
    removed: &[Square],
    target_piece: Piece,
) -> bool {
    let occupant = Piece::new(side, kind);
    let king_square = if kind == PieceKind::King {
        target
    } else {
        let Some(square) = find_virtual_king(position, side, target, target_piece, removed) else {
            return false;
        };
        square
    };
    !virtual_square_is_attacked(
        position,
        king_square,
        side.opposite(),
        target,
        occupant,
        removed,
        from,
    )
}

fn find_virtual_king(
    position: &Position,
    side: Color,
    target: Square,
    target_piece: Piece,
    removed: &[Square],
) -> Option<Square> {
    for rank in RANKS {
        for file in FILES {
            let square = Square::new(file, rank);
            if virtual_piece_at(position, square, target, target_piece, removed, None)
                == Some(Piece::new(side, PieceKind::King))
            {
                return Some(square);
            }
        }
    }
    None
}

fn virtual_square_is_attacked(
    position: &Position,
    target_square: Square,
    attacking_side: Color,
    exchange_target: Square,
    exchange_occupant: Piece,
    removed: &[Square],
    moving_from: Square,
) -> bool {
    for rank in RANKS {
        for file in FILES {
            let attacker_square = Square::new(file, rank);
            let Some(attacker) = virtual_piece_at(
                position,
                attacker_square,
                exchange_target,
                exchange_occupant,
                removed,
                Some(moving_from),
            ) else {
                continue;
            };
            if attacker.color() == attacking_side
                && virtual_piece_attacks_square(
                    position,
                    attacker_square,
                    attacker,
                    target_square,
                    exchange_target,
                    exchange_occupant,
                    removed,
                    moving_from,
                )
            {
                return true;
            }
        }
    }
    false
}

#[allow(clippy::too_many_arguments)]
fn virtual_piece_attacks_square(
    position: &Position,
    from: Square,
    piece: Piece,
    target: Square,
    exchange_target: Square,
    exchange_occupant: Piece,
    removed: &[Square],
    moving_from: Square,
) -> bool {
    let delta = |direction: (i8, i8)| {
        let mut square = from;
        loop {
            square = square.offset(direction.0, direction.1)?;
            if square == target {
                return Some(true);
            }
            if virtual_piece_at(
                position,
                square,
                exchange_target,
                exchange_occupant,
                removed,
                Some(moving_from),
            )
            .is_some()
            {
                return Some(false);
            }
        }
    };
    let reaches = |directions: &[(i8, i8)]| {
        directions
            .iter()
            .any(|&direction| delta(direction) == Some(true))
    };

    match piece.kind() {
        PieceKind::Pawn => {
            let rank_delta = if piece.color() == Color::White { 1 } else { -1 };
            [-1, 1]
                .into_iter()
                .filter_map(|file_delta| from.offset(file_delta, rank_delta))
                .any(|square| square == target)
        }
        PieceKind::Knight => KNIGHT_OFFSETS
            .iter()
            .filter_map(|&(file_delta, rank_delta)| from.offset(file_delta, rank_delta))
            .any(|square| square == target),
        PieceKind::King => KING_OFFSETS
            .iter()
            .filter_map(|&(file_delta, rank_delta)| from.offset(file_delta, rank_delta))
            .any(|square| square == target),
        PieceKind::Bishop => reaches(&DIAGONAL_DIRECTIONS),
        PieceKind::Rook => reaches(&ORTHOGONAL_DIRECTIONS),
        PieceKind::Queen => reaches(&DIAGONAL_DIRECTIONS) || reaches(&ORTHOGONAL_DIRECTIONS),
    }
}

fn virtual_piece_at(
    position: &Position,
    square: Square,
    target: Square,
    target_piece: Piece,
    removed: &[Square],
    moving_from: Option<Square>,
) -> Option<Piece> {
    if moving_from == Some(square) || removed.contains(&square) {
        None
    } else if square == target {
        Some(target_piece)
    } else {
        position.piece_at(square)
    }
}

fn is_piece(position: &Position, square: Square, color: Color, kind: PieceKind) -> bool {
    matches!(position.piece_at(square), Some(piece) if piece.color() == color && piece.kind() == kind)
}

/// Walks outward from `target` along `direction` and returns the first occupied, non-removed square
/// with its piece kind. Removed squares are treated as empty so a piece behind a consumed attacker
/// is revealed (the X-ray).
fn first_piece_on_ray(
    position: &Position,
    target: Square,
    direction: (i8, i8),
    removed: &[Square],
) -> Option<(Square, PieceKind)> {
    let (file_delta, rank_delta) = direction;
    let mut current = target;
    loop {
        current = current.offset(file_delta, rank_delta)?;
        if removed.contains(&current) {
            continue;
        }
        if let Some(piece) = position.piece_at(current) {
            return Some((current, piece.kind()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chess_board::Square;

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    fn square(text: &str) -> Square {
        Square::from_algebraic(text).expect("test square must parse")
    }

    fn mv(text: &str) -> Move {
        Move::from_coordinate(text).expect("test move must parse")
    }

    #[test]
    fn capturing_an_undefended_pawn_wins_a_full_pawn() {
        // White rook on a1, lone Black pawn on a7: Rxa7 wins it outright.
        let position = position("4k3/p7/8/8/8/8/8/R3K3 w - - 0 1");
        assert_eq!(
            static_exchange_eval(&position, square("a7"), Color::White),
            PAWN_VALUE
        );
    }

    #[test]
    fn trading_pawns_on_a_defended_square_is_even() {
        // White pawn d4 and Black pawns c5 (target) defended by b6 pawn. d4xc5, b6xc5 nets zero.
        let position = position("4k3/8/1p6/2p5/3P4/8/8/4K3 w - - 0 1");
        assert_eq!(
            static_exchange_eval(&position, square("c5"), Color::White),
            0
        );
    }

    #[test]
    fn taking_a_defended_pawn_with_the_queen_loses_the_difference() {
        // White queen on h5 can take the f7 pawn, but the Black king on e8 defends f7: QxP then KxQ.
        let position = position("4k3/5p2/8/7Q/8/8/8/4K3 w - - 0 1");
        assert_eq!(
            static_exchange_eval(&position, square("f7"), Color::White),
            PAWN_VALUE - QUEEN_VALUE
        );
    }

    #[test]
    fn xray_attacker_behind_a_rook_continues_the_exchange() {
        // Doubled White rooks on e1/e2 bear on the Black rook e7, defended once by the e8 rook.
        // RxR, RxR, RxR: White nets a rook (the second White rook is the X-ray attacker revealed
        // once the first rook is consumed).
        let position = position("4r2k/4r3/8/8/8/8/4R3/4R1K1 w - - 0 1");
        assert_eq!(
            static_exchange_eval(&position, square("e7"), Color::White),
            ROOK_VALUE
        );
    }

    #[test]
    fn absolutely_pinned_rook_is_not_a_legal_attacker() {
        // Black Re7 geometrically attacks the White bishop on a7, but moving off the e-file exposes
        // Black Ke8 to White Re1. Rxa7 is illegal, and the king cannot reach a7.
        let position = position("4k3/B3r3/8/8/8/8/8/4R1K1 b - - 0 1");
        assert_eq!(
            static_exchange_eval(&position, square("a7"), Color::Black),
            0
        );
    }

    #[test]
    fn en_passant_destination_exposure_uses_the_legal_child_board() {
        // After e5xd6 ep the d5 pawn is gone and Black Rd8 can take the pawn on d6. The exchange
        // wins one pawn, below the hanging threshold, so the legal en-passant move is not a hang.
        let position = position("3rk3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
        assert!(!move_hangs_material(&position, mv("e5d6")));
    }

    #[test]
    fn promotion_destination_uses_the_promoted_piece_value() {
        // a8=Q leaves the new queen on the open eighth rank for Rh8xa8. SEE must value the piece
        // on a8 as a queen, not as the pawn that moved there.
        let position = position("7r/P7/4k3/8/8/8/8/4K3 w - - 0 1");
        assert!(move_hangs_material(&position, mv("a7a8q")));
    }

    #[test]
    fn king_cannot_capture_onto_a_defended_target() {
        // Black Ke8 geometrically attacks White Bd7, but Kxd7 walks onto White Rd1's open file.
        // With no other Black attacker, the legal SEE result is zero.
        let position = position("4k3/3B4/8/8/8/8/8/3R2K1 b - - 0 1");
        assert_eq!(
            static_exchange_eval(&position, square("d7"), Color::Black),
            0
        );
    }

    #[test]
    fn overloaded_rook_move_exposes_both_defended_knights() {
        // White Rd4 is the sole recapturer for Nc4 and Nf4 against Black Rc8/Rf8. After Rd5 both
        // knights become free captures; the abandoned-defender signal must detect the move.
        let position = position("2r1kr2/8/8/8/2NR1N2/8/8/6K1 w - - 0 1");
        let move_away = mv("d4d5");
        let child = position
            .after_legal_move(move_away)
            .expect("fixture move must apply");

        assert!(
            static_exchange_eval(&position, square("c4"), Color::Black)
                < HANGING_MATERIAL_THRESHOLD
        );
        assert!(
            static_exchange_eval(&position, square("f4"), Color::Black)
                < HANGING_MATERIAL_THRESHOLD
        );
        assert!(
            static_exchange_eval(&child, square("c4"), Color::Black) >= HANGING_MATERIAL_THRESHOLD
        );
        assert!(
            static_exchange_eval(&child, square("f4"), Color::Black) >= HANGING_MATERIAL_THRESHOLD
        );
        assert!(move_leaves_piece_hanging(&position, move_away));
    }

    #[test]
    fn a_safe_developing_move_does_not_hang() {
        let start = position("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        assert!(!move_hangs_material(&start, mv("g1f3")));
        assert!(!move_hangs_material(&start, mv("e2e4")));
    }

    #[test]
    fn moving_the_queen_en_prise_hangs_it() {
        // White queen steps to d5 where the c6 pawn takes it for free.
        let position = position("4k3/8/2p5/8/8/3Q4/8/4K3 w - - 0 1");
        assert!(move_hangs_material(&position, mv("d3d5")));
    }

    #[test]
    fn winning_an_undefended_piece_is_not_a_hang() {
        // White rook captures an undefended Black knight on d5: White wins material, so the move is
        // not flagged — the hanging check is about the moved piece being left en prise, not about
        // every capture.
        let position = position("4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1");
        assert!(!move_hangs_material(&position, mv("d1d5")));
    }

    #[test]
    fn moving_a_defender_leaves_the_protected_piece_hanging() {
        // White bishop on e3 defends White knight on d4 (diagonally). Moving the bishop to f4
        // abandons the knight, which the Black rook on d8 can then capture for a free minor piece.
        // Before Be3-f4: SEE(d4, Black) = -10 (opponent loses material: rook-for-knight exchange).
        // After  Be3-f4: SEE(d4, Black) = 320 (knight is free for the rook, no recapture).
        let position = position("3r4/8/8/8/3N4/4B3/8/4K2k w - - 0 1");
        assert!(move_leaves_piece_hanging(&position, mv("e3f4")));
    }

    #[test]
    fn a_safe_developing_move_does_not_leave_pieces_hanging() {
        let start = position("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        assert!(!move_leaves_piece_hanging(&start, mv("g1f3")));
        assert!(!move_leaves_piece_hanging(&start, mv("e2e4")));
    }

    #[test]
    fn move_hangs_material_and_leaves_piece_hanging_are_independent() {
        // White rook moves to d5 where it hangs (move_hangs_material), but it was not defending
        // any other piece, so move_leaves_piece_hanging stays false.
        let position = position("4k3/8/2p5/8/8/3R4/8/4K3 w - - 0 1");
        assert!(move_hangs_material(&position, mv("d3d5")));
        assert!(!move_leaves_piece_hanging(&position, mv("d3d5")));
    }
}
