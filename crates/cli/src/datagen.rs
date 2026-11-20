//! Self-play data for the evaluation tuner: the engine plays itself at a fixed node budget and
//! writes each quiet position with its own search score and the final game result.
//!
//! Output lines: `<FEN> [<white result>] score:<white cp>`, one file per thread.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use chess_board::{Color, Position, PositionStatus};
use chess_search::engine::{Engine, EngineLimits};

const USAGE: &str =
    "usage: chess-cli datagen --out <dir> --games <n> [--threads 10] [--nodes 6000] [--seed 1]";
const RANDOM_PLIES: usize = 8;
const OPENING_LIMIT: i32 = 300;
const MAX_PLIES: usize = 400;
const WIN_SCORE: i32 = 2_500;
const WIN_PLIES: u32 = 4;
const DRAW_PLY: usize = 80;
const DRAW_SCORE: i32 = 10;
const DRAW_PLIES: u32 = 10;
const RECORD_FROM_PLY: usize = 16;
const RECORD_LIMIT: i32 = 2_000;

struct Args {
    out: PathBuf,
    games: usize,
    threads: usize,
    nodes: u64,
    seed: u64,
}

pub fn run(args: &[String]) -> ExitCode {
    let parsed = match parse(args) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("error: {message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    if let Err(error) = std::fs::create_dir_all(&parsed.out) {
        eprintln!("error: {error}");
        return ExitCode::from(1);
    }
    let started = Instant::now();
    let per_thread = parsed.games.div_ceil(parsed.threads);
    let handles: Vec<_> = (0..parsed.threads)
        .map(|thread| {
            let path = parsed
                .out
                .join(format!("data-{}-{thread}.txt", parsed.seed));
            let seed = parsed
                .seed
                .wrapping_mul(0x9E37_79B9)
                .wrapping_add(thread as u64);
            let nodes = parsed.nodes;
            std::thread::spawn(move || play_games(&path, per_thread, nodes, seed))
        })
        .collect();
    let mut positions = 0_u64;
    for handle in handles {
        match handle.join() {
            Ok(Ok(count)) => positions += count,
            Ok(Err(error)) => {
                eprintln!("error: {error}");
                return ExitCode::from(1);
            }
            Err(_) => return ExitCode::from(1),
        }
    }
    println!(
        "datagen games={} positions={positions} seconds={:.1}",
        per_thread * parsed.threads,
        started.elapsed().as_secs_f64()
    );
    ExitCode::SUCCESS
}

fn parse(args: &[String]) -> Result<Args, String> {
    let mut parsed = Args {
        out: PathBuf::new(),
        games: 0,
        threads: 10,
        nodes: 6_000,
        seed: 1,
    };
    let mut iter = args.iter();
    while let Some(flag) = iter.next() {
        let value = iter.next().ok_or(format!("{flag} needs a value"))?;
        let number = || value.parse::<u64>().map_err(|_| format!("bad {flag}"));
        match flag.as_str() {
            "--out" => parsed.out = value.into(),
            "--games" => parsed.games = number()? as usize,
            "--threads" => parsed.threads = number()?.max(1) as usize,
            "--nodes" => parsed.nodes = number()?.max(1),
            "--seed" => parsed.seed = number()?,
            _ => return Err(format!("unknown flag {flag}")),
        }
    }
    if parsed.out.as_os_str().is_empty() || parsed.games == 0 {
        return Err("--out and --games are required".into());
    }
    Ok(parsed)
}

fn play_games(path: &PathBuf, games: usize, nodes: u64, mut seed: u64) -> std::io::Result<u64> {
    let mut out = BufWriter::new(File::create(path)?);
    let mut engine = Engine::new(16);
    let mut written = 0;
    let mut played = 0;
    while played < games {
        engine.new_game();
        let Some((position, history)) = random_opening(&mut engine, &mut seed, nodes) else {
            continue;
        };
        let (records, result) = play_game(&mut engine, position, history, nodes);
        for (fen, score) in &records {
            writeln!(out, "{fen} [{result:.1}] score:{score}")?;
        }
        written += records.len() as u64;
        played += 1;
    }
    out.flush()?;
    Ok(written)
}

/// Plays `RANDOM_PLIES` uniform random moves and keeps the start only if it is still balanced.
fn random_opening(engine: &mut Engine, seed: &mut u64, nodes: u64) -> Option<(Position, Vec<u64>)> {
    let mut position = Position::startpos();
    let mut history = Vec::new();
    for _ in 0..RANDOM_PLIES {
        let moves = position.legal_moves_trusted();
        if moves.is_empty() {
            return None;
        }
        let mv = moves[(next_random(seed) % moves.len() as u64) as usize];
        history.push(position.zobrist_hash());
        position = position.after_known_legal_move(mv).ok()?;
    }
    if position.legal_moves_trusted().is_empty() {
        return None;
    }
    let check = engine.think(&position, &history, limits(nodes), &mut |_| true);
    (check.score_cp.abs() <= OPENING_LIMIT).then_some((position, history))
}

