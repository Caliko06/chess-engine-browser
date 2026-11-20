import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { extname, join, relative } from "node:path";
import {
  assertWasmBindgenCliVersion,
  betaCsp,
  contentType,
  copyBuiltWeb,
  copyProductCss,
  copyProductHtml,
  run,
  scanStaticOutput,
  walk,
  writeEmbeddedWasmModule
} from "./beta-preview-support.mjs";

const proofLabel = "P3.13 artifact-filtered saved retry route proof";
const proofRoot = "/private/tmp/chess-p3-13-artifact-filtered-saved-retry-route-proof";
const storeKey = "chess.trainer.reviewStore.v1";
const viewports = [
  { width: 1280, height: 900, label: "desktop" },
  { width: 390, height: 844, label: "narrow" }
];
const bannedRouteWords = [
  "weakness", "weak spot", "skill gap", "tendency", "habit", "you miss", "tactic",
  "motif", "opening", "material", "conversion", "confidence", "likely",
  "statistically significant", "priority", "ranking", "recommend", "recommended",
  "you should practice", "schedule", "due", "progress", "no issue", "cleared",
  "absent", "safe", "not a problem"
];

function review(id, savedAtIso, entries, artifacts) {
  return {
    id, savedAtIso,
    source: "review-pgn",
    review: { summary: { totalMoves: entries.length, best: 0, good: entries.length, inaccuracies: 0, mistakes: 0, blunders: 0 }, entries },
    artifacts
  };
}

function entry(ply) {
  return { ...moveFacts, ply };
}

const moveFacts = { playedMove: "g1f3", san: "Nf3", bestMove: "d2d4", bestScoreCp: 20, playedScoreCp: -60, cpLoss: 80, label: "good" };
const retry = {
  rank: 1, entryIndex: 1, ply: 41, fenBefore: "fen-filter-old",
  playedMove: moveFacts.playedMove,
  bestMove: moveFacts.bestMove,
  san: moveFacts.san,
  label: moveFacts.label,
  cpLoss: moveFacts.cpLoss
};
const keyMoment = { rank: 1, entryIndex: 1, kind: "centipawn-loss", ply: 41, ...moveFacts };
const localSearchSwing = { ...keyMoment, kind: "local-search-swing" };
const forkCandidate = {
  rank: 1, entryIndex: 1, ply: 41,
  sourceKind: "best-move-after-position",
  bestMove: moveFacts.bestMove,
  movedPiece: { color: "white", kind: "pawn" },
  destination: "d4",
  targets: [{ square: "e5", piece: { color: "black", kind: "pawn" } }],
  cpLoss: moveFacts.cpLoss,
  label: moveFacts.label
};
const emptyArtifacts = { keyMoments: [], evidence: [], forkCandidates: [], earlyMoveDivergences: [], retryPositions: [] };
const matchedStore = {
  schemaVersion: 2,
  reviews: [
    review("route-old", "2026-05-15T10:00:00.000Z", [entry(10), entry(41)], { keyMoments: [keyMoment], evidence: [localSearchSwing], forkCandidates: [forkCandidate], earlyMoveDivergences: [], retryPositions: [retry] }),
    review("route-new", "2026-05-15T18:00:00.000Z", [entry(12)], { ...emptyArtifacts, retryPositions: [{ ...retry, fenBefore: "fen-visible-new" }] })
  ]
};
const noMatchedStore = {
  schemaVersion: 2,
  reviews: [review("route-only", "2026-05-15T11:00:00.000Z", [entry(9)], { ...emptyArtifacts, retryPositions: [retry] })]
};

function prepareProofOutput() {
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(join(proofRoot, "dist/pkg"), { recursive: true });
  run("node", ["scripts/audit-policy.mjs"]);
  run("pnpm", ["--filter", "web", "run", "build"]);
  assertWasmBindgenCliVersion(proofLabel);
  run("cargo", ["build", "-p", "chess-wasm-bridge", "--target", "wasm32-unknown-unknown", "--release"]);
  run("wasm-bindgen", [
    "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm",
    "--target",
    "bundler",
    "--out-dir",
    join(proofRoot, "dist/pkg")
  ]);
  writeEmbeddedWasmModule(proofRoot, { removeWasmAsset: true });
  copyBuiltWeb(proofRoot);
  copyProductHtml(proofRoot, {
    missingMessage: "P3.13 product HTML is missing",
    scanBeforeChecks: true,
    cspCheck: "meta",
    cspMismatchMessage: (metaCsp) => `P3.13 product HTML CSP mismatch: ${metaCsp}`,
    requiredIncludes: [{ text: 'id="chess-review-app"', message: "P3.13 product root is missing" }, { text: 'href="./review.css"', message: "P3.13 product stylesheet href is missing" }, { text: 'src="./dist/app.js"', message: "P3.13 product entrypoint script is missing" }]
  });
  copyProductCss(proofRoot, { missingMessage: "P3.13 product stylesheet is missing" });
  scanStaticOutput(proofRoot, { extraForbiddenTokens: ['<script type="importmap"', "ServiceWorker", "Worker("] });
}

