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

const proofLabel = "P3.10 saved retry route availability proof";
const proofRoot = "/private/tmp/chess-p3-10-saved-retry-route-availability-proof";
const csp = betaCsp;
const storeKey = "chess.trainer.reviewStore.v1";
const samplePgn = "1. f3 e5 2. g4 Qh4# 0-1";
const viewports = [
  { width: 1280, height: 900, label: "desktop" },
  { width: 390, height: 844, label: "narrow" }
];
const bannedRouteWords = [
  "weakness",
  "weak spot",
  "skill gap",
  "tendency",
  "habit",
  "you miss",
  "tactic",
  "motif",
  "opening",
  "material",
  "conversion",
  "confidence",
  "likely",
  "statistically significant",
  "priority",
  "ranking",
  "recommend",
  "you should practice",
  "schedule",
  "due",
  "progress",
  "no issue",
  "cleared",
  "absent",
  "safe",
  "not a problem"
];

function prepareProofOutput() {
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(join(proofRoot, "dist/pkg"), { recursive: true });
  run("node", ["scripts/audit-policy.mjs"]);
  run("pnpm", ["--filter", "web", "run", "build"]);
  assertWasmBindgenCliVersion(proofLabel);
  run("cargo", [
    "build",
    "-p",
    "chess-wasm-bridge",
    "--target",
    "wasm32-unknown-unknown",
    "--release"
  ]);
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
    missingMessage: "P3.10 product HTML is missing",
    scanBeforeChecks: true,
    cspCheck: "meta",
    cspMismatchMessage: (metaCsp) => `P3.10 product HTML CSP mismatch: ${metaCsp}`,
    requiredIncludes: [
      { text: 'id="chess-review-app"', message: "P3.10 product root is missing" },
      { text: 'href="./review.css"', message: "P3.10 product stylesheet href is missing" },
      { text: 'src="./dist/app.js"', message: "P3.10 product entrypoint script is missing" }
    ]
  });
  copyProductCss(proofRoot, { missingMessage: "P3.10 product stylesheet is missing" });
  scanStaticOutput(proofRoot, {
    extraForbiddenTokens: ["<script type=\"importmap\"", "ServiceWorker", "Worker("]
  });
}

function isServedFile(path) {
  return [".html", ".css", ".js", ".mjs"].includes(extname(path));
}

async function startStaticServer() {
  const files = new Map(
    walk(proofRoot)
      .filter(isServedFile)
      .map((file) => [
        `/${relative(proofRoot, file).split("/").map(encodeURIComponent).join("/")}`,
        file
      ])
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
      const tabs = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) =>
        response.json()
      );
      webSocketUrl = tabs.find((tab) => tab.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch {
      await delay(100);
    }
  }
  if (webSocketUrl === "") {
    throw new Error("CDP endpoint was not available");
  }
  const websocket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  websocket.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    const command = pending.get(message.id);
    if (command === undefined) {
      return;
    }
    pending.delete(message.id);
    message.error === undefined
      ? command.resolve(message.result ?? {})
      : command.reject(new Error(message.error.message));
  });
  await new Promise((resolve, reject) => {
    websocket.addEventListener("open", resolve, { once: true });
    websocket.addEventListener("error", () => reject(new Error("Could not open CDP WebSocket")), {
      once: true
    });
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
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
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
    if (await evaluate(cdp, expression)) {
      return;
    }
    await delay(250);
  }
  throw new Error(label);
}

