import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import {
  evaluate,
  evaluateJson,
  reserveLoopbackPort,
  runCdpProof,
  waitFor
} from "./browser-proof-support.mjs";
import { playStockfishBinaryEnv } from "./play-local-stockfish-adapter.mjs";
import {
  preparePlayStockfishPreviewOutput,
  startPlayStockfishPreviewServer
} from "./preview-play-local-stockfish.mjs";

const proofRoot = "/private/tmp/chess-play-local-stockfish-loopback-preview-proof";
const fakeUciRoot = "/private/tmp/chess-play-local-stockfish-loopback-preview-fake-uci";
const viewports = [
  { width: 1280, height: 900, label: "desktop" },
  { width: 390, height: 844, label: "narrow" }
];
const allowedApiPaths = new Set([
  "/api/play/stockfish-status",
  "/api/play/stockfish-new-game",
  "/api/play/stockfish-best-move",
  "/api/play/stockfish-cancel"
]);

function writeFakeUci() {
  rmSync(fakeUciRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  mkdirSync(fakeUciRoot, { recursive: true });
  const binaryPath = join(fakeUciRoot, "fake-stockfish.mjs");
  const logPath = join(fakeUciRoot, "fake-stockfish.log");
  writeFileSync(
    binaryPath,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      'import { createInterface } from "node:readline";',
      `const logPath = ${JSON.stringify(logPath)};`,
      'let lastFen = "";',
      'const lines = createInterface({ input: process.stdin });',
      'lines.on("line", (line) => {',
      '  appendFileSync(logPath, `${line}\\n`, "utf8");',
      '  if (line === "uci") {',
      '    console.log("id name Fake Loopback Stockfish");',
      '    console.log("uciok");',
      '  } else if (line === "isready") {',
      '    console.log("readyok");',
      '  } else if (line === "ucinewgame") {',
      '    lastFen = "";',
      '  } else if (line.startsWith("position fen ")) {',
      '    lastFen = line.slice("position fen ".length);',
      '  } else if (line.startsWith("go ")) {',
      '    console.log("info depth 2 score cp 21 nodes 456");',
      '    console.log(`bestmove ${bestMoveFor(lastFen)}`);',
      '  } else if (line === "quit") {',
      '    process.exit(0);',
      '  }',
      '});',
      'function bestMoveFor(fen) {',
      '  if (fen.includes(" b ")) return "b8c6";',
      '  return "e2e4";',
      '}',
      ""
    ].join("\n"),
    "utf8"
  );
  chmodSync(binaryPath, 0o700);
  return { binaryPath, logPath };
}

