#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_STOCKFISH = "/opt/homebrew/bin/stockfish";
export const DEFAULT_CARGO = `${process.env.HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo`;
export const CLI = "target/release/chess-cli";
export const PHASES = ["opening", "middlegame", "endgame"];

export const OPENINGS = [
  ["Start position", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"],
  ["Ruy Lopez", "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"],
  ["Queen's Gambit", "rnbqkbnr/ppp2ppp/4p3/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3"],
  ["Sicilian Open", "rnbqkbnr/pp2pppp/3p4/8/3NP3/8/PPP2PPP/RNBQKB1R b KQkq - 0 3"],
  ["French Advance", "rnbqkbnr/ppp2ppp/4p3/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3"],
  ["Caro-Kann", "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR b KQkq - 1 3"],
  ["English", "rnbqkb1r/pppp1ppp/5n2/4p3/2P5/2N3P1/PP1PPP1P/R1BQKBNR b KQkq - 0 3"],
  ["King's Indian", "rnbqk2r/ppp1ppbp/3p1np1/8/2PPP3/2N5/PP3PPP/R1BQKBNR w KQkq - 0 5"],
];

const MATERIAL_VALUES = new Map([
  ["Q", 9],
  ["R", 5],
  ["B", 3],
  ["N", 3],
]);

export function nonPawnMaterial(fen) {
  const [placement] = fen.split(" ");
  let total = 0;
  for (const piece of placement) {
    total += MATERIAL_VALUES.get(piece.toUpperCase()) ?? 0;
  }
  return total;
}

export function phaseForFen(fen, ply) {
  if (!Number.isInteger(ply) || ply < 1) throw new Error(`invalid ply for phase classification: ${ply}`);
  if (nonPawnMaterial(fen) <= 13) return "endgame";
  return ply <= 20 ? "opening" : "middlegame";
}

export function scoreCp(score) {
  const cp = score.kind === "mate" ? Math.sign(score.value || 1) * 10000 : score.value;
  return Math.max(-10000, Math.min(10000, cp));
}

export function moverScoreAfter(evalAfterFromNextSide, afterBestMove = undefined) {
  if (afterBestMove === null && evalAfterFromNextSide.kind === "mate") return 10000;
  return -scoreCp(evalAfterFromNextSide);
}

export function lossCp(evalBefore, evalAfterFromNextSide, afterBestMove = undefined) {
  return Math.max(0, scoreCp(evalBefore) - moverScoreAfter(evalAfterFromNextSide, afterBestMove));
}

// When the engine plays the judge's own best move, any measured loss is judge
// self-disagreement (two searches of adjacent positions), not an engine error.
export function moveLoss(evalBefore, evalAfterFromNextSide, engineMove, judgeBest, afterBestMove = undefined) {
  const rawLossCp = lossCp(evalBefore, evalAfterFromNextSide, afterBestMove);
  const matchedJudgeBest = engineMove === judgeBest;
  return { rawLossCp, matchedJudgeBest, lossCp: matchedJudgeBest ? 0 : rawLossCp };
}

export function classifyLoss(loss) {
  if (loss >= 200) return "blunder";
  if (loss >= 100) return "mistake";
  if (loss >= 50) return "inaccuracy";
  return "ok";
}

function summarizePhaseMoves(moves) {
  const capped = moves.reduce((sum, m) => sum + Math.min(1000, m.lossCp), 0);
  return {
    movesScored: moves.length,
    acpl: moves.length === 0 ? 0 : Number((capped / moves.length).toFixed(2)),
    blunders: moves.filter((m) => m.classification === "blunder").length,
  };
}

export function phaseSummaries(moves) {
  return Object.fromEntries(PHASES.map((phase) => [phase, summarizePhaseMoves(moves.filter((m) => m.phase === phase))]));
}

export function shapeReport(config, gameSummaries, moves) {
  const shapedMoves = moves.map((m) => ({ ...m, phase: m.phase ?? phaseForFen(m.fen, m.ply) }));
  const capped = shapedMoves.reduce((sum, m) => sum + Math.min(1000, m.lossCp), 0);
  const summary = {
    config,
    games: gameSummaries.length,
    movesScored: shapedMoves.length,
    acpl: shapedMoves.length === 0 ? 0 : Number((capped / shapedMoves.length).toFixed(2)),
    blunders: shapedMoves.filter((m) => m.classification === "blunder").length,
    mistakes: shapedMoves.filter((m) => m.classification === "mistake").length,
    inaccuracies: shapedMoves.filter((m) => m.classification === "inaccuracy").length,
    phases: phaseSummaries(shapedMoves),
  };
  summary.movesPerBlunder = summary.blunders === 0 ? null : Number((shapedMoves.length / summary.blunders).toFixed(2));
  summary.judgeBestMatches = shapedMoves.filter((m) => m.matchedJudgeBest).length;
  return {
    tool: "quality-gauntlet",
    summary,
    games: gameSummaries,
    moves: shapedMoves,
    worstPositions: [...shapedMoves].sort((a, b) => b.lossCp - a.lossCp).slice(0, 8),
  };
}

function parseArgs(argv) {
  const cfg = {
    games: 4,
    budget: 60000,
    mode: "aggressive",
    opponentElo: 1600,
    judgeDepth: 18,
    maxPlies: 140,
    out: resolve(tmpdir(), `chess-quality-gauntlet-${Date.now()}.json`),
    stockfish: DEFAULT_STOCKFISH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i], v = argv[i + 1];
    if (["--games", "--budget", "--opponent-elo", "--judge-depth", "--max-plies", "--out", "--stockfish"].includes(a)) {
      if (!v || v.startsWith("--")) throw new Error(`missing value for ${a}`);
      if (a === "--games") cfg.games = Number.parseInt(v, 10);
      if (a === "--budget") cfg.budget = Number.parseInt(v, 10);
      if (a === "--opponent-elo") cfg.opponentElo = Number.parseInt(v, 10);
      if (a === "--judge-depth") cfg.judgeDepth = Number.parseInt(v, 10);
      if (a === "--max-plies") cfg.maxPlies = Number.parseInt(v, 10);
      if (a === "--out") cfg.out = resolve(v);
      if (a === "--stockfish") cfg.stockfish = resolve(v);
      i += 1;
    } else if (a === "--aggressive") cfg.mode = "aggressive";
    else if (a === "--neutral") cfg.mode = "neutral";
    else throw new Error(`unknown flag ${a}`);
  }
  for (const k of ["games", "budget", "opponentElo", "judgeDepth", "maxPlies"]) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < 1) throw new Error(`${k} must be a positive integer`);
  }
  return cfg;
}

