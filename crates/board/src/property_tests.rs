use super::*;

const MAX_PLIES: usize = 96;
const STARTPOS: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KIWIPETE: &str = "r3k2r/p1ppqpb1/bn2pnp1/2P5/1p2P3/2N2N2/PP1PBPPP/R2QKB1R w KQkq - 0 1";
const CASTLING: &str = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 4 11";
const PROMOTION: &str = "k7/4P3/8/8/8/8/8/4K3 w - - 5 1";
const EN_PASSANT: &str = "4k3/8/8/K2pP3/8/8/8/8 w - d6 9 2";
const IN_CHECK: &str = "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1";
const CAPTURE: &str = "r3k2r/8/8/3r4/8/8/6B1/R3K2R w KQkq - 9 20";
const TERMINALS: [&str; 2] = [
    "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1",
    "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
];
const SEEDS: [u64; 4] = [
    0x0182_0000_0000_0001,
    0x0182_0000_0000_0029,
    0x0182_5eed_cafe_babe,
    0xd1ce_ba5e_0182_0096,
];
const SPECIAL_SEEDS: [u64; 5] = [10, 1, 2, 3, 14];

#[derive(Debug, Eq, PartialEq)]
struct Trace {
    moves: Vec<Move>,
    fens: Vec<String>,
    hashes: Vec<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Failure(usize, &'static str);

fn next_random(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

fn ctx(fen: &str, seed: u64, ply: usize, moves: &[Move]) -> String {
    let moves = moves
        .iter()
        .map(Move::to_coordinate)
        .collect::<Vec<_>>()
        .join(" ");
    format!("start_fen={fen}; seed={seed:#018x}; failing_ply={ply}; moves={moves}")
}

const fn bad(ply: usize, reason: &'static str) -> Failure {
    Failure(ply, reason)
}

fn validate(fen: &str, moves: &[Move]) -> Result<Trace, Failure> {
    let root = Position::from_fen(fen).map_err(|_| bad(0, "start FEN parse"))?;
    if root.to_fen() != fen {
        return Err(bad(0, "noncanonical start FEN"));
    }
    let mut position = root.clone();
    let mut rollback = root.clone();
    let mut undos = Vec::with_capacity(moves.len());
    let mut fens = vec![root.to_fen()];
    let mut hashes = vec![root.zobrist_hash()];

    for (ply, selected) in moves.iter().enumerate() {
        let source = position.clone();
        let legal = position
            .legal_moves()
            .map_err(|_| bad(ply, "replay legal generation"))?;
        if !legal.contains(selected) {
            return Err(bad(ply, "selected move not legal"));
        }
        let child = position
            .after_legal_move(*selected)
            .map_err(|_| bad(ply, "legal child creation"))?;
        if position != source {
            return Err(bad(ply, "source mutated"));
        }

        let child_fen = child.to_fen();
        let round_trip = Position::from_fen(&child_fen).map_err(|_| bad(ply, "child FEN parse"))?;
        if round_trip.to_fen() != child_fen || round_trip.zobrist_hash() != child.zobrist_hash() {
            return Err(bad(ply, "child FEN/hash round-trip"));
        }

        let mut reversible = source.clone();
        let undo = make_reversible_move(&mut reversible, *selected)
            .ok_or_else(|| bad(ply, "private make"))?;
        if reversible != child {
            return Err(bad(ply, "private/public child mismatch"));
        }
        unmake_reversible_move(&mut reversible, undo);
        if reversible != source || reversible.zobrist_hash() != source.zobrist_hash() {
            return Err(bad(ply, "private unmake FEN/hash"));
        }
        undos.push(
            make_reversible_move(&mut rollback, *selected)
                .ok_or_else(|| bad(ply, "rollback make"))?,
        );

        position = child;
        fens.push(child_fen);
        hashes.push(position.zobrist_hash());
    }

    let legal = position
        .legal_moves()
        .map_err(|_| bad(moves.len(), "final legal generation"))?;
    if legal.is_empty()
        && position
            .status()
            .map_err(|_| bad(moves.len(), "terminal classification"))?
            == PositionStatus::Ongoing
    {
        return Err(bad(moves.len(), "zero moves but ongoing"));
    }
    while let Some(undo) = undos.pop() {
        unmake_reversible_move(&mut rollback, undo);
    }
    if rollback != root || rollback.zobrist_hash() != root.zobrist_hash() {
        return Err(bad(moves.len(), "full rollback FEN/hash"));
    }

    Ok(Trace {
        moves: moves.to_vec(),
        fens,
        hashes,
    })
}

fn shrink(fen: &str, moves: &[Move]) -> Option<(Vec<Move>, Failure)> {
    (0..=moves.len()).find_map(|length| {
        validate(fen, &moves[..length])
            .err()
            .map(|error| (moves[..length].to_vec(), error))
    })
}

fn die(fen: &str, seed: u64, moves: &[Move], fallback: Failure) -> ! {
    let (prefix, error) = shrink(fen, moves).unwrap_or_else(|| (moves.to_vec(), fallback));
    panic!("{}; reason={}", ctx(fen, seed, error.0, &prefix), error.1);
}

fn first_diff<T: PartialEq>(left: &[T], right: &[T]) -> usize {
    left.iter()
        .zip(right)
        .position(|(a, b)| a != b)
        .unwrap_or_else(|| left.len().min(right.len()))
}

fn die_trace(fen: &str, seed: u64, left: &Trace, right: &Trace, reason: &str) -> ! {
    let ply = first_diff(&left.moves, &right.moves)
        .min(first_diff(&left.fens, &right.fens).saturating_sub(1))
        .min(first_diff(&left.hashes, &right.hashes).saturating_sub(1));
    let end = (ply + 1).min(left.moves.len());
    panic!(
        "{}; reason={reason}",
        ctx(fen, seed, ply, &left.moves[..end])
    );
}

fn generate(fen: &str, seed: u64, limit: usize) -> Trace {
    let mut position =
        Position::from_fen(fen).unwrap_or_else(|_| die(fen, seed, &[], bad(0, "start FEN parse")));
    if position.to_fen() != fen {
        die(fen, seed, &[], bad(0, "noncanonical start FEN"));
    }
    let mut state = seed;
    let mut trace = Trace {
        moves: Vec::new(),
        fens: vec![position.to_fen()],
        hashes: vec![position.zobrist_hash()],
    };
    for ply in 0..limit.min(MAX_PLIES) {
        let legal = position
            .legal_moves()
            .unwrap_or_else(|_| die(fen, seed, &trace.moves, bad(ply, "generated legal moves")));
        if legal.is_empty() {
            break;
        }
        let divisor = u64::try_from(legal.len()).unwrap_or(u64::MAX);
        let index = usize::try_from(next_random(&mut state) % divisor).unwrap_or(0);
        let selected = legal[index];
        position = position.after_legal_move(selected).unwrap_or_else(|_| {
            let mut prefix = trace.moves.clone();
            prefix.push(selected);
            die(fen, seed, &prefix, bad(ply, "generated legal child"))
        });
        trace.moves.push(selected);
        trace.fens.push(position.to_fen());
        trace.hashes.push(position.zobrist_hash());
    }
    trace
}

fn verify(fen: &str, seed: u64, limit: usize) -> Trace {
    let first = generate(fen, seed, limit);
    let second = generate(fen, seed, limit);
    if first != second {
        die_trace(fen, seed, &first, &second, "nondeterministic trace");
    }
    let replay =
        validate(fen, &first.moves).unwrap_or_else(|error| die(fen, seed, &first.moves, error));
    if replay != first {
        die_trace(fen, seed, &first, &replay, "replay FEN/hash trace diverged");
    }
    first
}

#[test]
fn fixed_seed_legal_lines_are_deterministic_replayable_and_reversible() {
    for fen in [STARTPOS, KIWIPETE] {
        for seed in SEEDS {
            verify(fen, seed, MAX_PLIES);
        }
    }
}

#[test]
fn dedicated_fixtures_reach_special_move_classes() {
    let cases = [
        ("castling", CASTLING, SPECIAL_SEEDS[0]),
        ("promotion", PROMOTION, SPECIAL_SEEDS[1]),
        ("en-passant", EN_PASSANT, SPECIAL_SEEDS[2]),
        ("check", IN_CHECK, SPECIAL_SEEDS[3]),
        ("capture", CAPTURE, SPECIAL_SEEDS[4]),
    ];
    for (label, fen, seed) in cases {
        let root = Position::from_fen(fen)
            .unwrap_or_else(|_| die(fen, seed, &[], bad(0, "fixture did not parse")));
        let trace = verify(fen, seed, MAX_PLIES);
        let first = *trace
            .moves
            .first()
            .unwrap_or_else(|| die(fen, seed, &[], bad(0, "fixture selected no move")));
        let reached = match label {
            "castling" => matches!(first.to_coordinate().as_str(), "e1g1" | "e1c1"),
            "promotion" => first.promotion().is_some(),
            "en-passant" => root.en_passant_target() == Some(first.to()) && root.is_capture(first),
            "check" => root.is_check(),
            "capture" => root.is_capture(first),
            _ => false,
        };
        assert!(
            reached,
            "{}; reason={label} fixture missed its required class",
            ctx(fen, seed, 0, &[first])
        );
    }
}

#[test]
fn terminal_positions_select_no_continuation() {
    for fen in TERMINALS {
        let trace = verify(fen, SEEDS[0], MAX_PLIES);
        if let Some(first) = trace.moves.first() {
            die(fen, SEEDS[0], &[*first], bad(0, "terminal continuation"));
        }
    }
}

#[test]
fn corrupted_replay_fails_at_intended_ply_and_shrinks_to_earliest_prefix() {
    let seed = SEEDS[0];
    let mut moves = generate(STARTPOS, seed, 12).moves;
    let failing_ply = 4;
    moves[failing_ply] = Move::from_coordinate("a1a8").unwrap_or_else(|_| {
        die(
            STARTPOS,
            seed,
            &moves,
            bad(failing_ply, "corrupt move parse"),
        )
    });
    let expected = bad(failing_ply, "selected move not legal");
    assert_eq!(
        validate(STARTPOS, &moves),
        Err(expected),
        "{}; reason=corruption failed for the wrong reason",
        ctx(STARTPOS, seed, failing_ply, &moves[..=failing_ply])
    );
    let (shrunk, error) =
        shrink(STARTPOS, &moves).unwrap_or_else(|| die(STARTPOS, seed, &moves, expected));
    assert_eq!(error, expected, "{}", ctx(STARTPOS, seed, error.0, &shrunk));
    assert_eq!(
        shrunk.len(),
        failing_ply + 1,
        "{}; reason=shrinker missed earliest failing prefix",
        ctx(STARTPOS, seed, error.0, &shrunk)
    );
    assert!(
        validate(STARTPOS, &shrunk[..failing_ply]).is_ok(),
        "{}; reason=prefix before corruption also failed",
        ctx(STARTPOS, seed, failing_ply - 1, &shrunk[..failing_ply])
    );
}