async function typeTextWithCdp(cdp, selector, text) {
  const reset = await evaluateJson(cdp, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return JSON.stringify({ ok: false, reason: "missing-input" });
    input.focus();
    input.value = "";
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: null, inputType: "deleteContentBackward" }));
    return JSON.stringify({ ok: true });
  })()`);
  if (reset.ok !== true) return reset;
  await waitFor(
    cdp,
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      return input instanceof HTMLInputElement && document.activeElement === input &&
        input.selectionStart === 0 && input.selectionEnd === 0;
    })()`,
    `clearing ${selector} did not restore focus`
  );

  let typed = "";
  for (const char of text) {
    typed += char;
    await cdp.send("Input.insertText", { text: char });
    await waitFor(
      cdp,
      `(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        return input instanceof HTMLInputElement && input.value === ${JSON.stringify(typed)} &&
          document.activeElement === input && input.selectionStart === ${String(typed.length)} &&
          input.selectionEnd === ${String(typed.length)};
      })()`,
      `typing ${typed} did not preserve focus for ${selector}`
    );
    const check = await evaluateJson(cdp, `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!(input instanceof HTMLInputElement)) return JSON.stringify({ ok: false, reason: "missing-input", typed: ${JSON.stringify(typed)} });
      return JSON.stringify({
        ok: input.value === ${JSON.stringify(typed)} && document.activeElement === input &&
          input.selectionStart === ${String(typed.length)} && input.selectionEnd === ${String(typed.length)},
        typed: ${JSON.stringify(typed)},
        value: input.value,
        activeRestored: document.activeElement === input,
        caretRestored: input.selectionStart === ${String(typed.length)} && input.selectionEnd === ${String(typed.length)}
      });
    })()`);
    if (check.ok !== true) return check;
  }
  return { ok: true, typed: text, activeRestored: true, caretRestored: true };
}

