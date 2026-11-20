use std::process::{Command, Output};

const STARTPOS: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

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
fn cli_analyze_fen_outputs_stable_json() {
    let output = run_chess_cli(&["analyze-fen", "--fen", STARTPOS, "--depth", "1"]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stderr_text(&output), "");
    assert_eq!(
        stdout_text(&output),
        format!(
            "{{\"command\":\"analyze-fen\",\"search\":\"engine\",\"fen\":\"{STARTPOS}\",\"depth\":1,\"status\":\"ongoing\",\"best_move\":\"g1f3\",\"score_cp\":7,\"nodes\":23,\"pv\":[\"g1f3\"]}}"
        )
    );
}

#[test]
fn cli_analyze_fen_rejects_bad_inputs() {
    for args in [
        ["analyze-fen", "--fen", STARTPOS, "--depth", "0"],
        ["analyze-fen", "--fen", STARTPOS, "--depth", "33"],
        ["analyze-fen", "--fen", "not-a-fen", "--depth", "1"],
    ] {
        let output = run_chess_cli(&args);

        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert_eq!(stdout_text(&output), "", "{args:?}");
        assert!(stderr_text(&output).starts_with("error: "), "{args:?}");
    }
}

#[test]
fn cli_bench_outputs_local_schema() {
    let output = run_chess_cli(&["bench", "--depth", "1"]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stderr_text(&output), "");
    let stdout = stdout_text(&output);
    assert!(stdout.starts_with(
        "{\"command\":\"bench\",\"search\":\"engine\",\"position_set\":[\"startpos\",\"kiwipete\",\"recapture_trap\",\"stalemate_trap\",\"back_rank_mate\"],\"depth\":1,\"total_nodes\":262,\"elapsed_ms\":"
    ));
    assert!(stdout.contains(",\"nodes_per_second\":"));
    assert!(stdout.ends_with('}'));
    assert!(!stdout.contains('\n'));
}

#[test]
fn cli_bench_rejects_bad_depth() {
    let output = run_chess_cli(&["bench", "--depth", "0"]);

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(stdout_text(&output), "");
    let stderr = stderr_text(&output);
    assert!(stderr.contains("error: invalid depth"));
    assert!(stderr.contains("usage: chess-cli bench --depth <1..32>"));
}
