use chess_board::{PgnError, PgnGame};

#[test]
fn pgn_parses_local_game_tags_moves_and_result() {
    let text = r#"[Event "Local"]
[Site "Device"]
[Result "1-0"]

1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0"#;

    let game = PgnGame::from_pgn(text).unwrap();

    assert_eq!(
        game.to_pgn().unwrap(),
        "[Event \"Local\"]\n[Site \"Device\"]\n[Result \"1-0\"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0"
    );
    assert_eq!(
        game.moves()
            .iter()
            .map(|mv| mv.to_coordinate())
            .collect::<Vec<_>>(),
        ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"]
    );
}

#[test]
fn pgn_writes_canonical_san_movetext() {
    let game = PgnGame::from_pgn(
        "[Event \"Local\"]\n[Result \"1-0\"]\n\n1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7# 1-0",
    )
    .unwrap();

    assert_eq!(
        game.to_pgn().unwrap(),
        "[Event \"Local\"]\n[Result \"1-0\"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0"
    );
}

#[test]
fn pgn_accepts_compact_move_numbers_and_annotations() {
    let game = PgnGame::from_pgn("1.e4! e5 2.Nf3?? Nc6 *").unwrap();

    assert_eq!(game.to_pgn().unwrap(), "1. e4 e5 2. Nf3 Nc6 *");
}

#[test]
fn pgn_roundtrips_tag_escaping() {
    let game =
        PgnGame::from_pgn("[Event \"Local \\\"rapid\\\"\"]\n[Result \"*\"]\n\n1. e4 *").unwrap();
    let written = game.to_pgn().unwrap();
    let parsed = PgnGame::from_pgn(&written).unwrap();

    assert_eq!(
        parsed.to_pgn().unwrap(),
        "[Event \"Local \\\"rapid\\\"\"]\n[Result \"*\"]\n\n1. e4 *"
    );
}

#[test]
fn pgn_parses_repo_authored_long_knight_shuffle() {
    let mut text = String::from("[Event \"Local long parse probe\"]\n[Result \"*\"]\n\n");
    for move_number in 1..=40 {
        if move_number % 2 == 1 {
            text.push_str(&format!("{move_number}. Nf3 Nf6 "));
        } else {
            text.push_str(&format!("{move_number}. Ng1 Ng8 "));
        }
    }
    text.push('*');

    let game = PgnGame::from_pgn(&text).unwrap();

    assert_eq!(game.moves().len(), 80);
    assert!(game.to_pgn().unwrap().contains("40. Ng1 Ng8 *"));
}

#[test]
fn pgn_rejects_unsupported_features_and_illegal_moves() {
    assert_eq!(
        PgnGame::from_pgn("[FEN \"8/8/8/8/8/8/8/8 w - - 0 1\"]\n\n*").unwrap_err(),
        PgnError::UnsupportedFeature
    );
    assert_eq!(
        PgnGame::from_pgn("1. e4 {comment} *").unwrap_err(),
        PgnError::UnsupportedFeature
    );
    assert_eq!(
        PgnGame::from_pgn("1. e5 *").unwrap_err(),
        PgnError::IllegalMove
    );
    assert_eq!(
        PgnGame::from_pgn("[Event \"A\"B\"]\n\n*").unwrap_err(),
        PgnError::InvalidTag
    );
}

#[test]
fn pgn_rejects_result_mismatch() {
    assert_eq!(
        PgnGame::from_pgn("[Result \"1-0\"]\n\n1. e4 *").unwrap_err(),
        PgnError::ResultMismatch
    );
}
