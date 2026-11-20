use chess_board::{Color, PgnGame, Position, PositionStatus};
use chess_coach::{
    CoachConfig, GameReview, MoveLabel, ReviewEntry, ReviewSummary, review_pgn_game,
};
use chess_search::engine::{Engine, EngineLimits, EngineResult};
use chess_search::explore::side_explore;
use chess_search::{
    ForcingKind, MAX_PLAY_DEPTH, SacrificeAftermath, SideExploreCandidate, SideExploreReport,
};
mod datagen;
mod uci;

use std::process::ExitCode;
use std::time::Instant;

const PERFT_USAGE: &str = "usage: chess-cli perft --fen <fen> --depth <n>";
const PGN_ROUNDTRIP_USAGE: &str = "usage: chess-cli pgn-roundtrip --pgn <pgn>";
const PGN_PLIES_USAGE: &str = "usage: chess-cli pgn-plies --pgn <pgn>";
const ANALYZE_FEN_USAGE: &str = "usage: chess-cli analyze-fen --fen <fen> --depth <1..32>";
const BEST_MOVE_USAGE: &str =
    "usage: chess-cli best-move --fen <fen> [--aggressive] [--budget <nodes>]";
const SIDE_EXPLORE_USAGE: &str = "usage: chess-cli side-explore --fen <fen> --side <white|black> --budget <nodes> [--aggressive]";
const BENCH_USAGE: &str = "usage: chess-cli bench --depth <1..32>";
const REVIEW_PGN_USAGE: &str = "usage: chess-cli review-pgn --pgn <pgn> --depth <2..6>";
/// Same set as the legacy `m8_bench` example, so both searches are measured on the same positions.
const BENCH_POSITIONS: [(&str, &str); 5] = [
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
/// Transposition table for the one-shot CLI searches; matches the UCI default.
const CLI_HASH_MB: usize = 16;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);

    match args.next().as_deref() {
        Some("--help" | "-h") => {
            print_help();
            ExitCode::SUCCESS
        }
        Some("uci") => {
            uci::run();
            ExitCode::SUCCESS
        }
        Some("perft") => run_perft(&args.collect::<Vec<_>>()),
        Some("pgn-roundtrip") => run_pgn_roundtrip(&args.collect::<Vec<_>>()),
        Some("pgn-plies") => run_pgn_plies(&args.collect::<Vec<_>>()),
        Some("analyze-fen") => run_analyze_fen(&args.collect::<Vec<_>>()),
        Some("best-move") => run_best_move(&args.collect::<Vec<_>>()),
        Some("side-explore") => run_side_explore(&args.collect::<Vec<_>>()),
        Some("bench") => run_bench(&args.collect::<Vec<_>>()),
        Some("review-pgn") => run_review_pgn(&args.collect::<Vec<_>>()),
        Some("datagen") => datagen::run(&args.collect::<Vec<_>>()),
        Some("relabel") => datagen::relabel(&args.collect::<Vec<_>>()),
        Some("selfplay") => {
            eprintln!(
                "error: selfplay is unavailable until search has an approved node-limit API."
            );
            ExitCode::from(2)
        }
        Some("oracle") => {
            eprintln!(
                "Oracle validation is not a production chess-cli command. Run `just oracle`; the harness lives under tests/oracle/."
            );
            ExitCode::from(2)
        }
        Some(_) => {
            eprintln!("Unknown placeholder command. Run `chess-cli --help`.");
            ExitCode::from(2)
        }
        None => {
            println!("chess-cli Phase 0 scaffold. Run `chess-cli --help` for placeholders.");
            ExitCode::SUCCESS
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ReviewPgnArgs<'a> {
    pgn: &'a str,
    depth: &'a str,
}

fn run_review_pgn(args: &[String]) -> ExitCode {
    let review_args = match parse_review_pgn_args(args) {
        Ok(value) => value,
        Err(message) => return review_pgn_usage_error(&message),
    };
    let depth = match parse_coach_depth(review_args.depth) {
        Ok(value) => value,
        Err(message) => return review_pgn_usage_error(message),
    };
    let game = match PgnGame::from_pgn(review_args.pgn) {
        Ok(game) => game,
        Err(error) => {
            eprintln!("error: invalid PGN: {error}");
            return ExitCode::from(2);
        }
    };
    let review = match review_pgn_game(
        &game,
        CoachConfig {
            search_depth: depth,
        },
    ) {
        Ok(review) => review,
        Err(error) => {
            eprintln!("error: review failed: {error}");
            return ExitCode::from(2);
        }
    };

    print!("{}", review_json(&review, depth));
    ExitCode::SUCCESS
}

fn parse_review_pgn_args(args: &[String]) -> Result<ReviewPgnArgs<'_>, String> {
    let mut pgn = None;
    let mut depth = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--pgn" => {
                if pgn.is_some() {
                    return Err("duplicate --pgn".to_owned());
                }
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --pgn".to_owned());
                };
                if value.starts_with("--") {
                    return Err("missing value for --pgn".to_owned());
                }
                pgn = Some(value.as_str());
                index += 2;
            }
            "--depth" => {
                if depth.is_some() {
                    return Err("duplicate --depth".to_owned());
                }
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --depth".to_owned());
                };
                if value.starts_with("--") {
                    return Err("missing value for --depth".to_owned());
                }
                depth = Some(value.as_str());
                index += 2;
            }
            value if value.starts_with("--") => return Err(format!("unknown flag {value}")),
            _ => return Err("unexpected positional argument".to_owned()),
        }
    }

    Ok(ReviewPgnArgs {
        pgn: pgn.ok_or_else(|| "missing required --pgn".to_owned())?,
        depth: depth.ok_or_else(|| "missing required --depth".to_owned())?,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FenDepthArgs<'a> {
    fen: &'a str,
    depth: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BestMoveArgs<'a> {
    fen: &'a str,
    aggressive: bool,
    budget: u64,
}

fn run_analyze_fen(args: &[String]) -> ExitCode {
    let analyze_args = match parse_fen_depth_args(args) {
        Ok(value) => value,
        Err(message) => return analyze_usage_error(&message),
    };
    let depth = match parse_engine_depth(analyze_args.depth) {
        Ok(value) => value,
        Err(message) => return analyze_usage_error(message),
    };
    let position = match Position::from_fen(analyze_args.fen) {
        Ok(position) => position,
        Err(error) => {
            eprintln!("error: invalid FEN: {error}");
            return ExitCode::from(2);
        }
    };
    let status = match position.status() {
        Ok(status) => status,
        Err(error) => {
            eprintln!("error: analyze failed: {error}");
            return ExitCode::from(2);
        }
    };
    let result = engine_search(&position, depth);

    print_analyze_json(&position, status, &result);
    ExitCode::SUCCESS
}

/// One fixed-depth search with the play engine (`engine.rs`) on a fresh table, so the same
/// position and depth always give the same answer and node count.
fn engine_search(position: &Position, depth: u8) -> EngineResult {
    Engine::new(CLI_HASH_MB).think(
        position,
        &[],
        EngineLimits {
            max_depth: Some(depth),
            nodes: None,
            stop: None,
        },
        &mut |_| true,
    )
}

fn parse_fen_depth_args(args: &[String]) -> Result<FenDepthArgs<'_>, String> {
    let mut fen = None;
    let mut depth = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--fen" => {
                if fen.is_some() {
                    return Err("duplicate --fen".to_owned());
                }
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --fen".to_owned());
                };
                if value.starts_with("--") {
                    return Err("missing value for --fen".to_owned());
                }
                fen = Some(value.as_str());
                index += 2;
            }
            "--depth" => {
                if depth.is_some() {
                    return Err("duplicate --depth".to_owned());
                }
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --depth".to_owned());
                };
                if value.starts_with("--") {
                    return Err("missing value for --depth".to_owned());
                }
                depth = Some(value.as_str());
                index += 2;
            }
            value if value.starts_with("--") => return Err(format!("unknown flag {value}")),
            _ => return Err("unexpected positional argument".to_owned()),
        }
    }

    Ok(FenDepthArgs {
        fen: fen.ok_or_else(|| "missing required --fen".to_owned())?,
        depth: depth.ok_or_else(|| "missing required --depth".to_owned())?,
    })
}

