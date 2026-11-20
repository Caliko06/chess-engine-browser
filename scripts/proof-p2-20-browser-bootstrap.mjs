import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, relative } from "node:path";
import {
  assertWasmBindgenCliVersion,
  betaCsp,
  contentType,
  copyBuiltWeb,
  copyProductCss,
  copyProductHtml,
  repoRoot,
  run,
  scanStaticOutput,
  walk,
  writeEmbeddedWasmModule
} from "./beta-preview-support.mjs";

const proofRoot = "/private/tmp/chess-p2-20-browser-bootstrap-proof";
const csp = betaCsp;
const storeKey = "chess.trainer.reviewStore.v1";

function assertBrowserRuntimeImports(root) {
  const pattern =
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gu;
  const violations = [];
  for (const file of walk(root).filter((path) => path.endsWith(".js") || path.endsWith(".mjs"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] ?? match[2] ?? "";
      if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        !specifier.endsWith(".js") &&
        !specifier.endsWith(".mjs")
      ) {
        violations.push(`${relative(repoRoot, file)} imports ${specifier} without a browser extension`);
      }
    }
  }
  if (violations.length > 0) throw new Error(`Browser ESM import proof failed:\n${violations.join("\n")}`);
}

async function startStaticServer() {
  const files = new Map(
    walk(proofRoot).map((file) => [`/${relative(proofRoot, file).split("/").map(encodeURIComponent).join("/")}`, file])
  );
  const requests = [];
  const servedResponses = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(pathname);
    const path = pathname === "/" ? files.get("/index.html") : files.get(pathname);
    response.setHeader("Content-Security-Policy", csp);
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (path === undefined || !statSync(path).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    const type = contentType(path);
    servedResponses.push({ pathname, contentType: type });
    response.writeHead(200, { "Content-Type": type });
    response.end(readFileSync(path));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, requests, servedResponses, port: server.address().port };
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
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(description);
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await delay(250);
  }
  throw new Error(label);
}

