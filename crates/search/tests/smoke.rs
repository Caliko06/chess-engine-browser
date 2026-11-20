#[test]
fn crate_smoke_test_runs() {
    let package_name = env!("CARGO_PKG_NAME");
    assert_eq!(package_name, "chess-search");
}
