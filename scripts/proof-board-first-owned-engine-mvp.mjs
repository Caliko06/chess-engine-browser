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

const proofRoot = "/private/tmp/chess-board-first-owned-engine-mvp-proof";
const viewports = [
  { width: 1280, height: 900, label: "desktop" },
  { width: 390, height: 844, label: "narrow" }
];
const generatedPieceReviewSetFlag = process.argv.find((value) => value.startsWith("--generated-piece-review-set="));
const generatedPieceReviewSet = generatedPieceReviewSetFlag?.slice("--generated-piece-review-set=".length) ?? null;
const expectedAssetRequests = [
  "/assets/board/adr-0106/light-square-material-v1.jpg",
  "/assets/board/adr-0106/dark-square-material-v1.jpg"
];
if (generatedPieceReviewSet === "adr-0108-staunton-v1") {
  expectedAssetRequests.push(
    "/assets/pieces/adr-0108/white-king-review-v1.png",
    "/assets/pieces/adr-0108/white-queen-review-v1.png",
    "/assets/pieces/adr-0108/white-rook-review-v1.png",
    "/assets/pieces/adr-0108/white-bishop-review-v1.png",
    "/assets/pieces/adr-0108/white-knight-review-v1.png",
    "/assets/pieces/adr-0108/white-pawn-review-v1.png",
    "/assets/pieces/adr-0108/black-king-review-v1.png",
    "/assets/pieces/adr-0108/black-queen-review-v1.png",
    "/assets/pieces/adr-0108/black-rook-review-v1.png",
    "/assets/pieces/adr-0108/black-bishop-review-v1.png",
    "/assets/pieces/adr-0108/black-knight-review-v1.png",
    "/assets/pieces/adr-0108/black-pawn-review-v1.png"
  );
}

function prepareOutput() {
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(join(proofRoot, "dist/pkg"), { recursive: true });
  run("node", ["scripts/audit-policy.mjs"]);
  run("pnpm", ["--filter", "web", "run", "build"]);
  assertWasmBindgenCliVersion("board-first owned-engine MVP proof");
  run("cargo", ["build", "-p", "chess-wasm-bridge", "--target", "wasm32-unknown-unknown", "--release"]);
  run("wasm-bindgen", [
    "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm",
    "--target",
    "bundler",
    "--out-dir",
    join(proofRoot, "dist/pkg")
  ]);
  writeEmbeddedWasmModule(proofRoot, {
    assertExpectedImports: true,
    removeWasmAsset: true
  });
  copyBuiltWeb(proofRoot);
  copyProductHtml(proofRoot, {
    missingMessage: "board-first MVP product HTML is missing",
    scanBeforeChecks: true,
    cspCheck: "meta",
    cspMismatchMessage: (metaCsp) => `board-first MVP product HTML CSP mismatch: ${metaCsp}`,
    requiredIncludes: [
      { text: 'id="chess-review-app"', message: "board-first MVP product root is missing" },
      { text: 'href="./review.css"', message: "board-first MVP stylesheet href is missing" },
      { text: 'src="./dist/app.js"', message: "board-first MVP entrypoint script is missing" }
    ]
  });
  copyProductCss(proofRoot, { missingMessage: "board-first MVP stylesheet is missing" });
  scanStaticOutput(proofRoot, {
    extraForbiddenTokens: ['<script type="importmap"', "ServiceWorker", "Worker("]
  });
}

async function mountCleanPage(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64",
    "play board did not mount"
  );
  await waitFor(
    cdp,
    "Array.from(document.styleSheets).some((sheet) => sheet.href?.endsWith('/review.css'))",
    "stylesheet did not load"
  );
}

function clickSquareExpression(square) {
  return `(() => {
    const square = document.querySelector('[data-play-ui="board-square"][data-square="${square}"]');
    if (!(square instanceof HTMLButtonElement)) return false;
    square.click();
    return true;
  })()`;
}

