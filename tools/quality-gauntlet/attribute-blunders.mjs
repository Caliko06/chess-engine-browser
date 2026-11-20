#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_STOCKFISH,
  Uci,
  classifyLoss,
  engineMove,
  ensurePrereqs,
  moveLoss,
  moverScoreAfter,
  scoreCp,
} from "./run-quality-gauntlet.mjs";

export const ATTRIBUTION_BUDGETS = [60000, 240000, 960000];

function parseArgs(argv) {
  const cfg = {
    report: null,
    stockfish: null,
    judgeDepth: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i], v = argv[i + 1];
    if (["--report", "--stockfish", "--judge-depth"].includes(a)) {
      if (!v || v.startsWith("--")) throw new Error(`missing value for ${a}`);
      if (a === "--report") cfg.report = resolve(v);
      if (a === "--stockfish") cfg.stockfish = resolve(v);
      if (a === "--judge-depth") cfg.judgeDepth = Number.parseInt(v, 10);
      i += 1;
    } else {
      throw new Error(`unknown flag ${a}`);
    }
  }
  if (!cfg.report) throw new Error("missing --report <quality-gauntlet JSON>");
  if (cfg.judgeDepth !== null && (!Number.isInteger(cfg.judgeDepth) || cfg.judgeDepth < 1)) {
    throw new Error("judgeDepth must be a positive integer");
  }
  return cfg;
}

export function attributionOutputPath(reportPath) {
  return `${resolve(reportPath)}.attribution.json`;
}

export function attributionCandidates(report) {
  return (report.moves ?? []).filter((move) => move.classification === "blunder" && Math.abs(move.evalBefore) < 600);
}

export function classifyAttribution(lossAt960k) {
  return lossAt960k < 100 ? "horizon" : "eval-bound";
}

export function summarizeAttribution(rows) {
  return {
    horizon: rows.filter((row) => row.class === "horizon").length,
    evalBound: rows.filter((row) => row.class === "eval-bound").length,
  };
}

function reportConfig(report) {
  return report.summary?.config ?? report.config ?? {};
}

function resolveRunConfig(cliCfg, report) {
  const cfg = reportConfig(report);
  return {
    judgeDepth: cliCfg.judgeDepth ?? cfg.judgeDepth,
    stockfish: cliCfg.stockfish ?? cfg.stockfish ?? DEFAULT_STOCKFISH,
    mode: cfg.mode ?? "aggressive",
  };
}

async function attributePosition(move, cfg, judge) {
  const before = await judge.judge(move.fen, cfg.judgeDepth);
  const curve = [];
  for (const budget of ATTRIBUTION_BUDGETS) {
    const engine = engineMove(move.fen, { mode: cfg.mode, budget });
    if (!engine.best_move) throw new Error(`chess-cli returned no best_move for game ${move.game} ply ${move.ply}`);
    const nextFen = await judge.fenAfter(move.fen, engine.best_move);
    const after = await judge.judge(nextFen, cfg.judgeDepth);
    curve.push(attributionCurveEntry({ budget, engine, before, after }));
  }
  const last = curve[curve.length - 1];
  return {
    game: move.game,
    ply: move.ply,
    phase: move.phase ?? null,
    fen: move.fen,
    originalEngineMove: move.engineMove,
    originalLossCp: move.lossCp,
    originalEvalBefore: move.evalBefore,
    curve,
    class: classifyAttribution(last.lossCp),
  };
}

export function attributionCurveEntry({ budget, engine, before, after }) {
  const loss = moveLoss(before.score, after.score, engine.best_move, before.bestMove, after.bestMove);
  return {
    budget,
    engineMove: engine.best_move,
    sfBest: before.bestMove,
    evalBefore: scoreCp(before.score),
    evalAfter: moverScoreAfter(after.score, after.bestMove),
    lossCp: loss.lossCp,
    rawLossCp: loss.rawLossCp,
    matchedJudgeBest: loss.matchedJudgeBest,
    classification: classifyLoss(loss.lossCp),
    depth: engine.depth ?? null,
    nodes: engine.nodes ?? null,
    degraded: Boolean(engine.degraded),
  };
}

export async function attributeReport(report, cfg) {
  if (!Number.isInteger(cfg.judgeDepth) || cfg.judgeDepth < 1) throw new Error("judgeDepth must be available from --judge-depth or the report config");
  ensurePrereqs({ stockfish: cfg.stockfish });
  const judge = new Uci(cfg.stockfish);
  await judge.init();
  const rows = [];
  try {
    for (const move of attributionCandidates(report)) {
      rows.push(await attributePosition(move, cfg, judge));
    }
  } finally {
    judge.quit();
  }
  return {
    tool: "quality-attribution",
    inputReport: null,
    config: { judgeDepth: cfg.judgeDepth, stockfish: cfg.stockfish, mode: cfg.mode, budgets: ATTRIBUTION_BUDGETS },
    summary: summarizeAttribution(rows),
    positions: rows,
  };
}

async function main() {
  const cliCfg = parseArgs(process.argv.slice(2));
  const report = JSON.parse(readFileSync(cliCfg.report, "utf8"));
  const cfg = resolveRunConfig(cliCfg, report);
  const attribution = await attributeReport(report, cfg);
  attribution.inputReport = cliCfg.report;
  const out = attributionOutputPath(cliCfg.report);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(attribution, null, 2)}\n`);
  console.table(attribution.positions.map((row) => ({
    game: row.game,
    ply: row.ply,
    phase: row.phase,
    originalLossCp: row.originalLossCp,
    loss60k: row.curve[0].lossCp,
    loss240k: row.curve[1].lossCp,
    loss960k: row.curve[2].lossCp,
    class: row.class,
  })));
  console.log(`report=${out}`);
  console.log(`horizon=${attribution.summary.horizon} eval_bound=${attribution.summary.evalBound}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
}
