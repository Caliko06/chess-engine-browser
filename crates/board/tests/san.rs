use chess_board::{Move, Position, SanError};

fn position(fen: &str) -> Position {
    Position::from_fen(fen).expect("test FEN must parse")
}

fn mv(coordinate: &str) -> Move {
    Move::from_coordinate(coordinate).expect("test move must parse")
}

#[test]
fn san_renders_and_parses_quiet_moves() {
    let position = Position::startpos();

    assert_eq!(position.move_to_san(mv("e2e4")).unwrap(), "e4");
    assert_eq!(position.move_to_san(mv("g1f3")).unwrap(), "Nf3");
    assert_eq!(position.parse_san("e4").unwrap(), mv("e2e4"));
    assert_eq!(position.parse_san("Nf3").unwrap(), mv("g1f3"));
}

#[test]
fn san_renders_and_parses_pawn_capture() {
    let position = position("4k3/8/3p4/4P3/8/8/8/4K3 w - - 0 1");

    assert_eq!(position.move_to_san(mv("e5d6")).unwrap(), "exd6");
    assert_eq!(position.parse_san("exd6").unwrap(), mv("e5d6"));
}

#[test]
fn san_renders_disambiguated_piece_moves() {
    let position = position("4k3/8/8/8/8/8/3N4/4K1N1 w - - 0 1");

    assert_eq!(position.move_to_san(mv("g1f3")).unwrap(), "Ngf3");
    assert_eq!(position.move_to_san(mv("d2f3")).unwrap(), "Ndf3");
    assert_eq!(position.parse_san("Ngf3").unwrap(), mv("g1f3"));
    assert_eq!(
        position.parse_san("Nf3").unwrap_err(),
        SanError::InvalidMove
    );
}

#[test]
fn san_renders_and_parses_castling() {
    let position = position("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");

    assert_eq!(position.move_to_san(mv("e1g1")).unwrap(), "O-O");
    assert_eq!(position.move_to_san(mv("e1c1")).unwrap(), "O-O-O");
    assert_eq!(position.parse_san("O-O").unwrap(), mv("e1g1"));
    assert_eq!(position.parse_san("0-0-0").unwrap(), mv("e1c1"));
}

#[test]
fn san_renders_promotion_and_accepts_omitted_check_marker() {
    let position = position("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");

    assert_eq!(position.move_to_san(mv("a7a8q")).unwrap(), "a8=Q+");
    assert_eq!(position.parse_san("a8=Q").unwrap(), mv("a7a8q"));
}

#[test]
fn san_renders_checkmate() {
    let position = position("7k/8/5KQ1/8/8/8/8/8 w - - 0 1");

    assert_eq!(position.move_to_san(mv("g6g7")).unwrap(), "Qg7#");
    assert_eq!(position.parse_san("Qg7#").unwrap(), mv("g6g7"));
}

#[test]
fn san_rejects_invalid_or_empty_tokens() {
    let position = Position::startpos();

    assert_eq!(position.parse_san("").unwrap_err(), SanError::Empty);
    assert_eq!(
        position.parse_san("Qh5").unwrap_err(),
        SanError::InvalidMove
    );
    assert_eq!(
        position.parse_san("e4?!?!").unwrap_err(),
        SanError::InvalidMove
    );
    assert_eq!(
        position.move_to_san(mv("e2e5")).unwrap_err(),
        SanError::InvalidMove
    );
}
