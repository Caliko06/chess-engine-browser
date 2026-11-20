import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertWasmBindgenCliVersion,
  betaCsp,
  copyBuiltWeb,
  copyProductCss,
  copyProductHtml,
  run,
  scanStaticOutput,
  writeEmbeddedWasmModule
} from "./beta-preview-support.mjs";
import {
  evaluate,
  evaluateJson,
  reserveLoopbackPort,
  runCdpProof,
  startStaticServer,
  waitFor
} from "./browser-proof-support.mjs";

const proofRoot = "/private/tmp/chess-play-review-lifecycle-coordination-proof";
const approvedPieceSet = "adr-0137-staunton-sheet-v1";
const viewports = [
  { width: 1280, height: 900, label: "desktop", touchInput: false },
  { width: 390, height: 844, label: "narrow", touchInput: true }
];

function prepareOutput() {
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(join(proofRoot, "dist/pkg"), { recursive: true });
  run("node", ["scripts/audit-policy.mjs"]);
  run("pnpm", ["--filter", "web", "run", "build"]);
  assertWasmBindgenCliVersion("Play Review lifecycle proof");
  run("cargo", ["build", "-p", "chess-wasm-bridge", "--target", "wasm32-unknown-unknown", "--release"]);
  run("wasm-bindgen", [
    "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm",
    "--target",
    "bundler",
    "--out-dir",
    join(proofRoot, "dist/pkg")
  ]);
  writeEmbeddedWasmModule(proofRoot, { assertExpectedImports: true, removeWasmAsset: true });
  copyBuiltWeb(proofRoot);
  copyProductHtml(proofRoot, {
    missingMessage: "Play Review lifecycle product HTML is missing",
    scanBeforeChecks: true,
    cspCheck: "meta",
    cspMismatchMessage: (metaCsp) => `Play Review lifecycle CSP mismatch: ${metaCsp}`,
    requiredIncludes: [
      { text: 'id="chess-review-app"', message: "product root is missing" },
      { text: 'href="./review.css"', message: "stylesheet href is missing" },
      { text: 'src="./dist/app.js"', message: "app entrypoint is missing" }
    ]
  });
  copyProductCss(proofRoot, { missingMessage: "Play stylesheet is missing" });
  writePromotionProofHarness(proofRoot);
  writeReadabilityProofHarness(proofRoot);
  scanStaticOutput(proofRoot, {
    extraForbiddenTokens: ['<script type="importmap"', "ServiceWorker", "Worker("]
  });
}

function writePromotionProofHarness(outputRoot) {
  writeFileSync(
    join(outputRoot, "promotion-proof.html"),
    [
      "<!doctype html>",
      '<meta charset="utf-8">',
      "<title>Play promotion selection proof</title>",
      '<link rel="stylesheet" href="./review.css">',
      '<body><main id="promotion-proof-root"></main><script type="module" src="./promotion-proof.mjs"></script></body>'
    ].join(""),
    "utf8"
  );
  writeFileSync(
    join(outputRoot, "promotion-proof.mjs"),
    `
import { mountPlayUi } from "./dist/play-ui.js";

const promotionState = {
  fen: "k7/4P3/8/8/8/8/8/4K3 w - - 0 1",
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["e7e8q", "e7e8r", "e7e8b", "e7e8n"]
};
const afterPromotion = {
  appliedMove: "e7e8r",
  san: "e8=R+",
  state: {
    fen: "k3R3/8/8/8/8/8/8/4K3 b - - 0 1",
    status: "checkmate",
    sideToMove: "black",
    legalMoves: []
  }
};
const calls = [];
Object.defineProperty(window, "__selectionPromotionCalls", { configurable: true, value: calls });
const root = document.querySelector("#promotion-proof-root");
if (!(root instanceof HTMLElement)) throw new Error("promotion proof root missing");
await mountPlayUi(root, {
  engine: {
    newGame: () => {
      calls.push("newGame");
      return Promise.resolve({ ok: true, value: promotionState });
    },
    makeMove: (_fen, move) => {
      calls.push("makeMove:" + move);
      return Promise.resolve({ ok: true, value: afterPromotion });
    },
    bestMove: (_fen, depth) => {
      calls.push("bestMove:" + String(depth));
      return Promise.resolve({ ok: true, value: { bestMove: null, depth, scoreCp: 0, nodes: 4, ttHits: 0 } });
    }
  }
}).ready;
Object.defineProperty(window, "__selectionPromotionReady", { configurable: true, value: true });
`,
    "utf8"
  );
}

function writeReadabilityProofHarness(outputRoot) {
  writeFileSync(
    join(outputRoot, "readability-proof.html"),
    [
      "<!doctype html>",
      '<meta charset="utf-8">',
      "<title>Play board readability proof</title>",
      '<link rel="stylesheet" href="./review.css">',
      '<body><main id="readability-proof-root"></main><script type="module" src="./readability-proof.mjs"></script></body>'
    ].join(""),
    "utf8"
  );
  writeFileSync(
    join(outputRoot, "readability-proof.mjs"),
    `
import { mountPlayUi } from "./dist/play-ui.js";

const captureState = {
  fen: "4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1",
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["e4d5"]
};
const calls = [];
Object.defineProperty(window, "__boardReadabilityCalls", { configurable: true, value: calls });
const root = document.querySelector("#readability-proof-root");
if (!(root instanceof HTMLElement)) throw new Error("readability proof root missing");
await mountPlayUi(root, {
  engine: {
    newGame: () => {
      calls.push("newGame");
      return Promise.resolve({ ok: true, value: captureState });
    },
    makeMove: (_fen, move) => {
      calls.push("makeMove:" + move);
      return Promise.resolve({
        ok: true,
        value: {
          appliedMove: move,
          san: "exd5",
          state: {
            fen: "4k3/8/8/3P4/8/8/8/4K3 b - - 0 1",
            status: "ongoing",
            sideToMove: "black",
            legalMoves: []
          }
        }
      });
    },
    bestMove: (_fen, depth) => {
      calls.push("bestMove:" + String(depth));
      return Promise.resolve({ ok: true, value: { bestMove: null, depth, scoreCp: 0, nodes: 4, ttHits: 0 } });
    }
  }
}).ready;
Object.defineProperty(window, "__boardReadabilityReady", { configurable: true, value: true });
`,
    "utf8"
  );
}