async function runBrowserProof(url, debugPort) {
  const chrome = spawn(chromePath(), [
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
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let cdp;
  try {
    cdp = await connectCdp(debugPort);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url });
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"pgn-input\"]') !== null", "app did not mount");
    await waitFor(cdp, "Array.from(document.styleSheets).some((sheet) => sheet.href?.endsWith('/review.css'))", "product stylesheet did not load");
    const productHeaderProof = await evaluate(cdp, `(() => {
      const title = document.querySelector('[data-review-ui="product-title"]');
      const badge = document.querySelector('[data-review-ui="release-badge"]');
      const scope = document.querySelector('[data-review-ui="release-scope"]');
      return JSON.stringify({
        documentTitle: document.title,
        productTitle: title?.textContent,
        releaseBadge: badge?.textContent,
        releaseScope: scope?.textContent,
        productTitleWidth: title instanceof HTMLElement ? title.getBoundingClientRect().width : 0,
        releaseBadgeWidth: badge instanceof HTMLElement ? badge.getBoundingClientRect().width : 0,
        releaseScopeWidth: scope instanceof HTMLElement ? scope.getBoundingClientRect().width : 0
      });
    })()`);
    const parsedProductHeaderProof = JSON.parse(productHeaderProof);
    if (
      parsedProductHeaderProof.documentTitle !== "Local Chess Trainer" ||
      parsedProductHeaderProof.productTitle !== "Local Chess Trainer" ||
      parsedProductHeaderProof.releaseBadge !== "Beta 0.2 Active Trainer" ||
      parsedProductHeaderProof.releaseScope !== "Local review and retry practice" ||
      parsedProductHeaderProof.productTitleWidth <= 0 ||
      parsedProductHeaderProof.releaseBadgeWidth <= 0 ||
      parsedProductHeaderProof.releaseScopeWidth <= 0
    ) {
      throw new Error(`Beta 0.2 product header proof failed: ${productHeaderProof}`);
    }
    const initialStatusErrorProof = await evaluate(cdp, `(() => {
      const status = document.querySelector('[data-review-ui="status"]');
      const error = document.querySelector('[data-review-ui="error"]');
      const errorRect = error?.getBoundingClientRect();
      return JSON.stringify({
        statusText: status?.textContent,
        statusAriaLive: status?.getAttribute("aria-live"),
        statusHidden: status?.hasAttribute("hidden"),
        statusWidth: status instanceof HTMLElement ? status.getBoundingClientRect().width : 0,
        statusHeight: status instanceof HTMLElement ? status.getBoundingClientRect().height : 0,
        errorExists: error !== null,
        errorText: error?.textContent,
        errorHidden: error?.hasAttribute("hidden"),
        errorAriaHidden: error?.getAttribute("aria-hidden"),
        errorRole: error?.getAttribute("role"),
        errorAriaLive: error?.getAttribute("aria-live"),
        errorDisplay: error instanceof HTMLElement ? getComputedStyle(error).display : "",
        errorWidth: errorRect?.width ?? 0,
        errorHeight: errorRect?.height ?? 0
      });
    })()`);
    if (
      initialStatusErrorProof !==
      JSON.stringify({
        statusText: "Ready",
        statusAriaLive: "polite",
        statusHidden: false,
        statusWidth: 0,
        statusHeight: 0,
        errorExists: true,
        errorText: "",
        errorHidden: true,
        errorAriaHidden: "true",
        errorRole: null,
        errorAriaLive: null,
        errorDisplay: "none",
        errorWidth: 0,
        errorHeight: 0
      })
    ) {
      const parsed = JSON.parse(initialStatusErrorProof);
      if (parsed.statusWidth <= 0 || parsed.statusHeight <= 0) {
        throw new Error(`P2.33 initial status layout proof failed: ${initialStatusErrorProof}`);
      }
      parsed.statusWidth = 0;
      parsed.statusHeight = 0;
      if (JSON.stringify(parsed) !== JSON.stringify({
        statusText: "Ready",
        statusAriaLive: "polite",
        statusHidden: false,
        statusWidth: 0,
        statusHeight: 0,
        errorExists: true,
        errorText: "",
        errorHidden: true,
        errorAriaHidden: "true",
        errorRole: null,
        errorAriaLive: null,
        errorDisplay: "none",
        errorWidth: 0,
        errorHeight: 0
      })) {
        throw new Error(`P2.33 initial status/error proof failed: ${initialStatusErrorProof}`);
      }
    }
    const initialEmptyStateProof = await evaluate(cdp, `(() => {
      const moveList = document.querySelector('[data-review-ui="move-list"]');
      const artifacts = document.querySelector('[data-review-ui="coach-artifacts"]');
      return JSON.stringify({
        moveNoReview: document.querySelector('[data-review-ui="move-list-no-current-review"]')?.textContent,
        artifactsNoReview: document.querySelector('[data-review-ui="coach-artifacts-no-current-review"]')?.textContent,
        hasPostReviewMoveEmpty: moveList?.textContent.includes("No moves reviewed") === true,
        hasPostReviewArtifactEmpty: ["No key moments", "No evidence", "No early divergences", "No retry positions"].some((text) =>
          artifacts?.textContent.includes(text)
        )
      });
    })()`);
    if (
      initialEmptyStateProof !==
      JSON.stringify({
        moveNoReview: "No review yet",
        artifactsNoReview: "No review yet",
        hasPostReviewMoveEmpty: false,
        hasPostReviewArtifactEmpty: false
      })
    ) {
      throw new Error(`P2.32 initial empty-state proof failed: ${initialEmptyStateProof}`);
    }
    const styleProof = await evaluate(cdp, `(() => {
      const button = document.querySelector('[data-review-ui="review-button"]');
      const input = document.querySelector('[data-review-ui="pgn-input"]');
      const disabled = document.querySelector('[data-review-ui="save-button"]');
      if (!(button instanceof HTMLElement) || !(input instanceof HTMLElement) || !(disabled instanceof HTMLElement)) {
        return JSON.stringify({ ok: false, reason: "missing-control" });
      }
      button.focus();
      const buttonStyle = getComputedStyle(button);
      const inputStyle = getComputedStyle(input);
      const disabledStyle = getComputedStyle(disabled);
      const contrastRatio = (foreground, background) => {
        const channel = (value) => {
          const normalized = value / 255;
          return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        };
        const parse = (color) => color.match(/\\d+(?:\\.\\d+)?/gu).slice(0, 3).map(Number);
        const luminance = (color) => {
          const [red, green, blue] = parse(color);
          return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
        };
        const lighter = Math.max(luminance(foreground), luminance(background));
        const darker = Math.min(luminance(foreground), luminance(background));
        return (lighter + 0.05) / (darker + 0.05);
      };
      const hasFocusRule = Array.from(document.styleSheets).some((sheet) =>
        Array.from(sheet.cssRules).some((rule) =>
          "selectorText" in rule &&
          rule.selectorText.includes("button:focus") &&
          rule.cssText.includes("outline:")
        )
      );
      return JSON.stringify({
        ok: true,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        buttonRadius: buttonStyle.borderRadius,
        hasFocusRule,
        inputBackground: inputStyle.backgroundColor,
        bodyContrast: contrastRatio(getComputedStyle(document.body).color, getComputedStyle(document.body).backgroundColor),
        buttonContrast: contrastRatio(buttonStyle.color, buttonStyle.backgroundColor),
        disabledCursor: disabledStyle.cursor,
        disabledOpacity: disabledStyle.opacity
      });
    })()`);
    const parsedStyleProof = JSON.parse(styleProof);
    if (
      parsedStyleProof.ok !== true ||
      parsedStyleProof.bodyBackground === "rgba(0, 0, 0, 0)" ||
      parsedStyleProof.buttonRadius === "0px" ||
      parsedStyleProof.hasFocusRule !== true ||
      parsedStyleProof.bodyContrast < 4.5 ||
      parsedStyleProof.buttonContrast < 4.5 ||
      parsedStyleProof.disabledCursor !== "not-allowed" ||
      Number.parseFloat(parsedStyleProof.disabledOpacity) >= 1
    ) {
      throw new Error(`P2.22 stylesheet computed-style proof failed: ${styleProof}`);
    }
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"pgn-label\"]')?.textContent === 'PGN'", "PGN label did not render");
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"depth-label\"]')?.textContent === 'Review depth'", "depth label did not render");
    await evaluate(cdp, `(() => {
      const input = document.querySelector('[data-review-ui="pgn-input"]');
      input.value = "1. e4 {comment} *";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "}", inputType: "insertText" }));
      document.querySelector('[data-review-ui="review-button"]').click();
      return true;
    })()`);
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"error\"]')?.textContent.includes('Invalid PGN')", "invalid PGN did not surface through UI");
    const invalidPgnStatusProof = await evaluate(cdp, `(() => {
      const status = document.querySelector('[data-review-ui="status"]');
      const error = document.querySelector('[data-review-ui="error"]');
      return JSON.stringify({
        status: status?.textContent,
        statusAriaLive: status?.getAttribute("aria-live"),
        error: error?.textContent,
        errorHidden: error?.hasAttribute("hidden"),
        errorAriaHidden: error?.getAttribute("aria-hidden"),
        errorRole: error?.getAttribute("role"),
        errorAriaLive: error?.getAttribute("aria-live"),
        errorDisplay: error instanceof HTMLElement ? getComputedStyle(error).display : ""
      });
    })()`);
    if (
      invalidPgnStatusProof !==
      JSON.stringify({
        status: "Needs attention",
        statusAriaLive: "polite",
        error: "Invalid PGN",
        errorHidden: false,
        errorAriaHidden: null,
        errorRole: "alert",
        errorAriaLive: "assertive",
        errorDisplay: "block"
      })
    ) {
      throw new Error(`P2.33 invalid PGN status/error proof failed: ${invalidPgnStatusProof}`);
    }
    await evaluate(cdp, `(() => {
      const input = document.querySelector('[data-review-ui="pgn-input"]');
      input.value = "*";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "*", inputType: "insertText" }));
      document.querySelector('[data-review-ui="review-button"]').click();
      return true;
    })()`);
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"summary-total-moves\"]')?.textContent === 'Total moves0'", "empty PGN review did not complete");
    const reviewedSuccessStatusProof = await evaluate(cdp, `(() => {
      const status = document.querySelector('[data-review-ui="status"]');
      const error = document.querySelector('[data-review-ui="error"]');
      return JSON.stringify({
        status: status?.textContent,
        statusAriaLive: status?.getAttribute("aria-live"),
        errorText: error?.textContent,
        errorHidden: error?.hasAttribute("hidden"),
        errorAriaHidden: error?.getAttribute("aria-hidden"),
        errorRole: error?.getAttribute("role"),
        errorAriaLive: error?.getAttribute("aria-live"),
        errorDisplay: error instanceof HTMLElement ? getComputedStyle(error).display : ""
      });
    })()`);
    if (
      reviewedSuccessStatusProof !==
      JSON.stringify({
        status: "Review complete",
        statusAriaLive: "polite",
        errorText: "",
        errorHidden: true,
        errorAriaHidden: "true",
        errorRole: null,
        errorAriaLive: null,
        errorDisplay: "none"
      })
    ) {
      throw new Error(`P2.33 reviewed success status/error proof failed: ${reviewedSuccessStatusProof}`);
    }
    const reviewedEmptyStateProof = await evaluate(cdp, `(() => JSON.stringify({
      totalMoves: document.querySelector('[data-review-ui="summary-total-moves"]')?.textContent,
      moveEmpty: document.querySelector('[data-review-ui="move-list-empty"]')?.textContent,
      keyMomentEmpty: document.querySelector('[data-review-ui="key-moment-empty"]')?.textContent,
      evidenceEmpty: document.querySelector('[data-review-ui="evidence-empty"]')?.textContent,
      earlyEmpty: document.querySelector('[data-review-ui="early-divergence-empty"]')?.textContent,
      retryEmpty: document.querySelector('[data-review-ui="retry-position-empty"]')?.textContent,
      hasNoCurrentReviewArtifactState: document.querySelector('[data-review-ui="coach-artifacts-no-current-review"]') !== null
    }))()`);
    if (
      reviewedEmptyStateProof !==
      JSON.stringify({
        totalMoves: "Total moves0",
        moveEmpty: "No moves reviewed",
        keyMomentEmpty: "No key moments",
        evidenceEmpty: "No evidence",
        earlyEmpty: "No early divergences",
        retryEmpty: "No retry positions",
        hasNoCurrentReviewArtifactState: false
      })
    ) {
      throw new Error(`P2.32 reviewed-empty proof failed: ${reviewedEmptyStateProof}`);
    }
    const invalidDepth = await evaluate(cdp, `(async () => {
      const [{ createReviewWasmExecutor }, reviewModule] = await Promise.all([
        import("./dist/review-wasm-executor.js"),
        import("./dist/pkg/chess_wasm_bridge_embedded.mjs")
      ]);
      const reviewPgn = createReviewWasmExecutor(() => Promise.resolve(reviewModule));
      const result = await reviewPgn({ pgn: "1. e4 *", depth: 1 });
      return JSON.stringify(result);
    })()`);
    if (invalidDepth !== JSON.stringify({ ok: false, error: "invalid-depth" })) {
      throw new Error(`invalid depth did not surface through wasm graph: ${invalidDepth}`);
    }
    const pendingReviewProof = await evaluate(cdp, `(() => {
      const input = document.querySelector('[data-review-ui="pgn-input"]');
      input.value = "1. f3 e5 2. g4 Qh4# 0-1";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "0-1", inputType: "insertText" }));
      const depth = document.querySelector('[data-review-ui="depth-control"]');
      depth.value = "3";
      depth.dispatchEvent(new Event("change", { bubbles: true }));
      document.querySelector('[data-review-ui="review-button"]').click();
      const lockedInput = document.querySelector('[data-review-ui="pgn-input"]');
      const lockedDepth = document.querySelector('[data-review-ui="depth-control"]');
      const reviewButton = document.querySelector('[data-review-ui="review-button"]');
      const saveButton = document.querySelector('[data-review-ui="save-button"]');
      const locked = {
        status: document.querySelector('[data-review-ui="status"]')?.textContent,
        statusAriaLive: document.querySelector('[data-review-ui="status"]')?.getAttribute("aria-live"),
        pgnDisabled: lockedInput.disabled,
        depthDisabled: lockedDepth.disabled,
        reviewDisabled: reviewButton.disabled,
        saveDisabled: saveButton.disabled,
        pgnValue: lockedInput.value,
        depthValue: lockedDepth.value
      };
      lockedInput.value = "1. e4 *";
      lockedInput.dispatchEvent(new InputEvent("input", { bubbles: true, data: "*", inputType: "insertText" }));
      lockedDepth.value = "6";
      lockedDepth.dispatchEvent(new Event("change", { bubbles: true }));
      return JSON.stringify(locked);
    })()`);
    if (
      pendingReviewProof !==
      JSON.stringify({
        status: "Reviewing",
        statusAriaLive: "polite",
        pgnDisabled: true,
        depthDisabled: true,
        reviewDisabled: true,
        saveDisabled: true,
        pgnValue: "1. f3 e5 2. g4 Qh4# 0-1",
        depthValue: "3"
      })
    ) {
      throw new Error(`P2.25 pending review lock proof failed: ${pendingReviewProof}`);
    }
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"summary-total-moves\"]')?.textContent === 'Total moves4'", "review did not complete");
    const requestCoherenceProof = await evaluate(cdp, `(() => {
      const input = document.querySelector('[data-review-ui="pgn-input"]');
      const depth = document.querySelector('[data-review-ui="depth-control"]');
      const save = document.querySelector('[data-review-ui="save-button"]');
      return JSON.stringify({
        pgnValue: input.value,
        depthValue: depth.value,
        pgnDisabled: input.disabled,
        depthDisabled: depth.disabled,
        saveDisabled: save.disabled,
        totalMoves: document.querySelector('[data-review-ui="summary-total-moves"]')?.textContent
      });
    })()`);
    if (
      requestCoherenceProof !==
      JSON.stringify({
        pgnValue: "1. f3 e5 2. g4 Qh4# 0-1",
        depthValue: "3",
        pgnDisabled: false,
        depthDisabled: false,
        saveDisabled: false,
        totalMoves: "Total moves4"
      })
    ) {
      throw new Error(`P2.25 request coherence proof failed: ${requestCoherenceProof}`);
    }
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"key-moment-row\"]') !== null", "key moment artifact did not render");
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"retry-position-row\"]') !== null", "retry position artifact did not render");
    const artifactStyleProof = await evaluate(cdp, `(() => {
      const container = document.querySelector('[data-review-ui="coach-artifacts"]');
      const keyMoment = document.querySelector('[data-review-ui="key-moment-row"]');
      const evidence = document.querySelector('[data-review-ui="evidence-row"]');
      const retryFen = document.querySelector('[data-review-ui="retry-position-fen"] dd');
      if (
        !(container instanceof HTMLElement) ||
        !(keyMoment instanceof HTMLElement) ||
        !(evidence instanceof HTMLElement) ||
        !(retryFen instanceof HTMLElement)
      ) {
        return JSON.stringify({ ok: false, reason: "missing-artifact-element" });
      }
      const containerStyle = getComputedStyle(container);
      const keyMomentStyle = getComputedStyle(keyMoment);
      const evidenceStyle = getComputedStyle(evidence);
      const retryFenStyle = getComputedStyle(retryFen);
      return JSON.stringify({
        ok: true,
        containerBackground: containerStyle.backgroundColor,
        containerBorderWidth: containerStyle.borderTopWidth,
        keyMomentDisplay: keyMomentStyle.display,
        evidenceBorderWidth: evidenceStyle.borderTopWidth,
        retryFenOverflowWrap: retryFenStyle.overflowWrap,
        retryFenWhiteSpace: retryFenStyle.whiteSpace
      });
    })()`);
    const parsedArtifactStyleProof = JSON.parse(artifactStyleProof);
    if (
      parsedArtifactStyleProof.ok !== true ||
      parsedArtifactStyleProof.containerBackground === "rgba(0, 0, 0, 0)" ||
      parsedArtifactStyleProof.containerBorderWidth === "0px" ||
      parsedArtifactStyleProof.keyMomentDisplay !== "grid" ||
      parsedArtifactStyleProof.evidenceBorderWidth === "0px" ||
      parsedArtifactStyleProof.retryFenOverflowWrap !== "anywhere" ||
      parsedArtifactStyleProof.retryFenWhiteSpace !== "normal"
    ) {
      throw new Error(`P2.24 artifact presentation proof failed: ${artifactStyleProof}`);
    }
    for (const viewport of [
      { width: 1280, height: 900, label: "desktop-artifacts" },
      { width: 390, height: 844, label: "narrow-artifacts" }
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width < 600
      });
      const artifactLayoutProof = await evaluate(cdp, `(() => {
        const selectors = [
          '[data-review-ui="coach-artifacts"]',
          '[data-review-ui="key-moment-row"]',
          '[data-review-ui="evidence-row"]',
          '[data-review-ui="early-divergence-row"]',
          '[data-review-ui="retry-position-row"]',
          '[data-review-ui="retry-position-fen"]'
        ];
        const boxes = selectors.map((selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return { selector, missing: true };
          const rect = element.getBoundingClientRect();
          return {
            selector,
            missing: false,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth
          };
        });
        const broken = boxes.filter((box) =>
          box.missing ||
          box.width <= 0 ||
          box.height <= 0 ||
          box.left < -1 ||
          box.right > window.innerWidth + Math.max(1, box.scrollWidth - box.clientWidth)
        );
        return JSON.stringify({ viewport: ${JSON.stringify(viewport.label)}, broken });
      })()`);
      const parsedArtifactLayoutProof = JSON.parse(artifactLayoutProof);
      if (parsedArtifactLayoutProof.broken.length > 0) {
        throw new Error(`P2.24 ${viewport.label} layout proof failed: ${artifactLayoutProof}`);
      }
    }
    const semanticSurface = await evaluate(cdp, `(() => {
      const root = document.querySelector("#chess-review-app");
      const moveLabel = document.querySelector('[data-review-ui="move-label"][data-review-index="1"]');
      const keyMomentLabel = document.querySelector('[data-review-ui="key-moment-label"][data-review-index="0"]');
      const artifactLabels = [
        document.querySelector('[data-review-ui="evidence-label"][data-review-index="0"]')?.textContent,
        document.querySelector('[data-review-ui="early-divergence-label"][data-review-index="0"]')?.textContent,
        document.querySelector('[data-review-ui="retry-position-label"][data-review-index="0"]')?.textContent
      ];
      const scoreFields = {
        zeroMoveBestScore: document.querySelector('[data-review-ui="move-best-score"][data-review-index="1"]')?.textContent,
        zeroMoveCpLoss: document.querySelector('[data-review-ui="move-cp-loss"][data-review-index="1"]')?.textContent,
        blunderMovePlayedScore: document.querySelector('[data-review-ui="move-played-score"][data-review-index="2"]')?.textContent,
        blunderMoveCpLoss: document.querySelector('[data-review-ui="move-cp-loss"][data-review-index="2"]')?.textContent,
        keyMomentCpLoss: document.querySelector('[data-review-ui="key-moment-cp-loss"][data-review-index="0"]')?.textContent,
        evidenceScore: document.querySelector('[data-review-ui="evidence-score"][data-review-index="0"]')?.textContent,
        evidenceCpLoss: document.querySelector('[data-review-ui="evidence-cp-loss"][data-review-index="0"]')?.textContent,
        earlyDivergenceCpLoss: document.querySelector('[data-review-ui="early-divergence-cp-loss"][data-review-index="0"]')?.textContent,
        retryPositionCpLoss: document.querySelector('[data-review-ui="retry-position-cp-loss"][data-review-index="0"]')?.textContent
      };
      return JSON.stringify({
        hasMoveFields: document.querySelector('[data-review-ui="move-ply"][data-review-index="1"]') !== null &&
          document.querySelector('[data-review-ui="move-san"][data-review-index="1"]') !== null &&
          document.querySelector('[data-review-ui="move-label"][data-review-index="1"]') !== null,
        hasArtifactFields: document.querySelector('[data-review-ui="key-moment-row"]') !== null &&
          document.querySelector('[data-review-ui="evidence-row"]') !== null &&
          document.querySelector('[data-review-ui="evidence-label"][data-review-index="0"]') !== null &&
          document.querySelector('[data-review-ui="early-divergence-row"]') !== null &&
          document.querySelector('[data-review-ui="early-divergence-label"][data-review-index="0"]') !== null &&
          document.querySelector('[data-review-ui="retry-position-row"]') !== null &&
          document.querySelector('[data-review-ui="retry-position-label"][data-review-index="0"]') !== null,
        moveLabelText: moveLabel?.textContent,
        keyMomentLabelText: keyMomentLabel?.textContent,
        artifactLabelTexts: artifactLabels,
        scoreFields,
        rawScoreTokensInScoreFields: Object.values(scoreFields).some((text) =>
          text === "0" ||
          text === "-29999" ||
          text === "29999" ||
          text === "CP loss29999" ||
          text === "Score swing0 to -29999"
        ),
        rawLabelTokensInLabelFields: moveLabel?.textContent === "blunder" ||
          keyMomentLabel?.textContent === "Labelblunder" ||
          artifactLabels.some((text) => text === "blunder" || text === "Labelblunder"),
        hasDenseDebugText: root.textContent.includes("totalMoves=") || root.textContent.includes("ply=")
      });
    })()`);
    if (
      semanticSurface !==
      JSON.stringify({
        hasMoveFields: true,
        hasArtifactFields: true,
        moveLabelText: "Best",
        keyMomentLabelText: "LabelBlunder",
        artifactLabelTexts: ["LabelBlunder", "LabelBlunder", "LabelBlunder"],
        scoreFields: {
          zeroMoveBestScore: "0 cp",
          zeroMoveCpLoss: "0 cp",
          blunderMovePlayedScore: "-29999 cp",
          blunderMoveCpLoss: "29999 cp",
          keyMomentCpLoss: "CP loss29999 cp",
          evidenceScore: "Score swing0 cp to -29999 cp",
          evidenceCpLoss: "CP loss29999 cp",
          earlyDivergenceCpLoss: "CP loss29999 cp",
          retryPositionCpLoss: "CP loss29999 cp"
        },
        rawScoreTokensInScoreFields: false,
        rawLabelTokensInLabelFields: false,
        hasDenseDebugText: false
      })
    ) {
      throw new Error(`semantic review surface did not render cleanly: ${semanticSurface}`);
    }
    const leakedRawPgn = await evaluate(cdp, `
      const root = document.querySelector("#chess-review-app").cloneNode(true);
      for (const textarea of root.querySelectorAll("textarea")) textarea.remove();
      root.textContent.includes("1. f3 e5 2. g4 Qh4# 0-1");
    `);
    if (leakedRawPgn) throw new Error("raw PGN rendered outside textarea");
    await evaluate(cdp, "document.querySelector('[data-review-ui=\"save-button\"]').click(); true;");
    await waitFor(cdp, `JSON.parse(localStorage.getItem("${storeKey}") ?? '{"reviews":[]}').reviews.length === 1`, "save did not persist");
    const savedStateProof = await evaluate(cdp, `(() => {
      const saveButton = document.querySelector('[data-review-ui="save-button"]');
      const saveState = document.querySelector('[data-review-ui="save-state"]');
      const before = JSON.parse(localStorage.getItem("${storeKey}") ?? '{"reviews":[]}').reviews.length;
      saveButton.click();
      const after = JSON.parse(localStorage.getItem("${storeKey}") ?? '{"reviews":[]}').reviews.length;
      return JSON.stringify({
        before,
        after,
        saveDisabled: saveButton.disabled,
        saveState: saveState?.textContent ?? "",
        profileCpLossTotal: document.querySelector('[data-review-ui="profile-cp-loss-total"]')?.textContent,
        profileBucketCpLossTotal: document.querySelector('[data-review-ui="profile-bucket-cp-loss-total"][data-review-index="0"]')?.textContent,
        saveStateLeaksUuid: /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu.test(saveState?.textContent ?? "")
      });
    })()`);
    if (
      savedStateProof !==
      JSON.stringify({
        before: 1,
        after: 1,
        saveDisabled: true,
        saveState: "Current review saved",
        profileCpLossTotal: "CP loss total29999 cp",
        profileBucketCpLossTotal: "CP loss29999 cp",
        saveStateLeaksUuid: false
      })
    ) {
      throw new Error(`P2.26 save-state duplicate-save proof failed: ${savedStateProof}`);
    }
    const persisted = await evaluate(cdp, `localStorage.getItem("${storeKey}")`);
    if (typeof persisted !== "string" || persisted.includes("1. f3")) throw new Error("raw PGN leaked to storage");
    const persistedStore = JSON.parse(persisted);
    if (
      persistedStore.schemaVersion !== 2 ||
      !Array.isArray(persistedStore.reviews?.[0]?.artifacts?.retryPositions) ||
      persistedStore.reviews[0].artifacts.retryPositions.length === 0
    ) {
      throw new Error(`P2.46 saved-review artifact persistence proof failed: ${persisted}`);
    }
    await evaluate(cdp, "document.querySelector('[data-review-ui=\"delete-review-button\"]').click(); true;");
    await waitFor(cdp, `JSON.parse(localStorage.getItem("${storeKey}") ?? '{"reviews":[]}').reviews.length === 0`, "current saved review delete did not update localStorage");
    const deletedCurrentSaveState = await evaluate(cdp, `JSON.stringify({
      saveDisabled: document.querySelector('[data-review-ui="save-button"]')?.disabled,
      saveState: document.querySelector('[data-review-ui="save-state"]')?.textContent,
      totalReviews: document.querySelector('[data-review-ui="profile-total-reviews"]')?.textContent
    })`);
    if (
      deletedCurrentSaveState !==
      JSON.stringify({
        saveDisabled: false,
        saveState: "Unsaved review",
        totalReviews: "Saved reviews0"
      })
    ) {
      throw new Error(`P2.26 delete current saved review proof failed: ${deletedCurrentSaveState}`);
    }
    await evaluate(cdp, "document.querySelector('[data-review-ui=\"save-button\"]').click(); true;");
    await waitFor(cdp, `JSON.parse(localStorage.getItem("${storeKey}") ?? '{"reviews":[]}').reviews.length === 1`, "second save after current delete did not persist");
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"profile-total-reviews\"]')?.textContent === 'Saved reviews1'", "stored review did not survive reload");
    const savedDetailProof = await evaluate(cdp, `(() => {
      document.querySelector('[data-review-ui="view-review-button"]')?.click();
      const detail = document.querySelector('[data-review-ui="saved-review-detail"]');
      const root = document.querySelector("#chess-review-app");
      return JSON.stringify({
        hasDetail: detail?.textContent.includes("Saved at") === true &&
          detail?.textContent.includes("Moves4") === true &&
          document.querySelector('[data-review-ui="saved-review-detail-move-row"]') !== null,
        saveState: document.querySelector('[data-review-ui="save-state"]')?.textContent,
        pgnValue: document.querySelector('[data-review-ui="pgn-input"]')?.value,
        detailLeaksUuid: /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu.test(detail?.textContent ?? ""),
        detailLeaksRawPgn: detail?.textContent.includes("1. f3 e5 2. g4 Qh4# 0-1") === true,
        detailLeaksArtifacts: detail?.textContent.includes("Key moments") === true ||
          detail?.textContent.includes("Retry positions") === true,
        rawPgnOutsideTextarea: (() => {
          const clone = root.cloneNode(true);
          for (const textarea of clone.querySelectorAll("textarea")) textarea.remove();
          return clone.textContent.includes("1. f3 e5 2. g4 Qh4# 0-1");
        })()
      });
    })()`);
    if (
      savedDetailProof !==
      JSON.stringify({
        hasDetail: true,
        saveState: "No review yet",
        pgnValue: "",
        detailLeaksUuid: false,
        detailLeaksRawPgn: false,
        detailLeaksArtifacts: false,
        rawPgnOutsideTextarea: false
      })
    ) {
      throw new Error(`P2.27 saved-review detail proof failed: ${savedDetailProof}`);
    }
    const singleSavedReviewStore = await evaluate(cdp, `localStorage.getItem("${storeKey}")`);
    const savedListAffordanceSetup = await evaluate(cdp, `(() => {
      const stored = JSON.parse(localStorage.getItem("${storeKey}") ?? "{}");
      const baseReview = stored.reviews?.[0]?.review;
      if (baseReview === undefined) return false;
      const withSummary = (review, summary) => ({
        ...review,
        summary: {
          totalMoves: review.summary.totalMoves,
          best: 0,
          good: 0,
          inaccuracies: 0,
          mistakes: 0,
          blunders: 0,
          ...summary
        }
      });
      localStorage.setItem("${storeKey}", JSON.stringify({
        schemaVersion: 1,
        reviews: [
          { id: "old", savedAtIso: "2026-05-15T10:00:00.000Z", source: "review-pgn", review: withSummary(baseReview, { good: 4 }) },
          { id: "new", savedAtIso: "2026-05-15T18:00:00.000Z", source: "review-pgn", review: withSummary(baseReview, { blunders: 4 }) },
          { id: "tie-a", savedAtIso: "2026-05-15T15:00:00.000Z", source: "review-pgn", review: withSummary(baseReview, { mistakes: 4 }) },
          { id: "tie-b", savedAtIso: "2026-05-15T15:00:00.000Z", source: "review-pgn", review: withSummary(baseReview, { inaccuracies: 4 }) }
        ]
      }));
      return true;
    })()`);
    if (savedListAffordanceSetup !== true) {
      throw new Error("P2.29 saved-review list setup failed");
    }
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"profile-total-reviews\"]')?.textContent === 'Saved reviews4'", "P2.29 saved-review list store did not reload");
    const storageAfterSortedRender = await evaluate(cdp, `localStorage.getItem("${storeKey}")`);
    const savedListAffordanceProof = await evaluate(cdp, `(() => {
      const rowsBefore = Array.from(document.querySelectorAll('[data-review-ui="stored-review-row"]')).map((row) => row.textContent);
      document.querySelector('[data-review-ui="view-review-button"][data-review-index="1"]')?.click();
      const storageAfterView = localStorage.getItem("${storeKey}");
      const selected = document.querySelector('[data-review-ui="stored-review-selected"]');
      const detail = document.querySelector('[data-review-ui="saved-review-detail"]');
      const selectedRow = document.querySelector('[data-review-ui="stored-review-row"][data-review-index="1"]');
      const idLeak = ["old", "new", "tie-a", "tie-b"].some((id) => document.querySelector("#chess-review-app")?.textContent.includes(id));
      const labelMap = { best: "Best", good: "Good", inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder" };
      const selectedStoredLabel = JSON.parse(storageAfterView ?? '{"reviews":[]"}').reviews
        .find((review) => review.id === "tie-a")?.review?.entries?.[1]?.label;
      const detailFirstLabel = document.querySelector('[data-review-ui="saved-review-detail-move-label"][data-review-index="1"]')?.textContent;
      const summaryText = (field, index) =>
        document.querySelector(\`[data-review-ui="stored-review-summary-\${field}"][data-review-index="\${index}"]\`)?.textContent;
      const rowSummaries = {
        newestBest: summaryText("best", 0),
        newestBlunders: summaryText("blunders", 0),
        selectedMistakes: summaryText("mistakes", 1),
        tieBInaccuracies: summaryText("inaccuracies", 2),
        oldestGood: summaryText("good", 3)
      };
      document.querySelector('[data-review-ui="delete-review-button"][data-review-index="0"]')?.click();
      const idsAfterDeletingNewest = JSON.parse(localStorage.getItem("${storeKey}") ?? '{"reviews":[]}').reviews.map((review) => review.id);
      return JSON.stringify({
        rowsBefore,
        rowSummaries,
        storageAfterView,
        selectedText: selected?.textContent,
        selectedIndex: selected?.getAttribute("data-review-index"),
        selectedRowMarked: selectedRow?.getAttribute("data-review-selected"),
        detailSavedAt: document.querySelector('[data-review-ui="saved-review-detail-saved-at"]')?.textContent,
        detailFirstPly: document.querySelector('[data-review-ui="saved-review-detail-move-ply"][data-review-index="0"]')?.textContent,
        detailFirstLabelMatchesExpected: detailFirstLabel === labelMap[selectedStoredLabel],
        rawLabelTokenInDetailField: detailFirstLabel === selectedStoredLabel,
        detailLeaksIds: ["old", "new", "tie-a", "tie-b"].some((id) => detail?.textContent.includes(id)),
        idLeak,
        idsAfterDeletingNewest
      });
    })()`);
    if (
      savedListAffordanceProof !==
      JSON.stringify({
        rowsBefore: [
          "Saved at2026-05-15 18:00 UTCMoves4Best0Good0Inaccuracies0Mistakes0Blunders4ViewDelete",
          "Saved at2026-05-15 15:00 UTCMoves4Best0Good0Inaccuracies0Mistakes4Blunders0ViewDelete",
          "Saved at2026-05-15 15:00 UTCMoves4Best0Good0Inaccuracies4Mistakes0Blunders0ViewDelete",
          "Saved at2026-05-15 10:00 UTCMoves4Best0Good4Inaccuracies0Mistakes0Blunders0ViewDelete"
        ],
        rowSummaries: {
          newestBest: "Best0",
          newestBlunders: "Blunders4",
          selectedMistakes: "Mistakes4",
          tieBInaccuracies: "Inaccuracies4",
          oldestGood: "Good4"
        },
        storageAfterView: storageAfterSortedRender,
        selectedText: "Selected",
        selectedIndex: "1",
        selectedRowMarked: "true",
        detailSavedAt: "Saved at2026-05-15 15:00 UTC",
        detailFirstPly: "1",
        detailFirstLabelMatchesExpected: true,
        rawLabelTokenInDetailField: false,
        detailLeaksIds: false,
        idLeak: false,
        idsAfterDeletingNewest: ["old", "tie-a", "tie-b"]
      })
    ) {
      throw new Error(`P2.29 saved-review list affordance proof failed: ${savedListAffordanceProof}`);
    }
    if (typeof storageAfterSortedRender !== "string" || typeof singleSavedReviewStore !== "string") {
      throw new Error("P2.29 saved-review list storage proof failed");
    }
    const invalidTimestampStoreText = await evaluate(cdp, `(() => {
      const stored = JSON.parse(localStorage.getItem("${storeKey}") ?? "{}");
      const baseReview = stored.reviews?.[0]?.review;
      if (baseReview === undefined) return "";
      const invalidStore = {
        schemaVersion: 1,
        reviews: [
          { id: "bad-time", savedAtIso: "not-a-date", source: "review-pgn", review: baseReview }
        ]
      };
      const text = JSON.stringify(invalidStore);
      localStorage.setItem("${storeKey}", text);
      return text;
    })()`);
    if (invalidTimestampStoreText === "") {
      throw new Error("P2.34 invalid timestamp setup failed");
    }
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"profile-total-reviews\"]')?.textContent === 'Saved reviews1'", "P2.34 invalid timestamp store did not reload");
    const invalidTimestampProof = await evaluate(cdp, `(() => {
      const root = document.querySelector("#chess-review-app");
      document.querySelector('[data-review-ui="view-review-button"][data-review-index="0"]')?.click();
      return JSON.stringify({
        rowSavedAt: document.querySelector('[data-review-ui="stored-review-saved-at"][data-review-index="0"]')?.textContent,
        detailSavedAt: document.querySelector('[data-review-ui="saved-review-detail-saved-at"]')?.textContent,
        rawInvalidTimeVisible: root?.textContent.includes("not-a-date") === true,
        status: document.querySelector('[data-review-ui="status"]')?.textContent,
        error: document.querySelector('[data-review-ui="error"]')?.textContent,
        storageAfterView: localStorage.getItem("${storeKey}")
      });
    })()`);
    if (
      invalidTimestampProof !==
      JSON.stringify({
        rowSavedAt: "Saved atSaved time unavailable",
        detailSavedAt: "Saved atSaved time unavailable",
        rawInvalidTimeVisible: false,
        status: "Ready",
        error: "",
        storageAfterView: invalidTimestampStoreText
      })
    ) {
      throw new Error(`P2.34 invalid timestamp presentation proof failed: ${invalidTimestampProof}`);
    }
    await evaluate(cdp, `(() => {
      localStorage.setItem("other-key", "kept");
      localStorage.setItem("${storeKey}", "{");
      return true;
    })()`);
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"error\"]')?.textContent.includes('Stored reviews could not be read')", "corrupt store recovery UI did not render");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    const recoveryPresentationProof = await evaluate(cdp, `(() => {
      const surface = document.querySelector('[data-review-ui="recover-store"]');
      const requestButton = document.querySelector('[data-review-ui="recover-store-button"]');
      if (!(surface instanceof HTMLElement) || !(requestButton instanceof HTMLElement)) {
        return JSON.stringify({ ok: false, reason: "missing-recovery-surface" });
      }
      const surfaceStyle = getComputedStyle(surface);
      const requestStyle = getComputedStyle(requestButton);
      const rect = surface.getBoundingClientRect();
      return JSON.stringify({
        ok: true,
        surfaceDisplay: surfaceStyle.display,
        surfaceGridColumn: surfaceStyle.gridColumnStart,
        surfaceBackground: surfaceStyle.backgroundColor,
        surfaceBorderWidth: surfaceStyle.borderTopWidth,
        surfacePaddingTop: surfaceStyle.paddingTop,
        requestMinHeight: requestStyle.minHeight,
        requestBorderRadius: requestStyle.borderRadius,
        requestCursor: requestStyle.cursor,
        withinViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.width > 0 && rect.height > 0
      });
    })()`);
    const parsedRecoveryPresentationProof = JSON.parse(recoveryPresentationProof);
    if (
      parsedRecoveryPresentationProof.ok !== true ||
      parsedRecoveryPresentationProof.surfaceDisplay !== "grid" ||
      parsedRecoveryPresentationProof.surfaceGridColumn !== "1" ||
      parsedRecoveryPresentationProof.surfaceBackground === "rgba(0, 0, 0, 0)" ||
      parsedRecoveryPresentationProof.surfaceBorderWidth === "0px" ||
      parsedRecoveryPresentationProof.surfacePaddingTop === "0px" ||
      parsedRecoveryPresentationProof.requestMinHeight !== "40px" ||
      parsedRecoveryPresentationProof.requestBorderRadius === "0px" ||
      parsedRecoveryPresentationProof.requestCursor !== "pointer" ||
      parsedRecoveryPresentationProof.withinViewport !== true
    ) {
      throw new Error(`P2.31 recovery presentation proof failed: ${recoveryPresentationProof}`);
    }
    const corruptAtLoad = await evaluate(cdp, `localStorage.getItem("${storeKey}")`);
    const corruptFirstClickProof = JSON.parse(await evaluate(cdp, `(() => {
      const corruptAtLoad = localStorage.getItem("${storeKey}");
      document.querySelector('[data-review-ui="recover-store-button"]')?.click();
      const corruptAfterFirstClick = localStorage.getItem("${storeKey}");
        const corruptConfirmation = document.querySelector('[data-review-ui="recover-store-confirmation"]')?.textContent;
      return JSON.stringify({ corruptAtLoad, corruptAfterFirstClick, corruptConfirmation });
    })()`));
    const recoveryConfirmationPresentationProof = await evaluate(cdp, `(() => {
      const surface = document.querySelector('[data-review-ui="recover-store-confirmation"]');
      const cancelButton = document.querySelector('[data-review-ui="cancel-recover-store-button"]');
      const confirmButton = document.querySelector('[data-review-ui="confirm-recover-store-button"]');
      if (
        !(surface instanceof HTMLElement) ||
        !(cancelButton instanceof HTMLElement) ||
        !(confirmButton instanceof HTMLElement)
      ) {
        return JSON.stringify({ ok: false, reason: "missing-recovery-confirmation" });
      }
      const surfaceStyle = getComputedStyle(surface);
      const cancelStyle = getComputedStyle(cancelButton);
      const confirmStyle = getComputedStyle(confirmButton);
      return JSON.stringify({
        ok: true,
        surfaceDisplay: surfaceStyle.display,
        surfaceGridColumn: surfaceStyle.gridColumnStart,
        surfaceBackground: surfaceStyle.backgroundColor,
        surfaceBorderWidth: surfaceStyle.borderTopWidth,
        cancelMinHeight: cancelStyle.minHeight,
        cancelBackground: cancelStyle.backgroundColor,
        confirmMinHeight: confirmStyle.minHeight,
        confirmBackground: confirmStyle.backgroundColor,
        confirmBorderColor: confirmStyle.borderTopColor,
        confirmCursor: confirmStyle.cursor,
        destructiveDistinct: confirmStyle.backgroundColor !== cancelStyle.backgroundColor
      });
    })()`);
    const parsedRecoveryConfirmationPresentationProof = JSON.parse(recoveryConfirmationPresentationProof);
    if (
      parsedRecoveryConfirmationPresentationProof.ok !== true ||
      parsedRecoveryConfirmationPresentationProof.surfaceDisplay !== "grid" ||
      parsedRecoveryConfirmationPresentationProof.surfaceGridColumn !== "1" ||
      parsedRecoveryConfirmationPresentationProof.surfaceBackground === "rgba(0, 0, 0, 0)" ||
      parsedRecoveryConfirmationPresentationProof.surfaceBorderWidth === "0px" ||
      parsedRecoveryConfirmationPresentationProof.cancelMinHeight !== "40px" ||
      parsedRecoveryConfirmationPresentationProof.confirmMinHeight !== "40px" ||
      parsedRecoveryConfirmationPresentationProof.confirmCursor !== "pointer" ||
      parsedRecoveryConfirmationPresentationProof.destructiveDistinct !== true
    ) {
      throw new Error(`P2.31 recovery confirmation presentation proof failed: ${recoveryConfirmationPresentationProof}`);
    }
    for (const viewport of [
      { width: 1280, height: 900, label: "desktop-recovery" },
      { width: 390, height: 844, label: "narrow-recovery" }
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width < 600
      });
      const recoveryLayoutProof = await evaluate(cdp, `(() => {
        const selectors = [
          '[data-review-ui="recover-store-confirmation"]',
          '[data-review-ui="cancel-recover-store-button"]',
          '[data-review-ui="confirm-recover-store-button"]'
        ];
        const boxes = selectors.map((selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return { selector, missing: true };
          const rect = element.getBoundingClientRect();
          return {
            selector,
            missing: false,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth
          };
        });
        const broken = boxes.filter((box) =>
          box.missing ||
          box.width <= 0 ||
          box.height <= 0 ||
          box.left < -1 ||
          box.right > window.innerWidth + Math.max(1, box.scrollWidth - box.clientWidth)
        );
        return JSON.stringify({ viewport: ${JSON.stringify(viewport.label)}, broken });
      })()`);
      const parsedRecoveryLayoutProof = JSON.parse(recoveryLayoutProof);
      if (parsedRecoveryLayoutProof.broken.length > 0) {
        throw new Error(`P2.31 ${viewport.label} layout proof failed: ${recoveryLayoutProof}`);
      }
    }
    const corruptCancelProof = JSON.parse(await evaluate(cdp, `(() => {
      document.querySelector('[data-review-ui="cancel-recover-store-button"]')?.click();
      return JSON.stringify({ corruptAfterCancel: localStorage.getItem("${storeKey}") });
    })()`));
    const afterCorruptConfirm = JSON.parse(await evaluate(cdp, `(() => {
      document.querySelector('[data-review-ui="recover-store-button"]')?.click();
      document.querySelector('[data-review-ui="confirm-recover-store-button"]')?.click();
      return JSON.stringify({
        storeValue: localStorage.getItem("${storeKey}"),
        otherValue: localStorage.getItem("other-key"),
        status: document.querySelector('[data-review-ui="status"]')?.textContent,
        statusAriaLive: document.querySelector('[data-review-ui="status"]')?.getAttribute("aria-live"),
        error: document.querySelector('[data-review-ui="error"]')?.textContent,
        errorHidden: document.querySelector('[data-review-ui="error"]')?.hasAttribute("hidden"),
        errorAriaHidden: document.querySelector('[data-review-ui="error"]')?.getAttribute("aria-hidden"),
        errorRole: document.querySelector('[data-review-ui="error"]')?.getAttribute("role"),
        errorAriaLive: document.querySelector('[data-review-ui="error"]')?.getAttribute("aria-live"),
        errorDisplay: getComputedStyle(document.querySelector('[data-review-ui="error"]')).display,
        savedReviews: document.querySelector('[data-review-ui="profile-total-reviews"]')?.textContent,
        emptyList: document.querySelector('[data-review-ui="stored-review-empty"]')?.textContent
      });
    })()`));
    await evaluate(cdp, `(() => {
      localStorage.setItem("${storeKey}", JSON.stringify({ schemaVersion: 3, reviews: [] }));
      return true;
    })()`);
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"error\"]')?.textContent.includes('Stored reviews use a newer schema')", "unsupported store recovery UI did not render");
    const unsupportedProof = JSON.parse(await evaluate(cdp, `(() => {
      const unsupportedAtLoad = localStorage.getItem("${storeKey}");
      document.querySelector('[data-review-ui="recover-store-button"]')?.click();
      const unsupportedAfterFirstClick = localStorage.getItem("${storeKey}");
      document.querySelector('[data-review-ui="confirm-recover-store-button"]')?.click();
      return JSON.stringify({
        unsupportedAtLoad,
        unsupportedAfterFirstClick,
        unsupportedAfterConfirm: localStorage.getItem("${storeKey}"),
        otherAfterUnsupportedConfirm: localStorage.getItem("other-key"),
        rawInvalidBytesRendered: document.querySelector("#chess-review-app")?.textContent.includes("{") === true ||
          document.querySelector("#chess-review-app")?.textContent.includes("schemaVersion") === true
      });
    })()`));
    const recoveryProof = JSON.stringify({
      corruptAtLoad,
      corruptAfterFirstClick: corruptFirstClickProof.corruptAfterFirstClick,
      corruptConfirmation: corruptFirstClickProof.corruptConfirmation,
      corruptAfterCancel: corruptCancelProof.corruptAfterCancel,
      afterCorruptConfirm,
      unsupportedAtLoad: unsupportedProof.unsupportedAtLoad,
      unsupportedAfterFirstClick: unsupportedProof.unsupportedAfterFirstClick,
      unsupportedAfterConfirm: unsupportedProof.unsupportedAfterConfirm,
      otherAfterUnsupportedConfirm: unsupportedProof.otherAfterUnsupportedConfirm,
      rawInvalidBytesRendered: unsupportedProof.rawInvalidBytesRendered
    });
    if (
      recoveryProof !==
      JSON.stringify({
        corruptAtLoad: "{",
        corruptAfterFirstClick: "{",
        corruptConfirmation: "Reset saved-review storage?CancelReset saved reviews",
        corruptAfterCancel: "{",
        afterCorruptConfirm: {
          storeValue: null,
          otherValue: "kept",
          status: "Ready",
          statusAriaLive: "polite",
          error: "",
          errorHidden: true,
          errorAriaHidden: "true",
          errorRole: null,
          errorAriaLive: null,
          errorDisplay: "none",
          savedReviews: "Saved reviews0",
          emptyList: "No saved reviews"
        },
        unsupportedAtLoad: JSON.stringify({ schemaVersion: 3, reviews: [] }),
        unsupportedAfterFirstClick: JSON.stringify({ schemaVersion: 3, reviews: [] }),
        unsupportedAfterConfirm: null,
        otherAfterUnsupportedConfirm: "kept",
        rawInvalidBytesRendered: false
      })
    ) {
      throw new Error(`P2.30 saved-review store recovery proof failed: ${recoveryProof}`);
    }
    await evaluate(cdp, `localStorage.setItem("${storeKey}", ${JSON.stringify(singleSavedReviewStore)}); true;`);
    await cdp.send("Page.reload", { ignoreCache: true });
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"profile-total-reviews\"]')?.textContent === 'Saved reviews1'", "P2.29 proof did not restore single saved review store");
    await evaluate(cdp, "document.querySelector('[data-review-ui=\"view-review-button\"]')?.click(); true;");
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"saved-review-detail-move-row\"]') !== null", "saved detail did not restore after P2.29 proof");
    await evaluate(cdp, `(() => {
      const input = document.querySelector('[data-review-ui="pgn-input"]');
      input.value = "1. f3 e5 2. g4 Qh4# 0-1";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "0-1", inputType: "insertText" }));
      document.querySelector('[data-review-ui="review-button"]')?.click();
      return true;
    })()`);
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"summary-total-moves\"]')?.textContent === 'Total moves4'", "review before clear guard did not complete");
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"key-moment-row\"]') !== null", "artifact before clear guard did not render");
    const storedBeforeClearGuard = await evaluate(cdp, `localStorage.getItem("${storeKey}")`);
    if (typeof storedBeforeClearGuard !== "string") {
      throw new Error("stored review missing before clear guard proof");
    }
    const clearGuardFirstClickProof = await evaluate(cdp, `(() => {
      document.querySelector('[data-review-ui="clear-button"]')?.click();
      const stored = localStorage.getItem("${storeKey}");
      const parsed = JSON.parse(stored ?? "{}");
      return JSON.stringify({
        stored,
        schemaVersion: parsed.schemaVersion,
        reviewCount: parsed.reviews?.length,
        moveCount: parsed.reviews?.[0]?.review?.entries?.length,
        hasConfirmation: document.querySelector('[data-review-ui="clear-confirmation"]') !== null,
        hasDetail: document.querySelector('[data-review-ui="saved-review-detail-move-row"]') !== null,
        totalMoves: document.querySelector('[data-review-ui="summary-total-moves"]')?.textContent,
        hasArtifacts: document.querySelector('[data-review-ui="key-moment-row"]') !== null,
        saveState: document.querySelector('[data-review-ui="save-state"]')?.textContent
      });
    })()`);
    if (
      clearGuardFirstClickProof !==
      JSON.stringify({
        stored: storedBeforeClearGuard,
        schemaVersion: 2,
        reviewCount: 1,
        moveCount: 4,
        hasConfirmation: true,
        hasDetail: true,
        totalMoves: "Total moves4",
        hasArtifacts: true,
        saveState: "Unsaved review"
      })
    ) {
      throw new Error(`P2.28 clear guard first-click proof failed: ${clearGuardFirstClickProof}`);
    }
    const clearGuardCancelProof = await evaluate(cdp, `(() => {
      document.querySelector('[data-review-ui="cancel-clear-button"]')?.click();
      const stored = localStorage.getItem("${storeKey}");
      const parsed = JSON.parse(stored ?? "{}");
      return JSON.stringify({
        stored,
        schemaVersion: parsed.schemaVersion,
        reviewCount: parsed.reviews?.length,
        moveCount: parsed.reviews?.[0]?.review?.entries?.length,
        hasConfirmation: document.querySelector('[data-review-ui="clear-confirmation"]') !== null,
        hasDetail: document.querySelector('[data-review-ui="saved-review-detail-move-row"]') !== null,
        totalMoves: document.querySelector('[data-review-ui="summary-total-moves"]')?.textContent,
        hasArtifacts: document.querySelector('[data-review-ui="key-moment-row"]') !== null,
        saveState: document.querySelector('[data-review-ui="save-state"]')?.textContent
      });
    })()`);
    if (
      clearGuardCancelProof !==
      JSON.stringify({
        stored: storedBeforeClearGuard,
        schemaVersion: 2,
        reviewCount: 1,
        moveCount: 4,
        hasConfirmation: false,
        hasDetail: true,
        totalMoves: "Total moves4",
        hasArtifacts: true,
        saveState: "Unsaved review"
      })
    ) {
      throw new Error(`P2.28 clear guard cancel proof failed: ${clearGuardCancelProof}`);
    }
    await evaluate(cdp, "document.querySelector('[data-review-ui=\"delete-review-button\"]').click(); true;");
    await waitFor(cdp, `JSON.parse(localStorage.getItem("${storeKey}") ?? '{"reviews":[]}').reviews.length === 0`, "delete did not update localStorage");
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"saved-review-detail-empty\"]')?.textContent === 'No saved review selected'", "selected saved detail did not clear after delete");
    await evaluate(cdp, "document.querySelector('[data-review-ui=\"save-button\"]').click(); true;");
    await waitFor(cdp, `JSON.parse(localStorage.getItem("${storeKey}") ?? '{"reviews":[]}').reviews.length === 1`, "save before confirm clear did not persist");
    await evaluate(cdp, "document.querySelector('[data-review-ui=\"view-review-button\"]')?.click(); true;");
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"saved-review-detail-move-row\"]') !== null", "saved detail before confirm clear did not render");
    await evaluate(cdp, `(() => {
      document.querySelector('[data-review-ui="clear-button"]')?.click();
      document.querySelector('[data-review-ui="confirm-clear-button"]')?.click();
      return true;
    })()`);
    await waitFor(cdp, `localStorage.getItem("${storeKey}") === null`, "clear did not remove localStorage key");
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"saved-review-detail-empty\"]')?.textContent === 'No saved review selected'", "selected saved detail did not clear after confirm clear");
    await waitFor(cdp, "document.querySelector('[data-review-ui=\"save-state\"]')?.textContent === 'Unsaved review'", "confirm clear did not preserve current review save-state semantics");
    for (const viewport of [
      { width: 1280, height: 900, label: "desktop" },
      { width: 390, height: 844, label: "narrow" }
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width < 600
      });
      const layoutProof = await evaluate(cdp, `(() => {
        const selectors = [
          '[data-review-ui="product-header"]',
          '[data-review-ui="product-title"]',
          '[data-review-ui="release-badge"]',
          '[data-review-ui="release-scope"]',
          '[data-review-ui="pgn-input"]',
          '[data-review-ui="depth-control"]',
          '[data-review-ui="review-button"]',
          '[data-review-ui="save-button"]',
          '[data-review-ui="clear-button"]',
          '[data-review-ui="move-list"]'
        ];
        const boxes = selectors.map((selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return { selector, missing: true };
          const rect = element.getBoundingClientRect();
          return {
            selector,
            missing: false,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth
          };
        });
        const broken = boxes.filter((box) =>
          box.missing ||
          box.width <= 0 ||
          box.height <= 0 ||
          box.left < -1 ||
          box.right > window.innerWidth + Math.max(1, box.scrollWidth - box.clientWidth)
        );
        return JSON.stringify({ viewport: ${JSON.stringify(viewport.label)}, broken });
      })()`);
      const parsedLayoutProof = JSON.parse(layoutProof);
      if (parsedLayoutProof.broken.length > 0) {
        throw new Error(`P2.22 ${viewport.label} layout proof failed: ${layoutProof}`);
      }
    }
  } finally {
    if (cdp !== undefined) {
      await cdp.send("Browser.close").catch(() => {});
      cdp.close();
    }
    chrome.kill();
  }
}

