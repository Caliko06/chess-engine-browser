use chess_board::{Position, PositionStatus};
use chess_search::engine::{Engine, EngineLimits, EngineResult, IterationInfo};
use std::sync::atomic::{AtomicBool, Ordering};

const KIWIPETE: &str = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";

fn think(engine: &mut Engine, position: &Position, depth: u8, nodes: Option<u64>) -> EngineResult {
    engine.think(
        position,
        &[],
        EngineLimits {
            max_depth: Some(depth),
            nodes,
            stop: None,
        },
        &mut |_| true,
    )
}

fn legal_pv(position: &Position, result: &EngineResult) {
    assert_eq!(result.best_move, result.pv.first().copied());
    let mut position = position.clone();
    for &mv in &result.pv {
        position = position.after_legal_move(mv).expect("PV must remain legal");
    }
}

// Exhaustive legal-move proof, independent of search scores, pruning and evaluation.
fn forces_mate(position: &Position, plies: u8, attacker: chess_board::Color) -> bool {
    let moves = position.legal_moves().unwrap();
    if moves.is_empty() {
        return position.is_check() && position.side_to_move() != attacker;
    }
    if plies == 0 {
        return false;
    }
    let mut children = moves.into_iter().map(|mv| {
        forces_mate(
            &position.after_known_legal_move(mv).unwrap(),
            plies - 1,
            attacker,
        )
    });
    if position.side_to_move() == attacker {
        children.any(|mate| mate)
    } else {
        children.all(|mate| mate)
    }
}

#[test]
fn finds_mate_in_one_and_two_for_both_colors() {
    for (fen, distance) in [
        ("7k/8/5KQ1/8/8/8/8/8 w - - 0 1", 1),
        ("8/8/8/8/8/5kq1/8/7K b - - 0 1", 1),
        ("7k/8/5K2/8/4Q3/8/8/8 w - - 0 1", 2),
        ("8/8/8/4q3/8/5k2/8/7K b - - 0 1", 2),
    ] {
        let position = Position::from_fen(fen).unwrap();
        position.legal_moves().unwrap();
        let plies = distance * 2 - 1;
        assert!(
            forces_mate(&position, plies, position.side_to_move()),
            "fixture {fen}"
        );
        if distance == 2 {
            assert!(
                !forces_mate(&position, 1, position.side_to_move()),
                "not mate in one: {fen}"
            );
        }
        let mut infos = Vec::new();
        let result = Engine::new(1).think(
            &position,
            &[],
            EngineLimits {
                max_depth: Some(6),
                nodes: Some(300_000),
                stop: None,
            },
            &mut |info| {
                infos.push(info.clone());
                true
            },
        );
        legal_pv(&position, &result);
        assert_eq!(
            infos.last().unwrap().mate_in,
            Some(i32::from(distance)),
            "{fen}: {result:?}"
        );
        assert_eq!(result.score_cp, 30_000 - i32::from(plies), "{fen}");
        let child = position
            .after_legal_move(result.best_move.unwrap())
            .unwrap();
        assert!(
            forces_mate(&child, plies - 1, position.side_to_move()),
            "{fen}: {result:?}"
        );
    }
}

#[test]
fn legal_best_moves_and_pvs_over_three_hundred_random_play_positions() {
    let mut engine = Engine::new(1);
    let mut random = 0x9e37_79b9_7f4a_7c15_u64;
    let mut checked = 0;
    for _ in 0..10 {
        engine.new_game();
        let mut position = Position::startpos();
        let mut history = Vec::new();
        for _ in 0..32 {
            let legal = position.legal_moves().unwrap();
            if legal.is_empty() {
                break;
            }
            let result = engine.think(
                &position,
                &history,
                EngineLimits {
                    max_depth: Some(2),
                    nodes: Some(1200),
                    stop: None,
                },
                &mut |_| true,
            );
            assert!(legal.contains(&result.best_move.unwrap()), "{result:?}");
            legal_pv(&position, &result);
            checked += 1;
            random ^= random << 13;
            random ^= random >> 7;
            random ^= random << 17;
            history.push(position.zobrist_hash());
            position = position
                .after_known_legal_move(legal[random as usize % legal.len()])
                .unwrap();
        }
    }
    assert!(checked >= 300, "checked {checked} positions");
}

#[test]
fn fixed_depth_is_deterministic_and_new_game_resets_search_state() {
    let position = Position::startpos();
    let mut engine = Engine::new(1);
    let first = think(&mut engine, &position, 4, None);
    let second = think(&mut Engine::new(1), &position, 4, None);
    assert_eq!(first.depth, 4);
    assert_eq!(first.nodes, second.nodes);
    assert_eq!(first.score_cp, second.score_cp);
    assert_eq!(first.pv, second.pv);
    engine.new_game();
    let reset = think(&mut engine, &position, 4, None);
    assert_eq!(first.nodes, reset.nodes);
    assert_eq!(first.pv, reset.pv);
}

#[test]
fn stop_flag_is_polled_within_1024_nodes_and_preserves_completed_iteration() {
    let position = Position::startpos();
    let stop = AtomicBool::new(true);
    let mut engine = Engine::new(1);
    let preset = engine.think(
        &position,
        &[],
        EngineLimits {
            max_depth: None,
            nodes: None,
            stop: Some(&stop),
        },
        &mut |_| panic!("pre-stopped search must not complete an iteration"),
    );
    assert_eq!(preset.nodes, 0);
    assert_eq!(preset.depth, 0);
    legal_pv(&position, &preset);
    stop.store(false, Ordering::Relaxed);
    let mut iterations: Vec<IterationInfo> = Vec::new();
    let result = engine.think(
        &position,
        &[],
        EngineLimits {
            max_depth: None,
            nodes: None,
            stop: Some(&stop),
        },
        &mut |info| {
            iterations.push(info.clone());
            stop.store(true, Ordering::Relaxed);
            true
        },
    );
    let first = iterations.first().unwrap();
    let last = iterations.last().unwrap();
    assert!(result.nodes <= first.nodes + 1024);
    assert_eq!(result.depth, last.depth);
    assert_eq!(result.score_cp, last.score_cp);
    assert_eq!(result.pv, last.pv);
}

