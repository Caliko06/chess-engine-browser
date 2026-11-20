#!/usr/bin/env node
// ADR-0239/ADR-0240 operator loop: turn user-exported Play archives into refreshed
// engine memory with one command. Local-only; Stockfish is validation evidence, never
// a runtime dependency.
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const archiveDir = "data/play-archive";
const memoryDir = "data/engine-memory";
const refutationsPath = join(memoryDir, "refutations.v1.json");
const knownGapsPath = join(memoryDir, "known-gaps.v1.json");
const lastReportPath = join(memoryDir, "last-update-report.json");
const webRefutationMemoryPath = "apps/web/src/generated/play-refutation-memory.generated.ts";
const defaultDepth = 12;
const defaultWatchSeconds = 60;
const defaultStockfishCandidates = ["/opt/homebrew/bin/stockfish", "/usr/local/bin/stockfish"];

function usage() {
  return [
    "Usage: node scripts/play-memory-update.mjs [--depth <n>] [--force] [--no-oracle] [--watch [seconds]] [--skip-verify] [--no-import]",
    "",
    "Imports play-game-archive*.json|jsonl downloads from ~/Downloads (override with",
    "CHESS_PLAY_ARCHIVE_DOWNLOADS; content-hash dedup, originals untouched), then scans",
    "data/play-archive/*.json|jsonl exports, analyzes new/changed ones (Stockfish oracle",
    "when resolvable), recompiles data/engine-memory/refutations.v1.json, regenerates",
    "known-gaps.v1.json, verifies the enforcement harness, and records a consultive player",
    "profile in data/engine-memory/last-update-report.json.",
    "Stockfish resolution order: CHESS_PLAY_STOCKFISH_BIN, /opt/homebrew/bin/stockfish,",
    "/usr/local/bin/stockfish, `which stockfish`."
  ].join("\n");
}

export function downloadsDir(env = process.env) {
  const explicit = env.CHESS_PLAY_ARCHIVE_DOWNLOADS;
  if (typeof explicit === "string" && explicit !== "") {
    return explicit;
  }
  return join(homedir(), "Downloads");
}

export function isArchiveDownloadName(name) {
  return /^play-game-archive(?: \(\d+\))?\.(json|jsonl)$/u.test(name);
}

export function importedArchiveName(hashHex, extension) {
  return `imported-${hashHex.slice(0, 12)}.${extension}`;
}

export function importArchiveDownloads(sourceDir, targetDir, io = { readdirSync, readFileSync, existsSync, copyFileSync }) {
  let entries;
  try {
    entries = io.readdirSync(sourceDir);
  } catch {
    return { imported: [], skipped: 0 };
  }
  const imported = [];
  let skipped = 0;
  for (const name of entries.filter(isArchiveDownloadName).sort()) {
    const sourcePath = join(sourceDir, name);
    const content = io.readFileSync(sourcePath);
    const hashHex = createHash("sha256").update(content).digest("hex");
    const extension = name.endsWith(".jsonl") ? "jsonl" : "json";
    const targetPath = join(targetDir, importedArchiveName(hashHex, extension));
    if (io.existsSync(targetPath)) {
      skipped += 1;
      continue;
    }
    io.copyFileSync(sourcePath, targetPath);
    imported.push({ from: name, to: importedArchiveName(hashHex, extension) });
  }
  return { imported, skipped };
}

export function parseArgs(argv) {
  const args = {
    depth: defaultDepth,
    force: false,
    oracle: true,
    watch: false,
    watchSeconds: defaultWatchSeconds,
    skipVerify: false,
    importDownloads: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--depth") {
      args.depth = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--no-oracle") {
      args.oracle = false;
    } else if (arg === "--skip-verify") {
      args.skipVerify = true;
    } else if (arg === "--no-import") {
      args.importDownloads = false;
    } else if (arg === "--watch") {
      args.watch = true;
      const next = argv[index + 1];
      if (next !== undefined && /^\d+$/u.test(next)) {
        args.watchSeconds = Number.parseInt(next, 10);
        index += 1;
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.depth) || args.depth < 1 || args.depth > 30) {
    throw new Error("--depth must be an integer from 1 to 30");
  }
  if (!Number.isInteger(args.watchSeconds) || args.watchSeconds < 5) {
    throw new Error("--watch seconds must be an integer >= 5");
  }
  return args;
}

