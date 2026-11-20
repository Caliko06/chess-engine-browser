use chess_board::Position;
use chess_eval::tapered::{
    BISHOP_PAIR, DEFAULT_PARAMS, DOUBLED_PAWN, EvalParams, ISOLATED_PAWN, KING_ATTACK, MOBILITY,
    PARAM_COUNT, PASSED_PAWN, PAWN_SHIELD, PawnCache, ROOK_OPEN, ROOK_SEMI_OPEN, START_PARAMS,
    TEMPO, evaluate_cached, evaluate_tapered, evaluate_with_params, trace,
};

fn mirror(position: &Position) -> Position {
    let fen = position.to_fen();
    let fields: Vec<_> = fen.split_whitespace().collect();
    let board = fields[0]
        .split('/')
        .rev()
        .map(|rank| {
            rank.chars()
                .map(|c| {
                    if c.is_ascii_uppercase() {
                        c.to_ascii_lowercase()
                    } else {
                        c.to_ascii_uppercase()
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/");
    let rights = ['K', 'Q', 'k', 'q']
        .into_iter()
        .filter(|&c| {
            fields[2].contains(if c.is_ascii_uppercase() {
                c.to_ascii_lowercase()
            } else {
                c.to_ascii_uppercase()
            })
        })
        .collect::<String>();
    let rights = if rights.is_empty() { "-" } else { &rights };
    let ep = if fields[3] == "-" {
        "-".to_string()
    } else {
        format!(
            "{}{}",
            &fields[3][..1],
            9 - (fields[3].as_bytes()[1] - b'0')
        )
    };
    Position::from_fen(&format!(
        "{board} {} {rights} {ep} {} {}",
        if fields[1] == "w" { "b" } else { "w" },
        fields[4],
        fields[5]
    ))
    .unwrap()
}

#[test]
fn startpos_is_exactly_tempo_and_phase_24() {
    let position = Position::startpos();
    assert_eq!(trace(&position).phase, 24);
    assert_eq!(trace(&position).coefficients, [(TEMPO, 1)]);
    assert_eq!(
        evaluate_tapered(&position),
        DEFAULT_PARAMS.weights[TEMPO][0]
    );
    assert_eq!(
        evaluate_tapered(&mirror(&position)),
        -DEFAULT_PARAMS.weights[TEMPO][0]
    );
}

#[test]
fn color_swap_negates_eval_and_trace_matches_integer_runtime() {
    let parameters = [
        START_PARAMS,
        DEFAULT_PARAMS,
        EvalParams {
            weights: std::array::from_fn(|i| {
                [((i * 17) % 233) as i32 - 116, ((i * 29) % 197) as i32 - 98]
            }),
        },
    ];
    let mut position = Position::startpos();
    for ply in 0..120 {
        for params in &parameters {
            let score = evaluate_with_params(&position, params);
            assert_eq!(
                score,
                -evaluate_with_params(&mirror(&position), params),
                "{}",
                position.to_fen()
            );
            let linear = trace(&position).evaluate(params);
            assert!(
                (f64::from(score) - linear).abs() < 1.000001,
                "score={score}, linear={linear}"
            );
        }
        let moves = position.legal_moves().unwrap();
        if moves.is_empty() {
            break;
        }
        position = position
            .after_legal_move(moves[(ply * 37 + 11) % moves.len()])
            .unwrap();
    }
}

#[test]
fn phase_reaches_endgame_and_saturates_after_promotions() {
    let bare = Position::from_fen("4k3/8/8/8/8/8/8/4K3 w - - 0 1").unwrap();
    assert_eq!(trace(&bare).phase, 0);
    let promoted =
        Position::from_fen("rnbqkbnr/pppp1ppp/8/4Q3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").unwrap();
    assert_eq!(trace(&promoted).phase, 24);
    assert_eq!(
        evaluate_tapered(&promoted),
        -evaluate_tapered(&mirror(&promoted))
    );
}

#[test]
fn all_structural_and_safety_terms_are_traced_and_adjustable() {
    let fixtures = [
        "6k1/5ppp/8/3P4/P7/P7/2B2PPP/R1B1K2R w KQ - 0 1",
        "6k1/p4ppp/8/8/8/2N5/5PPP/R3K3 w Q - 0 1",
        "6k1/5ppp/8/7Q/8/2N5/5PPP/R3K3 w Q - 0 1",
        "6k1/8/8/8/8/8/3N1PPP/6K1 w - - 0 1",
    ];
    let mut seen = [false; PARAM_COUNT];
    for fen in fixtures {
        let position = Position::from_fen(fen).unwrap();
        let traced = trace(&position);
        for &(index, _) in &traced.coefficients {
            seen[index] = true;
            let mut one = EvalParams {
                weights: [[0; 2]; PARAM_COUNT],
            };
            one.weights[index] = [24, 24];
            let score = evaluate_with_params(&position, &one);
            assert_ne!(score, 0, "{fen} term {index}");
            assert!((f64::from(score) - traced.evaluate(&one)).abs() < 1.000001);
        }
    }
    for index in [
        BISHOP_PAIR,
        MOBILITY + 1,
        PASSED_PAWN + 4,
        DOUBLED_PAWN,
        ISOLATED_PAWN,
        ROOK_OPEN,
        ROOK_SEMI_OPEN,
        KING_ATTACK + 4,
        PAWN_SHIELD,
        TEMPO,
    ] {
        assert!(seen[index], "missing feature {index}");
    }
}

#[test]
fn new_terms_are_traced_symmetric_and_match_hand_counts() {
    use chess_eval::tapered::{
        BISHOP_OUTPOST, HANGING, KING_ATTACKER_COUNT, KING_ATTACKERS, KING_FILE_OPEN,
        KNIGHT_OUTPOST, MOBILITY_KNIGHT, PASSED_CONNECTED, PASSED_FREE, PASSED_KING_ENEMY,
        PASSED_KING_OWN, PASSED_SAFE, PAWN_CONNECTED, PUSH_THREAT, ROOK_SEVENTH, SAFE_CHECK,
        THREAT_MINOR, THREAT_PAWN, THREAT_ROOK,
    };
    let count = |fen: &str, index: usize| -> i16 {
        let position = Position::from_fen(fen).unwrap();
        trace(&position)
            .coefficients
            .iter()
            .find(|&&(i, _)| i == index)
            .map_or(0, |&(_, c)| c)
    };
    // White pawn on d5 attacks the black knight on e6 and bishop on c6.
    let fen = "4k3/8/2b1n3/3P4/8/8/8/4K3 w - - 0 1";
    assert_eq!(count(fen, THREAT_PAWN), 1);
    assert_eq!(count(fen, THREAT_PAWN + 1), 1);
    // Rook on the seventh against a king on the eighth.
    assert_eq!(count("4k3/R7/8/8/8/8/8/4K3 w - - 0 1", ROOK_SEVENTH), 1);
    assert_eq!(count("8/R3k3/8/8/8/8/8/4K3 w - - 0 1", ROOK_SEVENTH), 0);
    assert_eq!(count("4k3/8/8/8/8/8/r7/4K3 b - - 0 1", ROOK_SEVENTH), -1);
    // Knight on e5 guarded by d4, no black pawn on d/f files: an outpost.
    let outpost = "4k3/8/8/4N3/3P4/8/8/4K3 w - - 0 1";
    assert_eq!(count(outpost, KNIGHT_OUTPOST), 1);
    assert_eq!(count(outpost, BISHOP_OUTPOST), 0);
    assert_eq!(
        count("4k3/5p2/8/4N3/3P4/8/8/4K3 w - - 0 1", KNIGHT_OUTPOST),
        0
    );
    assert_eq!(
        count("4k3/8/8/4B3/3P4/8/8/4K3 w - - 0 1", BISHOP_OUTPOST),
        1
    );
    // Passed pawn on a5 with free, unattacked stop square; kings 3 and 5 files away.
    let passer = "7k/8/8/P7/8/8/8/4K3 w - - 0 1";
    assert_eq!(count(passer, PASSED_FREE + 4), 1);
    assert_eq!(count(passer, PASSED_SAFE + 4), 1);
    assert_eq!(count(passer, PASSED_KING_OWN + 4), 5);
    assert_eq!(count(passer, PASSED_KING_ENEMY + 4), 7);
    // Black bishop blocks the stop square: not free.
    assert_eq!(count("7k/8/b7/P7/8/8/8/4K3 w - - 0 1", PASSED_FREE + 4), 0);
    // Guarded passer and a phalanx.
    assert_eq!(
        count("7k/8/8/P7/1P6/8/8/4K3 w - - 0 1", PASSED_CONNECTED + 4),
        1
    );
    assert_eq!(
        count("7k/pp6/8/8/8/PP6/8/4K3 w - - 0 1", PAWN_CONNECTED + 2),
        2
    );
    // Hanging queen, minor threats and rook threats.
    assert_eq!(count("4k3/8/8/3q4/8/8/8/R3K3 w - - 0 1", HANGING), 0);
    assert_eq!(count("4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1", HANGING), 1);
    assert_eq!(
        count("4k3/8/8/3r4/5N2/8/8/4K3 w - - 0 1", THREAT_MINOR + 3),
        1
    );
    assert_eq!(
        count("4k3/8/8/3b4/8/8/8/3RK3 w - - 0 1", THREAT_ROOK + 2),
        1
    );
    // Safe push d4-d5 would attack the knight on e6.
    assert_eq!(count("4k3/8/4n3/8/3P4/8/8/4K3 w - - 0 1", PUSH_THREAT), 1);
    // Queen and knight attack the king zone; the queen has a safe check on g2.
    let attack = "6k1/8/8/8/8/5N2/8/4K1Q1 w - - 0 1";
    assert_eq!(count(attack, KING_ATTACKERS + 3), 1);
    assert_eq!(count(attack, KING_ATTACKER_COUNT), 1);
    assert_eq!(count(attack, SAFE_CHECK + 3), 1);
    assert_eq!(count(attack, KING_FILE_OPEN), 0);
    assert_eq!(
        count("6k1/8/8/8/8/8/8/N3K3 w - - 0 1", MOBILITY_KNIGHT + 2),
        1
    );
}

#[test]
fn new_terms_stay_symmetric_on_tactical_fixtures() {
    for fen in [
        "r1bq1rk1/pp2ppbp/2np1np1/8/3NP3/2N1BP2/PPPQ2PP/R3KB1R w KQ - 0 9",
        "2r3k1/1p3pp1/p3p2p/3pP3/1P1P4/P1R2PP1/6KP/8 b - - 0 30",
        "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/2NP1N2/PPP1QPPP/R4RK1 w - - 0 10",
        "8/5pk1/6p1/2P5/1P3K2/8/8/8 w - - 0 50",
    ] {
        let position = Position::from_fen(fen).unwrap();
        for params in [&DEFAULT_PARAMS, &START_PARAMS] {
            assert_eq!(
                evaluate_with_params(&position, params),
                -evaluate_with_params(&mirror(&position), params),
                "{fen}"
            );
        }
        let params = EvalParams {
            weights: std::array::from_fn(|i| {
                [((i * 17) % 233) as i32 - 116, ((i * 29) % 197) as i32 - 98]
            }),
        };
        assert_eq!(
            evaluate_with_params(&position, &params),
            -evaluate_with_params(&mirror(&position), &params),
            "{fen}"
        );
        assert!(
            (f64::from(evaluate_with_params(&position, &params))
                - trace(&position).evaluate(&params))
            .abs()
                < 1.000001
        );
    }
}

#[test]
fn pawn_cache_returns_the_uncached_eval_along_random_games() {
    // A tiny cache would hide misses; the real size forces hits and slot reuse alike.
    let mut cache = PawnCache::new();
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    let mut checked = 0;
    for _game in 0..40 {
        let mut position = Position::startpos();
        for _ply in 0..160 {
            let moves = position.legal_moves_trusted();
            if moves.is_empty() {
                break;
            }
            // Twice per position: the second call is served from the cache.
            for _ in 0..2 {
                assert_eq!(
                    evaluate_cached(&position, &mut cache),
                    evaluate_tapered(&position),
                    "{}",
                    position.to_fen()
                );
            }
            checked += 1;
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let mv = moves[(state % moves.len() as u64) as usize];
            position = position.after_known_legal_move(mv).expect("legal move");
        }
    }
    assert!(checked > 3_000, "checked {checked}");
}
