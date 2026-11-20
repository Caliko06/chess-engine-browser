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

// ADR-0143: prove the opt-in Play live reaction map is engine-backed, board-first, and honest.
// The real owned engine computes candidates and a projected line; the board overlays the reaction
// arrows. Default Play must stay clean. ADR-0216 also proves one real prospective Brilliant with
// depth and continuation evidence.

const proofRoot = "/private/tmp/chess-play-reaction-map-engine-lines-proof";
const reactionQuery = "playReactionMap=adr-0143-engine-lines";
const reactionToken = "adr-0143-engine-lines";
const viewports = [
  { width: 1280, height: 900, label: "desktop" },
  { width: 390, height: 844, label: "narrow" }
];

function prepareOutput() {
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(join(proofRoot, "dist/pkg"), { recursive: true });
  run("node", ["scripts/audit-policy.mjs"]);
  run("pnpm", ["--filter", "web", "run", "build"]);
  assertWasmBindgenCliVersion("Play reaction map proof");
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
    missingMessage: "Play reaction map product HTML is missing",
    scanBeforeChecks: true,
    cspCheck: "meta",
    cspMismatchMessage: (metaCsp) => `Play reaction map CSP mismatch: ${metaCsp}`,
    requiredIncludes: [
      { text: 'id="chess-review-app"', message: "product root is missing" },
      { text: 'href="./review.css"', message: "stylesheet href is missing" },
      { text: 'src="./dist/app.js"', message: "app entrypoint is missing" }
    ]
  });
  copyProductCss(proofRoot, { missingMessage: "Play stylesheet is missing" });
  scanStaticOutput(proofRoot, {
    extraForbiddenTokens: ['<script type="importmap"', "ServiceWorker"]
  });
}

function reactionSnapshot(label) {
  return `JSON.stringify((() => {
    const factValue = (selector) => document.querySelector(selector + " dd")?.textContent?.trim() ?? null;
    const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? null;
    const panel = document.querySelector('[data-play-ui="reaction-lens"]');
    const board = document.querySelector('[data-play-ui="board-grid"]');
    const boardRect = board instanceof HTMLElement ? board.getBoundingClientRect() : null;
    const arrows = [...document.querySelectorAll('[data-play-ui="reaction-arrow"]')].map((node) => ({
      from: node.getAttribute("data-reaction-from"),
      to: node.getAttribute("data-reaction-to"),
      order: node.getAttribute("data-reaction-order"),
      primary: node.getAttribute("data-reaction-primary"),
      rival: node.getAttribute("data-reaction-rival")
    }));
    const primary = arrows.find((arrow) => arrow.order === "1") ?? null;
    const fromSquareHasPiece =
      primary === null
        ? false
        : document
            .querySelector('[data-play-ui="board-square"][data-square="' + primary.from + '"]')
            ?.hasAttribute("data-board-piece") ?? false;
    return {
      label: ${JSON.stringify(label)},
      playMode: attr('[data-play-ui="root"]', "data-play-mode"),
      reactionMapAttr: attr('[data-app-ui="play-root"]', "data-play-reaction-map"),
      reactionStatus: attr('[data-play-ui="reaction-lens"]', "data-reaction-status"),
      reactionPanelCount: document.querySelectorAll('[data-play-ui="reaction-lens"]').length,
      analysisLensCount: document.querySelectorAll('[data-play-ui="analysis-lens"]').length,
      arrowsSvgCount: document.querySelectorAll('[data-play-ui="reaction-arrows"]').length,
      arrows,
      best: factValue('[data-play-ui="reaction-best"]'),
      score: factValue('[data-play-ui="reaction-score"]'),
      line: arrows.map((arrow) => (arrow.from ?? "") + (arrow.to ?? "")).join(" ") || null,
      candidateCount: factValue('[data-play-ui="reaction-candidate-count"]'),
      mate: factValue('[data-play-ui="reaction-mate"]'),
      fen: factValue('[data-play-ui="current-fen"]'),
      brilliantCount: document.querySelectorAll('[data-play-ui="prospective-brilliant"]').length,
      brilliantText: document.querySelector('[data-play-ui="prospective-brilliant"]')?.textContent?.trim() ?? null,
      forbidden: /Chess\\.com|Great|Miss|Mistake|Blunder|Book|Theory|Expected Points/iu.test(panel?.textContent ?? ""),
      fromSquareHasPiece,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      boardWidth: boardRect ? Math.round(boardRect.width) : 0,
      boardVisible:
        boardRect !== null &&
        boardRect.top >= -1 &&
        boardRect.left >= -1 &&
        boardRect.right <= window.innerWidth + 1,
      moveRows: document.querySelectorAll('[data-play-ui="move-row"]').length,
      statusText: document.querySelector('[data-play-ui="status"]')?.textContent?.trim() ?? null
    };
  })())`;
}

