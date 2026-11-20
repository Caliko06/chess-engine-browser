#!/usr/bin/env node
// Analyze one saved game by id. Finds it in data/play-archive/, runs the local Stockfish
// oracle, writes the analysis report next to the archive, and prints the per-move result.
// Local-only; Stockfish is optional validation evidence, never a runtime dependency.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { buildPgnGameRecord, findGameRecord } from "./play-analyzer-shared.mjs";
import { resolveStockfishBinary } from "./play-memory-update.mjs";

const archiveDir = "data/play-archive";
const tmpDir = "/tmp/chess-analyze";

// ── ANSI colour / terminal support ──────────────────────────────────────────
const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CI;

function c(code, bold) {
  return useColor ? `\x1b[${bold ? "1;" : ""}${code}m` : "";
}
const RST = c(0);
const GRN = c(32);
const CYN = c(36);
const YLW = c(33);
const MAG = c(35);
const RED = c(31);
const BLD = c(0, true);
const DIM = c(2);
const BGRN = c(32, true);
const BCYN = c(36, true);
const BYLW = c(33, true);
const BMAJ = c(35, true);
const BRED = c(31, true);

// ── quality band display helpers ────────────────────────────────────────────
const BAND_STYLE = {
  best:             { chr: "★",  label: "Excelente",  fg: BGRN,  bg: GRN  },
  good:             { chr: "●",  label: "Bien",        fg: BCYN,  bg: CYN  },
  inaccuracy:       { chr: "△",  label: "Imprecisión", fg: BYLW,  bg: YLW  },
  mistake:          { chr: "⊗",  label: "Error",       fg: BMAJ,  bg: MAG  },
  blunder:          { chr: "✗",  label: "Blunder",     fg: BRED,  bg: RED  },
  "mate-transition":{ chr: "♛",  label: "Mate",        fg: BRED,  bg: RED  },
};

// ── helpers ─────────────────────────────────────────────────────────────────
function padEnd(str, len) {
  return String(str ?? "").padEnd(len);
}

function moveNumber(ply) {
  return Math.ceil(ply / 2);
}

function movePrefix(ply, side) {
  return side === "black" ? `${moveNumber(ply)}...` : `${moveNumber(ply)}.`;
}

function labelsByPly(game, kind) {
  const byPly = {};
  for (const label of game.labels ?? []) {
    if (label.kind === kind) {
      byPly[label.ply] = label;
    }
  }
  return byPly;
}

// Report moves carry the UCI in `move`; older analyzer shapes used `coordinate`.
function playedUci(move) {
  return move?.coordinate ?? move?.move ?? null;
}

const PIECE_NAMES = { p: "Peón", n: "Caballo", b: "Alfil", r: "Torre", q: "Dama", k: "Rey" };
const PROMO_LETTERS = { q: "D", r: "T", b: "A", n: "C" };

function boardAt(fen) {
  const board = {};
  const rows = (fen ?? "").split(/\s+/u)[0]?.split("/") ?? [];
  rows.forEach((row, index) => {
    const rank = 8 - index;
    let file = 0;
    for (const ch of row) {
      if (ch >= "1" && ch <= "8") {
        file += Number(ch);
        continue;
      }
      board[`${"abcdefgh"[file]}${rank}`] = ch;
      file += 1;
    }
  });
  return board;
}

// Human-readable alternative move from a FEN + UCI pair. The origin square is always
// shown, so no legality-based disambiguation is needed to stay unambiguous.
function describeMove(fen, uci) {
  if (typeof uci !== "string" || uci.length < 4) {
    return uci ?? "\u2014";
  }
  const board = boardAt(fen);
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const piece = board[from];
  if (piece === undefined) {
    return uci;
  }
  const pieceChar = piece.toLowerCase();
  if (pieceChar === "k" && Math.abs(uci.charCodeAt(0) - uci.charCodeAt(2)) === 2) {
    return uci.charCodeAt(0) < uci.charCodeAt(2) ? "Enroque corto" : "Enroque largo";
  }
  const epTarget = (fen ?? "").split(/\s+/u)[3];
  const isCapture = board[to] !== undefined
    || (pieceChar === "p" && typeof epTarget === "string" && epTarget !== "-"
      && epTarget[0] === to[0] && to[1] === (piece === pieceChar ? "6" : "3"));
  const promo = uci.length > 4 ? `=${PROMO_LETTERS[uci[4]] ?? ""}` : "";
  return `${PIECE_NAMES[pieceChar]} ${from}${isCapture ? "\u00d7" : "\u2192"}${to}${promo}`;
}

