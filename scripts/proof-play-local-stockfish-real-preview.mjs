import { rmSync } from "node:fs";
import { evaluate, evaluateJson, reserveLoopbackPort, runCdpProof, waitFor } from "./browser-proof-support.mjs";
import { createLocalStockfishBestMoveProvider, playStockfishBinaryEnv, resolvePlayStockfishBinary } from "./play-local-stockfish-adapter.mjs";
import { preparePlayStockfishPreviewOutput, startPlayStockfishPreviewServer } from "./preview-play-local-stockfish.mjs";

const proofRoot = "/private/tmp/chess-play-local-stockfish-real-preview-proof";
const viewports = [{ label: "desktop", width: 1280, height: 900 }, { label: "narrow", width: 390, height: 844 }];
const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const startLegalMoves = ["a2a3", "a2a4", "b2b3", "b2b4", "c2c3", "c2c4", "d2d3", "d2d4", "e2e3", "e2e4", "f2f3", "f2f4", "g2g3", "g2g4", "h2h3", "h2h4", "b1a3", "b1c3", "g1f3", "g1h3"];
const allowedApiPaths = new Set(["/api/play/stockfish-status", "/api/play/stockfish-new-game", "/api/play/stockfish-best-move", "/api/play/stockfish-cancel"]);

function withoutStockfishEnv() {
  const env = { ...process.env, CHESS_PLAY_STOCKFISH_PREVIEW_PORT: "0" };
  delete env[playStockfishBinaryEnv];
  return env;
}

