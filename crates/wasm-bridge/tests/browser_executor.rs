use chess_wasm_bridge::{
    best_move_json, make_move_json, new_game_json, review_pgn_json, review_pgn_with_artifacts_json,
    side_explore_context_json, side_explore_json,
};

const STARTPOS: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

#[test]
fn owned_play_json_exports_return_start_move_and_best_move() {
    let new_game = new_game_json();
    assert!(new_game.starts_with(r#"{"ok":true,"state":{"#));
    assert!(
        new_game.contains(r#""fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1""#)
    );
    assert!(new_game.contains(r#""status":"ongoing""#));
    assert!(new_game.contains(r#""sideToMove":"white""#));
    assert!(new_game.contains(r#""legalMoves":["a2a3""#));

    let player_move = make_move_json(STARTPOS, "e2e4");
    assert_eq!(
        player_move,
        r#"{"ok":true,"move":{"appliedMove":"e2e4","san":"e4","state":{"fen":"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1","status":"ongoing","drawReason":null,"sideToMove":"black","legalMoves":["a7a5","a7a6","b7b5","b7b6","b8a6","b8c6","c7c5","c7c6","d7d5","d7d6","e7e5","e7e6","f7f5","f7f6","g7g5","g7g6","g8f6","g8h6","h7h5","h7h6"]}}}"#
    );

    let best = best_move_json(STARTPOS, 1, false, 5_000);
    assert!(
        best.starts_with(r#"{"ok":true,"bestMove":{"bestMove":""#),
        "{best}"
    );
    assert!(best.contains(r#""principalLine":["#), "{best}");
    assert!(best.contains(r#""followedPlan":false"#), "{best}");
    assert!(!best.contains(r#""plan":"#), "{best}");
}

#[test]
fn owned_play_json_exports_map_errors_to_stable_codes() {
    assert_eq!(
        make_move_json("not-a-fen", "e2e4"),
        r#"{"ok":false,"error":"invalid-fen"}"#
    );
    assert_eq!(
        make_move_json(STARTPOS, "e2e5"),
        r#"{"ok":false,"error":"invalid-move"}"#
    );
    assert_eq!(
        best_move_json(STARTPOS, 0, false, 0),
        r#"{"ok":false,"error":"invalid-depth"}"#
    );
}

#[test]
fn side_explore_context_json_accepts_history() {
    let output = side_explore_context_json(STARTPOS, "white", true, STARTPOS);
    assert!(output.starts_with(r#"{"ok":true,"sideExplore":{"#));
    assert!(output.contains(r#""side":"white""#));
}

#[test]
fn review_pgn_json_returns_success_result_for_core_review() {
    let output = review_pgn_json("1. f3 e5 2. g4 Qh4# 0-1", 3);

    assert!(output.starts_with(r#"{"ok":true,"review":{"#));
    assert!(output.contains(r#""summary":{"#));
    assert!(output.contains(r#""entries":["#));
    assert!(output.contains(r#""label":"blunder""#));
    assert!(!output.contains("1. f3"));
}

#[test]
fn review_pgn_json_maps_wrong_reasons_to_existing_error_codes() {
    assert_eq!(
        review_pgn_json("", 3),
        r#"{"ok":false,"error":"invalid-pgn"}"#
    );
    assert_eq!(
        review_pgn_json("1. e4 *", 1),
        r#"{"ok":false,"error":"invalid-depth"}"#
    );
    assert_eq!(
        review_pgn_json("1. e4 *", 7),
        r#"{"ok":false,"error":"invalid-depth"}"#
    );
    assert_eq!(
        review_pgn_json("1. e4 {comment} *", 3),
        r#"{"ok":false,"error":"invalid-pgn"}"#
    );
}

#[test]
fn review_pgn_with_artifacts_json_returns_artifacts_without_raw_pgn() {
    let output = review_pgn_with_artifacts_json("1. f3 e5 2. g4 Qh4# 0-1", 3);

    assert!(output.starts_with(r#"{"ok":true,"reviewWithArtifacts":{"#));
    assert!(output.contains(r#""review":{"summary":{"#));
    assert!(output.contains(r#""artifacts":{"keyMoments":["#));
    assert!(output.contains(r#""kind":"centipawn-loss""#));
    assert!(output.contains(r#""kind":"local-search-swing""#));
    assert!(output.contains(r#""forkCandidates":["#));
    assert!(output.contains(r#""earlyMoveDivergences":["#));
    assert!(output.contains(r#""retryPositions":["#));
    assert!(
        !output.contains(r#""fenBefore":"rnbqkbnr/pppp1ppp/8/4p3/5P2/8/PPPPP1PP/RNBQKQ - 0 2"#)
    );
    assert!(!output.contains("1. f3"));
}

#[test]
fn review_pgn_with_artifacts_json_exposes_fork_candidate_facts() {
    let output = review_pgn_with_artifacts_json("1. e4 e5 2. Qh5 Nc6 3. Bc4 Bc5 4. a3 *", 2);

    assert!(output.contains(r#""forkCandidates":[{"rank":1"#));
    assert!(output.contains(r#""sourceKind":"best-move-after-position""#));
    assert!(output.contains(r#""bestMove":"h5f7""#));
    assert!(output.contains(r#""movedPiece":{"color":"white","kind":"queen"}"#));
    assert!(output.contains(r#""destination":"f7""#));
    assert!(output.contains(r#""square":"e8""#));
    assert!(output.contains(r#""kind":"king""#));
    assert!(output.contains(r#""square":"g7""#));
    assert!(output.contains(r#""kind":"pawn""#));
    assert!(!output.contains("1. e4"));
}

#[test]
fn side_explore_json_returns_structured_result() {
    let output = side_explore_json(STARTPOS, "white", true);

    assert!(output.starts_with(r#"{"ok":true,"sideExplore":{"#));
    assert!(output.contains(r#""onTurn":true"#));
    assert!(output.contains(r#""replyCandidates":[]"#));
    assert!(output.contains(r#""side":"white""#));
    assert!(output.contains(r#""candidates":["#));
    assert!(output.contains(r#""sound":true"#));
    assert!(output.contains(r#""sacrifice":false"#));
    assert!(output.contains(r#""soundMarginCp":50"#));
    assert!(output.contains(r#""principalLine":["#));
}

#[test]
fn side_explore_json_off_turn_is_not_on_turn() {
    let output = side_explore_json(STARTPOS, "black", false);

    assert!(output.starts_with(r#"{"ok":true,"sideExplore":{"#));
    assert!(output.contains(r#""onTurn":false"#));
    assert!(output.contains(r#""side":"black""#));
    assert!(output.contains(r#""replyCandidates":[{"move":""#));
    assert!(output.contains(r#""role":"objective-primary""#));
    assert!(output.contains(r#""quality":""#));
    assert!(output.contains(r#""mateIn":"#));
}

#[test]
fn side_explore_json_maps_bad_color_to_error() {
    let output = side_explore_json(STARTPOS, "purple", false);
    assert_eq!(output, r#"{"ok":false,"error":"invalid-position"}"#);
}

#[test]
fn side_explore_json_maps_bad_fen_to_error() {
    let output = side_explore_json("not-a-fen", "white", false);
    assert_eq!(output, r#"{"ok":false,"error":"invalid-fen"}"#);
}
