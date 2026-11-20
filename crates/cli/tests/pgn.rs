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
fn cli_pgn_roundtrip_requires_pgn_text() {
    let output = run_chess_cli(&["pgn-roundtrip"]);

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(stdout_text(&output), "");
    let stderr = stderr_text(&output);
    assert!(stderr.contains("error: missing required --pgn"));
    assert!(stderr.contains("usage: chess-cli pgn-roundtrip --pgn <pgn>"));
}

#[test]
fn cli_pgn_roundtrip_prints_canonical_pgn() {
    let pgn = "[Event \"Local\"]\n[Result \"1-0\"]\n\n1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6 4.Qxf7# 1-0";
    let output = run_chess_cli(&["pgn-roundtrip", "--pgn", pgn]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stderr_text(&output), "");
    assert_eq!(
        stdout_text(&output),
        "[Event \"Local\"]\n[Result \"1-0\"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0"
    );
}

#[test]
fn cli_pgn_roundtrip_rejects_unsupported_or_illegal_pgn() {
    let output = run_chess_cli(&["pgn-roundtrip", "--pgn", "1. e5 *"]);

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(stdout_text(&output), "");
    assert!(stderr_text(&output).starts_with("error: invalid PGN: "));
}
