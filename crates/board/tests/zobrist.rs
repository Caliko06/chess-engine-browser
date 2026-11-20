use chess_board::{Move, Position};

fn position(fen: &str) -> Position {
    Position::from_fen(fen).expect("test FEN must parse")
}

#[test]
fn zobrist_hash_ignores_clocks_for_repetition_identity() {
    let early = position("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    let later = position("4k3/8/8/8/8/8/8/4K3 w - - 42 99");

    assert_eq!(early.zobrist_hash(), later.zobrist_hash());
}

#[test]
fn zobrist_hash_tracks_side_castling_en_passant_and_piece_square_features() {
    let root = Position::startpos();

    assert_ne!(
        root.zobrist_hash(),
        position("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1").zobrist_hash()
    );
    assert_ne!(
        root.zobrist_hash(),
        position("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQk - 0 1").zobrist_hash()
    );
    assert_ne!(
        position("4k3/8/8/8/4pP2/8/8/4K3 b - - 0 1").zobrist_hash(),
        position("4k3/8/8/8/4pP2/8/8/4K3 b - f3 0 1").zobrist_hash()
    );
    assert_ne!(
        position("4k3/8/8/8/8/8/8/4KQ2 w - - 0 1").zobrist_hash(),
        position("4k3/8/8/8/8/8/8/4K1Q1 w - - 0 1").zobrist_hash()
    );
    assert_ne!(
        position("4k3/8/8/8/8/8/8/4KQ2 w - - 0 1").zobrist_hash(),
        position("4k3/8/8/8/8/8/8/4KR2 w - - 0 1").zobrist_hash()
    );
    assert_ne!(
        position("4k3/8/8/8/8/8/8/4KQ2 w - - 0 1").zobrist_hash(),
        position("4k3/8/8/8/8/8/8/4Kq2 w - - 0 1").zobrist_hash()
    );
}

#[test]
fn child_zobrist_hash_matches_reparsed_child_fen() {
    let root = Position::startpos();
    let child = root
        .after_legal_move(Move::from_coordinate("e2e4").expect("move must parse"))
        .expect("move must be legal");
    let reparsed = position(&child.to_fen());

    assert_eq!(child.zobrist_hash(), reparsed.zobrist_hash());
}
