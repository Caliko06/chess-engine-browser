use chess_board::Position;

/// Validation-rich corpus: castling both ways, pins, en-passant chances, promotions either
/// colour, and the perft reference middlegames.
const CORPUS: [&str; 7] = [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
    "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
];

fn position(fen: &str) -> Position {
    Position::from_fen(fen).expect("corpus FEN must parse")
}

/// ADR-0162 P1: applying a move taken from the position's own legal move list through the
/// known-legal fast path must yield exactly the position the validating path yields, recursively
/// across the corpus.
#[test]
fn after_known_legal_move_matches_after_legal_move_over_the_corpus() {
    for fen in CORPUS {
        let root = position(fen);
        assert_walk_known_legal_matches(&root, 2);
    }
}

/// ADR-0162 P4: the trusted `legal_moves`/`status` variants must agree with the validating
/// methods on every corpus position and every derived child, including terminal positions.
#[test]
fn trusted_legal_moves_and_status_match_validating_paths() {
    let terminal_fens = [
        // Fool's mate: White is checkmated.
        "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 2 3",
        // Classic queen stalemate: Black to move has no legal move and is not in check.
        "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
    ];
    for fen in CORPUS.into_iter().chain(terminal_fens) {
        let root = position(fen);
        assert_trusted_walk_matches(&root, 2);
    }
}

fn assert_trusted_walk_matches(parent: &Position, depth: u8) {
    assert_eq!(
        parent.legal_moves().expect("corpus positions are valid"),
        parent.legal_moves_trusted(),
        "legal move mismatch for {}",
        parent.to_fen()
    );
    assert_eq!(
        parent.status().expect("corpus positions are valid"),
        parent.status_trusted(),
        "status mismatch for {}",
        parent.to_fen()
    );
    assert_eq!(
        !parent.legal_moves_trusted().is_empty(),
        parent.has_any_legal_move_trusted(),
        "has-any-legal-move mismatch for {}",
        parent.to_fen()
    );
    if depth == 0 {
        return;
    }
    for mv in parent.legal_moves_trusted() {
        let child = parent
            .after_known_legal_move(mv)
            .expect("legal move must apply");
        assert_trusted_walk_matches(&child, depth - 1);
    }
}

fn assert_walk_known_legal_matches(parent: &Position, depth: u8) {
    for mv in parent.legal_moves().expect("corpus positions are valid") {
        let validated = parent
            .after_legal_move(mv)
            .expect("legal move must apply through the validating path");
        let trusted = parent
            .after_known_legal_move(mv)
            .expect("legal move must apply through the known-legal path");
        assert_eq!(
            validated,
            trusted,
            "child mismatch for {} after {}",
            parent.to_fen(),
            mv.to_coordinate()
        );
        if depth > 1 {
            assert_walk_known_legal_matches(&trusted, depth - 1);
        }
    }
}
