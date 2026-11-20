//! Minimal UCI front end so external tools (fastchess) can drive the engine.

use chess_board::{Color, Move, Position};
use chess_search::engine::{Engine, EngineLimits, IterationInfo};
use chess_search::skill::{MAX_LEVEL, think_at_level};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const DEFAULT_HASH_MB: usize = 16;
/// Safety margin for process and pipe latency per move.
const MOVE_OVERHEAD_MS: u64 = 30;

#[derive(Default)]
struct GoParams {
    wtime: Option<u64>,
    btime: Option<u64>,
    winc: u64,
    binc: u64,
    movestogo: Option<u64>,
    movetime: Option<u64>,
    depth: Option<u8>,
    nodes: Option<u64>,
}

/// Soft limit ends deepening between iterations; hard limit raises the stop flag mid-iteration.
struct TimeBudget {
    soft: Duration,
    hard: Duration,
}

impl TimeBudget {
    /// Best-move stability scaling of the soft limit: a move that just changed earns up to twice
    /// the soft time, a long-stable one stops early. Fixed `movetime` (soft == hard) is untouched.
    fn soft_for_stability(&self, stable: usize) -> Duration {
        const SCALE_PERCENT: [u32; 5] = [200, 130, 100, 80, 60];
        if self.soft >= self.hard {
            return self.soft;
        }
        let percent = SCALE_PERCENT[stable.min(SCALE_PERCENT.len() - 1)];
        (self.soft * percent / 100).min(self.hard)
    }
}

pub fn run() {
    let stdin = std::io::stdin();
    let engine = Arc::new(Mutex::new(Engine::new(DEFAULT_HASH_MB)));
    // `None` after a `position` command whose setup could not be parsed: `go` then has no move.
    let mut position = Some(Position::startpos());
    let mut history: Vec<u64> = Vec::new();
    let mut search: Option<(Arc<AtomicBool>, JoinHandle<()>)> = None;
    let mut level = MAX_LEVEL;

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some(&command) = tokens.first() else {
            continue;
        };
        match command {
            "uci" => {
                send("id name Chess");
                send("id author Chess");
                send("option name Hash type spin default 16 min 1 max 1024");
                send(&format!(
                    "option name Level type spin default {MAX_LEVEL} min 1 max {MAX_LEVEL}"
                ));
                send("uciok");
            }
            "isready" => send("readyok"),
            "setoption" => {
                finish(&mut search, false);
                match parse_option(&tokens[1..]) {
                    Some((name, value)) if name.eq_ignore_ascii_case("hash") => {
                        if let Ok(mb) = value.parse::<usize>() {
                            *lock(&engine) = Engine::new(mb.clamp(1, 1024));
                        }
                    }
                    Some((name, value)) if name.eq_ignore_ascii_case("level") => {
                        if let Ok(value) = value.parse::<u8>() {
                            level = value.clamp(1, MAX_LEVEL);
                        }
                    }
                    _ => {}
                }
            }
            "ucinewgame" => {
                finish(&mut search, false);
                lock(&engine).new_game();
                position = Some(Position::startpos());
                history.clear();
            }
            "position" => {
                finish(&mut search, false);
                let (p, h, error) = parse_position(&tokens[1..]);
                if let Some(error) = error {
                    send(&format!("info string {error}"));
                }
                position = p;
                history = h;
            }
            "go" => {
                finish(&mut search, false);
                let Some(position) = &position else {
                    send("info string no valid position");
                    send("bestmove 0000");
                    continue;
                };
                let params = parse_go(&tokens[1..]);
                let stop = Arc::new(AtomicBool::new(false));
                let handle = spawn_search(
                    Arc::clone(&engine),
                    position.clone(),
                    history.clone(),
                    params,
                    level,
                    Arc::clone(&stop),
                );
                search = Some((stop, handle));
            }
            "stop" => finish(&mut search, true),
            "quit" => {
                finish(&mut search, true);
                break;
            }
            _ => {}
        }
    }
    finish(&mut search, true);
}

fn lock(engine: &Mutex<Engine>) -> std::sync::MutexGuard<'_, Engine> {
    engine
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Waits for the running search; `stop` raises its flag first.
fn finish(search: &mut Option<(Arc<AtomicBool>, JoinHandle<()>)>, stop: bool) {
    if let Some((flag, handle)) = search.take() {
        if stop {
            flag.store(true, Ordering::Relaxed);
        }
        let _ = handle.join();
    }
}

fn spawn_search(
    engine: Arc<Mutex<Engine>>,
    position: Position,
    history: Vec<u64>,
    params: GoParams,
    level: u8,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        if level < MAX_LEVEL {
            let seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_nanos() as u64);
            let result = think_at_level(&mut lock(&engine), &position, &history, level, None, seed);
            let best = result
                .best_move
                .map_or_else(|| "0000".to_string(), |m| m.to_coordinate());
            send(&format!("bestmove {best}"));
            return;
        }
        let start = Instant::now();
        let budget = time_budget(&position, &params);
        if let Some(budget) = &budget {
            let timer_stop = Arc::clone(&stop);
            let hard = budget.hard;
            std::thread::spawn(move || {
                std::thread::sleep(hard);
                timer_stop.store(true, Ordering::Relaxed);
            });
        }
        let limits = EngineLimits {
            max_depth: params.depth,
            nodes: params.nodes,
            stop: Some(&stop),
        };
        let mut last_best: Option<Move> = None;
        let mut stable = 0_usize;
        let mut on_iteration = |info: &IterationInfo| {
            send(&info_line(info, start.elapsed()));
            let best = info.pv.first().copied();
            stable = if best == last_best { stable + 1 } else { 0 };
            last_best = best;
            budget
                .as_ref()
                .is_none_or(|budget| start.elapsed() < budget.soft_for_stability(stable))
        };
        let result = lock(&engine).think(&position, &history, limits, &mut on_iteration);
        let best = result
            .best_move
            .map_or_else(|| "0000".to_string(), |m| m.to_coordinate());
        send(&format!("bestmove {best}"));
    })
}

