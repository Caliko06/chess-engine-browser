//! Adjustable playing strength for human opponents.
//!
//! Levels below [`MAX_LEVEL`] score every root move with a shallow search and pick one by a
//! softmax over those scores: a lower level searches less deeply and samples more widely, so it
//! misses tactics and sometimes prefers a worse move, the way a weaker player does. [`MAX_LEVEL`]
//! is the full engine.

use chess_board::Position;

use crate::engine::{Engine, EngineLimits, EngineResult};

/// The full-strength level.
pub const MAX_LEVEL: u8 = 6;

/// Scores above this are clamped before sampling so a forced mate still dominates the choice.
const SCORE_CLAMP: i32 = 2_000;

/// (child search depth, softmax temperature in centipawns) for levels 1 to `MAX_LEVEL - 1`.
const LEVELS: [(u8, f64); (MAX_LEVEL - 1) as usize] =
    [(1, 220.0), (1, 110.0), (2, 60.0), (3, 30.0), (5, 12.0)];

/// Picks a move at `level` (clamped to 1..=`MAX_LEVEL`). `seed` drives the sampling; the same
/// seed, position and history give the same move. `nodes` caps the full-strength search only.
pub fn think_at_level(
    engine: &mut Engine,
    position: &Position,
    history_hashes: &[u64],
    level: u8,
    nodes: Option<u64>,
    seed: u64,
) -> EngineResult {
    let level = level.clamp(1, MAX_LEVEL);
    if level == MAX_LEVEL {
        let limits = EngineLimits {
            max_depth: None,
            nodes,
            stop: None,
        };
        return engine.think(position, history_hashes, limits, &mut |_| true);
    }
    let (depth, temperature) = LEVELS[usize::from(level - 1)];
    let moves = position.legal_moves_trusted();
    if moves.is_empty() {
        let limits = EngineLimits {
            max_depth: Some(1),
            nodes: None,
            stop: None,
        };
        return engine.think(position, history_hashes, limits, &mut |_| true);
    }
    let mut child_history = history_hashes.to_vec();
    child_history.push(position.zobrist_hash());
    let mut total_nodes = 0_u64;
    let mut scored = Vec::with_capacity(moves.len());
    for mv in moves {
        let Ok(child) = position.after_known_legal_move(mv) else {
            continue;
        };
        let limits = EngineLimits {
            max_depth: Some(depth),
            nodes: None,
            stop: None,
        };
        let reply = engine.think(&child, &child_history, limits, &mut |_| true);
        total_nodes += reply.nodes;
        scored.push((mv, -reply.score_cp));
    }
    let best = scored.iter().map(|(_, score)| *score).max().unwrap_or(0);
    let best_clamped = best.clamp(-SCORE_CLAMP, SCORE_CLAMP);
    let weights: Vec<f64> = scored
        .iter()
        .map(|(_, score)| {
            let loss = f64::from(best_clamped - (*score).clamp(-SCORE_CLAMP, SCORE_CLAMP));
            (-loss / temperature).exp()
        })
        .collect();
    let total: f64 = weights.iter().sum();
    let mut pick = unit_interval(seed) * total;
    let mut chosen = scored[0];
    for (entry, weight) in scored.iter().zip(&weights) {
        chosen = *entry;
        if pick < *weight {
            break;
        }
        pick -= weight;
    }
    EngineResult {
        best_move: Some(chosen.0),
        score_cp: chosen.1,
        depth: depth + 1,
        nodes: total_nodes,
        pv: vec![chosen.0],
    }
}

/// splitmix64 mapped to [0, 1).
fn unit_interval(seed: u64) -> f64 {
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    (z >> 11) as f64 / (1_u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_level_returns_a_legal_move_and_full_level_takes_free_queen() {
        // White to move, black queen en prise on d5 to the e4 pawn.
        let position =
            Position::from_fen("rnb1kbnr/ppp1pppp/8/3q4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3")
                .unwrap();
        let mut engine = Engine::new(4);
        for level in 1..=MAX_LEVEL {
            for seed in 0..4 {
                let result = think_at_level(&mut engine, &position, &[], level, Some(20_000), seed);
                let mv = result.best_move.expect("a move");
                assert!(position.legal_moves_trusted().contains(&mv));
            }
        }
        let full = think_at_level(&mut engine, &position, &[], MAX_LEVEL, Some(50_000), 0);
        assert_eq!(full.best_move.unwrap().to_coordinate(), "e4d5");
    }

    #[test]
    fn weak_level_is_seeded_and_varies() {
        let position = Position::startpos();
        let mut engine = Engine::new(4);
        let a = think_at_level(&mut engine, &position, &[], 1, None, 7).best_move;
        let b = think_at_level(&mut engine, &position, &[], 1, None, 7).best_move;
        assert_eq!(a, b);
        let distinct: std::collections::HashSet<_> = (0..40)
            .map(|seed| {
                think_at_level(&mut engine, &position, &[], 1, None, seed)
                    .best_move
                    .map(|mv| mv.to_coordinate())
            })
            .collect();
        assert!(distinct.len() > 3);
    }
}