export function resolveStockfishBinary(env = process.env, probe = existsSync) {
  const explicit = env.CHESS_PLAY_STOCKFISH_BIN;
  if (typeof explicit === "string" && explicit !== "") {
    return probe(explicit) ? { ok: true, path: explicit, source: "env" } : { ok: false, reason: `CHESS_PLAY_STOCKFISH_BIN points at missing file: ${explicit}` };
  }
  for (const candidate of defaultStockfishCandidates) {
    if (probe(candidate)) {
      return { ok: true, path: candidate, source: "default-path" };
    }
  }
  const which = spawnSync("which", ["stockfish"], { encoding: "utf8" });
  const found = which.status === 0 ? which.stdout.trim() : "";
  if (found !== "" && probe(found)) {
    return { ok: true, path: found, source: "which" };
  }
  return { ok: false, reason: "no Stockfish binary found (set CHESS_PLAY_STOCKFISH_BIN)" };
}

export function listArchives(dir, io = { readdirSync, statSync }) {
  let entries;
  try {
    entries = io.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /\.(json|jsonl)$/u.test(name) && !name.endsWith(".analysis.json") && name !== "last-update-report.json")
    .map((name) => {
      const path = join(dir, name);
      return { name, path, mtimeMs: io.statSync(path).mtimeMs };
    })
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

export function analysisPathFor(archivePath) {
  return `${archivePath.replace(/\.(json|jsonl)$/u, "")}.analysis.json`;
}

export function listAnalysisReports(dir, io = { readdirSync, statSync }) {
  let entries;
  try {
    entries = io.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".analysis.json"))
    .map((name) => ({ name, path: join(dir, name), mtimeMs: io.statSync(join(dir, name)).mtimeMs }))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

export function needsAnalysis(archive, force, io = { existsSync, statSync }) {
  if (force) {
    return true;
  }
  const target = analysisPathFor(archive.path);
  if (!io.existsSync(target)) {
    return true;
  }
  return io.statSync(target).mtimeMs < archive.mtimeMs;
}

function cargoEnv(extra = {}) {
  const home = process.env.HOME ?? "";
  return {
    ...process.env,
    PATH: `${home}/.rustup/toolchains/stable-aarch64-apple-darwin/bin:${home}/.cargo/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    ...extra
  };
}

function run(label, command, commandArgs, env) {
  console.log(`\n[play-memory] ${label}`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit", env });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${String(result.status)}`);
  }
}

function readCounts() {
  const counts = { cases: null, gaps: null };
  try {
    counts.cases = JSON.parse(readFileSync(refutationsPath, "utf8")).cases.length;
  } catch {
    /* keep null */
  }
  try {
    counts.gaps = JSON.parse(readFileSync(knownGapsPath, "utf8")).gaps.length;
  } catch {
    /* keep null */
  }
  return counts;
}

export function degradedOracleReports(reportPaths, io = { readFileSync }) {
  const degraded = [];
  for (const reportPath of reportPaths) {
    const report = JSON.parse(io.readFileSync(reportPath, "utf8"));
    if (report?.oracle?.status === "degraded") {
      degraded.push({
        path: reportPath,
        unavailablePlies: report.oracle.coverage?.unavailablePlies ?? null
      });
    }
  }
  return degraded;
}

function aggregatePatternOutput(pattern, exact) {
  const output = {
    patternId: pattern.patternId,
    selectedSide: pattern.selectedSide,
    role: pattern.role,
    side: pattern.side,
    occurrences: pattern.occurrences,
    gameCount: pattern.games.size,
    failCount: pattern.failCount,
    watchCount: pattern.watchCount,
    mateTransitionCount: pattern.mateTransitionCount,
    qualityBands: Object.fromEntries(
      [...pattern.qualityBands.entries()].sort(([left], [right]) => left.localeCompare(right))
    ),
    averageDeltaCp: pattern.deltaCpCount === 0
      ? null
      : Math.round(pattern.deltaCpTotal / pattern.deltaCpCount),
    examples: pattern.examples
  };
  if (exact) {
    output.move = pattern.move;
    output.positionKey = pattern.positionKey;
    output.kinds = [...pattern.kinds].sort();
  } else {
    output.kind = pattern.kind;
  }
  return output;
}

