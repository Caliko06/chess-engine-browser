//! Offline Texel tuner, using no external crates. Labels are White's game result.
//! See www.chessprogramming.org/Texel%27s_Tuning_Method and the sparse
//! analytic-gradient approach in Weiss/Blunder. Unlike runtime evaluation, the
//! tuner may allocate and read/write files. It never downloads data itself.

use chess_board::{Move, Position};
use chess_eval::tapered::{
    DEFAULT_PARAMS, EvalParams, MAX_PHASE, PARAM_COUNT, SCALE_NORMAL, START_PARAMS,
    evaluate_tapered, trace,
};
use std::error::Error;
use std::fmt::Write as _;
use std::fs::File;
use std::hint::black_box;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::time::Instant;

const WEIGHTS: usize = PARAM_COUNT * 2;
type Weights = [f64; WEIGHTS];

struct Options {
    input: PathBuf,
    output: Option<PathBuf>,
    epochs: usize,
    limit: usize,
    threads: usize,
    rate: f64,
    bench: usize,
    start_default: bool,
    lambda: f64,
    label_k: f64,
}

impl Options {
    fn parse() -> Result<Self, Box<dyn Error>> {
        let mut args = std::env::args().skip(1);
        let input = args.next().ok_or("usage: chess-tuner DATASET [--epochs 300] [--limit 1000000] [--threads 4] [--rate 1] [--bench 1000000] [--output FILE] [--start-default] [--lambda 0..1] [--label-k 1.523]")?;
        let mut options = Self {
            input: input.into(),
            output: None,
            epochs: 300,
            limit: usize::MAX,
            threads: std::thread::available_parallelism()
                .map_or(1, usize::from)
                .min(8),
            rate: 1.0,
            bench: 1_000_000,
            start_default: false,
            lambda: 0.0,
            label_k: 1.523,
        };
        while let Some(flag) = args.next() {
            if flag == "--start-default" {
                options.start_default = true;
                continue;
            }
            let value = args
                .next()
                .ok_or_else(|| format!("missing value for {flag}"))?;
            match flag.as_str() {
                "--epochs" => options.epochs = value.parse()?,
                "--limit" => options.limit = value.parse()?,
                "--threads" => options.threads = value.parse()?,
                "--rate" => options.rate = value.parse()?,
                "--bench" => options.bench = value.parse()?,
                "--output" => options.output = Some(value.into()),
                "--lambda" => options.lambda = value.parse()?,
                "--label-k" => options.label_k = value.parse()?,
                _ => return Err(format!("unknown option {flag}").into()),
            }
        }
        if options.threads == 0
            || options.limit < 10
            || !options.rate.is_finite()
            || options.rate <= 0.0
            || !(0.0..=1.0).contains(&options.lambda)
        {
            return Err("threads must be positive, limit >= 10, rate finite and positive".into());
        }
        Ok(options)
    }
}

#[derive(Clone, Copy)]
struct Coefficient {
    index: u16,
    count: i16,
}

struct Entry {
    start: usize,
    len: usize,
    phase: f64,
    /// Endgame weight: the trace's scale factor over 128.
    eg_weight: f64,
    result: f64,
    validation: bool,
}

struct Dataset {
    entries: Vec<Entry>,
    coefficients: Vec<Coefficient>,
    benchmark: Vec<Position>,
}