fn run_best_move(args: &[String]) -> ExitCode {
    let best_move_args = match parse_best_move_args(args) {
        Ok(value) => value,
        Err(message) => {
            eprintln!("error: {message}");
            eprintln!("{BEST_MOVE_USAGE}");
            return ExitCode::from(2);
        }
    };
    let position = match Position::from_fen(best_move_args.fen) {
        Ok(position) => position,
        Err(error) => {
            eprintln!("error: invalid FEN: {error}");
            return ExitCode::from(2);
        }
    };
    let report = match side_explore(
        &position,
        &[],
        best_move_args.budget,
        position.side_to_move(),
        best_move_args.aggressive,
    ) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("error: best-move failed: {error}");
            return ExitCode::from(2);
        }
    };
    print_best_move_json(best_move_args.fen, best_move_args.aggressive, &report);
    ExitCode::SUCCESS
}

fn parse_best_move_args(args: &[String]) -> Result<BestMoveArgs<'_>, String> {
    let mut fen = None;
    let mut aggressive = false;
    let mut budget = 48_000_u64;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--aggressive" => {
                aggressive = true;
                index += 1;
            }
            "--fen" => {
                if fen.is_some() {
                    return Err("duplicate --fen".to_owned());
                }
                let value = args.get(index + 1).ok_or("missing value for --fen")?;
                if value.starts_with("--") {
                    return Err("missing value for --fen".to_owned());
                }
                fen = Some(value.as_str());
                index += 2;
            }
            "--budget" => {
                let value = args.get(index + 1).ok_or("missing value for --budget")?;
                if value.starts_with("--") {
                    return Err("missing value for --budget".to_owned());
                }
                budget = value
                    .parse()
                    .map_err(|_| "invalid budget: must be a positive integer")?;
                index += 2;
            }
            value if value.starts_with("--") => return Err(format!("unknown flag {value}")),
            _ => return Err("unexpected positional argument".to_owned()),
        }
    }

    Ok(BestMoveArgs {
        fen: fen.ok_or_else(|| "missing required --fen".to_owned())?,
        aggressive,
        budget,
    })
}