function boardStateExpression(viewport, stage) {
  return `(() => {
    const issues = [];
    const board = document.querySelector('[data-play-ui="board"]');
    const grid = document.querySelector('[data-play-ui="board-grid"]');
    const root = document.querySelector('[data-play-ui="root"]');
    const squares = Array.from(document.querySelectorAll('[data-play-ui="board-square"]'));
    const moves = Array.from(document.querySelectorAll('[data-play-ui="move-row"]'), (row) => ({
      actor: row.getAttribute("data-play-actor"),
      ply: row.getAttribute("data-play-ply"),
      san: row.querySelector('[data-play-ui="move-san"]')?.textContent?.trim() ?? "",
      coordinate: row.querySelector('[data-play-ui="move-coordinate"]')?.textContent?.trim() ?? ""
    }));
    const visible = (element, selector) => {
      if (!(element instanceof HTMLElement)) {
        issues.push({ kind: "missing", selector });
        return null;
      }
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) issues.push({ kind: "zero", selector });
      if (rect.left < -1 || rect.right > window.innerWidth + 1) {
        issues.push({ kind: "horizontal-overflow", selector, left: rect.left, right: rect.right });
      }
      return rect;
    };
    const boardRect = visible(board, "board");
    const gridRect = visible(grid, "board-grid");
    visible(root, "play-root");
    if (squares.length !== 64) issues.push({ kind: "square-count", count: squares.length });
    if (gridRect === null || Math.abs(gridRect.width - gridRect.height) > 2) {
      issues.push({ kind: "grid-not-square", rect: gridRect });
    }
    for (const square of [squares[0], squares[27], squares[63]].filter(Boolean)) {
      const rect = square.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const targetSquare = target instanceof Element ? target.closest('[data-play-ui="board-square"]') : null;
      if (targetSquare !== square) issues.push({ kind: "covered-square", square: square.getAttribute("data-square") });
    }
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (pageWidth > window.innerWidth + 1) {
      issues.push({ kind: "page-overflow", pageWidth, viewportWidth: window.innerWidth });
    }
    const overflowText = Array.from(document.querySelectorAll('[data-play-ui="status"], [data-play-ui="new-game-button"], [data-play-ui="post-game-review-button"], [data-play-ui="move-row"]'))
      .filter((element) => element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.getAttribute("data-play-ui") ?? element.tagName);
    if (overflowText.length > 0) issues.push({ kind: "text-overflow", overflowText });
    for (const fact of Array.from(document.querySelectorAll('[data-play-ui="facts"] dl > div'))) {
      const label = fact.querySelector("dt");
      const value = fact.querySelector("dd");
      if (label instanceof HTMLElement && value instanceof HTMLElement) {
        const labelRect = label.getBoundingClientRect();
        const valueRect = value.getBoundingClientRect();
        if (labelRect.bottom > valueRect.top && labelRect.top < valueRect.bottom && labelRect.right > valueRect.left - 2) {
          issues.push({ kind: "fact-overlap", label: label.textContent?.trim() ?? "" });
        }
      }
    }
    const playerMove = moves[0]?.coordinate ?? "";
    const engineMove = moves[1]?.coordinate ?? "";
    const engineFrom = engineMove.slice(0, 2);
    const engineTo = engineMove.slice(2, 4);
    const squareAttr = (square, name) => document.querySelector('[data-play-ui="board-square"][data-square="' + square + '"]')?.getAttribute(name) ?? null;
    const pieceBackgroundMatches = (square, token) => {
      const piece = document.querySelector('[data-play-ui="board-square"][data-square="' + square + '"] [data-play-ui="board-piece"]');
      return piece instanceof HTMLElement && getComputedStyle(piece).backgroundImage.includes(token);
    };
    return JSON.stringify({
      stage: ${JSON.stringify(stage)},
      expectedViewport: ${JSON.stringify(viewport)},
      actualViewport: { width: window.innerWidth, height: window.innerHeight },
      boardRect,
      squares: squares.length,
      occupied: squares.filter((square) => square.getAttribute("data-board-piece") !== null).length,
      modeLabel: document.querySelector('[data-play-ui="mode-label"]')?.textContent?.trim() ?? "",
      pieceReviewSet: document.querySelector('[data-piece-review-set]')?.getAttribute("data-piece-review-set") ?? null,
      status: document.querySelector('[data-play-ui="status"]')?.textContent?.trim() ?? "",
      postGameDisabled: document.querySelector('[data-play-ui="post-game-review-button"]')?.hasAttribute("disabled") ?? null,
      e2Piece: squareAttr("e2", "data-board-piece"),
      e4Piece: squareAttr("e4", "data-board-piece"),
      e4Legal: squareAttr("e4", "data-board-legal-target"),
      playerMove,
      engineMove,
      engineFromPiece: engineFrom.length === 2 ? squareAttr(engineFrom, "data-board-piece") : null,
      engineToPieceColor: engineTo.length === 2 ? squareAttr(engineTo, "data-board-piece-color") : null,
      moves,
      lightMaterialApplied: getComputedStyle(document.querySelector('[data-play-ui="board-square"][data-board-shade="light"]')).backgroundImage.includes("light-square-material-v1.jpg"),
      darkMaterialApplied: getComputedStyle(document.querySelector('[data-play-ui="board-square"][data-board-shade="dark"]')).backgroundImage.includes("dark-square-material-v1.jpg"),
      whiteKingCandidate: pieceBackgroundMatches("e1", "white-king-review-v1.png"),
      whiteQueenCandidate: pieceBackgroundMatches("d1", "white-queen-review-v1.png"),
      whiteRookCandidate: pieceBackgroundMatches("a1", "white-rook-review-v1.png"),
      whiteBishopCandidate: pieceBackgroundMatches("c1", "white-bishop-review-v1.png"),
      whiteKnightCandidate: pieceBackgroundMatches("b1", "white-knight-review-v1.png"),
      whitePawnCandidate: pieceBackgroundMatches("a2", "white-pawn-review-v1.png"),
      blackKingCandidate: pieceBackgroundMatches("e8", "black-king-review-v1.png"),
      blackQueenCandidate: pieceBackgroundMatches("d8", "black-queen-review-v1.png"),
      blackRookCandidate: pieceBackgroundMatches("a8", "black-rook-review-v1.png"),
      blackBishopCandidate: pieceBackgroundMatches("c8", "black-bishop-review-v1.png"),
      blackKnightCandidate: pieceBackgroundMatches("b8", "black-knight-review-v1.png"),
      blackPawnCandidate: pieceBackgroundMatches("a7", "black-pawn-review-v1.png"),
      issues
    });
  })()`;
}

