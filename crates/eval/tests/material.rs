use chess_board::Position;
use chess_eval::{
    BISHOP_VALUE, KNIGHT_VALUE, PAWN_VALUE, QUEEN_VALUE, ROOK_VALUE, evaluate, material_score,
};

fn position(fen: &str) -> Position {
    Position::from_fen(fen).expect("test FEN must parse")
}

#[test]
fn material_score_is_white_positive_and_kings_are_zero() {
    assert_eq!(material_score(&Position::startpos()), 0);
    assert_eq!(
        material_score(&position("4k3/8/8/8/8/8/8/4KQ2 w - - 0 1")),
        QUEEN_VALUE
    );
    assert_eq!(
        material_score(&position("4k3/8/8/8/8/8/8/r3K3 w - - 0 1")),
        -ROOK_VALUE
    );
}

#[test]
fn material_score_combines_all_non_king_piece_values() {
    assert_eq!(
        material_score(&position("4k3/8/8/8/8/8/1p6/2B1K2R w - - 0 1")),
        BISHOP_VALUE + ROOK_VALUE - PAWN_VALUE
    );
}

#[test]
fn evaluate_is_antisymmetric_in_the_startpos_tempo() {
    // The starting board is mirror-symmetric, so the only asymmetry is the side-to-move tempo:
    // White-to-move and Black-to-move must be exact negatives and sum to zero.
    let white_to_move = Position::startpos();
    let black_to_move = position("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1");

    assert_eq!(evaluate(&white_to_move), -evaluate(&black_to_move));
    assert_eq!(evaluate(&white_to_move) + evaluate(&black_to_move), 0);
}

#[test]
fn evaluate_prefers_central_knight_without_material_change() {
    let rim_knight = evaluate(&position("4k3/8/8/8/8/8/8/N3K3 w - - 0 1"));
    let central_knight = evaluate(&position("4k3/8/8/8/3N4/8/8/4K3 w - - 0 1"));

    assert!(
        central_knight > rim_knight,
        "{central_knight} <= {rim_knight}"
    );
    assert_eq!(
        material_score(&position("4k3/8/8/8/3N4/8/8/4K3 w - - 0 1")),
        KNIGHT_VALUE
    );
}

#[test]
fn evaluate_penalizes_doubled_isolated_pawns_without_material_change() {
    let doubled = evaluate(&position("4k3/8/8/8/8/P7/P7/4K3 w - - 0 1"));
    let connected = evaluate(&position("4k3/8/8/8/8/8/PP6/4K3 w - - 0 1"));

    assert!(connected > doubled, "{connected} <= {doubled}");
    assert_eq!(
        material_score(&position("4k3/8/8/8/8/P7/P7/4K3 w - - 0 1")),
        material_score(&position("4k3/8/8/8/8/8/PP6/4K3 w - - 0 1"))
    );
}

#[test]
fn evaluate_rewards_rook_mobility_when_static_terms_match() {
    let open = position("4k3/8/8/4P3/3R4/4P3/8/4K3 w - - 0 1");
    let boxed = position("4k3/8/8/3P4/3R4/3P4/8/4K3 w - - 0 1");

    assert_eq!(material_score(&open), material_score(&boxed));
    let open_score = evaluate(&open);
    let boxed_score = evaluate(&boxed);

    assert!(open_score > boxed_score, "{open_score} <= {boxed_score}");
}

#[test]
fn evaluate_penalizes_queen_pressure_on_king_zone_when_static_terms_match() {
    let safe = position("4k3/3q4/8/8/8/8/8/4K3 w - - 0 1");
    let exposed = position("4k3/8/8/8/8/8/4q3/4K3 w - - 0 1");

    assert_eq!(material_score(&safe), material_score(&exposed));
    let safe_score = evaluate(&safe);
    let exposed_score = evaluate(&exposed);

    assert!(
        safe_score > exposed_score,
        "{safe_score} <= {exposed_score}"
    );
}

#[test]
fn evaluate_is_white_positive_and_black_negative_for_mirrored_features() {
    let white = evaluate(&position("4k3/8/8/8/3N4/8/8/4K3 w - - 0 1"));
    let black = evaluate(&position("4k3/8/8/3n4/8/8/8/4K3 b - - 0 1"));

    assert_eq!(white, -black);
}
