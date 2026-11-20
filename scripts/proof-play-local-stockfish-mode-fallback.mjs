import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { betaCsp, repoRoot, run } from "./beta-preview-support.mjs";
import {
  evaluate,
  evaluateJson,
  reserveLoopbackPort,
  runCdpProof,
  startStaticServer,
  waitFor
} from "./browser-proof-support.mjs";

const proofRoot = "/private/tmp/chess-play-local-stockfish-mode-fallback-proof";
const viewports = [
  { width: 1280, height: 900, label: "desktop" },
  { width: 390, height: 844, label: "narrow" }
];

function prepareOutput() {
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(proofRoot, { recursive: true });
  run("node", ["scripts/audit-policy.mjs"]);
  run("pnpm", ["--filter", "web", "run", "build"]);
  cpSync(join(repoRoot, "apps/web/dist"), join(proofRoot, "dist"), { recursive: true });
  cpSync(join(repoRoot, "apps/web/assets"), join(proofRoot, "assets"), { recursive: true });
  cpSync(join(repoRoot, "apps/web/review.css"), join(proofRoot, "review.css"));
  writeFileSync(
    join(proofRoot, "index.html"),
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<meta http-equiv="Content-Security-Policy" content="${betaCsp}">`,
      '<link rel="stylesheet" href="./review.css">',
      "<title>Play local engine mode proof</title>",
      "</head>",
      "<body>",
      '<main id="chess-review-app"></main>',
      '<script type="module" src="./proof-app.mjs"></script>',
      "</body>",
      "</html>",
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(join(proofRoot, "proof-app.mjs"), proofAppSource(), "utf8");
}

function proofAppSource() {
  return String.raw`import { createHybridPlayEngine } from "./dist/play-engine.js";
import { mountPlayUi } from "./dist/play-ui.js";

const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const afterE4Fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const afterC6Fen = "r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2";

const startState = {
  fen: startFen,
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["e2e4"]
};
const afterE4State = {
  fen: afterE4Fen,
  status: "ongoing",
  sideToMove: "black",
  legalMoves: ["b8c6"]
};
const afterC6State = {
  fen: afterC6Fen,
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["g1f3"]
};

window.__proofState = {
  ownedCancel: 0,
  stockfishCancel: 0,
  ownedBestMoveArgs: [],
  stockfishBestMoveArgs: [],
  ready: false
};

const ownedEngine = {
  mode: () => "owned-local",
  cancelSearch: () => {
    window.__proofState.ownedCancel += 1;
  },
  newGame: async () => ({ ok: true, value: startState }),
  makeMove: async (_fen, move) => {
    if (move === "e2e4") {
      return { ok: true, value: { appliedMove: move, san: "e4", state: afterE4State } };
    }
    if (move === "b8c6") {
      return { ok: true, value: { appliedMove: move, san: "Nc6", state: afterC6State } };
    }
    return { ok: false, error: "invalid-move" };
  },
  bestMove: async (fen, depth, legalMoves) => {
    window.__proofState.ownedBestMoveArgs.push({ fen, depth, legalMoves: [...(legalMoves ?? [])] });
    const bestMove = fen === startFen ? "e2e4" : "b8c6";
    return { ok: true, value: { bestMove, depth, scoreCp: 8, nodes: 42, ttHits: 0 } };
  }
};

const localStockfishProvider = {
  isAvailable: () => true,
  cancelSearch: () => {
    window.__proofState.stockfishCancel += 1;
  },
  prepareNewGame: async () => ({ ok: true, value: undefined }),
  bestMove: async (fen, depth, legalMoves) => {
    window.__proofState.stockfishBestMoveArgs.push({ fen, depth, legalMoves: [...(legalMoves ?? [])] });
    return { ok: true, value: { bestMove: "a7a6", depth, scoreCp: 20, nodes: 77, ttHits: 0 } };
  }
};

const params = new URLSearchParams(window.location.search);
const engine =
  params.get("mode") === "owned"
    ? ownedEngine
    : createHybridPlayEngine({ owned: ownedEngine, stockfishProvider: localStockfishProvider });
const root = document.getElementById("chess-review-app");
await mountPlayUi(root, { engine }).ready;
window.__proofState.ready = true;
`;
}

function click(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLButtonElement)) return false;
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
      if (Math.abs(rect.width - rect.height) > 2) issues.push({ kind: "grid-not-square", width: rect.width, height: rect.height });
    }
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (pageWidth > window.innerWidth + 1) {
      issues.push({ kind: "page-overflow", pageWidth, viewportWidth: window.innerWidth });
    }
    for (const element of document.querySelectorAll('[data-play-ui="mode-label"], [data-play-ui="status"], [data-play-ui="new-game-button"], [data-play-ui="resign-button"], [data-play-ui="post-game-review-button"]')) {
      if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1) {
        issues.push({ kind: "text-overflow", ui: element.getAttribute("data-play-ui") });
      }
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
      reviewDisabled: document.querySelector('[data-play-ui="post-game-review-button"]')?.hasAttribute("disabled") ?? null,
      proofState: window.__proofState,
      issues
    });
  })()`;
}

async function navigate(cdp, server, viewport, mode) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/index.html?mode=${mode}` });
  await waitFor(
    cdp,
    "window.__proofState?.ready === true && document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64",
    `Play ${mode} proof did not mount`
  );
}

async function runOwnedViewport(cdp, server, viewport) {
  await navigate(cdp, server, viewport, "owned");
  const initial = await evaluateJson(cdp, snapshot(`${viewport.label}-owned-initial`));
  assertCommon(initial, viewport);
  if (initial.modeLabel !== "Engine: Owned local") throw new Error(`${initial.label}: owned mode label mismatch`);
  await evaluate(cdp, click('[data-play-ui="player-side-button"][data-player-side="black"]'));
  await evaluate(cdp, click('[data-play-ui="engine-depth-button"][data-engine-depth="2"]'));
  await evaluate(cdp, click('[data-play-ui="new-game-button"]'));
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 1 && document.querySelector('[data-play-ui=\"status\"]')?.textContent?.trim() === 'Black to move'",
    "owned remount did not preserve Black side with engine-first move"
  );
  const remounted = await evaluateJson(cdp, snapshot(`${viewport.label}-owned-remounted`));
  assertCommon(remounted, viewport);
  if (remounted.modeLabel !== "Engine: Owned local") throw new Error(`${remounted.label}: owned remount label mismatch`);
  if (remounted.orientation !== "black" || remounted.blackSide !== "true" || remounted.depth2 !== "true") {
    throw new Error(`${remounted.label}: side/depth/orientation not preserved`);
  }
  if (remounted.moveRows !== 1 || remounted.reviewDisabled !== true) {
    throw new Error(`${remounted.label}: fresh Play state mismatch`);
  }
  return { initial, remounted };
}

async function runStockfishViewport(cdp, server, viewport) {
  await navigate(cdp, server, viewport, "stockfish");
  await evaluate(cdp, click('[data-play-ui="engine-depth-button"][data-engine-depth="2"]'));
  const initial = await evaluateJson(cdp, snapshot(`${viewport.label}-stockfish-initial`));
  assertCommon(initial, viewport);
  if (initial.modeLabel !== "Engine: Local Stockfish") {
    throw new Error(`${initial.label}: local Stockfish label mismatch`);
  }

  await evaluate(cdp, click('[data-play-ui="board-square"][data-square="e2"]'));
  await evaluate(cdp, click('[data-play-ui="board-square"][data-square="e4"]'));
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 2 && document.querySelector('[data-play-ui=\"mode-label\"]')?.textContent?.trim() === 'Engine: Owned local (Stockfish unavailable)'",
    "Stockfish fallback label did not appear"
  );
  const fallback = await evaluateJson(cdp, snapshot(`${viewport.label}-stockfish-fallback`));
  assertCommon(fallback, viewport);
  if (fallback.status !== "White to move" || fallback.moveRows !== 2 || fallback.depth2 !== "true") {
    throw new Error(`${fallback.label}: fallback Play state mismatch`);
  }
  const stockfishMove = fallback.proofState.stockfishBestMoveArgs[0];
  if (JSON.stringify(stockfishMove?.legalMoves) !== JSON.stringify(["b8c6"])) {
    throw new Error(`${fallback.label}: legal move contract was not passed to provider`);
  }
  if (fallback.proofState.ownedBestMoveArgs.length !== 1) {
    throw new Error(`${fallback.label}: owned fallback was not used exactly once`);
  }

  await evaluate(cdp, click('[data-play-ui="new-game-button"]'));
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 0 && document.querySelector('[data-play-ui=\"status\"]')?.textContent?.trim() === 'White to move'",
    "New Game did not recover to a fresh Play board"
  );
  const reset = await evaluateJson(cdp, snapshot(`${viewport.label}-stockfish-reset`));
  assertCommon(reset, viewport);
  if (reset.modeLabel !== "Engine: Owned local (Stockfish unavailable)" || reset.depth2 !== "true") {
    throw new Error(`${reset.label}: fallback mode/depth was not preserved after New Game`);
  }
  if (reset.proofState.stockfishCancel < 1 || reset.proofState.ownedCancel < 1) {
    throw new Error(`${reset.label}: New Game did not cancel active engine seams`);
  }
  return { initial, fallback, reset };
}

function assertCommon(state, viewport) {
  if (state.viewport.width !== viewport.width) throw new Error(`${state.label}: viewport drift`);
  if (state.issues.length > 0) throw new Error(`${state.label}: layout issues ${JSON.stringify(state.issues)}`);
  if (state.reviewDisabled !== true) throw new Error(`${state.label}: Review leaked before terminal game`);
}

prepareOutput();
const server = await startStaticServer(proofRoot, betaCsp);
try {
  const debugPort = await reserveLoopbackPort();
  const evidence = await runCdpProof(proofRoot, debugPort, async (cdp) => {
    const results = [];
    for (const viewport of viewports) {
      results.push({
        viewport: viewport.label,
        owned: await runOwnedViewport(cdp, server, viewport),
        stockfish: await runStockfishViewport(cdp, server, viewport)
      });
    }
    return results;
  });
  console.log(JSON.stringify({ ok: true, evidence, requests: server.requests }, null, 2));
} finally {
  await new Promise((resolve) => server.server.close(resolve));
}