function click(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLButtonElement)) return false;
    element.click();
    return true;
  })()`;
}

function hitTarget(selector) {
  return `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement)) {
      return JSON.stringify({ ok: false, reason: "missing-target", selector: ${JSON.stringify(selector)} });
    }
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const closest = hit instanceof Element ? hit.closest(${JSON.stringify(selector)}) : null;
    return JSON.stringify({
      ok: closest === target,
      reason: closest === target ? "ok" : "covered-or-offscreen",
      selector: ${JSON.stringify(selector)},
      point: { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) },
      targetRect: {
        left: Number(rect.left.toFixed(2)),
        top: Number(rect.top.toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2))
      },
      hitTag: hit instanceof Element ? hit.tagName : null,
      hitUi: hit instanceof Element ? hit.getAttribute("data-play-ui") ?? hit.getAttribute("data-app-ui") : null,
      hitSquare: hit instanceof Element ? hit.getAttribute("data-square") : null
    });
  })()`;
}

async function clickTopmost(cdp, selector, label) {
  const hit = await evaluateJson(cdp, hitTarget(selector));
  if (hit.ok !== true) {
    throw new Error(`${label}: target is not topmost ${JSON.stringify(hit)}`);
  }
  await evaluate(cdp, click(selector));
}

async function dragTopmost(cdp, fromSelector, toSelector, label) {
  const from = await evaluateJson(cdp, hitTarget(fromSelector));
  const to = await evaluateJson(cdp, hitTarget(toSelector));
  if (from.ok !== true || to.ok !== true) {
    throw new Error(`${label}: drag target is not topmost ${JSON.stringify({ from, to })}`);
  }
  const steps = 8;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.point.x,
    y: from.point.y
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.point.x,
    y: from.point.y,
    button: "left",
    buttons: 1,
    clickCount: 1
  });
  let visual = null;
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.point.x + (to.point.x - from.point.x) * progress,
      y: from.point.y + (to.point.y - from.point.y) * progress,
      button: "left",
      buttons: 1
    });
    if (index === Math.ceil(steps / 2)) {
      visual = await evaluateJson(cdp, dragVisualSnapshot(fromSelector, `${label} mid-drag`));
    }
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.point.x,
    y: to.point.y,
    button: "left",
    buttons: 0,
    clickCount: 1
  });
  return visual ?? (await evaluateJson(cdp, dragVisualSnapshot(fromSelector, `${label} post-drag`)));
}

async function touchDragTopmost(cdp, fromSelector, toSelector, label) {
  const from = await evaluateJson(cdp, hitTarget(fromSelector));
  const to = await evaluateJson(cdp, hitTarget(toSelector));
  if (from.ok !== true || to.ok !== true) {
    throw new Error(`${label}: touch drag target is not topmost ${JSON.stringify({ from, to })}`);
  }
  const steps = 8;
  const pointAt = (progress) => ({
    x: from.point.x + (to.point.x - from.point.x) * progress,
    y: from.point.y + (to.point.y - from.point.y) * progress,
    radiusX: 2,
    radiusY: 2,
    force: 1,
    id: 1
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [pointAt(0)]
  });
  let visual = null;
  for (let index = 1; index <= steps; index += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [pointAt(index / steps)]
    });
    if (index === Math.ceil(steps / 2)) {
      visual = await evaluateJson(cdp, dragVisualSnapshot(fromSelector, `${label} mid-drag`));
    }
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: []
  });
  return visual ?? (await evaluateJson(cdp, dragVisualSnapshot(fromSelector, `${label} post-drag`)));
}

async function dragByViewportInput(cdp, fromSelector, toSelector, label, viewport) {
  if (viewport.touchInput === true) {
    return await touchDragTopmost(cdp, fromSelector, toSelector, label);
  }
  return await dragTopmost(cdp, fromSelector, toSelector, label);
}

function dragVisualSnapshot(sourceSelector, label) {
  return `(() => {
    const source = document.querySelector(${JSON.stringify(sourceSelector)});
    const sourcePiece = source?.querySelector(':scope > [data-play-ui="board-piece"]');
    const sourceStyle = source instanceof HTMLElement ? getComputedStyle(source) : null;
    const sourcePieceStyle = sourcePiece instanceof HTMLElement ? getComputedStyle(sourcePiece) : null;
    const followers = Array.from(document.querySelectorAll('[data-play-ui="board-drag-piece"]'), (follower) => {
      const inner = follower.querySelector(':scope > [data-play-ui="board-piece"]');
      const style = follower instanceof HTMLElement ? getComputedStyle(follower) : null;
      const innerStyle = inner instanceof HTMLElement ? getComputedStyle(inner) : null;
      const rect = follower instanceof HTMLElement ? follower.getBoundingClientRect() : null;
      const innerRect = inner instanceof HTMLElement ? inner.getBoundingClientRect() : null;
      return {
        from: follower.getAttribute('data-board-drag-from'),
        color: follower.getAttribute('data-board-piece-color'),
        kind: follower.getAttribute('data-board-piece-kind'),
        text: follower.textContent?.trim() ?? '',
        backgroundImage: style?.backgroundImage ?? null,
        backgroundColor: style?.backgroundColor ?? null,
        borderTopWidth: style?.borderTopWidth ?? null,
        boxShadow: style?.boxShadow ?? null,
        pointerEvents: style?.pointerEvents ?? null,
        rect: rect === null ? null : {
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
          left: Number(rect.left.toFixed(2)),
          top: Number(rect.top.toFixed(2))
        },
        innerBackgroundImage: innerStyle?.backgroundImage ?? null,
        innerFontSize: innerStyle?.fontSize ?? null,
        innerRect: innerRect === null ? null : {
          width: Number(innerRect.width.toFixed(2)),
          height: Number(innerRect.height.toFixed(2))
        }
      };
    });
    return JSON.stringify({
      label: ${JSON.stringify(label)},
      sourceSquare: source instanceof HTMLElement ? source.getAttribute('data-square') : null,
      sourceDragActive: source instanceof HTMLElement ? source.getAttribute('data-board-drag-active') : null,
      sourcePieceOpacity: sourcePieceStyle?.opacity ?? null,
      sourceBackgroundImage: sourceStyle?.backgroundImage ?? null,
      sourceBoxShadow: sourceStyle?.boxShadow ?? null,
      draggingSquares: Array.from(document.querySelectorAll('[data-play-ui="board-square"][data-board-dragging="true"]'), (square) => square.getAttribute('data-square')),
      followers
    });
  })()`;
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForBoardMotion(cdp, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, "document.querySelector('[data-play-ui=\"board-motion-piece\"]') !== null")) {
      return;
    }
    await sleep(40);
  }
  throw new Error(label);
}

function focus(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.focus();
    return document.activeElement === element;
  })()`;
}

