import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyEligibleMove,
  assertCandidateAcceptance,
  candidateRecords,
  hasExactIdentity,
  isProjectedOffTurn,
  parseArgs,
  replayEvents
} from "./replay-evidence-trust.mjs";

const buildSha = "candidate-build";
const wasmSha256 = "a".repeat(64);
const identity = { buildSha, wasmSha256 };
const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function withEvidence(lines, callback) {
  const root = mkdtempSync(join(tmpdir(), "replay-evidence-trust-test-"));
  const path = join(root, "evidence.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  try {
    callback(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function recommendation(overrides = {}) {
  return {
    type: "recommendation",
    seq: 1,
    buildSha,
    wasmSha256,
    fenBefore: startFen,
    userSide: "white",
    primaryRenderState: "recommended",
    candidates: [{ move: "e2e4", scoreCp: 20, sound: true, rank: 1 }],
    ...overrides
  };
}

test("expect-zero requires the complete exact artifact identity", () => {
  assert.throws(() => parseArgs(["--expect-zero"]), /requires an exact candidate artifact identity/u);
  assert.throws(
    () => parseArgs(["--candidate-build-sha", buildSha]),
    /requires both --candidate-build-sha and --candidate-wasm-sha256/u
  );
  assert.throws(
    () => parseArgs(["--candidate-build-sha", buildSha, "--candidate-wasm-sha256", "ABC"]),
    /64 lowercase hex/u
  );
  const parsed = parseArgs([
    "--expect-zero",
    "--candidate-build-sha",
    buildSha,
    "--candidate-wasm-sha256",
    wasmSha256
  ]);
  assert.deepEqual(parsed.candidateIdentity, identity);
});

test("exact identity requires both build and served WASM hashes", () => {
  assert.equal(hasExactIdentity({ buildSha, wasmSha256 }, identity), true);
  assert.equal(hasExactIdentity({ buildSha, wasmSha256: "b".repeat(64) }, identity), false);
  assert.equal(hasExactIdentity({ buildSha }, identity), false);
});

test("sound=false recommended candidates never certify or enter followed state", () => {
  const records = candidateRecords(
    recommendation({
      candidates: [
        { move: "e2e4", scoreCp: 200, sound: false, rank: 1 },
        { move: "d2d4", scoreCp: 10, sound: true, rank: 2 }
      ]
    })
  );
  assert.deepEqual(records.map((candidate) => candidate.move), ["d2d4"]);
});

test("candidate acceptance rejects empty, unrescored, and blundering populations", () => {
  assert.throws(
    () => assertCandidateAcceptance({ candidateRecommendationRows: 0, candidateRescoredCandidates: 0, candidateCertifiedBlunders: 0 }),
    /zero replayable recommendation rows/u
  );
  assert.throws(
    () => assertCandidateAcceptance({ candidateRecommendationRows: 1, candidateRescoredCandidates: 0, candidateCertifiedBlunders: 0 }),
    /zero rescored eligible candidates/u
  );
  assert.throws(
    () => assertCandidateAcceptance({ candidateRecommendationRows: 1, candidateRescoredCandidates: 1, candidateCertifiedBlunders: 1 }),
    /contains certified blunders/u
  );
  assert.doesNotThrow(() =>
    assertCandidateAcceptance({ candidateRecommendationRows: 1, candidateRescoredCandidates: 1, candidateCertifiedBlunders: 0 })
  );
});

test("malformed JSON and malformed selected sound candidates fail explicitly", () => {
  withEvidence(["{"], (path) => {
    assert.throws(() => replayEvents(path, identity), /malformed JSON/u);
  });
  withEvidence(
    [JSON.stringify(recommendation({ candidates: [{ move: null, scoreCp: 0, sound: true }] }))],
    (path) => {
      assert.throws(() => replayEvents(path, identity), /selected sound candidate is malformed/u);
    }
  );
});

test("malformed selected row envelopes fail before diagnostic skipping", () => {
  withEvidence([JSON.stringify(recommendation({ type: "unknown" }))], (path) => {
    assert.throws(() => replayEvents(path, identity), /selected row has unsupported type/u);
  });
  withEvidence([JSON.stringify(recommendation({ type: "move" }))], (path) => {
    assert.throws(() => replayEvents(path, identity), /selected move missing move/u);
  });
  withEvidence([JSON.stringify(recommendation({ type: "move", move: 12 }))], (path) => {
    assert.throws(() => replayEvents(path, identity), /selected move missing move/u);
  });
});

test("malformed unselected rows remain diagnostic", () => {
  const malformedHistorical = recommendation({
    type: "unknown",
    wasmSha256: "b".repeat(64)
  });
  withEvidence([JSON.stringify(malformedHistorical)], (path) => {
    assert.deepEqual(replayEvents(path, identity), []);
  });
});

test("selection is exact and projected off-turn rows are explicit", () => {
  const historical = recommendation({ seq: 1, wasmSha256: "b".repeat(64) });
  const selected = recommendation({ seq: 2, userSide: "black" });
  withEvidence([JSON.stringify(historical), JSON.stringify(selected)], (path) => {
    const rows = replayEvents(path, identity);
    assert.deepEqual(rows.map((row) => row.selected), [false, true]);
    assert.equal(isProjectedOffTurn(rows[0]), false);
    assert.equal(isProjectedOffTurn(rows[1]), true);
  });
});

test("illegal selected eligible moves fail instead of being skipped", () => {
  const row = { selected: true, line: 7, fenBefore: startFen };
  const wasm = { make_move_json: () => JSON.stringify({ ok: false }) };
  assert.throws(
    () => applyEligibleMove(wasm, row, { move: "e2e5" }, "/tmp/evidence.jsonl"),
    /selected eligible candidate is illegal/u
  );
});