/// Full FEN or four-field EPD; accepted labels: c9 "1-0"/"0-1"/"1/2-1/2",
/// bracketed [1.0]/[0.0]/[0.5], or FenGen's outcome:1.0 etc. No bare score is
/// interpreted as a result and labels are never flipped for Black to move. An optional
/// `score:<cp>` is the generating search's White score (`chess-cli datagen`).
fn parse_record(line: &str) -> Result<(Position, f64, Option<f64>), Box<dyn Error>> {
    let tokens: Vec<_> = line.split_whitespace().collect();
    if tokens.len() < 5 {
        return Err("expected FEN/EPD and a result".into());
    }
    let numeric_clocks = tokens.get(4).is_some_and(|s| s.parse::<u32>().is_ok())
        && tokens
            .get(5)
            .is_some_and(|s| s.trim_end_matches(';').parse::<u32>().is_ok());
    let fen = if numeric_clocks {
        tokens[..6].join(" ").trim_end_matches(';').to_string()
    } else {
        format!("{} 0 1", tokens[..4].join(" "))
    };
    let label = tokens[if numeric_clocks { 6 } else { 4 }..].join(" ");
    let result = if label.contains("\"1-0\"") || label.contains("[1.0]") {
        1.0
    } else if label.contains("\"0-1\"") || label.contains("[0.0]") {
        0.0
    } else if label.contains("\"1/2-1/2\"") || label.contains("[0.5]") {
        0.5
    } else if let Some(outcome) = label.split("outcome:").nth(1) {
        let value: f64 = outcome.split(';').next().unwrap_or("").trim().parse()?;
        if ![0.0, 0.5, 1.0].contains(&value) {
            return Err("invalid outcome".into());
        }
        value
    } else {
        return Err("missing recognized White result label".into());
    };
    let score = match label.split("score:").nth(1) {
        Some(text) => Some(
            text.split_whitespace()
                .next()
                .unwrap_or("")
                .parse::<f64>()?,
        ),
        None => None,
    };
    Ok((Position::from_fen(&fen)?, result, score))
}

/// Conservative quiet filter: not in check, at least one legal move, and no
/// legal capture or promotion. Avoid fitting a static eval to unresolved tactics.
fn quiet(position: &Position, moves: &[Move]) -> bool {
    !position.is_check()
        && !moves.is_empty()
        && moves
            .iter()
            .all(|&mv| !position.is_capture(mv) && mv.promotion().is_none())
}

fn load(options: &Options) -> Result<Dataset, Box<dyn Error>> {
    let begin = Instant::now();
    let reader = BufReader::new(File::open(&options.input)?);
    let mut data = Dataset {
        entries: Vec::new(),
        coefficients: Vec::new(),
        benchmark: Vec::new(),
    };
    let (mut read, mut rejected, mut invalid) = (0, 0, 0);
    for (number, line) in reader.lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        read += 1;
        let (position, result, score) = match parse_record(&line) {
            Ok(record) => record,
            Err(error) => {
                invalid += 1;
                if invalid <= 3 {
                    eprintln!("line {} skipped: {error}", number + 1);
                }
                continue;
            }
        };
        let moves = match position.legal_moves() {
            Ok(moves) => moves,
            Err(_) => {
                invalid += 1;
                continue;
            }
        };
        if !quiet(&position, &moves) {
            rejected += 1;
            continue;
        }
        let features = trace(&position);
        let start = data.coefficients.len();
        data.coefficients.extend(
            features
                .coefficients
                .iter()
                .map(|&(index, count)| Coefficient {
                    index: index as u16,
                    count,
                }),
        );
        data.entries.push(Entry {
            start,
            len: features.coefficients.len(),
            phase: f64::from(features.phase) / f64::from(MAX_PHASE),
            eg_weight: (1.0 - f64::from(features.phase) / f64::from(MAX_PHASE))
                * f64::from(features.scale(&DEFAULT_PARAMS))
                / f64::from(SCALE_NORMAL),
            // Blend the game result with the search's own verdict when the data carries one.
            result: score.map_or(result, |cp| {
                options.lambda * sigmoid(cp, options.label_k) + (1.0 - options.lambda) * result
            }),
            validation: data.entries.len() % 10 == 0,
        });
        if data.benchmark.len() < 256 {
            data.benchmark.push(position);
        }
        if data.entries.len() == options.limit {
            break;
        }
        if read % 1_000_000 == 0 {
            eprintln!("read {read}, quiet {}", data.entries.len());
        }
    }
    if data.entries.len() < 10 {
        return Err("fewer than 10 valid quiet labeled positions".into());
    }
    eprintln!(
        "dataset={} read={read} quiet={} rejected_tactical={rejected} invalid={invalid} train={} validation={} load_s={:.3}",
        options.input.display(),
        data.entries.len(),
        data.entries.iter().filter(|e| !e.validation).count(),
        data.entries.iter().filter(|e| e.validation).count(),
        begin.elapsed().as_secs_f64()
    );
    Ok(data)
}