fn run_side_explore(args: &[String]) -> ExitCode {
    let (fen, side_text, budget, aggressive) = match parse_side_explore_args(args) {
        Ok(value) => value,
        Err(message) => {
            eprintln!("error: {message}");
            eprintln!("{SIDE_EXPLORE_USAGE}");
            return ExitCode::from(2);
        }
    };
    let side = match side_text {
        "white" => Color::White,
        "black" => Color::Black,
        other => {
            eprintln!("error: invalid side {other:?}; expected white or black");
            eprintln!("{SIDE_EXPLORE_USAGE}");
            return ExitCode::from(2);
        }
    };
    let position = match Position::from_fen(fen) {
        Ok(position) => position,
        Err(error) => {
            eprintln!("error: invalid FEN: {error}");
            return ExitCode::from(2);
        }
    };
    let report = match side_explore(&position, &[], budget, side, aggressive) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("error: side-explore failed: {error}");
            return ExitCode::from(2);
        }
    };
    print_side_explore_json(fen, &report);
    ExitCode::SUCCESS
}

fn parse_side_explore_args(args: &[String]) -> Result<(&str, &str, u64, bool), String> {
    let mut fen = None;
    let mut side = None;
    let mut budget = None;
    let mut aggressive = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--aggressive" => {
                aggressive = true;
                index += 1;
            }
            "--fen" => {
                let value = args.get(index + 1).ok_or("missing value for --fen")?;
                fen = Some(value.as_str());
                index += 2;
            }
            "--side" => {
                let value = args.get(index + 1).ok_or("missing value for --side")?;
                side = Some(value.as_str());
                index += 2;
            }
            "--budget" => {
                let value = args.get(index + 1).ok_or("missing value for --budget")?;
                let n: u64 = value
                    .parse()
                    .map_err(|_| "invalid budget: must be a positive integer")?;
                budget = Some(n);
                index += 2;
            }
            value if value.starts_with("--") => {
                return Err(format!("unknown flag {value}"));
            }
            _ => return Err("unexpected positional argument".to_owned()),
        }
    }
    Ok((
        fen.ok_or("missing required --fen")?,
        side.ok_or("missing required --side")?,
        budget.ok_or("missing required --budget")?,
        aggressive,
    ))
}

