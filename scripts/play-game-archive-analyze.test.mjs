import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("../", import.meta.url).pathname;
const tempRoot = mkdtempSync(join(tmpdir(), "play-game-archive-analyze-test-"));
const inputPath = join(tempRoot, "archive.jsonl");
const outputPath = join(tempRoot, "report.json");
const oracleInputPath = join(tempRoot, "oracle-archive.jsonl");
const oracleOutputPath = join(tempRoot, "oracle-report.json");
const fakeStockfishPath = join(tempRoot, "fake-stockfish.mjs");

const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const afterNc6 = "r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2";
const afterE4PositionKey = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b";

const game = {
  schema: 1,
  id: "fixture-game",
  source: "play-game-archive",
  selectedSide: "black",
  playMode: "spectator-lens",
  aggressive: true,
  engineDepth: 1,
  startFen,
  finalFen: afterNc6,
  pgn: "1. e4 Nc6 *",
  moves: [
    {
      ply: 1,
      actor: "engine",
      side: "white",
      role: "rival",
      selectedSide: "black",
      buildSha: "fixture-build-sha",
      evaluatorBackend: "owned-local",
      engineDepth: 1,
      aggressive: true,
      attribution: {
        buildSha: "fixture-build-sha",
        evaluatorBackend: "owned-local",
        engineDepth: 1,
        aggressive: true
      },
      recommendationBeforeMove: null,
      coordinate: "e2e4",
      san: "e4",
      fenBefore: startFen,
      fenAfter: afterE4
    },
    {
      ply: 2,
      actor: "player",
      side: "black",
      role: "user",
      selectedSide: "black",
      buildSha: "fixture-build-sha",
      evaluatorBackend: "owned-local",
      engineDepth: 1,
      aggressive: true,
      attribution: {
        buildSha: "fixture-build-sha",
        evaluatorBackend: "owned-local",
        engineDepth: 1,
        aggressive: true
      },
      recommendationBeforeMove: {
        buildSha: "fixture-build-sha",
        seq: 8,
        nodeBudget: 22000,
        exploreMode: "fast",
        aggressive: true,
        userSide: "black",
        ply: 2,
        fenBefore: afterE4,
        primaryMove: "b8c6",
        primaryRenderState: "recommended",
        side: "black",
        onTurn: true,
        candidates: [
          {
            move: "b8c6",
            kind: "defense",
            exactScoreCp: 12,
            sound: true,
            sacrifice: false,
            aftermath: null,
            mateIn: null,
            continuation: null,
            rank: 1
          }
        ],
        principalLineFirst: "b8c6",
        replyCandidateFirst: null
      },
      coordinate: "b8c6",
      san: "Nc6",
      fenBefore: afterE4,
      fenAfter: afterNc6
    }
  ]
};

const repeatedGame = {
  ...game,
  id: "fixture-game-repeat"
};
const reactionLensManualGame = {
  ...game,
  id: "fixture-reaction-lens-manual-opposite",
  playMode: "reaction-lens",
  moves: game.moves.map((move) => ({
    ...move,
    actor: "player",
    role: "user"
  }))
};
const secondaryCandidateGame = {
  ...game,
  id: "fixture-game-secondary-candidate",
  moves: game.moves.map((move) =>
    move.ply === 2
      ? {
          ...move,
          recommendationBeforeMove: {
            ...move.recommendationBeforeMove,
            primaryMove: "a2a3"
          }
        }
      : move
  )
};
const afterA6 = "rnbqkbnr/1ppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const terminalGame = {
  ...game,
  id: "fixture-game-terminal",
  finalFen: afterA6,
  moves: [
    game.moves[0],
    {
      ...game.moves[1],
      coordinate: "a7a6",
      san: "a6",
      fenAfter: afterA6
    }
  ]
};
const quarantinedGame = {
  ...game,
  id: "fixture-game-bad-role",
  moves: [
    (() => {
      const { actor: _actor, ...moveWithoutActor } = game.moves[0];
      return moveWithoutActor;
    })(),
    game.moves[1]
  ]
};
const selectedSideMismatchGame = {
  ...game,
  id: "fixture-game-selected-side-mismatch",
  moves: game.moves.map((move, index) => (index === 0 ? { ...move, selectedSide: "white" } : move))
};
const legacyGame = {
  ...game,
  id: "fixture-game-legacy",
  moves: game.moves.map((move) => {
    const { attribution: _attribution, ...rest } = move;
    return rest;
  })
};

