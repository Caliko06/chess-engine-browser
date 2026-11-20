import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  evaluate,
  evaluateJson,
  reserveLoopbackPort,
  runCdpProof,
  startStaticServer,
  waitFor
} from "../../../scripts/browser-proof-support.mjs";

// Contractual UI proof only: this harness deliberately uses deterministic fixtures. The
// production Worker/WASM path is verified by proof-explore-aggressive-runtime.mjs.

const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
const webRoot = join(repoRoot, "apps/web");
const proofRoot = "/private/tmp/g0262-v5-proof";
const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; connect-src 'self'";
const g1Fen = "3R4/5ppk/7p/5P2/q7/1p6/3R2PP/7K w - - 0 36";
const g1AfterD2D1Fen = "3R4/5ppk/7p/5P2/q7/1p6/6PP/3R3K b - - 1 36";
const g1AfterD2D4Fen = "3R4/5ppk/7p/5P2/q2R4/1p6/6PP/7K b - - 1 36";
const expectedPlayPieceSet = "adr-0206-cburnett-v1";
const viewports = [
  { label: "desktop-1440x900", width: 1440, height: 900, mobile: false },
  { label: "desktop-1366x768", width: 1366, height: 768, mobile: false },
  { label: "desktop-1280x800", width: 1280, height: 800, mobile: false },
  { label: "desktop-1920x1080", width: 1920, height: 1080, mobile: false },
  { label: "phone-390", width: 390, height: 844, mobile: true }
];

function assert(condition, message, context) {
  if (!condition) throw new Error(`${message}${context === undefined ? "" : `: ${JSON.stringify(context)}`}`);
}

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function prepareProofRoot() {
  run("npm", ["run", "build"], webRoot);
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(proofRoot, { recursive: true });
  cpSync(join(webRoot, "dist"), join(proofRoot, "dist"), { recursive: true });
  cpSync(join(webRoot, "assets"), join(proofRoot, "assets"), { recursive: true });
  cpSync(join(webRoot, "review.css"), join(proofRoot, "review.css"));
  writeFileSync(join(proofRoot, "index.html"), harnessHtml());
}

function candidate(move, exactScoreCp, sound, continuation = null) {
  return {
    move,
    kind: "defense",
    exactScoreCp,
    sound,
    sacrifice: false,
    mateIn: null,
    aftermath: null,
    continuation,
    prospectiveBrilliant: false
  };
}

function harnessHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Explore Aggressive board-first proof</title><link rel="stylesheet" href="./review.css"></head><body><main id="chess-review-app"><div id="proof-root"></div></main><script type="module">
import { mountPlayUi } from "./dist/play-ui.js";
const g1Fen = ${JSON.stringify(g1Fen)};
const g1AfterD2D1Fen = ${JSON.stringify(g1AfterD2D1Fen)};
const g1AfterD2D4Fen = ${JSON.stringify(g1AfterD2D4Fen)};
const states = new Map([
  [g1Fen, { fen: g1Fen, status: "ongoing", sideToMove: "white", legalMoves: ["d2d1", "d2d4", "d2d3", "h2h4"] }],
  [g1AfterD2D1Fen, { fen: g1AfterD2D1Fen, status: "ongoing", sideToMove: "black", legalMoves: ["a4a1"] }],
  [g1AfterD2D4Fen, { fen: g1AfterD2D4Fen, status: "ongoing", sideToMove: "black", legalMoves: ["a4d4"] }]
]);
const sideExploreCalls = [];
const query = new URLSearchParams(window.location.search);
const fallbackMode = query.get("fallback") === "1";
const stateMode = query.get("state");
const riskMode = query.get("risk") === "1";
const pendingMode = stateMode === "pending";
const failedMode = stateMode === "failed";
const loadingMode = stateMode === "loading";
const rootErrorMode = stateMode === "error";
const terminalMode = stateMode === "terminal";
const ok = (value) => Promise.resolve({ ok: true, value });
const fail = (error = "search-failed") => Promise.resolve({ ok: false, error });
const candidate = ${candidate.toString()};
const sideExploreDto = (fen, side) => {
  const state = states.get(fen);
  if (state === undefined) return null;
  if (fen === g1AfterD2D1Fen) return {
    state, side, onTurn: side === "black",
    replyCandidates: side === "black" ? [] : [{ move: "a4a1", kind: "capture", quality: "best", sound: true, sacrifice: false, mateIn: null }],
    candidates: side === "black" ? [candidate("a4a1", -190, true)] : [candidate("d1d8", -190, true)],
    principalLine: side === "black" ? ["a4a1", "d1d8"] : ["d1d8"], mateDetected: false, depth: 3, nodes: 32000, soundMarginCp: 300,
    planStatus: "followed", planReason: "matched-history-and-gate"
  };
  if (fen === g1AfterD2D4Fen) return {
    state, side, onTurn: side === "black",
    replyCandidates: [],
    candidates: [candidate("a4d4", 420, true)],
    principalLine: ["a4d4"], mateDetected: false, depth: 3, nodes: 28000, soundMarginCp: 300,
    planStatus: "replaced", planReason: "live-board-recomputed"
  };
  if (side === "black") return {
    state, side, onTurn: false,
    replyCandidates: [
      { move: "d2d1", kind: "defense", quality: "best", sound: true, sacrifice: false, mateIn: null },
      { move: "d2d4", kind: "defense", quality: "blunder", sound: false, sacrifice: false, mateIn: null }
    ],
    candidates: [candidate("a4a1", -190, true)],
    principalLine: ["a4a1"], mateDetected: false, depth: 3, nodes: 30000, soundMarginCp: 300,
    planStatus: "none", planReason: "no-previous-line"
  };
  const value = {
    state, side, onTurn: true, replyCandidates: [],
    candidates: [
      candidate("d2d1", -163, true, "d1d8"),
      candidate("d2d4", -468, true),
      candidate("d2d3", -260, false),
      candidate("h2h4", -610, false)
    ],
    principalLine: ["d2d1", "a4a1", "d1d8"], mateDetected: false, depth: 3, nodes: 42000,
    soundMarginCp: 300, planStatus: "none", planReason: "no-previous-line"
  };
  return riskMode
    ? { ...value, candidates: value.candidates.map((item, index) => index === 0 ? { ...item, sound: false } : item) }
    : value;
};
const engine = {
  mode: () => "owned-local",
  newGame: () => loadingMode ? new Promise(() => {}) : rootErrorMode ? fail("operation-failed") : ok(states.get(g1Fen)),
  loadPosition: (fen) => states.has(fen) ? ok(states.get(fen)) : fail("invalid-fen"),
  makeMove: (fen, move) => {
    if (fen === g1Fen && move === "d2d1") {
      if (terminalMode) return ok({ appliedMove: move, san: "Rd1#", state: { fen: g1AfterD2D1Fen, status: "checkmate", sideToMove: "black", legalMoves: [] } });
      return ok({ appliedMove: move, san: "Rd1", state: states.get(g1AfterD2D1Fen) });
    }
    if (fen === g1Fen && move === "d2d4") return ok({ appliedMove: move, san: "Rd4", state: states.get(g1AfterD2D4Fen) });
    if (fen === g1AfterD2D1Fen && move === "a4a1") return ok({ appliedMove: move, san: "Qa1", state: { fen: "8/5ppk/7p/5P2/8/1p6/6PP/q2R3K w - - 2 37", status: "ongoing", sideToMove: "white", legalMoves: ["d1a1"] } });
    if (fen === g1AfterD2D4Fen && move === "a4d4") return ok({ appliedMove: move, san: "Qxd4", state: { fen: "3R4/5ppk/7p/5P2/3q4/1p6/6PP/7K w - - 0 37", status: "ongoing", sideToMove: "white", legalMoves: ["d8d4"] } });
    return fail("invalid-move");
  },
  bestMove: (_fen, depth) => pendingMode || failedMode ? fail() : ok({ bestMove: "d2d1", depth, scoreCp: -163, nodes: 1, ttHits: 0, principalLine: ["d2d1", "a4a1", "d1d8"] }),
  sideExplore: (fen, side, aggressive, historyFens, context) => {
    sideExploreCalls.push({ fen, side, aggressive, historyFens, context });
    const value = sideExploreDto(fen, side);
    if (value === null) return fail("invalid-fen");
    if (failedMode) return fail();
    if (pendingMode) return new Promise(() => {});
    return fallbackMode ? new Promise((resolve) => setTimeout(() => resolve({ ok: true, value }), 80)) : ok(value);
  },
  reactionMap: () => fail(),
  forcingMap: () => fail()
};
const proofRoot = document.getElementById("proof-root");
if (!(proofRoot instanceof HTMLElement)) throw new Error("proof root did not mount");
const runtimeErrors = [];
const recordRuntimeError = (type, message) => runtimeErrors.push({ type, message: String(message ?? "") });
window.addEventListener("error", (event) => recordRuntimeError("error", event.message));
window.addEventListener("unhandledrejection", (event) => recordRuntimeError("unhandledrejection", event.reason));
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  recordRuntimeError("console.error", args.join(" "));
  originalConsoleError(...args);
};
window.__exploreAggressiveRuntimeErrors = runtimeErrors;
const httpPaths = [
  "./index.html",
  "./review.css",
  "./dist/play-ui.js",
  "./assets/pieces/adr-0206-cburnett/white-king-v1.svg"
];
Promise.all(httpPaths.map(async (path) => {
  try {
    const response = await fetch(path, { cache: "no-store" });
    return { path, status: response.status, contentType: response.headers.get("content-type") ?? "" };
  } catch (error) {
    return { path, status: null, contentType: "", error: String(error) };
  }
})).then((checks) => {
  window.__exploreAggressiveHttpResults = checks;
});
// The production app sets this identity on its play root before mounting Play UI. Keep the
// direct harness on the same asset contract so its screenshots cannot silently use glyph fallback.
proofRoot.setAttribute("data-piece-set", ${JSON.stringify(expectedPlayPieceSet)});
window.__exploreAggressiveProof = { g1Fen, sideExploreCalls, fallbackMode, stateMode, riskMode, ready: mountPlayUi(proofRoot, { engine, analysisEngine: engine, reactionLens: true, initialAggressive: true, locale: "es", motion: { sideExploreFastDeadlineMs: pendingMode ? 15000 : fallbackMode ? 0 : 1000, sideExploreDeepDeadlineMs: pendingMode ? 15000 : fallbackMode ? 0 : 1000 } }).ready };
</script></body></html>`;
}

function click(selector) {
  return `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!(e instanceof HTMLElement)) return false; e.click(); return true; })()`;
}

function loadFenExpression(fen) {
  return `(() => {
    const input = document.querySelector('[data-play-ui="load-position-input"]');
    const button = document.querySelector('[data-play-ui="load-position-button"]');
    if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement) || button.disabled) return false;
    input.value = ${JSON.stringify(fen)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
    return true;
  })()`;
}

function playMoveExpression(from, to) {
  return `(() => {
    const fromSquare = document.querySelector('[data-play-ui="board-square"][data-square="${from}"]');
    const toSquare = document.querySelector('[data-play-ui="board-square"][data-square="${to}"]');
    if (!(fromSquare instanceof HTMLButtonElement) || !(toSquare instanceof HTMLButtonElement)) return false;
    fromSquare.click();
    toSquare.click();
    return true;
  })()`;
}

async function pressKey(cdp, key, code, windowsVirtualKeyCode) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
}

async function assertAccessibility(cdp) {
  const tree = await cdp.send("Accessibility.getFullAXTree");
  const nodes = tree.nodes ?? [];
  const hasNamedBoard = nodes.some((node) => node.role?.value === "grid" && node.name?.value === "Tablero de ajedrez");
  const hasLocalizedSquare = nodes.some((node) => node.role?.value === "gridcell" && String(node.name?.value ?? "").includes("d2, torre blanca"));
  assert(hasNamedBoard, "AX tree has no localized named board grid", nodes.map((node) => ({ role: node.role?.value, name: node.name?.value })));
  assert(hasLocalizedSquare, "AX tree has no localized d2 square label", nodes.map((node) => ({ role: node.role?.value, name: node.name?.value })));
}

async function proveKeyboard(cdp) {
  assert(await evaluate(cdp, `(() => { const square = document.querySelector('[data-play-ui="board-square"][data-square="d2"]'); if (!(square instanceof HTMLButtonElement)) return false; square.focus(); return document.activeElement === square; })()`), "could not focus d2 for keyboard proof");
  await pressKey(cdp, "ArrowRight", "ArrowRight", 39);
  await waitFor(cdp, `document.activeElement?.getAttribute('data-square') === 'e2'`, "board ArrowRight did not move focus to e2");
  await pressKey(cdp, "ArrowLeft", "ArrowLeft", 37);
  await waitFor(cdp, `document.activeElement?.getAttribute('data-square') === 'd2'`, "board ArrowLeft did not restore focus to d2");
  await pressKey(cdp, "Enter", "Enter", 13);
  await waitFor(cdp, `document.querySelector('[data-play-ui="board-square"][data-square="d2"]')?.getAttribute('data-board-selected') === 'true'`, "board Enter did not select the focused square");
  assert(await evaluate(cdp, loadFenExpression(g1Fen)), "could not reset after keyboard proof");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready'`, "Explore did not reset after keyboard proof");
}