rmSync(proofRoot, { recursive: true, force: true });
mkdirSync(join(proofRoot, "dist/pkg"), { recursive: true });
run("node", ["scripts/audit-policy.mjs"]);
run("pnpm", ["--filter", "web", "run", "build"]);
assertBrowserRuntimeImports(join(repoRoot, "apps/web/dist"));
assertWasmBindgenCliVersion("P2.20 proof");
run("cargo", ["build", "-p", "chess-wasm-bridge", "--target", "wasm32-unknown-unknown", "--release"]);
run("wasm-bindgen", [
  "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm",
  "--target",
  "bundler",
  "--out-dir",
  join(proofRoot, "dist/pkg")
]);
writeEmbeddedWasmModule(proofRoot, { assertExpectedImports: true });
copyBuiltWeb(proofRoot);
copyProductHtml(proofRoot, {
  missingMessage: "P2.20 product HTML is missing",
  scanBeforeChecks: true,
  cspCheck: "meta",
  cspMismatchMessage: (metaCsp) => `P2.20 product HTML CSP mismatch: ${metaCsp}`,
  requiredIncludes: [
    { text: 'id="chess-review-app"', message: "P2.20 product root is missing" },
    { text: 'rel="stylesheet"', message: "P2.22 product stylesheet link is missing" },
    { text: 'href="./review.css"', message: "P2.22 product stylesheet href is missing" },
    { text: 'src="./dist/app.js"', message: "P2.20 product entrypoint script is missing" }
  ]
});
copyProductCss(proofRoot, { missingMessage: "P2.22 product stylesheet is missing" });
scanStaticOutput(proofRoot, {
  extraForbiddenTokens: ["<script type=\"importmap\"", "ServiceWorker", "Worker("]
});
const { server, requests, servedResponses, port } = await startStaticServer();
try {
  await runBrowserProof(`http://127.0.0.1:${port}/index.html`, port + 1);
} finally {
  server.close();
}
if (!requests.includes("/review.css")) {
  throw new Error(`P2.22 proof did not request review.css: ${requests.join(", ")}`);
}
if (!servedResponses.some((response) => response.pathname === "/review.css" && response.contentType === "text/css; charset=utf-8")) {
  throw new Error(`P2.22 proof did not serve review.css as text/css: ${JSON.stringify(servedResponses)}`);
}
if (requests.some((request) => request.endsWith(".wasm"))) {
  throw new Error(`P2.20 proof requested a .wasm asset: ${requests.join(", ")}`);
}
if (requests.some((request) => request === "/review-workflow" || request === "/review-store")) {
  throw new Error(`P2.20 proof used extensionless delivery aliases: ${requests.join(", ")}`);
}
console.log("P2.20 browser bootstrap proof passed.");
