// Shared analyzer foundation for the CLI and the local web Analyzer surface.
// Local-only. Stockfish is optional validation evidence; chess-cli is the owned engine.
// `ownedChessCliBinary`/`newestSourceMtime` moved verbatim from
// scripts/play-game-archive-analyze.mjs; the PGN record builder moved verbatim from
// scripts/analyze-game.mjs so CLI and web share one record format.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const repoRootPath = new URL("../", import.meta.url).pathname;
const chessCliBinaryPath = join(repoRootPath, "target/release/chess-cli");
const cargoPathEnv = [
  `${process.env.HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/bin`,
  `${process.env.HOME}/.cargo/bin`,
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  process.env.PATH ?? ""
].join(":");
let resolvedOwnedChessCli = null;

export function ownedChessCliBinary() {
  if (resolvedOwnedChessCli !== null) {
    return resolvedOwnedChessCli;
  }
  let binaryTime = 0;
  try {
    binaryTime = statSync(chessCliBinaryPath).mtimeMs;
  } catch {
    binaryTime = 0;
  }
  let newestSourceTime = 0;
  try {
    newestSourceTime = newestSourceMtime(join(repoRootPath, "crates"));
  } catch {
    newestSourceTime = 0;
  }
  if (binaryTime === 0 || (newestSourceTime > 0 && newestSourceTime > binaryTime)) {
    const build = spawnSync(
      "cargo",
      ["build", "--release", "-p", "chess-cli", "--quiet"],
      {
        cwd: repoRootPath,
        env: { ...process.env, PATH: cargoPathEnv },
        encoding: "utf8"
      }
    );
    if (build.status !== 0) {
      resolvedOwnedChessCli = { ok: false, reason: "chess-cli-release-build-failed" };
      return resolvedOwnedChessCli;
    }
  }
  try {
    statSync(chessCliBinaryPath);
  } catch {
    resolvedOwnedChessCli = { ok: false, reason: "chess-cli-release-missing" };
    return resolvedOwnedChessCli;
  }
  resolvedOwnedChessCli = { ok: true, path: chessCliBinaryPath };
  return resolvedOwnedChessCli;
}

function newestSourceMtime(rootDir) {
  const skipNames = new Set(["target", "node_modules", ".git"]);
  let newest = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const entryPath = join(dir, name);
      let entryStat;
      try {
        entryStat = statSync(entryPath);
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        if (!skipNames.has(name)) {
          stack.push(entryPath);
        }
        continue;
      }
      if (entryStat.mtimeMs > newest) {
        newest = entryStat.mtimeMs;
      }
    }
  }
  return newest;
}

