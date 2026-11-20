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

const proofRoot = "/private/tmp/chess-adr0221-browser-continuity-proof";
const reactionQuery = "playReactionMap=adr-0143-engine-lines";
const incidentFen =
  "r2k1b1r/1ppBpp1p/8/p2pN1p1/Q2Pb1n1/P1P1P3/1P3BPP/RN2K2R b KQ - 0 14";
const viewports = [
  { width: 1280, height: 900, label: "desktop" },
  { width: 390, height: 844, label: "narrow" }
];

function assert(condition, message, context) {
  if (!condition) {
    throw new Error(`${message}${context === undefined ? "" : `: ${JSON.stringify(context)}`}`);
  }
}

function prepareOutput() {
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(join(proofRoot, "dist/pkg"), { recursive: true });
  run("pnpm", ["--filter", "web", "run", "build"]);
  assertWasmBindgenCliVersion("ADR-0221 browser continuity proof");
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
    missingMessage: "ADR-0221 product HTML is missing",
    scanBeforeChecks: true,
    cspCheck: "meta",
    cspMismatchMessage: (metaCsp) => `ADR-0221 CSP mismatch: ${metaCsp}`,
    requiredIncludes: [
      { text: 'id="chess-review-app"', message: "product root is missing" },
      { text: 'href="./review.css"', message: "stylesheet href is missing" },
      { text: 'src="./dist/app.js"', message: "app entrypoint is missing" }
    ]
  });
  copyProductCss(proofRoot, { missingMessage: "Play stylesheet is missing" });
  scanStaticOutput(proofRoot, { extraForbiddenTokens: ['<script type="importmap"', "ServiceWorker"] });
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

function click(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`;
}

function clickMove(from, to) {
  return `(() => {
    const fromSquare = document.querySelector('[data-play-ui="board-square"][data-square="${from}"]');
    const toSquare = document.querySelector('[data-play-ui="board-square"][data-square="${to}"]');
    if (!(fromSquare instanceof HTMLButtonElement) || !(toSquare instanceof HTMLButtonElement)) return false;
    fromSquare.click();
    toSquare.click();
    return true;
  })()`;
}

function snapshot(label) {
  return `JSON.stringify((() => {
    const fact = (key) => document.querySelector('[data-play-ui="' + key + '"] dd')?.textContent?.trim() ?? null;
    const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? null;
    const board = document.querySelector('[data-play-ui="board-grid"]');
    const boardRect = board instanceof HTMLElement ? board.getBoundingClientRect() : null;
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const arrows = [...document.querySelectorAll('[data-play-ui="reaction-arrow"]')].map((node) => ({
      from: node.getAttribute("data-reaction-from"),
      to: node.getAttribute("data-reaction-to"),
      order: node.getAttribute("data-reaction-order"),
      primary: node.getAttribute("data-reaction-primary"),
      rival: node.getAttribute("data-reaction-rival"),
      risk: node.getAttribute("data-path-risk")
    }));
    const candidateArrows = [...document.querySelectorAll('[data-play-ui="candidate-arrow"]')].map((node) => ({
      from: node.getAttribute("data-candidate-from"),
      to: node.getAttribute("data-candidate-to"),
      rank: node.getAttribute("data-candidate-rank"),
      safety: node.getAttribute("data-candidate-safety"),
      risk: node.getAttribute("data-path-risk")
    }));
    return {
      label: ${JSON.stringify(label)},
      href: location.href,
      playMode: attr('[data-play-ui="root"]', "data-play-mode"),
      reactionAttr: attr('[data-app-ui="play-root"]', "data-play-reaction-map"),
      status: attr('[data-play-ui="reaction-lens"]', "data-reaction-status"),
      best: fact("reaction-best"),
      score: fact("reaction-score"),
      depth: fact("reaction-depth"),
      mode: fact("reaction-mode"),
      side: fact("reaction-input"),
      turn: fact("reaction-turn"),
      aggressive: attr('[data-play-ui="aggressive-toggle-button"]', "aria-pressed"),
      fast: attr('[data-play-ui="reaction-depth-button"][data-reaction-depth="fast"]', "aria-pressed"),
      deep: attr('[data-play-ui="reaction-depth-button"][data-reaction-depth="deep"]', "aria-pressed"),
      fen: fact("current-fen"),
      arrows,
      candidateArrows,
      pageWidth,
      viewportWidth: window.innerWidth,
      boardWidth: boardRect === null ? 0 : Math.round(boardRect.width),
      boardVisible: boardRect !== null && boardRect.right <= window.innerWidth + 1
    };
  })())`;
}

async function screenshot(cdp, name) {
  const image = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(join(proofRoot, `${name}.png`), Buffer.from(image.data, "base64"));
}

async function loadIncident(cdp, port) {
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?${reactionQuery}` });
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "Play did not mount");
  assert(await evaluate(cdp, loadFenExpression(incidentFen)), "could not load incident FEN");
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="reaction-turn"] dd')?.textContent?.trim() === 'Black'`,
    "incident FEN did not load with Black to move"
  );
  assert(
    await evaluate(cdp, click('[data-play-ui="player-side-button"][data-player-side="black"]')),
    "could not select Black"
  );
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="reaction-input"] dd')?.textContent?.trim() === 'Black'`,
    "selected side Black did not settle"
  );
  assert(await evaluate(cdp, click('[data-play-ui="aggressive-toggle-button"]')), "could not enable Aggressive");
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="aggressive-toggle-button"]')?.getAttribute('aria-pressed') === 'true'`,
    "Aggressive did not enable"
  );
}