async function proveTouchTap(cdp) {
  const point = await evaluateJson(cdp, `JSON.stringify((() => { const node = document.querySelector('[data-play-ui="board-square"][data-square="d2"]'); if (!(node instanceof HTMLElement)) return null; const box = node.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })())`);
  assert(point !== null, "could not locate d2 for touch proof");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
  await waitFor(cdp, `document.querySelector('[data-play-ui="board-square"][data-square="d2"]')?.getAttribute('data-board-selected') === 'true'`, "touch tap did not select d2");
  assert(await evaluate(cdp, loadFenExpression(g1Fen)), "could not reset after touch proof");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready'`, "Explore did not reset after touch proof");
}

function snapshotExpression(label) {
  return `JSON.stringify((() => {
    const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? null;
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) return null;
      const box = node.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom), width: Math.round(box.width), height: Math.round(box.height) };
    };
    const map = (selector, fields) => [...document.querySelectorAll(selector)].map((node) => Object.fromEntries(fields.map(([key, attrName]) => [key, node.getAttribute(attrName)])));
    const boardGridRect = rect('[data-play-ui="board-grid"]');
    const boardShellRect = rect('[data-play-ui="board"]');
    const boardRect = boardGridRect ?? boardShellRect;
    const pieceNode = document.querySelector('[data-play-ui="board-square"][data-board-piece] > [data-play-ui="board-piece"]');
    const boardPanelRect = rect('[data-play-ui="board-panel"]');
    const primaryGatesRect = rect('[data-play-ui="explore-gates"]');
    const primaryGatesControlsRect = rect('[data-play-ui="explore-gates-controls"]');
    const controlsRect = primaryGatesControlsRect;
    const recommendationRect = rect('[data-play-ui="explore-section"][data-explore-section="recommendation"]');
    const verdictRect = rect('[data-play-ui="explore-verdict"]');
    const verdictNode = document.querySelector('[data-play-ui="explore-verdict"]');
    const verdictInBoardPanel = (() => {
      const panel = document.querySelector('[data-play-ui="board-panel"]');
      return panel !== null && verdictNode !== null && panel.contains(verdictNode);
    })();
    const recommendationInVerdict = (() => {
      const rec = document.querySelector('[data-play-ui="explore-section"][data-explore-section="recommendation"]');
      return verdictNode !== null && rec !== null && verdictNode.contains(rec);
    })();
    const alternativesInVerdict = (() => {
      const alternatives = document.querySelector('[data-play-ui="explore-alternatives"]');
      return alternatives === null ? null : verdictNode !== null && verdictNode.contains(alternatives);
    })();
    const statusPillNode = document.querySelector('[data-play-ui="explore-status"]');
    const statusPillRect = statusPillNode === null ? null : statusPillNode.getBoundingClientRect();
    const statusPillInVerdict = verdictNode !== null && statusPillNode !== null && verdictNode.contains(statusPillNode);
    const statusPillVisible = statusPillRect !== null && statusPillRect.width > 0 && statusPillRect.height > 0 && getComputedStyle(statusPillNode).display !== 'none';
    const continuationNode = document.querySelector('[data-play-ui="explore-continuation"]');
    const continuationRect = continuationNode === null ? null : continuationNode.getBoundingClientRect();
    const continuationInBoardPanel = (() => {
      const panel = document.querySelector('[data-play-ui="board-panel"]');
      return panel !== null && continuationNode !== null && panel.contains(continuationNode);
    })();
    const controlDeckInContinuation = continuationNode !== null && continuationNode.contains(document.querySelector('[data-play-ui="control-deck"]'));
    const lensLabel = attr('[data-play-ui="reaction-lens"]', "aria-label");
    const kickerVisibleCount = [...document.querySelectorAll('[data-play-ui="board-eyebrow"], [data-play-ui="explore-kicker"]')].filter((node) => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
    }).length;
    const scoreRect = rect('[data-play-ui="reaction-score"]');
    const metricsRect = rect('[data-play-ui="explore-section"][data-explore-section="metrics"]');
    const detailsRect = rect('[data-play-ui="explore-details"]');
    const detailsSummaryRect = rect('[data-play-ui="explore-details-summary"]');
    const overlaps = (a, b) => a !== null && b !== null && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const gateLegendOverlapCount = [...document.querySelectorAll('[data-play-ui="explore-gates-controls"] fieldset')].reduce((count, fieldset) => {
      const legend = fieldset.querySelector('legend');
      if (!(legend instanceof HTMLElement)) return count;
      const legendRect = legend.getBoundingClientRect();
      return count + [...fieldset.querySelectorAll('button')].filter((button) => overlaps(legendRect, button.getBoundingClientRect())).length;
    }, 0);
    return {
      label: ${JSON.stringify(label)},
      status: attr('[data-play-ui="reaction-lens"]', "data-reaction-status"),
      reactionState: attr('[data-play-ui="reaction-lens"]', "data-reaction-state"),
      riskState: attr('[data-play-ui="reaction-lens"]', "data-reaction-risk-state"),
      verdictState: attr('[data-play-ui="explore-verdict"]', "data-verdict-state"),
      verdictStatus: attr('[data-play-ui="explore-verdict"]', "data-verdict-status"),
      verdictRiskState: attr('[data-play-ui="explore-verdict"]', "data-verdict-risk-state"),
      verdictInBoardPanel,
      recommendationInVerdict,
      alternativesInVerdict,
      playMode: attr('[data-play-ui="root"]', "data-play-mode"),
      pieceSet: attr('[data-piece-set]', "data-piece-set"),
      pieceCount: document.querySelectorAll('[data-play-ui="board-square"][data-board-piece]').length,
      pieceAsset: pieceNode === null ? null : getComputedStyle(pieceNode).backgroundImage,
      boardLabel: attr('[data-play-ui="board-grid"]', "aria-label") ?? attr('[data-play-ui="board"]', "aria-label"),
      d2Label: attr('[data-play-ui="board-square"][data-square="d2"]', "aria-label"),
      runtimeErrors: window.__exploreAggressiveRuntimeErrors ?? [],
      httpResults: window.__exploreAggressiveHttpResults ?? [],
      boardState: attr('[data-play-ui="board"]', "data-board-state"),
      rootStatus: text('[data-play-ui="status"]'),
      rootBusy: attr('[data-play-ui="root"]', "aria-busy"),
      errorTitle: text('[data-play-ui="error-title"]'),
      terminalResult: text('[data-play-ui="terminal-result-value"]'),
      terminalOpen: document.querySelector('[data-play-ui="secondary-drawer"]')?.open ?? null,
      riskItems: document.querySelectorAll('[data-play-ui="risk-hierarchy-item"]').length,
      alternativeItems: document.querySelectorAll('[data-play-ui="alternative-item"]').length,
      alternativeChevrons: document.querySelectorAll('[data-play-ui="alternative-chevron"]').length,
      alternativeLabels: [...document.querySelectorAll('[data-play-ui="alternative-item"]')].map((node) => node.getAttribute('aria-label')),
      supportingHeading: text('[data-play-ui="explore-supporting-heading"] h3'),
      disclosureTiers: [...document.querySelectorAll('[data-play-ui="explore-supporting"] [data-explore-tier]')].map((node) => node.getAttribute('data-explore-tier')),
      aggressive: attr('[data-play-ui="aggressive-toggle-button"]', "aria-pressed"),
      aggressiveBadgeCount: document.querySelectorAll('[data-play-ui="aggressive-badge"]').length,
      selectedSide: text('[data-play-ui="reaction-input"] dd'),
      turn: text('[data-play-ui="reaction-turn"] dd'),
      best: text('[data-play-ui="reaction-best"] dd'),
      score: text('[data-play-ui="reaction-score"] dd'),
      recommendationNote: text('[data-play-ui="recommendation-note"]'),
      recommendationBridge: document.querySelectorAll('[data-play-ui="recommendation-bridge"]').length,
      source: text('[data-play-ui="reaction-result-source"] dd'),
      plan: text('[data-play-ui="reaction-plan"] dd'),
      fen: text('[data-play-ui="current-fen"] dd'),
      arrows: map('[data-play-ui="reaction-arrow"]', [["from", "data-reaction-from"], ["to", "data-reaction-to"], ["order", "data-reaction-order"], ["primary", "data-reaction-primary"], ["role", "data-path-role"], ["sequence", "data-reaction-sequence"], ["risk", "data-path-risk"]]),
      candidates: map('[data-play-ui="candidate-arrow"]', [["from", "data-candidate-from"], ["to", "data-candidate-to"], ["rank", "data-candidate-rank"], ["role", "data-path-role"], ["safety", "data-candidate-safety"], ["riskLabel", "data-candidate-risk-label"]]),
      replies: map('[data-play-ui="reply-arrow"]', [["from", "data-reply-from"], ["to", "data-reply-to"], ["rank", "data-reply-rank"], ["role", "data-path-role"]]),
      sideExploreCalls: window.__exploreAggressiveProof?.sideExploreCalls ?? [],
      exploreSections: [...document.querySelectorAll('[data-play-ui="reaction-lens"] [data-play-ui="explore-section"]')].map((node) => node.getAttribute('data-explore-section')),
      detailsOpen: document.querySelector('[data-play-ui="explore-details"]')?.open ?? null,
      optionsOpen: document.querySelector('[data-play-ui="explore-options"]')?.open ?? null,
      cliReportOpen: document.querySelector('[data-play-ui="explore-cli-report"]')?.open ?? null,
      forcingStatus: attr('[data-play-ui="forcing-lens"]', "data-forcing-status"),
      forcingButtonPressed: attr('[data-play-ui="reaction-view-button"][data-reaction-view="forcing"]', "aria-pressed"),
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      primaryGatesVisible: primaryGatesRect !== null && primaryGatesRect.width > 0 && primaryGatesRect.height > 0,
      controlDeckVisible: (() => {
        const node = document.querySelector('[data-play-ui="control-deck-summary"]');
        return node !== null && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0;
      })(),
      controlDeckIsDisclosure: document.querySelector('[data-play-ui="control-deck"]')?.matches('details') ?? false,
      factsPresent: (() => { const node = document.querySelector('[data-play-mode="reaction-lens"] [data-play-ui="facts"]'); return node !== null && getComputedStyle(node).display !== 'none'; })(),
      controlDeckInContinuation,
      lensLabel,
      kickerVisibleCount,
      statusPillInVerdict,
      statusPillVisible,
      exploreStatusText: statusPillNode === null ? null : statusPillNode.textContent.trim(),
      continuationInBoardPanel,
      continuationBelowVerdict: continuationRect !== null && verdictRect !== null && continuationRect.top >= verdictRect.bottom - 2,
      verdictContinuationOverlap: overlaps(verdictRect, continuationRect),
      bandBoardSharedWidth: verdictRect !== null && boardShellRect !== null && Math.abs(verdictRect.width - boardShellRect.width) <= 2,
      visibleSecondaryArrows: [...document.querySelectorAll('[data-play-ui="reaction-arrow"][data-reaction-primary="false"], [data-play-ui="candidate-arrow"], [data-play-ui="reply-arrow"]')].filter((node) => getComputedStyle(node).visibility !== 'hidden').length,
      boardRect, primaryGatesRect, primaryGatesControlsRect, controlsRect,
      recommendationRect, verdictRect, scoreRect, metricsRect, detailsRect, detailsSummaryRect,
      continuationRect, statusPillRect: statusPillRect === null ? null : { left: Math.round(statusPillRect.left), top: Math.round(statusPillRect.top), right: Math.round(statusPillRect.right), bottom: Math.round(statusPillRect.bottom), width: Math.round(statusPillRect.width), height: Math.round(statusPillRect.height) },
      pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      pageHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      boardVisible: boardRect !== null && boardRect.width > 0 && boardRect.right <= window.innerWidth + 1,
      boardBottomVisible: boardRect !== null && boardRect.bottom <= window.innerHeight + 1,
      boardPanelRect,
      boardShellRect,
      boardGridRect,
      controlsOverlap: overlaps(boardRect, controlsRect),
      gateLegendOverlapCount
    };
  })())`;
}

