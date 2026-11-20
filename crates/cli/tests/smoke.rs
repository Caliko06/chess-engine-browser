use std::process::Command;

#[test]
fn help_placeholder_runs() {
    let output = Command::new(env!("CARGO_BIN_EXE_chess-cli"))
        .arg("--help")
        .output()
        .expect("failed to run chess-cli --help");

    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("help output should be utf-8");
    assert!(stdout.contains("analyze-fen"));
    assert!(stdout.contains("bench"));
    assert!(stdout.contains("selfplay"));
    assert!(stdout.contains("Unavailable"));
}

#[test]
fn oracle_is_not_a_production_cli_command() {
    let output = Command::new(env!("CARGO_BIN_EXE_chess-cli"))
        .arg("oracle")
        .output()
        .expect("failed to run chess-cli oracle");

    assert!(!output.status.success());

    let stderr = String::from_utf8(output.stderr).expect("oracle error output should be utf-8");
    assert!(stderr.contains("tests/oracle"));
}

#[test]
fn selfplay_fails_closed_until_search_has_node_limits() {
    let output = Command::new(env!("CARGO_BIN_EXE_chess-cli"))
        .arg("selfplay")
        .output()
        .expect("failed to run chess-cli selfplay");

    assert!(!output.status.success());

    let stderr = String::from_utf8(output.stderr).expect("selfplay error output should be utf-8");
    assert!(stderr.contains("node-limit"));
}
