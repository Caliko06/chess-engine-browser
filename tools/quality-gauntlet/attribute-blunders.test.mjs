#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import {
  attributionCurveEntry,
  attributionCandidates,
  attributionOutputPath,
  classifyAttribution,
  summarizeAttribution,
} from "./attribute-blunders.mjs";

test("attribution output path is a sidecar beside the input report", () => {
  assert.equal(attributionOutputPath("/tmp/quality.json"), "/tmp/quality.json.attribution.json");
});

test("attribution candidates are neutral-ish blunders only", () => {
  const report = {
    moves: [
      { classification: "blunder", evalBefore: 599, fen: "candidate" },
      { classification: "blunder", evalBefore: 600, fen: "winning" },
      { classification: "mistake", evalBefore: 0, fen: "mistake" },
      { classification: "blunder", evalBefore: -700, fen: "losing" },
    ],
  };
  assert.deepEqual(attributionCandidates(report).map((move) => move.fen), ["candidate"]);
});

test("960k loss alone defines horizon versus eval-bound", () => {
  assert.equal(classifyAttribution(99), "horizon");
  assert.equal(classifyAttribution(100), "eval-bound");
  assert.deepEqual(summarizeAttribution([{ class: "horizon" }, { class: "eval-bound" }, { class: "eval-bound" }]), {
    horizon: 1,
    evalBound: 2,
  });
});

test("attribution curve scores delivered terminal mate from mover perspective", () => {
  const row = attributionCurveEntry({
    budget: 60000,
    engine: { best_move: "e1e8", depth: 4, nodes: 123, degraded: true },
    before: { score: { kind: "mate", value: 1 }, bestMove: "g6e8" },
    after: { score: { kind: "mate", value: 0 }, bestMove: null },
  });
  assert.equal(row.evalAfter, 10000);
  assert.equal(row.rawLossCp, 0);
  assert.equal(row.lossCp, 0);
  assert.equal(row.classification, "ok");
});