// Replay a PGN into the per-ply FEN chain with the owned engine CLI. The release binary
// freshness guard (build once per process when sources are newer) is shared with
// ownedBestMove so both paths resolve the same up-to-date binary.
export function pgnPlies(pgnText) {
  const binary = ownedChessCliBinary();
  if (!binary.ok) {
    throw new Error(`pgn-plies unavailable: ${binary.reason}`);
  }
  const result = spawnSync(
    binary.path,
    ["pgn-plies", "--pgn", pgnText],
    { cwd: repoRootPath, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`invalid PGN: ${(result.stderr || result.stdout || "unknown").trim()}`);
  }
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

// Build a play-game-archive record from a raw PGN. Moved verbatim from
// scripts/analyze-game.mjs analyzeRawPgn; side defaults to white like the CLI.
export function buildPgnGameRecord(pgnText, id, side, depth) {
  const selectedSide = side === "black" ? "black" : "white";
  const plies = pgnPlies(pgnText);
  if (plies.length === 0) {
    throw new Error("PGN has no moves");
  }
  const moves = plies.map((ply) => ({
    ply: ply.ply,
    actor: ply.side === selectedSide ? "player" : "engine",
    role: ply.side === selectedSide ? "user" : "rival",
    side: ply.side,
    selectedSide,
    coordinate: ply.uci,
    san: ply.san,
    fenBefore: ply.fenBefore,
    fenAfter: ply.fenAfter,
    buildSha: "cli",
    evaluatorBackend: "owned-local",
    engineDepth: depth,
    aggressive: true,
    recommendationBeforeMove: null,
    attribution: { buildSha: "cli", evaluatorBackend: "owned-local", engineDepth: depth, aggressive: true }
  }));
  const last = plies[plies.length - 1];
  return {
    schema: 1,
    id,
    savedAtIso: new Date().toISOString(),
    source: "play-game-archive",
    saveReason: "manual-save",
    engineBuildSha: "cli",
    selectedSide,
    playMode: "opponent",
    aggressive: true,
    engineDepth: depth,
    startFen: plies[0].fenBefore,
    finalFen: last.fenAfter,
    pgn: pgnText,
    moves
  };
}

export const playArchiveDir = "data/play-archive";

// Compact summaries for the web Analyzer's recent-games picker. Newest first, capped.
export function listArchiveGameSummaries(limit = 12) {
  let names;
  try {
    names = readdirSync(playArchiveDir);
  } catch {
    return [];
  }
  const summaries = [];
  for (const name of names.sort()) {
    if (!/\.(json|jsonl)$/u.test(name)) {
      continue;
    }
    if (name.endsWith(".analysis.json") || name === "last-update-report.json") {
      continue;
    }
    const raw = readFileSync(join(playArchiveDir, name), "utf8");
    const values = [];
    if (name.endsWith(".jsonl")) {
      for (const line of raw.split(/\r?\n/u)) {
        if (line.trim() === "") {
          continue;
        }
        try {
          values.push(JSON.parse(line));
        } catch {
          /* skip malformed line */
        }
      }
    } else {
      try {
        values.push(JSON.parse(raw));
      } catch {
        /* skip malformed file */
      }
    }
    for (const value of values) {
      collectGameSummaries(value, summaries);
    }
  }
  return summaries
    .filter((entry) => entry.id !== null && Array.isArray(entry.moves) && entry.moves.length >= 2)
    .sort((left, right) => (right.savedAtIso ?? "").localeCompare(left.savedAtIso ?? ""))
    .slice(0, limit)
    .map((entry) => ({
      id: entry.id,
      savedAtIso: entry.savedAtIso ?? null,
      selectedSide: entry.selectedSide === "black" ? "black" : "white",
      plies: entry.moves.length,
      aggressive: entry.aggressive === true,
      playMode: typeof entry.playMode === "string" ? entry.playMode : null,
      termination: entry.termination ?? null,
      resignedBy: entry.resignedBy ?? null,
      resignedSide: entry.resignedSide ?? null,
      result: pgnResult(entry.pgn)
    }));
}

function collectGameSummaries(value, summaries) {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (typeof value.id === "string" && value.id !== "" && Array.isArray(value.moves)) {
    summaries.push(value);
  }
  if (Array.isArray(value.games)) {
    for (const game of value.games) {
      collectGameSummaries(game, summaries);
    }
  }
}

function pgnResult(pgn) {
  const last = typeof pgn === "string" ? pgn.trim().split(/\s+/u).at(-1) : undefined;
  return last === "1-0" || last === "0-1" || last === "1/2-1/2" ? last : null;
}

// Find one saved game record by id across data/play-archive. Moved verbatim from
// scripts/analyze-game.mjs findGameRecord.
export function findGameRecord(id) {
  let names;
  try {
    names = readdirSync(playArchiveDir);
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    if (!/\.(json|jsonl)$/u.test(name)) {
      continue;
    }
    if (name.endsWith(".analysis.json") || name === "last-update-report.json") {
      continue;
    }
    const raw = readFileSync(join(playArchiveDir, name), "utf8");
    const values = [];
    if (name.endsWith(".jsonl")) {
      for (const line of raw.split(/\r?\n/u)) {
        if (line.trim() === "") {
          continue;
        }
        try {
          values.push(JSON.parse(line));
        } catch {
          /* skip malformed line */
        }
      }
    } else {
      try {
        values.push(JSON.parse(raw));
      } catch {
        /* skip malformed file */
      }
    }
    for (const value of values) {
      const found = findRecordById(value, id);
      if (found !== null) {
        return { game: found, archivePath: join(playArchiveDir, name) };
      }
    }
  }
  return null;
}

function findRecordById(value, id) {
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (value.id === id) {
    return value;
  }
  if (Array.isArray(value.games)) {
    for (const game of value.games) {
      if (game !== null && typeof game === "object" && game.id === id) {
        return game;
      }
    }
  }
  return null;
}