function click(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
    element.click();
    return true;
  })()`;
}

function snapshot(label) {
  return `(() => {
    const issues = [];
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? null;
    const visible = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        issues.push({ kind: "missing", selector });
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) issues.push({ kind: "zero", selector });
      if (rect.left < -1 || rect.right > window.innerWidth + 1) {
        issues.push({ kind: "horizontal-overflow", selector, left: rect.left, right: rect.right });
      }
    };
    for (const selector of [
      '[data-play-ui="root"]',
      '[data-play-ui="header"]',
      '[data-play-ui="mode-label"]',
      '[data-play-ui="board"]',
      '[data-play-ui="board-grid"]',
      '[data-play-ui="side-panel"]'
    ]) visible(selector);
    const grid = document.querySelector('[data-play-ui="board-grid"]');
    if (grid instanceof HTMLElement) {
      const rect = grid.getBoundingClientRect();
      if (Math.abs(rect.width - rect.height) > 2) {
        issues.push({ kind: "grid-not-square", width: rect.width, height: rect.height });
      }
    }
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (pageWidth > window.innerWidth + 1) {
      issues.push({ kind: "page-overflow", pageWidth, viewportWidth: window.innerWidth });
    }
    for (const element of document.querySelectorAll('[data-play-ui="mode-label"], [data-play-ui="status"], [data-play-ui="new-game-button"], [data-play-ui="resign-button"], [data-play-ui="rematch-button"], [data-play-ui="post-game-review-button"]')) {
      if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1) {
        issues.push({ kind: "text-overflow", ui: element.getAttribute("data-play-ui") });
      }
    }
    const appReview = document.querySelector('[data-app-ui="post-game-review"]');
    return JSON.stringify({
      label: ${JSON.stringify(label)},
      viewport: { width: window.innerWidth, height: window.innerHeight },
      modeLabel: text('[data-play-ui="mode-label"]'),
      status: text('[data-play-ui="status"]'),
      orientation: attr('[data-play-ui="board"]', "data-board-orientation"),
      blackSide: attr('[data-play-ui="player-side-button"][data-player-side="black"]', "aria-pressed"),
      depth2: attr('[data-play-ui="engine-depth-button"][data-engine-depth="2"]', "aria-pressed"),
      moveRows: document.querySelectorAll('[data-play-ui="move-row"]').length,
      reviewDisabled: document.querySelector('[data-play-ui="post-game-review-button"]')?.hasAttribute("disabled") ?? null,
      rematchVisible: document.querySelector('[data-play-ui="rematch-button"]') !== null,
      appReviewVisible: appReview instanceof HTMLElement && !appReview.hidden,
      issues
    });
  })()`;
}

async function navigate(cdp, url, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.send("Page.navigate", { url });
  await waitFor(
    cdp,
    'document.querySelectorAll("[data-play-ui=\\"board-square\\"]").length === 64',
    "Play local Stockfish preview did not mount"
  );
}

async function runConfiguredViewport(cdp, url, viewport) {
  await navigate(cdp, url, viewport);
  const initial = await evaluateJson(cdp, snapshot(`${viewport.label}-local-initial`));
  assertCommon(initial, viewport);
  if (initial.modeLabel !== "Engine: Local Stockfish") {
    throw new Error(`${initial.label}: local Stockfish label mismatch`);
  }
  if (initial.reviewDisabled !== true) {
    throw new Error(`${initial.label}: non-terminal Review should be locked`);
  }

  await evaluate(cdp, click('[data-play-ui="player-side-button"][data-player-side="black"]'));
  await evaluate(cdp, click('[data-play-ui="engine-depth-button"][data-engine-depth="2"]'));
  await evaluate(cdp, click('[data-play-ui="new-game-button"]'));
  await waitFor(
    cdp,
    'document.querySelectorAll("[data-play-ui=\\"move-row\\"]").length === 1 && document.querySelector("[data-play-ui=\\"status\\"]")?.textContent?.trim() === "Black to move"',
    "Local Stockfish preview did not make the engine-first move"
  );
  const blackStart = await evaluateJson(cdp, snapshot(`${viewport.label}-local-black-start`));
  assertCommon(blackStart, viewport);
  if (
    blackStart.modeLabel !== "Engine: Local Stockfish" ||
    blackStart.orientation !== "black" ||
    blackStart.blackSide !== "true" ||
    blackStart.depth2 !== "true" ||
    blackStart.moveRows !== 1 ||
    blackStart.reviewDisabled !== true
  ) {
    throw new Error(`${blackStart.label}: local Stockfish side/depth/orientation state mismatch`);
  }

  await evaluate(cdp, click('[data-play-ui="resign-button"]'));
  await waitFor(
    cdp,
    'document.querySelector("[data-play-ui=\\"rematch-button\\"]") !== null && !document.querySelector("[data-play-ui=\\"post-game-review-button\\"]")?.hasAttribute("disabled")',
    "Resign did not open terminal Play actions"
  );
  await evaluate(cdp, click('[data-play-ui="post-game-review-button"]'));
  await waitFor(
    cdp,
    'document.querySelector("[data-app-ui=\\"post-game-review\\"]") instanceof HTMLElement && !document.querySelector("[data-app-ui=\\"post-game-review\\"]").hidden',
    "Terminal Play game did not open app-level Review"
  );
  const terminal = await evaluateJson(cdp, snapshot(`${viewport.label}-local-terminal-review`));
  assertCommon(terminal, viewport);
  if (terminal.reviewDisabled !== false || terminal.appReviewVisible !== true || terminal.rematchVisible !== true) {
    throw new Error(`${terminal.label}: terminal Review handoff mismatch`);
  }

  await evaluate(cdp, click('[data-play-ui="rematch-button"]'));
  await waitFor(
    cdp,
    'document.querySelectorAll("[data-play-ui=\\"move-row\\"]").length === 1 && document.querySelector("[data-app-ui=\\"post-game-review\\"]")?.hasAttribute("hidden")',
    "Rematch did not reset Play and hide stale Review"
  );
  const rematch = await evaluateJson(cdp, snapshot(`${viewport.label}-local-rematch`));
  assertCommon(rematch, viewport);
  if (
    rematch.modeLabel !== "Engine: Local Stockfish" ||
    rematch.orientation !== "black" ||
    rematch.depth2 !== "true" ||
    rematch.reviewDisabled !== true ||
    rematch.appReviewVisible !== false
  ) {
    throw new Error(`${rematch.label}: rematch state mismatch`);
  }
  return { initial, blackStart, terminal, rematch };
}

async function runFallbackViewport(cdp, url, viewport) {
  await navigate(cdp, url, viewport);
  await evaluate(cdp, click('[data-play-ui="player-side-button"][data-player-side="black"]'));
  await evaluate(cdp, click('[data-play-ui="engine-depth-button"][data-engine-depth="2"]'));
  await evaluate(cdp, click('[data-play-ui="new-game-button"]'));
  await waitFor(
    cdp,
    'document.querySelector("[data-play-ui=\\"mode-label\\"]")?.textContent?.trim() === "Engine: Owned local (Stockfish unavailable)" && document.querySelectorAll("[data-play-ui=\\"move-row\\"]").length === 1',
    "Missing Stockfish config did not fall back to owned engine"
  );
  const fallback = await evaluateJson(cdp, snapshot(`${viewport.label}-fallback`));
  assertCommon(fallback, viewport);
  if (
    fallback.modeLabel !== "Engine: Owned local (Stockfish unavailable)" ||
    fallback.orientation !== "black" ||
    fallback.blackSide !== "true" ||
    fallback.depth2 !== "true" ||
    fallback.status !== "Black to move" ||
    fallback.reviewDisabled !== true
  ) {
    throw new Error(`${fallback.label}: fallback state mismatch`);
  }
  return fallback;
}

function assertCommon(state, viewport) {
  if (state.viewport.width !== viewport.width) {
    throw new Error(`${state.label}: viewport drift`);
  }
  if (state.issues.length > 0) {
    throw new Error(`${state.label}: layout issues ${JSON.stringify(state.issues)}`);
  }
}

function assertOnlyPlayApiRequests(requests, label) {
  const apiRequests = requests.filter((request) => request.pathname.startsWith("/api/"));
  const forbidden = apiRequests.filter((request) => !allowedApiPaths.has(request.pathname));
  if (forbidden.length > 0) {
    throw new Error(`${label}: non-Play API request observed ${JSON.stringify(forbidden)}`);
  }
  if (apiRequests.some((request) => /review|trainer/u.test(request.pathname))) {
    throw new Error(`${label}: Review/trainer API request observed ${JSON.stringify(apiRequests)}`);
  }
  return apiRequests;
}

function assertFakeUciLog(logPath) {
  const log = readFileSync(logPath, "utf8");
  for (const expected of ["uci\n", "isready\n", "ucinewgame\n", "go depth 2\n", "quit\n"]) {
    if (!log.includes(expected)) {
      throw new Error(`fake UCI log missing ${JSON.stringify(expected)}`);
    }
  }
  if (!log.includes("position fen ")) {
    throw new Error("fake UCI log missing position fen command");
  }
}

async function expectHttpContract(url) {
  const status = await fetch(new URL("/api/play/stockfish-status", url));
  if (status.status !== 200) {
    throw new Error(`status endpoint returned HTTP ${String(status.status)}`);
  }
  const statusBody = await status.json();
  if (statusBody?.ok !== true || statusBody.value?.configured !== true) {
    throw new Error(`status endpoint body mismatch: ${JSON.stringify(statusBody)}`);
  }

  await expectHttpResponse(
    new URL("/api/play/stockfish-best-move", url),
    { method: "GET" },
    405,
    "unsupported method"
  );
  await expectHttpResponse(
    new URL("/api/play/stockfish-best-move", url),
    { method: "POST", headers: { "Content-Type": "text/plain" }, body: "fen" },
    400,
    "non-JSON body"
  );
  await expectHttpResponse(
    new URL("/api/play/stockfish-best-move", url),
    jsonRequest({ fen: "start", depth: 1 }),
    400,
    "missing legal moves"
  );
  await expectHttpResponse(
    new URL("/api/play/stockfish-best-move", url),
    jsonRequest({ fen: "start", depth: 0, legalMoves: ["e2e4"] }),
    400,
    "invalid depth"
  );
  await expectHttpResponse(
    new URL("/api/play/stockfish-best-move", url),
    jsonRequest({ fen: "start", depth: 1, legalMoves: ["e9e4"] }),
    400,
    "malformed legal move"
  );
  const illegalResult = await expectHttpResponse(
    new URL("/api/play/stockfish-best-move", url),
    jsonRequest({
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      depth: 2,
      legalMoves: ["a2a3"]
    }),
    200,
    "illegal provider result"
  );
  if (illegalResult?.ok !== false || illegalResult.error !== "search-failed") {
    throw new Error(`illegal provider result should fail closed: ${JSON.stringify(illegalResult)}`);
  }
  await expectHttpResponse(
    new URL("/api/play/stockfish-best-move", url),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fen: "x".repeat(20_000),
        depth: 1,
        legalMoves: ["e2e4"]
      })
    },
    400,
    "oversized body"
  );
}

function jsonRequest(body) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

async function expectHttpResponse(url, options, expectedStatus, label) {
  const response = await fetch(url, options);
  if (response.status !== expectedStatus) {
    throw new Error(`${label}: expected HTTP ${String(expectedStatus)}, got ${String(response.status)}`);
  }
  return response.headers.get("content-type")?.includes("application/json") === true
    ? response.json()
    : response.text();
}

const fakeUci = writeFakeUci();
const configuredEnv = {
  ...process.env,
  [playStockfishBinaryEnv]: fakeUci.binaryPath,
  CHESS_PLAY_STOCKFISH_PREVIEW_PORT: "0"
};
preparePlayStockfishPreviewOutput(proofRoot, configuredEnv);

const configuredServer = await startPlayStockfishPreviewServer({
  outputRoot: proofRoot,
  env: configuredEnv
});
let configuredEvidence;
try {
  await expectHttpContract(configuredServer.url);
  const debugPort = await reserveLoopbackPort();
  configuredEvidence = await runCdpProof(proofRoot, debugPort, async (cdp) => {
    const results = [];
    for (const viewport of viewports) {
      results.push({
        viewport: viewport.label,
        configured: await runConfiguredViewport(cdp, configuredServer.url, viewport)
      });
    }
    return results;
  });
} finally {
  await configuredServer.dispose();
}
assertFakeUciLog(fakeUci.logPath);
const configuredApiRequests = assertOnlyPlayApiRequests(
  configuredServer.requests,
  "configured preview"
);
if (!configuredApiRequests.some((request) => request.pathname === "/api/play/stockfish-best-move")) {
  throw new Error("configured preview did not request a local Stockfish best move");
}

const fallbackEnv = { ...process.env, CHESS_PLAY_STOCKFISH_PREVIEW_PORT: "0" };
delete fallbackEnv[playStockfishBinaryEnv];
const fallbackServer = await startPlayStockfishPreviewServer({
  outputRoot: proofRoot,
  env: fallbackEnv
});
let fallbackEvidence;
try {
  const debugPort = await reserveLoopbackPort();
  fallbackEvidence = await runCdpProof(proofRoot, debugPort, async (cdp) => {
    const results = [];
    for (const viewport of viewports) {
      results.push({
        viewport: viewport.label,
        fallback: await runFallbackViewport(cdp, fallbackServer.url, viewport)
      });
    }
    return results;
  });
} finally {
  await fallbackServer.dispose();
}
const fallbackApiRequests = assertOnlyPlayApiRequests(fallbackServer.requests, "fallback preview");
if (fallbackApiRequests.length !== 0) {
  throw new Error(`fallback preview should not call Play Stockfish endpoints: ${JSON.stringify(fallbackApiRequests)}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      configuredApiRequests,
      configuredEvidence,
      fallbackApiRequests,
      fallbackEvidence
    },
    null,
    2
  )
);
