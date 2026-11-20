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

const proofLabel = "P3.5 fork-candidate exposure proof";
const proofRoot = "/private/tmp/chess-p3-5-fork-candidate-exposure-proof";
const csp = betaCsp;
const storeKey = "chess.trainer.reviewStore.v1";
const samplePgn = "1. e4 e5 2. Qh5 Nc6 3. Bc4 Bc5 4. a3 *";
const viewports = [
  { width: 1280, height: 900, label: "desktop" },
  { width: 390, height: 844, label: "narrow" }
];

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
    missingMessage: "P3.5 product HTML is missing",
    scanBeforeChecks: true,
    cspCheck: "meta",
    cspMismatchMessage: (metaCsp) => `P3.5 product HTML CSP mismatch: ${metaCsp}`,
    requiredIncludes: [
      { text: 'id="chess-review-app"', message: "P3.5 product root is missing" },
      { text: 'href="./review.css"', message: "P3.5 product stylesheet href is missing" },
      { text: 'src="./dist/app.js"', message: "P3.5 product entrypoint script is missing" }
    ]
  });
  copyProductCss(proofRoot, { missingMessage: "P3.5 product stylesheet is missing" });
  scanStaticOutput(proofRoot, { extraForbiddenTokens: ["<script type=\"importmap\"", "ServiceWorker", "Worker("] });
}

function isServedFile(path) {
  return [".html", ".css", ".js", ".mjs"].includes(extname(path));
}

async function startStaticServer() {
  const files = new Map(
    walk(proofRoot)
      .filter(isServedFile)
      .map((file) => [`/${relative(proofRoot, file).split("/").map(encodeURIComponent).join("/")}`, file])
  );
  const requests = [];
  const servedResponses = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const file = pathname === "/" ? files.get("/index.html") : files.get(pathname);
    requests.push(pathname);
    response.setHeader("Content-Security-Policy", csp);
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("method not allowed");
      return;
    }
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
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Reserved loopback port was unavailable");
  }
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
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
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
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