/// Plays one game; returns the recorded (FEN, White score) pairs and White's result.
fn play_game(
    engine: &mut Engine,
    mut position: Position,
    mut history: Vec<u64>,
    nodes: u64,
) -> (Vec<(String, i32)>, f64) {
    let mut records = Vec::new();
    let mut seen: HashMap<u64, u32> = HashMap::new();
    let (mut win_streak, mut draw_streak) = (0_u32, 0_u32);
    let mut last_sign = 0;
    for ply in 0..MAX_PLIES {
        match position.status_trusted() {
            PositionStatus::Checkmate => {
                return (
                    records,
                    if position.side_to_move() == Color::White {
                        0.0
                    } else {
                        1.0
                    },
                );
            }
            PositionStatus::Stalemate => return (records, 0.5),
            PositionStatus::Ongoing => {}
        }
        let hash = position.zobrist_hash();
        let repeats = seen.entry(hash).or_insert(0);
        *repeats += 1;
        if *repeats >= 3 || position.is_fifty_move_draw() || position.has_insufficient_material() {
            return (records, 0.5);
        }
        let result = engine.think(&position, &history, limits(nodes), &mut |_| true);
        let Some(mv) = result.best_move else {
            return (records, 0.5);
        };
        let white_score = if position.side_to_move() == Color::White {
            result.score_cp
        } else {
            -result.score_cp
        };
        if white_score.abs() >= WIN_SCORE && white_score.signum() == last_sign {
            win_streak += 1;
        } else {
            win_streak = u32::from(white_score.abs() >= WIN_SCORE);
        }
        last_sign = white_score.signum();
        if win_streak >= WIN_PLIES {
            return (records, if white_score > 0 { 1.0 } else { 0.0 });
        }
        draw_streak = if ply >= DRAW_PLY && white_score.abs() <= DRAW_SCORE {
            draw_streak + 1
        } else {
            0
        };
        if draw_streak >= DRAW_PLIES {
            return (records, 0.5);
        }
        let quiet = !position.is_check()
            && !position.is_capture(mv)
            && mv.promotion().is_none()
            && white_score.abs() < RECORD_LIMIT;
        if ply >= RECORD_FROM_PLY.saturating_sub(RANDOM_PLIES) && quiet {
            records.push((position.to_fen(), white_score));
        }
        history.push(hash);
        let Ok(next) = position.after_known_legal_move(mv) else {
            return (records, 0.5);
        };
        position = next;
    }
    (records, 0.5)
}

fn limits(nodes: u64) -> EngineLimits<'static> {
    EngineLimits {
        max_depth: None,
        nodes: Some(nodes),
        stop: None,
    }
}

/// splitmix64.
fn next_random(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

const RELABEL_USAGE: &str =
    "usage: chess-cli relabel --in <file> --out <file> [--threads 10] [--nodes 6000]";

/// Re-scores an existing `<FEN> [<result>]` dataset with the engine's own search, keeping only
/// quiet positions (the tuner's filter): writes `<FEN> [<result>] score:<white cp>`.
pub fn relabel(args: &[String]) -> ExitCode {
    let mut input = None;
    let mut output = None;
    let (mut threads, mut nodes) = (10_usize, 6_000_u64);
    let mut iter = args.iter();
    while let Some(flag) = iter.next() {
        let Some(value) = iter.next() else {
            eprintln!("{RELABEL_USAGE}");
            return ExitCode::from(2);
        };
        match flag.as_str() {
            "--in" => input = Some(PathBuf::from(value)),
            "--out" => output = Some(PathBuf::from(value)),
            "--threads" => threads = value.parse().unwrap_or(10).max(1),
            "--nodes" => nodes = value.parse().unwrap_or(6_000).max(1),
            _ => {
                eprintln!("{RELABEL_USAGE}");
                return ExitCode::from(2);
            }
        }
    }
    let (Some(input), Some(output)) = (input, output) else {
        eprintln!("{RELABEL_USAGE}");
        return ExitCode::from(2);
    };
    let started = Instant::now();
    let text = match std::fs::read_to_string(&input) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::from(1);
        }
    };
    let quiet: Vec<(Position, String)> = text
        .lines()
        .filter_map(|line| {
            let tokens: Vec<_> = line.split_whitespace().collect();
            let label = (*tokens.get(6)?).to_string();
            let position = Position::from_fen(&tokens[..6].join(" ")).ok()?;
            let moves = position.legal_moves_trusted();
            let quiet = !position.is_check()
                && !moves.is_empty()
                && moves
                    .iter()
                    .all(|&mv| !position.is_capture(mv) && mv.promotion().is_none());
            quiet.then_some((position, label))
        })
        .collect();
    drop(text);
    let chunk = quiet.len().div_ceil(threads).max(1);
    let lines: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = quiet
            .chunks(chunk)
            .map(|part| {
                scope.spawn(move || {
                    let mut engine = Engine::new(16);
                    part.iter()
                        .map(|(position, label)| {
                            let score = engine
                                .think(position, &[], limits(nodes), &mut |_| true)
                                .score_cp;
                            let white = if position.side_to_move() == Color::White {
                                score
                            } else {
                                -score
                            };
                            format!("{} {label} score:{white}", position.to_fen())
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    });
    if let Err(error) = std::fs::write(&output, lines.join("\n") + "\n") {
        eprintln!("error: {error}");
        return ExitCode::from(1);
    }
    println!(
        "relabel positions={} seconds={:.1}",
        lines.len(),
        started.elapsed().as_secs_f64()
    );
    ExitCode::SUCCESS
}
