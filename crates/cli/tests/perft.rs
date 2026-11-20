use std::process::{Command, Output};

const STARTPOS: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const USAGE: &str = "usage: chess-cli perft --fen <fen> --depth <n>";

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
fn cli_perft_requires_fen_and_depth() {
    let output = run_chess_cli(&["perft"]);

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(stdout_text(&output), "");
    let stderr = stderr_text(&output);
    assert!(stderr.contains("error: missing required --fen"));
    assert!(stderr.contains(USAGE));
}

#[test]
fn cli_perft_depth_zero_returns_one() {
    let output = run_chess_cli(&["perft", "--fen", STARTPOS, "--depth", "0"]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        stdout_text(&output),
        format!(
            "{{\"command\":\"perft\",\"fen\":\"{}\",\"depth\":0,\"nodes\":1}}",
            STARTPOS
        )
    );
    assert_eq!(stderr_text(&output), "");
}

#[test]
fn cli_perft_depth_above_zero_returns_owned_nodes() {
    let output = run_chess_cli(&["perft", "--fen", STARTPOS, "--depth", "1"]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        stdout_text(&output),
        format!(
            "{{\"command\":\"perft\",\"fen\":\"{}\",\"depth\":1,\"nodes\":20}}",
            STARTPOS
        )
    );
    assert_eq!(stderr_text(&output), "");
}

#[test]
fn cli_perft_rejects_invalid_fen() {
    let output = run_chess_cli(&["perft", "--fen", "not-a-fen", "--depth", "0"]);

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(stdout_text(&output), "");
    let stderr = stderr_text(&output);
    assert!(stderr.starts_with("error: invalid FEN: "));
    assert!(stderr.contains("FEN must contain exactly six fields"));
}

#[test]
fn cli_perft_rejects_negative_non_numeric_or_too_large_depth() {
    for depth in ["-1", "abc", "07", "7"] {
        let output = run_chess_cli(&["perft", "--fen", STARTPOS, "--depth", depth]);

        assert_eq!(output.status.code(), Some(2), "depth {depth}");
        assert_eq!(stdout_text(&output), "", "depth {depth}");
        let stderr = stderr_text(&output);
        assert!(
            stderr.contains("error: invalid depth"),
            "depth {depth}: {stderr}"
        );
        assert!(stderr.contains(USAGE), "depth {depth}: {stderr}");
    }
}

#[test]
fn cli_perft_output_is_machine_parseable() {
    let output = run_chess_cli(&["perft", "--depth", "0", "--fen", STARTPOS]);

    assert_eq!(output.status.code(), Some(0));
    let stdout = stdout_text(&output);
    assert_eq!(
        stdout,
        format!(
            "{{\"command\":\"perft\",\"fen\":\"{}\",\"depth\":0,\"nodes\":1}}",
            STARTPOS
        )
    );
    assert!(stdout.is_ascii());
    assert!(!stdout.contains('\n'));
}

#[test]
fn cli_perft_divide_depth_two_reports_root_nodes() {
    let output = run_chess_cli(&["perft", "--fen", STARTPOS, "--depth", "2", "--divide"]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stderr_text(&output), "");
    assert_eq!(
        stdout_text(&output),
        format!(
            "{{\"command\":\"perft\",\"fen\":\"{}\",\"depth\":2,\"nodes\":400,\"divide\":[{{\"move\":\"a2a3\",\"nodes\":20}},{{\"move\":\"a2a4\",\"nodes\":20}},{{\"move\":\"b1a3\",\"nodes\":20}},{{\"move\":\"b1c3\",\"nodes\":20}},{{\"move\":\"b2b3\",\"nodes\":20}},{{\"move\":\"b2b4\",\"nodes\":20}},{{\"move\":\"c2c3\",\"nodes\":20}},{{\"move\":\"c2c4\",\"nodes\":20}},{{\"move\":\"d2d3\",\"nodes\":20}},{{\"move\":\"d2d4\",\"nodes\":20}},{{\"move\":\"e2e3\",\"nodes\":20}},{{\"move\":\"e2e4\",\"nodes\":20}},{{\"move\":\"f2f3\",\"nodes\":20}},{{\"move\":\"f2f4\",\"nodes\":20}},{{\"move\":\"g1f3\",\"nodes\":20}},{{\"move\":\"g1h3\",\"nodes\":20}},{{\"move\":\"g2g3\",\"nodes\":20}},{{\"move\":\"g2g4\",\"nodes\":20}},{{\"move\":\"h2h3\",\"nodes\":20}},{{\"move\":\"h2h4\",\"nodes\":20}}]}}",
            STARTPOS
        )
    );
}

#[test]
fn cli_perft_errors_are_stderr_and_nonzero() {
    let output = run_chess_cli(&["perft", "--fen", STARTPOS]);

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(stdout_text(&output), "");
    assert!(stderr_text(&output).starts_with("error: "));
}