async function screenshot(cdp, name) {
  const image = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const file = join(proofRoot, `2026-07-22-g0262-v5-${name}.png`);
  writeFileSync(file, Buffer.from(image.data, "base64"));
  return file;
}

async function setViewport(cdp, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.mobile
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: viewport.mobile,
    maxTouchPoints: 1
  });
}

async function captureScrollBehavior(cdp) {
  assert(
    await evaluate(cdp, `(() => {
      window.__exploreScrollBehaviors = [];
      Element.prototype.scrollIntoView = function(options) {
        window.__exploreScrollBehaviors.push(
          typeof options === "object" && options !== null ? options.behavior ?? "auto" : "auto"
        );
      };
      return true;
    })()`),
    "could not instrument board bridge scrolling"
  );
}

async function assertReducedMotionBridge(cdp, port, viewport) {
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  await loadProofPage(cdp, port, viewport);
  await captureScrollBehavior(cdp);
  assert(await evaluate(cdp, click('[data-play-ui="alternative-item"][data-alternative-move="d2d4"]')), "reduced-motion alternative bridge did not respond");
  await waitFor(cdp, `document.querySelector('[data-play-ui="board-square"][data-square="d2"]')?.getAttribute('data-board-selected') === 'true'`, "reduced-motion alternative bridge did not focus the recommended source");
  const behaviors = await evaluateJson(cdp, `JSON.stringify(window.__exploreScrollBehaviors ?? [])`);
  assert(behaviors.includes("auto"), "reduced-motion board bridge did not use auto scrolling", behaviors);
  const transitionDuration = await evaluate(cdp, `getComputedStyle(document.querySelector('[data-play-ui="alternative-chevron"]')).transitionDuration`);
  assert(transitionDuration === "0s", "reduced-motion alternative affordance still animates", transitionDuration);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
  });
}