fn forcing_kind_label(kind: ForcingKind) -> &'static str {
    match kind {
        ForcingKind::Mate => "mate",
        ForcingKind::Check => "check",
        ForcingKind::Capture => "capture",
        ForcingKind::Defense => "defense",
    }
}

fn print_side_explore_json(fen: &str, report: &SideExploreReport) {
    let side_label = if report.side == Color::White {
        "white"
    } else {
        "black"
    };
    let on_turn = report.on_turn;
    let mate_detected = report.mate_detected;
    let depth = report.depth;
    let nodes = report.nodes;
    let mut json = String::new();
    json.push_str(&format!(
        "{{\"command\":\"side-explore\",\"fen\":\"{}\",\"side\":\"{}\",\"on_turn\":{},\"mate_detected\":{},\"depth\":{},\"nodes\":{},\"candidates\":[",
        fen, side_label, on_turn, mate_detected, depth, nodes
    ));
    for (i, c) in report.candidates.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        push_side_explore_candidate_json(&mut json, c);
    }
    json.push_str("],\"principal_line\":[");
    for (i, mv) in report.principal_line.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        json.push('"');
        json.push_str(&mv.to_coordinate());
        json.push('"');
    }
    json.push_str("]}");
    println!("{json}");
}

fn push_side_explore_candidate_json(json: &mut String, c: &SideExploreCandidate) {
    let mate_in = match c.mate_in {
        Some(n) => format!("{n}"),
        None => "null".to_owned(),
    };
    let aftermath = match c.aftermath {
        Some(SacrificeAftermath::Accepted) => "\"accepted\"".to_owned(),
        Some(SacrificeAftermath::Defended) => "\"defended\"".to_owned(),
        None => "null".to_owned(),
    };
    let continuation = match c.continuation {
        Some(mv) => format!("\"{}\"", mv.to_coordinate()),
        None => "null".to_owned(),
    };
    json.push_str(&format!(
        "{{\"move\":\"{}\",\"kind\":\"{}\",\"exact_score_cp\":{},\"sound\":{},\"sacrifice\":{},\"mate_in\":{},\"aftermath\":{},\"continuation\":{}}}",
        c.mv.to_coordinate(),
        forcing_kind_label(c.kind),
        c.exact_score,
        c.sound,
        c.sacrifice,
        mate_in,
        aftermath,
        continuation
    ));
}

fn run_bench(args: &[String]) -> ExitCode {
    let depth_text = match parse_bench_args(args) {
        Ok(value) => value,
        Err(message) => return bench_usage_error(&message),
    };
    let depth = match parse_engine_depth(depth_text) {
        Ok(value) => value,
        Err(message) => return bench_usage_error(message),
    };

    let mut positions = Vec::with_capacity(BENCH_POSITIONS.len());
    for (_name, fen) in BENCH_POSITIONS {
        match Position::from_fen(fen) {
            Ok(position) => positions.push(position),
            Err(error) => {
                eprintln!("error: bench FEN failed to parse: {error}");
                return ExitCode::from(2);
            }
        }
    }
    // Only the searches are timed; each position starts from a fresh engine so the node count is
    // deterministic and independent of the order of the set.
    let mut elapsed = std::time::Duration::ZERO;
    let mut total_nodes = 0_u64;
    for position in &positions {
        let mut engine = Engine::new(CLI_HASH_MB);
        let started = Instant::now();
        let result = engine.think(
            position,
            &[],
            EngineLimits {
                max_depth: Some(depth),
                nodes: None,
                stop: None,
            },
            &mut |_| true,
        );
        elapsed += started.elapsed();
        total_nodes = total_nodes.saturating_add(result.nodes);
    }

    let elapsed_ms = u64::try_from(elapsed.as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    let nodes_per_second = total_nodes.saturating_mul(1_000) / elapsed_ms;
    print_bench_json(depth, total_nodes, elapsed_ms, nodes_per_second);
    ExitCode::SUCCESS
}

fn parse_bench_args(args: &[String]) -> Result<&str, String> {
    let mut depth = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--depth" => {
                if depth.is_some() {
                    return Err("duplicate --depth".to_owned());
                }
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --depth".to_owned());
                };
                if value.starts_with("--") {
                    return Err("missing value for --depth".to_owned());
                }
                depth = Some(value.as_str());
                index += 2;
            }
            value if value.starts_with("--") => return Err(format!("unknown flag {value}")),
            _ => return Err("unexpected positional argument".to_owned()),
        }
    }

    depth.ok_or_else(|| "missing required --depth".to_owned())
}

