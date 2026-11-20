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
            "{{\"command\":\"analyze-fen\",\"fen\":\"{STARTPOS}\",\"depth\":1,\"status\":\"ongoing\",\"best_move\":\"b1c3\",\"score_cp\":24,\"nodes\":20,\"tt_hits\":0}}"
        )
    );
}

#[test]
fn cli_analyze_fen_rejects_bad_inputs() {
    for args in [
        ["analyze-fen", "--fen", STARTPOS, "--depth", "0"],
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
    // Node count at depth 1 was repinned 2026-07-05 (1074 -> 21528): ADR-0195 quiescence capture
    // resolution (MAX_QUIESCENCE_PLY 3 -> 16 with q-node guard and delta pruning) legitimately
    // expands quiescence subtrees even at this shallow depth. Repin authorized by the user in
    // session (fence widening recorded in the product-delivery run log); verified deterministic
    // via `chess-cli bench --depth 1` before repinning.
    assert!(stdout.starts_with(
        "{\"command\":\"bench\",\"position_set\":[\"startpos\",\"kiwipete\",\"recapture_trap\"],\"depth\":1,\"total_nodes\":21528,\"elapsed_ms\":"
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
    assert!(stderr.contains("usage: chess-cli bench --depth <1..6>"));
}