function scrollIntoView(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    return true;
  })()`;
}

function installClipboard(reject) {
  return `(() => {
    const writes = [];
    Object.defineProperty(window, "__proofClipboardWrites", { configurable: true, value: writes });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value) => {
          writes.push(value);
          return ${reject ? "Promise.reject(new Error('proof clipboard unavailable'))" : "Promise.resolve()"};
        }
      }
    });
  })()`;
}

function snapshot(label, options = {}) {
  const visibleSelectors = [
    '[data-play-ui="root"]',
    '[data-play-ui="header"]',
    '[data-play-ui="header-actions"]',
    '[data-play-ui="board-panel"]',
    '[data-play-ui="board"]',
    '[data-play-ui="board-grid"]',
    '[data-play-ui="side-panel"]',
    '[data-play-ui="facts"]',
    '[data-play-ui="move-list"]',
    '[data-play-ui="selection-assist"]',
    '[data-play-ui="current-fen"]',
    '[data-play-ui="current-fen-copy"]',
    '[data-play-ui="current-fen-copy-button"]',
    '[data-play-ui="current-fen-copy-status"]',
    '[data-play-ui="post-game"]'
  ];
  if (options.allowLens === true) {
    visibleSelectors.push('[data-play-ui="analysis-lens"]');
  }
  if (options.standalone !== true) {
    visibleSelectors.push('[data-app-ui="post-game-review"]');
  }
  return `(() => {
    const issues = [];
    const pieceSet = document.querySelector('[data-piece-set]')?.getAttribute('data-piece-set') ?? null;
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const factValue = (selector) => document.querySelector(selector + " dd")?.textContent?.trim() ?? "";
    const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? null;
    const rectOf = (selector) => {
      const element = document.querySelector(selector);
      return element instanceof HTMLElement ? element.getBoundingClientRect() : null;
    };
    const visibleArea = (rect) => {
      if (rect === null) return 0;
      const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      return width * height;
    };
    const rectSnapshot = (name, selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return { name, missing: true };
      const rect = element.getBoundingClientRect();
      const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      if (element.hidden && rect.width > 0 && rect.height > 0) {
        issues.push({
          kind: "hidden-element-rendered",
          selector,
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2))
        });
      }
      return {
        name,
        hidden: element.hidden,
        top: Number(rect.top.toFixed(2)),
        right: Number(rect.right.toFixed(2)),
        bottom: Number(rect.bottom.toFixed(2)),
        left: Number(rect.left.toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
        visibleWidth: Number(width.toFixed(2)),
        visibleHeight: Number(height.toFixed(2))
      };
    };
    const backgroundAlpha = (element) => {
      if (!(element instanceof HTMLElement)) return 0;
      const background = window.getComputedStyle(element).backgroundColor;
      const rgba = background.match(/^rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*([\\d.]+)\\s*\\)$/);
      if (rgba !== null) return Number.parseFloat(rgba[1]);
      return background === "transparent" ? 0 : 1;
    };
    const styleSnapshot = (name, selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return { name, missing: true };
      const style = window.getComputedStyle(element);
      return {
        name,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderTopColor: style.borderTopColor,
        boxShadow: style.boxShadow,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        opacity: style.opacity
      };
    };
    const visible = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        issues.push({ kind: "missing", selector });
        return;
      }
      const rect = element.getBoundingClientRect();
      if (element.hidden && rect.width > 0 && rect.height > 0) {
        issues.push({
          kind: "hidden-element-rendered",
          selector,
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2))
        });
        return;
      }
      if (element.hidden) return;
      if (rect.width <= 0 || rect.height <= 0) issues.push({ kind: "zero", selector });
      if (rect.left < -1 || rect.right > window.innerWidth + 1) {
        issues.push({ kind: "horizontal-overflow", selector, left: rect.left, right: rect.right });
      }
    };
    for (const selector of ${JSON.stringify(visibleSelectors)}) visible(selector);
    const analysisLens = document.querySelector('[data-play-ui="analysis-lens"]');
    if (${options.allowLens === true ? "false" : "true"} && analysisLens !== null) {
      issues.push({ kind: "unexpected-analysis-lens" });
    }
    const lensText = analysisLens?.textContent ?? "";
    if (/Chess\\.com|Brilliant|Great|Miss|Mistake|Blunder|Book|Theory|Expected Points/iu.test(lensText)) {
      issues.push({ kind: "forbidden-analysis-lens-wording", text: lensText.trim() });
    }
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (pageWidth > window.innerWidth + 1) {
      issues.push({ kind: "page-overflow", pageWidth, viewportWidth: window.innerWidth });
    }
    for (const element of document.querySelectorAll('[data-play-ui="header"], [data-play-ui="header-actions"], [data-play-ui="controls"], [data-play-ui="player-side-control"], [data-play-ui="engine-depth-control"], [data-play-ui="status"], [data-play-ui="new-game-button"], [data-play-ui="resign-button"], [data-play-ui="layout"], [data-play-ui="board-panel"], [data-play-ui="facts"], [data-play-ui="analysis-lens"], [data-play-ui="move-list"], [data-play-ui="move-rows"], [data-play-ui="move-row"], [data-play-ui="move-turn"], [data-play-ui="move-side"], [data-play-ui="move-san"], [data-play-ui="move-coordinate"], [data-play-ui="terminal-actions"], [data-play-ui="selection-assist"], [data-play-ui="selected-square"], [data-play-ui="selection-legal-count"], [data-play-ui="selection-legal-targets"], [data-play-ui="current-fen"], [data-play-ui="current-fen-copy-button"], [data-play-ui="current-fen-copy-status"], [data-play-ui="last-move"], [data-play-ui="rematch-button"], [data-play-ui="post-game-review-button"], [data-play-ui="terminal-copy-pgn-button"], [data-play-ui="terminal-copy-pgn-status"], [data-app-ui="post-game-review-title"]')) {
      if (element instanceof HTMLElement && !element.hidden && element.scrollWidth > element.clientWidth + 1) {
        issues.push({ kind: "text-overflow", ui: element.getAttribute("data-play-ui") ?? element.getAttribute("data-app-ui") });
      }
    }
    const grid = document.querySelector('[data-play-ui="board-grid"]');
    if (grid instanceof HTMLElement) {
      const rect = grid.getBoundingClientRect();
      if (Math.abs(rect.width - rect.height) > 2) issues.push({ kind: "grid-not-square", width: rect.width, height: rect.height });
      const squares = Array.from(document.querySelectorAll('[data-play-ui="board-square"]'));
      if (squares.length !== 64) {
        issues.push({ kind: "square-count", count: squares.length });
      } else {
        const expected = rect.width / 8;
        const tolerance = Math.max(1, expected * 0.025);
        const rows = new Map();
        const columns = new Map();
        for (const square of squares) {
          if (!(square instanceof HTMLElement)) continue;
          const squareRect = square.getBoundingClientRect();
          const id = square.getAttribute("data-square");
          if (squareRect.width <= 0 || squareRect.height <= 0) {
            issues.push({ kind: "square-zero", square: id, width: squareRect.width, height: squareRect.height });
          }
          if (Math.abs(squareRect.width - expected) > tolerance || Math.abs(squareRect.height - expected) > tolerance) {
            issues.push({
              kind: "square-size-drift",
              square: id,
              width: Number(squareRect.width.toFixed(2)),
              height: Number(squareRect.height.toFixed(2)),
              expected: Number(expected.toFixed(2))
            });
          }
          const rowKey = Math.round(squareRect.top);
          const columnKey = Math.round(squareRect.left);
          rows.set(rowKey, (rows.get(rowKey) ?? 0) + 1);
          columns.set(columnKey, (columns.get(columnKey) ?? 0) + 1);
          const piece = square.querySelector('[data-play-ui="board-piece"]');
          if (piece instanceof HTMLElement) {
            const pieceRect = piece.getBoundingClientRect();
            const pieceHeightRatio = pieceRect.height / squareRect.height;
            const pieceCenterXDrift = Math.abs(pieceRect.left + pieceRect.width / 2 - (squareRect.left + squareRect.width / 2)) / squareRect.width;
            const pieceCenterYDrift = Math.abs(pieceRect.top + pieceRect.height / 2 - (squareRect.top + squareRect.height / 2)) / squareRect.height;
            if (pieceRect.left < squareRect.left - tolerance || pieceRect.right > squareRect.right + tolerance || pieceRect.top < squareRect.top - tolerance || pieceRect.bottom > squareRect.bottom + tolerance) {
              issues.push({
                kind: "piece-overflow",
                square: id,
                piece: square.getAttribute("data-board-piece"),
                pieceRect: {
                  width: Number(pieceRect.width.toFixed(2)),
                  height: Number(pieceRect.height.toFixed(2))
                },
                squareRect: {
                  width: Number(squareRect.width.toFixed(2)),
                  height: Number(squareRect.height.toFixed(2))
                }
              });
            }
            const maxPieceHeightRatio = pieceSet === ${JSON.stringify(approvedPieceSet)} ? 0.94 : 0.9;
            if (pieceHeightRatio < 0.52 || pieceHeightRatio > maxPieceHeightRatio) {
              issues.push({
                kind: "piece-height-ratio-drift",
                square: id,
                piece: square.getAttribute("data-board-piece"),
                ratio: Number(pieceHeightRatio.toFixed(3))
              });
            }
            if (pieceCenterXDrift > 0.12 || pieceCenterYDrift > 0.12) {
              issues.push({
                kind: "piece-off-center",
                square: id,
                piece: square.getAttribute("data-board-piece"),
                x: Number(pieceCenterXDrift.toFixed(3)),
                y: Number(pieceCenterYDrift.toFixed(3))
              });
            }
          }
          const legalMarker = square.querySelector('[data-play-ui="legal-dot"]');
          if (square.getAttribute("data-board-legal-target") === "true") {
            if (!(legalMarker instanceof HTMLElement)) {
              issues.push({ kind: "legal-marker-missing", square: id });
            } else {
              const markerRect = legalMarker.getBoundingClientRect();
              const markerWidthRatio = markerRect.width / squareRect.width;
              const markerHeightRatio = markerRect.height / squareRect.height;
              const markerCenterXDrift = Math.abs(markerRect.left + markerRect.width / 2 - (squareRect.left + squareRect.width / 2)) / squareRect.width;
              const markerCenterYDrift = Math.abs(markerRect.top + markerRect.height / 2 - (squareRect.top + squareRect.height / 2)) / squareRect.height;
              const occupied = square.hasAttribute("data-board-piece");
              if (occupied && (markerWidthRatio < 0.52 || markerWidthRatio > 0.86 || markerHeightRatio < 0.52 || markerHeightRatio > 0.86)) {
                issues.push({
                  kind: "capture-marker-size-drift",
                  square: id,
                  widthRatio: Number(markerWidthRatio.toFixed(3)),
                  heightRatio: Number(markerHeightRatio.toFixed(3))
                });
              }
              if (!occupied && (markerWidthRatio < 0.18 || markerWidthRatio > 0.38 || markerHeightRatio < 0.18 || markerHeightRatio > 0.38)) {
                issues.push({
                  kind: "empty-marker-size-drift",
                  square: id,
                  widthRatio: Number(markerWidthRatio.toFixed(3)),
                  heightRatio: Number(markerHeightRatio.toFixed(3))
                });
              }
              if (markerCenterXDrift > 0.12 || markerCenterYDrift > 0.12) {
                issues.push({
                  kind: "legal-marker-off-center",
                  square: id,
                  x: Number(markerCenterXDrift.toFixed(3)),
                  y: Number(markerCenterYDrift.toFixed(3))
                });
              }
            }
          } else if (legalMarker instanceof HTMLElement) {
            issues.push({ kind: "unexpected-legal-marker", square: id });
          }
          if (document.activeElement === square) {
            const style = window.getComputedStyle(square);
            if (style.outlineStyle !== "none" && Number.parseFloat(style.outlineOffset) > 0) {
              issues.push({ kind: "focused-square-outline-outset", square: id, outlineOffset: style.outlineOffset });
            }
          }
        }
        if (rows.size !== 8 || columns.size !== 8) {
          issues.push({
            kind: "board-track-count-drift",
            rows: Array.from(rows.entries()),
            columns: Array.from(columns.entries())
          });
        }
        for (const [top, count] of rows) {
          if (count !== 8) issues.push({ kind: "board-row-square-count-drift", top, count });
        }
        for (const [left, count] of columns) {
          if (count !== 8) issues.push({ kind: "board-column-square-count-drift", left, count });
        }
      }
    }
    const rects = [
      rectSnapshot("root", '[data-play-ui="root"]'),
      rectSnapshot("header", '[data-play-ui="header"]'),
      rectSnapshot("headerActions", '[data-play-ui="header-actions"]'),
      rectSnapshot("controls", '[data-play-ui="controls"]'),
      rectSnapshot("layout", '[data-play-ui="layout"]'),
      rectSnapshot("boardPanel", '[data-play-ui="board-panel"]'),
      rectSnapshot("board", '[data-play-ui="board"]'),
      rectSnapshot("boardGrid", '[data-play-ui="board-grid"]'),
      rectSnapshot("sidePanel", '[data-play-ui="side-panel"]'),
      rectSnapshot("facts", '[data-play-ui="facts"]'),
      rectSnapshot("analysisLens", '[data-play-ui="analysis-lens"]'),
      rectSnapshot("moveList", '[data-play-ui="move-list"]'),
      rectSnapshot("postGame", '[data-play-ui="post-game"]'),
      rectSnapshot("postGameReview", '[data-app-ui="post-game-review"]')
    ];
    const firstBoardSquare = document.querySelector('[data-play-ui="board-square"]');
    const lastBoardSquare = Array.from(document.querySelectorAll('[data-play-ui="board-square"]')).at(-1);
    const moveRowsElement = document.querySelector('[data-play-ui="move-rows"]');
    const moveRowsStyle = moveRowsElement instanceof HTMLElement ? window.getComputedStyle(moveRowsElement) : null;
    const boardMotionPieces = Array.from(document.querySelectorAll('[data-play-ui="board-motion-piece"]'), (piece) => {
      const rect = piece instanceof HTMLElement ? piece.getBoundingClientRect() : null;
      return {
        actor: piece.getAttribute("data-board-motion-actor"),
        move: piece.getAttribute("data-board-motion-move"),
        from: piece.getAttribute("data-board-motion-from"),
        to: piece.getAttribute("data-board-motion-to"),
        durationMs: Number.parseInt(piece.getAttribute("data-board-motion-duration-ms") ?? "0", 10),
        text: piece.textContent?.trim() ?? "",
        rect: rect === null
          ? null
          : {
              width: Number(rect.width.toFixed(2)),
              height: Number(rect.height.toFixed(2)),
              left: Number(rect.left.toFixed(2)),
              top: Number(rect.top.toFixed(2))
            }
      };
    });
    const visualIdentity = (() => {
      if (${options.standalone === true ? "true" : "false"}) return null;
      const activeControl = document.querySelector('[data-play-ui="player-side-button"][aria-pressed="true"]');
      const inactiveControl = document.querySelector('[data-play-ui="player-side-button"][aria-pressed="false"]');
      const supportHeadingStyles = Array.from(
        document.querySelectorAll('[data-play-ui="facts"] h2, [data-play-ui="move-list"] h2, [data-play-ui="post-game"] h2'),
        (heading) => {
          const style = window.getComputedStyle(heading);
          return {
            text: heading.textContent?.trim() ?? "",
            color: style.color,
            fontSize: Number.parseFloat(style.fontSize),
            fontWeight: style.fontWeight
          };
        }
      );
      const bodyStyle = window.getComputedStyle(document.body);
      if (bodyStyle.backgroundImage === "none") {
        issues.push({ kind: "page-shell-flat" });
      }
      for (const heading of supportHeadingStyles) {
        if (heading.fontSize > 14.5) {
          issues.push({
            kind: "supporting-heading-too-prominent",
            text: heading.text,
            fontSize: Number(heading.fontSize.toFixed(2))
          });
        }
      }
      if (activeControl instanceof HTMLElement && inactiveControl instanceof HTMLElement) {
        const activeStyle = window.getComputedStyle(activeControl);
        const inactiveStyle = window.getComputedStyle(inactiveControl);
        if (activeStyle.borderTopColor === inactiveStyle.borderTopColor) {
          issues.push({ kind: "active-control-border-not-distinct", color: activeStyle.borderTopColor });
        }
        if (activeStyle.boxShadow === "none") {
          issues.push({ kind: "active-control-state-too-flat" });
        }
      }
      return {
        body: styleSnapshot("body", "body"),
        root: styleSnapshot("root", '[data-play-ui="root"]'),
        boardPanel: styleSnapshot("boardPanel", '[data-play-ui="board-panel"]'),
        boardGrid: styleSnapshot("boardGrid", '[data-play-ui="board-grid"]'),
        status: styleSnapshot("status", '[data-play-ui="status"]'),
        activeSide: styleSnapshot("activeSide", '[data-play-ui="player-side-button"][aria-pressed="true"]'),
        inactiveSide: styleSnapshot("inactiveSide", '[data-play-ui="player-side-button"][aria-pressed="false"]'),
        activeDepth: styleSnapshot("activeDepth", '[data-play-ui="engine-depth-button"][aria-pressed="true"]'),
        inactiveDepth: styleSnapshot("inactiveDepth", '[data-play-ui="engine-depth-button"][aria-pressed="false"]'),
        supportHeadings: supportHeadingStyles,
        disabledReviewButton: styleSnapshot("disabledReviewButton", '[data-play-ui="post-game-review-button"]:disabled'),
        terminalActions: styleSnapshot("terminalActions", '[data-play-ui="terminal-actions"]')
      };
    })();
    const composition = (() => {
      if (${options.standalone === true ? "true" : "false"}) return null;
      const appReview = document.querySelector('[data-app-ui="post-game-review"]');
      if (appReview instanceof HTMLElement && appReview.hidden === false) return null;
      const rootRect = rectOf('[data-play-ui="root"]');
      const headerRect = rectOf('[data-play-ui="header"]');
      const boardPanelRect = rectOf('[data-play-ui="board-panel"]');
      const boardGridRect = rectOf('[data-play-ui="board-grid"]');
      const sidePanelRect = rectOf('[data-play-ui="side-panel"]');
      const factsRect = rectOf('[data-play-ui="facts"]');
      const moveListRect = rectOf('[data-play-ui="move-list"]');
      const postGame = document.querySelector('[data-play-ui="post-game"]');
      const postGameRect = rectOf('[data-play-ui="post-game"]');
      const reviewButton = document.querySelector('[data-play-ui="post-game-review-button"]');
      if (
        rootRect === null ||
        headerRect === null ||
        boardPanelRect === null ||
        boardGridRect === null ||
        sidePanelRect === null ||
        factsRect === null ||
        moveListRect === null ||
        postGameRect === null ||
        !(postGame instanceof HTMLElement)
      ) {
        issues.push({ kind: "composition-missing-rect" });
        return null;
      }
      const boardWidthRatio = boardGridRect.width / rootRect.width;
      const boardTopRatio = boardGridRect.top / window.innerHeight;
      const boardVisibleRatio = visibleArea(boardGridRect) / (boardGridRect.width * boardGridRect.height);
      const boardTopAfterHeader = boardGridRect.top - headerRect.bottom;
      const sideFirstViewportArea = visibleArea(sidePanelRect);
      const boardToSideFirstViewportRatio = visibleArea(boardGridRect) / Math.max(1, sideFirstViewportArea);
      const maxSupportArea = Math.max(visibleArea(factsRect), visibleArea(moveListRect), visibleArea(postGameRect));
      const boardSupportRatio = visibleArea(boardGridRect) / Math.max(1, maxSupportArea);
      const headerRatio = headerRect.height / window.innerHeight;
      const desktop = window.innerWidth >= 900;
      const postGameBackgroundAlpha = backgroundAlpha(postGame);
      const preTerminalReview = reviewButton instanceof HTMLButtonElement && reviewButton.disabled;
      if (boardVisibleRatio < 0.995) {
        issues.push({ kind: "board-first-viewport-clipped", ratio: Number(boardVisibleRatio.toFixed(3)) });
      }
      if (desktop && boardWidthRatio < 0.54) {
        issues.push({ kind: "board-not-dominant-width", ratio: Number(boardWidthRatio.toFixed(3)) });
      }
      if (!desktop && boardTopRatio > 0.28) {
        issues.push({ kind: "board-starts-too-low", ratio: Number(boardTopRatio.toFixed(3)) });
      }
      if (boardTopAfterHeader > 58) {
        issues.push({ kind: "board-separated-from-header", pixels: Number(boardTopAfterHeader.toFixed(2)) });
      }
      if (headerRatio > (desktop ? 0.18 : 0.25)) {
        issues.push({ kind: "header-competes-with-board", ratio: Number(headerRatio.toFixed(3)) });
      }
      if (desktop && preTerminalReview && boardToSideFirstViewportRatio < 3.0) {
        issues.push({
          kind: "side-rail-competes-with-board",
          ratio: Number(boardToSideFirstViewportRatio.toFixed(3))
        });
      }
      if (!desktop && sidePanelRect.top < boardGridRect.bottom) {
        issues.push({
          kind: "narrow-side-panel-overlaps-board-first-flow",
          sideTop: Number(sidePanelRect.top.toFixed(2)),
          boardBottom: Number(boardGridRect.bottom.toFixed(2))
        });
      }
      if (desktop && boardSupportRatio < 1.35) {
        issues.push({ kind: "supporting-panel-competes-with-board", ratio: Number(boardSupportRatio.toFixed(3)) });
      }
      if (preTerminalReview && postGameBackgroundAlpha > 0.25) {
        issues.push({
          kind: "pre-terminal-review-too-prominent",
          backgroundAlpha: Number(postGameBackgroundAlpha.toFixed(3))
        });
      }
      return {
        boardWidthRatio: Number(boardWidthRatio.toFixed(3)),
        boardTopRatio: Number(boardTopRatio.toFixed(3)),
        boardVisibleRatio: Number(boardVisibleRatio.toFixed(3)),
        boardTopAfterHeader: Number(boardTopAfterHeader.toFixed(2)),
        boardToSideFirstViewportRatio: Number(boardToSideFirstViewportRatio.toFixed(3)),
        sideFirstViewportArea: Number(sideFirstViewportArea.toFixed(2)),
        boardSupportRatio: Number(boardSupportRatio.toFixed(3)),
        headerRatio: Number(headerRatio.toFixed(3)),
        preTerminalReview,
        postGameBackgroundAlpha: Number(postGameBackgroundAlpha.toFixed(3))
      };
    })();
    return JSON.stringify({
      label: ${JSON.stringify(label)},
      viewport: { width: window.innerWidth, height: window.innerHeight },
      pieceSet,
      playMode: attr('[data-play-ui="root"]', "data-play-mode"),
      spectatorLens: attr('[data-app-ui="play-root"]', "data-play-spectator-lens"),
      visualViewportWidth: window.visualViewport?.width ?? window.innerWidth,
      rects,
      status: text('[data-play-ui="status"]'),
      statusOwner: attr('[data-play-ui="status"]', "data-play-status-owner"),
      statusSide: attr('[data-play-ui="status"]', "data-play-status-side"),
      motionProofElapsedMs: typeof window.__playMotionProofStart === "number"
        ? Number((performance.now() - window.__playMotionProofStart).toFixed(2))
        : null,
      boardMotionPieces,
      motionFromSquares: Array.from(document.querySelectorAll('[data-play-ui="board-square"][data-board-motion-from="true"]'), (square) => square.getAttribute("data-square")),
      motionToSquares: Array.from(document.querySelectorAll('[data-play-ui="board-square"][data-board-motion-to="true"]'), (square) => square.getAttribute("data-square")),
      orientation: attr('[data-play-ui="board"]', "data-board-orientation"),
      blackSide: attr('[data-play-ui="player-side-button"][data-player-side="black"]', "aria-pressed"),
      depth2: attr('[data-play-ui="engine-depth-button"][data-engine-depth="2"]', "aria-pressed"),
      moveRows: document.querySelectorAll('[data-play-ui="move-row"]').length,
      moveRailStyle: moveRowsStyle === null
        ? null
        : {
            display: moveRowsStyle.display,
            gridTemplateColumns: moveRowsStyle.gridTemplateColumns,
            listStyleType: moveRowsStyle.listStyleType,
            maxBlockSize: moveRowsStyle.maxBlockSize,
            overflowY: moveRowsStyle.overflowY
          },
      moveRailRows: Array.from(document.querySelectorAll('[data-play-ui="move-row"]'), (row) => {
        const cellText = (name) => row.querySelector('[data-play-ui="' + name + '"]')?.textContent?.trim() ?? "";
        return {
          ply: row.getAttribute("data-play-ply"),
          actor: row.getAttribute("data-play-actor"),
          turn: row.getAttribute("data-play-turn"),
          side: row.getAttribute("data-play-side"),
          turnText: cellText("move-turn"),
          sideText: cellText("move-side"),
          sanText: cellText("move-san"),
          coordinateText: cellText("move-coordinate"),
          text: row.textContent?.trim() ?? ""
        };
      }),
      reviewHidden: document.querySelector('[data-app-ui="post-game-review"]')?.hasAttribute("hidden") ?? null,
      terminalResult: document.querySelector('[data-play-ui="terminal-result"]') !== null,
      reviewDisabled: document.querySelector('[data-play-ui="post-game-review-button"]')?.hasAttribute("disabled") ?? null,
      rematchVisible: document.querySelector('[data-play-ui="rematch-button"]') !== null,
      currentFenText: text('[data-play-ui="current-fen"]'),
      currentFenCopyVisible: document.querySelector('[data-play-ui="current-fen-copy-button"]') !== null,
      currentFenCopyStatus: text('[data-play-ui="current-fen-copy-status"]'),
      selectionText: text('[data-play-ui="selection-assist"]'),
      selectedSquareText: text('[data-play-ui="selected-square"]'),
      legalCountText: text('[data-play-ui="selection-legal-count"]'),
      legalTargetsText: text('[data-play-ui="selection-legal-targets"]'),
      analysisLensVisible: analysisLens !== null,
      lens: {
        status: attr('[data-play-ui="analysis-lens"]', "data-lens-status"),
        mode: factValue('[data-play-ui="lens-mode"]'),
        input: factValue('[data-play-ui="lens-input"]'),
        turn: factValue('[data-play-ui="lens-turn"]'),
        legalCount: factValue('[data-play-ui="lens-legal-count"]'),
        bestMove: factValue('[data-play-ui="lens-best-move"]'),
        score: factValue('[data-play-ui="lens-score"]'),
        depth: factValue('[data-play-ui="lens-depth"]'),
        nodes: factValue('[data-play-ui="lens-nodes"]'),
        text: lensText.trim()
      },
      selectedSquares: Array.from(document.querySelectorAll('[data-play-ui="board-square"][data-board-selected="true"]'), (square) => square.getAttribute("data-square")),
      legalTargets: Array.from(document.querySelectorAll('[data-play-ui="board-square"][data-board-legal-target="true"]'), (square) => square.getAttribute("data-square")),
      lastMoveSquares: Array.from(document.querySelectorAll('[data-play-ui="board-square"][data-board-last-move="true"]'), (square) => square.getAttribute("data-square")),
      draggableSquares: Array.from(document.querySelectorAll('[data-play-ui="board-square"][data-board-draggable="true"]'), (square) => square.getAttribute("data-square")),
      firstBoardSquareId: firstBoardSquare instanceof HTMLElement ? firstBoardSquare.getAttribute("data-square") : null,
      lastBoardSquareId: lastBoardSquare instanceof HTMLElement ? lastBoardSquare.getAttribute("data-square") : null,
      focusedSquare: document.activeElement instanceof HTMLElement ? document.activeElement.getAttribute("data-square") : null,
      promotionButtons: document.querySelectorAll('[data-play-ui="promotion-button"]').length,
      lastMoveText: text('[data-play-ui="last-move"]'),
      copyVisible: document.querySelector('[data-play-ui="terminal-copy-pgn-button"]') !== null,
      copyStatus: text('[data-play-ui="terminal-copy-pgn-status"]'),
      actionOrder: Array.from(document.querySelectorAll('[data-play-ui="terminal-actions"] button[data-play-ui]'), (button) => button.getAttribute("data-play-ui")),
      actionRoles: Array.from(document.querySelectorAll('[data-play-ui="terminal-actions"] button[data-play-ui]'), (button) => ({
        id: button.getAttribute("data-play-ui"),
        role: button.getAttribute("data-terminal-action")
      })),
      clipboardWrites: Array.isArray(window.__proofClipboardWrites) ? window.__proofClipboardWrites : [],
      visualIdentity,
      composition,
      issues
    });
  })()`;
}

async function runViewport(cdp, server, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: viewport.touchInput === true,
    maxTouchPoints: 1
  });
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
  });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/index.html` });
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "Play did not mount");
  const initialNoSelection = await evaluateJson(cdp, snapshot(`${viewport.label}-initial-no-selection`));
  assertNoSelection(initialNoSelection, viewport);
  assertStatus(initialNoSelection, { text: "Your move as White", owner: "player", side: "white" });
  assertInitialDraggableSources(initialNoSelection);
  await clickTopmost(cdp, '[data-play-ui="board-square"][data-square="e2"]', `${viewport.label} e2`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"selected-square\"]')?.textContent?.trim() === 'e2'", "selected-square guidance missing");
  const selected = await evaluateJson(cdp, snapshot(`${viewport.label}-selected-e2`));
  assertStatus(selected, { text: "Your move as White", owner: "player", side: "white" });
  assertSelection(selected, viewport, {
    square: "e2",
    count: "2 legal destinations",
    targets: "e3, e4",
    legalTargets: ["e3", "e4"]
  });
  await clickTopmost(cdp, '[data-play-ui="board-square"][data-square="e2"]', `${viewport.label} e2 clear`);
  const cleared = await evaluateJson(cdp, snapshot(`${viewport.label}-selection-cleared-before-drag`));
  assertNoSelection(cleared, viewport);
  assertInitialDraggableSources(cleared);
  const dragVisual = await dragByViewportInput(cdp, '[data-play-ui="board-square"][data-square="e2"]', '[data-play-ui="board-square"][data-square="e4"]', `${viewport.label} drag e2e4`, viewport);
  assertPieceOnlyDrag(dragVisual, viewport);
  await evaluate(cdp, "window.__playMotionProofStart = performance.now()");
  await waitForBoardMotion(cdp, `${viewport.label} engine move motion did not render`);
  const engineMotion = await evaluateJson(cdp, snapshot(`${viewport.label}-engine-move-motion`));
  assertEngineMoveMotion(engineMotion);
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"move-row\"]').length >= 2", `${viewport.label} move reset proof did not complete`);
  const moveReset = await evaluateJson(cdp, snapshot(`${viewport.label}-move-reset-no-selection`));
  assertNoSelection(moveReset, viewport);
  assertStatus(moveReset, { text: "Your move as White", owner: "player", side: "white" });
  assertLastMove(moveReset);
  assertCompactMoveRail(moveReset, [
    { ply: "1", actor: "player", turn: "1", side: "white", turnText: "1.", sideText: "White", san: "e4", coordinate: "e2e4" },
    { ply: "2", actor: "engine", turn: "1", side: "black", turnText: "1...", sideText: "Black", san: "Nc6", coordinate: "b8c6" }
  ]);
  await clickTopmost(cdp, '[data-play-ui="new-game-button"]', `${viewport.label} new game`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"status\"]')?.textContent?.trim() === 'Your move as White' && document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 0", "New Game reset did not clear moves");
  const explicitNewGame = await evaluateJson(cdp, snapshot(`${viewport.label}-new-game-selection-reset`));
  assertNoSelection(explicitNewGame, viewport);
  assertStatus(explicitNewGame, { text: "Your move as White", owner: "player", side: "white" });
  await clickTopmost(cdp, '[data-play-ui="player-side-button"][data-player-side="black"]', `${viewport.label} black side`);
  await clickTopmost(cdp, '[data-play-ui="engine-depth-button"][data-engine-depth="2"]', `${viewport.label} depth 2`);
  const currentFenReady = await evaluateJson(cdp, snapshot(`${viewport.label}-current-fen-ready`));
  assertCurrentFenCopy(currentFenReady, viewport, "");
  assertStatus(currentFenReady, { text: "Engine to move as White", owner: "engine", side: "white" });
  await evaluate(cdp, installClipboard(false));
  await evaluate(cdp, scrollIntoView('[data-play-ui="current-fen-copy-button"]'));
  await clickTopmost(cdp, '[data-play-ui="current-fen-copy-button"]', `${viewport.label} copy fen`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"current-fen-copy-status\"]')?.textContent?.trim() === 'FEN copied'", "Copy FEN success status missing");
  await evaluate(cdp, "window.scrollTo(0, 0)");
  const currentFenCopied = await evaluateJson(cdp, snapshot(`${viewport.label}-current-fen-copy-success`));
  assertCurrentFenCopy(currentFenCopied, viewport, "FEN copied");
  assertCopiedFen(currentFenCopied);
  await evaluate(cdp, installClipboard(true));
  await evaluate(cdp, scrollIntoView('[data-play-ui="current-fen-copy-button"]'));
  await clickTopmost(cdp, '[data-play-ui="current-fen-copy-button"]', `${viewport.label} copy fen unavailable`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"current-fen-copy-status\"]')?.textContent?.trim() === 'FEN copy unavailable'", "Copy FEN unavailable status missing");
  await evaluate(cdp, "window.scrollTo(0, 0)");
  const currentFenUnavailable = await evaluateJson(cdp, snapshot(`${viewport.label}-current-fen-copy-unavailable`));
  assertCurrentFenCopy(currentFenUnavailable, viewport, "FEN copy unavailable");
  assertCopiedFen(currentFenUnavailable);
  await clickTopmost(cdp, '[data-play-ui="new-game-button"]', `${viewport.label} black new game`);
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 1", "Black engine-first move missing");
  await clickTopmost(cdp, '[data-play-ui="resign-button"]', `${viewport.label} resign`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"rematch-button\"]') !== null", "terminal controls missing");
  const terminal = await evaluateJson(cdp, snapshot(`${viewport.label}-terminal-copy-ready`));
  assertTerminalCopy(terminal, viewport, "");
  await evaluate(cdp, installClipboard(false));
  await evaluate(cdp, scrollIntoView('[data-play-ui="terminal-copy-pgn-button"]'));
  await clickTopmost(cdp, '[data-play-ui="terminal-copy-pgn-button"]', `${viewport.label} copy pgn`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"terminal-copy-pgn-status\"]')?.textContent?.trim() === 'PGN copied'", "Copy PGN success status missing");
  await evaluate(cdp, "window.scrollTo(0, 0)");
  const copied = await evaluateJson(cdp, snapshot(`${viewport.label}-terminal-copy-success`));
  assertTerminalCopy(copied, viewport, "PGN copied");
  assertCopiedPgn(copied);
  await evaluate(cdp, installClipboard(true));
  await evaluate(cdp, scrollIntoView('[data-play-ui="terminal-copy-pgn-button"]'));
  await clickTopmost(cdp, '[data-play-ui="terminal-copy-pgn-button"]', `${viewport.label} copy pgn unavailable`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"terminal-copy-pgn-status\"]')?.textContent?.trim() === 'PGN copy unavailable'", "Copy PGN unavailable status missing");
  await evaluate(cdp, "window.scrollTo(0, 0)");
  const unavailable = await evaluateJson(cdp, snapshot(`${viewport.label}-terminal-copy-unavailable`));
  assertTerminalCopy(unavailable, viewport, "PGN copy unavailable");
  assertCopiedPgn(unavailable);
  await evaluate(cdp, scrollIntoView('[data-play-ui="post-game-review-button"]'));
  await clickTopmost(cdp, '[data-play-ui="post-game-review-button"]', `${viewport.label} review game`);
  await waitFor(cdp, "document.querySelector('[data-app-ui=\"post-game-review\"]')?.hasAttribute('hidden') === false", "Review did not reveal");
  const revealed = await evaluateJson(cdp, snapshot(`${viewport.label}-review-revealed`));
  assertRevealed(revealed, viewport);

  await evaluate(cdp, scrollIntoView('[data-play-ui="rematch-button"]'));
  await clickTopmost(cdp, '[data-play-ui="rematch-button"]', `${viewport.label} rematch`);
  await waitFor(cdp, "document.querySelector('[data-app-ui=\"post-game-review\"]')?.hasAttribute('hidden') === true && document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 1", "Rematch did not hide Review");
  const rematch = await evaluateJson(cdp, snapshot(`${viewport.label}-rematch-hidden`));
  assertFreshGame(rematch, viewport);

  await clickTopmost(cdp, '[data-play-ui="resign-button"]', `${viewport.label} resign again`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"rematch-button\"]') !== null", "second terminal controls missing");
  await evaluate(cdp, scrollIntoView('[data-play-ui="post-game-review-button"]'));
  await clickTopmost(cdp, '[data-play-ui="post-game-review-button"]', `${viewport.label} review again`);
  await waitFor(cdp, "document.querySelector('[data-app-ui=\"post-game-review\"]')?.hasAttribute('hidden') === false", "Review did not reveal again");
  await evaluate(cdp, scrollIntoView('[data-play-ui="new-game-button"]'));
  await clickTopmost(cdp, '[data-play-ui="new-game-button"]', `${viewport.label} new game hides review`);
  await waitFor(cdp, "document.querySelector('[data-app-ui=\"post-game-review\"]')?.hasAttribute('hidden') === true && document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 1", "New Game did not hide Review");
  const newGame = await evaluateJson(cdp, snapshot(`${viewport.label}-new-game-hidden`));
  assertFreshGame(newGame, viewport);
  const promotion = await runPromotionProof(cdp, server, viewport);
  const readability = await runReadabilityProof(cdp, server, viewport);
  const spectatorLens = await runSpectatorLensProof(cdp, server, viewport);
  return { initialNoSelection, selected, moveReset, explicitNewGame, currentFenReady, currentFenCopied, currentFenUnavailable, terminal, copied, unavailable, revealed, rematch, newGame, promotion, readability, spectatorLens };
}