function patternSort(left, right) {
  return right.failCount - left.failCount ||
    right.watchCount - left.watchCount ||
    right.occurrences - left.occurrences ||
    left.patternId.localeCompare(right.patternId);
}

function addPlayerPattern(map, key, game, entry, exact) {
  const side = typeof entry.side === "string" ? entry.side : "unknown";
  const kind = typeof entry.kind === "string" ? entry.kind : "unknown";
  const current = map.get(key) ?? {
    patternId: key,
    selectedSide: game.selectedSide,
    role: "user",
    side,
    kind: exact ? null : kind,
    move: exact ? (typeof entry.move === "string" ? entry.move : null) : null,
    positionKey: exact ? (typeof entry.positionKey === "string" ? entry.positionKey : null) : null,
    kinds: new Set(),
    occurrences: 0,
    games: new Set(),
    failCount: 0,
    watchCount: 0,
    deltaCpTotal: 0,
    deltaCpCount: 0,
    mateTransitionCount: 0,
    qualityBands: new Map(),
    examples: []
  };
  current.occurrences += 1;
  current.games.add(game.id);
  current.kinds.add(kind);
  if (entry.severity === "fail") {
    current.failCount += 1;
  }
  if (entry.severity === "watch") {
    current.watchCount += 1;
  }
  if (entry.detail?.deltaClass === "mate-transition") {
    current.mateTransitionCount += 1;
  } else if (typeof entry.detail?.deltaCp === "number") {
    current.deltaCpTotal += entry.detail.deltaCp;
    current.deltaCpCount += 1;
  }
  if (typeof entry.detail?.qualityBand === "string") {
    current.qualityBands.set(
      entry.detail.qualityBand,
      (current.qualityBands.get(entry.detail.qualityBand) ?? 0) + 1
    );
  }
  current.examples.push({
    gameId: game.id,
    ply: entry.ply,
    move: entry.move ?? null,
    positionKey: entry.positionKey ?? null,
    severity: entry.severity,
    detail: entry.detail ?? null
  });
  current.examples.sort((left, right) => {
    const severityRank = { fail: 0, watch: 1, info: 2 };
    return (severityRank[left.severity] ?? 3) - (severityRank[right.severity] ?? 3) ||
      left.ply - right.ply ||
      String(left.gameId).localeCompare(String(right.gameId));
  });
  current.examples = current.examples.slice(0, 3);
  map.set(key, current);
}

function patternKey(game, entry) {
  const move = typeof entry.move === "string" ? entry.move : "none";
  const side = typeof entry.side === "string" ? entry.side : "unknown";
  const positionKey = typeof entry.positionKey === "string" ? entry.positionKey : "no-position";
  return `${game.selectedSide}:user:${side}:${positionKey}:${move}`;
}

