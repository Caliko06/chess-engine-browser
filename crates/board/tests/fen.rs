use chess_board::{
    CastlingRights, Color, FenError, Piece, PieceKind, Position, Square, SquareError,
};

const STARTPOS: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KIWIPETE: &str = "r3k2r/p1ppqpb1/bn2pnp1/2P5/1p2P3/2N2N2/PP1PBPPP/R2QKB1R w KQkq - 0 1";

fn sq(text: &str) -> Square {
    Square::from_algebraic(text).expect("test square must be valid")
}

#[test]
fn startpos_fen_roundtrips_canonical_text() {
    let position = Position::from_fen(STARTPOS).expect("startpos must parse");

    assert_eq!(position.to_fen(), STARTPOS);
    assert_eq!(Position::startpos().to_fen(), STARTPOS);
}

#[test]
fn kiwipete_fen_roundtrips_canonical_text() {
    let position = Position::from_fen(KIWIPETE).expect("Kiwipete must parse");

    assert_eq!(position.to_fen(), KIWIPETE);
}

#[test]
fn startpos_piece_placement_is_queryable() {
    let position = Position::startpos();

    assert_eq!(position.side_to_move(), Color::White);
    assert_eq!(
        position.piece_at(sq("e1")),
        Some(Piece::new(Color::White, PieceKind::King))
    );
    assert_eq!(
        position.piece_at(sq("d8")),
        Some(Piece::new(Color::Black, PieceKind::Queen))
    );
    assert_eq!(
        position.piece_at(sq("a2")),
        Some(Piece::new(Color::White, PieceKind::Pawn))
    );
    assert_eq!(position.piece_at(sq("e4")), None);
}

#[test]
fn kiwipete_side_castling_ep_and_counters_are_queryable() {
    let position = Position::from_fen(KIWIPETE).expect("Kiwipete must parse");

    assert_eq!(position.side_to_move(), Color::White);
    assert_eq!(position.castling_rights(), CastlingRights::all());
    assert_eq!(position.en_passant_target(), None);
    assert_eq!(position.halfmove_clock(), 0);
    assert_eq!(position.fullmove_number(), 1);
    assert_eq!(
        position.piece_at(sq("g7")),
        Some(Piece::new(Color::Black, PieceKind::Bishop))
    );
    assert_eq!(
        position.piece_at(sq("c3")),
        Some(Piece::new(Color::White, PieceKind::Knight))
    );
}

#[test]
fn fen_nondefault_metadata_is_queryable_and_roundtrips() {
    let fen = "4k3/8/8/3pP3/8/8/8/4K3 w - d6 17 42";
    let position = Position::from_fen(fen).expect("non-default metadata FEN must parse");

    assert_eq!(position.side_to_move(), Color::White);
    assert_eq!(position.castling_rights(), CastlingRights::none());
    assert_eq!(position.en_passant_target(), Some(sq("d6")));
    assert_eq!(position.halfmove_clock(), 17);
    assert_eq!(position.fullmove_number(), 42);
    assert_eq!(position.to_fen(), fen);
}

#[test]
fn fen_castling_subsets_are_canonicalized() {
    let noncanonical = "4k3/8/8/8/8/8/8/4K3 w qK - 3 9";
    let position = Position::from_fen(noncanonical).expect("castling subset FEN must parse");

    assert!(position.castling_rights().white_kingside());
    assert!(!position.castling_rights().white_queenside());
    assert!(!position.castling_rights().black_kingside());
    assert!(position.castling_rights().black_queenside());
    assert_eq!(position.to_fen(), "4k3/8/8/8/8/8/8/4K3 w Kq - 3 9");
}