function assertInitialState(state) {
  const pieceReviewOk =
    generatedPieceReviewSet === null ||
    (
      state.pieceReviewSet === generatedPieceReviewSet &&
      state.whiteKingCandidate === true &&
      state.whiteQueenCandidate === true &&
      state.whiteRookCandidate === true &&
      state.whiteBishopCandidate === true &&
      state.whiteKnightCandidate === true &&
      state.whitePawnCandidate === true &&
      state.blackKingCandidate === true &&
      state.blackQueenCandidate === true &&
      state.blackRookCandidate === true &&
      state.blackBishopCandidate === true &&
      state.blackKnightCandidate === true &&
      state.blackPawnCandidate === true
    );
  if (
    state.actualViewport.width !== state.expectedViewport.width ||
    state.actualViewport.height !== state.expectedViewport.height ||
    state.issues.length > 0 ||
    state.squares !== 64 ||
    state.occupied !== 32 ||
    state.modeLabel !== "Engine: Owned local" ||
    state.status !== "White to move" ||
    state.postGameDisabled !== true ||
    state.e2Piece !== "P" ||
    state.e4Piece !== null ||
    state.lightMaterialApplied !== true ||
    state.darkMaterialApplied !== true ||
    pieceReviewOk !== true ||
    state.moves.length !== 0
  ) {
    throw new Error(`board-first initial proof failed: ${JSON.stringify(state)}`);
  }
}

function assertAfterMoveState(state) {
  if (
    state.actualViewport.width !== state.expectedViewport.width ||
    state.actualViewport.height !== state.expectedViewport.height ||
    state.issues.length > 0 ||
    state.squares !== 64 ||
    state.occupied !== 32 ||
    state.status !== "White to move" ||
    state.playerMove !== "e2e4" ||
    state.lightMaterialApplied !== true ||
    state.darkMaterialApplied !== true ||
    !/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(state.engineMove) ||
    state.engineFromPiece !== null ||
    state.engineToPieceColor !== "black" ||
    state.moves.length !== 2 ||
    state.moves[0]?.actor !== "player" ||
    state.moves[1]?.actor !== "engine"
  ) {
    throw new Error(`board-first interaction proof failed: ${JSON.stringify(state)}`);
  }
}

