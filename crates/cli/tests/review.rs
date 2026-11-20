use std::process::{Command, Output};

fn run_chess_cli(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_chess-cli"))
        .args(args)
        .output()
        .expect("failed to run chess-cli")
}

fn stdout_text(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).expect("stdout should be utf-8")
}

fn stderr_text(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).expect("stderr should be utf-8")
}

#[test]
fn cli_review_pgn_outputs_stable_core_review_json() {
    let pgn = "1. a3 *";
    let first = run_chess_cli(&["review-pgn", "--pgn", pgn, "--depth", "3"]);
    let second = run_chess_cli(&["review-pgn", "--pgn", pgn, "--depth", "3"]);

    assert_eq!(first.status.code(), Some(0));
    assert_eq!(stderr_text(&first), "");
    assert_eq!(stdout_text(&first), stdout_text(&second));
    assert_eq!(
        stdout_text(&first),
        "{\"command\":\"review-pgn\",\"depth\":3,\"summary\":{\"total_moves\":1,\"best\":0,\"good\":1,\"inaccuracies\":0,\"mistakes\":0,\"blunders\":0},\"entries\":[{\"ply\":1,\"played_move\":\"a2a3\",\"san\":\"a3\",\"best_move\":\"b1c3\",\"best_score_cp\":24,\"played_score_cp\":-6,\"cp_loss\":30,\"label\":\"good\"}]}"
    );
    assert!(!stdout_text(&first).ends_with('\n'));
}

#[test]
fn cli_review_pgn_allows_parser_valid_empty_game() {
    let output = run_chess_cli(&["review-pgn", "--pgn", "*", "--depth", "2"]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stderr_text(&output), "");
    assert_eq!(
        stdout_text(&output),
        "{\"command\":\"review-pgn\",\"depth\":2,\"summary\":{\"total_moves\":0,\"best\":0,\"good\":0,\"inaccuracies\":0,\"mistakes\":0,\"blunders\":0},\"entries\":[]}"
    );
}

#[test]
fn cli_review_pgn_rejects_usage_errors_with_usage_text() {
    for args in [
        &["review-pgn"][..],
        &["review-pgn", "--pgn", "1. a3 *"][..],
        &["review-pgn", "--depth", "2"][..],
        &[
            "review-pgn",
            "--pgn",
            "1. a3 *",
            "--pgn",
            "1. h3 *",
            "--depth",
            "2",
        ][..],
        &[
            "review-pgn",
            "--pgn",
            "1. a3 *",
            "--depth",
            "2",
            "--depth",
            "3",
        ][..],
        &["review-pgn", "--pgn-file", "game.pgn", "--depth", "2"][..],
        &["review-pgn", "--pgn", "1. a3 *", "--depth", "2", "extra"][..],
    ] {
        let output = run_chess_cli(args);

        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert_eq!(stdout_text(&output), "", "{args:?}");
        let stderr = stderr_text(&output);
        assert!(stderr.starts_with("error: "), "{args:?}: {stderr}");
        assert!(
            stderr.contains("usage: chess-cli review-pgn --pgn <pgn> --depth <2..6>"),
            "{args:?}: {stderr}"
        );
    }
}

#[test]
fn cli_review_pgn_rejects_depths_before_review() {
    for depth in ["1", "0", "01", "x", "7"] {
        let output = run_chess_cli(&["review-pgn", "--pgn", "1. a3 *", "--depth", depth]);

        assert_eq!(output.status.code(), Some(2), "{depth}");
        assert_eq!(stdout_text(&output), "", "{depth}");
        let stderr = stderr_text(&output);
        assert!(stderr.contains("error: invalid depth"), "{depth}: {stderr}");
        assert!(
            stderr.contains("usage: chess-cli review-pgn --pgn <pgn> --depth <2..6>"),
            "{depth}: {stderr}"
        );
    }
}

#[test]
fn cli_review_pgn_rejects_invalid_pgn_without_partial_json() {
    for pgn in ["", "1. e5 *", "1. e4 {comment} *"] {
        let output = run_chess_cli(&["review-pgn", "--pgn", pgn, "--depth", "2"]);

        assert_eq!(output.status.code(), Some(2), "{pgn:?}");
        assert_eq!(stdout_text(&output), "", "{pgn:?}");
        assert!(
            stderr_text(&output).starts_with("error: invalid PGN: "),
            "{pgn:?}"
        );
    }
}