export class Uci {
  constructor(path) {
    this.path = path;
    this.lines = [];
    this.proc = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (c) => String(c).split(/\r?\n/).filter(Boolean).forEach((l) => this.lines.push(l)));
    this.proc.stderr.on("data", (c) => process.stderr.write(c));
  }
  send(cmd) { this.proc.stdin.write(`${cmd}\n`); }
  wait(match, from = this.lines.length, ms = 30000) {
    return new Promise((resolveWait, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        for (let i = from; i < this.lines.length; i += 1) if (match(this.lines[i])) { clearInterval(timer); resolveWait({ line: this.lines[i], to: this.lines.length }); return; }
        if (Date.now() - start > ms) { clearInterval(timer); reject(new Error(`timeout waiting for ${this.path}`)); }
      }, 10);
    });
  }
  async init(options = []) {
    let at = this.lines.length; this.send("uci"); ({ to: at } = await this.wait((l) => l === "uciok", at));
    for (const [name, value] of options) this.send(`setoption name ${name} value ${value}`);
    this.send("isready"); await this.wait((l) => l === "readyok", at);
  }
  async bestMove(fen, command) {
    const at = this.lines.length;
    this.send(`position fen ${fen}`);
    this.send(command);
    const { line, to } = await this.wait((l) => l.startsWith("bestmove "), at, 60000);
    return { move: line.split(/\s+/)[1], lines: this.lines.slice(at, to) };
  }
  async fenAfter(fen, move) {
    const at = this.lines.length;
    this.send(`position fen ${fen} moves ${move}`);
    this.send("d");
    const { line } = await this.wait((l) => l.startsWith("Fen: "), at);
    return line.slice(5);
  }
  async judge(fen, depth) {
    const result = await this.bestMove(fen, `go depth ${depth}`);
    let score = null, pv = null, seenDepth = null, nodes = null;
    for (const line of result.lines) {
      const s = line.match(/\bscore (cp|mate) (-?\d+)/);
      if (s) score = { kind: s[1], value: Number.parseInt(s[2], 10) };
      const d = line.match(/\bdepth (\d+)/); if (d) seenDepth = Number.parseInt(d[1], 10);
      const n = line.match(/\bnodes (\d+)/); if (n) nodes = Number.parseInt(n[1], 10);
      const p = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/); if (p) pv = p[1];
    }
    if (!score) throw new Error(`judge produced no score for ${fen}`);
    return { score, bestMove: result.move === "(none)" ? pv : result.move, depth: seenDepth, nodes };
  }
  quit() { this.send("quit"); }
}