async function screenshot(cdp, viewport) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    fromSurface: true
  });
  const path = join(proofRoot, `${viewport.label}.png`);
  writeFileSync(path, result.data, "base64");
  return path;
}

async function runViewportProof(cdp, url, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await mountCleanPage(cdp, url);
  const initial = await evaluateJson(cdp, boardStateExpression(viewport, "initial"));
  assertInitialState(initial);
  if ((await evaluate(cdp, clickSquareExpression("e2"))) !== true) {
    throw new Error(`could not click e2 for ${viewport.label}`);
  }
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"board-square\"][data-square=\"e4\"]')?.getAttribute('data-board-legal-target') === 'true'",
    `${viewport.label} legal target did not render`
  );
  const selected = await evaluateJson(cdp, boardStateExpression(viewport, "selected"));
  if (selected.e4Legal !== "true" || selected.issues.length > 0) {
    throw new Error(`board-first selected-square proof failed: ${JSON.stringify(selected)}`);
  }
  if ((await evaluate(cdp, clickSquareExpression("e4"))) !== true) {
    throw new Error(`could not click e4 for ${viewport.label}`);
  }
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 2 && document.querySelector('[data-play-ui=\"status\"]')?.textContent?.trim() === 'White to move'",
    `${viewport.label} engine reply did not complete`
  );
  const afterMove = await evaluateJson(cdp, boardStateExpression(viewport, "after-move"));
  assertAfterMoveState(afterMove);
  const screenshotPath = await screenshot(cdp, viewport);
  return {
    viewport,
    initial,
    selected,
    afterMove,
    screenshotPath
  };
}

async function runBrowserProof(url, debugPort) {
  return runCdpProof(proofRoot, debugPort, async (cdp) => {
    const results = [];
    for (const viewport of viewports) {
      results.push(await runViewportProof(cdp, url, viewport));
    }
    return results;
  });
}

prepareOutput();
const { server, requests, servedResponses, port } = await startStaticServer(proofRoot, betaCsp);
let proofResults = [];
try {
  proofResults = await runBrowserProof(
    `http://127.0.0.1:${port}/index.html${
      generatedPieceReviewSet === null ? "" : `?generatedPieceReview=${generatedPieceReviewSet}`
    }`,
    await reserveLoopbackPort()
  );
} finally {
  server.close();
}
if (!requests.includes("/review.css")) {
  throw new Error(`board-first proof did not request review.css: ${requests.join(", ")}`);
}
for (const request of expectedAssetRequests) {
  if (!requests.includes(request)) {
    throw new Error(`board-first proof did not request board asset ${request}: ${requests.join(", ")}`);
  }
}
if (
  !servedResponses.some(
    (response) =>
      response.pathname === "/review.css" && response.contentType === "text/css; charset=utf-8"
  )
) {
  throw new Error(`board-first proof did not serve review.css as text/css: ${JSON.stringify(servedResponses)}`);
}
for (const request of expectedAssetRequests) {
  if (
    !servedResponses.some(
      (response) =>
        response.pathname === request &&
        (response.contentType === "image/jpeg" || response.contentType === "image/png")
    )
  ) {
    throw new Error(`board-first proof did not serve ${request} as image asset: ${JSON.stringify(servedResponses)}`);
  }
}
if (requests.some((request) => request.endsWith(".wasm"))) {
  throw new Error(`board-first proof requested a .wasm asset: ${requests.join(", ")}`);
}
writeFileSync(join(proofRoot, "summary.json"), `${JSON.stringify(proofResults, null, 2)}\n`);
console.log("Board-first owned-engine MVP and board-asset browser proof passed.");
for (const result of proofResults) {
  console.log(
    `- ${result.viewport.label}: ${result.afterMove.playerMove}, engine ${result.afterMove.engineMove}, screenshot ${result.screenshotPath}`
  );
}
