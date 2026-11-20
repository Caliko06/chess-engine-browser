#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import { classifyLoss, lossCp, moveLoss, moverScoreAfter, phaseForFen, shapeReport } from "./run-quality-gauntlet.mjs";

test("loss computation flips the after score to mover perspective", () => {
  assert.equal(lossCp({ kind: "cp", value: 80 }, { kind: "cp", value: -20 }), 60);
  assert.equal(lossCp({ kind: "cp", value: 80 }, { kind: "cp", value: -120 }), 0);
});

test("mate scores clamp before loss computation", () => {
  assert.equal(lossCp({ kind: "mate", value: 4 }, { kind: "cp", value: 0 }), 10000);
  assert.equal(lossCp({ kind: "cp", value: 0 }, { kind: "mate", value: 3 }), 10000);
});

test("delivered terminal mate is scored from the mover perspective", () => {
  assert.equal(moverScoreAfter({ kind: "mate", value: 0 }, null), 10000);
  assert.equal(lossCp({ kind: "mate", value: 1 }, { kind: "mate", value: 0 }, null), 0);
  const delivered = moveLoss(
    { kind: "mate", value: 1 },
    { kind: "mate", value: 0 },
    "e1e8",
    "g6e8",
    null,
  );
  assert.equal(delivered.rawLossCp, 0);
  assert.equal(delivered.lossCp, 0);
});

test("playing the judge's best move never counts as a loss", () => {
  const matched = moveLoss({ kind: "cp", value: 80 }, { kind: "cp", value: 200 }, "e2e4", "e2e4");
  assert.equal(matched.matchedJudgeBest, true);
  assert.equal(matched.rawLossCp, 280);
  assert.equal(matched.lossCp, 0);
  const differed = moveLoss({ kind: "cp", value: 80 }, { kind: "cp", value: 200 }, "d2d4", "e2e4");
  assert.equal(differed.matchedJudgeBest, false);
  assert.equal(differed.lossCp, 280);
  assert.equal(differed.rawLossCp, 280);
});

test("classification thresholds match the gauntlet contract", () => {
  assert.equal(classifyLoss(49), "ok");
  assert.equal(classifyLoss(50), "inaccuracy");
  assert.equal(classifyLoss(100), "mistake");
  assert.equal(classifyLoss(200), "blunder");
});

test("phase classification follows material first, then ply", () => {
  const fullMaterial = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const bareKings = "8/8/8/8/8/8/4K3/4k3 w - - 0 1";
  assert.equal(phaseForFen(fullMaterial, 1), "opening");
  assert.equal(phaseForFen(fullMaterial, 21), "middlegame");
  assert.equal(phaseForFen(bareKings, 1), "endgame");
});

test("report shaping caps ACPL and emits phase summaries plus worst positions", () => {
  const openingFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const endgameFen = "8/8/8/8/8/8/4K3/4k3 w - - 0 1";
  const moves = [
    { lossCp: 40, classification: "ok", fen: openingFen, ply: 1 },
    { lossCp: 1200, classification: "blunder", fen: openingFen, ply: 21 },
    { lossCp: 110, classification: "mistake", fen: endgameFen, ply: 3, matchedJudgeBest: false },
    { lossCp: 0, rawLossCp: 90, classification: "ok", fen: openingFen, ply: 2, matchedJudgeBest: true },
  ];
  const report = shapeReport({ games: 1 }, [{ game: 1 }], moves);
  assert.equal(report.summary.movesScored, 4);
  assert.equal(report.summary.acpl, 287.5);
  assert.equal(report.summary.blunders, 1);
  assert.equal(report.summary.mistakes, 1);
  assert.equal(report.summary.movesPerBlunder, 4);
  assert.equal(report.summary.judgeBestMatches, 1);
  assert.deepEqual(report.moves.map((m) => m.phase), ["opening", "middlegame", "endgame", "opening"]);
  assert.deepEqual(report.summary.phases, {
    opening: { movesScored: 2, acpl: 20, blunders: 0 },
    middlegame: { movesScored: 1, acpl: 1000, blunders: 1 },
    endgame: { movesScored: 1, acpl: 110, blunders: 0 },
  });
  assert.deepEqual(report.worstPositions.map((m) => m.phase), ["middlegame", "endgame", "opening", "opening"]);
});