fn flatten(params: &EvalParams) -> Weights {
    std::array::from_fn(|i| f64::from(params.weights[i / 2][i % 2]))
}

fn round(weights: &Weights) -> EvalParams {
    EvalParams {
        weights: std::array::from_fn(|i| {
            [
                weights[i * 2].round() as i32,
                weights[i * 2 + 1].round() as i32,
            ]
        }),
    }
}

fn linear_score(entry: &Entry, coefficients: &[Coefficient], weights: &Weights) -> f64 {
    let (mut mg, mut eg) = (0.0, 0.0);
    for coefficient in &coefficients[entry.start..entry.start + entry.len] {
        let index = usize::from(coefficient.index) * 2;
        let count = f64::from(coefficient.count);
        mg += weights[index] * count;
        eg += weights[index + 1] * count;
    }
    mg * entry.phase + eg * entry.eg_weight
}

fn sigmoid(score: f64, k: f64) -> f64 {
    1.0 / (1.0 + (-k * std::f64::consts::LN_10 * score / 400.0).exp())
}

fn fit_k(data: &Dataset, weights: &Weights) -> f64 {
    let scores: Vec<_> = data
        .entries
        .iter()
        .filter(|e| !e.validation)
        .map(|e| (linear_score(e, &data.coefficients, weights), e.result))
        .collect();
    let error = |log_k: f64| -> f64 {
        let k = log_k.exp();
        scores
            .iter()
            .map(|&(score, result)| (sigmoid(score, k) - result).powi(2))
            .sum::<f64>()
            / scores.len() as f64
    };
    // Golden-section search in log(K), fitted once to the seed on training data.
    let ratio = (5f64.sqrt() - 1.0) / 2.0;
    let (mut left, mut right) = (-5.0, 3.0);
    let mut a = right - ratio * (right - left);
    let mut b = left + ratio * (right - left);
    let (mut fa, mut fb) = (error(a), error(b));
    for _ in 0..48 {
        if fa < fb {
            right = b;
            b = a;
            fb = fa;
            a = right - ratio * (right - left);
            fa = error(a);
        } else {
            left = a;
            a = b;
            fa = fb;
            b = left + ratio * (right - left);
            fb = error(b);
        }
    }
    ((left + right) / 2.0).exp()
}

struct Statistics {
    gradient: Weights,
    train_error: f64,
    validation_error: f64,
    train_count: usize,
    validation_count: usize,
}

fn statistics(
    entries: &[Entry],
    coefficients: &[Coefficient],
    weights: &Weights,
    k: f64,
    gradient: bool,
    runtime_rounding: bool,
) -> Statistics {
    let mut stats = Statistics {
        gradient: [0.0; WEIGHTS],
        train_error: 0.0,
        validation_error: 0.0,
        train_count: 0,
        validation_count: 0,
    };
    let scale = k * std::f64::consts::LN_10 / 400.0;
    for entry in entries {
        let mut score = linear_score(entry, coefficients, weights);
        if runtime_rounding {
            score = score.trunc();
        }
        let probability = sigmoid(score, k);
        let residual = probability - entry.result;
        if entry.validation {
            stats.validation_error += residual * residual;
            stats.validation_count += 1;
        } else {
            stats.train_error += residual * residual;
            stats.train_count += 1;
            if gradient {
                let derivative = 2.0 * scale * residual * probability * (1.0 - probability);
                let mg = derivative * entry.phase;
                let eg = derivative * entry.eg_weight;
                for coefficient in &coefficients[entry.start..entry.start + entry.len] {
                    let index = usize::from(coefficient.index) * 2;
                    let count = f64::from(coefficient.count);
                    stats.gradient[index] += mg * count;
                    stats.gradient[index + 1] += eg * count;
                }
            }
        }
    }
    stats
}