export function aggregatePlayerProfile(reportPaths, io = { readFileSync }) {
  const exactPatterns = new Map();
  const broadPatterns = new Map();
  const seenGames = new Set();
  const acceptedGameIds = new Set();
  const oracleCounts = { enabled: 0, degraded: 0, unavailable: 0, unknown: 0 };
  let acceptedGamesFromReports = 0;
  let quarantinedGames = 0;
  let totalPlies = 0;
  let userPlies = 0;
  let userLabels = 0;
  let failLabels = 0;
  let watchLabels = 0;
  let oracleUnavailablePlies = 0;

  for (const reportPath of reportPaths) {
    const report = JSON.parse(io.readFileSync(reportPath, "utf8"));
    acceptedGamesFromReports += Number.isFinite(report?.understanding?.acceptedGames)
      ? report.understanding.acceptedGames
      : 0;
    quarantinedGames += Number.isFinite(report?.understanding?.quarantinedGames)
      ? report.understanding.quarantinedGames
      : 0;

    const oracleStatus = report?.oracle?.status;
    if (oracleStatus === "enabled" || oracleStatus === "degraded" || oracleStatus === "unavailable") {
      oracleCounts[oracleStatus] += 1;
    } else {
      oracleCounts.unknown += 1;
    }
    const unavailable = report?.oracle?.coverage?.unavailablePlies;
    if (Number.isFinite(unavailable) && unavailable > 0) {
      oracleUnavailablePlies += unavailable;
    }

    for (const [index, game] of (Array.isArray(report?.games) ? report.games : []).entries()) {
      const gameId = typeof game?.id === "string" && game.id !== ""
        ? game.id
        : `${reportPath}#${String(index)}`;
      if (seenGames.has(gameId)) {
        continue;
      }
      seenGames.add(gameId);
      acceptedGameIds.add(gameId);
      totalPlies += Number.isFinite(game?.plies) ? game.plies : 0;
      userPlies += Number.isFinite(game?.userPlies) ? game.userPlies : 0;
      const gameMeta = { id: gameId, selectedSide: game.selectedSide };
      for (const entry of Array.isArray(game?.labels) ? game.labels : []) {
        if (entry?.role !== "user" || entry.kind === "oracle-unavailable-at-ply") {
          continue;
        }
        userLabels += 1;
        if (entry.severity === "fail") {
          failLabels += 1;
        }
        if (entry.severity === "watch") {
          watchLabels += 1;
        }
        addPlayerPattern(
          exactPatterns,
          patternKey(game, entry),
          gameMeta,
          entry,
          true
        );
        const side = typeof entry.side === "string" ? entry.side : "unknown";
        const kind = typeof entry.kind === "string" ? entry.kind : "unknown";
        addPlayerPattern(
          broadPatterns,
          `${game.selectedSide}:user:${side}:${kind}`,
          gameMeta,
          entry,
          false
        );
      }
    }
  }

  const surfacedPatterns = [...broadPatterns.values()]
    .filter((pattern) => pattern.occurrences >= 2 || pattern.failCount > 0 || pattern.watchCount > 0)
    .sort(patternSort)
    .map((pattern) => aggregatePatternOutput(pattern, false));
  const surfacedSignals = [...exactPatterns.values()]
    .filter((pattern) => pattern.occurrences >= 2 || pattern.failCount > 0)
    .sort(patternSort)
    .map((pattern) => aggregatePatternOutput(pattern, true));
  const oracleStatus = oracleCounts.degraded > 0
    ? "degraded"
    : oracleCounts.enabled > 0
      ? "enabled"
      : oracleCounts.unavailable > 0
        ? "unavailable"
        : "unknown";

  return {
    schema: 1,
    status: "consultive-only",
    reports: reportPaths.length,
    acceptedGames: acceptedGameIds.size || acceptedGamesFromReports,
    quarantinedGames,
    totalPlies,
    userPlies,
    userLabels,
    failLabels,
    watchLabels,
    oracle: {
      status: oracleStatus,
      enabledReports: oracleCounts.enabled,
      degradedReports: oracleCounts.degraded,
      unavailableReports: oracleCounts.unavailable,
      unavailablePlies: oracleUnavailablePlies
    },
    patterns: surfacedPatterns,
    signals: surfacedSignals,
    note: "Descriptive profile from accepted, user-attributed game labels; it does not tune search or approve training automatically."
  };
}

