use chess_board::{Move, Position, PositionStatus};

fn position(fen: &str) -> Position {
    Position::from_fen(fen).expect("test FEN must parse")
}

#[test]
fn public_status_reports_ongoing_checkmate_and_stalemate() {
    assert_eq!(
        Position::startpos().status().expect("status must run"),
        PositionStatus::Ongoing
    );
    assert_eq!(
        position("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1")
            .status()
            .expect("status must run"),
        PositionStatus::Checkmate
    );
    assert_eq!(
        position("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")
            .status()
            .expect("status must run"),
        PositionStatus::Stalemate
    );
}

#[test]
fn draw_predicates_report_fifty_move_and_insufficient_material_without_changing_status() {
    let fifty = position("4k3/8/8/8/8/8/8/4K3 w - - 100 75");
    assert!(fifty.is_fifty_move_draw());
    assert_eq!(
        fifty
            .status()
            .expect("status still uses terminal move status"),
        PositionStatus::Ongoing
    );

    assert!(position("4k3/8/8/8/8/8/8/4K3 w - - 0 1").has_insufficient_material());
    assert!(position("4k3/8/8/8/8/8/8/3BK3 w - - 0 1").has_insufficient_material());
    assert!(position("4k3/8/8/8/8/8/8/3NK3 w - - 0 1").has_insufficient_material());
    assert!(
        position("4k3/8/8/8/8/b7/8/2B1K3 w - - 0 1").has_insufficient_material(),
        "bishop-only material on one square colour cannot mate"
    );
    assert!(
        !position("4k3/8/8/8/8/1b6/8/2B1K3 w - - 0 1").has_insufficient_material(),
        "opposite-colour bishop-only material is not folded into this conservative predicate"
    );
    assert!(!position("4k3/8/8/8/8/8/8/R3K3 w - - 0 1").has_insufficient_material());
    assert!(!position("4k3/8/8/8/8/8/8/2NNK3 w - - 0 1").has_insufficient_material());
}

#[test]
fn after_legal_move_returns_child_position_without_mutating_root() {
    let root = Position::startpos();
    let mv = Move::from_coordinate("e2e4").expect("move must parse");
    let child = root.after_legal_move(mv).expect("move must be legal");

    assert_eq!(
        root.to_fen(),
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    );
    assert_eq!(
        child.to_fen(),
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    );
}

#[test]
fn after_legal_move_rejects_pseudo_legal_or_out_of_turn_moves() {
    let root = Position::startpos();

    assert!(
        root.after_legal_move(Move::from_coordinate("e2e5").expect("move must parse"))
            .is_err()
    );
    assert!(
        root.after_legal_move(Move::from_coordinate("e7e5").expect("move must parse"))
            .is_err()
    );
}