export function ensurePrereqs(cfg) {
  if (!existsSync(cfg.stockfish)) throw new Error(`Stockfish not found at ${cfg.stockfish}; install it manually, never by this tool`);
  if (existsSync(CLI)) return;
  const cargo = process.env.CARGO ?? (existsSync(DEFAULT_CARGO) ? DEFAULT_CARGO : "cargo");
  const version = spawnSync(cargo, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) throw new Error(`release chess-cli is missing and cargo is unavailable at ${cargo}`);
  const build = spawnSync(cargo, ["build", "--release", "-p", "chess-cli"], { stdio: "inherit" });
  if (build.status !== 0) throw new Error("cargo build --release -p chess-cli failed");
}

export function engineMove(fen, cfg) {
  const args = ["best-move", "--fen", fen, "--budget", String(cfg.budget)];
  if (cfg.mode === "aggressive") args.push("--aggressive");
  const run = spawnSync(CLI, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (run.status !== 0) {
    throw new Error(`chess-cli failed: ${run.stderr.trim()}`);
  }
  return JSON.parse(run.stdout);
}

async function runGame(index, cfg, opponent, judge) {
  const [openingName, openingFen] = OPENINGS[index % OPENINGS.length];
  const engineFenColor = index % 2 === 0 ? "w" : "b";
  const engineColor = engineFenColor === "w" ? "white" : "black";
  let fen = openingFen;
  const moves = [];
  for (let ply = 1; ply <= cfg.maxPlies; ply += 1) {
    if (fen.split(" ")[1] === engineFenColor) {
      const before = await judge.judge(fen, cfg.judgeDepth);
      const engine = engineMove(fen, cfg);
      if (!engine.best_move) break;
      const nextFen = await judge.fenAfter(fen, engine.best_move);
      const after = await judge.judge(nextFen, cfg.judgeDepth);
      const loss = moveLoss(before.score, after.score, engine.best_move, before.bestMove, after.bestMove);
      moves.push({
        game: index + 1, ply, opening: openingName, engineColor, fen, engineMove: engine.best_move,
        sfBest: before.bestMove, evalBefore: scoreCp(before.score), evalAfter: moverScoreAfter(after.score, after.bestMove),
        lossCp: loss.lossCp, rawLossCp: loss.rawLossCp, matchedJudgeBest: loss.matchedJudgeBest,
        classification: classifyLoss(loss.lossCp), depth: engine.depth ?? null,
        nodes: engine.nodes ?? null, degraded: Boolean(engine.degraded),
      });
      fen = nextFen;
    } else {
      const { move } = await opponent.bestMove(fen, "go movetime 300");
      if (!move || move === "0000" || move === "(none)") break;
      fen = await opponent.fenAfter(fen, move);
    }
  }
  return { game: index + 1, opening: openingName, engineColor, startFen: openingFen, finalFen: fen, plies: cfg.maxPlies, moves };
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  ensurePrereqs(cfg);
  const opponent = new Uci(cfg.stockfish), judge = new Uci(cfg.stockfish);
  await opponent.init([["UCI_LimitStrength", "true"], ["UCI_Elo", String(cfg.opponentElo)]]);
  await judge.init();
  const games = [], moves = [];
  try {
    for (let i = 0; i < cfg.games; i += 1) {
      console.error(`quality-gauntlet: game ${i + 1}/${cfg.games}`);
      const game = await runGame(i, cfg, opponent, judge);
      moves.push(...game.moves);
      delete game.moves;
      games.push(game);
    }
  } finally {
    opponent.quit(); judge.quit();
  }
  const config = { ...cfg, openingSchedule: OPENINGS.map(([name, fen]) => ({ name, fen })) };
  const report = shapeReport(config, games, moves);
  mkdirSync(dirname(cfg.out), { recursive: true });
  writeFileSync(cfg.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report=${cfg.out}`);
  console.log(`moves=${report.summary.movesScored} acpl=${report.summary.acpl} blunders=${report.summary.blunders} moves_per_blunder=${report.summary.movesPerBlunder ?? "none"}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
}
