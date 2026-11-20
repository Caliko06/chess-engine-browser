use chess_board::{Move, PgnError, PgnGame};
use chess_coach::{CoachConfig, CoachError, MoveLabel, review_coordinate_game, review_pgn_game};

fn mv(text: &str) -> Move {
    Move::from_coordinate(text).expect("test move should parse")
}

#[test]
fn review_rejects_depth_one_and_depth_above_search_limit() {
    assert_eq!(
        review_coordinate_game(&[], CoachConfig { search_depth: 1 }).unwrap_err(),
        CoachError::InvalidDepth
    );
    assert_eq!(
        review_coordinate_game(&[], CoachConfig { search_depth: 7 }).unwrap_err(),
        CoachError::InvalidDepth
    );
}

#[test]
fn review_empty_game_is_deterministic_with_empty_summary() {
    let review = review_coordinate_game(&[], CoachConfig { search_depth: 2 }).unwrap();

    assert!(review.entries.is_empty());
    assert_eq!(review.summary.total_moves, 0);
    assert_eq!(review.summary.best, 0);
    assert_eq!(review.summary.good, 0);
    assert_eq!(review.summary.inaccuracies, 0);
    assert_eq!(review.summary.mistakes, 0);
    assert_eq!(review.summary.blunders, 0);
}

#[test]
fn review_uses_engine_development_preference_with_stable_san() {
    let review = review_coordinate_game(&[mv("a2a3")], CoachConfig { search_depth: 3 }).unwrap();

    assert_eq!(review.entries.len(), 1);
    let entry = &review.entries[0];
    assert_eq!(entry.ply, 1);
    assert_eq!(entry.played_move.to_coordinate(), "a2a3");
    assert_eq!(entry.san, "a3");
    assert_eq!(
        entry.best_move.map(|mv| mv.to_coordinate()),
        Some("b1c3".to_owned())
    );
    assert_eq!(entry.cp_loss, 30);
    assert_eq!(entry.label, MoveLabel::Good);
    assert_eq!(review.summary.total_moves, 1);
    assert_eq!(review.summary.good, 1);
}

#[test]
fn review_reports_illegal_move_without_partial_review() {
    assert_eq!(
        review_coordinate_game(&[mv("a7a6")], CoachConfig { search_depth: 2 }).unwrap_err(),
        CoachError::IllegalMove
    );
}

#[test]
fn review_is_byte_stable_for_repeated_white_and_black_moves() {
    let moves = [mv("a2a3"), mv("a7a6"), mv("b2b3")];
    let config = CoachConfig { search_depth: 2 };

    let first = review_coordinate_game(&moves, config).unwrap();
    let second = review_coordinate_game(&moves, config).unwrap();

    assert_eq!(first, second);
    assert_eq!(first.entries.len(), 3);
    assert_eq!(first.entries[1].ply, 2);
    assert_eq!(first.entries[1].played_move.to_coordinate(), "a7a6");
    assert!(first.entries.iter().all(|entry| entry.cp_loss <= 30_000));
}

#[test]
fn review_flags_fools_mate_setup_as_blunder() {
    let moves = [mv("f2f3"), mv("e7e5"), mv("g2g4")];
    let review = review_coordinate_game(&moves, CoachConfig { search_depth: 3 }).unwrap();

    let entry = &review.entries[2];
    assert_eq!(entry.played_move.to_coordinate(), "g2g4");
    assert_eq!(entry.label, MoveLabel::Blunder, "{entry:?}");
    assert!(entry.cp_loss > 300, "{entry:?}");
    assert_eq!(review.summary.blunders, 1);
}

#[test]
fn review_scores_black_missed_mate_from_black_perspective() {
    let moves = [mv("f2f3"), mv("e7e5"), mv("g2g4"), mv("a7a6")];
    let review = review_coordinate_game(&moves, CoachConfig { search_depth: 3 }).unwrap();
    let entry = &review.entries[3];

    assert_eq!(entry.played_move.to_coordinate(), "a7a6");
    assert_eq!(
        entry.best_move.map(|mv| mv.to_coordinate()),
        Some("d8h4".to_owned())
    );
    assert_eq!(entry.best_score_cp, 29_999);
    assert_eq!(entry.played_score_cp, 52);
    assert_eq!(entry.cp_loss, 29_947);
    assert_eq!(entry.label, MoveLabel::Blunder);
}

#[test]
fn review_pgn_game_matches_coordinate_review() {
    let game = PgnGame::from_pgn("1. f3 e5 2. g4 *").unwrap();
    let config = CoachConfig { search_depth: 3 };

    assert_eq!(
        review_pgn_game(&game, config).unwrap(),
        review_coordinate_game(game.moves(), config).unwrap()
    );
}

#[test]
fn review_pgn_game_is_byte_stable_for_repeated_reviews() {
    let game = PgnGame::from_pgn("1. a3 a6 2. b3 *").unwrap();
    let config = CoachConfig { search_depth: 2 };

    let first = review_pgn_game(&game, config).unwrap();
    let second = review_pgn_game(&game, config).unwrap();

    assert_eq!(first, second);
    assert_eq!(first.summary.total_moves, 3);
}

#[test]
fn review_pgn_game_accepts_empty_parsed_game() {
    let game = PgnGame::from_pgn("*").unwrap();
    let review = review_pgn_game(&game, CoachConfig { search_depth: 2 }).unwrap();

    assert!(review.entries.is_empty());
    assert_eq!(review.summary.total_moves, 0);
}

#[test]
fn unsupported_pgn_features_fail_before_coach_review() {
    assert_eq!(
        PgnGame::from_pgn("1. e4 {comment} *").unwrap_err(),
        PgnError::UnsupportedFeature
    );
}
