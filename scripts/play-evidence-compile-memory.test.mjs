import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compileMemoryFromReports } from "./play-evidence-compile-memory.mjs";

const fenA = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const fenB = "r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2";
const fenC = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const report = {
  schema: 1,
  understanding: {
    accepted: [{ id: "accepted-a" }, { id: "accepted-b" }, { id: "accepted-c" }],
    quarantined: [{ id: "quarantined" }]
  },
  games: [
    game("accepted-a", fenA, "b8c6", -180, true),
    game("accepted-b", fenB, "g1f3", -450, false),
    game("accepted-b", fenB, "a2a3", -200, false),
    game("accepted-c", fenC, "a2a3", -200, false, true),
    game("quarantined", fenA, "d7d5", -900, true)
  ]
};

const memory = compileMemoryFromReports([report]);
assertEqual(memory.schema, 1, "schema");
assertEqual(memory.cases.length, 2, "included case count");
assertEqual(memory.cases[0].move, "g1f3", "deterministic order");
assertEqual(memory.cases[0].tier, "refuted-played", "single large played refutation");
assertEqual(memory.cases[1].move, "b8c6", "recommendation case move");
assertEqual(memory.cases[1].tier, "refuted-recommendation", "recommendation tier");
assertEqual(memory.cases.some((entry) => entry.move === "a2a3"), false, "single unrecommended -200 excluded");
assertEqual(memory.cases.some((entry) => entry.move === "d7d5"), false, "quarantined excluded");

const duplicateReport = {
  schema: 1,
  understanding: { accepted: [{ id: "accepted-b" }] },
  games: [game("accepted-b", fenB, "g1f3", -450, false)]
};
const dedupedMemory = compileMemoryFromReports([report, duplicateReport]);
const dedupedCase = dedupedMemory.cases.find((entry) => entry.move === "g1f3");
assertEqual(dedupedCase !== undefined, true, "dedup keeps first accepted occurrence");
assertEqual(dedupedCase.occurrences, 1, "duplicate game id counted once");
assertEqual(dedupedCase.gameIds, ["accepted-b"], "duplicate game id keeps single game");
assertEqual(dedupedCase.tier, "refuted-played", "deduped tier from real evidence");

const tempRoot = mkdtempSync(join(tmpdir(), "play-evidence-compile-memory-test-"));
const reportPath = join(tempRoot, "report.json");
const outputPath = join(tempRoot, "memory.json");
writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
const result = spawnSync(
  process.execPath,
  ["scripts/play-evidence-compile-memory.mjs", "--reports", reportPath, "--output", outputPath],
  { cwd: new URL("../", import.meta.url), encoding: "utf8" }
);
if (result.status !== 0) {
  throw new Error(`compiler failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
}
assertEqual(readFileSync(outputPath, "utf8"), `${JSON.stringify(memory, null, 2)}\n`, "idempotent CLI output");
console.log("play-evidence-compile-memory.test.mjs passed.");

function game(id, fenBefore, move, deltaCp, recommendationFailure, secondaryCandidate = false) {
  return {
    id,
    moves: [
      {
        ply: 1,
        side: fenBefore.includes(" w ") ? "white" : "black",
        role: "user",
        selectedSide: "black",
        move,
        fenBefore,
        buildSha: "fixture-build"
      }
    ],
    labels: [
      {
        ply: 1,
        side: fenBefore.includes(" w ") ? "white" : "black",
        role: "user",
        move,
        positionKey: fenBefore.split(/\s+/u).slice(0, 4).join(" "),
        kind: "oracle-move-delta",
        severity: "fail",
        detail: { depth: 12, deltaCp }
      },
      ...(recommendationFailure
        ? [
            {
              ply: 1,
              side: fenBefore.includes(" w ") ? "white" : "black",
              role: "user",
              move,
              positionKey: fenBefore.split(/\s+/u).slice(0, 4).join(" "),
              kind: "shallow-recommendation-failure",
              severity: "fail",
              detail: { depth: 12, deltaCp }
            }
        ]
        : []),
      ...(secondaryCandidate
        ? [
            {
              ply: 1,
              side: fenBefore.includes(" w ") ? "white" : "black",
              role: "user",
              move,
              positionKey: fenBefore.split(/\s+/u).slice(0, 4).join(" "),
              kind: "oracle-refuted-candidate",
              severity: "fail",
              detail: { depth: 12, deltaCp }
            }
          ]
        : [])
    ]
  };
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
