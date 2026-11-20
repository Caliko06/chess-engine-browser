use chess_board::Position;
use chess_search::{SearchConfig, search};
use std::time::Instant;

const DEPTH: u8 = 3;
const POSITIONS: [(&str, &str); 5] = [
    (
        "startpos",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    ),
    (
        "kiwipete",
        "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    ),
    ("recapture_trap", "kq6/8/8/8/8/8/8/1R2K3 w - - 0 1"),
    ("stalemate_trap", "k7/8/1Q6/8/8/8/8/7K w - - 0 1"),
    ("back_rank_mate", "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1"),
];

fn main() {
    let started = Instant::now();
    let mut total_nodes = 0_u64;

    for (name, fen) in POSITIONS {
        let position = match Position::from_fen(fen) {
            Ok(position) => position,
            Err(error) => {
                eprintln!("bench FEN failed to parse: {error}");
                std::process::exit(1);
            }
        };
        let result = match search(&position, SearchConfig { max_depth: DEPTH }) {
            Ok(result) => result,
            Err(error) => {
                eprintln!("bench search failed: {error}");
                std::process::exit(1);
            }
        };
        total_nodes = total_nodes.saturating_add(result.nodes);

        let best_move = result
            .best_move
            .map_or_else(String::new, |best_move| best_move.to_coordinate());
        println!(
            "{{\"name\":\"{name}\",\"best_move\":\"{best_move}\",\"score\":{},\"depth\":{},\"nodes\":{}}}",
            result.score, result.depth, result.nodes
        );
    }

    let elapsed_ms = u64::try_from(started.elapsed().as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    let nodes_per_second = total_nodes.saturating_mul(1_000) / elapsed_ms;

    println!(
        "{{\"command\":\"cargo run --release --quiet -p chess-search --example m8_bench\",\"position_set\":[\"startpos\",\"kiwipete\",\"recapture_trap\",\"stalemate_trap\",\"back_rank_mate\"],\"depth\":{DEPTH},\"total_nodes\":{total_nodes},\"elapsed_ms\":{elapsed_ms},\"nodes_per_second\":{nodes_per_second}}}"
    );
}