#[test]
fn node_limits_and_soft_stop_keep_only_completed_iterations() {
    let position = Position::startpos();
    let mut engine = Engine::new(1);
    let mut last = None;
    let one = engine.think(
        &position,
        &[],
        EngineLimits {
            max_depth: Some(10),
            nodes: None,
            stop: None,
        },
        &mut |info| {
            last = Some(info.clone());
            false
        },
    );
    assert_eq!(one.depth, 1);
    assert_eq!(one.nodes, last.unwrap().nodes);
    engine.new_game();
    // Same tree and node allowance: first iteration completes, the next is interrupted.
    let limited = think(&mut engine, &position, 10, Some(one.nodes + 1));
    assert_eq!(limited.nodes, one.nodes + 1);
    assert_eq!(limited.depth, 1);
    assert_eq!(limited.pv, one.pv);
    assert_eq!(limited.score_cp, one.score_cp);
    for budget in [0, 1, 5, 15] {
        let partial = think(&mut Engine::new(1), &position, 10, Some(budget));
        assert!(partial.nodes <= budget);
        legal_pv(&position, &partial);
    }
}

#[test]
fn terminal_draws_and_checkmate_precedence_are_correct() {
    for (fen, expected) in [
        ("7k/6Q1/6K1/8/8/8/8/8 b - - 100 1", -30_000),
        ("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", 0),
        ("4k3/8/8/8/8/8/8/4K3 w - - 0 1", 0),
        ("4k3/8/8/8/8/8/8/4K2R w - - 100 1", 0),
    ] {
        let position = Position::from_fen(fen).unwrap();
        let result = think(&mut Engine::new(1), &position, 3, None);
        assert_eq!(result.score_cp, expected, "{fen}");
        legal_pv(&position, &result);
    }
    // A mating quiet move on halfmove 99 must still win.
    let position = Position::from_fen("7k/8/5KQ1/8/8/8/8/8 w - - 99 1").unwrap();
    let result = think(&mut Engine::new(1), &position, 3, None);
    assert_eq!(result.score_cp, 29_999);
    assert_eq!(
        position
            .after_legal_move(result.best_move.unwrap())
            .unwrap()
            .status()
            .unwrap(),
        PositionStatus::Checkmate
    );
}

#[test]
fn repetition_uses_game_history_and_tree_path() {
    // White's only legal evasion is Kh1. Its known prior occurrence makes this a tree draw.
    let position = Position::from_fen("5r1k/8/8/8/8/6q1/8/6K1 w - - 8 20").unwrap();
    let legal = position.legal_moves().unwrap();
    assert_eq!(legal.len(), 1);
    let child = position.after_known_legal_move(legal[0]).unwrap();
    let mut engine = Engine::new(1);
    let result = engine.think(
        &position,
        &[child.zobrist_hash()],
        EngineLimits {
            max_depth: Some(3),
            nodes: Some(50_000),
            stop: None,
        },
        &mut |_| true,
    );
    assert_eq!(result.score_cp, 0);
    legal_pv(&position, &result);
    // A true threefold at the root is also drawn, even with a warm TT.
    let position = Position::from_fen("4k3/8/8/8/8/8/8/4K2R w - - 8 20").unwrap();
    let hash = position.zobrist_hash();
    let result = engine.think(
        &position,
        &[hash, hash],
        EngineLimits {
            max_depth: Some(2),
            nodes: None,
            stop: None,
        },
        &mut |_| true,
    );
    assert_eq!(result.score_cp, 0);
}

#[test]
#[ignore = "release-only throughput probe; run with --release --ignored --nocapture"]
fn million_node_probe() {
    for (name, position) in [
        ("startpos", Position::startpos()),
        ("kiwipete", Position::from_fen(KIWIPETE).unwrap()),
    ] {
        let mut engine = Engine::new(32);
        let start = std::time::Instant::now();
        let mut seldepth = 0;
        let result = engine.think(
            &position,
            &[],
            EngineLimits {
                max_depth: None,
                nodes: Some(1_000_000),
                stop: None,
            },
            &mut |info| {
                seldepth = info.seldepth;
                true
            },
        );
        let seconds = start.elapsed().as_secs_f64();
        println!(
            "{name}: nodes={} depth={} seldepth={} nps={:.0} seconds={seconds:.3} best={} score={}",
            result.nodes,
            result.depth,
            seldepth,
            result.nodes as f64 / seconds,
            result
                .best_move
                .map_or_else(|| "none".into(), |mv| mv.to_coordinate()),
            result.score_cp
        );
        assert_eq!(result.nodes, 1_000_000);
        legal_pv(&position, &result);
    }
}

#[test]
fn develops_instead_of_early_queen_sortie_after_e4_e5() {
    // Stockfish rates 2.Nf3 +27 and 2.Qh5 -43 here; the old Classical search chose Qh5.
    let mut position = Position::startpos();
    for mv in ["e2e4", "e7e5"] {
        let mv = chess_board::Move::from_coordinate(mv).expect("move parses");
        position = position.after_legal_move(mv).expect("legal opening move");
    }
    let mut engine = Engine::new(16);
    let result = think(&mut engine, &position, 8, None);
    let best = result.best_move.expect("a move").to_coordinate();
    assert_ne!(best, "d1h5", "{result:?}");
}
