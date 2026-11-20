//! The allocation-free search move generator must agree exactly with `legal_moves_trusted`.

use chess_board::{Move, MoveList, Position, PromotionPiece};

const POSITIONS: [&str; 12] = [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
    "r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1",
    "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    // En passant that would expose the king along the rank.
    "8/8/8/KPp4r/8/8/8/7k w - c6 0 1",
    // Castling through, out of and into check; castling with attacked rook-side square.
    "r3k2r/8/8/8/8/8/6b1/R3K2R w KQkq - 0 1",
    "r3k2r/8/8/8/8/5q2/8/R3K2R w KQkq - 0 1",
    // Double check and pinned pieces.
    "4k3/8/8/8/1b6/8/3N4/4K2r w - - 0 1",
    // Many queens: stresses list capacity.
    "QQQQQQQQ/8/8/8/8/8/8/k6K w - - 0 1",
];

fn legal_set(position: &Position) -> Vec<Move> {
    let mut moves = position.legal_moves_trusted();
    moves.sort();
    moves
}

fn check_agreement(position: &Position) {
    let mut pseudo = MoveList::new();
    position.pseudo_legal_moves_into(&mut pseudo);
    let mut survivors = Vec::new();
    for &mv in pseudo.iter() {
        if let Some(child) = position.after_pseudo_move(mv) {
            let expected = position
                .after_known_legal_move(mv)
                .expect("a legal move applies");
            assert_eq!(child, expected, "{} {mv:?}", position.to_fen());
            assert_eq!(
                position.gives_check(mv),
                child.is_check(),
                "gives_check {} {mv:?}",
                position.to_fen()
            );
            survivors.push(mv);
        }
    }
    survivors.sort();
    assert_eq!(survivors, legal_set(position), "{}", position.to_fen());
    let mut deduplicated = survivors.clone();
    deduplicated.dedup();
    assert_eq!(
        deduplicated,
        survivors,
        "duplicate move in {}",
        position.to_fen()
    );

    let mut captures = MoveList::new();
    position.pseudo_legal_captures_into(&mut captures);
    let mut capture_survivors: Vec<Move> = captures
        .iter()
        .copied()
        .filter(|&mv| position.after_pseudo_move(mv).is_some())
        .collect();
    capture_survivors.sort();
    let mut expected_captures: Vec<Move> = legal_set(position)
        .into_iter()
        .filter(|&mv| match mv.promotion() {
            Some(promotion) => promotion == PromotionPiece::Queen,
            None => position.is_capture(mv),
        })
        .collect();
    expected_captures.sort();
    assert_eq!(
        capture_survivors,
        expected_captures,
        "captures in {}",
        position.to_fen()
    );
}

#[test]
fn pseudo_legal_survivors_equal_legal_moves_on_reference_positions() {
    for fen in POSITIONS {
        let position = Position::from_fen(fen).expect("test FEN must parse");
        check_agreement(&position);
    }
}

#[test]
fn pseudo_legal_survivors_equal_legal_moves_along_random_games() {
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut visited = 0;
    for fen in POSITIONS.iter().take(11) {
        for _game in 0..12 {
            let mut position = Position::from_fen(fen).expect("test FEN must parse");
            for _ply in 0..120 {
                if position.status_trusted() != chess_board::PositionStatus::Ongoing {
                    break;
                }
                check_agreement(&position);
                visited += 1;
                let moves = position.legal_moves_trusted();
                let mv = moves[(next() % moves.len() as u64) as usize];
                position = position
                    .after_known_legal_move(mv)
                    .expect("a legal move applies");
            }
        }
    }
    assert!(visited > 5_000, "visited {visited}");
}

#[test]
fn has_non_pawn_material_reads_the_bitboards() {
    use chess_board::Color;
    let position = Position::from_fen("4k3/pppppppp/8/8/8/8/PPPPPPPP/R3K3 w - - 0 1")
        .expect("test FEN must parse");
    assert!(position.has_non_pawn_material(Color::White));
    assert!(!position.has_non_pawn_material(Color::Black));
}