async function runPromotionProof(cdp, server, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: viewport.touchInput === true,
    maxTouchPoints: 1
  });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/promotion-proof.html` });
  await waitFor(cdp, "window.__selectionPromotionReady === true", "promotion proof did not mount");
  const initial = await evaluateJson(cdp, snapshot(`${viewport.label}-promotion-initial`, { standalone: true }));
  assertNoSelection(initial, viewport);
  await clickTopmost(cdp, '[data-play-ui="board-square"][data-square="e7"]', `${viewport.label} promotion e7`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"selected-square\"]')?.textContent?.trim() === 'e7'", "promotion selected-square guidance missing");
  const selected = await evaluateJson(cdp, snapshot(`${viewport.label}-promotion-selected`, { standalone: true }));
  assertSelection(selected, viewport, {
    square: "e7",
    count: "1 legal destination",
    targets: "e8",
    legalTargets: ["e8"]
  });
  await clickTopmost(cdp, '[data-play-ui="board-square"][data-square="e7"]', `${viewport.label} promotion e7 clear`);
  const cleared = await evaluateJson(cdp, snapshot(`${viewport.label}-promotion-cleared-before-drag`, { standalone: true }));
  assertNoSelection(cleared, viewport);
  await dragByViewportInput(cdp, '[data-play-ui="board-square"][data-square="e7"]', '[data-play-ui="board-square"][data-square="e8"]', `${viewport.label} promotion drag e7e8`, viewport);
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"promotion-button\"]').length === 4", "promotion choices missing");
  const choices = await evaluateJson(cdp, snapshot(`${viewport.label}-promotion-choices`, { standalone: true }));
  assertSelection(choices, viewport, {
    square: "e7",
    count: "1 legal destination",
    targets: "e8",
    legalTargets: ["e8"]
  });
  if (choices.promotionButtons !== 4) throw new Error(`${choices.label}: promotion choices drifted`);
  await clickTopmost(cdp, '[data-play-ui="promotion-button"][data-promotion-piece="rook"]', `${viewport.label} promotion rook`);
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 1 && document.querySelectorAll('[data-play-ui=\"promotion-button\"]').length === 0", "promotion move did not apply");
  const completed = await evaluateJson(cdp, snapshot(`${viewport.label}-promotion-completed`, { standalone: true }));
  assertNoSelection(completed, viewport);
  if (completed.terminalResult !== true || completed.promotionButtons !== 0) {
    throw new Error(`${completed.label}: promotion terminal state drifted`);
  }
  const moves = await evaluateJson(cdp, "JSON.stringify(window.__selectionPromotionCalls ?? [])");
  if (JSON.stringify(moves) !== JSON.stringify(["newGame", "makeMove:e7e8r"])) {
    throw new Error(`${viewport.label}: promotion calls drifted ${JSON.stringify(moves)}`);
  }
  return { initial, selected, choices, completed, moves };
}

async function runReadabilityProof(cdp, server, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/readability-proof.html` });
  await waitFor(cdp, "window.__boardReadabilityReady === true", "readability proof did not mount");
  const initial = await evaluateJson(cdp, snapshot(`${viewport.label}-readability-initial`, { standalone: true }));
  assertNoSelection(initial, viewport);
  await clickTopmost(cdp, '[data-play-ui="board-square"][data-square="e4"]', `${viewport.label} readability e4`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"selected-square\"]')?.textContent?.trim() === 'e4'", "readability selected-square guidance missing");
  await evaluate(cdp, focus('[data-play-ui="board-square"][data-square="e4"]'));
  const selected = await evaluateJson(cdp, snapshot(`${viewport.label}-readability-capture-selected`, { standalone: true }));
  assertSelection(selected, viewport, {
    square: "e4",
    count: "1 legal destination",
    targets: "d5",
    legalTargets: ["d5"]
  });
  if (selected.focusedSquare !== "e4") {
    throw new Error(`${selected.label}: board focus did not stay on selected square`);
  }
  return { initial, selected };
}