function click(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error(${JSON.stringify(`missing ${selector}`)});
    element.click();
    return true;
  })()`;
}

function snapshot(label) {
  return `(() => {
    const q = (selector) => document.querySelector(selector);
    const text = (selector) => q(selector)?.textContent?.trim() ?? "";
    const attr = (selector, name) => q(selector)?.getAttribute(name) ?? null;
    const issues = [];
    const check = (selector) => {
      const element = q(selector);
      if (!(element instanceof HTMLElement)) {
        issues.push({ kind: "missing", selector });
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) issues.push({ kind: "zero", selector });
      if (rect.left < -1 || rect.right > window.innerWidth + 1) issues.push({ kind: "overflow", selector });
    };
    ['[data-play-ui="root"]', '[data-play-ui="mode-label"]', '[data-play-ui="board"]', '[data-play-ui="board-grid"]', '[data-play-ui="side-panel"]'].forEach(check);
    const grid = q('[data-play-ui="board-grid"]');
    if (grid instanceof HTMLElement) {
      const rect = grid.getBoundingClientRect();
      if (Math.abs(rect.width - rect.height) > 2) issues.push({ kind: "grid-not-square" });
    }
    if (Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth + 1) issues.push({ kind: "page-overflow" });
    for (const element of document.querySelectorAll('[data-play-ui="mode-label"], [data-play-ui="status"], [data-play-ui="new-game-button"]')) {
      if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1) issues.push({ kind: "text-overflow", ui: element.getAttribute("data-play-ui") });
    }
    return JSON.stringify({
      label: ${JSON.stringify(label)},
      viewport: { width: window.innerWidth, height: window.innerHeight },
      modeLabel: text('[data-play-ui="mode-label"]'),
      status: text('[data-play-ui="status"]'),
      orientation: attr('[data-play-ui="board"]', "data-board-orientation"),
      blackSide: attr('[data-play-ui="player-side-button"][data-player-side="black"]', "aria-pressed"),
      depth2: attr('[data-play-ui="engine-depth-button"][data-engine-depth="2"]', "aria-pressed"),
      moveRows: document.querySelectorAll('[data-play-ui="move-row"]').length,
      reviewDisabled: q('[data-play-ui="post-game-review-button"]')?.hasAttribute("disabled") ?? null,
      issues
    });
  })()`;
}

async function navigate(cdp, url, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url });
  await waitFor(cdp, 'document.querySelectorAll("[data-play-ui=\\"board-square\\"]").length === 64', "Play real Stockfish preview did not mount");
}

function assertState(state, viewport, expectedMode) {
  if (state.viewport.width !== viewport.width || state.modeLabel !== expectedMode || state.issues.length > 0) {
    throw new Error(`${state.label}: state mismatch ${JSON.stringify(state)}`);
  }
}

async function proveBlackStart(cdp, url, viewport, expectedMode) {
  await navigate(cdp, url, viewport);
  const initial = await evaluateJson(cdp, snapshot(`${viewport.label}-initial`));
  assertState(initial, viewport, expectedMode);
  if (initial.status !== "White to move" || initial.reviewDisabled !== true) {
    throw new Error(`${initial.label}: initial Play state mismatch`);
  }
  await evaluate(cdp, click('[data-play-ui="player-side-button"][data-player-side="black"]'));
  await evaluate(cdp, click('[data-play-ui="engine-depth-button"][data-engine-depth="2"]'));
  await evaluate(cdp, click('[data-play-ui="new-game-button"]'));
  await waitFor(cdp, 'document.querySelectorAll("[data-play-ui=\\"move-row\\"]").length === 1 && document.querySelector("[data-play-ui=\\"status\\"]")?.textContent?.trim() === "Black to move"', "Preview did not make the engine-first move");
  const blackStart = await evaluateJson(cdp, snapshot(`${viewport.label}-black-start`));
  assertState(blackStart, viewport, expectedMode);
  if (blackStart.orientation !== "black" || blackStart.blackSide !== "true" || blackStart.depth2 !== "true" || blackStart.moveRows !== 1 || blackStart.reviewDisabled !== true) {
    throw new Error(`${blackStart.label}: black-start state mismatch ${JSON.stringify(blackStart)}`);
  }
  return { initial, blackStart };
}

async function browserProof(server, expectedMode) {
  const debugPort = await reserveLoopbackPort();
  return runCdpProof(proofRoot, debugPort, async (cdp) => {
    const evidence = [];
    for (const viewport of viewports) {
      evidence.push({ viewport: viewport.label, state: await proveBlackStart(cdp, server.url, viewport, expectedMode) });
    }
    return evidence;
  });
}

async function readStatus(url) {
  const response = await fetch(new URL("/api/play/stockfish-status", url));
  if (response.status !== 200) throw new Error(`status endpoint returned HTTP ${String(response.status)}`);
  const body = await response.json();
  if (body?.ok !== true) throw new Error(`status endpoint body mismatch ${JSON.stringify(body)}`);
  return body.value;
}

function assertOnlyPlayApiRequests(requests, label) {
  const apiRequests = requests.filter((request) => request.pathname.startsWith("/api/"));
  const forbidden = apiRequests.filter((request) => !allowedApiPaths.has(request.pathname) || /review|trainer/u.test(request.pathname));
  if (forbidden.length > 0) throw new Error(`${label}: forbidden API request ${JSON.stringify(apiRequests)}`);
  return apiRequests;
}

async function proveNoBinaryDirect() {
  const provider = createLocalStockfishBestMoveProvider(resolvePlayStockfishBinary(withoutStockfishEnv()));
  const result = await provider.bestMove(startFen, 1, startLegalMoves);
  await provider.dispose?.();
  if (provider.isAvailable() !== false || result?.ok !== false || result.error !== "search-failed") {
    throw new Error(`no-binary direct proof should fail closed ${JSON.stringify(result)}`);
  }
  return { available: provider.isAvailable(), result };
}

async function proveRealDirect(config) {
  const provider = createLocalStockfishBestMoveProvider(config);
  try {
    await provider.prepareNewGame();
    const result = await provider.bestMove(startFen, 1, startLegalMoves);
    if (result?.ok !== true || !startLegalMoves.includes(result.value.bestMove)) {
      throw new Error(`real direct proof returned an illegal result ${JSON.stringify(result)}`);
    }
    return { binaryPath: config.binaryPath, bestMove: result.value.bestMove, depth: result.value.depth, nodes: result.value.nodes, scoreCp: result.value.scoreCp };
  } finally {
    await provider.dispose?.();
  }
}

async function provePreview(env, expectedMode) {
  const server = await startPlayStockfishPreviewServer({ outputRoot: proofRoot, env });
  try {
    return {
      status: await readStatus(server.url),
      browser: await browserProof(server, expectedMode),
      get apiRequests() {
        return assertOnlyPlayApiRequests(server.requests, expectedMode);
      }
    };
  } finally {
    await server.dispose();
  }
}

const suppliedBinary = process.env[playStockfishBinaryEnv]?.trim() ?? "";
const requestedRealProof = suppliedBinary !== "";
const realConfig = resolvePlayStockfishBinary(process.env);
if (requestedRealProof && !realConfig.ok) {
  throw new Error(`${playStockfishBinaryEnv} was supplied but is ${realConfig.reason}`);
}

rmSync(proofRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
preparePlayStockfishPreviewOutput(proofRoot, requestedRealProof ? process.env : withoutStockfishEnv());

const noBinaryEvidence = {
  direct: await proveNoBinaryDirect(),
  preview: await provePreview(withoutStockfishEnv(), "Engine: Owned local (Stockfish unavailable)")
};
if (noBinaryEvidence.preview.status.configured !== false || noBinaryEvidence.preview.status.available !== false || noBinaryEvidence.preview.status.reason !== "not-configured") {
  throw new Error(`no-binary status mismatch ${JSON.stringify(noBinaryEvidence.preview.status)}`);
}
const noBinaryAdapterRequests = noBinaryEvidence.preview.apiRequests.filter((request) => request.pathname !== "/api/play/stockfish-status");
if (noBinaryAdapterRequests.length > 0) {
  throw new Error(`no-binary fallback called adapter endpoints ${JSON.stringify(noBinaryAdapterRequests)}`);
}

let realEvidence = null;
if (requestedRealProof) {
  realEvidence = {
    direct: await proveRealDirect(realConfig),
    preview: await provePreview({ ...process.env, CHESS_PLAY_STOCKFISH_PREVIEW_PORT: "0" }, "Engine: Local Stockfish")
  };
  if (realEvidence.preview.status.configured !== true || realEvidence.preview.status.available !== true || !realEvidence.preview.apiRequests.some((request) => request.pathname === "/api/play/stockfish-best-move")) {
    throw new Error(`real preview proof mismatch ${JSON.stringify(realEvidence.preview)}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  proofRoot,
  realProof: requestedRealProof ? "passed" : "skipped",
  realProofSkippedReason: requestedRealProof ? null : `${playStockfishBinaryEnv} not supplied`,
  noBinaryEvidence,
  realEvidence
}, null, 2));