fn run_pgn_roundtrip(args: &[String]) -> ExitCode {
    let pgn_text = match parse_pgn_roundtrip_args(args) {
        Ok(value) => value,
        Err(message) => return pgn_usage_error(&message),
    };

    let game = match PgnGame::from_pgn(pgn_text) {
        Ok(game) => game,
        Err(error) => {
            eprintln!("error: invalid PGN: {error}");
            return ExitCode::from(2);
        }
    };

    match game.to_pgn() {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: invalid PGN: {error}");
            ExitCode::from(2)
        }
    }
}

fn run_pgn_plies(args: &[String]) -> ExitCode {
    let pgn_text = match parse_pgn_roundtrip_args(args) {
        Ok(value) => value,
        Err(message) => return pgn_plies_usage_error(&message),
    };
    let game = match PgnGame::from_pgn(pgn_text) {
        Ok(game) => game,
        Err(error) => {
            eprintln!("error: invalid PGN: {error}");
            return ExitCode::from(2);
        }
    };

    let mut position = Position::startpos();
    let mut ply = 0_u32;
    for mv in game.moves().iter().copied() {
        ply += 1;
        let fen_before = position.to_fen();
        let side = position.side_to_move();
        let san = match position.move_to_san(mv) {
            Ok(san) => san,
            Err(error) => {
                eprintln!("error: could not render SAN: {error}");
                return ExitCode::from(2);
            }
        };
        let child = match position.after_legal_move(mv) {
            Ok(child) => child,
            Err(error) => {
                eprintln!("error: illegal PGN move: {error}");
                return ExitCode::from(2);
            }
        };
        let fen_after = child.to_fen();

        let mut json = String::new();
        json.push_str("{\"ply\":");
        json.push_str(&ply.to_string());
        json.push_str(",\"uci\":");
        push_json_string(&mut json, &mv.to_coordinate());
        json.push_str(",\"san\":");
        push_json_string(&mut json, &san);
        json.push_str(",\"fenBefore\":");
        push_json_string(&mut json, &fen_before);
        json.push_str(",\"side\":\"");
        json.push_str(match side {
            Color::White => "white",
            Color::Black => "black",
        });
        json.push('"');
        json.push_str(",\"fenAfter\":");
        push_json_string(&mut json, &fen_after);
        json.push('}');
        println!("{json}");

        position = child;
    }

    ExitCode::SUCCESS
}

fn pgn_plies_usage_error(message: &str) -> ExitCode {
    eprintln!("error: {message}");
    eprintln!("{PGN_PLIES_USAGE}");
    ExitCode::from(2)
}

fn parse_pgn_roundtrip_args(args: &[String]) -> Result<&str, String> {
    let mut pgn = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--pgn" => {
                if pgn.is_some() {
                    return Err("duplicate --pgn".to_owned());
                }
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --pgn".to_owned());
                };
                if value.starts_with("--") {
                    return Err("missing value for --pgn".to_owned());
                }
                pgn = Some(value.as_str());
                index += 2;
            }
            value if value.starts_with("--") => return Err(format!("unknown flag {value}")),
            _ => return Err("unexpected positional argument".to_owned()),
        }
    }

    pgn.ok_or_else(|| "missing required --pgn".to_owned())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PerftArgs<'a> {
    fen: &'a str,
    depth: &'a str,
    divide: bool,
}

fn run_perft(args: &[String]) -> ExitCode {
    let perft_args = match parse_perft_args(args) {
        Ok(value) => value,
        Err(message) => return usage_error(&message),
    };

    let depth = match parse_depth(perft_args.depth) {
        Ok(value) => value,
        Err(message) => return usage_error(message),
    };

    let position = match Position::from_fen(perft_args.fen) {
        Ok(position) => position,
        Err(error) => {
            eprintln!("error: invalid FEN: {error}");
            return ExitCode::from(2);
        }
    };

    let nodes = match position.perft(depth) {
        Ok(nodes) => nodes,
        Err(error) => {
            eprintln!("error: perft failed: {error}");
            return ExitCode::from(2);
        }
    };

    if perft_args.divide {
        let divide = match position.perft_divide(depth) {
            Ok(divide) => divide,
            Err(error) => {
                eprintln!("error: perft divide failed: {error}");
                return ExitCode::from(2);
            }
        };
        print_perft_divide_json(&position, depth, nodes, &divide);
    } else {
        print_perft_json(&position, depth, nodes);
    }
    ExitCode::SUCCESS
}