async function loadProofPage(cdp, port, viewport, search = "") {
  await setViewport(cdp, viewport);
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html${search}` });
  await waitFor(cdp, "window.__exploreAggressiveProof !== undefined", "proof harness did not initialize");
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "Play UI board did not mount");
  await waitFor(cdp, "Array.isArray(window.__exploreAggressiveHttpResults) && window.__exploreAggressiveHttpResults.length === 4", "HTTP asset checks did not settle");
  assert(await evaluate(cdp, loadFenExpression(g1Fen)), "could not load G1 through the Play UI FEN control");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-turn"] dd')?.textContent?.trim() === 'Blancas'`, "G1 FEN did not settle");
  await waitFor(cdp, `document.querySelector('[data-play-ui="aggressive-toggle-button"]')?.getAttribute('aria-pressed') === 'true'`, "Aggressive did not enable");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready'`, "Explore result did not settle");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-result-source"] dd')?.textContent?.trim() === 'Resultado completo'`, "Explore rich result did not settle");
}

async function loadRiskProofPage(cdp, port, viewport) {
  await loadProofPage(cdp, port, viewport, "?risk=1");
}

async function loadFallbackProofPage(cdp, port, viewport) {
  await setViewport(cdp, viewport);
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?fallback=1` });
  await waitFor(cdp, "window.__exploreAggressiveProof !== undefined", "fallback proof harness did not initialize");
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "Fallback Play UI board did not mount");
  await waitFor(cdp, "Array.isArray(window.__exploreAggressiveHttpResults) && window.__exploreAggressiveHttpResults.length === 4", "fallback HTTP asset checks did not settle");
  assert(await evaluate(cdp, loadFenExpression(g1Fen)), "could not load G1 for fallback proof");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-turn"] dd')?.textContent?.trim() === 'Blancas'`, "fallback G1 FEN did not settle");
  await waitFor(cdp, `document.querySelector('[data-play-ui="aggressive-toggle-button"]')?.getAttribute('aria-pressed') === 'true'`, "Aggressive fallback default did not enable");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-result-source"] dd')?.textContent?.trim() === 'provisional · sin certificar'`, "provisional fallback did not appear");
}