function isServedFile(path) { return [".html", ".css", ".js", ".mjs"].includes(extname(path)); }

async function startStaticServer() {
  const files = new Map(walk(proofRoot).filter(isServedFile).map((file) => [
    `/${relative(proofRoot, file).split("/").map(encodeURIComponent).join("/")}`,
    file
  ]));
  const requests = [];
  const servedResponses = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const file = pathname === "/" ? files.get("/index.html") : files.get(pathname);
    requests.push(pathname);
    response.setHeader("Content-Security-Policy", betaCsp);
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (file === undefined || !statSync(file).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    const type = contentType(file);
    servedResponses.push({ pathname, contentType: type });
    response.writeHead(200, { "Content-Type": type });
    response.end(request.method === "HEAD" ? undefined : readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, requests, servedResponses, port: server.address().port };
}

async function reserveLoopbackPort() {
  const server = createServer((_request, response) => {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("reserved");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return port;
}

function chromePath() {
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(macChrome) ? macChrome : "google-chrome";
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectCdp(debugPort) {
  const deadline = Date.now() + 10_000;
  let webSocketUrl = "";
  while (Date.now() < deadline && webSocketUrl === "") {
    try {
      const tabs = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      webSocketUrl = tabs.find((tab) => tab.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch {
      await delay(100);
    }
  }
  if (webSocketUrl === "") throw new Error("CDP endpoint was not available");
  const websocket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  websocket.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    const command = pending.get(message.id);
    if (command === undefined) return;
    pending.delete(message.id);
    message.error === undefined ? command.resolve(message.result ?? {}) : command.reject(new Error(message.error.message));
  });
  await new Promise((resolve, reject) => {
    websocket.addEventListener("open", resolve, { once: true });
    websocket.addEventListener("error", () => reject(new Error("Could not open CDP WebSocket")), { once: true });
  });
  return {
    close: () => websocket.close(),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      websocket.send(JSON.stringify({ id, method, params }));
    })
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function evaluateJson(cdp, expression) {
  return JSON.parse(await evaluate(cdp, expression));
}

async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await delay(250);
  }
  throw new Error(label);
}

async function mountWithStore(cdp, url, store) {
  await cdp.send("Page.navigate", { url });
  await waitFor(cdp, "document.querySelector('[data-review-ui=\"pgn-input\"]') !== null", "app did not mount");
  await waitFor(cdp, "Array.from(document.styleSheets).some((sheet) => sheet.href?.endsWith('/review.css'))", "product stylesheet did not load");
  await evaluate(cdp, `localStorage.setItem(${JSON.stringify(storeKey)}, ${JSON.stringify(JSON.stringify(store))}); true;`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(cdp, "document.querySelector('[data-review-ui=\"saved-retry-route\"]') !== null", "saved route did not render");
}

function readRouteExpression() {
  return `(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const texts = (selector) => Array.from(document.querySelectorAll(selector), (node) => node.textContent?.trim() ?? "");
    return JSON.stringify({
      savedReviews: text('[data-review-ui="saved-retry-route-saved-reviews"]'),
      reviewedMoves: text('[data-review-ui="saved-retry-route-reviewed-moves"]'),
      artifactBacked: text('[data-review-ui="saved-retry-route-artifact-backed-reviews"]'),
      artifactMissing: text('[data-review-ui="saved-retry-route-artifact-missing-reviews"]'),
      savedRetryPositions: text('[data-review-ui="saved-retry-route-saved-retry-positions"]'),
      filterRows: texts('[data-review-ui="saved-retry-route-filter"]'),
      filteredButtons: texts('[data-review-ui="open-filtered-saved-retry-route-button"]'),
      globalButton: text('[data-review-ui="open-saved-retry-route-button"]'),
      routeText: text('[data-review-ui="saved-retry-route"]')
    });
  })()`;
}

function openFilteredRouteExpression(index) {
  return `(() => {
    document.querySelector('[data-review-ui="open-filtered-saved-retry-route-button"][data-review-index="${index}"]')?.click();
    return JSON.stringify({
      savedAt: document.querySelector('[data-review-ui="saved-review-detail-saved-at"]')?.textContent?.trim() ?? "",
      practiceIndex: document.querySelector('[data-review-ui="saved-review-detail-practice-index"]')?.textContent?.trim() ?? "",
      practiceFen: document.querySelector('[data-review-ui="saved-review-detail-practice-fen"]')?.textContent?.trim() ?? "",
      practiceInput: document.querySelector('[data-review-ui="saved-review-detail-practice-input"]') !== null
    });
  })()`;
}

function layoutExpression(viewport) {
  const selectors = [
    '[data-review-ui="saved-retry-route"]',
    '[data-review-ui="saved-retry-route-filter"]',
    '[data-review-ui="open-filtered-saved-retry-route-button"]',
    '[data-review-ui="saved-review-detail-practice"]'
  ];
  return `(() => {
    const issues = [];
    for (const selector of ${JSON.stringify(selectors)}) {
      for (const element of document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement)) issues.push({ kind: "not-element", selector });
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) issues.push({ kind: "zero", selector });
        if (rect.left < -1 || rect.right > window.innerWidth + 1) issues.push({ kind: "horizontal-overflow", selector, left: rect.left, right: rect.right, width: window.innerWidth });
      }
    }
    const rows = Array.from(document.querySelectorAll('[data-review-ui="saved-retry-route-filter"]'), (row) => row.getBoundingClientRect());
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index - 1].bottom > rows[index].top + 1) issues.push({ kind: "filter-row-overlap", index });
    }
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (pageWidth > window.innerWidth + 1) issues.push({ kind: "page-horizontal-overflow", pageWidth, viewportWidth: window.innerWidth });
    return JSON.stringify({ expectedViewport: ${JSON.stringify(viewport)}, actualViewport: { width: window.innerWidth, height: window.innerHeight }, issues });
  })()`;
}

async function typeTextWithCdp(cdp, selector, text) {
  const reset = await evaluateJson(cdp, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return JSON.stringify({ ok: false, reason: "missing-input" });
    input.focus(); input.value = ""; input.setSelectionRange(0, 0);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: null, inputType: "deleteContentBackward" }));
    return JSON.stringify({ ok: true });
  })()`);
  if (reset.ok !== true) return reset;
  let typed = "";
  for (const char of text) {
    typed += char;
    await cdp.send("Input.insertText", { text: char });
    const ok = await evaluate(cdp, `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      return input instanceof HTMLInputElement && input.value === ${JSON.stringify(typed)} &&
        document.activeElement === input && input.selectionStart === ${String(typed.length)} &&
        input.selectionEnd === ${String(typed.length)};
    })()`);
    if (ok !== true) return { ok: false, typed };
  }
  return { ok: true, typed: text, activeRestored: true, caretRestored: true };
}

function assertNoBannedRouteWords(text, label) {
  const normalized = text.toLowerCase();
  const matched = bannedRouteWords.filter((word) => word === "due" || word === "safe" ? new RegExp(`\\b${word}\\b`, "u").test(normalized) : normalized.includes(word));
  if (matched.length > 0) throw new Error(`${label} route wording used banned words: ${matched.join(", ")}`);
}

async function assertMatchedStore(cdp, viewport) {
  const content = await evaluateJson(cdp, readRouteExpression());
  const expectedRows = [
    "Key momentsKey moments1 key momentMatched retry positions1 from 1 key momentOpen saved retry position",
    "Local search swingsLocal search swings1 local search swingMatched retry positions1 from 1 local search swingOpen saved retry position",
    "Fork candidatesFork candidates1 fork candidateMatched retry positions1 from 1 fork candidateOpen saved retry position"
  ];
  if (
    content.savedReviews !== "Saved reviews2 saved reviews" ||
    content.reviewedMoves !== "Reviewed moves3 reviewed moves" ||
    content.artifactBacked !== "Artifact-backed reviews2 of 2 saved reviews" ||
    content.artifactMissing !== "Artifact-missing reviews0 of 2 saved reviews" ||
    content.savedRetryPositions !== "Saved retry positions2 from 2 artifact-backed reviews" ||
    content.globalButton !== "Open saved retry position" ||
    JSON.stringify(content.filterRows) !== JSON.stringify(expectedRows) ||
    JSON.stringify(content.filteredButtons) !== JSON.stringify(["Open saved retry position", "Open saved retry position", "Open saved retry position"])
  ) {
    throw new Error(`P3.13 ${viewport.label} matched route content failed: ${JSON.stringify(content)}`);
  }
  assertNoBannedRouteWords(content.routeText, `P3.13 ${viewport.label}`);
}

async function runViewportProof(cdp, url, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await mountWithStore(cdp, url, noMatchedStore);
  const noMatch = await evaluateJson(cdp, readRouteExpression());
  if (noMatch.globalButton !== "Open saved retry position" || noMatch.filteredButtons.length !== 0) {
    throw new Error(`P3.13 ${viewport.label} zero-match button proof failed: ${JSON.stringify(noMatch)}`);
  }
  await mountWithStore(cdp, url, matchedStore);
  await assertMatchedStore(cdp, viewport);
  const opened = await evaluateJson(cdp, openFilteredRouteExpression(0));
  if (opened.savedAt !== "Saved at2026-05-15 10:00 UTC" || opened.practiceIndex !== "Position 1 of 1" || opened.practiceFen !== "FEN beforefen-filter-old" || opened.practiceInput !== true) {
    throw new Error(`P3.13 ${viewport.label} filtered route open failed: ${JSON.stringify(opened)}`);
  }
  const typeCheck = await typeTextWithCdp(cdp, '[data-review-ui="saved-review-detail-practice-input"]', "d2d4");
  if (typeCheck.ok !== true || typeCheck.activeRestored !== true || typeCheck.caretRestored !== true) {
    throw new Error(`P3.13 ${viewport.label} typing proof failed: ${JSON.stringify(typeCheck)}`);
  }
  const layout = await evaluateJson(cdp, layoutExpression(viewport));
  if (layout.actualViewport.width !== viewport.width || layout.actualViewport.height !== viewport.height || layout.issues.length > 0) {
    throw new Error(`P3.13 ${viewport.label} layout proof failed: ${JSON.stringify(layout)}`);
  }
  await evaluate(cdp, `localStorage.setItem(${JSON.stringify(storeKey)}, "{"); document.querySelector('[data-review-ui="delete-review-button"]')?.click(); true;`);
  await waitFor(cdp, "document.querySelector('[data-review-ui=\"saved-retry-route\"]')?.hasAttribute('hidden')", `${viewport.label} stale route did not hide`);
  await evaluate(cdp, "document.querySelector('[data-review-ui=\"recover-store-button\"]')?.click(); document.querySelector('[data-review-ui=\"confirm-recover-store-button\"]')?.click(); true;");
  await waitFor(cdp, "document.querySelector('[data-review-ui=\"saved-retry-route-saved-retry-positions\"]')?.textContent === 'Saved retry positions0 from 0 artifact-backed reviews'", `${viewport.label} recovery did not reset route counts`);
  const recovered = await evaluateJson(cdp, readRouteExpression());
  if (recovered.filteredButtons.length !== 0) throw new Error(`P3.13 ${viewport.label} recovery kept filtered buttons: ${JSON.stringify(recovered)}`);
}

async function runBrowserProof(url, debugPort) {
  const chrome = spawn(chromePath(), [
    "--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
    "--disable-sync", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${debugPort}`,
    "--remote-allow-origins=*", `--user-data-dir=${join(proofRoot, "chrome-profile")}`, "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let cdp;
  try {
    cdp = await connectCdp(debugPort);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    for (const viewport of viewports) await runViewportProof(cdp, url, viewport);
  } finally {
    if (cdp !== undefined) {
      await cdp.send("Browser.close").catch(() => {});
      cdp.close();
    }
    chrome.kill();
  }
}

prepareProofOutput();
const { server, requests, servedResponses, port } = await startStaticServer();
try {
  await runBrowserProof(`http://127.0.0.1:${port}/index.html`, await reserveLoopbackPort());
} finally {
  server.close();
}
if (!requests.includes("/review.css")) throw new Error(`P3.13 proof did not request review.css: ${requests.join(", ")}`);
if (!servedResponses.some((response) => response.pathname === "/review.css" && response.contentType === "text/css; charset=utf-8")) {
  throw new Error(`P3.13 proof did not serve review.css as text/css: ${JSON.stringify(servedResponses)}`);
}
if (requests.some((request) => request.endsWith(".wasm"))) throw new Error(`P3.13 proof requested a .wasm asset: ${requests.join(", ")}`);
console.log("P3.13 artifact-filtered saved retry route browser proof passed.");