async function mountCleanPage(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await waitFor(cdp, "document.querySelector('[data-review-ui=\"pgn-input\"]') !== null", "app did not mount");
  await waitFor(cdp, "Array.from(document.styleSheets).some((sheet) => sheet.href?.endsWith('/review.css'))", "product stylesheet did not load");
  await evaluate(cdp, `localStorage.removeItem(${JSON.stringify(storeKey)}); true;`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(cdp, "document.querySelector('[data-review-ui=\"pgn-input\"]') !== null", "app did not remount");
  await waitFor(cdp, "Array.from(document.styleSheets).some((sheet) => sheet.href?.endsWith('/review.css'))", "product stylesheet did not reload");
}

function headerExpression() {
  return `(() => JSON.stringify({
    documentTitle: document.title,
    productTitle: document.querySelector('[data-review-ui="product-title"]')?.textContent,
    releaseBadge: document.querySelector('[data-review-ui="release-badge"]')?.textContent,
    releaseScope: document.querySelector('[data-review-ui="release-scope"]')?.textContent
  }))()`;
}

function sampleReviewExpression() {
  return `(() => {
    const input = document.querySelector('[data-review-ui="pgn-input"]');
    const depth = document.querySelector('[data-review-ui="depth-control"]');
    if (!(input instanceof HTMLTextAreaElement) || !(depth instanceof HTMLSelectElement)) return false;
    input.value = ${JSON.stringify(samplePgn)};
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "*", inputType: "insertText" }));
    depth.value = "2";
    depth.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector('[data-review-ui="review-button"]')?.click();
    return true;
  })()`;
}

function contentExpression() {
  return `(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const count = (selector) => document.querySelectorAll(selector).length;
    const rowsHaveText = (selector, expected) => {
      const rows = Array.from(document.querySelectorAll(selector)).map((row) => row.textContent?.trim() ?? "");
      return rows.length === expected && rows.every((value) => value.length > 0);
    };
    return JSON.stringify({
      pgnValue: document.querySelector('[data-review-ui="pgn-input"]')?.value,
      depthValue: document.querySelector('[data-review-ui="depth-control"]')?.value,
      reviewButtonText: text('[data-review-ui="review-button"]'),
      status: text('[data-review-ui="status"]'),
      summaryTotal: text('[data-review-ui="summary-total-moves"]'),
      moveRowCount: count('[data-review-ui="move-row"]'),
      moveRowsHaveText: rowsHaveText('[data-review-ui="move-row"]', 7),
      keyMomentRows: count('[data-review-ui="key-moment-row"]'),
      evidenceRows: count('[data-review-ui="evidence-row"]'),
      forkCandidateRows: count('[data-review-ui="fork-candidate-row"]'),
      forkCandidateBestMove: text('[data-review-ui="fork-candidate-best-move"]'),
      forkCandidateMovedPiece: text('[data-review-ui="fork-candidate-moved-piece"]'),
      forkCandidateDestination: text('[data-review-ui="fork-candidate-destination"]'),
      forkCandidateTargets: text('[data-review-ui="fork-candidate-targets"]'),
      earlyDivergenceRows: count('[data-review-ui="early-divergence-row"]'),
      retryPositionRows: count('[data-review-ui="retry-position-row"]'),
      savedDetailMoveCount: text('[data-review-ui="saved-review-detail-move-count"]'),
      savedDetailRows: count('[data-review-ui="saved-review-detail-move-row"]'),
      savedRowsHaveText: rowsHaveText('[data-review-ui="saved-review-detail-move-row"]', 7),
      savedForkCandidateRows: count('[data-review-ui="saved-review-detail-fork-candidate-row"]'),
      savedForkCandidateBestMove: text('[data-review-ui="saved-review-detail-fork-candidate-best-move"]'),
      savedForkCandidateMovedPiece: text('[data-review-ui="saved-review-detail-fork-candidate-moved-piece"]'),
      savedForkCandidateDestination: text('[data-review-ui="saved-review-detail-fork-candidate-destination"]'),
      savedForkCandidateTargets: text('[data-review-ui="saved-review-detail-fork-candidate-targets"]'),
      bannedClaimPresent: /tactic|weakness|opening|material|wins/i.test(document.body.textContent ?? "")
    });
  })()`;
}

function layoutExpression(expectedViewport) {
  const visibleSelectors = [
    '[data-review-ui="product-header"]', '[data-review-ui="product-title"]', '[data-review-ui="release-badge"]',
    '[data-review-ui="release-scope"]', '[data-review-ui="review-form"]', '[data-review-ui="pgn-input"]',
    '[data-review-ui="depth-control"]', '[data-review-ui="review-button"]', '[data-review-ui="summary"]',
    '[data-review-ui="summary-total-moves"]', '[data-review-ui="move-list"]', '[data-review-ui="move-row"]',
    '[data-review-ui="coach-artifacts"]', '[data-review-ui="key-moment-row"]', '[data-review-ui="evidence-row"]',
    '[data-review-ui="fork-candidate-row"]', '[data-review-ui="fork-candidate-best-move"]',
    '[data-review-ui="fork-candidate-moved-piece"]', '[data-review-ui="fork-candidate-destination"]',
    '[data-review-ui="fork-candidate-targets"]', '[data-review-ui="early-divergence-row"]',
    '[data-review-ui="retry-position-row"]', '[data-review-ui="profile"]',
    '[data-review-ui="profile-total-reviews"]', '[data-review-ui="stored-review-list"]', '[data-review-ui="stored-review-row"]',
    '[data-review-ui="view-review-button"]', '[data-review-ui="saved-review-detail"]',
    '[data-review-ui="saved-review-detail-move-row"]', '[data-review-ui="saved-review-detail-fork-candidate-row"]',
    '[data-review-ui="saved-review-detail-fork-candidate-best-move"]',
    '[data-review-ui="saved-review-detail-fork-candidate-moved-piece"]',
    '[data-review-ui="saved-review-detail-fork-candidate-destination"]',
    '[data-review-ui="saved-review-detail-fork-candidate-targets"]'
  ];
  const coreRegions = [
    '[data-review-ui="product-header"]', '[data-review-ui="review-form"]', '[data-review-ui="summary"]',
    '[data-review-ui="move-list"]', '[data-review-ui="coach-artifacts"]', '[data-review-ui="profile"]',
    '[data-review-ui="stored-review-list"]', '[data-review-ui="saved-review-detail"]'
  ];
  return `(() => {
    const visibleSelectors = ${JSON.stringify(visibleSelectors)};
    const coreRegions = ${JSON.stringify(coreRegions)};
    const issues = [];
    const docBox = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return { selector, missing: true };
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        selector, missing: false, left: rect.left + window.scrollX, right: rect.right + window.scrollX,
        top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY, width: rect.width,
        height: rect.height, display: style.display, visibility: style.visibility, opacity: style.opacity
      };
    };
    const visibleHit = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return { ok: false, reason: "missing" };
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden" ||
        style.visibility === "collapse" || Number(style.opacity) === 0) {
        return { ok: false, reason: "hidden-or-zero", rect: { width: rect.width, height: rect.height } };
      }
      const left = Math.max(rect.left, 0);
      const right = Math.min(rect.right, window.innerWidth);
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, window.innerHeight);
      if (right <= left || bottom <= top) return { ok: false, reason: "offscreen" };
      const target = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (target === null || (target !== element && !element.contains(target))) {
        return { ok: false, reason: "covered", coveringTag: target?.tagName ?? null, coveringUi: target?.getAttribute?.("data-review-ui") ?? null };
      }
      return { ok: true };
    };
    const boxes = coreRegions.map(docBox);
    for (const box of [...visibleSelectors.map(docBox), ...boxes]) {
      if (box.missing || box.width <= 0 || box.height <= 0 || box.display === "none" ||
        box.visibility === "hidden" || box.visibility === "collapse" || Number(box.opacity) === 0) {
        issues.push({ kind: "not-rendered", box });
      }
    }
    for (const selector of visibleSelectors) {
      const hit = visibleHit(selector);
      if (!hit.ok) issues.push({ kind: "not-visible", selector, hit });
    }
    const renderedBoxes = boxes.filter((box) => !box.missing);
    for (let outer = 0; outer < renderedBoxes.length; outer += 1) {
      for (let inner = outer + 1; inner < renderedBoxes.length; inner += 1) {
        const a = renderedBoxes[outer];
        const b = renderedBoxes[inner];
        const overlapWidth = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const overlapHeight = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        if (overlapWidth * overlapHeight > 1) issues.push({ kind: "core-overlap", first: a.selector, second: b.selector, overlapWidth, overlapHeight });
      }
    }
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (pageWidth > window.innerWidth + 1) issues.push({ kind: "page-horizontal-overflow", pageWidth, viewportWidth: window.innerWidth });
    return JSON.stringify({ expectedViewport: ${JSON.stringify(expectedViewport)}, actualViewport: { width: window.innerWidth, height: window.innerHeight }, issues, boxes });
  })()`;
}

async function runViewportProof(cdp, url, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await mountCleanPage(cdp, url);
  const header = await evaluateJson(cdp, headerExpression());
  if (header.documentTitle !== "Local Chess Trainer" || header.productTitle !== "Local Chess Trainer" ||
    header.releaseBadge !== "Beta 0.2 Active Trainer" || header.releaseScope !== "Local review and retry practice") {
    throw new Error(`P3.5 ${viewport.label} header proof failed: ${JSON.stringify(header)}`);
  }
  if ((await evaluate(cdp, sampleReviewExpression())) !== true) throw new Error(`P3.5 ${viewport.label} sample review input failed`);
  await waitFor(cdp, "document.querySelector('[data-review-ui=\"summary-total-moves\"]')?.textContent === 'Total moves7'", `${viewport.label} review did not complete`);
  for (const selector of ["key-moment-row", "evidence-row", "fork-candidate-row", "early-divergence-row", "retry-position-row"]) {
    await waitFor(cdp, `document.querySelector('[data-review-ui="${selector}"]') !== null`, `${viewport.label} ${selector} did not render`);
  }
  await evaluate(cdp, "document.querySelector('[data-review-ui=\"save-button\"]')?.click(); true;");
  await waitFor(cdp, "document.querySelector('[data-review-ui=\"profile-total-reviews\"]')?.textContent === 'Saved reviews1'", `${viewport.label} saved review profile did not update`);
  const persisted = await evaluateJson(cdp, `(() => {
    const text = localStorage.getItem(${JSON.stringify(storeKey)});
    const store = JSON.parse(text ?? "{}");
    const first = store.reviews?.[0];
    return JSON.stringify({
      schemaVersion: store.schemaVersion,
      hasForkCandidates: first?.artifacts?.forkCandidates?.length > 0,
      rawPgnPersisted: typeof text === "string" && (text.includes(${JSON.stringify(samplePgn)}) || text.includes("1. e4 e5"))
    });
  })()`);
  if (persisted.schemaVersion !== 2 || persisted.hasForkCandidates !== true || persisted.rawPgnPersisted !== false) {
    throw new Error(`P3.5 ${viewport.label} persistence proof failed: ${JSON.stringify(persisted)}`);
  }
  await waitFor(cdp, "document.querySelector('[data-review-ui=\"stored-review-row\"]') !== null", `${viewport.label} saved-review row did not render`);
  await evaluate(cdp, "document.querySelector('[data-review-ui=\"view-review-button\"]')?.click(); true;");
  await waitFor(cdp, "document.querySelector('[data-review-ui=\"saved-review-detail-fork-candidate-row\"]') !== null", `${viewport.label} saved fork candidate did not render`);
  const content = await evaluateJson(cdp, contentExpression());
  if (content.pgnValue !== samplePgn || content.depthValue !== "2" || content.reviewButtonText !== "Review" ||
    content.status !== "Review complete" || content.summaryTotal !== "Total moves7" || content.moveRowCount !== 7 ||
    content.moveRowsHaveText !== true || content.keyMomentRows < 1 || content.evidenceRows < 1 ||
    content.forkCandidateRows < 1 || content.forkCandidateBestMove !== "Best moveh5f7" ||
    content.forkCandidateMovedPiece !== "Moved pieceWhite queen" ||
    content.forkCandidateDestination !== "Destinationf7" ||
    !content.forkCandidateTargets.includes("e8 Black king") ||
    !content.forkCandidateTargets.includes("g7 Black pawn") ||
    content.earlyDivergenceRows < 1 || content.retryPositionRows < 1 ||
    content.savedDetailMoveCount !== "Moves7" || content.savedDetailRows !== 7 ||
    content.savedRowsHaveText !== true || content.savedForkCandidateRows < 1 ||
    content.savedForkCandidateBestMove !== "Best moveh5f7" ||
    content.savedForkCandidateMovedPiece !== "Moved pieceWhite queen" ||
    content.savedForkCandidateDestination !== "Destinationf7" ||
    !content.savedForkCandidateTargets.includes("e8 Black king") ||
    !content.savedForkCandidateTargets.includes("g7 Black pawn") ||
    content.bannedClaimPresent !== false) {
    throw new Error(`P3.5 ${viewport.label} content proof failed: ${JSON.stringify(content)}`);
  }
  const layout = await evaluateJson(cdp, layoutExpression(viewport));
  if (layout.actualViewport.width !== viewport.width || layout.actualViewport.height !== viewport.height || layout.issues.length > 0) {
    throw new Error(`P3.5 ${viewport.label} layout proof failed: ${JSON.stringify(layout)}`);
  }
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
  const debugPort = await reserveLoopbackPort();
  await runBrowserProof(`http://127.0.0.1:${port}/index.html`, debugPort);
} finally {
  server.close();
}
if (!requests.includes("/review.css")) throw new Error(`P3.5 proof did not request review.css: ${requests.join(", ")}`);
if (!servedResponses.some((response) => response.pathname === "/review.css" && response.contentType === "text/css; charset=utf-8")) {
  throw new Error(`P3.5 proof did not serve review.css as text/css: ${JSON.stringify(servedResponses)}`);
}
if (requests.some((request) => request.endsWith(".wasm"))) throw new Error(`P3.5 proof requested a .wasm asset: ${requests.join(", ")}`);
console.log("P3.5 browser fork-candidate exposure proof passed.");
