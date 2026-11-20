#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analysisPathFor,
  aggregatePlayerProfile,
  degradedOracleReports,
  downloadsDir,
  importArchiveDownloads,
  importedArchiveName,
  isArchiveDownloadName,
  listAnalysisReports,
  listArchives,
  needsAnalysis,
  parseArgs,
  resolveStockfishBinary
} from "./play-memory-update.mjs";

// parseArgs
assert.deepEqual(parseArgs([]), {
  depth: 12,
  force: false,
  oracle: true,
  watch: false,
  watchSeconds: 60,
  skipVerify: false,
  importDownloads: true
});
assert.equal(parseArgs(["--no-import"]).importDownloads, false);
assert.equal(parseArgs(["--depth", "16"]).depth, 16);
assert.equal(parseArgs(["--force"]).force, true);
assert.equal(parseArgs(["--no-oracle"]).oracle, false);
assert.equal(parseArgs(["--skip-verify"]).skipVerify, true);
assert.deepEqual(
  [parseArgs(["--watch"]).watch, parseArgs(["--watch"]).watchSeconds],
  [true, 60]
);
assert.equal(parseArgs(["--watch", "30"]).watchSeconds, 30);
assert.throws(() => parseArgs(["--depth", "0"]));
assert.throws(() => parseArgs(["--watch", "1"]));
assert.throws(() => parseArgs(["--bogus"]));

// resolveStockfishBinary
const envHit = resolveStockfishBinary({ CHESS_PLAY_STOCKFISH_BIN: "/fake/sf" }, (path) => path === "/fake/sf");
assert.deepEqual(envHit, { ok: true, path: "/fake/sf", source: "env" });
const envMiss = resolveStockfishBinary({ CHESS_PLAY_STOCKFISH_BIN: "/fake/absent" }, () => false);
assert.equal(envMiss.ok, false);
const defaultHit = resolveStockfishBinary({}, (path) => path === "/opt/homebrew/bin/stockfish");
assert.deepEqual(defaultHit, { ok: true, path: "/opt/homebrew/bin/stockfish", source: "default-path" });

// listArchives / analysisPathFor / needsAnalysis over a real temp dir
const dir = mkdtempSync(join(tmpdir(), "play-memory-test-"));
try {
  writeFileSync(join(dir, "a-games.json"), "{}");
  writeFileSync(join(dir, "b-games.jsonl"), "{}");
  writeFileSync(join(dir, "a-games.analysis.json"), "{}");
  writeFileSync(join(dir, "README.md"), "docs");
  writeFileSync(join(dir, "last-update-report.json"), "{}");

  const archives = listArchives(dir);
  assert.deepEqual(archives.map((archive) => archive.name), ["a-games.json", "b-games.jsonl"]);
  assert.deepEqual(listAnalysisReports(dir).map((report) => report.name), ["a-games.analysis.json"]);

  assert.equal(analysisPathFor(join(dir, "a-games.json")), join(dir, "a-games.analysis.json"));
  assert.equal(analysisPathFor(join(dir, "b-games.jsonl")), join(dir, "b-games.analysis.json"));

  const [archiveA, archiveB] = archives;
  // analysis exists and is newer -> no work
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(dir, "a-games.analysis.json"), future, future);
  assert.equal(needsAnalysis({ ...archiveA, mtimeMs: Date.now() }, false), false);
  // stale analysis -> work
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(dir, "a-games.analysis.json"), past, past);
  assert.equal(needsAnalysis({ ...archiveA, mtimeMs: Date.now() }, false), true);
  // force overrides freshness
  utimesSync(join(dir, "a-games.analysis.json"), future, future);
  assert.equal(needsAnalysis({ ...archiveA, mtimeMs: Date.now() }, true), true);
  // missing analysis -> work
  assert.equal(needsAnalysis(archiveB, false), true);

  assert.deepEqual(listArchives(join(dir, "does-not-exist")), []);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// downloads import helpers
assert.equal(downloadsDir({ CHESS_PLAY_ARCHIVE_DOWNLOADS: "/x/dl" }), "/x/dl");
assert.ok(downloadsDir({}).endsWith("/Downloads"));
assert.equal(isArchiveDownloadName("play-game-archive.jsonl"), true);
assert.equal(isArchiveDownloadName("play-game-archive (3).jsonl"), true);
assert.equal(isArchiveDownloadName("play-game-archive.json"), true);
assert.equal(isArchiveDownloadName("other.jsonl"), false);
assert.equal(isArchiveDownloadName("play-game-archive.jsonl.txt"), false);
assert.equal(importedArchiveName("abcdef0123456789", "jsonl"), "imported-abcdef012345.jsonl");
assert.deepEqual(
  degradedOracleReports(["ok.json", "bad.json"], {
    readFileSync: (path) => JSON.stringify(
      path === "bad.json"
        ? { oracle: { status: "degraded", coverage: { unavailablePlies: 7 } } }
        : { oracle: { status: "enabled", coverage: { unavailablePlies: 0 } } }
    )
  }),
  [{ path: "bad.json", unavailablePlies: 7 }]
);

