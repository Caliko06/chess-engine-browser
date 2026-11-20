// Same-origin Analyzer endpoint foundation for the local preview server.
// Local-only. It reuses the exact CLI pipeline (analyze-game.mjs →
// play-game-archive-analyze.mjs) so HTML results carry identical oracle semantics:
// Stockfish bands, verdict, and quarantine. Stockfish is optional validation
// evidence, never a runtime dependency (ADR-0242).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPgnGameRecord,
  findGameRecord
} from "./play-analyzer-shared.mjs";
import { resolveStockfishBinary } from "./play-memory-update.mjs";

const maxAnalyzerBodyBytes = 512 * 1024;
const minDepth = 1;
const maxDepth = 30;

export function analyzerRoot(outputRoot) {
  return join(outputRoot, "analyzer");
}

export function readBoundedAnalyzerBody(request, maxBytes = maxAnalyzerBodyBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("analyzer body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function parseAnalyzeRequest(value) {
  if (value === null || typeof value !== "object") {
    throw new Error("invalid analyze request");
  }
  const request = value;
  if (request.mode !== "pgn" && request.mode !== "archive") {
    throw new Error("invalid analyze mode");
  }
  const depth = request.depth === undefined ? 12 : request.depth;
  if (!Number.isInteger(depth) || depth < minDepth || depth > maxDepth) {
    throw new Error("invalid analyze depth");
  }
  const ownedEngine = request.ownedEngine === true;
  if (request.mode === "pgn") {
    if (typeof request.pgn !== "string" || request.pgn.trim() === "") {
      throw new Error("invalid analyze pgn");
    }
    if (request.side !== undefined && request.side !== "white" && request.side !== "black") {
      throw new Error("invalid analyze side");
    }
    return { mode: "pgn", depth, ownedEngine, pgn: request.pgn, side: request.side ?? "white" };
  }
  if (typeof request.id !== "string" || request.id.trim() === "") {
    throw new Error("invalid analyze id");
  }
  return { mode: "archive", depth, ownedEngine, id: request.id };
}

// Builds the exact CLI input/output pair for one analysis run. The id is safe by
// construction (CLI `safeId` alphabet), so the report path cannot escape the root.
export function prepareAnalyzerRun(request, outputRoot, id) {
  const safe = id.replace(/[^a-zA-Z0-9_-]/gu, "_");
  const root = analyzerRoot(outputRoot);
  const inputPath = join(root, `${safe}.json`);
  const outputPath = join(root, `${safe}.analysis.json`);
  const record = request.mode === "pgn"
    ? buildPgnGameRecord(request.pgn, id, request.side, request.depth)
    : findGameRecord(request.id)?.game ?? null;
  if (record === null) {
    return null;
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(inputPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { inputPath, outputPath, record };
}

export function analyzeRecord(inputPath, outputPath, depth, ownedEngine) {
  const stockfish = resolveStockfishBinary();
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
    const child = spawn("node", args, { cwd: process.cwd(), env });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, oracle: stockfish.ok ? "enabled" : "unavailable" });
        return;
      }
      reject(new Error(`analysis failed: ${stderr.trim() || "unknown"}`));
    });
  });
}

// Validates the report shape the web surface renders. Quarantined games are
// preserved so the UI can show the honest quarantine state.
export function readAnalyzerReport(path) {
  if (!existsSync(path)) {
    return null;
  }
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (report === null || typeof report !== "object" || Array.isArray(report.games) === false) {
    throw new Error("invalid analyzer report");
  }
  return report;
}

export async function handleAnalyzerAnalyze(request, response, outputRoot) {
  if (request.method !== "POST") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("method not allowed");
    return;
  }
  let body;
  try {
    body = await readBoundedAnalyzerBody(request);
  } catch {
    response.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "analyzer body too large" }));
    return;
  }
  let requestValue;
  try {
    requestValue = parseAnalyzeRequest(JSON.parse(body));
  } catch (error) {
    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid analyze request" }));
    return;
  }
  const id = requestValue.mode === "pgn"
    ? `pgn-${Date.now().toString(36)}`
    : requestValue.id;
  let prepared;
  try {
    prepared = prepareAnalyzerRun(requestValue, outputRoot, id);
  } catch (error) {
    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid analyze request" }));
    return;
  }
  if (prepared === null) {
    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "saved game not found" }));
    return;
  }
  try {
    await analyzeRecord(prepared.inputPath, prepared.outputPath, requestValue.depth, requestValue.ownedEngine);
    const report = readAnalyzerReport(prepared.outputPath);
    if (report === null) {
      throw new Error("analysis report missing");
    }
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, id, path: prepared.outputPath, report }));
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "analysis failed" }));
  }
}

// Smoke helper: guarantees an isolated analyzer output root per proof run.
export function analyzerSmokeRoot() {
  const root = join(tmpdir(), `chess-analyzer-smoke-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}