fn parse_perft_args(args: &[String]) -> Result<PerftArgs<'_>, String> {
    let mut fen = None;
    let mut depth = None;
    let mut divide = false;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--divide" => {
                if divide {
                    return Err("duplicate --divide".to_owned());
                }
                divide = true;
                index += 1;
            }
            "--fen" => {
                if fen.is_some() {
                    return Err("duplicate --fen".to_owned());
                }
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --fen".to_owned());
                };
                if value.starts_with("--") {
                    return Err("missing value for --fen".to_owned());
                }
                fen = Some(value.as_str());
                index += 2;
            }
            "--depth" => {
                if depth.is_some() {
                    return Err("duplicate --depth".to_owned());
                }
                let Some(value) = args.get(index + 1) else {
                    return Err("missing value for --depth".to_owned());
                };
                if value.starts_with("--") {
                    return Err("missing value for --depth".to_owned());
                }
                depth = Some(value.as_str());
                index += 2;
            }
            value if value.starts_with("--") => return Err(format!("unknown flag {value}")),
            _ => return Err("unexpected positional argument".to_owned()),
        }
    }

    let Some(fen) = fen else {
        return Err("missing required --fen".to_owned());
    };
    let Some(depth) = depth else {
        return Err("missing required --depth".to_owned());
    };

    Ok(PerftArgs { fen, depth, divide })
}

fn parse_depth(value: &str) -> Result<u8, &'static str> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("invalid depth");
    }
    if value.len() > 1 && value.starts_with('0') {
        return Err("invalid depth");
    }

    match value.parse::<u8>() {
        Ok(depth) if depth <= 6 => Ok(depth),
        _ => Err("invalid depth"),
    }
}

/// Depth for the play engine, which deepens far past the legacy search's 6-ply window.
fn parse_engine_depth(value: &str) -> Result<u8, &'static str> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("invalid depth");
    }
    if value.starts_with('0') {
        return Err("invalid depth");
    }
    match value.parse::<u8>() {
        Ok(depth) if depth <= MAX_PLAY_DEPTH => Ok(depth),
        _ => Err("invalid depth"),
    }
}

fn parse_coach_depth(value: &str) -> Result<u8, &'static str> {
    let depth = parse_depth(value)?;
    if depth < 2 {
        return Err("invalid depth");
    }
    Ok(depth)
}

fn usage_error(message: &str) -> ExitCode {
    eprintln!("error: {message}");
    eprintln!("{PERFT_USAGE}");
    ExitCode::from(2)
}

fn analyze_usage_error(message: &str) -> ExitCode {
    eprintln!("error: {message}");
    eprintln!("{ANALYZE_FEN_USAGE}");
    ExitCode::from(2)
}

fn bench_usage_error(message: &str) -> ExitCode {
    eprintln!("error: {message}");
    eprintln!("{BENCH_USAGE}");
    ExitCode::from(2)
}

fn pgn_usage_error(message: &str) -> ExitCode {
    eprintln!("error: {message}");
    eprintln!("{PGN_ROUNDTRIP_USAGE}");
    ExitCode::from(2)
}

fn review_pgn_usage_error(message: &str) -> ExitCode {
    eprintln!("error: {message}");
    eprintln!("{REVIEW_PGN_USAGE}");
    ExitCode::from(2)
}

fn review_json(review: &GameReview, depth: u8) -> String {
    let mut json = String::new();
    json.push_str("{\"command\":\"review-pgn\",\"depth\":");
    json.push_str(&depth.to_string());
    json.push_str(",\"summary\":");
    push_review_summary_json(&mut json, &review.summary);
    json.push_str(",\"entries\":[");
    for (index, entry) in review.entries.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        push_review_entry_json(&mut json, entry);
    }
    json.push_str("]}");
    json
}

