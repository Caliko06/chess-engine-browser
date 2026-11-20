use chess_board::{Move, PgnGame, Position};
use chess_coach::{
    CoachConfig, CoachError, GameReview, MoveLabel, RetryConfig, ReviewEntry, ReviewSummary,
    generate_retry_positions, review_coordinate_game, review_pgn_game,
};

fn mv(text: &str) -> Move {
    Move::from_coordinate(text).expect("test move should parse")
}

fn entry(ply: usize, coordinate: &str, label: MoveLabel, cp_loss: u32) -> ReviewEntry {
    ReviewEntry {
        ply,
        played_move: mv(coordinate),
        san: format!("san-{ply}"),
        best_move: Some(mv("a2a3")),
        best_score_cp: 1_000,
        played_score_cp: 1_000 - i32::try_from(cp_loss).expect("test loss fits i32"),
        cp_loss,
        label,
    }
}

fn review(entries: Vec<ReviewEntry>) -> GameReview {
    GameReview {
        entries,
        summary: ReviewSummary::default(),
    }
}

#[test]
fn retry_positions_empty_or_zero_bound_returns_empty_without_replay() {
    assert_eq!(
        generate_retry_positions(&[], &review(Vec::new()), config(3, MoveLabel::Good)),
        Ok(Vec::new())
    );

    let illegal_history = [mv("e2e5")];
    let illegal_review = review(vec![entry(1, "e2e5", MoveLabel::Blunder, 500)]);

    assert_eq!(
        generate_retry_positions(
            &illegal_history,
            &illegal_review,
            config(0, MoveLabel::Good)
        ),
        Ok(Vec::new())
    );
    assert_eq!(
        generate_retry_positions(
            &illegal_history,
            &review(Vec::new()),
            config(1, MoveLabel::Good)
        ),
        Err(CoachError::IllegalMove)
    );
    assert_eq!(
        generate_retry_positions(
            &illegal_history,
            &review(vec![entry(1, "e2e5", MoveLabel::Good, 10)]),
            config(1, MoveLabel::Blunder)
        ),
        Err(CoachError::IllegalMove)
    );
}

#[test]
fn retry_positions_filter_rank_and_copy_selected_review_context() {
    let moves = [mv("f2f3"), mv("e7e5"), mv("g2g4"), mv("d8h4")];
    let game_review = review(vec![
        entry(1, "f2f3", MoveLabel::Best, 0),
        entry(2, "e7e5", MoveLabel::Mistake, 900),
        entry(3, "g2g4", MoveLabel::Blunder, 350),
        entry(4, "d8h4", MoveLabel::Inaccuracy, 1_000),
    ]);

    let retries =
        generate_retry_positions(&moves, &game_review, config(2, MoveLabel::Inaccuracy)).unwrap();

    assert_eq!(retries.len(), 2);
    assert_eq!(retries[0].rank, 1);
    assert_eq!(retries[0].entry_index, 2);
    assert_eq!(retries[0].ply, 3);
    assert_eq!(
        retries[0].fen_before,
        "rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2"
    );
    assert_eq!(retries[0].played_move, mv("g2g4"));
    assert_eq!(retries[0].best_move, Some(mv("a2a3")));
    assert_eq!(retries[0].san, "san-3");
    assert_eq!(retries[0].label, MoveLabel::Blunder);
    assert_eq!(retries[0].cp_loss, 350);

    assert_eq!(retries[1].rank, 2);
    assert_eq!(retries[1].entry_index, 1);
    assert_eq!(
        retries[1].fen_before,
        "rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1"
    );
    for retry in &retries {
        assert_eq!(
            Position::from_fen(&retry.fen_before).unwrap().to_fen(),
            retry.fen_before
        );
    }
}

#[test]
fn retry_positions_are_byte_stable_for_pgn_and_coordinate_reviews() {
    let game = PgnGame::from_pgn("1. f3 e5 2. g4 *").unwrap();
    let coach_config = CoachConfig { search_depth: 3 };
    let retry_config = config(2, MoveLabel::Mistake);

    let pgn_review = review_pgn_game(&game, coach_config).unwrap();
    let coordinate_review = review_coordinate_game(game.moves(), coach_config).unwrap();
    let pgn_retries = generate_retry_positions(game.moves(), &pgn_review, retry_config).unwrap();
    let coordinate_retries =
        generate_retry_positions(game.moves(), &coordinate_review, retry_config).unwrap();

    assert!(!pgn_retries.is_empty());
    assert_eq!(pgn_retries, coordinate_retries);
    assert_eq!(
        pgn_retries,
        generate_retry_positions(game.moves(), &pgn_review, retry_config).unwrap()
    );
}

#[test]
fn retry_positions_reject_illegal_supplied_move_history() {
    let moves = [mv("e2e5")];
    let game_review = review(vec![entry(1, "e2e5", MoveLabel::Blunder, 500)]);

    assert_eq!(
        generate_retry_positions(&moves, &game_review, config(1, MoveLabel::Good)),
        Err(CoachError::IllegalMove)
    );
}

#[test]
fn retry_positions_reject_inconsistent_review_index_ply_or_move() {
    let moves = [mv("f2f3")];

    assert_eq!(
        generate_retry_positions(
            &moves,
            &review(vec![
                entry(1, "f2f3", MoveLabel::Best, 0),
                entry(2, "e7e5", MoveLabel::Blunder, 500),
            ]),
            config(1, MoveLabel::Good),
        ),
        Err(CoachError::InconsistentReview)
    );
    assert_eq!(
        generate_retry_positions(
            &moves,
            &review(vec![entry(2, "f2f3", MoveLabel::Blunder, 500)]),
            config(1, MoveLabel::Good),
        ),
        Err(CoachError::InconsistentReview)
    );
    assert_eq!(
        generate_retry_positions(
            &moves,
            &review(vec![entry(1, "e2e4", MoveLabel::Blunder, 500)]),
            config(1, MoveLabel::Good),
        ),
        Err(CoachError::InconsistentReview)
    );
}

fn config(max_positions: usize, minimum_label: MoveLabel) -> RetryConfig {
    RetryConfig {
        max_positions,
        minimum_label,
    }
}