async function loadStateProofPage(cdp, port, viewport, state) {
  await setViewport(cdp, viewport);
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?state=${state}` });
  await waitFor(cdp, "window.__exploreAggressiveProof !== undefined", `${state} proof harness did not initialize`);
  await waitFor(cdp, "Array.isArray(window.__exploreAggressiveHttpResults) && window.__exploreAggressiveHttpResults.length === 4", `${state} HTTP asset checks did not settle`);
  if (state === "loading") {
    await waitFor(cdp, `document.querySelector('[data-play-ui="board"][data-board-state="loading"]') !== null`, "loading board placeholder did not mount");
    await waitFor(cdp, `document.querySelector('[data-play-ui="status"]')?.textContent?.trim() === 'Cargando'`, "loading state did not remain visible");
    return;
  }
  if (state === "error") {
    await waitFor(cdp, `document.querySelector('[data-play-ui="board"][data-board-state="loading"]') !== null`, "error board placeholder did not mount");
    await waitFor(cdp, `document.querySelector('[data-play-ui="error"]') !== null && document.querySelector('[data-play-ui="error"]')?.getAttribute('data-play-error-source') !== null`, "root error state did not settle");
    return;
  }
  if (state === "terminal") {
    await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "terminal Play UI board did not mount");
    assert(await evaluate(cdp, loadFenExpression(g1Fen)), "could not load G1 for terminal proof");
    await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready'`, "terminal setup Explore result did not settle");
    assert(await evaluate(cdp, playMoveExpression("d2", "d1")), "could not play terminal d2d1");
    await waitFor(cdp, `document.querySelector('[data-play-ui="terminal-result"]') !== null`, "terminal result did not render");
    return;
  }
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", `${state} Play UI board did not mount`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"reaction-lens\"]') !== null", `${state} Explore lens did not mount`);
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === '${state}'`, `${state} Explore state did not settle`);
}

function has(items, fields) {
  return items.some((item) => Object.entries(fields).every(([key, value]) => item[key] === value));
}

function assertLayout(snapshot) {
  assert(snapshot.runtimeErrors.length === 0, "browser/page reported runtime errors", snapshot.runtimeErrors);
  assert(snapshot.httpResults.length === 4 && snapshot.httpResults.every((check) => check.status === 200), "fresh HTTP asset checks did not return 200", snapshot.httpResults);
  const htmlCheck = snapshot.httpResults.find((check) => check.path === "./index.html");
  const cssCheck = snapshot.httpResults.find((check) => check.path === "./review.css");
  const jsCheck = snapshot.httpResults.find((check) => check.path === "./dist/play-ui.js");
  const assetCheck = snapshot.httpResults.find((check) => check.path.includes("white-king-v1.svg"));
  assert(htmlCheck?.contentType.includes("text/html"), "index.html content type is not HTML", snapshot.httpResults);
  assert(cssCheck?.contentType.includes("text/css"), "review.css content type is not CSS", snapshot.httpResults);
  assert(jsCheck?.contentType.includes("javascript"), "play-ui.js content type is not JavaScript", snapshot.httpResults);
  assert(assetCheck?.contentType === "image/svg+xml", "Cburnett asset content type is not SVG", snapshot.httpResults);
  assert(snapshot.pieceSet === expectedPlayPieceSet, "proof is not using the production piece set", snapshot);
  assert(snapshot.pieceCount > 0, "proof board has no rendered pieces", snapshot);
  assert(typeof snapshot.pieceAsset === "string" && snapshot.pieceAsset.includes("/assets/pieces/adr-0206-cburnett/"), "proof is not rendering a Cburnett SVG asset", snapshot);
  assert(snapshot.pageWidth <= snapshot.viewportWidth + 1, "page overflows viewport", snapshot);
  assert(snapshot.boardVisible, "board is not fully visible", snapshot);
  assert(snapshot.controlsOverlap === false, "controls overlap the board", snapshot);
  assert(snapshot.exploreSections.join(",") === "context,metrics", "Explore primary-first section order is wrong", snapshot);
  assert(snapshot.recommendationRect?.width > 0 && snapshot.recommendationRect?.height > 0, "recommendation block is not rendered", snapshot);
  assert(snapshot.verdictRect?.width > 0 && snapshot.verdictRect?.height > 0, "explore verdict band is not rendered", snapshot);
  assert(snapshot.verdictInBoardPanel === true, "explore verdict band is not inside the board panel", snapshot);
  assert(snapshot.recommendationInVerdict === true, "recommendation block is not inside the verdict band", snapshot);
  assert(snapshot.alternativesInVerdict !== false, "explore alternatives left the verdict band", snapshot);
  assert(snapshot.statusPillInVerdict === true, "Explore status pill is not inside the verdict band", snapshot);
  assert(snapshot.statusPillVisible === true, "Explore status pill is not visible inside the verdict band", snapshot);
  assert(snapshot.kickerVisibleCount === 0, "Explore first contact still renders a redundant uppercase kicker", snapshot);
  assert(snapshot.continuationInBoardPanel === true, "explore continuation rows are not inside the board panel", snapshot);
  assert(snapshot.continuationBelowVerdict === true, "explore continuation rows do not flow under the verdict band", snapshot);
  assert(snapshot.verdictContinuationOverlap === false, "verdict band overlaps the continuation rows", snapshot);
  if (snapshot.viewportWidth >= 1121) {
    assert(snapshot.bandBoardSharedWidth === true, "verdict band and board do not share the same width on the desktop flow", snapshot);
  }
  assert(snapshot.verdictState === snapshot.reactionState, "verdict state does not mirror the Explore state", snapshot);
  assert(snapshot.verdictStatus === snapshot.status, "verdict status does not mirror the Explore status", snapshot);
  assert(snapshot.verdictRiskState === snapshot.riskState, "verdict risk state does not mirror the Explore risk state", snapshot);
  assert(
    snapshot.recommendationRect.left >= snapshot.boardPanelRect.left - 1 && snapshot.recommendationRect.right <= snapshot.boardPanelRect.right + 1,
    "recommendation block is not aligned inside the board panel",
    snapshot
  );
  assert(snapshot.verdictRect.top >= snapshot.boardRect.bottom - 2, "verdict band is not directly under the board", snapshot);
  assert(snapshot.scoreRect?.width > 0 && snapshot.scoreRect?.height > 0, "recommendation score is not rendered", snapshot);
  assert(snapshot.detailsRect?.width > 0 && snapshot.detailsRect?.height > 0, "progressive detail disclosure is not rendered", snapshot);
  assert(snapshot.detailsSummaryRect?.width > 0 && snapshot.detailsSummaryRect?.height > 0, "progressive detail control is not visible", snapshot);
  assert(snapshot.detailsOpen === false, "secondary Explore detail is open on first contact", snapshot);
  assert(snapshot.optionsOpen === false, "Explore options are open on first contact", snapshot);
  assert(snapshot.primaryGatesVisible === true, "primary Explore gates are not visible on first contact", snapshot);
    assert(snapshot.primaryGatesRect?.width > 0 && snapshot.primaryGatesRect?.height > 0, "primary Explore gates have no rendered geometry", snapshot);
    assert(snapshot.primaryGatesControlsRect?.width > 0 && snapshot.primaryGatesControlsRect?.height > 0, "primary Explore controls have no rendered geometry", snapshot);
    if (snapshot.viewportWidth >= 761) {
      assert(snapshot.gateLegendOverlapCount === 0, "desktop Explore gate labels overlap their controls", snapshot);
    }
  assert(snapshot.controlDeckVisible === true, "secondary options disclosure is not visible on first contact", snapshot);
  assert(snapshot.controlDeckIsDisclosure === true, "secondary options are not represented as a disclosure", snapshot);
  assert(snapshot.factsPresent === false, "generic position facts leaked into Explore first contact", snapshot);
  assert(snapshot.controlDeckInContinuation === true, "Explore session controls are not part of the continuation flow under the board", snapshot);
  assert(snapshot.lensLabel === "Qué jugar ahora", "Explore lens accessible name is still generic or duplicated", snapshot);
  const secondaryDataCount = snapshot.candidates.length + snapshot.replies.length + snapshot.arrows.filter((arrow) => arrow.primary === "false").length;
  assert(snapshot.visibleSecondaryArrows > 0 || secondaryDataCount === 0, "secondary board paths are present but not visible", snapshot);
  if (snapshot.boardState === "ready") {
    assert(snapshot.boardLabel === "Tablero de ajedrez", "board accessible name is not localized", snapshot);
    assert(["d2, torre blanca", "d2, vacía"].includes(snapshot.d2Label), "board square ARIA label is not localized and understandable", snapshot);
  }
  const rawCoordinate = /\b[a-h][1-8][a-h][1-8](?:[qrbn])?\b/i;
  assert(!rawCoordinate.test(snapshot.best ?? "") && !rawCoordinate.test(snapshot.recommendationNote ?? ""), "recommendation exposes raw UCI coordinates", snapshot);
  if (snapshot.viewportWidth >= 761) {
    assert(snapshot.boardBottomVisible, "desktop board extends below the first viewport", snapshot);
    assert(snapshot.boardShellRect?.bottom <= snapshot.viewportHeight + 1, "desktop board shell extends below the first viewport", snapshot);
    if (snapshot.viewportWidth >= 1400) {
      assert(snapshot.boardShellRect?.bottom <= snapshot.viewportHeight - 2, "desktop board shell does not respect the 2px bottom safety margin", snapshot);
    }
    const minimumBoard = snapshot.viewportWidth >= 1800 ? 840 : snapshot.viewportWidth >= 1400 ? 720 : Math.min(680, snapshot.viewportHeight - 192);
    assert((snapshot.boardShellRect?.width ?? snapshot.boardRect?.width) >= minimumBoard, "desktop board is not large enough to remain the primary surface", snapshot);
    if (snapshot.boardGridRect !== null && snapshot.viewportWidth >= 1400) {
      const minimumGrid = snapshot.viewportWidth >= 1800
        ? Math.min(840, snapshot.viewportHeight - 200)
        : Math.min(720, snapshot.viewportHeight - 200);
      assert(snapshot.boardGridRect.width >= minimumGrid, "desktop board grid is not large enough to remain the primary surface", snapshot);
    }
  }
}

function assertInitialProof(snapshot) {
  assert(snapshot.playMode === "reaction-lens", "proof is not mounted in Explore/Reaction mode", snapshot);
  assert(snapshot.aggressive === "true" && snapshot.status === "ready", "Aggressive Explore is not ready", snapshot);
  assert(snapshot.aggressiveBadgeCount === 0, "Explore still renders a duplicate Aggressive badge", snapshot);
  assert(snapshot.source === "Resultado completo", "initial proof is not rich", snapshot);
  if (snapshot.viewportWidth >= 1400) {
    assert(snapshot.verdictRect.height <= 200, "rich Explore verdict band is not compact on desktop", snapshot.verdictRect);
  }
  assert(snapshot.selectedSide === "Blancas" && snapshot.turn === "Blancas", "G1 side state mismatch", snapshot);
  assert(snapshot.best === "d2 → d1" && snapshot.score === "-163 cp", "dominant recommendation mismatch", snapshot);
  assert(snapshot.recommendationBridge === 1, "recommendation-to-board bridge is missing", snapshot);
  assert(snapshot.alternativeItems === 3, "visible alternative move list is missing or incomplete", snapshot);
  assert(snapshot.alternativeChevrons === 3, "alternative rows are missing their navigation affordance", snapshot);
  assert(snapshot.alternativeLabels.some((label) => label?.toLowerCase().includes("verificada")), "alternative accessibility labels omit their safety state", snapshot);
  assert(snapshot.supportingHeading === "Profundizar", "Explore supporting hierarchy is missing", snapshot);
  assert(snapshot.disclosureTiers.join(",") === "controls,controls,evidence", "Explore supporting disclosures lost their hierarchy", snapshot);
  assert(snapshot.recommendationNote === "Juega d2 → d1: es la opción verificada para tu lado.", "recommendation explanation is missing or not localized", snapshot);
  assert(has(snapshot.arrows, { from: "d2", to: "d1", primary: "true", role: "main", sequence: "lead" }), "main dominant arrow d2d1 is missing", snapshot);
  assert(has(snapshot.arrows, { from: "a4", to: "a1", role: "continuation", sequence: "continuation" }), "initial continuation arrow a4a1 is missing", snapshot);
  assert(has(snapshot.candidates, { from: "d2", to: "d4", rank: "2", role: "alternative" }), "secondary alternative d2d4 is missing", snapshot);
  assert(has(snapshot.candidates, { from: "d2", to: "d3", rank: "3", role: "diagnostic", riskLabel: "risky-alternative" }), "caution diagnostic d2d3 is missing or promoted", snapshot);
  assert(has(snapshot.candidates, { from: "h2", to: "h4", rank: "4", role: "diagnostic", riskLabel: "avoid" }), "diagnostic unsound h2h4 is missing or promoted", snapshot);
  assert(snapshot.sideExploreCalls.some((call) => call.fen === g1Fen && call.aggressive === true), "proof did not exercise Aggressive On sideExplore", snapshot);
  assertLayout(snapshot);
}

function assertFallbackProof(snapshot) {
  assert(snapshot.playMode === "reaction-lens", "fallback proof is not mounted in Explore/Reaction mode", snapshot);
  assert(snapshot.aggressive === "true" && snapshot.status === "ready", "fallback Explore is not ready", snapshot);
  assert(snapshot.source === "provisional · sin certificar", "fallback source is not provisional", snapshot);
  assert(snapshot.plan === "provisional · sin certificar", "fallback plan is not provisional", snapshot);
  assert(snapshot.best === "d2 → d1" || snapshot.best === "Menor riesgo d2 → d1", "fallback move mismatch", snapshot);
  assert(snapshot.recommendationNote === "Si necesitas elegir, usa d2 → d1: es el menor riesgo disponible, pero no está verificada.", "provisional recommendation explanation is missing", snapshot);
  assert(snapshot.arrows.length === 0, "fallback must not draw board line arrows", snapshot);
  assert(snapshot.candidates.length === 0, "fallback must not draw candidate arrows", snapshot);
  assertLayout(snapshot);
}

function assertFallbackReplacementProof(snapshot) {
  assert(snapshot.source === "Resultado completo", "rich result did not replace fallback", snapshot);
  assert(has(snapshot.arrows, { from: "d2", to: "d1", primary: "true", role: "main", sequence: "lead" }), "replacement rich main arrow missing", snapshot);
  assert(has(snapshot.candidates, { from: "d2", to: "d4", rank: "2", role: "alternative" }), "replacement rich candidate missing", snapshot);
  assertLayout(snapshot);
}

function assertRiskProof(snapshot) {
  assert(snapshot.playMode === "reaction-lens", "risk proof is not mounted in Explore/Reaction mode", snapshot);
  assert(snapshot.aggressive === "true" && snapshot.status === "ready", "risk Explore is not ready", snapshot);
  assert(snapshot.riskState === "not-recommended", "risk candidate did not change the recommendation state", snapshot);
  assert(snapshot.best === "d2 → d1", "risk recommendation move mismatch", snapshot);
  assert(snapshot.score === "no recomendada · exacta -163 cp", "risk score did not carry the non-recommended state", snapshot);
  assert(snapshot.recommendationNote === "Si necesitas elegir, usa d2 → d1: es el menor riesgo disponible, pero no está verificada.", "risk warning copy is missing", snapshot);
  assert(snapshot.riskItems > 0, "risk hierarchy did not render", snapshot);
  assert(snapshot.arrows.length === 0, "a non-recommended candidate became the primary board path", snapshot);
  assertLayout(snapshot);
}

function assertLoadingProof(snapshot) {
  assert(snapshot.rootStatus === "Cargando", "loading status is not localized or visible", snapshot);
  assert(snapshot.rootBusy === "true", "loading root is not marked busy", snapshot);
  assert(snapshot.boardState === "loading" && snapshot.boardGridRect === null, "loading state did not use the stable board placeholder", snapshot);
  assert(snapshot.errorTitle === null && snapshot.terminalResult === null, "loading state leaked terminal/error content", snapshot);
  assert(snapshot.boardRect?.width > 0 && snapshot.boardRect?.height > 0, "loading state lost the board geometry", snapshot);
}

function assertRootErrorProof(snapshot) {
  assert(snapshot.rootStatus === "No se pudo iniciar la partida", "root error status is not truthful/localized", snapshot);
  assert(snapshot.errorTitle === "No se pudo iniciar la partida", "root error detail is missing", snapshot);
  assert(snapshot.terminalResult === null, "root error leaked terminal content", snapshot);
  assert(snapshot.boardRect?.width > 0 && snapshot.boardRect?.height > 0, "root error state lost the board geometry", snapshot);
}

function assertTerminalProof(snapshot) {
  assert(snapshot.rootStatus === "Jaque mate", "terminal status is not localized", snapshot);
  assert(snapshot.terminalResult === "Resultado1-0", "terminal result did not render", snapshot);
  assert(snapshot.terminalOpen === true, "terminal drawer did not open for a completed game", snapshot);
  assert(snapshot.errorTitle === null, "terminal state leaked root error content", snapshot);
}

function assertNonHappyStateProof(snapshot, state) {
  assert(snapshot.playMode === "reaction-lens", `${state} proof is not mounted in Explore/Reaction mode`, snapshot);
  assert(snapshot.aggressive === "true" && snapshot.status === state, `${state} Explore state mismatch`, snapshot);
  assert(snapshot.lensLabel === "Qué jugar ahora", `${state} Explore heading drifted`, snapshot);
  assert(snapshot.factsPresent === false, `${state} generic position facts leaked into first contact`, snapshot);
  assert(snapshot.controlDeckInContinuation === true, `${state} session controls left the continuation flow`, snapshot);
  assert(snapshot.visibleSecondaryArrows === 0, `${state} secondary board paths compete with first contact`, snapshot);
  if (state === "pending") {
    assert(snapshot.exploreStatusText === "Calculando…", "pending status copy is not explicit", snapshot);
    assert(snapshot.best === "—", "pending recommendation is presented as a move", snapshot);
    assert(snapshot.score === "Calculando…", "pending score leaks an engine token", snapshot);
    assert(snapshot.recommendationNote === "El motor está calculando la posición localmente.", "pending note is missing", snapshot);
  } else {
    assert(snapshot.exploreStatusText === "No disponible", "failed status copy is not explicit", snapshot);
    assert(snapshot.best === "—", "failed recommendation is presented as a move", snapshot);
    assert(snapshot.score === "No disponible", "failed score leaks an engine token", snapshot);
    assert(snapshot.recommendationNote === "Revisa Más opciones para continuar.", "failed recovery note is missing", snapshot);
  }
  assertLayout(snapshot);
}

function assertAfterFirstMoveProof(snapshot) {
  assert(snapshot.aggressive === "true" && snapshot.status === "ready", "Aggressive Explore did not stay ready after d2d1", snapshot);
  assert(snapshot.selectedSide === "Blancas" && snapshot.turn === "Negras", "post-move side state mismatch", snapshot);
  assert(has(snapshot.arrows, { from: "a4", to: "a1", primary: "true", role: "main", sequence: "lead" }), "post-move reply arrow a4a1 is missing", snapshot);
  assert(has(snapshot.arrows, { from: "d1", to: "d8", role: "continuation", sequence: "continuation" }), "post-move continuation arrow d1d8 is missing", snapshot);
  assert(snapshot.replies.length === 0 && snapshot.candidates.length === 0, "off-turn board promoted deferred alternatives", snapshot);
  assertLayout(snapshot);
}

function assertBlackProjectedProof(snapshot) {
  assert(snapshot.playMode === "reaction-lens", "black graph proof is not mounted in Explore/Reaction mode", snapshot);
  assert(snapshot.aggressive === "true" && snapshot.status === "ready", "black Aggressive Explore is not ready", snapshot);
  assert(snapshot.selectedSide === "Negras" && snapshot.turn === "Blancas", "black graph initial side state mismatch", snapshot);
  assert(snapshot.best === "Después de d2 → d1: a4 → a1", "black projected response mismatch", snapshot);
  assert(has(snapshot.arrows, { from: "d2", to: "d1", primary: "true", role: "main", sequence: "lead" }), "best rival reply d2d1 is not the lead graph edge", snapshot);
  assert(has(snapshot.arrows, { from: "a4", to: "a1", role: "continuation", sequence: "continuation" }), "black projected response a4a1 is missing", snapshot);
  assert(snapshot.sideExploreCalls.some((call) => call.fen === g1Fen && call.side === "black" && call.aggressive === true), "black graph did not query the root FEN", snapshot);
  assertLayout(snapshot);
}

function assertBlackBestReplyProof(snapshot) {
  assert(snapshot.selectedSide === "Negras" && snapshot.turn === "Negras", "black best-reply child state mismatch", snapshot);
  assert(snapshot.best === "a4 → a1", "black best-reply recompute did not use the child FEN", snapshot);
  assert(snapshot.plan === "Mantenido", "best-reply plan did not stay followed", snapshot);
  assert(has(snapshot.arrows, { from: "a4", to: "a1", primary: "true", role: "main", sequence: "lead" }), "best-reply child main arrow missing", snapshot);
  assert(snapshot.sideExploreCalls.some((call) => call.fen === g1AfterD2D1Fen && call.side === "black" && call.aggressive === true), "best-reply child FEN was not queried", snapshot);
  assertLayout(snapshot);
}

function assertBlackBadReplyProof(snapshot) {
  assert(snapshot.selectedSide === "Negras" && snapshot.turn === "Negras", "black bad-reply child state mismatch", snapshot);
  assert(snapshot.best === "a4 → d4", "black bad-reply recompute did not use the actual child FEN", snapshot);
  assert(snapshot.plan === "Reemplazado · tablero recalculado", "bad-reply plan did not report live recompute", snapshot);
  assert(has(snapshot.arrows, { from: "a4", to: "d4", primary: "true", role: "main", sequence: "lead" }), "bad-reply child main arrow missing", snapshot);
  assert(snapshot.sideExploreCalls.some((call) => call.fen === g1AfterD2D4Fen && call.side === "black" && call.aggressive === true), "bad-reply child FEN was not queried", snapshot);
  assertLayout(snapshot);
}

async function runBlackReplyBranch(cdp, port, viewport, reply) {
  await loadProofPage(cdp, port, viewport);
  assert(await evaluate(cdp, click('[data-play-ui="player-side-button"][data-player-side="black"]')), "could not select Side Black");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-input"] dd')?.textContent?.trim() === 'Negras'`, "Side Black did not settle");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready'`, "black root Explore result did not settle");
  const projected = await evaluateJson(cdp, snapshotExpression(`${viewport.label}-black-projected-${reply}`));
  assertBlackProjectedProof(projected);
  assert(await evaluate(cdp, playMoveExpression(reply.slice(0, 2), reply.slice(2, 4))), `could not play ${reply} on the real board`);
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-turn"] dd')?.textContent?.trim() === 'Negras'`, `${reply} did not advance to Black`);
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready'`, `${reply} child Explore result did not settle`);
  const child = await evaluateJson(cdp, snapshotExpression(`${viewport.label}-black-after-${reply}`));
  if (reply === "d2d1") {
    assertBlackBestReplyProof(child);
  } else {
    assertBlackBadReplyProof(child);
  }
  const screenshotFile = await screenshot(cdp, `${viewport.label}-black-after-${reply}`);
  return { projected, child, screenshots: [screenshotFile] };
}