function assert(condition, message, context) {
  if (!condition) {
    throw new Error(`${message}${context === undefined ? "" : `: ${JSON.stringify(context)}`}`);
  }
}

function assertWellFormedLine(line) {
  assert(typeof line === "string" && line.length > 0 && line !== "none", "projected line is empty", { line });
  const moves = line.split(" ");
  for (const move of moves) {
    assert(/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(move), "projected line move is not a legal coordinate", {
      move,
      line
    });
  }
  return moves;
}

function assertReactionReady(snapshot, viewport) {
  assert(snapshot.playMode === "reaction-lens", "play mode is not reaction-lens", snapshot);
  assert(snapshot.reactionMapAttr === reactionToken, "reaction map attribute missing", snapshot);
  assert(snapshot.reactionStatus === "ready", "reaction status is not ready", snapshot);
  assert(snapshot.reactionPanelCount === 1, "reaction panel must render exactly once", snapshot);
  assert(snapshot.analysisLensCount === 0, "spectator analysis lens must not render", snapshot);
  assert(snapshot.arrowsSvgCount === 1, "reaction arrow overlay must render once", snapshot);
  assert(snapshot.arrows.length >= 1, "at least one reaction arrow must render", snapshot);
  assert(snapshot.arrows.length <= 4, "reaction arrows must be capped", snapshot);
  assert(snapshot.forbidden === false, "forbidden wording present in reaction panel", snapshot);
  assert(snapshot.fromSquareHasPiece === true, "primary reaction arrow does not start from a piece", snapshot);

  const moves = assertWellFormedLine(snapshot.line);
  const firstMove = moves[0];
  const primary = snapshot.arrows.find((arrow) => arrow.order === "1");
  assert(primary !== undefined && primary.primary === "true", "primary reaction arrow missing", snapshot);
  const expectedBest = primary.rival === "true" ? moves[1] : firstMove;
  assert(snapshot.best === expectedBest, "reaction move fact must match its side-oriented line", snapshot);
  assert(primary.from === firstMove.slice(0, 2), "primary arrow from-square must match the line", snapshot);
  assert(primary.to === firstMove.slice(2, 4), "primary arrow to-square must match the line", snapshot);
  for (const [index, arrow] of snapshot.arrows.entries()) {
    const move = moves[index];
    assert(move !== undefined, "reaction arrow has no matching projected move", { arrow, moves });
    assert(arrow.from === move.slice(0, 2) && arrow.to === move.slice(2, 4), "reaction arrow does not match the projected line", {
      arrow,
      move
    });
  }

  const candidateCount = Number.parseInt(snapshot.candidateCount ?? "0", 10);
  assert(candidateCount >= 1, "reaction candidate count must be positive", snapshot);

  // mate wording is only allowed when the panel reports a forced mate.
  if (snapshot.score === "Mate" || snapshot.mate === "Forced mate") {
    assert(snapshot.score === "Mate" && snapshot.mate === "Forced mate", "mate wording must be consistent", snapshot);
  } else {
    assert(/^[+-]?\d+ cp$/u.test(snapshot.score ?? ""), "non-mate score must be a centipawn value", snapshot);
    assert(snapshot.mate === "None", "non-mate reaction must report no forced mate", snapshot);
  }

  assert(snapshot.pageWidth <= snapshot.viewportWidth + 1, "page overflows the viewport", snapshot);
  assert(snapshot.boardWidth > 0 && snapshot.boardVisible === true, "board is not the primary visible surface", {
    snapshot,
    viewport
  });
}

function clickSquareExpression(square) {
  return `(() => {
    const element = document.querySelector('[data-play-ui="board-square"][data-square="${square}"]');
    if (!(element instanceof HTMLButtonElement)) return false;
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!(hit instanceof Element) || hit.closest('[data-play-ui="board-square"][data-square="${square}"]') === null) {
      return false;
    }
    element.click();
    return true;
  })()`;
}

