use chess_board::{Move, PromotionPiece, Square};

/// Every move constructible through the public API: all from/to square pairs, with every
/// promotion piece wherever `Move::new` accepts one.
fn all_constructible_moves() -> Vec<Move> {
    let squares: Vec<Square> = ('a'..='h')
        .flat_map(|file| ('1'..='8').map(move |rank| format!("{file}{rank}")))
        .map(|text| Square::from_algebraic(&text).expect("square must parse"))
        .collect();

    let mut moves = Vec::new();
    for &from in &squares {
        for &to in &squares {
            if let Ok(mv) = Move::new(from, to, None) {
                moves.push(mv);
            }
            for promotion in [
                PromotionPiece::Queen,
                PromotionPiece::Rook,
                PromotionPiece::Bishop,
                PromotionPiece::Knight,
            ] {
                if let Ok(mv) = Move::new(from, to, Some(promotion)) {
                    moves.push(mv);
                }
            }
        }
    }
    moves
}

#[test]
fn move_ord_matches_coordinate_string_order_exhaustively() {
    let mut by_ord = all_constructible_moves();
    let mut by_coordinate = by_ord.clone();
    assert!(by_ord.len() > 4_000, "the move universe must be exhaustive");

    by_ord.sort_unstable();
    by_coordinate.sort_by_key(Move::to_coordinate);

    assert_eq!(by_ord, by_coordinate);
}

#[test]
fn move_ord_sorted_coordinates_are_strictly_increasing() {
    let mut moves = all_constructible_moves();
    moves.sort_unstable();

    for pair in moves.windows(2) {
        assert!(
            pair[0].to_coordinate() < pair[1].to_coordinate(),
            "{} must order strictly before {}",
            pair[0].to_coordinate(),
            pair[1].to_coordinate()
        );
    }
}