async function runSpectatorLensProof(cdp, server, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: viewport.touchInput === true,
    maxTouchPoints: 1
  });
  await cdp.send("Page.navigate", {
    url: `http://127.0.0.1:${server.port}/index.html?playSpectatorLens=adr-0142-foundation`
  });
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"analysis-lens\"]')?.getAttribute('data-lens-status') === 'ready'",
    "spectator Lens did not become ready"
  );
  const initial = await evaluateJson(cdp, snapshot(`${viewport.label}-spectator-lens-initial`, { allowLens: true }));
  assertSpectatorLens(initial, viewport, { text: "White to move", owner: "player", side: "white" });
  await clickTopmost(cdp, '[data-play-ui="board-square"][data-square="e2"]', `${viewport.label} spectator e2`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"selected-square\"]')?.textContent?.trim() === 'e2'", "spectator e2 selection missing");
  const selectedWhite = await evaluateJson(cdp, snapshot(`${viewport.label}-spectator-lens-selected-white`, { allowLens: true }));
  assertSpectatorLens(selectedWhite, viewport, { text: "White to move", owner: "player", side: "white" });
  if (!selectedWhite.legalTargets.includes("e4")) {
    throw new Error(`${selectedWhite.label}: spectator white legal targets missing e4 ${JSON.stringify(selectedWhite.legalTargets)}`);
  }
  await clickTopmost(cdp, '[data-play-ui="board-square"][data-square="e4"]', `${viewport.label} spectator e4`);
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"status\"]')?.textContent?.trim() === 'Black to move' && document.querySelector('[data-play-ui=\"analysis-lens\"]')?.getAttribute('data-lens-status') === 'ready'",
    "spectator black turn missing"
  );
  const blackTurn = await evaluateJson(cdp, snapshot(`${viewport.label}-spectator-lens-black-turn`, { allowLens: true }));
  assertSpectatorLens(blackTurn, viewport, { text: "Black to move", owner: "player", side: "black" });
  if (!blackTurn.draggableSquares.includes("b8")) {
    throw new Error(`${blackTurn.label}: spectator black side was not draggable ${JSON.stringify(blackTurn.draggableSquares)}`);
  }
  if (blackTurn.draggableSquares.includes("g1")) {
    throw new Error(`${blackTurn.label}: spectator allowed inactive white input ${JSON.stringify(blackTurn.draggableSquares)}`);
  }
  await clickTopmost(cdp, '[data-play-ui="board-square"][data-square="b8"]', `${viewport.label} spectator b8`);
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"selected-square\"]')?.textContent?.trim() === 'b8'", "spectator b8 selection missing");
  const selectedBlack = await evaluateJson(cdp, snapshot(`${viewport.label}-spectator-lens-selected-black`, { allowLens: true }));
  assertSpectatorLens(selectedBlack, viewport, { text: "Black to move", owner: "player", side: "black" });
  if (!selectedBlack.legalTargets.includes("c6")) {
    throw new Error(`${selectedBlack.label}: spectator black legal targets missing c6 ${JSON.stringify(selectedBlack.legalTargets)}`);
  }
  await clickTopmost(cdp, '[data-play-ui="board-square"][data-square="c6"]', `${viewport.label} spectator c6`);
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"status\"]')?.textContent?.trim() === 'White to move' && document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 2 && document.querySelector('[data-play-ui=\"analysis-lens\"]')?.getAttribute('data-lens-status') === 'ready'",
    "spectator second human move missing"
  );
  const secondMove = await evaluateJson(cdp, snapshot(`${viewport.label}-spectator-lens-second-move`, { allowLens: true }));
  assertSpectatorLens(secondMove, viewport, { text: "White to move", owner: "player", side: "white" });
  if (secondMove.moveRows !== 2) {
    throw new Error(`${secondMove.label}: spectator move row count drifted ${secondMove.moveRows}`);
  }
  return { initial, selectedWhite, blackTurn, selectedBlack, secondMove };
}