async function runViewport(cdp, port, viewport) {
  await loadProofPage(cdp, port, viewport);
  const initial = await evaluateJson(cdp, snapshotExpression(`${viewport.label}-initial`));
  assertInitialProof(initial);
  const initialScreenshot = await screenshot(cdp, `${viewport.label}-initial`);
  await captureScrollBehavior(cdp);
  assert(await evaluate(cdp, click('[data-play-ui="recommendation-bridge"]')), "recommendation bridge did not respond");
  await waitFor(cdp, `document.querySelector('[data-play-ui="board-square"][data-square="d2"]')?.getAttribute('data-board-selected') === 'true'`, "recommendation bridge did not focus the recommended move");
  const scrollBehaviors = await evaluateJson(cdp, `JSON.stringify(window.__exploreScrollBehaviors ?? [])`);
  assert(scrollBehaviors.includes("smooth"), "normal board bridge did not use smooth scrolling", scrollBehaviors);
  await loadProofPage(cdp, port, viewport);
  assert(await evaluate(cdp, click('[data-play-ui="alternative-item"][data-alternative-move="d2d4"]')), "alternative board bridge did not respond");
  await waitFor(cdp, `document.querySelector('[data-play-ui="board-square"][data-square="d2"]')?.getAttribute('data-board-selected') === 'true'`, "alternative board bridge did not focus the alternative move");
  await loadProofPage(cdp, port, viewport);
  await assertAccessibility(cdp);
  await proveKeyboard(cdp);
  if (viewport.mobile) {
    await proveTouchTap(cdp);
  }
  assert(await evaluate(cdp, click('[data-play-ui="explore-details-summary"]')), "could not open Explore details");
  await waitFor(cdp, `document.querySelector('[data-play-ui="explore-details"]')?.open === true`, "Explore details did not open");
  const detailed = await evaluateJson(cdp, snapshotExpression(`${viewport.label}-details-open`));
  assert(detailed.detailsOpen === true, "Explore detail disclosure did not stay open", detailed);
  assert(detailed.visibleSecondaryArrows > 0, "opening Explore details did not reveal diagnostic board paths", detailed);
  const detailedScreenshot = await screenshot(cdp, `${viewport.label}-details-open`);
  assert(await evaluate(cdp, click('[data-play-ui="explore-details-summary"]')), "could not close Explore details");
  await waitFor(cdp, `document.querySelector('[data-play-ui="explore-details"]')?.open === false`, "Explore details did not close");
  assert(await evaluate(cdp, click('[data-play-ui="explore-options-summary"]')), "could not open Explore options");
  await waitFor(cdp, `document.querySelector('[data-play-ui="explore-options"]')?.open === true && document.querySelector('[data-play-ui="explore-controls"]')?.getBoundingClientRect().height > 0 && document.querySelector('[data-play-ui="explore-gates"]')?.getBoundingClientRect().height > 0`, "Explore disclosures did not remain rendered");
  assert(await evaluate(cdp, click('[data-play-ui="locale-toggle"]')), "could not switch locale for disclosure persistence");
  await waitFor(cdp, `document.querySelector('[data-play-ui="explore-options"]')?.open === true && document.querySelector('[data-play-ui="explore-controls"]')?.getBoundingClientRect().height > 0 && document.querySelector('[data-play-ui="explore-gates"]')?.getBoundingClientRect().height > 0`, "Explore disclosures did not persist across locale rerender");
  assert(await evaluate(cdp, click('[data-play-ui="locale-toggle"]')), "could not restore Spanish locale");
  await waitFor(cdp, `document.querySelector('[data-play-ui="explore-options"]')?.open === true && document.querySelector('[data-play-ui="explore-controls"]')?.getBoundingClientRect().height > 0 && document.querySelector('[data-play-ui="explore-gates"]')?.getBoundingClientRect().height > 0`, "Explore disclosures did not restore after locale toggle");
  assert(await evaluate(cdp, click('[data-play-ui="explore-options-summary"]')), "could not close Explore options");
  await waitFor(cdp, `document.querySelector('[data-play-ui="explore-options"]')?.open === false && document.querySelector('[data-play-ui="explore-gates"]')?.getBoundingClientRect().height > 0`, "primary Explore gates disappeared after closing secondary options");
  assert(await evaluate(cdp, playMoveExpression("d2", "d1")), "could not play d2d1 on the real board");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-turn"] dd')?.textContent?.trim() === 'Negras'`, "first move did not advance the board");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready'`, "post-move Explore result did not settle");
  const afterMove = await evaluateJson(cdp, snapshotExpression(`${viewport.label}-after-d2d1`));
  assertAfterFirstMoveProof(afterMove);
  const afterMoveScreenshot = await screenshot(cdp, `${viewport.label}-after-d2d1`);
  const blackBest = await runBlackReplyBranch(cdp, port, viewport, "d2d1");
  const blackBad = await runBlackReplyBranch(cdp, port, viewport, "d2d4");
  await loadFallbackProofPage(cdp, port, viewport);
  const fallback = await evaluateJson(cdp, snapshotExpression(`${viewport.label}-fallback`));
  assertFallbackProof(fallback);
  const fallbackScreenshot = await screenshot(cdp, `${viewport.label}-fallback`);
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-result-source"] dd')?.textContent?.trim() === 'Resultado completo'`, "rich result did not replace fallback");
  const replacement = await evaluateJson(cdp, snapshotExpression(`${viewport.label}-fallback-replaced`));
  assertFallbackReplacementProof(replacement);
  const replacementScreenshot = await screenshot(cdp, `${viewport.label}-fallback-replaced`);
  let cliReportProof = null;
  let forcingProof = null;
  let cliReportScreenshot = null;
  let forcingScreenshot = null;
  if (viewport.label === "desktop-1440x900") {
    assert(await evaluate(cdp, click('[data-play-ui="explore-cli-report-summary"]')), "could not open the Explore CLI report");
    await waitFor(cdp, `document.querySelector('[data-play-ui="explore-cli-report"]')?.open === true`, "Explore CLI report did not open");
    cliReportProof = await evaluateJson(cdp, snapshotExpression(`${viewport.label}-cli-report-open`));
    assert(cliReportProof.cliReportOpen === true, "Explore CLI report disclosure did not stay open", cliReportProof);
    assert(cliReportProof.documentScrollWidth <= cliReportProof.documentClientWidth, "opening the Explore CLI report introduced horizontal overflow", { scrollWidth: cliReportProof.documentScrollWidth, clientWidth: cliReportProof.documentClientWidth });
    cliReportScreenshot = await screenshot(cdp, `${viewport.label}-cli-report-open`);
    assert(await evaluate(cdp, click('[data-play-ui="explore-options-summary"]')), "could not open Explore options for the forcing view");
    await waitFor(cdp, `document.querySelector('[data-play-ui="explore-options"]')?.open === true`, "Explore options did not open for the forcing view");
    assert(await evaluate(cdp, click('[data-play-ui="reaction-view-button"][data-reaction-view="forcing"]')), "could not switch the reaction view toggle to forcing");
    await waitFor(cdp, `document.querySelector('[data-play-ui="forcing-lens"]')?.getAttribute('data-forcing-status') === 'failed'`, "forcing view did not settle after the fixture forcingMap failure");
    forcingProof = await evaluateJson(cdp, snapshotExpression(`${viewport.label}-forcing-view`));
    assert(forcingProof.forcingStatus === "failed", "forcing view did not report the failed forcingMap state", forcingProof);
    assert(forcingProof.forcingButtonPressed === "true", "forcing view toggle did not show the forcing button as pressed", forcingProof);
    assert(forcingProof.documentScrollWidth <= forcingProof.documentClientWidth, "the forcing view introduced horizontal overflow", { scrollWidth: forcingProof.documentScrollWidth, clientWidth: forcingProof.documentClientWidth });
    forcingScreenshot = await screenshot(cdp, `${viewport.label}-forcing-view`);
    assert(await evaluate(cdp, click('[data-play-ui="reaction-view-button"][data-reaction-view="reaction"]')), "could not switch the reaction view toggle back to reaction");
    await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready'`, "reaction view did not restore after toggling back");
  }
  const stateProofs = [];
  if (viewport.width >= 761) {
    for (const state of ["pending", "failed", "loading", "error", "terminal"]) {
      await loadStateProofPage(cdp, port, viewport, state);
      const snapshot = await evaluateJson(cdp, snapshotExpression(`${viewport.label}-${state}`));
      if (state === "loading") {
        assertLoadingProof(snapshot);
      } else if (state === "error") {
        assertRootErrorProof(snapshot);
      } else if (state === "terminal") {
        assertTerminalProof(snapshot);
      } else {
        assertNonHappyStateProof(snapshot, state);
      }
      stateProofs.push({ state, snapshot, screenshot: await screenshot(cdp, `${viewport.label}-${state}`) });
    }
    await loadRiskProofPage(cdp, port, viewport);
    const risk = await evaluateJson(cdp, snapshotExpression(`${viewport.label}-risk`));
    assertRiskProof(risk);
    stateProofs.push({ state: "risk", snapshot: risk, screenshot: await screenshot(cdp, `${viewport.label}-risk`) });
  }
  if (viewport.label === "desktop-1440x900") {
    await assertReducedMotionBridge(cdp, port, viewport);
  }
  return { viewport: viewport.label, initial, detailed, afterMove, blackBest, blackBad, fallback, replacement, cliReportProof, forcingProof, stateProofs, screenshots: [initialScreenshot, detailedScreenshot, afterMoveScreenshot, ...blackBest.screenshots, ...blackBad.screenshots, fallbackScreenshot, replacementScreenshot, ...(cliReportScreenshot ? [cliReportScreenshot] : []), ...(forcingScreenshot ? [forcingScreenshot] : []), ...stateProofs.map((item) => item.screenshot)] };
}