fn parallel_statistics(
    data: &Dataset,
    weights: &Weights,
    k: f64,
    threads: usize,
    gradient: bool,
    rounding: bool,
) -> Statistics {
    std::thread::scope(|scope| {
        let handles: Vec<_> = data
            .entries
            .chunks(data.entries.len().div_ceil(threads))
            .map(|entries| {
                scope.spawn(move || {
                    statistics(entries, &data.coefficients, weights, k, gradient, rounding)
                })
            })
            .collect();
        let mut total = Statistics {
            gradient: [0.0; WEIGHTS],
            train_error: 0.0,
            validation_error: 0.0,
            train_count: 0,
            validation_count: 0,
        };
        for handle in handles {
            let part = handle.join().expect("tuning worker panicked");
            for (dest, value) in total.gradient.iter_mut().zip(part.gradient) {
                *dest += value;
            }
            total.train_error += part.train_error;
            total.validation_error += part.validation_error;
            total.train_count += part.train_count;
            total.validation_count += part.validation_count;
        }
        for value in &mut total.gradient {
            *value /= total.train_count as f64;
        }
        total.train_error /= total.train_count as f64;
        total.validation_error /= total.validation_count as f64;
        total
    })
}

fn source(params: &EvalParams) -> String {
    let mut source =
        String::from("pub const DEFAULT_PARAMS: EvalParams = EvalParams {\n    weights: [\n");
    for (index, &[mg, eg]) in params.weights.iter().enumerate() {
        writeln!(source, "        [{mg}, {eg}], // {index}").unwrap();
    }
    source.push_str("    ],\n};\n");
    source
}

fn benchmark(data: &Dataset, iterations: usize) {
    let begin = Instant::now();
    let mut checksum = 0i64;
    for i in 0..iterations {
        checksum += i64::from(black_box(evaluate_tapered(black_box(
            &data.benchmark[i % data.benchmark.len()],
        ))));
    }
    eprintln!(
        "runtime_eval iterations={iterations} seconds={:.6} evals_per_s={:.0} checksum={checksum}",
        begin.elapsed().as_secs_f64(),
        iterations as f64 / begin.elapsed().as_secs_f64()
    );
}