function assertLayoutClean(state, viewport) {
  if (state.viewport.width !== viewport.width) throw new Error(`${state.label}: viewport drift`);
  const visualViewportDelta = viewport.width - Math.round(state.visualViewportWidth);
  if (state.visualViewportWidth > viewport.width + 1 || visualViewportDelta > 20) {
    throw new Error(`${state.label}: visual viewport drift ${state.visualViewportWidth}`);
  }
  if (state.orientation === "white") {
    if (state.firstBoardSquareId !== "a8" || state.lastBoardSquareId !== "h1") {
      throw new Error(`${state.label}: white orientation square order drifted ${state.firstBoardSquareId}/${state.lastBoardSquareId}`);
    }
  }
  if (state.orientation === "black") {
    if (state.firstBoardSquareId !== "h1" || state.lastBoardSquareId !== "a8") {
      throw new Error(`${state.label}: black orientation square order drifted ${state.firstBoardSquareId}/${state.lastBoardSquareId}`);
    }
  }
  if (state.issues.length > 0) throw new Error(`${state.label}: layout issues ${JSON.stringify(state.issues)}`);
}

function assertNoSelection(state, viewport) {
  assertLayoutClean(state, viewport);
  if (!state.selectionText.includes("Selection") || !state.selectionText.includes("No selection")) {
    throw new Error(`${state.label}: no-selection guidance missing`);
  }
  if (state.selectedSquareText !== "" || state.legalCountText !== "" || state.legalTargetsText !== "") {
    throw new Error(`${state.label}: stale selected-square guidance ${JSON.stringify(state)}`);
  }
  if (state.selectedSquares.length !== 0 || state.legalTargets.length !== 0) {
    throw new Error(`${state.label}: stale board selection markers ${JSON.stringify(state)}`);
  }
}

