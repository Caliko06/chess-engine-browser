#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const advice = "do-not-prefer-without-new-tactical-proof";

function parseArgs(argv) {
  const args = { reports: [], output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reports") {
      index += 1;
      while (index < argv.length && !argv[index].startsWith("--")) {
        args.reports.push(argv[index]);
        index += 1;
      }
      index -= 1;
    } else if (arg === "--output") {
      args.output = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.reports.length === 0) {
    throw new Error("--reports requires at least one report path");
  }
  if (args.output === null) {
    throw new Error("--output is required");
  }
  return args;
}

export function compileMemoryFromReports(reports) {
  const byKey = new Map();
  const seenGameIds = new Set();
  for (const report of reports) {
    const accepted = new Set(report.understanding?.accepted?.map((game) => game.id) ?? []);
    for (const game of report.games ?? []) {
      if (!accepted.has(game.id) || seenGameIds.has(game.id)) {
        continue;
      }
      seenGameIds.add(game.id);
      const movesByPly = new Map((game.moves ?? []).map((move) => [move.ply, move]));
      const labelsByPly = new Map();
      for (const label of game.labels ?? []) {
        const labels = labelsByPly.get(label.ply) ?? [];
        labels.push(label);
        labelsByPly.set(label.ply, labels);
      }
      for (const [ply, labels] of labelsByPly.entries()) {
        const oracle = labels.find(
          (label) =>
            label.kind === "oracle-move-delta" &&
            label.severity === "fail" &&
            typeof label.detail?.deltaCp === "number" &&
            label.detail.deltaCp <= -150 &&
            typeof label.detail?.depth === "number" &&
            label.detail.depth >= 12
        );
        if (oracle === undefined) {
          continue;
        }
        const move = movesByPly.get(ply);
        if (move === undefined || typeof move.fenBefore !== "string") {
          continue;
        }
        const recommendationFailure = labels.some((label) => label.kind === "shallow-recommendation-failure");
        const key = `${positionKeyFromFen(move.fenBefore)}|${move.move}`;
        const current = byKey.get(key) ?? {
          fen: move.fenBefore,
          positionKey: positionKeyFromFen(move.fenBefore),
          move: move.move,
          side: move.side,
          selectedSide: move.selectedSide,
          role: move.role,
          deltas: [],
          depths: [],
          buildShas: new Set(),
          gameIds: new Set(),
          recommendationFailure: false
        };
        current.deltas.push(oracle.detail.deltaCp);
        current.depths.push(oracle.detail.depth);
        if (typeof move.buildSha === "string" && move.buildSha !== "") {
          current.buildShas.add(move.buildSha);
        }
        current.gameIds.add(game.id);
        current.recommendationFailure ||= recommendationFailure;
        byKey.set(key, current);
      }
    }
  }
  const cases = [...byKey.values()]
    .map((entry) => {
      const occurrences = entry.deltas.length;
      const deltaCp = Math.min(...entry.deltas);
      const tier = entry.recommendationFailure
        ? "refuted-recommendation"
        : occurrences >= 2 || deltaCp <= -400
          ? "refuted-played"
          : null;
      if (tier === null) {
        return null;
      }
      const id = `${entry.positionKey}:${entry.move}`.replace(/[^A-Za-z0-9_.:-]+/gu, "_");
      return {
        id,
        tier,
        fen: entry.fen,
        positionKey: entry.positionKey,
        move: entry.move,
        side: entry.side,
        selectedSide: entry.selectedSide,
        role: entry.role,
        deltaCp,
        oracleDepth: Math.max(...entry.depths),
        buildShas: [...entry.buildShas].sort(),
        gameIds: [...entry.gameIds].sort(),
        occurrences,
        advice
      };
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => left.positionKey.localeCompare(right.positionKey) || left.move.localeCompare(right.move));
  return { schema: 1, cases };
}

function positionKeyFromFen(fen) {
  return fen.split(/\s+/u).slice(0, 4).join(" ");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const reports = args.reports.map((path) => JSON.parse(readFileSync(path, "utf8")));
  writeFileSync(args.output, `${JSON.stringify(compileMemoryFromReports(reports), null, 2)}\n`);
  console.log(`play-evidence-memory=${args.output}`);
}
