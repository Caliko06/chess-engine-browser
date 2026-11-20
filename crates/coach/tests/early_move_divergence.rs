use chess_board::{Move, PgnGame};
use chess_coach::{
    CoachConfig, EARLY_MOVE_DIVERGENCE_MAX_PLIES, EarlyMoveDivergenceConfig, GameReview, MoveLabel,
    ReviewEntry, ReviewSummary, review_coordinate_game, review_pgn_game,
    select_early_move_divergences,
};

fn mv(text: &str) -> Move {
    Move::from_coordinate(text).expect("test move should parse")
}

fn entry(
    ply: usize,
    played_move: &str,
    best_move: Option<&str>,
    cp_loss: u32,
    label: MoveLabel,
) -> ReviewEntry {
    ReviewEntry {
        ply,
        played_move: mv(played_move),
        san: format!("san-{ply}"),
        best_move: best_move.map(mv),
        best_score_cp: 200,
        played_score_cp: 200 - i32::try_from(cp_loss).expect("test loss fits i32"),
        cp_loss,
        label,
    }
}

fn review(entries: Vec<ReviewEntry>) -> GameReview {
    GameReview {
        entries,
        summary: ReviewSummary {
            total_moves: 99,
            best: 99,
            good: 0,
            inaccuracies: 0,
            mistakes: 0,
            blunders: 0,
        },
    }
}

#[test]
fn early_move_divergences_empty_and_wrong_reasons_return_empty() {
    assert!(select_early_move_divergences(&review(Vec::new()), config(1)).is_empty());

    let game_review = review(vec![
        entry(0, "a2a3", Some("a2a4"), 500, MoveLabel::Blunder),
        entry(1, "a2a3", None, 500, MoveLabel::Blunder),
        entry(2, "a7a6", Some("a7a6"), 500, MoveLabel::Blunder),
        entry(3, "b2b3", Some("b2b4"), 0, MoveLabel::Best),
        entry(4, "b7b6", Some("b7b5"), 49, MoveLabel::Good),
        entry(
            EARLY_MOVE_DIVERGENCE_MAX_PLIES + 1,
            "c2c3",
            Some("c2c4"),
            900,
            MoveLabel::Blunder,
        ),
    ]);

    assert!(select_early_move_divergences(&game_review, config(50)).is_empty());
}

#[test]
fn early_move_divergences_copy_fields_and_preserve_review_order() {
    let game_review = review(vec![
        entry(1, "a2a3", Some("a2a4"), 75, MoveLabel::Inaccuracy),
        entry(6, "a7a6", Some("a7a5"), 150, MoveLabel::Inaccuracy),
        entry(
            EARLY_MOVE_DIVERGENCE_MAX_PLIES,
            "b2b3",
            Some("b2b4"),
            300,
            MoveLabel::Mistake,
        ),
    ]);

    let divergences = select_early_move_divergences(&game_review, config(50));

    assert_eq!(
        divergences.iter().map(summary).collect::<Vec<_>>(),
        [
            "0 1 a2a3 san-1 a2a4 125 75",
            "1 6 a7a6 san-6 a7a5 50 150",
            "2 10 b2b3 san-10 b2b4 -100 300",
        ]
    );
    assert_eq!(divergences[2].best_score_cp, 200);
    assert_eq!(divergences[2].label, MoveLabel::Mistake);
}

#[test]
fn early_move_divergences_are_byte_stable_for_synthetic_reviews() {
    let game_review = review(vec![entry(5, "h2h4", Some("h2h3"), 50, MoveLabel::Good)]);

    let first = select_early_move_divergences(&game_review, config(1));
    let second = select_early_move_divergences(&game_review, config(1));

    assert_eq!(first, second);
    assert_eq!(first[0].entry_index, 0);
    assert_eq!(first[0].san, "san-5");
}

#[test]
fn early_move_divergences_are_byte_stable_for_pgn_and_coordinate_reviews() {
    let game = PgnGame::from_pgn("1. f3 e5 2. g4 *").unwrap();
    let coach_config = CoachConfig { search_depth: 3 };
    let divergence_config = config(1);

    let pgn_divergences = select_early_move_divergences(
        &review_pgn_game(&game, coach_config).unwrap(),
        divergence_config,
    );
    let coordinate_divergences = select_early_move_divergences(
        &review_coordinate_game(game.moves(), coach_config).unwrap(),
        divergence_config,
    );

    assert!(!pgn_divergences.is_empty());
    assert_eq!(pgn_divergences, coordinate_divergences);
    assert_eq!(
        pgn_divergences,
        select_early_move_divergences(
            &review_pgn_game(&game, coach_config).unwrap(),
            divergence_config,
        )
    );
}

fn config(minimum_cp_loss: u32) -> EarlyMoveDivergenceConfig {
    EarlyMoveDivergenceConfig { minimum_cp_loss }
}

fn summary(divergence: &chess_coach::EarlyMoveDivergence) -> String {
    format!(
        "{} {} {} {} {} {} {}",
        divergence.entry_index,
        divergence.ply,
        divergence.played_move.to_coordinate(),
        divergence.san.as_str(),
        divergence.local_best_move.to_coordinate(),
        divergence.played_score_cp,
        divergence.cp_loss,
    )
}