fn info_line(info: &IterationInfo, elapsed: Duration) -> String {
    let score = info.mate_in.map_or_else(
        || format!("cp {}", info.score_cp),
        |mate| format!("mate {mate}"),
    );
    let ms = elapsed.as_millis().max(1);
    let nps = u128::from(info.nodes) * 1000 / ms;
    let pv: Vec<String> = info.pv.iter().map(|m| m.to_coordinate()).collect();
    format!(
        "info depth {} seldepth {} score {score} nodes {} nps {nps} time {ms} pv {}",
        info.depth,
        info.seldepth,
        info.nodes,
        pv.join(" ")
    )
}

fn send(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{text}");
    let _ = out.flush();
}

/// `None` means search until depth/nodes/stop. Formula: soft = remaining/movestogo + 3/4 inc,
/// hard = 3 x soft, both capped so one move never spends more than a fifth of the clock.
fn time_budget(position: &Position, params: &GoParams) -> Option<TimeBudget> {
    if let Some(ms) = params.movetime {
        let ms = ms.saturating_sub(MOVE_OVERHEAD_MS).max(1);
        return Some(TimeBudget {
            soft: Duration::from_millis(ms),
            hard: Duration::from_millis(ms),
        });
    }
    let (time, inc) = if position.side_to_move() == Color::White {
        (params.wtime, params.winc)
    } else {
        (params.btime, params.binc)
    };
    let remaining = time?.saturating_sub(MOVE_OVERHEAD_MS).max(1);
    let moves_to_go = params.movestogo.map_or(25, |m| m.clamp(1, 25));
    let cap = remaining / 5;
    let soft = (remaining / moves_to_go + inc * 3 / 4).min(cap).max(1);
    let hard = (soft * 3).min(cap).max(soft);
    Some(TimeBudget {
        soft: Duration::from_millis(soft),
        hard: Duration::from_millis(hard),
    })
}

fn parse_option<'a>(tokens: &[&'a str]) -> Option<(String, &'a str)> {
    let name = tokens.iter().position(|t| *t == "name")?;
    let value = tokens.iter().position(|t| *t == "value")?;
    Some((
        tokens.get(name + 1..value)?.join(" "),
        tokens.get(value + 1)?,
    ))
}

fn parse_go(tokens: &[&str]) -> GoParams {
    let mut params = GoParams::default();
    let mut i = 0;
    while i < tokens.len() {
        let value = tokens.get(i + 1).and_then(|v| v.parse::<i64>().ok());
        let unsigned = value.map(|v| v.max(0).unsigned_abs());
        match tokens[i] {
            "wtime" => params.wtime = unsigned,
            "btime" => params.btime = unsigned,
            "winc" => params.winc = unsigned.unwrap_or(0),
            "binc" => params.binc = unsigned.unwrap_or(0),
            "movestogo" => params.movestogo = unsigned,
            "movetime" => params.movetime = unsigned,
            "depth" => params.depth = unsigned.map(|v| v.min(u64::from(u8::MAX)) as u8),
            "nodes" => params.nodes = unsigned,
            _ => {
                i += 1;
                continue;
            }
        }
        i += 2;
    }
    params
}

/// Never keeps the previous position. A bad setup gives no position; moves apply up to the first
/// illegal one, as reference UCI engines do. The error, if any, is reported to the GUI.
fn parse_position(tokens: &[&str]) -> (Option<Position>, Vec<u64>, Option<String>) {
    let moves_at = tokens.iter().position(|t| *t == "moves");
    let setup = &tokens[..moves_at.unwrap_or(tokens.len())];
    let mut position = match setup.first().copied() {
        Some("startpos") => Position::startpos(),
        Some("fen") => match Position::from_fen(&setup[1..].join(" ")) {
            Ok(position) => position,
            Err(_) => return (None, Vec::new(), Some("invalid fen".to_string())),
        },
        _ => {
            return (
                None,
                Vec::new(),
                Some("invalid position command".to_string()),
            );
        }
    };
    let mut history = Vec::new();
    for text in moves_at.map_or(&[][..], |at| &tokens[at + 1..]) {
        let legal = Move::from_coordinate(text)
            .ok()
            .and_then(|mv| position.legal_moves().ok()?.into_iter().find(|m| *m == mv));
        let Some(next) = legal.and_then(|mv| position.after_known_legal_move(mv).ok()) else {
            return (
                Some(position),
                history,
                Some(format!("illegal move {text}, stopped before it")),
            );
        };
        history.push(position.zobrist_hash());
        position = next;
    }
    (Some(position), history, None)
}