function updateCycle(args) {
  if (args.importDownloads) {
    const result = importArchiveDownloads(downloadsDir(), archiveDir);
    for (const entry of result.imported) {
      console.log(`[play-memory] imported download: ${entry.from} -> ${entry.to}`);
    }
  }
  const archives = listArchives(archiveDir);
  if (archives.length === 0) {
    console.log(`[play-memory] no archives in ${archiveDir}; nothing to do (export games from Play first).`);
    return { ranAnalyzer: false, ranCompile: false, archives: 0 };
  }

  const stockfish = args.oracle ? resolveStockfishBinary() : { ok: false, reason: "oracle disabled by flag" };
  if (args.oracle && !stockfish.ok) {
    throw new Error(`oracle required but unavailable: ${stockfish.reason}. Use --no-oracle only for pipeline dry runs; memory cases require the oracle.`);
  }

  let analyzed = 0;
  for (const archive of archives) {
    if (!needsAnalysis(archive, args.force)) {
      console.log(`[play-memory] up to date: ${archive.name}`);
      continue;
    }
    const analyzerArgs = [
      "scripts/play-game-archive-analyze.mjs",
      "--input",
      archive.path,
      "--output",
      analysisPathFor(archive.path),
      "--depth",
      String(args.depth)
    ];
    if (!args.oracle) {
      analyzerArgs.push("--no-oracle");
    }
    const env = stockfish.ok ? { ...process.env, CHESS_PLAY_STOCKFISH_BIN: stockfish.path } : process.env;
    run(`analyze ${archive.name} (depth ${String(args.depth)}, oracle ${stockfish.ok ? stockfish.path : "off"})`, "node", analyzerArgs, env);
    analyzed += 1;
  }

  const reports = listAnalysisReports(archiveDir).map((report) => report.path).filter((path) => existsSync(path));
  if (reports.length === 0) {
    throw new Error("no analysis reports exist after the analyze step");
  }
  const degradedReports = args.oracle ? degradedOracleReports(reports) : [];
  if (degradedReports.length > 0) {
    const detail = degradedReports
      .map((report) => `${report.path} unavailablePlies=${String(report.unavailablePlies)}`)
      .join("; ");
    throw new Error(`oracle degraded; refusing silent memory update: ${detail}`);
  }
  run("compile refutation memory", "node", [
    "scripts/play-evidence-compile-memory.mjs",
    "--reports",
    ...reports,
    "--output",
    refutationsPath
  ], process.env);
  run("generate web refutation memory", "node", [
    "scripts/generate-play-refutation-memory.mjs",
    "--input",
    refutationsPath,
    "--output",
    webRefutationMemoryPath
  ], process.env);

  run(
    "regenerate known-gaps inventory",
    "cargo",
    ["nextest", "run", "-p", "chess-search", "--test", "evidence_refutation_memory"],
    cargoEnv({ CHESS_EVIDENCE_REGENERATE: "1" })
  );
  if (!args.skipVerify) {
    run(
      "verify enforcement harness",
      "cargo",
      ["nextest", "run", "-p", "chess-search", "--test", "evidence_refutation_memory"],
      cargoEnv()
    );
  }

  const counts = readCounts();
  const playerProfile = aggregatePlayerProfile(reports);
  const summary = {
    schema: 1,
    updatedAtIso: new Date().toISOString(),
    archives: archives.map((archive) => archive.name),
    analyzedThisRun: analyzed,
    oracle: stockfish.ok ? { status: "enabled", binary: stockfish.path, depth: args.depth } : { status: "disabled", reason: stockfish.reason },
    memoryCases: counts.cases,
    knownGaps: counts.gaps,
    playerProfile
  };
  writeFileSync(lastReportPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n[play-memory] done: ${String(archives.length)} archive(s), ${String(analyzed)} analyzed this run, memory cases: ${String(counts.cases)}, known gaps: ${String(counts.gaps)}.`);
  console.log(`[play-memory] player profile: ${String(playerProfile.acceptedGames)} game(s), ${String(playerProfile.userPlies)} user plies, ${String(playerProfile.patterns.length)} pattern(s), ${String(playerProfile.signals.length)} recurring signal(s).`);
  console.log(`[play-memory] report: ${lastReportPath}`);
  return { ranAnalyzer: analyzed > 0, ranCompile: true, archives: archives.length };
}

function watchSignature() {
  let downloads = [];
  try {
    downloads = readdirSync(downloadsDir()).filter(isArchiveDownloadName);
  } catch {
    /* downloads dir unavailable */
  }
  return JSON.stringify([
    listArchives(archiveDir).map((archive) => [archive.name, archive.mtimeMs]),
    downloads.sort()
  ]);
}

async function watchLoop(args) {
  console.log(`[play-memory] watch mode: checking ${archiveDir} every ${String(args.watchSeconds)}s. Ctrl+C to stop.`);
  let lastSignature = "";
  for (;;) {
    const signature = watchSignature();
    if (signature !== lastSignature) {
      try {
        updateCycle(args);
        lastSignature = watchSignature();
      } catch (error) {
        console.error(`[play-memory] cycle failed: ${error instanceof Error ? error.message : String(error)}`);
        lastSignature = signature;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, args.watchSeconds * 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.watch) {
      await watchLoop(args);
    } else {
      updateCycle(args);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  }
}
