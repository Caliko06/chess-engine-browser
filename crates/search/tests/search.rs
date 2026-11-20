use chess_board::{Move, Position, PositionStatus};
use chess_search::{MATE_SCORE, MAX_M8_DEPTH, SearchConfig, SearchError, search};

fn position(fen: &str) -> Position {
    Position::from_fen(fen).expect("test FEN must parse")
}

fn search_at(position: &Position, depth: u8) -> chess_search::SearchResult {
    search(position, SearchConfig { max_depth: depth }).expect("search must run")
}

#[test]
fn search_rejects_depths_outside_m8_range() {
    assert_eq!(
        search(&Position::startpos(), SearchConfig { max_depth: 0 }),
        Err(SearchError::InvalidDepth)
    );
    assert_eq!(
        search(
            &Position::startpos(),
            SearchConfig {
                max_depth: MAX_M8_DEPTH + 1
            }
        ),
        Err(SearchError::InvalidDepth)
    );
}

#[test]
fn search_returns_a_legal_startpos_move_at_depth_one() {
    let position = Position::startpos();
    let result = search_at(&position, 1);

    assert!(
        position
            .legal_moves()
            .expect("legal moves must run")
            .contains(&result.best_move.expect("startpos has a move"))
    );
    assert_eq!(result.depth, 1);
    assert!(result.nodes > 0);
    assert_eq!(result.tt_hits, 0);
}

#[test]
fn search_is_deterministic_for_same_position_and_config() {
    let position = Position::startpos();
    let first = search_at(&position, 2);
    let second = search_at(&position, 2);

    assert_eq!(first, second);
}

#[test]
fn search_scores_fifty_move_positions_as_draws() {
    let position = position("4k3/8/8/8/8/8/8/R3K3 w - - 100 75");
    let result = search_at(&position, 3);

    assert_eq!(result.best_move, None);
    assert_eq!(result.score, 0);
    assert_eq!(result.nodes, 1);
}

#[test]
fn search_keeps_halfmove_99_live_and_draws_at_100() {
    let live = position("4k3/8/8/8/8/8/8/R3K3 w - - 99 75");
    let drawn = position("4k3/8/8/8/8/8/8/R3K3 w - - 100 75");
    let live_result = search_at(&live, 2);
    let drawn_result = search_at(&drawn, 2);

    assert!(
        live_result.best_move.is_some(),
        "halfmove 99 must remain live"
    );
    assert_ne!(live_result.nodes, 1, "halfmove 99 must search the position");
    assert_eq!(drawn_result.best_move, None);
    assert_eq!(drawn_result.score, 0);
    assert_eq!(drawn_result.nodes, 1);
}