fn run(options: Options) -> Result<(), Box<dyn Error>> {
    let data = load(&options)?;
    benchmark(&data, options.bench);
    let mut weights = flatten(if options.start_default {
        &DEFAULT_PARAMS
    } else {
        &START_PARAMS
    });
    let k = fit_k(&data, &weights);
    let before = parallel_statistics(&data, &weights, k, options.threads, false, true);
    eprintln!(
        "K={k:.9} before_train_mse={:.9} before_validation_mse={:.9}",
        before.train_error, before.validation_error
    );
    let (mut momentum, mut velocity) = ([0.0; WEIGHTS], [0.0; WEIGHTS]);
    let (mut best, mut best_error, mut best_epoch) = (weights, f64::INFINITY, 0);
    let (mut beta1_power, mut beta2_power) = (1.0, 1.0);
    let begin = Instant::now();
    for epoch in 0..=options.epochs {
        let stats = parallel_statistics(&data, &weights, k, options.threads, true, false);
        if stats.validation_error < best_error {
            best = weights;
            best_error = stats.validation_error;
            best_epoch = epoch;
        }
        if epoch % 10 == 0 || epoch == options.epochs {
            eprintln!(
                "epoch={epoch} train_mse={:.9} validation_mse={:.9} elapsed_s={:.1}",
                stats.train_error,
                stats.validation_error,
                begin.elapsed().as_secs_f64()
            );
        }
        if epoch == options.epochs {
            break;
        }
        beta1_power *= 0.9;
        beta2_power *= 0.999;
        for i in 0..WEIGHTS {
            let gradient = stats.gradient[i];
            momentum[i] = 0.9 * momentum[i] + 0.1 * gradient;
            velocity[i] = 0.999 * velocity[i] + 0.001 * gradient * gradient;
            let corrected_m = momentum[i] / (1.0 - beta1_power);
            let corrected_v = velocity[i] / (1.0 - beta2_power);
            weights[i] -= options.rate * corrected_m / (corrected_v.sqrt() + 1e-8);
        }
    }
    let params = round(&best);
    let after = parallel_statistics(&data, &flatten(&params), k, options.threads, false, true);
    eprintln!(
        "selected_epoch={best_epoch} rounded_train_mse={:.9} rounded_validation_mse={:.9} tuning_s={:.3}",
        after.train_error,
        after.validation_error,
        begin.elapsed().as_secs_f64()
    );
    let output = format!(
        "// Texel: K={k:.9}, quiet={}, train MSE {:.9} -> {:.9}, held-out MSE {:.9} -> {:.9}.\n{}",
        data.entries.len(),
        before.train_error,
        after.train_error,
        before.validation_error,
        after.validation_error,
        source(&params)
    );
    if let Some(path) = options.output {
        std::fs::write(path, output)?;
    } else {
        std::io::stdout().lock().write_all(output.as_bytes())?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = Options::parse().and_then(run) {
        eprintln!("chess-tuner: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_white_relative_for_both_epd_and_full_fen() {
        let epd = "4k3/8/8/8/8/8/8/4K3 b - - c9 \"1-0\";";
        assert_eq!(parse_record(epd).unwrap().1, 1.0);
        assert_eq!(
            parse_record("4k3/8/8/8/8/8/8/4K3 b - - 0 1 [0.0]")
                .unwrap()
                .1,
            0.0
        );
        assert_eq!(
            parse_record("4k3/8/8/8/8/8/8/4K3 w - - 0 1;eval:15;outcome:0.5")
                .unwrap()
                .1,
            0.5
        );
        assert!(parse_record("4k3/8/8/8/8/8/8/4K3 w - - 0 1 eval 23").is_err());
        let datagen = parse_record("4k3/8/8/8/8/8/8/4K3 b - - 0 1 [1.0] score:-35").unwrap();
        assert_eq!((datagen.1, datagen.2), (1.0, Some(-35.0)));
    }

    #[test]
    fn analytic_gradient_matches_finite_difference() {
        let position = Position::from_fen("4k3/7p/8/3P4/8/2N5/P7/4K3 w - - 0 1").unwrap();
        let traced = trace(&position);
        let coefficients: Vec<_> = traced
            .coefficients
            .iter()
            .map(|&(index, count)| Coefficient {
                index: index as u16,
                count,
            })
            .collect();
        let entries = [Entry {
            start: 0,
            len: coefficients.len(),
            phase: f64::from(traced.phase) / 24.0,
            eg_weight: (1.0 - f64::from(traced.phase) / 24.0)
                * f64::from(traced.scale(&START_PARAMS))
                / 128.0,
            result: 0.5,
            validation: false,
        }];
        let weights = flatten(&START_PARAMS);
        let stats = statistics(&entries, &coefficients, &weights, 1.1, true, false);
        for i in 0..WEIGHTS {
            let mut up = weights;
            let mut down = weights;
            up[i] += 0.01;
            down[i] -= 0.01;
            let delta = (statistics(&entries, &coefficients, &up, 1.1, false, false).train_error
                - statistics(&entries, &coefficients, &down, 1.1, false, false).train_error)
                / 0.02;
            assert!((delta - stats.gradient[i]).abs() < 1e-9, "weight {i}");
        }
    }

    #[test]
    fn quiet_filter_rejects_checks_captures_promotions_and_terminal_positions() {
        for fen in [
            "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1",
            "4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1",
            "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
            "7k/5K2/6Q1/8/8/8/8/8 b - - 0 1",
        ] {
            let position = Position::from_fen(fen).unwrap();
            assert!(!quiet(&position, &position.legal_moves().unwrap()), "{fen}");
        }
        let start = Position::startpos();
        assert!(quiet(&start, &start.legal_moves().unwrap()));
    }
}