#[test]
fn invalid_fen_returns_typed_error_for_each_field() {
    let cases = [
        ("4k3/8/8/8/8/8/8/4K3 w - - 0", FenError::FieldCount),
        ("4k3/8/8/8/8/8/4K3 w - - 0 1", FenError::BoardRankCount),
        ("4k3/8/8/8/8/8/8/4K2 w - - 0 1", FenError::BoardFileCount),
        ("4k3/8/8/8/8/8/8/3XK3 w - - 0 1", FenError::InvalidPiece),
        ("4k3/8/8/8/8/8/8/4K3 x - - 0 1", FenError::InvalidSideToMove),
        ("4k3/8/8/8/8/8/8/4K3 w KA - 0 1", FenError::InvalidCastling),
        ("4k3/8/8/8/8/8/8/4K3 w KK - 0 1", FenError::InvalidCastling),
        ("4k3/8/8/8/8/8/8/4K3 w - e4 0 1", FenError::InvalidEnPassant),
        ("4k3/8/8/8/8/8/8/4K3 b - e6 0 1", FenError::InvalidEnPassant),
        ("4k3/8/8/8/8/8/8/4K3 w - e3 0 1", FenError::InvalidEnPassant),
        (
            "4k3/11111111/8/8/8/8/8/4K3 w - - 0 1",
            FenError::BoardFileCount,
        ),
        (
            "4k3/8/8/8/8/8/8/4K3 w - - +0 1",
            FenError::InvalidHalfmoveClock,
        ),
        (
            "4k3/8/8/8/8/8/8/4K3 w - - 0 +1",
            FenError::InvalidFullmoveNumber,
        ),
        (" 4k3/8/8/8/8/8/8/4K3 w - - 0 1", FenError::FieldCount),
        ("4k3/8/8/8/8/8/8/4K3  w - - 0 1", FenError::FieldCount),
        ("4k3/8/8/8/8/8/8/4K3\nw - - 0 1", FenError::FieldCount),
        (
            "4k3/8/8/8/8/8/8/4K3 w - - -1 1",
            FenError::InvalidHalfmoveClock,
        ),
        (
            "4k3/8/8/8/8/8/8/4K3 w - - 01 1",
            FenError::InvalidHalfmoveClock,
        ),
        (
            "4k3/8/8/8/8/8/8/4K3 w - - 0 0",
            FenError::InvalidFullmoveNumber,
        ),
        (
            "4k3/8/8/8/8/8/8/4K3 w - - 0 01",
            FenError::InvalidFullmoveNumber,
        ),
    ];

    for (fen, expected_error) in cases {
        assert_eq!(
            Position::from_fen(fen).unwrap_err(),
            expected_error,
            "{fen}"
        );
    }
}

#[test]
fn fen_rejects_missing_or_duplicate_kings() {
    let cases = [
        (
            "4k3/8/8/8/8/8/8/8 w - - 0 1",
            FenError::MissingKing(Color::White),
        ),
        (
            "8/8/8/8/8/8/8/4K3 w - - 0 1",
            FenError::MissingKing(Color::Black),
        ),
        (
            "4k3/8/8/8/8/8/4K3/4K3 w - - 0 1",
            FenError::DuplicateKing(Color::White),
        ),
        (
            "4k3/4k3/8/8/8/8/8/4K3 w - - 0 1",
            FenError::DuplicateKing(Color::Black),
        ),
    ];

    for (fen, expected_error) in cases {
        assert_eq!(
            Position::from_fen(fen).unwrap_err(),
            expected_error,
            "{fen}"
        );
    }
}

#[test]
fn fen_rejects_pawns_on_back_rank() {
    let cases = [
        "4k3/8/8/8/8/8/8/P3K3 w - - 0 1",
        "p3k3/8/8/8/8/8/8/4K3 w - - 0 1",
    ];

    for fen in cases {
        assert_eq!(
            Position::from_fen(fen).unwrap_err(),
            FenError::PawnOnBackRank,
            "{fen}"
        );
    }
}

#[test]
fn fen_rejects_adjacent_kings() {
    let fen = "8/8/8/8/8/8/4k3/4K3 w - - 0 1";

    assert_eq!(
        Position::from_fen(fen).unwrap_err(),
        FenError::AdjacentKings
    );
}

#[test]
fn square_parsing_rejects_out_of_range_values() {
    assert_eq!(
        Square::from_algebraic("a").unwrap_err(),
        SquareError::InvalidLength
    );
    assert_eq!(
        Square::from_algebraic("i1").unwrap_err(),
        SquareError::InvalidFile
    );
    assert_eq!(
        Square::from_algebraic("a9").unwrap_err(),
        SquareError::InvalidRank
    );
}

#[test]
fn fen_roundtrip_is_not_raw_input_echo() {
    let noncanonical = "r3k2r/p1ppqpb1/bn2pnp1/2P5/1p2P3/2N2N2/PP1PBPPP/R2QKB1R w qkQK - 0 1";
    let position =
        Position::from_fen(noncanonical).expect("noncanonical castling order must parse");

    assert_ne!(position.to_fen(), noncanonical);
    assert_eq!(position.to_fen(), KIWIPETE);
}