#[test]
fn search_scores_insufficient_material_as_draw() {
    let position = position("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    let result = search_at(&position, 3);

    assert_eq!(result.best_move, None);
    assert_eq!(result.score, 0);
    assert_eq!(result.nodes, 1);
}

#[test]
fn transposition_table_records_hits_without_changing_result_determinism() {
    let position = Position::startpos();
    let first = search_at(&position, 3);
    let second = search_at(&position, 3);

    assert_eq!(first, second);
    assert!(first.tt_hits > 0);
}

#[test]
fn positional_eval_prefers_development_over_coordinate_order() {
    let result = search_at(&Position::startpos(), 1);

    assert_eq!(
        result.best_move.expect("startpos has a move"),
        Move::from_coordinate("b1c3").expect("move must parse")
    );
    assert!(result.score > 0);
}

#[test]
fn mate_in_one_is_found() {
    let position = position("7k/8/6QK/8/8/8/8/8 w - - 0 1");
    let result = search_at(&position, 1);
    let child = position
        .after_legal_move(result.best_move.expect("mate exists"))
        .expect("best move must apply");

    assert_eq!(
        child.status().expect("status must run"),
        PositionStatus::Checkmate
    );
    assert_eq!(result.score, MATE_SCORE - 1);
}

#[test]
fn free_queen_capture_is_preferred_over_quiet_moves() {
    let result = search_at(&position("q3k3/8/8/8/8/8/8/R3K3 w - - 0 1"), 1);

    assert_eq!(
        result.best_move.expect("capture exists"),
        Move::from_coordinate("a1a8").expect("move must parse")
    );
}

#[test]
fn terminal_scores_follow_root_side_convention() {
    let mate = search_at(&position("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1"), 1);
    let stalemate = search_at(&position("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"), 1);

    assert_eq!(mate.best_move, None);
    assert_eq!(mate.score, -MATE_SCORE);
    assert_eq!(stalemate.best_move, None);
    assert_eq!(stalemate.score, 0);
}

#[test]
fn depth_one_quiescence_matches_depth_two_on_simple_recapture_trap() {
    let position = position("kq6/8/8/8/8/8/8/1R2K3 w - - 0 1");
    let depth_one = search_at(&position, 1);
    let depth_two = search_at(&position, 2);

    assert_eq!(
        depth_one.best_move.expect("capture exists"),
        Move::from_coordinate("b1b8").expect("move must parse")
    );
    assert_eq!(depth_one.score, depth_two.score);
}

#[test]
fn quiescence_stabilizes_simple_recapture_at_depth_one() {
    let result = search_at(&position("kq6/8/8/8/8/8/8/1R2K3 w - - 0 1"), 1);

    assert_eq!(
        result.best_move.expect("capture exists"),
        Move::from_coordinate("b1b8").expect("move must parse")
    );
    assert!(
        result.score.abs() < ROOK_SWING_FROM_SHALLOW_CAPTURE,
        "{result:?}"
    );
}

const ROOK_SWING_FROM_SHALLOW_CAPTURE: i32 = 400;
const PRE_LMR_STARTPOS_DEPTH_FOUR_NODES: u64 = 1775;
const PRE_LMR_M8_TOTAL_NODES: u64 = 107022;

#[test]
fn equal_king_walk_preserves_root_coordinate_tie_break() {
    let result = search_at(&position("4k3/8/8/8/8/p7/P7/4K3 w - - 0 1"), 2);

    assert_eq!(
        result
            .best_move
            .expect("equal king walk must choose a move"),
        Move::from_coordinate("e1d1").expect("move must parse")
    );
    // Every king walk is equal; the blocked pawns keep the fixture outside insufficient material.
    assert_eq!(result.score, 0);
    assert_eq!(result.nodes, 9);
}

#[test]
fn startpos_depth_four_ordering_regression_stays_deterministic() {
    let first = search_at(&Position::startpos(), 4);
    let second = search_at(&Position::startpos(), 4);

    assert_eq!(first, second);
    assert_eq!(
        first.best_move.expect("startpos has a move"),
        Move::from_coordinate("b1c3").expect("move must parse")
    );
    // Symmetric start; the residual +12 is the side-to-move tempo at the even-depth leaf.
    assert_eq!(first.score, 12);
    assert!(
        first.nodes < PRE_LMR_STARTPOS_DEPTH_FOUR_NODES,
        "expected LMR to reduce depth-four startpos nodes below {PRE_LMR_STARTPOS_DEPTH_FOUR_NODES}, got {first:?}"
    );
    assert!(first.tt_hits > 0);
}

#[test]
fn m8_depth_three_lmr_reduces_benchmark_total_nodes() {
    let positions = [
        Position::startpos(),
        position("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"),
        position("kq6/8/8/8/8/8/8/1R2K3 w - - 0 1"),
    ];
    let total_nodes = positions
        .iter()
        .map(|position| search_at(position, 3).nodes)
        .sum::<u64>();

    assert!(
        total_nodes < PRE_LMR_M8_TOTAL_NODES,
        "expected LMR to reduce M8 benchmark nodes below {PRE_LMR_M8_TOTAL_NODES}, got {total_nodes}"
    );
}