prepareProofRoot();
const { server, port, servedResponses } = await startStaticServer(proofRoot, csp);
const debugPort = await reserveLoopbackPort();
const results = [];
try {
  await runCdpProof(proofRoot, debugPort, async (cdp) => {
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
    });
    for (const viewport of viewports) results.push(await runViewport(cdp, port, viewport));
  });
} finally {
  server.close();
}
assert(servedResponses.some((response) => response.pathname === "/index.html" && response.contentType.includes("text/html")), "proof server did not serve index.html", servedResponses);
assert(servedResponses.some((response) => response.pathname === "/assets/pieces/adr-0206-cburnett/white-king-v1.svg" && response.contentType === "image/svg+xml"), "proof server did not serve the Cburnett SVG asset", servedResponses);
const summary = join(proofRoot, "summary.json");
const summaryPayload = {
  schema: "explore-ui-contract-proof-v2",
  status: "PASS",
  proof: "selected-side Classical Explore UI contract",
  source: "deterministic fixture; not production runtime evidence",
  viewports: results.map(({ viewport, initial }) => ({
    viewport,
    board: initial.boardRect,
    boardBottomVisible: initial.boardBottomVisible,
    primaryGates: initial.primaryGatesRect,
    continuation: initial.continuationRect,
    pageWidth: initial.pageWidth,
    pageHeight: initial.pageHeight
  })),
  checks: [
    "Explore/Aggressive single-column board-first flow: board stage first, verdict band directly under the board with visible status pill, controls subordinate after the decision, and full-width continuation rows",
    "Explore/Aggressive initial composition and primary section order",
    "localized board ARIA, Cburnett assets, keyboard focus/navigation, click/drag and touch tap contracts",
    "desktop 1440x900, 1366x768, 1280x800 and 1920x1080 geometry plus responsive 390px smoke",
    "fresh HTTP 200/content-type probes and zero browser/page runtime errors",
    "pending, failed, loading, root error, terminal, provisional, rich replacement, and risk states",
    "More detail and Explore options disclosure persistence across locale rerenders",
    "Explore CLI report disclosure opens without horizontal overflow (desktop 1440x900)",
    "forcing lens view reachable from the reaction view toggle; fixture forcingMap failure settles as failed",
    "normal smooth and reduced-motion auto scrolling for board-to-band bridges",
    "selected-side branches, post-move recomputation, and fixture sideExplore request identity"
  ],
  screenshots: results.flatMap(({ screenshots }) => screenshots)
};
writeFileSync(summary, `${JSON.stringify(summaryPayload, null, 2)}\n`);
console.log("Explore Aggressive board-first browser proof passed");
console.log(`summary: ${summary}`);