fn push_review_summary_json(json: &mut String, summary: &ReviewSummary) {
    json.push_str("{\"total_moves\":");
    json.push_str(&summary.total_moves.to_string());
    json.push_str(",\"best\":");
    json.push_str(&summary.best.to_string());
    json.push_str(",\"good\":");
    json.push_str(&summary.good.to_string());
    json.push_str(",\"inaccuracies\":");
    json.push_str(&summary.inaccuracies.to_string());
    json.push_str(",\"mistakes\":");
    json.push_str(&summary.mistakes.to_string());
    json.push_str(",\"blunders\":");
    json.push_str(&summary.blunders.to_string());
    json.push('}');
}

fn push_review_entry_json(json: &mut String, entry: &ReviewEntry) {
    json.push_str("{\"ply\":");
    json.push_str(&entry.ply.to_string());
    json.push_str(",\"played_move\":");
    push_json_string(json, &entry.played_move.to_coordinate());
    json.push_str(",\"san\":");
    push_json_string(json, &entry.san);
    json.push_str(",\"best_move\":");
    match entry.best_move {
        Some(best_move) => push_json_string(json, &best_move.to_coordinate()),
        None => json.push_str("null"),
    }
    json.push_str(",\"best_score_cp\":");
    json.push_str(&entry.best_score_cp.to_string());
    json.push_str(",\"played_score_cp\":");
    json.push_str(&entry.played_score_cp.to_string());
    json.push_str(",\"cp_loss\":");
    json.push_str(&entry.cp_loss.to_string());
    json.push_str(",\"label\":");
    push_json_string(json, label_text(entry.label));
    json.push('}');
}

fn push_json_string(json: &mut String, value: &str) {
    json.push('"');
    for character in value.chars() {
        match character {
            '"' => json.push_str("\\\""),
            '\\' => json.push_str("\\\\"),
            '\u{08}' => json.push_str("\\b"),
            '\u{0c}' => json.push_str("\\f"),
            '\n' => json.push_str("\\n"),
            '\r' => json.push_str("\\r"),
            '\t' => json.push_str("\\t"),
            character if character.is_control() => {
                json.push_str("\\u");
                let value = u32::from(character);
                for shift in [12, 8, 4, 0] {
                    let digit = ((value >> shift) & 0x0f) as u8;
                    json.push(char::from(if digit < 10 {
                        b'0' + digit
                    } else {
                        b'a' + digit - 10
                    }));
                }
            }
            character => json.push(character),
        }
    }
    json.push('"');
}

const fn label_text(label: MoveLabel) -> &'static str {
    match label {
        MoveLabel::Best => "best",
        MoveLabel::Good => "good",
        MoveLabel::Inaccuracy => "inaccuracy",
        MoveLabel::Mistake => "mistake",
        MoveLabel::Blunder => "blunder",
    }
}

fn print_analyze_json(position: &Position, status: PositionStatus, result: &EngineResult) {
    let pv = result
        .pv
        .iter()
        .map(|mv| format!("\"{}\"", mv.to_coordinate()))
        .collect::<Vec<_>>()
        .join(",");
    print!(
        "{{\"command\":\"analyze-fen\",\"search\":\"engine\",\"fen\":\"{}\",\"depth\":{},\"status\":\"{}\",\"best_move\":{},\"score_cp\":{},\"nodes\":{},\"pv\":[{}]}}",
        position.to_fen(),
        result.depth,
        status_text(status),
        result.best_move.map_or_else(
            || "null".to_owned(),
            |mv| format!("\"{}\"", mv.to_coordinate())
        ),
        result.score_cp,
        result.nodes,
        pv
    );
}

fn print_best_move_json(fen: &str, aggressive: bool, report: &SideExploreReport) {
    let top = report.candidates.first();
    print!(
        "{{\"command\":\"best-move\",\"fen\":\"{}\",\"aggressive\":{},\"evaluator_backend\":\"classical\",\"best_move\":{},\"objective_score_cp\":{},\"depth\":{},\"nodes\":{}}}",
        fen,
        aggressive,
        top.map_or_else(
            || "null".to_owned(),
            |candidate| format!("\"{}\"", candidate.mv.to_coordinate())
        ),
        top.map_or(0, |candidate| candidate.exact_score),
        report.depth,
        report.nodes
    );
}