async function waitForIncidentReady(cdp) {
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready' &&
      document.querySelector('[data-play-ui="reaction-best"] dd')?.textContent?.trim().includes('g4e5')`,
    "incident Explore did not settle on visible g4e5"
  );
}

function assertIncident(snapshotResult, viewport) {
  assert(snapshotResult.playMode === "reaction-lens", "not in reaction-lens", snapshotResult);
  assert(snapshotResult.reactionAttr === "adr-0143-engine-lines", "reaction attr missing", snapshotResult);
  assert(snapshotResult.status === "ready", "reaction status not ready", snapshotResult);
  assert(snapshotResult.side === "Black", "selected side must be Black", snapshotResult);
  assert(snapshotResult.best === "Alt/risk g4e5", "incident must show uncertified g4e5", snapshotResult);
  assert(snapshotResult.score === "not recommended", "incident g4e5 must remain uncertified", snapshotResult);
  assert(
    snapshotResult.arrows.some((arrow) => arrow.from === "g4" && arrow.to === "e5") ||
      snapshotResult.candidateArrows.some((arrow) => arrow.from === "g4" && arrow.to === "e5"),
    "g4e5 board arrow missing",
    snapshotResult
  );
  assert(snapshotResult.pageWidth <= snapshotResult.viewportWidth + 1, "page overflows viewport", { snapshotResult, viewport });
  assert(snapshotResult.boardWidth > 0 && snapshotResult.boardVisible, "board not visible", { snapshotResult, viewport });
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

  await loadIncident(cdp, port);
  assert(await evaluate(cdp, click('[data-play-ui="reaction-depth-button"][data-reaction-depth="fast"]')), "could not select Fast");
  await waitForIncidentReady(cdp);
  const fast = await evaluateJson(cdp, snapshot(`${viewport.label}-fast`));
  assertIncident(fast, viewport);
  assert(fast.fast === "true" && fast.deep === "false", "Fast state mismatch", fast);
  await screenshot(cdp, `${viewport.label}-fast`);

  assert(await evaluate(cdp, click('[data-play-ui="reaction-depth-button"][data-reaction-depth="deep"]')), "could not select Deep");
  await waitForIncidentReady(cdp);
  const deep = await evaluateJson(cdp, snapshot(`${viewport.label}-deep`));
  assertIncident(deep, viewport);
  assert(deep.fast === "false" && deep.deep === "true", "Deep state mismatch", deep);
  await screenshot(cdp, `${viewport.label}-deep`);

  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "reload did not restore board");
  await loadIncident(cdp, port);
  await waitForIncidentReady(cdp);
  const reload = await evaluateJson(cdp, snapshot(`${viewport.label}-reload`));
  assertIncident(reload, viewport);

  assert(await evaluate(cdp, clickMove("g4", "e5")), "could not play selected-side move g4e5");
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="reaction-turn"] dd')?.textContent?.trim() === 'White'`,
    "turn did not advance to White after g4e5"
  );
  assert(await evaluate(cdp, clickMove("d4", "e5")), "could not play expected rival reply d4e5");
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="reaction-turn"] dd')?.textContent?.trim() === 'Black' &&
      document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready'`,
    "expected rival reply branch did not settle"
  );
  const expectedReply = await evaluateJson(cdp, snapshot(`${viewport.label}-expected-reply`));
  assert(expectedReply.side === "Black" && expectedReply.turn === "Black", "expected reply branch side/turn mismatch", expectedReply);
  assert(/^(?:[a-h][1-8][a-h][1-8][qrbn]?|Alt\/risk [a-h][1-8][a-h][1-8][qrbn]?)$/u.test(expectedReply.best ?? ""), "expected reply branch lacks legal best", expectedReply);
  await screenshot(cdp, `${viewport.label}-expected-reply`);

  await loadIncident(cdp, port);
  await waitForIncidentReady(cdp);
  assert(await evaluate(cdp, clickMove("g4", "e5")), "could not replay selected-side move g4e5");
  await waitFor(cdp, `document.querySelector('[data-play-ui="reaction-turn"] dd')?.textContent?.trim() === 'White'`, "turn did not advance for deviation");
  assert(await evaluate(cdp, clickMove("b2", "b3")), "could not play rival deviation b2b3");
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="reaction-turn"] dd')?.textContent?.trim() === 'Black' &&
      document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready'`,
    "rival deviation branch did not settle"
  );
  const deviation = await evaluateJson(cdp, snapshot(`${viewport.label}-deviation`));
  assert(deviation.side === "Black" && deviation.turn === "Black", "deviation branch side/turn mismatch", deviation);
  assert(/^(?:[a-h][1-8][a-h][1-8][qrbn]?|Alt\/risk [a-h][1-8][a-h][1-8][qrbn]?)$/u.test(deviation.best ?? ""), "deviation branch lacks legal best", deviation);
  await screenshot(cdp, `${viewport.label}-deviation`);

  return { viewport: viewport.label, fast, deep, reload, expectedReply, deviation };
}

prepareOutput();
const { server, port, servedResponses } = await startStaticServer(proofRoot, betaCsp);
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

const html200 = servedResponses.some(
  (response) => response.pathname === "/index.html" && response.contentType.includes("text/html")
);
assert(html200, "preview did not serve index.html as HTTP 200", servedResponses);
writeFileSync(join(proofRoot, "summary.json"), `${JSON.stringify({ results, servedResponses }, null, 2)}\n`);
console.log(`ADR-0221 browser continuity proof passed: ${proofRoot}`);
