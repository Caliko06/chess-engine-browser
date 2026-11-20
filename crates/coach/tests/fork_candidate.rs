use chess_board::{Move, Piece, PieceKind, Square};
use chess_coach::{
    ForkCandidateSourceKind, MoveLabel, RetryPosition, collect_fork_candidate_evidence,
};

fn mv(text: &str) -> Move {
    Move::from_coordinate(text).expect("test move should parse")
}

fn square(text: &str) -> Square {
    Square::from_algebraic(text).expect("test square should parse")
}

fn retry(fen_before: &str, best_move: Option<&str>) -> RetryPosition {
    RetryPosition {
        rank: 2,
        entry_index: 4,
        ply: 5,
        fen_before: fen_before.to_owned(),
        played_move: mv("e5g4"),
        best_move: best_move.map(mv),
        san: "synthetic".to_owned(),
        label: MoveLabel::Blunder,
        cp_loss: 420,
    }
}

#[test]
fn fork_candidate_evidence_empty_and_missing_best_move_return_empty() {
    assert_eq!(collect_fork_candidate_evidence(&[]), Ok(Vec::new()));
    assert_eq!(
        collect_fork_candidate_evidence(&[retry("k2q3r/8/8/4N3/8/8/8/4K3 w - - 0 1", None,)]),
        Ok(Vec::new())
    );
}

#[test]
fn fork_candidate_evidence_reports_best_move_attacking_two_targets() {
    let evidence = collect_fork_candidate_evidence(&[retry(
        "k2q4/8/7b/4N3/8/8/8/4K3 w - - 0 1",
        Some("e5f7"),
    )])
    .expect("fork evidence must run");

    assert_eq!(evidence.len(), 1);
    let candidate = &evidence[0];
    assert_eq!(candidate.rank, 2);
    assert_eq!(candidate.entry_index, 4);
    assert_eq!(candidate.ply, 5);
    assert_eq!(
        candidate.source_kind,
        ForkCandidateSourceKind::BestMoveAfterPosition
    );
    assert_eq!(candidate.best_move, mv("e5f7"));
    assert_eq!(
        candidate.moved_piece,
        Piece::new(chess_board::Color::White, PieceKind::Knight)
    );
    assert_eq!(candidate.destination, square("f7"));
    assert_eq!(candidate.cp_loss, 420);
    assert_eq!(candidate.label, MoveLabel::Blunder);
    assert_eq!(
        candidate
            .targets
            .iter()
            .map(|target| (target.square.to_algebraic(), target.piece.kind()))
            .collect::<Vec<_>>(),
        [
            ("d8".to_owned(), PieceKind::Queen),
            ("h6".to_owned(), PieceKind::Bishop),
        ]
    );
}

#[test]
fn fork_candidate_evidence_rejects_mutually_defended_targets() {
    assert_eq!(
        collect_fork_candidate_evidence(&[retry(
            "k2q3r/8/8/4N3/8/8/8/4K3 w - - 0 1",
            Some("e5f7"),
        )]),
        Ok(Vec::new())
    );
}

#[test]
fn fork_candidate_evidence_filters_defended_targets_before_threshold() {
    assert_eq!(
        collect_fork_candidate_evidence(&[retry(
            "k2q4/8/1b5b/4N3/8/8/8/4K3 w - - 0 1",
            Some("e5f7"),
        )]),
        Ok(Vec::new())
    );
}

#[test]
fn fork_candidate_evidence_rejects_pawn_only_targets() {
    assert_eq!(
        collect_fork_candidate_evidence(&[
            retry("k7/8/8/4N3/8/8/5p1p/K7 w - - 0 1", Some("e5g4"),)
        ]),
        Ok(Vec::new())
    );
}

#[test]
fn fork_candidate_evidence_rejects_immediately_capturable_moved_piece() {
    assert_eq!(
        collect_fork_candidate_evidence(&[retry(
            "3q2kr/8/8/4N3/8/8/8/4K3 w - - 0 1",
            Some("e5f7"),
        )]),
        Ok(Vec::new())
    );
}

#[test]
fn fork_candidate_evidence_ignores_best_move_missing_from_position() {
    assert_eq!(
        collect_fork_candidate_evidence(&[retry(
            "k2q3r/8/8/4N3/8/8/8/4K3 w - - 0 1",
            Some("e5e6"),
        )]),
        Ok(Vec::new())
    );
}

#[test]
fn fork_candidate_evidence_ignores_stale_retry_and_keeps_later_evidence() {
    let evidence = collect_fork_candidate_evidence(&[
        retry("k2q4/8/7b/4N3/8/8/8/4K3 w - - 0 1", Some("e5e6")),
        retry("k2q4/8/7b/4N3/8/8/8/4K3 w - - 0 1", Some("e5f7")),
    ])
    .expect("fork evidence must ignore stale retry positions");

    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0].best_move, mv("e5f7"));
}

#[test]
fn fork_candidate_evidence_requires_two_attacked_enemy_targets() {
    assert_eq!(
        collect_fork_candidate_evidence(&[
            retry("k2q4/8/8/4N3/8/8/8/4K3 w - - 0 1", Some("e5f7"),)
        ]),
        Ok(Vec::new())
    );
}

#[test]
fn fork_candidate_evidence_rejects_invalid_fen() {
    assert!(collect_fork_candidate_evidence(&[retry("not-a-fen", Some("e5f7"))]).is_err());
}
