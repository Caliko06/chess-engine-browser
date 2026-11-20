use chess_board::{Move, PgnGame};
use chess_coach::{
    CoachConfig, GameReview, KeyMomentConfig, KeyMomentKind, MoveLabel, ReviewEntry, ReviewSummary,
    review_coordinate_game, review_pgn_game, select_key_moments,
};

fn mv(text: &str) -> Move {
    Move::from_coordinate(text).expect("test move should parse")
}

fn entry(index: usize, label: MoveLabel, cp_loss: u32) -> ReviewEntry {
    ReviewEntry {
        ply: index + 1,
        played_move: mv(["a2a3", "a7a6", "b2b3", "b7b6", "c2c3"][index]),
        san: format!("m{}", index + 1),
        best_move: Some(mv("a2a3")),
        best_score_cp: 1_000,
        played_score_cp: 1_000 - i32::try_from(cp_loss).expect("test loss fits i32"),
        cp_loss,
        label,
    }
}

#[test]
fn key_moments_empty_or_zero_bound_returns_empty() {
    let review = GameReview {
        entries: vec![entry(0, MoveLabel::Blunder, 500)],
        summary: ReviewSummary::default(),
    };

    assert!(
        select_key_moments(
            &GameReview {
                entries: Vec::new(),
                summary: ReviewSummary::default(),
            },
            config(3, MoveLabel::Good),
        )
        .is_empty()
    );
    assert!(select_key_moments(&review, config(0, MoveLabel::Good)).is_empty());
}

#[test]
fn key_moments_filter_bound_and_rank_by_approved_order() {
    let review = GameReview {
        entries: vec![
            entry(0, MoveLabel::Best, 0),
            entry(1, MoveLabel::Mistake, 900),
            entry(2, MoveLabel::Blunder, 350),
            entry(3, MoveLabel::Blunder, 350),
            entry(4, MoveLabel::Inaccuracy, 1_000),
        ],
        summary: ReviewSummary::default(),
    };

    let moments = select_key_moments(&review, config(3, MoveLabel::Inaccuracy));

    assert_eq!(moments.len(), 3);
    assert_eq!(
        moments
            .iter()
            .map(|moment| (
                moment.rank,
                moment.entry_index,
                moment.kind,
                moment.entry.label
            ))
            .collect::<Vec<_>>(),
        [
            (1, 2, KeyMomentKind::CentipawnLoss, MoveLabel::Blunder),
            (2, 3, KeyMomentKind::CentipawnLoss, MoveLabel::Blunder),
            (3, 1, KeyMomentKind::CentipawnLoss, MoveLabel::Mistake),
        ]
    );
    assert_eq!(moments[0].entry.cp_loss, 350);
    assert_eq!(moments[1].entry.cp_loss, 350);
    assert_eq!(moments[2].entry.cp_loss, 900);
}

#[test]
fn key_moments_use_cp_loss_within_same_label_and_ignore_summary() {
    let review = GameReview {
        entries: vec![
            entry(0, MoveLabel::Good, 40),
            entry(1, MoveLabel::Good, 50),
            entry(2, MoveLabel::Inaccuracy, 51),
        ],
        summary: ReviewSummary {
            total_moves: 99,
            best: 99,
            good: 0,
            inaccuracies: 0,
            mistakes: 0,
            blunders: 0,
        },
    };

    let moments = select_key_moments(&review, config(5, MoveLabel::Good));

    assert_eq!(
        moments
            .iter()
            .map(|moment| (moment.entry_index, moment.entry.cp_loss))
            .collect::<Vec<_>>(),
        [(2, 51), (1, 50), (0, 40)]
    );
}

#[test]
fn key_moments_are_byte_stable_for_pgn_and_coordinate_reviews() {
    let game = PgnGame::from_pgn("1. f3 e5 2. g4 *").unwrap();
    let coach_config = CoachConfig { search_depth: 3 };
    let moment_config = config(2, MoveLabel::Mistake);

    let pgn_moments = select_key_moments(
        &review_pgn_game(&game, coach_config).unwrap(),
        moment_config,
    );
    let coordinate_moments = select_key_moments(
        &review_coordinate_game(game.moves(), coach_config).unwrap(),
        moment_config,
    );

    assert!(!pgn_moments.is_empty());
    assert_eq!(pgn_moments[0].rank, 1);
    assert_eq!(pgn_moments, coordinate_moments);
    assert_eq!(
        pgn_moments,
        select_key_moments(
            &review_pgn_game(&game, coach_config).unwrap(),
            moment_config
        )
    );
}

fn config(max_moments: usize, minimum_label: MoveLabel) -> KeyMomentConfig {
    KeyMomentConfig {
        max_moments,
        minimum_label,
    }
}
