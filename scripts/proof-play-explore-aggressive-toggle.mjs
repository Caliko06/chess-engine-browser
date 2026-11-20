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

// ADR-0153 follow-up: prove Play Explore is wired to the real aggressive toggle.
// The Greek-gift FEN is deterministic under the wasm bridge's deep-lens node budget:
// neutral and Aggressive On both keep the sound objective primary d1h5. Aggressive
// ownership is still proven by the selected-side mode/objective and off-turn guard below.

const proofRoot = "/private/tmp/chess-play-explore-aggressive-toggle-proof";
const reactionQuery = "playReactionMap=adr-0143-engine-lines";
const reactionToken = "adr-0143-engine-lines";
const caroKannCatalogFen = "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3";
const greekGiftFen = "r1bq1rk1/pppnbppp/4p3/3pP1B1/3P3P/2NB4/PPP2PP1/R2QK1NR w KQ - 1 8";
const ownerRegressionFen = "8/1P3pk1/4p3/4P3/3P1PP1/8/3Q3K/6R1 b - - 0 46";
const viewports = [
  { width: 1280, height: 900, label: "desktop" },
  { width: 390, height: 844, label: "narrow" }
];

function prepareOutput() {
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(join(proofRoot, "dist/pkg"), { recursive: true });
  run("node", ["scripts/audit-policy.mjs"]);
  run("pnpm", ["--filter", "web", "run", "build"]);
  assertWasmBindgenCliVersion("Play Explore Aggressive-On proof");
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
    missingMessage: "Play Explore Aggressive-On product HTML is missing",
    scanBeforeChecks: true,
    cspCheck: "meta",
    cspMismatchMessage: (metaCsp) => `Play Explore Aggressive-On CSP mismatch: ${metaCsp}`,
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

function snapshot(label) {
  return `JSON.stringify((() => {
    const factValue = (selector) => document.querySelector(selector + " dd")?.textContent?.trim() ?? null;
    const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? null;
    const resolvedColor = (value) => {
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const panel = document.querySelector('[data-play-ui="reaction-lens"]');
    const board = document.querySelector('[data-play-ui="board-grid"]');
    const boardRect = board instanceof HTMLElement ? board.getBoundingClientRect() : null;
    const rootStyle = getComputedStyle(document.documentElement);
    const arrows = [...document.querySelectorAll('[data-play-ui="reaction-arrow"]')].map((node) => ({
      from: node.getAttribute("data-reaction-from"),
      to: node.getAttribute("data-reaction-to"),
      order: node.getAttribute("data-reaction-order"),
      primary: node.getAttribute("data-reaction-primary"),
      rival: node.getAttribute("data-reaction-rival"),
      safety: node.getAttribute("data-reaction-safety"),
      quality: node.getAttribute("data-reaction-quality"),
      sacrifice: node.getAttribute("data-reaction-sacrifice"),
      pathRole: node.getAttribute("data-path-role"),
      pathRisk: node.getAttribute("data-path-risk"),
      stroke: node.querySelector("line") === null ? null : getComputedStyle(node.querySelector("line")).stroke,
      fill: node.querySelector("polygon") === null ? null : getComputedStyle(node.querySelector("polygon")).fill,
      opacity: node.querySelector("line") === null ? null : getComputedStyle(node.querySelector("line")).opacity
    }));
    const replyArrows = [...document.querySelectorAll('[data-play-ui="reply-arrow"]')].map((node) => ({
      from: node.getAttribute("data-reply-from"),
      to: node.getAttribute("data-reply-to"),
      rank: node.getAttribute("data-reply-rank"),
      primary: node.getAttribute("data-reply-primary"),
      safety: node.getAttribute("data-reply-safety"),
      quality: node.getAttribute("data-reply-quality"),
      sacrifice: node.getAttribute("data-reply-sacrifice"),
      pathRole: node.getAttribute("data-path-role"),
      pathRisk: node.getAttribute("data-path-risk"),
      stroke: node.querySelector("line") === null ? null : getComputedStyle(node.querySelector("line")).stroke,
      fill: node.querySelector("polygon") === null ? null : getComputedStyle(node.querySelector("polygon")).fill,
      opacity: node.querySelector("line") === null ? null : getComputedStyle(node.querySelector("line")).opacity
    }));
    const scopedNodes = [panel, board].filter((node) => node !== null).flatMap((node) => [node, ...node.querySelectorAll("*")]);
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    return {
      label: ${JSON.stringify(label)},
      playMode: attr('[data-play-ui="root"]', "data-play-mode"),
      reactionMapAttr: attr('[data-app-ui="play-root"]', "data-play-reaction-map"),
      reactionStatus: attr('[data-play-ui="reaction-lens"]', "data-reaction-status"),
      aggressivePressed: attr('[data-play-ui="aggressive-toggle-button"]', "aria-pressed"),
      aggressiveText: document.querySelector('[data-play-ui="aggressive-toggle-button"]')?.textContent?.trim() ?? null,
      reactionPanelCount: document.querySelectorAll('[data-play-ui="reaction-lens"]').length,
      analysisLensCount: document.querySelectorAll('[data-play-ui="analysis-lens"]').length,
      arrowsSvgCount: document.querySelectorAll('[data-play-ui="reaction-arrows"]').length,
      arrows,
      replyArrows,
      best: factValue('[data-play-ui="reaction-best"]'),
      score: factValue('[data-play-ui="reaction-score"]'),
      candidateCount: factValue('[data-play-ui="reaction-candidate-count"]'),
      depth: factValue('[data-play-ui="reaction-depth"]'),
      mate: factValue('[data-play-ui="reaction-mate"]'),
      mode: factValue('[data-play-ui="reaction-mode"]'),
      objective: factValue('[data-play-ui="reaction-objective"]'),
      rivalBest: factValue('[data-play-ui="reaction-rival-best"]'),
      sideFollowUp: factValue('[data-play-ui="reaction-side-follow-up"]'),
      resultSource: factValue('[data-play-ui="reaction-result-source"]'),
      opening: factValue('[data-play-ui="reaction-opening"]'),
      openingMarkerCount: document.querySelectorAll('[data-play-ui="opening-marker"]').length,
      reactionOpeningCount: document.querySelectorAll('[data-reaction-opening="true"]').length,
      candidateOpeningCount: document.querySelectorAll('[data-candidate-opening="true"]').length,
      side: factValue('[data-play-ui="reaction-input"]'),
      turn: factValue('[data-play-ui="reaction-turn"]'),
      currentFen: document.querySelector('[data-play-ui="current-fen"]')?.textContent?.trim() ?? null,
      pathReply: rootStyle.getPropertyValue("--path-reply").trim(),
      pathReplyColor: resolvedColor("var(--path-reply)"),
      pathAlternativeColor: resolvedColor("var(--path-alternative)"),
      pathMateColor: resolvedColor("var(--path-mate)"),
      pathSacrificeColor: resolvedColor("var(--path-sacrifice)"),
      pathHanging: rootStyle.getPropertyValue("--path-hanging").trim(),
      pathHangingColor: resolvedColor("var(--path-hanging)"),
      threatDataAttrCount: scopedNodes.filter((node) =>
        [...node.getAttributeNames()].some((name) => name.includes("threat"))
      ).length,
      threatTextPresent: /threat/iu.test([panel?.textContent ?? "", board?.textContent ?? ""].join(" ")),
      // Prospective Brilliant is an approved, engine-owned Explore fact (ADR-0216). Keep rejecting
      // imported review-site vocabulary that this proof does not own.
      forbidden: /Chess\\.com|Great|Miss|Mistake|Blunder|Book|Theory|Expected Points/iu.test(panel?.textContent ?? ""),
      pageWidth,
      viewportWidth: window.innerWidth,
      boardWidth: boardRect ? Math.round(boardRect.width) : 0,
      boardVisible:
        boardRect !== null &&
        boardRect.top >= -1 &&
        boardRect.left >= -1 &&
        boardRect.right <= window.innerWidth + 1
    };
  })())`;
}

function assert(condition, message, context) {
  if (!condition) {
    throw new Error(`${message}${context === undefined ? "" : `: ${JSON.stringify(context)}`}`);
  }
}

async function waitForExploreSnapshot(cdp, label, predicate) {
  const deadline = Date.now() + 20_000;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    lastSnapshot = await evaluateJson(cdp, snapshot(label));
    if (predicate(lastSnapshot)) {
      return lastSnapshot;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`${label} did not settle: ${JSON.stringify(lastSnapshot)}`);
}

function assertExploreReady(snapshot, viewport, expected) {
  assert(snapshot.playMode === "reaction-lens", "play mode is not reaction-lens", snapshot);
  assert(snapshot.reactionMapAttr === reactionToken, "reaction map attribute missing", snapshot);
  assert(snapshot.reactionStatus === "ready", "reaction status is not ready", snapshot);
  assert(snapshot.aggressivePressed === expected.aggressive, "aggressive toggle state mismatch", snapshot);
  assert(snapshot.aggressiveText === expected.label, "aggressive toggle text mismatch", snapshot);
  assert(snapshot.reactionPanelCount === 1, "Explore panel must render exactly once", snapshot);
  assert(snapshot.analysisLensCount === 0, "spectator analysis lens must not render", snapshot);
  assert(snapshot.arrowsSvgCount === 1, "Explore arrow overlay must render once", snapshot);
  assert(snapshot.arrows.length >= 1, "at least one Explore arrow must render", snapshot);
  assert(snapshot.arrows.length <= 4, "Explore arrows must be capped", snapshot);
  assert(snapshot.best === expected.best, "Explore best idea mismatch", snapshot);
  assert(
    snapshot.mode === (expected.aggressive === "true" ? "Aggressive line for White" : "Best line for White"),
    "Explore mode must reflect selected-side winning pressure only when Aggressive is on",
    snapshot
  );
  assert(
    snapshot.objective ===
      (expected.aggressive === "true" ? "Best move first · aggressive tie-break" : "Best outcome for White"),
    "Explore objective must name the selected Side and outcome priority",
    snapshot
  );
  assert(
    /^Independent · [a-h][1-8][a-h][1-8][qrbn]?$/u.test(snapshot.rivalBest ?? ""),
    "on-turn Explore must expose an independent rival best reply",
    snapshot
  );
  assert(
    snapshot.sideFollowUp === "unavailable" ||
      /^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(snapshot.sideFollowUp ?? ""),
    "on-turn Explore follow-up must be a move or honestly unavailable when the PV has no third ply",
    snapshot
  );
  assert(snapshot.side === "White", "Explore side fact mismatch", snapshot);
  assert(snapshot.forbidden === false, "forbidden wording present in Explore panel", snapshot);

  const primary = snapshot.arrows.find((arrow) => arrow.order === "1");
  assert(primary !== undefined && primary.primary === "true", "primary Explore arrow missing", snapshot);
  assert(primary.from === expected.best.slice(0, 2), "primary arrow from-square mismatch", snapshot);
  assert(primary.to === expected.best.slice(2, 4), "primary arrow to-square mismatch", snapshot);

  const candidateCount = Number.parseInt(snapshot.candidateCount ?? "0", 10);
  assert(candidateCount >= 1, "Explore candidate count must be positive", snapshot);
  assert(/^[+-]?\d+ cp$/u.test(snapshot.score ?? ""), "Explore score must be centipawns", snapshot);
  assert(snapshot.mate === "None", "Greek-gift Explore fixture should not report forced mate", snapshot);
  assert(snapshot.pageWidth <= snapshot.viewportWidth + 1, "page overflows the viewport", snapshot);
  assert(snapshot.boardWidth > 0 && snapshot.boardVisible === true, "board is not visibly framed", {
    snapshot,
    viewport
  });
}

function assertOpeningCatalogReady(snapshot, viewport) {
  assertExploreReady(snapshot, viewport, {
    aggressive: "true",
    label: "Aggressive: On",
    best: snapshot.best
  });
  assert(snapshot.opening !== "unavailable", "catalog case must expose an available opening", snapshot);
  assert(snapshot.openingMarkerCount >= 1, "catalog case must render a discrete opening marker", snapshot);
  assert(
    snapshot.reactionOpeningCount + snapshot.candidateOpeningCount >= 1,
    "catalog case must mark an existing Explore arrow, not only panel text",
    snapshot
  );
}

function assertOffTurnSelectedSideReady(snapshot, viewport) {
  assert(snapshot.playMode === "reaction-lens", "play mode is not reaction-lens", snapshot);
  assert(snapshot.reactionMapAttr === reactionToken, "reaction map attribute missing", snapshot);
  assert(snapshot.reactionStatus === "ready", "reaction status is not ready", snapshot);
  assert(snapshot.aggressivePressed === "true", "aggressive toggle must be on", snapshot);
  assert(snapshot.side === "Black", "Explore must stay on the selected side", snapshot);
  assert(snapshot.turn === "White", "fixture must be off-turn for Black from startpos", snapshot);
  assert(
    snapshot.objective === "Rival best first · Black projected response",
    "off-turn objective must remain selected-side owned",
    snapshot
  );
  assert(
    /^Independent · [a-h][1-8][a-h][1-8][qrbn]?$/u.test(snapshot.rivalBest ?? ""),
    "off-turn Explore must expose an independent rival reply",
    snapshot
  );
  const projectedMove = /^after [a-h][1-8][a-h][1-8][qrbn]?: ([a-h][1-8][a-h][1-8][qrbn]?)$/u.exec(
    snapshot.best ?? ""
  )?.[1] ?? null;
  assert(projectedMove !== null, "off-turn Best idea must name the projected selected-Side move", snapshot);
  assert(
    snapshot.sideFollowUp === projectedMove,
    "off-turn selected-Side next move must match Best idea",
    snapshot
  );
  assert(
    /^Projected line for Black after [a-h][1-8][a-h][1-8][qrbn]?$/u.test(snapshot.mode ?? ""),
    "off-turn mode must name Black's plan after the projected reply",
    snapshot
  );
  assert(projectedMove !== null, "Best idea must include a projected move", snapshot);
  assert(/^[+-]?\d+ cp$/u.test(snapshot.score ?? ""), "Explore score must be centipawns", snapshot);
  assert(snapshot.threatDataAttrCount === 0, "Explore board must not carry threat data attributes", snapshot);
  assert(snapshot.threatTextPresent === false, "Explore board must not render threat vocabulary", snapshot);
  const classifiedColors = [snapshot.pathAlternativeColor, snapshot.pathMateColor, snapshot.pathSacrificeColor];
  assert(snapshot.pathAlternativeColor !== snapshot.pathReplyColor, "classified rival colour must not be flat reply gray", snapshot);
  assert(snapshot.pathReplyColor !== snapshot.pathHangingColor, "reply fallback colour must be distinct from hanging red", snapshot);

  const projectedReply = /after ([a-h][1-8][a-h][1-8][qrbn]?)/u.exec(snapshot.mode ?? "")?.[1] ?? null;
  const primary = snapshot.arrows.find((arrow) => arrow.order === "1");
  assert(primary !== undefined && primary.primary === "true", "primary reaction arrow missing", snapshot);
  assert(primary.rival === "true", "primary off-turn arrow must be marked as rival input", snapshot);
  assert(primary.pathRole === "main", "primary off-turn arrow must stay on the main path", snapshot);
  assert(primary.safety !== null, "primary rival reply must carry classification safety", snapshot);
  assert(primary.quality !== null, "primary rival reply must carry classification quality", snapshot);
  assert(primary.pathRisk === primary.safety, "primary rival path risk must match classification", snapshot);
  assert(primary.stroke === snapshot.pathReplyColor, "primary rival stroke must use neutral reply colour", snapshot);
  assert(primary.fill === snapshot.pathReplyColor, "primary rival fill must use neutral reply colour", snapshot);
  assert(Number.parseFloat(primary.opacity ?? "0") >= 0.75, "primary rival opacity must stay legible", snapshot);
  assert(primary.stroke !== snapshot.pathHangingColor, "primary rival stroke must not use --path-hanging", snapshot);
  assert(`${primary.from}${primary.to}` === projectedReply, "primary arrow must match the projected reply", snapshot);

  const plan = snapshot.arrows.find((arrow) => arrow.order === "2");
  assert(plan !== undefined, "selected-side continuation arrow missing", snapshot);
  assert(plan.rival === "false", "selected-side continuation must not be marked rival", snapshot);
  assert(`${plan.from}${plan.to}` === projectedMove, "selected-side continuation must match Best idea", snapshot);
  assert(snapshot.replyArrows.length + 1 <= 3, "rival arrows must be capped at three including primary", snapshot);
  for (const reply of snapshot.replyArrows) {
    assert(reply.pathRole === "reply", "secondary replies must use reply path role", snapshot);
    assert(reply.safety !== null, "secondary reply must carry classification safety", snapshot);
    assert(reply.quality !== null, "secondary reply must carry classification quality", snapshot);
    assert(classifiedColors.includes(reply.stroke), "secondary reply stroke must use classification palette", snapshot);
    assert(classifiedColors.includes(reply.fill), "secondary reply fill must use classification palette", snapshot);
    assert(reply.stroke !== snapshot.pathReplyColor, "secondary reply stroke must not use flat reply gray", snapshot);
    assert(Number.parseFloat(reply.opacity ?? "0") >= 0.75, "secondary reply opacity must stay legible", snapshot);
  }
  assert(snapshot.pageWidth <= snapshot.viewportWidth + 1, "page overflows the viewport", snapshot);
  assert(snapshot.boardWidth > 0 && snapshot.boardVisible === true, "board is not visibly framed", {
    snapshot,
    viewport
  });
}

function loadFenExpression(fen) {
  return `(() => {
    const input = document.querySelector('[data-play-ui="load-position-input"]');
    const button = document.querySelector('[data-play-ui="load-position-button"]');
    if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement) || button.disabled) {
      return false;
    }
    input.value = ${JSON.stringify(fen)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
    return true;
  })()`;
}

function click(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
    element.click();
    return true;
  })()`;
}

function centipawns(score) {
  const match = /^([+-]?\d+) cp$/u.exec(score ?? "");
  return match === null ? Number.NaN : Number.parseInt(match[1], 10);
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

  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?${reactionQuery}` });
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "Explore Play did not mount");
  assert(await evaluate(cdp, loadFenExpression(caroKannCatalogFen)), "could not load catalog proof FEN");
  await waitForExploreSnapshot(
    cdp,
    `${viewport.label}-opening-catalog-neutral`,
    (current) =>
      current.aggressivePressed === "false" &&
      current.side === "White" &&
      current.turn === "White" &&
      current.reactionStatus === "ready" &&
      current.resultSource === "rich"
  );
  assert(await evaluate(cdp, click('[data-play-ui="aggressive-toggle-button"]')), "could not toggle aggressive on for catalog case");
  const openingCatalog = await waitForExploreSnapshot(
    cdp,
    `${viewport.label}-opening-catalog`,
    (current) =>
      current.aggressivePressed === "true" &&
      current.side === "White" &&
      current.turn === "White" &&
      current.reactionStatus === "ready" &&
      current.resultSource === "rich" &&
      current.opening !== "unavailable" &&
      current.openingMarkerCount >= 1
  );
  assertOpeningCatalogReady(openingCatalog, viewport);

  await evaluate(cdp, "(() => { localStorage.clear(); sessionStorage.clear(); return true; })()");
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?${reactionQuery}` });
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "Explore Play did not mount");
  assert(await evaluate(cdp, loadFenExpression(greekGiftFen)), "could not load Greek-gift FEN");
  const off = await waitForExploreSnapshot(
    cdp,
    `${viewport.label}-off`,
    (current) =>
      current.reactionStatus === "ready" &&
      current.best !== "unavailable" &&
      current.resultSource === "rich"
  );
  assertExploreReady(off, viewport, {
    aggressive: "false",
    label: "Aggressive: Off",
    best: off.best
  });

  assert(await evaluate(cdp, click('[data-play-ui="aggressive-toggle-button"]')), "could not toggle aggressive on");
  const on = await waitForExploreSnapshot(
    cdp,
    `${viewport.label}-on`,
    (current) =>
      current.reactionStatus === "ready" &&
      current.best !== "unavailable" &&
      current.resultSource === "rich"
  );
  assertExploreReady(on, viewport, {
    aggressive: "true",
    label: "Aggressive: On",
    best: on.best
  });
  assert(
    centipawns(on.score) >= centipawns(off.score),
    "Aggressive primary must not score below the objective Neutral primary",
    { off, on }
  );

  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?${reactionQuery}` });
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "owner-FEN Explore did not mount");
  assert(await evaluate(cdp, loadFenExpression(ownerRegressionFen)), "could not load owner regression FEN");
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="reaction-turn"] dd')?.textContent?.trim() === 'Black' &&
      document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready'`,
    "owner regression FEN did not settle"
  );
  assert(await evaluate(cdp, click('[data-play-ui="player-side-button"][data-player-side="black"]')), "could not select Black on owner FEN");
  const ownerNeutral = await waitForExploreSnapshot(
    cdp,
    `${viewport.label}-owner-neutral`,
    (current) =>
      current.side === "Black" &&
      current.reactionStatus === "ready" &&
      current.best !== "unavailable" &&
      current.resultSource === "rich"
  );
  assert(ownerNeutral.openingMarkerCount === 0, "owner regression Neutral must not show opening markers", ownerNeutral);
  assert(await evaluate(cdp, click('[data-play-ui="aggressive-toggle-button"]')), "could not enable Aggressive on owner FEN");
  const ownerAggressive = await waitForExploreSnapshot(
    cdp,
    `${viewport.label}-owner-aggressive`,
    (current) =>
      current.aggressivePressed === "true" &&
      current.reactionStatus === "ready" &&
      current.best !== "unavailable" &&
      current.resultSource === "rich"
  );
  assert(ownerAggressive.openingMarkerCount === 0, "owner regression Aggressive must not show opening markers", ownerAggressive);
  assert(ownerAggressive.depth === ownerNeutral.depth, "owner regression modes must share one depth", { ownerNeutral, ownerAggressive });
  assert(ownerAggressive.objective === "Best move first · aggressive tie-break", "owner regression copy must state the real contract", ownerAggressive);
  assert(/^Independent · [a-h][1-8][a-h][1-8][qrbn]?$/u.test(ownerAggressive.rivalBest ?? ""), "owner regression must expose an independent rival reply", ownerAggressive);

  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?${reactionQuery}` });
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "Explore Play did not mount");
  assert(await evaluate(cdp, click('[data-play-ui="player-side-button"][data-player-side="black"]')), "could not select Black");
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="reaction-input"] dd')?.textContent?.trim() === 'Black'`,
    "Explore did not switch to selected side Black"
  );
  assert(await evaluate(cdp, click('[data-play-ui="aggressive-toggle-button"]')), "could not toggle aggressive on");
  const offTurn = await waitForExploreSnapshot(
    cdp,
    `${viewport.label}-off-turn-black-on`,
    (current) =>
      current.aggressivePressed === "true" &&
      current.side === "Black" &&
      current.reactionStatus === "ready" &&
      current.resultSource === "rich" &&
      typeof current.mode === "string" &&
      current.mode.startsWith("Projected line for Black after ")
  );
  assertOffTurnSelectedSideReady(offTurn, viewport);
  assert(offTurn.opening === "unavailable", "off-turn rival position must not expose a catalog opening", offTurn);
  assert(offTurn.openingMarkerCount === 0, "off-turn rival position must not render opening markers", offTurn);
  return { viewport: viewport.label, openingCatalog, off, on, ownerNeutral, ownerAggressive, offTurn };
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
console.log("Play Explore Aggressive-On browser proof passed.");
for (const result of results) {
  console.log(
    `  ${result.viewport}: opening=${result.openingCatalog.opening} best=${result.openingCatalog.best} off=${result.off.best} (${result.off.score}) on=${result.on.best} (${result.on.score}) owner=${result.ownerAggressive.best} (${result.ownerAggressive.score}) off-turn=${result.offTurn.mode} best=${result.offTurn.best} (${result.offTurn.score})`
  );
}