function assertInitialDraggableSources(state) {
  if (!state.draggableSquares.includes("e2")) {
    throw new Error(`${state.label}: legal source e2 was not draggable ${JSON.stringify(state.draggableSquares)}`);
  }
  if (state.draggableSquares.includes("e4") || state.draggableSquares.includes("e7")) {
    throw new Error(`${state.label}: non-player/empty square was draggable ${JSON.stringify(state.draggableSquares)}`);
  }
}

function assertSelection(state, viewport, expected) {
  assertLayoutClean(state, viewport);
  if (state.selectedSquareText !== expected.square) {
    throw new Error(`${state.label}: selected square drifted ${state.selectedSquareText}`);
  }
  if (state.legalCountText !== expected.count) {
    throw new Error(`${state.label}: legal count drifted ${state.legalCountText}`);
  }
  if (state.legalTargetsText !== expected.targets) {
    throw new Error(`${state.label}: legal targets drifted ${state.legalTargetsText}`);
  }
  if (JSON.stringify(state.selectedSquares) !== JSON.stringify([expected.square])) {
    throw new Error(`${state.label}: selected board marker drifted ${JSON.stringify(state.selectedSquares)}`);
  }
  const actualTargets = [...state.legalTargets].sort();
  const expectedTargets = [...expected.legalTargets].sort();
  if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) {
    throw new Error(`${state.label}: legal board targets drifted ${JSON.stringify(state.legalTargets)}`);
  }
}

function assertSpectatorLens(state, viewport, expectedStatus) {
  assertLayoutClean(state, viewport);
  assertStatus(state, expectedStatus);
  if (state.playMode !== "spectator-lens") {
    throw new Error(`${state.label}: spectator play mode missing ${state.playMode}`);
  }
  if (state.spectatorLens !== "adr-0142-foundation") {
    throw new Error(`${state.label}: spectator query marker missing ${state.spectatorLens}`);
  }
  if (state.analysisLensVisible !== true || state.lens.status !== "ready") {
    throw new Error(`${state.label}: Lens was not ready ${JSON.stringify(state.lens)}`);
  }
  if (state.lens.mode !== "Spectator" || state.lens.input !== "Both sides") {
    throw new Error(`${state.label}: Lens mode/input drifted ${JSON.stringify(state.lens)}`);
  }
  if (state.lens.turn !== expectedStatus.side.replace(/^./u, (letter) => letter.toUpperCase())) {
    throw new Error(`${state.label}: Lens turn drifted ${JSON.stringify(state.lens)}`);
  }
  if (!/^[1-9][0-9]*$/u.test(state.lens.legalCount)) {
    throw new Error(`${state.label}: Lens legal count is not positive ${JSON.stringify(state.lens)}`);
  }
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(state.lens.bestMove)) {
    throw new Error(`${state.label}: Lens best move is not coordinate notation ${JSON.stringify(state.lens)}`);
  }
  if (!/^(?:[+-]?[0-9]+|0) cp$/u.test(state.lens.score)) {
    throw new Error(`${state.label}: Lens score is not a cp value ${JSON.stringify(state.lens)}`);
  }
  if (!/^[1-9][0-9]*$/u.test(state.lens.depth) || !/^[0-9]+$/u.test(state.lens.nodes)) {
    throw new Error(`${state.label}: Lens depth/nodes drifted ${JSON.stringify(state.lens)}`);
  }
  if (state.status.includes("Engine to move") || state.status.includes("Your move")) {
    throw new Error(`${state.label}: spectator status used opponent-mode wording ${state.status}`);
  }
  if (state.reviewHidden !== true) {
    throw new Error(`${state.label}: spectator mode revealed Review unexpectedly`);
  }
}

function assertCompactMoveRail(state, expectedRows) {
  if (state.moveRows !== expectedRows.length) {
    throw new Error(`${state.label}: move rail row count drifted ${state.moveRows}`);
  }
  if (state.moveRailStyle?.display !== "grid") {
    throw new Error(`${state.label}: move rail is not compact grid ${JSON.stringify(state.moveRailStyle)}`);
  }
  if (state.moveRailStyle?.listStyleType !== "none") {
    throw new Error(`${state.label}: move rail still uses list markers ${JSON.stringify(state.moveRailStyle)}`);
  }
  if (state.viewport.width >= 900 && state.moveRailStyle?.overflowY !== "auto") {
    throw new Error(`${state.label}: desktop move rail lacks local scroll containment ${JSON.stringify(state.moveRailStyle)}`);
  }
  for (const [index, expected] of expectedRows.entries()) {
    const actual = state.moveRailRows[index];
    if (actual === undefined) {
      throw new Error(`${state.label}: missing move rail row ${String(index + 1)}`);
    }
    const expectedRow = {
      ply: expected.ply,
      actor: expected.actor,
      turn: expected.turn,
      side: expected.side,
      turnText: expected.turnText,
      sideText: expected.sideText,
      sanText: expected.san,
      coordinateText: expected.coordinate
    };
    const actualRow = {
      ply: actual.ply,
      actor: actual.actor,
      turn: actual.turn,
      side: actual.side,
      turnText: actual.turnText,
      sideText: actual.sideText,
      sanText: actual.sanText,
      coordinateText: actual.coordinateText
    };
    if (JSON.stringify(actualRow) !== JSON.stringify(expectedRow)) {
      throw new Error(`${state.label}: move rail row ${expected.ply} drifted ${JSON.stringify(actual)}`);
    }
  }
}

