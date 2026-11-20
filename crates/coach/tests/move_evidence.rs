use chess_board::{Move, PgnGame};
use chess_coach::{
    CoachConfig, EvidenceKind, KeyMoment, KeyMomentConfig, KeyMomentKind, MoveEvidence, MoveLabel,
    ReviewEntry, collect_key_moment_evidence, review_coordinate_game, review_pgn_game,
    select_key_moments,
};

fn mv(text: &str) -> Move {
    Move::from_coordinate(text).expect("test move should parse")
}

fn entry(index: usize, label: MoveLabel, cp_loss: u32) -> ReviewEntry {
    ReviewEntry {
        ply: index + 1,
        played_move: mv(["a2a3", "a7a6", "b2b3", "b7b6"][index]),
        san: format!("m{}", index + 1),
        best_move: Some(mv("a2a3")),
        best_score_cp: 500,
        played_score_cp: 500 - i32::try_from(cp_loss).expect("test loss fits i32"),
        cp_loss,
        label,
    }
}

fn moment(rank: usize, entry_index: usize, entry: ReviewEntry) -> KeyMoment {
    KeyMoment {
        rank,
        entry_index,
        kind: KeyMomentKind::CentipawnLoss,
        entry,
    }
}

#[test]
fn local_search_swing_empty_and_zero_loss_moments_produce_no_evidence() {
    assert!(collect_key_moment_evidence(&[]).is_empty());
    assert!(collect_key_moment_evidence(&[moment(1, 0, entry(0, MoveLabel::Best, 0))]).is_empty());
}

#[test]
fn local_search_swing_copies_exact_review_fields() {
    let evidence = collect_key_moment_evidence(&[moment(3, 2, entry(2, MoveLabel::Mistake, 275))]);

    assert_eq!(
        evidence,
        [MoveEvidence {
            rank: 3,
            entry_index: 2,
            ply: 3,
            kind: EvidenceKind::LocalSearchSwing,
            played_move: mv("b2b3"),
            san: "m3".to_owned(),
            best_move: Some(mv("a2a3")),
            best_score_cp: 500,
            played_score_cp: 225,
            cp_loss: 275,
            label: MoveLabel::Mistake,
        }]
    );
}

#[test]
fn local_search_swing_preserves_supplied_order_without_reranking() {
    let evidence = collect_key_moment_evidence(&[
        moment(2, 1, entry(1, MoveLabel::Good, 20)),
        moment(1, 3, entry(3, MoveLabel::Blunder, 900)),
    ]);

    assert_eq!(
        evidence
            .iter()
            .map(|item| (item.rank, item.entry_index, item.cp_loss, item.label))
            .collect::<Vec<_>>(),
        [(2, 1, 20, MoveLabel::Good), (1, 3, 900, MoveLabel::Blunder),]
    );
}

#[test]
fn local_search_swing_projects_synthetic_moments_without_revalidation() {
    let synthetic = ReviewEntry {
        ply: 99,
        played_move: mv("h2h4"),
        san: "synthetic".to_owned(),
        best_move: None,
        best_score_cp: -20,
        played_score_cp: -70,
        cp_loss: 50,
        label: MoveLabel::Good,
    };

    let evidence = collect_key_moment_evidence(&[moment(7, 42, synthetic)]);

    assert_eq!(evidence[0].rank, 7);
    assert_eq!(evidence[0].entry_index, 42);
    assert_eq!(evidence[0].ply, 99);
    assert_eq!(evidence[0].best_move, None);
    assert_eq!(evidence[0].san, "synthetic");
}

#[test]
fn local_search_swing_is_byte_stable_for_pgn_and_coordinate_reviews() {
    let game = PgnGame::from_pgn("1. f3 e5 2. g4 *").unwrap();
    let coach_config = CoachConfig { search_depth: 3 };
    let moment_config = KeyMomentConfig {
        max_moments: 2,
        minimum_label: MoveLabel::Mistake,
    };

    let pgn_moments = select_key_moments(
        &review_pgn_game(&game, coach_config).unwrap(),
        moment_config,
    );
    let coordinate_moments = select_key_moments(
        &review_coordinate_game(game.moves(), coach_config).unwrap(),
        moment_config,
    );
    let pgn_evidence = collect_key_moment_evidence(&pgn_moments);
    let coordinate_evidence = collect_key_moment_evidence(&coordinate_moments);

    assert!(!pgn_evidence.is_empty());
    assert_eq!(pgn_evidence, coordinate_evidence);
    assert_eq!(pgn_evidence, collect_key_moment_evidence(&pgn_moments));
}
