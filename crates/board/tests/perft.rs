use chess_board::Position;

const STARTPOS: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KIWIPETE: &str = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
const POSITION_3: &str = "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1";
const POSITION_4: &str = "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1";
const POSITION_4_MIRRORED: &str =
    "r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1";
const POSITION_5: &str = "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8";
const POSITION_6: &str = "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10";

fn position(fen: &str) -> Position {
    Position::from_fen(fen).expect("test FEN must parse")
}

#[test]
fn perft_startpos_depths_1_through_4_are_canonical() {
    let position = position(STARTPOS);

    assert_eq!(position.perft(1).expect("perft must run"), 20);
    assert_eq!(position.perft(2).expect("perft must run"), 400);
    assert_eq!(position.perft(3).expect("perft must run"), 8_902);
    assert_eq!(position.perft(4).expect("perft must run"), 197_281);
}

#[test]
fn perft_kiwipete_depths_1_through_3_are_canonical() {
    let position = position(KIWIPETE);

    assert_eq!(position.perft(1).expect("perft must run"), 48);
    assert_eq!(position.perft(2).expect("perft must run"), 2_039);
    assert_eq!(position.perft(3).expect("perft must run"), 97_862);
}

#[test]
fn perft_standard_positions_cover_special_move_edge_cases() {
    for (fen, depth, expected) in [
        (POSITION_3, 3, 2_812),
        (POSITION_4, 3, 9_467),
        (POSITION_4_MIRRORED, 3, 9_467),
        (POSITION_5, 3, 62_379),
        (POSITION_6, 3, 89_890),
    ] {
        assert_eq!(
            position(fen).perft(depth).expect("perft must run"),
            expected,
            "{fen} depth {depth}"
        );
    }
}

#[test]
fn perft_divide_startpos_depth_2_reports_root_move_nodes() {
    let entries = position(STARTPOS).perft_divide(2).expect("divide must run");
    let coordinates = entries
        .iter()
        .map(|entry| (entry.mv().to_coordinate(), entry.nodes()))
        .collect::<Vec<_>>();

    assert_eq!(
        coordinates,
        [
            ("a2a3".to_string(), 20),
            ("a2a4".to_string(), 20),
            ("b1a3".to_string(), 20),
            ("b1c3".to_string(), 20),
            ("b2b3".to_string(), 20),
            ("b2b4".to_string(), 20),
            ("c2c3".to_string(), 20),
            ("c2c4".to_string(), 20),
            ("d2d3".to_string(), 20),
            ("d2d4".to_string(), 20),
            ("e2e3".to_string(), 20),
            ("e2e4".to_string(), 20),
            ("f2f3".to_string(), 20),
            ("f2f4".to_string(), 20),
            ("g1f3".to_string(), 20),
            ("g1h3".to_string(), 20),
            ("g2g3".to_string(), 20),
            ("g2g4".to_string(), 20),
            ("h2h3".to_string(), 20),
            ("h2h4".to_string(), 20),
        ]
    );
}