async function runViewport(cdp, port, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: viewport.label === "narrow",
    maxTouchPoints: 1
  });
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
  });

  // Default Play (no query) must not leak the reaction map.
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` });
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "Default Play did not mount");
  const defaultSnapshot = await evaluateJson(cdp, reactionSnapshot(`${viewport.label}-default`));
  assert(defaultSnapshot.playMode === "opponent", "default Play must be the opponent loop", defaultSnapshot);
  assert(defaultSnapshot.reactionPanelCount === 0, "default Play must not render the reaction panel", defaultSnapshot);
  assert(defaultSnapshot.arrowsSvgCount === 0, "default Play must not render reaction arrows", defaultSnapshot);

  // Opt-in reaction map.
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?${reactionQuery}` });
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "Reaction Play did not mount");
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"reaction-lens\"]')?.getAttribute('data-reaction-status') === 'ready'",
    "Reaction map did not become ready"
  );
  const initial = await evaluateJson(cdp, reactionSnapshot(`${viewport.label}-initial`));
  assertReactionReady(initial, viewport);
  assert(initial.brilliantCount === 0, "startpos must not fabricate a Brilliant", initial);
  assert(initial.statusText === "White to move", "reaction map must start with White to move", initial);

  // Move both sides: play White's projected reaction, then confirm the engine recomputes for Black.
  const firstMove = initial.line.split(" ")[0];
  const fromSquare = firstMove.slice(0, 2);
  const toSquare = firstMove.slice(2, 4);
  assert(await evaluate(cdp, clickSquareExpression(fromSquare)), `could not select ${fromSquare}`, initial);
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="selected-square"]')?.textContent?.trim() === '${fromSquare}'`,
    "reaction selection did not register"
  );
  assert(await evaluate(cdp, clickSquareExpression(toSquare)), `could not move to ${toSquare}`, initial);
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 1", "reaction move was not applied");
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"status\"]')?.textContent?.trim() === 'Black to move'",
    "reaction turn did not pass to Black"
  );
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"reaction-lens\"]')?.getAttribute('data-reaction-status') === 'ready'",
    "reaction map did not recompute for Black"
  );
  const afterMove = await evaluateJson(cdp, reactionSnapshot(`${viewport.label}-after-white-reaction`));
  assertReactionReady(afterMove, viewport);
  assert(afterMove.statusText === "Black to move", "reaction map must follow Black after the move", afterMove);
  assert(afterMove.moveRows === 1, "exactly one move should be recorded", afterMove);

  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?${reactionQuery}` });
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "Brilliant proof did not mount");
  const aggressiveEnabled = await evaluate(cdp, `(() => {
    const aggressive = document.querySelector('[data-play-ui="aggressive-toggle-button"]');
    if (!(aggressive instanceof HTMLButtonElement)) return false;
    if (aggressive.getAttribute('aria-pressed') !== 'true') aggressive.click();
    return true;
  })()`);
  assert(aggressiveEnabled === true, "could not enable Aggressive Explore");
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"aggressive-toggle-button\"]')?.getAttribute('aria-pressed') === 'true'",
    "Aggressive Explore did not enable"
  );
  const loaded = await evaluate(cdp, `(() => {
    const input = document.querySelector('[data-play-ui="load-position-input"]');
    const load = document.querySelector('[data-play-ui="load-position-button"]');
    if (!(input instanceof HTMLInputElement) || !(load instanceof HTMLButtonElement)) return false;
    input.value = 'rn4k1/6pp/5n2/7Q/8/8/2B5/5RK1 w - - 0 1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    load.click();
    return true;
  })()`);
  assert(loaded === true, "could not load the Brilliant fixture");
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"current-fen\"] dd')?.textContent?.includes('rn4k1/6pp/5n2') === true && document.querySelector('[data-play-ui=\"reaction-lens\"]')?.getAttribute('data-reaction-status') === 'ready'",
    "Brilliant fixture did not finish analysis"
  );
  const brilliant = await evaluateJson(cdp, reactionSnapshot(`${viewport.label}-brilliant`));
  assertReactionReady(brilliant, viewport);
  assert(brilliant.brilliantCount === 1, "exactly one Brilliant candidate must render", brilliant);
  assert(
    /Brilliant candidatec2h7Depth 3 · continuation h5e8/u.test(brilliant.brilliantText ?? ""),
    "Brilliant evidence is incomplete",
    brilliant
  );

  return { viewport: viewport.label, initial, afterMove, brilliant };
}

prepareOutput();
const { server, port } = await startStaticServer(proofRoot, betaCsp);
const debugPort = await reserveLoopbackPort();
const results = [];
try {
  await runCdpProof(proofRoot, debugPort, async (cdp) => {
    for (const viewport of viewports) {
      results.push(await runViewport(cdp, port, viewport));
    }
  });
} finally {
  server.close();
}

writeFileSync(join(proofRoot, "summary.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log("Play reaction map engine-lines browser proof passed.");
for (const result of results) {
  console.log(
    `  ${result.viewport}: line=${result.initial.line} candidates=${result.initial.candidateCount} arrows=${result.initial.arrows.length}`
  );
  console.log(`    brilliant=${result.brilliant.brilliantText}`);
}