async function mountCleanPage(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await waitFor(
    cdp,
    "document.querySelector('[data-review-ui=\"pgn-input\"]') !== null",
    "app did not mount"
  );
  await waitFor(
    cdp,
    "Array.from(document.styleSheets).some((sheet) => sheet.href?.endsWith('/review.css'))",
    "product stylesheet did not load"
  );
  await evaluate(cdp, `localStorage.removeItem(${JSON.stringify(storeKey)}); true;`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(
    cdp,
    "document.querySelector('[data-review-ui=\"pgn-input\"]') !== null",
    "app did not remount"
  );
}

function sampleReviewExpression() {
  return `(() => {
    const input = document.querySelector('[data-review-ui="pgn-input"]');
    const depth = document.querySelector('[data-review-ui="depth-control"]');
    if (!(input instanceof HTMLTextAreaElement) || !(depth instanceof HTMLSelectElement)) return false;
    input.value = ${JSON.stringify(samplePgn)};
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "0-1", inputType: "insertText" }));
    depth.value = "3";
    depth.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector('[data-review-ui="review-button"]')?.click();
    return true;
  })()`;
}

function contentExpression() {
  return `(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const hidden = (selector) => {
      const element = document.querySelector(selector);
      return element === null || element.hasAttribute("hidden");
    };
    return JSON.stringify({
      status: text('[data-review-ui="status"]'),
      summaryTotal: text('[data-review-ui="summary-total-moves"]'),
      routeTitle: text('[data-review-ui="saved-retry-route"] h2'),
      savedReviews: text('[data-review-ui="saved-retry-route-saved-reviews"]'),
      reviewedMoves: text('[data-review-ui="saved-retry-route-reviewed-moves"]'),
      artifactBacked: text('[data-review-ui="saved-retry-route-artifact-backed-reviews"]'),
      artifactMissing: text('[data-review-ui="saved-retry-route-artifact-missing-reviews"]'),
      savedRetryPositions: text('[data-review-ui="saved-retry-route-saved-retry-positions"]'),
      routeButton: text('[data-review-ui="open-saved-retry-route-button"]'),
      routeHidden: hidden('[data-review-ui="saved-retry-route"]'),
      routeText: text('[data-review-ui="saved-retry-route"]')
    });
  })()`;
}

function routeOpenExpression() {
  return `(() => {
    document.querySelector('[data-review-ui="open-saved-retry-route-button"]')?.click();
    return JSON.stringify({
      savedAt: document.querySelector('[data-review-ui="saved-review-detail-saved-at"]')?.textContent?.trim() ?? "",
      practiceIndex: document.querySelector('[data-review-ui="saved-review-detail-practice-index"]')?.textContent?.trim() ?? "",
      practiceFen: document.querySelector('[data-review-ui="saved-review-detail-practice-fen"]')?.textContent?.trim() ?? "",
      practiceInput: document.querySelector('[data-review-ui="saved-review-detail-practice-input"]') !== null
    });
  })()`;
}

function clearExpression() {
  return `(() => {
    document.querySelector('[data-review-ui="clear-button"]')?.click();
    document.querySelector('[data-review-ui="confirm-clear-button"]')?.click();
    return true;
  })()`;
}

function corruptStoreSaveExpression() {
  return `(() => {
    localStorage.setItem(${JSON.stringify(storeKey)}, "{");
    document.querySelector('[data-review-ui="save-button"]')?.click();
    return true;
  })()`;
}

function recoverExpression() {
  return `(() => {
    document.querySelector('[data-review-ui="recover-store-button"]')?.click();
    document.querySelector('[data-review-ui="confirm-recover-store-button"]')?.click();
    return true;
  })()`;
}

function layoutExpression(expectedViewport) {
  const visibleSelectors = [
    '[data-review-ui="product-header"]',
    '[data-review-ui="review-form"]',
    '[data-review-ui="summary"]',
    '[data-review-ui="move-list"]',
    '[data-review-ui="coach-artifacts"]',
    '[data-review-ui="profile"]',
    '[data-review-ui="saved-retry-route"]',
    '[data-review-ui="open-saved-retry-route-button"]',
    '[data-review-ui="stored-review-list"]',
    '[data-review-ui="stored-review-row"]',
    '[data-review-ui="saved-review-detail"]',
    '[data-review-ui="saved-review-detail-practice"]'
  ];
  return `(() => {
    const visibleSelectors = ${JSON.stringify(visibleSelectors)};
    const issues = [];
    for (const selector of visibleSelectors) {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        issues.push({ kind: "missing", selector });
        continue;
      }
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || style.display === "none" ||
        style.visibility === "hidden" || Number(style.opacity) === 0) {
        issues.push({ kind: "hidden-or-zero", selector, rect: { width: rect.width, height: rect.height } });
      }
    }
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (pageWidth > window.innerWidth + 1) {
      issues.push({ kind: "page-horizontal-overflow", pageWidth, viewportWidth: window.innerWidth });
    }
    return JSON.stringify({
      expectedViewport: ${JSON.stringify(expectedViewport)},
      actualViewport: { width: window.innerWidth, height: window.innerHeight },
      issues
    });
  })()`;
}

function assertNoBannedRouteWords(text, label) {
  const normalized = text.toLowerCase();
  const matched = bannedRouteWords.filter((word) => {
    if (word === "due" || word === "safe") {
      return new RegExp(`\\b${word}\\b`, "u").test(normalized);
    }
    return normalized.includes(word);
  });
  if (matched.length > 0) {
    throw new Error(`${label} route wording used banned words: ${matched.join(", ")}`);
  }
}

async function runAndSaveReview(cdp, viewportLabel) {
  await runReviewOnly(cdp, viewportLabel);
  await evaluate(cdp, "document.querySelector('[data-review-ui=\"save-button\"]')?.click(); true;");
  await waitFor(
    cdp,
    "document.querySelector('[data-review-ui=\"open-saved-retry-route-button\"]') !== null",
    `${viewportLabel} saved retry route did not become available`
  );
}

async function runReviewOnly(cdp, viewportLabel) {
  if ((await evaluate(cdp, sampleReviewExpression())) !== true) {
    throw new Error(`P3.10 ${viewportLabel} sample review input failed`);
  }
  await waitFor(
    cdp,
    "document.querySelector('[data-review-ui=\"summary-total-moves\"]')?.textContent === 'Total moves4'",
    `${viewportLabel} review did not complete`
  );
  await waitFor(
    cdp,
    "document.querySelector('[data-review-ui=\"retry-position-row\"]') !== null",
    `${viewportLabel} retry positions did not render`
  );
}

async function assertRouteAvailable(cdp, viewportLabel) {
  const content = await evaluateJson(cdp, contentExpression());
  if (
    content.status !== "Review complete" ||
    content.summaryTotal !== "Total moves4" ||
    content.routeTitle !== "Local saved retry positions" ||
    content.savedReviews !== "Saved reviews1 saved review" ||
    content.reviewedMoves !== "Reviewed moves4 reviewed moves" ||
    content.artifactBacked !== "Artifact-backed reviews1 of 1 saved review" ||
    content.artifactMissing !== "Artifact-missing reviews0 of 1 saved review" ||
    content.savedRetryPositions !== "Saved retry positions1 from 1 artifact-backed review" ||
    content.routeButton !== "Open saved retry position" ||
    content.routeHidden !== false
  ) {
    throw new Error(`P3.10 ${viewportLabel} route content failed: ${JSON.stringify(content)}`);
  }
  assertNoBannedRouteWords(content.routeText, `P3.10 ${viewportLabel}`);
}

async function runViewportProof(cdp, url, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await mountCleanPage(cdp, url);
  await runAndSaveReview(cdp, viewport.label);
  await assertRouteAvailable(cdp, viewport.label);

  const opened = await evaluateJson(cdp, routeOpenExpression());
  if (
    !opened.savedAt.startsWith("Saved at") ||
    opened.practiceIndex !== "Position 1 of 1" ||
    !opened.practiceFen.startsWith("FEN before") ||
    opened.practiceInput !== true
  ) {
    throw new Error(`P3.10 ${viewport.label} route open failed: ${JSON.stringify(opened)}`);
  }
  const typeCheck = await typeTextWithCdp(
    cdp,
    '[data-review-ui="saved-review-detail-practice-input"]',
    "a2a3"
  );
  if (
    typeCheck.ok !== true ||
    typeCheck.activeRestored !== true ||
    typeCheck.caretRestored !== true
  ) {
    throw new Error(`P3.10 ${viewport.label} saved retry route typing failed: ${JSON.stringify(typeCheck)}`);
  }

  const layout = await evaluateJson(cdp, layoutExpression(viewport));
  if (
    layout.actualViewport.width !== viewport.width ||
    layout.actualViewport.height !== viewport.height ||
    layout.issues.length > 0
  ) {
    throw new Error(`P3.10 ${viewport.label} layout proof failed: ${JSON.stringify(layout)}`);
  }

  await evaluate(cdp, clearExpression());
  await waitFor(
    cdp,
    "document.querySelector('[data-review-ui=\"saved-retry-route-saved-retry-positions\"]')?.textContent === 'Saved retry positions0 from 0 artifact-backed reviews'",
    `${viewport.label} clear did not reset route count`
  );
  if ((await evaluate(cdp, "document.querySelector('[data-review-ui=\"open-saved-retry-route-button\"]') === null")) !== true) {
    throw new Error(`P3.10 ${viewport.label} route button survived clear`);
  }

  await evaluate(cdp, "document.querySelector('[data-review-ui=\"save-button\"]')?.click(); true;");
  await waitFor(
    cdp,
    "document.querySelector('[data-review-ui=\"open-saved-retry-route-button\"]') !== null",
    `${viewport.label} route did not return after resave`
  );
  await runReviewOnly(cdp, viewport.label);
  await evaluate(cdp, corruptStoreSaveExpression());
  await waitFor(
    cdp,
    "document.querySelector('[data-review-ui=\"error\"]')?.textContent.includes('Stored reviews could not be read')",
    `${viewport.label} corrupt store save did not show a store error`
  );
  if ((await evaluate(cdp, "document.querySelector('[data-review-ui=\"saved-retry-route\"]')?.hasAttribute('hidden')")) !== true) {
    throw new Error(`P3.10 ${viewport.label} stale route remained visible during store error`);
  }
  await evaluate(cdp, recoverExpression());
  await waitFor(
    cdp,
    "document.querySelector('[data-review-ui=\"saved-retry-route-saved-retry-positions\"]')?.textContent === 'Saved retry positions0 from 0 artifact-backed reviews'",
    `${viewport.label} recovery did not reset route availability`
  );
}

async function runBrowserProof(url, debugPort) {
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${join(proofRoot, "chrome-profile")}`,
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let cdp;
  try {
    cdp = await connectCdp(debugPort);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    for (const viewport of viewports) {
      await runViewportProof(cdp, url, viewport);
    }
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
if (!requests.includes("/review.css")) {
  throw new Error(`P3.10 proof did not request review.css: ${requests.join(", ")}`);
}
if (
  !servedResponses.some(
    (response) =>
      response.pathname === "/review.css" && response.contentType === "text/css; charset=utf-8"
  )
) {
  throw new Error(`P3.10 proof did not serve review.css as text/css: ${JSON.stringify(servedResponses)}`);
}
if (requests.some((request) => request.endsWith(".wasm"))) {
  throw new Error(`P3.10 proof requested a .wasm asset: ${requests.join(", ")}`);
}
console.log("P3.10 saved retry route availability browser proof passed.");