function assertStatus(state, expected) {
  if (state.status !== expected.text) {
    throw new Error(`${state.label}: status text drifted ${JSON.stringify({ actual: state.status, expected: expected.text })}`);
  }
  if (state.statusOwner !== expected.owner || state.statusSide !== expected.side) {
    throw new Error(`${state.label}: status ownership drifted ${JSON.stringify({
      owner: state.statusOwner,
      side: state.statusSide,
      expected
    })}`);
  }
}

function assertCommon(state, viewport) {
  assertLayoutClean(state, viewport);
  if (state.orientation !== "black") throw new Error(`${state.label}: orientation not black`);
  if (state.blackSide !== "true") throw new Error(`${state.label}: Black side not preserved`);
  if (state.depth2 !== "true") throw new Error(`${state.label}: depth 2 not preserved`);
  if (!state.currentFenText.includes("FEN") || !state.currentFenText.includes("/")) {
    throw new Error(`${state.label}: current FEN text missing`);
  }
  if (state.currentFenCopyVisible !== true) throw new Error(`${state.label}: current Copy FEN missing`);
}

function assertRevealed(state, viewport) {
  assertCommon(state, viewport);
  assertNoSelection(state, viewport);
  if (state.reviewHidden !== false) throw new Error(`${state.label}: Review was not visible`);
  if (state.terminalResult !== true || state.rematchVisible !== true) throw new Error(`${state.label}: terminal controls missing`);
}

function assertTerminalCopy(state, viewport, expectedStatus) {
  assertCommon(state, viewport);
  assertNoSelection(state, viewport);
  const expectedOrder = ["rematch-button", "post-game-review-button", "terminal-copy-pgn-button"];
  const expectedRoles = [
    { id: "rematch-button", role: "primary" },
    { id: "post-game-review-button", role: "secondary" },
    { id: "terminal-copy-pgn-button", role: "utility" }
  ];
  if (state.terminalResult !== true || state.rematchVisible !== true || state.copyVisible !== true) {
    throw new Error(`${state.label}: terminal Copy PGN controls missing`);
  }
  if (JSON.stringify(state.actionOrder) !== JSON.stringify(expectedOrder)) {
    throw new Error(`${state.label}: terminal action order drifted ${JSON.stringify(state.actionOrder)}`);
  }
  if (JSON.stringify(state.actionRoles) !== JSON.stringify(expectedRoles)) {
    throw new Error(`${state.label}: terminal action roles drifted ${JSON.stringify(state.actionRoles)}`);
  }
  assertLastMove(state);
  if (state.copyStatus !== expectedStatus) throw new Error(`${state.label}: bad copy status`);
}

function assertPreTerminalActionHierarchy(state) {
  const expectedOrder = ["post-game-review-button"];
  const expectedRoles = [{ id: "post-game-review-button", role: "secondary" }];
  if (JSON.stringify(state.actionOrder) !== JSON.stringify(expectedOrder)) {
    throw new Error(`${state.label}: pre-terminal action order drifted ${JSON.stringify(state.actionOrder)}`);
  }
  if (JSON.stringify(state.actionRoles) !== JSON.stringify(expectedRoles)) {
    throw new Error(`${state.label}: pre-terminal action roles drifted ${JSON.stringify(state.actionRoles)}`);
  }
}

function assertCurrentFenCopy(state, viewport, expectedStatus) {
  assertCommon(state, viewport);
  assertNoSelection(state, viewport);
  if (state.lastMoveText !== "") throw new Error(`${state.label}: last move visible before moves`);
  if (state.currentFenCopyStatus !== expectedStatus) {
    throw new Error(`${state.label}: bad current FEN copy status`);
  }
}

function assertLastMove(state) {
  if (!state.lastMoveText.includes("Last move") || !state.lastMoveText.includes("engine:") || !state.lastMoveText.includes("(")) {
    throw new Error(`${state.label}: last move summary missing`);
  }
  if (state.lastMoveSquares.length !== 2) {
    throw new Error(`${state.label}: last move board markers drifted ${JSON.stringify(state.lastMoveSquares)}`);
  }
}

function assertEngineMoveMotion(state) {
  if (state.motionProofElapsedMs === null || state.motionProofElapsedMs > 280) {
    throw new Error(`${state.label}: engine motion started too late ${JSON.stringify({ elapsedMs: state.motionProofElapsedMs })}`);
  }
  if (state.boardMotionPieces.length !== 1) {
    throw new Error(`${state.label}: expected one engine motion piece ${JSON.stringify(state.boardMotionPieces)}`);
  }
  const [motion] = state.boardMotionPieces;
  const expected = { actor: "engine", move: "b8c6", from: "b8", to: "c6" };
  if (
    motion.actor !== expected.actor ||
    motion.move !== expected.move ||
    motion.from !== expected.from ||
    motion.to !== expected.to
  ) {
    throw new Error(`${state.label}: engine motion metadata drifted ${JSON.stringify({ motion, expected })}`);
  }
  if (!Number.isFinite(motion.durationMs) || motion.durationMs < 120 || motion.durationMs > 240) {
    throw new Error(`${state.label}: engine motion duration is outside the baseline ${JSON.stringify(motion)}`);
  }
  if (motion.rect === null || motion.rect.width <= 0 || motion.rect.height <= 0) {
    throw new Error(`${state.label}: engine motion piece is not rendered ${JSON.stringify(motion)}`);
  }
  if (JSON.stringify(state.motionFromSquares) !== JSON.stringify(["b8"]) || JSON.stringify(state.motionToSquares) !== JSON.stringify(["c6"])) {
    throw new Error(`${state.label}: engine motion square markers drifted ${JSON.stringify({
      from: state.motionFromSquares,
      to: state.motionToSquares
    })}`);
  }
}

function assertPieceOnlyDrag(state, viewport) {
  if (state.sourceSquare !== "e2" || state.sourceDragActive !== "true") {
    throw new Error(`${state.label}: drag source was not active ${JSON.stringify(state)}`);
  }
  if (JSON.stringify(state.draggingSquares) !== JSON.stringify(["e2"])) {
    throw new Error(`${state.label}: drag square marker drifted ${JSON.stringify(state.draggingSquares)}`);
  }
  if (state.sourcePieceOpacity !== "0") {
    throw new Error(`${state.label}: source piece stayed visible during drag ${JSON.stringify(state)}`);
  }
  if (typeof state.sourceBackgroundImage === "string" && state.sourceBackgroundImage.includes("/assets/pieces/")) {
    throw new Error(`${state.label}: source square carried a piece asset background ${JSON.stringify(state)}`);
  }
  if (state.followers.length !== 1) {
    throw new Error(`${state.label}: expected one board-owned drag follower ${JSON.stringify(state.followers)}`);
  }
  const [follower] = state.followers;
  if (
    follower.from !== "e2" ||
    follower.color !== "white" ||
    follower.kind !== "pawn" ||
    follower.backgroundImage !== "none" ||
    !follower.backgroundColor.endsWith(", 0)") ||
    follower.borderTopWidth !== "0px" ||
    follower.boxShadow !== "none" ||
    follower.pointerEvents !== "none" ||
    follower.rect === null ||
    follower.rect.width <= 0 ||
    follower.rect.height <= 0 ||
    follower.innerRect === null ||
    follower.innerRect.width <= 0 ||
    follower.innerRect.height <= 0 ||
    (follower.text === "" && follower.innerBackgroundImage === "none")
  ) {
    throw new Error(`${state.label}: drag follower was not piece-only ${JSON.stringify(follower)}`);
  }
  if (viewport.width <= 390 && follower.rect.width > 50) {
    throw new Error(`${state.label}: narrow drag follower is larger than a square ${JSON.stringify(follower)}`);
  }
}

function assertCopiedFen(state) {
  const [fen] = state.clipboardWrites;
  const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
  if (state.clipboardWrites.length !== 1 || typeof fen !== "string" || !fen.startsWith(startFen)) {
    throw new Error(`${state.label}: bad copied FEN ${JSON.stringify(state.clipboardWrites)}`);
  }
}

function assertCopiedPgn(state) {
  const [pgn] = state.clipboardWrites;
  if (state.clipboardWrites.length !== 1 || typeof pgn !== "string" || !pgn.startsWith("1. ") || !pgn.endsWith(" 1-0")) {
    throw new Error(`${state.label}: bad copied PGN ${JSON.stringify(state.clipboardWrites)}`);
  }
}

function assertFreshGame(state, viewport) {
  assertCommon(state, viewport);
  assertNoSelection(state, viewport);
  if (state.reviewHidden !== true) throw new Error(`${state.label}: stale Review remained visible`);
  assertStatus(state, { text: "Your move as Black", owner: "player", side: "black" });
  if (state.moveRows !== 1) throw new Error(`${state.label}: expected Black engine-first move`);
  assertLastMove(state);
  if (state.terminalResult !== false || state.reviewDisabled !== true) throw new Error(`${state.label}: terminal Review leaked into fresh game`);
  assertPreTerminalActionHierarchy(state);
  if (state.copyVisible !== false) throw new Error(`${state.label}: terminal Copy PGN leaked into fresh game`);
  if (state.currentFenCopyStatus !== "") throw new Error(`${state.label}: stale Copy FEN status leaked into fresh game`);
}

prepareOutput();
const server = await startStaticServer(proofRoot, betaCsp);
try {
  const debugPort = await reserveLoopbackPort();
  const evidence = await runCdpProof(proofRoot, debugPort, async (cdp) => {
    const results = [];
    for (const viewport of viewports) results.push(await runViewport(cdp, server, viewport));
    return results;
  });
  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
} finally {
  await new Promise((resolve) => server.server.close(resolve));
}
