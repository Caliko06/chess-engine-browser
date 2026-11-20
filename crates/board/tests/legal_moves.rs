use chess_board::{LegalMoveError, Position};

const STARTPOS: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KIWIPETE: &str = "r3k2r/p1ppqpb1/bn2pnp1/2P5/1p2P3/2N2N2/PP1PBPPP/R2QKB1R w KQkq - 0 1";

fn position(fen: &str) -> Position {
    Position::from_fen(fen).expect("test FEN must parse")
}

fn legal_coordinates(fen: &str) -> Vec<String> {
    position(fen)
        .legal_moves()
        .expect("test position must be legal")
        .into_iter()
        .map(|candidate| candidate.to_coordinate())
        .collect()
}

#[test]
fn legal_moves_startpos_are_exact_and_deterministically_ordered() {
    assert_eq!(
        legal_coordinates(STARTPOS),
        [
            "a2a3", "a2a4", "b1a3", "b1c3", "b2b3", "b2b4", "c2c3", "c2c4", "d2d3", "d2d4", "e2e3",
            "e2e4", "f2f3", "f2f4", "g1f3", "g1h3", "g2g3", "g2g4", "h2h3", "h2h4",
        ]
    );
}

#[test]
fn legal_moves_include_castling_in_kiwipete_style_root() {
    assert_eq!(
        legal_coordinates("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"),
        [
            "a1a2", "a1a3", "a1a4", "a1a5", "a1a6", "a1a7", "a1a8", "a1b1", "a1c1", "a1d1", "e1c1",
            "e1d1", "e1d2", "e1e2", "e1f1", "e1f2", "e1g1", "h1f1", "h1g1", "h1h2", "h1h3", "h1h4",
            "h1h5", "h1h6", "h1h7", "h1h8",
        ]
    );
}

#[test]
fn legal_moves_kiwipete_root_is_exact() {
    assert_eq!(
        legal_coordinates(KIWIPETE),
        [
            "a1b1", "a1c1", "a2a3", "a2a4", "b2b3", "c3a4", "c3b1", "c3b5", "c3d5", "c5b6", "c5c6",
            "d1a4", "d1b1", "d1b3", "d1c1", "d1c2", "d2d3", "d2d4", "e2a6", "e2b5", "e2c4", "e2d3",
            "e4e5", "f3d4", "f3e5", "f3g1", "f3g5", "f3h4", "g2g3", "g2g4", "h1g1", "h2h3", "h2h4",
        ]
    );
}

#[test]
fn legal_moves_omit_denied_castling_without_hiding_available_castling() {
    let moves = legal_coordinates("4k3/8/8/8/8/8/8/R3KB1R w KQ - 0 1");

    assert!(moves.contains(&"e1c1".to_string()));
    assert!(!moves.contains(&"e1g1".to_string()));
}

#[test]
fn legal_moves_include_promotions_and_en_passant_exactly() {
    assert_eq!(
        legal_coordinates("k2r1r2/4P3/8/8/8/8/8/4K3 w - - 0 1"),
        [
            "e1e2", "e7d8b", "e7d8n", "e7d8q", "e7d8r", "e7e8b", "e7e8n", "e7e8q", "e7e8r",
            "e7f8b", "e7f8n", "e7f8q", "e7f8r",
        ]
    );
    assert_eq!(
        legal_coordinates("8/8/8/K2pP3/8/8/8/4k3 w - d6 0 1"),
        ["a5a4", "a5a6", "a5b4", "a5b5", "a5b6", "e5d6", "e5e6"]
    );
}

#[test]
fn legal_moves_return_empty_for_terminal_positions() {
    assert_eq!(
        legal_coordinates("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1"),
        Vec::<String>::new()
    );
    assert_eq!(
        legal_coordinates("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"),
        Vec::<String>::new()
    );
}

#[test]
fn legal_moves_reject_semantically_classified_positions() {
    for fen in [
        "4k3/8/8/8/8/8/4r3/4K3 b - - 0 1",
        "4k3/8/8/8/8/8/8/4K3 w Kq - 0 1",
    ] {
        assert_eq!(
            position(fen).legal_moves().unwrap_err(),
            LegalMoveError::InvalidPosition,
            "{fen}"
        );
    }
}

#[test]
fn legal_moves_allow_impossible_material_count_diagnostic() {
    assert_eq!(
        legal_coordinates("k7/8/8/8/8/P7/PPPPPPPP/7K w - - 0 1"),
        [
            "a3a4", "b2b3", "b2b4", "c2c3", "c2c4", "d2d3", "d2d4", "e2e3", "e2e4", "f2f3", "f2f4",
            "g2g3", "g2g4", "h1g1", "h2h3", "h2h4",
        ]
    );
}

#[test]
fn legal_moves_allow_uncapturable_en_passant_target() {
    assert_eq!(
        legal_coordinates("4k3/8/8/8/8/8/8/4K3 w - d6 0 1"),
        ["e1d1", "e1d2", "e1e2", "e1f1", "e1f2"]
    );
}

#[test]
fn legal_moves_allow_side_to_move_in_check() {
    assert_eq!(
        legal_coordinates("4k3/8/8/8/8/8/4r3/4K3 w - - 0 1"),
        ["e1d1", "e1e2", "e1f1"]
    );
}
