use chess_board::{Move, MoveError, PromotionPiece, Square};

fn sq(text: &str) -> Square {
    Square::from_algebraic(text).expect("test square must be valid")
}

#[test]
fn quiet_coordinate_move_roundtrips() {
    let parsed = Move::from_coordinate("e2e4").expect("quiet coordinate move must parse");

    assert_eq!(parsed.from(), sq("e2"));
    assert_eq!(parsed.to(), sq("e4"));
    assert_eq!(parsed.promotion(), None);
    assert_eq!(parsed.to_coordinate(), "e2e4");

    let constructed = Move::new(sq("g1"), sq("f3"), None).expect("quiet move must construct");
    assert_eq!(constructed.to_coordinate(), "g1f3");
}

#[test]
fn promotion_coordinate_move_roundtrips() {
    let cases = [
        ("e7e8q", PromotionPiece::Queen),
        ("e7e8r", PromotionPiece::Rook),
        ("e7e8b", PromotionPiece::Bishop),
        ("e7e8n", PromotionPiece::Knight),
        ("e2e1q", PromotionPiece::Queen),
    ];

    for (coordinate, promotion) in cases {
        let parsed = Move::from_coordinate(coordinate).expect("promotion move must parse");

        assert_eq!(parsed.from().to_algebraic(), &coordinate[0..2]);
        assert_eq!(parsed.to().to_algebraic(), &coordinate[2..4]);
        assert_eq!(parsed.promotion(), Some(promotion));
        assert_eq!(parsed.to_coordinate(), coordinate);
    }

    let constructed = Move::new(sq("a7"), sq("a8"), Some(PromotionPiece::Knight))
        .expect("promotion move must construct");
    assert_eq!(constructed.to_coordinate(), "a7a8n");
}

#[test]
fn coordinate_move_rejects_from_equals_to() {
    assert_eq!(
        Move::from_coordinate("e2e2").unwrap_err(),
        MoveError::SameSquare
    );
    assert_eq!(
        Move::new(sq("h8"), sq("h8"), None).unwrap_err(),
        MoveError::SameSquare
    );
}

#[test]
fn coordinate_move_rejects_bad_length_or_chars() {
    let cases = [
        "", "e2e", "e2e4qq", "i2e4", "e9e4", "e2i4", "e2e9", "E2e4", "e2E4", "e2 e4", "e7e8x",
        "e7e8Q",
    ];

    for coordinate in cases {
        assert_eq!(
            Move::from_coordinate(coordinate).unwrap_err(),
            MoveError::InvalidCoordinate,
            "{coordinate}"
        );
    }
}

#[test]
fn coordinate_move_rejects_promotion_to_king_or_pawn() {
    let cases = ["e7e8k", "e7e8p"];

    for coordinate in cases {
        assert_eq!(
            Move::from_coordinate(coordinate).unwrap_err(),
            MoveError::InvalidPromotion,
            "{coordinate}"
        );
    }
}

#[test]
fn coordinate_move_rejects_promotion_suffix_outside_last_rank() {
    let cases = ["e2e4q", "g1f3n", "e7e6q", "a2a3r"];

    for coordinate in cases {
        assert_eq!(
            Move::from_coordinate(coordinate).unwrap_err(),
            MoveError::InvalidPromotion,
            "{coordinate}"
        );
    }

    assert_eq!(
        Move::new(sq("e2"), sq("e4"), Some(PromotionPiece::Queen)).unwrap_err(),
        MoveError::InvalidPromotion
    );
}