writeFileSync(
  inputPath,
  `${JSON.stringify(game)}\n${JSON.stringify(repeatedGame)}\n${JSON.stringify(reactionLensManualGame)}\n${JSON.stringify(quarantinedGame)}\n${JSON.stringify(selectedSideMismatchGame)}\n${JSON.stringify(legacyGame)}\n`
);

const result = spawnSync(
  process.execPath,
  [
    "scripts/play-game-archive-analyze.mjs",
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--no-oracle",
    "--min-repeat",
    "2"
  ],
  { cwd: repoRoot, encoding: "utf8" }
);

if (result.status !== 0) {
  throw new Error(`analyzer failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
}
const report = JSON.parse(readFileSync(outputPath, "utf8"));
assertEqual(report.schema, 1, "schema");
assertEqual(report.oracle.status, "unavailable", "oracle status");
assertEqual(report.oracle.reason, "disabled", "oracle reason");
assertEqual(report.understanding.acceptedGames, 3, "accepted games");
assertEqual(report.understanding.quarantinedGames, 3, "quarantined games");
assertEqual(
  report.understanding.quarantined[0].rejectionReasons.includes("missing-actor:1"),
  true,
  "missing actor quarantine"
);
const selectedSideMismatch = report.understanding.quarantined.find(
  (entry) => entry.id === selectedSideMismatchGame.id
);
if (selectedSideMismatch === undefined) {
  throw new Error("selected-side mismatch fixture was not quarantined");
}
assertEqual(
  selectedSideMismatch.rejectionReasons.includes("selected-side-at-ply-mismatch:1"),
  true,
  "per-ply selected side quarantine"
);
assertEqual(
  report.understanding.quarantined.some((entry) =>
    entry.rejectionReasons.includes("missing-move-time-attribution:1")
  ),
  true,
  "legacy attribution quarantine"
);
assertEqual(report.totals.games, 3, "game total");
assertEqual(report.totals.plies, 6, "ply total");
assertEqual(report.trainingReadiness.status, "evidence-ready", "training readiness");
assertEqual(report.trainingReadiness.movesWithBuildSha, 6, "training readiness build sha");
assertEqual(report.trainingReadiness.movesWithRecommendationSnapshot, 3, "training readiness snapshots");
assertEqual(report.games[0].selectedSide, "black", "selected side");
assertEqual(report.games[0].userPlies, 1, "user plies");
assertEqual(report.games[0].rivalPlies, 1, "rival plies");
const reactionLensReport = report.games.find((entry) => entry.id === reactionLensManualGame.id);
if (reactionLensReport === undefined) {
  throw new Error("reaction-lens manual fixture was not analyzed");
}
assertEqual(reactionLensReport.userPlies, 1, "reaction-lens selected-side user plies");
assertEqual(reactionLensReport.rivalPlies, 1, "reaction-lens opposite-side rival plies");
assertEqual(reactionLensReport.moves[0].actor, "player", "reaction-lens manual actor");
assertEqual(reactionLensReport.moves[0].role, "rival", "reaction-lens opposite-side role");
assertEqual(reactionLensReport.moves[0].side, "white", "reaction-lens opposite move side");
assertEqual(
  report.games[0].labels.some(
    (entry) =>
      entry.kind === "early-piece-development" &&
      entry.move === "b8c6" &&
      entry.role === "user"
  ),
  true,
  "black development label"
);
assertEqual(
  report.learningSignals.some(
    (entry) =>
      entry.patternId === `black:user:black:${afterE4PositionKey}:b8c6` &&
      entry.positionKey === afterE4PositionKey &&
      entry.occurrences === 3 &&
      entry.kinds.includes("early-piece-development")
  ),
  true,
  "repeated learning signal"
);
assertEqual(
  report.engineFeedback.some(
    (entry) =>
      entry.patternId === `black:user:black:${afterE4PositionKey}:b8c6` &&
      entry.advice === "review-before-repeating"
  ),
  true,
  "engine feedback"
);
assertEqual(
  report.observedPatterns.some(
    (entry) =>
      entry.patternId === "black:user:black:early-piece-development" &&
      entry.occurrences === 3 &&
      entry.gameCount === 3 &&
      entry.averageDeltaCp === null
  ),
  true,
  "cross-game observed pattern"
);

const searchLogPath = join(tempRoot, "fake-stockfish-searches.log");
writeFileSync(
  fakeStockfishPath,
  [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    "let lastFen = null;",
    "const lines = createInterface({ input: process.stdin });",
    'lines.on("line", (line) => {',
    '  if (line.startsWith("position fen ")) {',
    "    lastFen = line.slice(\"position fen \".length);",
    '  } else if (line === "uci") {',
    '    console.log("id name fake-stockfish");',
    '    console.log("uciok");',
    '  } else if (line === "isready") {',
    '    console.log("readyok");',
    '  } else if (line.startsWith("go ")) {',
    "    if (process.env.FAKE_SF_SEARCH_LOG) {",
    '      appendFileSync(process.env.FAKE_SF_SEARCH_LOG, `${lastFen}\\n`);',
    "    }",
    "    if (lastFen === " + JSON.stringify(afterA6) + ") {",
    '      console.log("info depth 0 score mate 0 nodes 1");',
    '      console.log("bestmove (none)");',
    "    } else if (lastFen === " + JSON.stringify(afterNc6) + ") {",
    '      console.log("info depth 2 score cp 200 nodes 20");',
    '      console.log("bestmove b8c6");',
    "    } else {",
    '      console.log("info depth 2 score cp 0 nodes 10");',
    '      console.log("bestmove b8c6");',
    "    }",
    '  } else if (line === "quit") {',
    "    process.exit(0);",
    "  }",
    "});",
    ""
  ].join("\n"),
  "utf8"
);
chmodSync(fakeStockfishPath, 0o700);
writeFileSync(
  oracleInputPath,
  `${JSON.stringify(game)}\n${JSON.stringify(repeatedGame)}\n${JSON.stringify(secondaryCandidateGame)}\n${JSON.stringify(terminalGame)}\n`
);
const oracleResult = spawnSync(
  process.execPath,
  [
    "scripts/play-game-archive-analyze.mjs",
    "--input",
    oracleInputPath,
    "--output",
    oracleOutputPath,
    "--depth",
    "2"
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CHESS_PLAY_STOCKFISH_BIN: fakeStockfishPath,
      FAKE_SF_SEARCH_LOG: searchLogPath
    }
  }
);
if (oracleResult.status !== 0) {
  throw new Error(`oracle analyzer failed\nstdout=${oracleResult.stdout}\nstderr=${oracleResult.stderr}`);
}
const oracleReport = JSON.parse(readFileSync(oracleOutputPath, "utf8"));
assertEqual(oracleReport.oracle.status, "enabled", "oracle terminal status");
assertEqual(oracleReport.oracle.coverage.unavailablePlies, 0, "oracle terminal coverage");
assertEqual(
  oracleReport.games[1].labels.some(
    (entry) =>
      entry.kind === "oracle-move-delta" &&
      entry.move === "b8c6" &&
      entry.severity === "fail" &&
      entry.detail.deltaCp === -200 &&
      entry.detail.qualityBand === "mistake"
  ),
  true,
  "post-terminal oracle delta survives"
);
assertEqual(
  oracleReport.games[1].labels.some(
    (entry) =>
      entry.kind === "shallow-recommendation-failure" &&
      entry.detail.recommendationRelation === "primary"
  ),
  true,
  "primary recommendation failure is attributed"
);
assertEqual(
  oracleReport.games[2].labels.some(
    (entry) =>
      entry.kind === "oracle-refuted-candidate" &&
      entry.detail.recommendationRelation === "candidate"
  ),
  true,
  "secondary candidate refutation is separated"
);
assertEqual(
  oracleReport.games[2].labels.some((entry) => entry.kind === "shallow-recommendation-failure"),
  false,
  "secondary candidate does not become primary failure"
);
assertEqual(
  oracleReport.observedPatterns.some(
    (entry) =>
      entry.patternId === "black:user:black:shallow-recommendation-failure" &&
      entry.failCount > 0 &&
      entry.qualityBands.mistake > 0
  ),
  true,
  "observed primary recommendation pattern"
);
assertEqual(
  oracleReport.observedPatterns.some(
    (entry) =>
      entry.patternId === "black:user:black:oracle-refuted-candidate" &&
      entry.failCount > 0
  ),
  true,
  "observed secondary candidate pattern"
);
const searchLog = readFileSync(searchLogPath, "utf8").trim().split("\n");
assertEqual(searchLog.length, 4, "one oracle search per distinct position");
assertEqual(new Set(searchLog).size, 4, "repeated positions are not re-searched");
assertEqual(
  oracleReport.games[3].labels.some(
    (entry) =>
      entry.kind === "oracle-move-delta" &&
      entry.detail.deltaClass === "mate-transition" &&
      entry.detail.deltaCp === 100_000
  ),
  true,
  "terminal position eval survives as mate transition"
);
assertEqual(
  oracleReport.games[3].labels.some((entry) => entry.kind === "oracle-unavailable-at-ply"),
  false,
  "terminal position is not marked unavailable"
);

console.log("play-game-archive-analyze.test.mjs passed.");

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