fn status_text(status: PositionStatus) -> &'static str {
    match status {
        PositionStatus::Ongoing => "ongoing",
        PositionStatus::Checkmate => "checkmate",
        PositionStatus::Stalemate => "stalemate",
    }
}

fn print_bench_json(depth: u8, total_nodes: u64, elapsed_ms: u64, nodes_per_second: u64) {
    print!(
        "{{\"command\":\"bench\",\"search\":\"engine\",\"position_set\":[\"startpos\",\"kiwipete\",\"recapture_trap\",\"stalemate_trap\",\"back_rank_mate\"],\"depth\":{depth},\"total_nodes\":{total_nodes},\"elapsed_ms\":{elapsed_ms},\"nodes_per_second\":{nodes_per_second}}}"
    );
}

fn print_perft_json(position: &Position, depth: u8, nodes: u64) {
    print!(
        "{{\"command\":\"perft\",\"fen\":\"{}\",\"depth\":{},\"nodes\":{}}}",
        position.to_fen(),
        depth,
        nodes
    );
}

fn print_perft_divide_json(
    position: &Position,
    depth: u8,
    nodes: u64,
    divide: &[chess_board::PerftDivideEntry],
) {
    print!(
        "{{\"command\":\"perft\",\"fen\":\"{}\",\"depth\":{},\"nodes\":{},\"divide\":[",
        position.to_fen(),
        depth,
        nodes
    );
    for (index, entry) in divide.iter().enumerate() {
        if index > 0 {
            print!(",");
        }
        print!(
            "{{\"move\":\"{}\",\"nodes\":{}}}",
            entry.mv().to_coordinate(),
            entry.nodes()
        );
    }
    print!("]}}");
}

fn print_help() {
    println!("chess-cli Phase 0 scaffold");
    println!();
    println!("Commands:");
    println!("  --help        Show this help text");
    println!("  perft         Run owned perft: perft --fen <fen> --depth <n> [--divide]");
    println!("  pgn-roundtrip Canonicalize one local PGN: pgn-roundtrip --pgn <pgn>");
    println!(
        "  analyze-fen   Search one local FEN with the play engine: analyze-fen --fen <fen> --depth <1..32>"
    );
    println!(
        "  best-move     Search the board-first Play move: best-move --fen <fen> [--aggressive] [--budget <nodes>]"
    );
    println!(
        "  bench         Benchmark the play engine (engine.rs) on a fixed set: bench --depth <1..32>"
    );
    println!("  review-pgn    Review one local PGN: review-pgn --pgn <pgn> --depth <2..6>");
    println!("  pgn-plies     Replay PGN to JSONL: pgn-plies --pgn <pgn>");
    println!(
        "  datagen       Self-play tuner data: datagen --out <dir> --games <n> [--threads 10] [--nodes 6000] [--seed 1]"
    );
    println!(
        "  relabel       Re-score a tuner dataset with search: relabel --in <file> --out <file> [--threads 10] [--nodes 6000]"
    );
    println!("  selfplay      Unavailable until search has an approved node-limit API");
    println!("  oracle        Not supported here; use tests/oracle harness via `just oracle`");
}

#[cfg(test)]
mod tests {
    use super::{BestMoveArgs, parse_best_move_args};

    #[test]
    fn best_move_args_parse_defaults_and_aggressive_budget() {
        let default_args = vec!["--fen".to_owned(), "start-fen".to_owned()];
        assert_eq!(
            parse_best_move_args(&default_args).expect("default args should parse"),
            BestMoveArgs {
                fen: "start-fen",
                aggressive: false,
                budget: 48_000,
            }
        );

        let aggressive_args = vec![
            "--fen".to_owned(),
            "sharp-fen".to_owned(),
            "--aggressive".to_owned(),
            "--budget".to_owned(),
            "200000".to_owned(),
        ];
        assert_eq!(
            parse_best_move_args(&aggressive_args).expect("aggressive args should parse"),
            BestMoveArgs {
                fen: "sharp-fen",
                aggressive: true,
                budget: 200_000,
            }
        );
    }
}