const profileReportA = join(tmpdir(), "play-memory-profile-a.json");
const profileReportB = join(tmpdir(), "play-memory-profile-b.json");
const profileReports = new Map([
  [profileReportA, {
    understanding: { acceptedGames: 1, quarantinedGames: 0 },
    oracle: { status: "enabled", coverage: { unavailablePlies: 0 } },
    games: [{
      id: "game-a",
      selectedSide: "white",
      plies: 4,
      userPlies: 2,
      labels: [
        {
          ply: 2,
          role: "user",
          side: "white",
          move: "d1d3",
          positionKey: "fen-a w",
          kind: "oracle-move-delta",
          severity: "fail",
          detail: { deltaCp: -200, qualityBand: "mistake", deltaClass: "centipawn" }
        },
        {
          ply: 3,
          role: "rival",
          side: "black",
          move: "g8f6",
          positionKey: "fen-b b",
          kind: "oracle-move-delta",
          severity: "fail",
          detail: { deltaCp: -300, qualityBand: "blunder", deltaClass: "centipawn" }
        }
      ]
    }]
  }],
  [profileReportB, {
    understanding: { acceptedGames: 1, quarantinedGames: 1 },
    oracle: { status: "degraded", coverage: { unavailablePlies: 1 } },
    games: [{
      id: "game-b",
      selectedSide: "white",
      plies: 3,
      userPlies: 1,
      labels: [
        {
          ply: 2,
          role: "user",
          side: "white",
          move: "d1d3",
          positionKey: "fen-a w",
          kind: "oracle-move-delta",
          severity: "fail",
          detail: { deltaCp: -100, qualityBand: "inaccuracy", deltaClass: "centipawn" }
        },
        {
          ply: 3,
          role: "user",
          side: "white",
          move: "e1d2",
          positionKey: "fen-c w",
          kind: "oracle-move-delta",
          severity: "fail",
          detail: { deltaCp: -90000, qualityBand: "mate-transition", deltaClass: "mate-transition" }
        }
      ]
    }]
  }]
]);
const profile = aggregatePlayerProfile([profileReportA, profileReportB], {
  readFileSync: (path) => JSON.stringify(profileReports.get(path))
});
assert.equal(profile.status, "consultive-only");
assert.equal(profile.acceptedGames, 2);
assert.equal(profile.quarantinedGames, 1);
assert.equal(profile.userPlies, 3);
assert.equal(profile.failLabels, 3);
assert.deepEqual(profile.oracle, {
  status: "degraded",
  enabledReports: 1,
  degradedReports: 1,
  unavailableReports: 0,
  unavailablePlies: 1
});
assert.equal(profile.signals[0].patternId, "white:user:white:fen-a w:d1d3");
assert.equal(profile.signals[0].occurrences, 2);
assert.equal(profile.signals[0].averageDeltaCp, -150);
assert.equal(profile.patterns[0].kind, "oracle-move-delta");
assert.equal(profile.patterns[0].mateTransitionCount, 1);
assert.equal(profile.patterns[0].qualityBands["mate-transition"], 1);
rmSync(profileReportA, { force: true });
rmSync(profileReportB, { force: true });

const source = mkdtempSync(join(tmpdir(), "play-memory-dl-"));
const target = mkdtempSync(join(tmpdir(), "play-memory-ar-"));
try {
  writeFileSync(join(source, "play-game-archive.jsonl"), '{"a":1}\n');
  writeFileSync(join(source, "play-game-archive (1).jsonl"), '{"a":1}\n');
  writeFileSync(join(source, "unrelated.jsonl"), "{}\n");

  const first = importArchiveDownloads(source, target);
  // identical content in both downloads -> one import, one hash-dedup skip
  assert.equal(first.imported.length, 1);
  assert.equal(first.skipped, 1);

  const second = importArchiveDownloads(source, target);
  assert.equal(second.imported.length, 0);
  assert.equal(second.skipped, 2);

  writeFileSync(join(source, "play-game-archive (2).jsonl"), '{"a":2}\n');
  const third = importArchiveDownloads(source, target);
  assert.equal(third.imported.length, 1);

  assert.deepEqual(importArchiveDownloads(join(source, "missing"), target), { imported: [], skipped: 0 });
} finally {
  rmSync(source, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
}

console.log("play-memory-update.test.mjs passed.");