// The number a reader cares about: what the move cost, in pawns.
function lossText(label) {
  const detail = label.detail;
  const deltaCp = detail?.deltaCp;
  if (typeof deltaCp !== "number" || deltaCp >= 0) {
    return null;
  }
  if (detail.deltaClass === "mate-transition") {
    return detail.moverCpAfter <= -99_000
      ? BRED + "pierde el rey" + RST
      : BYLW + "el mate se escapa" + RST;
  }
  return RED + "\u2212" + (Math.abs(deltaCp) / 100).toFixed(1) + RST;
}

// ── usage / args ────────────────────────────────────────────────────────────
function usage() {
  return [
    `Usage: just analyze <game-id> [--depth <n>] [--owned-engine] [--output <path>]`,
    `       echo "<PGN>" | just analyze pgn --side <white|black> [--depth <n>] [--output <path>]`,
    "",
    "Finds the saved game with <id> in data/play-archive/, runs the local Stockfish",
    "oracle, and prints the highlights plus a compact move strip for the game.",
    "With --owned-engine also reports what our own engine would have played.",
    "Use 'pgn' subcommand with --side to analyze a raw PGN pasted from anywhere.",
    "Stockfish is auto-detected."
  ].join("\n");
}

function parseArgs(argv) {
  let id = null;
  let depth = 12;
  let ownedEngine = false;
  let pgnMode = false;
  let side = null;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--depth") {
      depth = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
    } else if (arg === "--side") {
      side = argv[index + 1] ?? null;
      if (side !== "white" && side !== "black") {
        throw new Error("--side must be white or black");
      }
      index += 1;
    } else if (arg === "--owned-engine") {
      ownedEngine = true;
    } else if (arg === "--output") {
      output = argv[index + 1] ?? null;
      if (output === null || output === "") {
        throw new Error("--output requires a path");
      }
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown argument: ${arg}`);
    } else if (arg === "pgn") {
      pgnMode = true;
    } else if (id === null) {
      id = arg;
    } else {
      throw new Error("unexpected positional argument");
    }
  }
  if (!pgnMode && id === null) {
    throw new Error("game id is required");
  }
  if (!Number.isInteger(depth) || depth < 1 || depth > 30) {
    throw new Error("--depth must be an integer from 1 to 30");
  }
  return { id, depth, ownedEngine, pgnMode, side, output };
}

function safeId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

function runAnalyzer(inputPath, outputPath, depth, stockfish, ownedEngine) {
  const env = { ...process.env };
  if (stockfish.ok) {
    env.CHESS_PLAY_STOCKFISH_BIN = stockfish.path;
  }
  const args = [
    "scripts/play-game-archive-analyze.mjs",
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--depth",
    String(depth)
  ];
  if (ownedEngine) {
    args.push("--owned-engine");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, { cwd: new URL("../", import.meta.url), env });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`analysis failed: ${stderr.trim() || "unknown"}`));
      }
    });
  });
}

function sideName(side) {
  return side === "white" ? "Blancas" : "Negras";
}
function resultLabel(result) {
  if (result === "1-0") return "1-0 (Ganan Blancas)";
  if (result === "0-1") return "0-1 (Ganan Negras)";
  if (result === "1/2-1/2") return "½-½ (Tablas)";
  return null;
}

function gameResult(game) {
  const tokens = (game.pgn ?? "").trim().split(/\s+/u);
  const last = tokens.at(-1);
  return ["1-0", "0-1", "1/2-1/2"].includes(last) ? last : null;
}

function printHeader(id, game, depth, stockfish, ownedEngine) {
  const result = gameResult(game);
  const userSide = game.selectedSide === "white" ? "white" : "black";
  const rivalSide = userSide === "white" ? "black" : "white";
  const kv = (label, value) => "  " + DIM + (label.length >= 10 ? label + " " : padEnd(label, 10)) + RST + value;

  const subtitleParts = [];
  if (stockfish.ok) subtitleParts.push("Stockfish Oracle");
  if (ownedEngine) subtitleParts.push("Motor propio");
  const subtitle = subtitleParts.length > 0 ? subtitleParts.join(" + ") : "\u2014";

  console.log("\n" + BLD + "An\u00e1lisis de partida" + RST + " " + DIM + "\u00b7 " + subtitle + RST);
  console.log("  " + BLD + id + RST + " · Tú: " + BLD + sideName(userSide) + RST + " (" + game.moves.filter(m => m.side === userSide).length + " jugadas)" + " · Rival: " + BLD + sideName(rivalSide) + RST + " (" + game.moves.filter(m => m.side === rivalSide).length + " jugadas)");
  if (result) {
    console.log(kv("Resultado:", BLD + resultLabel(result) + RST));
  }
  if (game.termination === "resigned") {
    const actor = game.resignedBy === "rival" ? "Rival" : game.resignedBy === "user" ? "Usuario" : "desconocido";
    const side = game.resignedSide === "white" ? "Blancas" : game.resignedSide === "black" ? "Negras" : "desconocido";
    console.log(kv("Fin:", BLD + `Rendici\u00f3n \u00b7 ${actor} \u00b7 ${side}` + RST));
  }
  console.log(kv("Oracle:", stockfish.ok ? BLD + "Stockfish" + RST + " depth " + depth : RED + "no disponible" + RST));
  if (ownedEngine) {
    console.log(kv("Motor:", BLD + "chess-cli best-move" + RST + (game.aggressive ? " \u00b7 " + BLD + "Agresivo" + RST : "")));
  }
  console.log(kv("Modo:", (game.playMode ?? "\u2014") + (game.aggressive ? " \u00b7 " + BLD + "Aggressive" + RST : "")));
  console.log("");
}

const ATTENTION_KIND_LABELS = {
  "early-queen-activity": "Actividad temprana de dama",
  "repeated-early-piece-origin": "Repetici\u00f3n temprana de pieza",
  "shallow-recommendation-failure": "La recomendaci\u00f3n superficial fall\u00f3",
  "oracle-refuted-candidate": "Candidato refutado por el Oracle"
};

function findingLabel(label) {
  const qualityBand = label.detail?.qualityBand;
  if (typeof qualityBand === "string" && BAND_STYLE[qualityBand] !== undefined) {
    return BAND_STYLE[qualityBand].label;
  }
  return ATTENTION_KIND_LABELS[label.kind] ?? label.kind ?? "Revisar";
}

function collectAttentionFindings(games) {
  const findings = games
    .flatMap((game) =>
      (game.labels ?? [])
        // Engine-disagreement labels are diagnostic noise in the reading view; the owned
        // suggestion already appears as a note on oracle findings that deserve attention.
        .filter((label) =>
          label.kind !== "owned-engine-move-comparison"
          && (label.severity === "fail" || label.severity === "watch")
          && label.role === "user"
        )
        .map((label) => ({ game, label }))
    )
  .sort((left, right) => {
    const rank = (entry) => (entry.label.severity === "fail" ? 0 : 1);
    const loss = (entry) => entry.label.detail?.deltaCp ?? 0;
    return rank(left) - rank(right) || loss(left) - loss(right) || (left.label.ply ?? 0) - (right.label.ply ?? 0);
  });
  const seenPlies = new Set();
  return findings.filter(({ game, label }) => {
    const key = `${game.id ?? "game"}:${label.ply ?? "unknown"}`;
    if (seenPlies.has(key)) {
      return false;
    }
    seenPlies.add(key);
    return true;
  });
}

function printSummary(games, oracle) {
  const counters = { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, "mate-transition": 0 };
  for (const game of games) {
    for (const label of game.labels ?? []) {
      if (label.kind !== "oracle-move-delta" || label.detail?.qualityBand === undefined) {
        continue;
      }
      if (counters[label.detail.qualityBand] !== undefined) {
        counters[label.detail.qualityBand] += 1;
      }
    }
  }

  const summaryParts = [];
  for (const [band, count] of Object.entries(counters)) {
    if (count === 0) {
      continue;
    }
    const style = BAND_STYLE[band];
    summaryParts.push(style === undefined ? `${band}: ${count}` : `${style.fg}${style.chr} ${count} ${style.label}${RST}`);
  }
  const totalPlies = games.reduce((sum, game) => sum + game.plies, 0);
  const oracleColor = oracle.status === "enabled" ? GRN : oracle.status === "degraded" ? YLW : RED;
  const oracleText = oracle.status + (typeof oracle.depth === "number" ? ` · depth ${oracle.depth}` : "");

  console.log("\n  " + BLD + "Resumen" + RST);
  console.log("    " + totalPlies + " pliegues" + (summaryParts.length > 0 ? " · " + summaryParts.join("  ") : " · sin etiquetas de calidad"));
  console.log("    " + DIM + "Oracle: " + RST + oracleColor + oracleText + RST);
}

function buildVerdict(games) {
  const grave = [];
  for (const game of games) {
    for (const label of game.labels ?? []) {
      if (label.kind !== "oracle-move-delta" || label.role !== "user") {
        continue;
      }
      const band = label.detail?.qualityBand;
      if (band === "mistake" || band === "blunder") {
        grave.push({ game, label });
      }
    }
  }
  const withLoss = grave.filter(({ label }) => (label.detail?.deltaCp ?? 0) < 0);
  if (withLoss.length === 0) {
    return null;
  }
  const totalLoss = withLoss.reduce((sum, { label }) => sum - label.detail.deltaCp, 0) / 100;
  const worst = withLoss.reduce((left, right) => (right.label.detail.deltaCp < left.label.detail.deltaCp ? right : left));
  const move = worst.game.moves[worst.label.ply - 1];
  const worstLoss = (-worst.label.detail.deltaCp / 100).toFixed(1);
  const jugadas = withLoss.length === 1 ? "jugada dañina" : "jugadas dañinas";
  return `Tus ${withLoss.length} ${jugadas} costaron ~${totalLoss.toFixed(1)} peones`
    + (move ? `; la peor: ${movePrefix(move.ply, move.side)}${move.san} (\u2212${worstLoss}).` : ".");
}

function printAttentionFindings(games) {
  console.log("\n  " + BLD + "Qu\u00e9 revisar" + RST);
  const findings = collectAttentionFindings(games);
  const verdict = buildVerdict(games);
  if (verdict !== null) {
    console.log("    " + verdict);
  }
  if (findings.length === 0) {
    console.log("    " + DIM + "Sin hallazgos destacados en tus jugadas." + RST);
    return;
  }
  for (const { game, label } of findings) {
    const move = typeof label.ply === "number" ? game.moves[label.ply - 1] : null;
    const band = label.detail?.qualityBand;
    const bandStyle = typeof band === "string" ? BAND_STYLE[band] : undefined;
    const marker = bandStyle
      ? bandStyle.fg + bandStyle.chr + RST
      : label.severity === "fail"
        ? BRED + "!" + RST
        : BYLW + "~" + RST;

    const parts = [marker];
    if (move !== null && move !== undefined) {
      parts.push(BLD + movePrefix(move.ply, move.side) + move.san + RST);
    } else {
      parts.push(DIM + `ply ${label.ply ?? "\u2014"}` + RST);
    }

    const loss = lossText(label);
    if (loss !== null) {
      parts.push(loss);
    }

    const isLossPhrase = label.detail?.deltaClass === "mate-transition";
    if (!isLossPhrase) {
      parts.push(bandStyle ? bandStyle.fg + findingLabel(label) + RST : DIM + findingLabel(label) + RST);
    }

    const played = playedUci(move);
    const best = label.detail?.bestBefore;
    if (typeof best === "string" && best !== played) {
      parts.push(DIM + "mejor: " + describeMove(move?.fenBefore, best) + RST);
    } else if (band === "mistake" || band === "blunder") {
      parts.push(DIM + "ya era lo mejor posible" + RST);
    }
    if (move !== null && move !== undefined) {
      const owned = labelsByPly(game, "owned-engine-move-comparison")[move.ply];
      const ownBest = owned?.detail?.bestMove;
      if (typeof ownBest === "string" && ownBest !== played) {
        const ownCp = owned?.detail?.objectiveScoreCp;
        parts.push(
          DIM
          + "motor propio: " + describeMove(move.fenBefore, ownBest)
          + (typeof ownCp === "number" ? ` (${ownCp >= 0 ? "+" : ""}${ownCp})` : "")
          + RST
        );
      }
    }
    console.log("    " + parts.join("  "));
  }
}

const STRIP_WIDTH = 92;

function printGameStrip(games) {
  console.log("\n  " + BLD + "Partida" + RST);
  for (const game of games) {
    const oracleByPly = labelsByPly(game, "oracle-move-delta");
    const lines = [];
    let line = "    ";
    let lineWidth = 4;
    let lastWhiteNum = 0;
    for (const move of game.moves) {
      const num = moveNumber(move.ply);
      let plain;
      if (move.side === "white") {
        plain = `${num}. ${move.san}`;
        lastWhiteNum = num;
      } else if (lastWhiteNum === num) {
        plain = move.san;
      } else {
        plain = `${num}... ${move.san}`;
      }

      let token = plain;
      if (move.side !== game.selectedSide) {
        token = DIM + plain + RST;
      } else {
        const band = oracleByPly[move.ply]?.detail?.qualityBand;
        if (band === "mistake" || band === "blunder" || band === "mate-transition") {
          token = BLD + BAND_STYLE[band].fg + plain + RST;
        }
      }

      if (lineWidth > 4 && lineWidth + 1 + plain.length > STRIP_WIDTH) {
        lines.push(line);
        line = "    ";
        lineWidth = 4;
      }
      line += (lineWidth > 4 ? " " : "") + token;
      lineWidth += (lineWidth > 4 ? 1 : 0) + plain.length;
    }
    if (lineWidth > 4) lines.push(line);
    if (lines.length === 0) {
      console.log("    " + DIM + "(sin jugadas)" + RST);
    }
    for (const out of lines) console.log(out);
  }
}

function printQuarantineNotice(report, id, reportPath) {
  const quarantined = (report.understanding?.quarantined ?? []).find((entry) => entry.id === id);
  console.log("\n  " + BYLW + "⚠" + RST + " " + BLD + "Partida en cuarentena" + RST);
  if (quarantined === undefined) {
    console.log("    No se generó un análisis utilizable para esta partida.");
  } else {
    console.log("    No se analizaron sus " + quarantined.plies + " pliegues porque la evidencia no pasó la validación.");
    const reasons = quarantined.rejectionReasons ?? [];
    if (reasons.length > 0) {
      console.log("    Motivo: " + reasons.slice(0, 3).join(", ") + (reasons.length > 3 ? ` · y ${reasons.length - 3} más` : ""));
    }
  }
  console.log("    " + DIM + "Reporte: " + RST + reportPath);
}

function startSpinner(label) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  const start = Date.now();
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - start) / 1000);
    process.stderr.write(`\r${frames[frame % frames.length]} ${label} ${String(seconds)}s`);
    frame += 1;
  }, 120);
  return () => {
    clearInterval(timer);
    process.stderr.write("\r\u001b[2K");
  };
}

function printAnalysis(reportPath, id, elapsed) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const oracle = report.oracle ?? { status: "unavailable" };
  const games = report.games ?? [];

  if (games.length === 0) {
    printQuarantineNotice(report, id, reportPath);
    console.log("\n  " + BYLW + "⚠" + RST + " " + BLD + "Análisis sin resultados" + RST + " · " + id + " · " + elapsed + " s");
    console.log("  " + DIM + "Oracle: " + RST + (oracle.status === "enabled" ? GRN : oracle.status === "degraded" ? YLW : RED) + oracle.status + RST + (typeof oracle.depth === "number" ? " · depth " + oracle.depth : ""));
    console.log("");
    return;
  }

  printSummary(games, oracle);
  printAttentionFindings(games);
  printGameStrip(games);

  // ── Footer ──
  console.log("\n  " + BGRN + "✓" + RST + " " + BLD + "Análisis terminado" + RST + " · " + id + " · " + elapsed + " s");
  console.log("  " + DIM + "Oracle: " + RST + (oracle.status === "enabled" ? GRN : oracle.status === "degraded" ? YLW : RED) + oracle.status + RST + (typeof oracle.depth === "number" ? " · depth " + oracle.depth : ""));
  console.log("  " + DIM + "Reporte: " + RST + reportPath);
  console.log("  " + DIM + "Siguiente: " + RST + "`just play-memory` para compilar la memoria del motor\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.pgnMode) {
      // Read PGN from stdin
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const pgnText = Buffer.concat(chunks).toString("utf8").trim();
      if (pgnText === "") {
        throw new Error("empty PGN from stdin — pipe a PGN or paste it then Ctrl+D");
      }
      const pgnId = safeId(`pgn-${Date.now().toString(36)}`);
      await analyzeRawPgn(pgnText, pgnId, args);
      process.exit(0);
    }

    const found = findGameRecord(args.id);
    if (found === null) {
      throw new Error(`no saved game found with id "${args.id}" in ${archiveDir}`);
    }
    const game = found.game;
    try { mkdirSync(tmpDir, { recursive: true }); } catch {}
    const singlePath = join(tmpDir, `${safeId(args.id)}.json`);
    writeFileSync(singlePath, `${JSON.stringify(game, null, 2)}\n`);
    const outputPath = args.output ?? join(archiveDir, `${safeId(args.id)}.analysis.json`);
    try { mkdirSync(dirname(outputPath), { recursive: true }); } catch {}
    const stockfish = resolveStockfishBinary();

    printHeader(args.id, game, args.depth, stockfish, args.ownedEngine);
    const label = args.ownedEngine
      ? `Analyzing ${String(game.moves.length)} plies (Oracle + Motor propio)…`
      : `Analyzing ${String(game.moves.length)} plies with Stockfish…`;
    const stopSpinner = startSpinner(label);
    const started = Date.now();
    let elapsed = "0.0";
    try {
      await runAnalyzer(singlePath, outputPath, args.depth, stockfish, args.ownedEngine);
      elapsed = ((Date.now() - started) / 1000).toFixed(1);
    } finally {
      stopSpinner();
    }
    printAnalysis(outputPath, args.id, elapsed);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exit(1);
  }
}

async function analyzeRawPgn(pgnText, pgnId, args) {
  // Replay PGN and build the archive record via the shared analyzer module.
  const record = buildPgnGameRecord(pgnText, pgnId, args.side ?? "white", args.depth);
  const moves = record.moves;
  try { mkdirSync(tmpDir, { recursive: true }); } catch {}
  const singlePath = join(tmpDir, `${pgnId}.json`);
  writeFileSync(singlePath, `${JSON.stringify(record, null, 2)}\n`);
  const outputPath = args.output ?? `${singlePath.replace(/\.json$/u, "")}.analysis.json`;
  try { mkdirSync(dirname(outputPath), { recursive: true }); } catch {}
  const stockfish = resolveStockfishBinary();

  printHeader(pgnId, record, args.depth, stockfish, args.ownedEngine);
  const label = args.ownedEngine
    ? `Analyzing ${String(moves.length)} plies (Oracle + Motor propio)…`
    : `Analyzing ${String(moves.length)} plies with Stockfish…`;
  const stopSpinner = startSpinner(label);
  const started = Date.now();
  let elapsed = "0.0";
  try {
    await runAnalyzer(singlePath, outputPath, args.depth, stockfish, args.ownedEngine);
    elapsed = ((Date.now() - started) / 1000).toFixed(1);
  } finally {
    stopSpinner();
  }
  printAnalysis(outputPath, pgnId, elapsed);
}

