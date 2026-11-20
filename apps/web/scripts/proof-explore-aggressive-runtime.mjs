import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  assertWasmBindgenCliVersion,
  betaCsp,
  copyProductCss,
  copyProductHtml,
  scanStaticOutput,
  writeEmbeddedWasmModule,
} from "../../../scripts/beta-preview-support.mjs";
import {
  evaluate,
  evaluateJson,
  reserveLoopbackPort,
  runCdpProof,
  startStaticServer,
  waitFor,
} from "../../../scripts/browser-proof-support.mjs";

const repoRoot = new URL("../../../", import.meta.url).pathname;
const proofRoot = join(repoRoot, "target/proofs/explore-runtime");
const proofDistRoot = join(proofRoot, "dist");
const cargoWasmPath = join(
  repoRoot,
  "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm",
);
const traceSymbol = "chess.runtime.proof.state";
const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const targetFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const targetSideToMove = targetFen.split(" ")[1] === "w" ? "white" : "black";
const expectedWorkerUrls = ["./dist/play-move-worker.js", "./dist/play-worker.js"];
const expectedWorkerPaths = ["/dist/play-move-worker.js", "/dist/play-worker.js"];
const commandsUsed = [
  "node scripts/audit-policy.mjs",
  `apps/web/node_modules/.bin/tsc -p apps/web/tsconfig.build.json --outDir ${proofDistRoot} --declaration false --sourceMap false`,
  "cargo build --offline -p chess-wasm-bridge --target wasm32-unknown-unknown --release",
  `wasm-bindgen ${cargoWasmPath} --target bundler --out-dir ${join(proofDistRoot, "pkg")}`,
  "Chrome CDP: production navigation, Worker post/response trace, FEN/side/depth UI actions, rendered Cburnett/orientation/recommendation checks, screenshots, and 1440x900/1920x1080 geometry smoke",
];

const taskPath = [
  join(process.env.HOME ?? "", ".cargo/bin"),
  "/opt/homebrew/opt/rustup/bin",
  "/opt/homebrew/sbin",
  "/opt/homebrew/bin",
  process.env.PATH ?? "",
]
  .filter((part) => part.length > 0)
  .join(":");

function commandEnvironment(extra = {}) {
  return {
    ...process.env,
    ...extra,
    PATH: taskPath,
    CARGO_NET_OFFLINE: "true",
  };
}

function runChecked(command, args, label, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: commandEnvironment(extraEnv),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const detail = output.length > 0 ? `\n${output.slice(-4000)}` : "";
    throw new Error(`${label} failed with exit ${String(result.status)}${detail}`);
  }
}

function prepareProofOutput() {
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(join(proofDistRoot, "pkg"), { recursive: true });

  runChecked(process.execPath, ["scripts/audit-policy.mjs"], "runtime proof policy audit");

  const tscPath = join(repoRoot, "apps/web/node_modules/.bin/tsc");
  if (!existsSync(tscPath)) {
    throw new Error(`TypeScript compiler is missing at ${tscPath}`);
  }
  runChecked(
    tscPath,
    [
      "-p",
      join(repoRoot, "apps/web/tsconfig.build.json"),
      "--outDir",
      proofDistRoot,
      "--declaration",
      "false",
      "--sourceMap",
      "false",
    ],
    "current working-tree web build",
  );

  assertWasmBindgenCliVersion("Explore aggressive runtime proof");
  runChecked(
    "cargo",
    [
      "build",
      "--offline",
      "-p",
      "chess-wasm-bridge",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
    ],
    "current working-tree WASM build",
  );

  if (!existsSync(cargoWasmPath)) {
    throw new Error(`WASM build did not produce ${cargoWasmPath}`);
  }
  runChecked(
    "wasm-bindgen",
    [cargoWasmPath, "--target", "bundler", "--out-dir", join(proofDistRoot, "pkg")],
    "current working-tree wasm-bindgen delivery",
  );
  writeEmbeddedWasmModule(proofRoot, {
    assertExpectedImports: true,
    removeWasmAsset: true,
  });

  copyProductHtml(proofRoot, {
    missingMessage: "production index.html is missing",
    scanBeforeChecks: true,
    cspCheck: "meta",
    cspMismatchMessage: (metaCsp) => `production index.html CSP mismatch: ${metaCsp}`,
    requiredIncludes: [
      { text: 'id="chess-review-app"', message: "production app root is missing" },
      { text: 'href="./review.css"', message: "production stylesheet link is missing" },
      { text: 'src="./dist/app.js"', message: "production app entrypoint is missing" },
    ],
  });
  copyProductCss(proofRoot, { missingMessage: "production review.css is missing" });

  const requiredFiles = [
    join(proofDistRoot, "app.js"),
    join(proofDistRoot, "play-move-worker.js"),
    join(proofDistRoot, "play-worker.js"),
    join(proofDistRoot, "pkg/chess_wasm_bridge_embedded.mjs"),
  ];
  for (const file of requiredFiles) {
    if (!existsSync(file)) throw new Error(`proof delivery is missing ${file}`);
  }

  const appEntry = readFileSync(join(proofDistRoot, "app.js"), "utf8");
  if (!appEntry.includes("mountReviewApp")) {
    throw new Error("dist/app.js does not contain the production mountReviewApp entry");
  }
  const workerEntry = readFileSync(join(proofDistRoot, "play-worker.js"), "utf8");
  if (!workerEntry.includes("chess_wasm_bridge_embedded.mjs")) {
    throw new Error("production analysis Worker does not import the embedded WASM module");
  }
  const embeddedModule = readFileSync(
    join(proofDistRoot, "pkg/chess_wasm_bridge_embedded.mjs"),
    "utf8",
  );
  if (!embeddedModule.includes("new WebAssembly.Module")) {
    throw new Error("embedded WASM module was not generated from the current bridge");
  }

  scanStaticOutput(proofRoot, {
    extraForbiddenTokens: ['<script type="importmap"', "ServiceWorker"],
  });
}

const traceSource = `
(() => {
  const key = Symbol.for(${JSON.stringify(traceSymbol)});
  const state = { events: [], nextSequence: 1, nextWorkerId: 1 };
  const push = (event) => {
    if (state.events.length < 20000) {
      state.events.push({ ...event, sequence: state.nextSequence++, t: performance.now() });
    }
  };
  globalThis[key] = state;
  const serialize = (value) => {
    try {
      return String(value);
    } catch {
      return "<unserializable>";
    }
  };
  addEventListener("error", (event) => {
    push({
      kind: "page-error",
      message: serialize(event.error?.stack ?? event.message),
      source: serialize(event.filename),
      line: event.lineno ?? null,
    });
  });
  addEventListener("unhandledrejection", (event) => {
    push({ kind: "unhandled-rejection", message: serialize(event.reason) });
  });
  const nativeConsoleError = console.error.bind(console);
  console.error = (...args) => {
    push({ kind: "console-error", message: args.map(serialize).join(" ") });
    nativeConsoleError(...args);
  };

  const NativeWorker = globalThis.Worker;
  if (typeof NativeWorker !== "function") {
    push({ kind: "worker-unavailable" });
    return;
  }
  globalThis.Worker = function ProofObservedWorker(url, options) {
    const rawUrl = String(url ?? "");
    const absolutePath = new URL(rawUrl, location.href).pathname;
    const channel = rawUrl.endsWith("play-move-worker.js")
      ? "move"
      : rawUrl.endsWith("play-worker.js")
        ? "analysis"
        : "other";
    const workerId = state.nextWorkerId++;
    const worker = new NativeWorker(url, options);
    push({ kind: "worker-constructed", workerId, channel, url: rawUrl, path: absolutePath });

    const nativePostMessage = worker.postMessage.bind(worker);
    worker.postMessage = (message, ...rest) => {
      push({
        kind: "worker-post",
        workerId,
        channel,
        url: rawUrl,
        op: message?.op ?? null,
        id: message?.id ?? null,
        fen: message?.fen ?? null,
        side: message?.side ?? null,
        aggressive: message?.aggressive ?? null,
        historyFens: message?.historyFens ?? null,
        context: message?.context ?? null,
        uiEngineDepth: document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-engine-depth') ?? null,
      });
      return nativePostMessage(message, ...rest);
    };
    worker.addEventListener("message", (event) => {
      const result = event.data?.result;
      const value = result?.value;
      push({
        kind: "worker-response",
        workerId,
        channel,
        url: rawUrl,
        op: event.data?.op ?? null,
        id: event.data?.id ?? null,
        ok: result?.ok ?? null,
        error: result?.error ?? null,
        stateFen: result?.value?.state?.fen ?? null,
        stateSideToMove: result?.value?.state?.sideToMove ?? null,
        valueSide: result?.value?.side ?? null,
        valueDepth: result?.value?.depth ?? null,
        resultValuePresent: value !== null && typeof value === "object",
        candidateCount: Array.isArray(value?.candidates) ? value.candidates.length : null,
        replyCandidateCount: Array.isArray(value?.replyCandidates) ? value.replyCandidates.length : null,
        principalLineLength: Array.isArray(value?.principalLine) ? value.principalLine.length : null,
        nodes: typeof value?.nodes === "number" ? value.nodes : null,
        soundMarginCp: typeof value?.soundMarginCp === "number" ? value.soundMarginCp : null,
        mateDetected: typeof value?.mateDetected === "boolean" ? value.mateDetected : null,
      });
    });
    worker.addEventListener("error", (event) => {
      push({ kind: "worker-error", workerId, channel, message: serialize(event.message) });
    });
    worker.addEventListener("messageerror", () => {
      push({ kind: "worker-message-error", workerId, channel });
    });
    return worker;
  };
  globalThis.Worker.prototype = NativeWorker.prototype;
})();
`;

const runtimeTraceExpression = `globalThis[Symbol.for(${JSON.stringify(traceSymbol)})]`;
const runtimeTraceJsonExpression = `JSON.stringify(${runtimeTraceExpression} ?? null)`;

const domSnapshotExpression = `JSON.stringify((() => {
  const element = (selector) => document.querySelector(selector);
  const text = (selector) => element(selector)?.textContent?.trim() ?? null;
  const attribute = (selector, name) => element(selector)?.getAttribute(name) ?? null;
  const buttonPressed = (selector) => attribute(selector, "aria-pressed");
  return {
    appRoot: element("#chess-review-app [data-app-ui=\\"root\\"]") !== null,
    playRoot: element("#chess-review-app [data-app-ui=\\"play-root\\"]") !== null,
    boardSquares: document.querySelectorAll('[data-play-ui="board-square"]').length,
    currentFen: text('[data-play-ui="current-fen"] dd'),
    boardLabel: attribute('[data-play-ui="board-grid"]', "aria-label") ?? attribute('[data-play-ui="board"]', "aria-label"),
    boardOrientation: attribute('[data-play-ui="board"]', "data-board-orientation"),
    pieceSet: attribute('[data-piece-set]', "data-piece-set"),
    pieceCount: document.querySelectorAll('[data-play-ui="board-square"][data-board-piece]').length,
    pieceAsset: (() => {
      const piece = document.querySelector('[data-play-ui="board-square"][data-board-piece] > [data-play-ui="board-piece"]');
      return piece instanceof HTMLElement ? getComputedStyle(piece).backgroundImage : null;
    })(),
    statusOwner: attribute('[data-play-ui="status"]', "data-play-status-owner"),
    reactionStatus: attribute('[data-play-ui="reaction-lens"]', "data-reaction-status"),
    reactionSource: attribute('[data-play-ui="reaction-lens"]', "data-reaction-source"),
    reactionSide: attribute('[data-play-ui="reaction-lens"]', "data-reaction-side"),
    reactionDepth: attribute('[data-play-ui="reaction-lens"]', "data-reaction-engine-depth"),
    exploreHeading: text('[data-play-ui="reaction-lens"] h2'),
    recommendation: (() => {
      const node = document.querySelector('[data-play-ui="explore-section"][data-explore-section="recommendation"]');
      if (!(node instanceof HTMLElement)) return null;
      const box = node.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    })(),
    recommendationNote: text('[data-play-ui="recommendation-note"]'),
    mode: buttonPressed('[data-play-ui="play-mode-button"][data-play-mode="reaction-lens"]'),
    classical: buttonPressed('[data-play-ui="eval-button"][data-eval-mode="classical"]'),
    aggressive: buttonPressed('[data-play-ui="aggressive-toggle-button"]'),
    white: buttonPressed('[data-play-ui="player-side-button"][data-player-side="white"]'),
    black: buttonPressed('[data-play-ui="player-side-button"][data-player-side="black"]'),
    depth1: buttonPressed('[data-play-ui="engine-depth-button"][data-engine-depth="1"]'),
    depth3: buttonPressed('[data-play-ui="engine-depth-button"][data-engine-depth="3"]'),
    depth5: buttonPressed('[data-play-ui="engine-depth-button"][data-engine-depth="5"]'),
    modeLabel: text('[data-play-ui="mode-label"]'),
    errorNodes: Array.from(document.querySelectorAll('[data-play-ui="error"]')).filter((node) => {
      return node instanceof HTMLElement && !node.hidden;
    }).length,
  };
})())`;

const markerSnapshotExpression = `JSON.stringify({
  legacyProofMarker: typeof globalThis.__exploreAggressiveProof,
  legacyRuntimeTrace: typeof globalThis.__chessRuntimeTrace,
  bootstrappedBestMove: typeof globalThis.__chessPlayBestMoveProvider,
})`;

function clickExpression(selector, requireVisible) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { ok: false, reason: "missing" };
    if (element instanceof HTMLButtonElement && element.disabled) return { ok: false, reason: "disabled" };
    const rect = element.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;
    if (${String(requireVisible)} && !visible) return { ok: false, reason: "not-visible" };
    element.click();
    return { ok: true, visible };
  })()`;
}

function openDetailsExpression(selector) {
  return `(() => {
    const details = document.querySelector(${JSON.stringify(selector)});
    if (!(details instanceof HTMLDetailsElement)) return { ok: false, reason: "missing" };
    if (!details.open) details.querySelector("summary")?.click();
    return { ok: details.open, visible: details.getBoundingClientRect().height > 0 };
  })()`;
}

function loadFenExpression(fen) {
  return `(() => {
    const details = document.querySelector('[data-play-ui="load-position"]');
    if (!(details instanceof HTMLDetailsElement)) return { ok: false, reason: "load-control-missing" };
    if (!details.open) details.querySelector("summary")?.click();
    const input = details.querySelector('[data-play-ui="load-position-input"]');
    const button = details.querySelector('[data-play-ui="load-position-button"]');
    if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) {
      return { ok: false, reason: "load-controls-missing" };
    }
    if (button.disabled) return { ok: false, reason: "load-button-disabled" };
    input.value = ${JSON.stringify(fen)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
    return { ok: true, visible: input.getBoundingClientRect().height > 0 };
  })()`;
}

async function clickButton(cdp, selector, label, requireVisible = false) {
  const result = await evaluate(cdp, clickExpression(selector, requireVisible));
  if (result?.ok !== true) throw new Error(`${label}: ${JSON.stringify(result)}`);
}

async function openDetails(cdp, selector, label) {
  const result = await evaluate(cdp, openDetailsExpression(selector));
  if (result?.ok !== true) throw new Error(`${label}: ${JSON.stringify(result)}`);
}

async function readRuntimeTrace(cdp) {
  const trace = await evaluateJson(cdp, runtimeTraceJsonExpression);
  if (trace === null || typeof trace !== "object" || !Array.isArray(trace.events)) {
    throw new Error("runtime trace was not installed before production app execution");
  }
  return trace;
}

function workerPair(trace, post) {
  const response = trace.events.find(
    (event) =>
      event.kind === "worker-response" &&
      event.workerId === post.workerId &&
      event.id === post.id &&
      event.sequence > post.sequence,
  );
  return response === undefined ? null : { post, response };
}

function matchingSideExplorePair(trace, criteria, minimumSequence = 0) {
  for (const post of trace.events) {
    if (
      post.kind !== "worker-post" ||
      post.op !== "sideExplore" ||
      post.sequence < minimumSequence ||
      post.fen !== criteria.fen ||
      post.side !== criteria.side ||
      post.aggressive !== true ||
      (criteria.uiEngineDepth !== undefined && post.uiEngineDepth !== String(criteria.uiEngineDepth)) ||
      (criteria.contextMode !== undefined && post.context?.mode !== criteria.contextMode)
    ) {
      continue;
    }
    const pair = workerPair(trace, post);
    if (
      pair?.response.ok === true &&
      pair.response.stateFen === criteria.fen &&
      pair.response.valueSide === criteria.side &&
      pair.response.stateSideToMove === targetSideToMove &&
      pair.response.resultValuePresent === true &&
      typeof pair.response.candidateCount === "number" &&
      typeof pair.response.replyCandidateCount === "number" &&
      typeof pair.response.principalLineLength === "number" &&
      typeof pair.response.nodes === "number" &&
      typeof pair.response.soundMarginCp === "number" &&
      typeof pair.response.mateDetected === "boolean"
    ) {
      return pair;
    }
  }
  return null;
}

async function waitForSideExplorePair(cdp, criteria, minimumSequence, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const trace = await readRuntimeTrace(cdp);
    const pair = matchingSideExplorePair(trace, criteria, minimumSequence);
    if (pair !== null) return pair;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const trace = await readRuntimeTrace(cdp);
  const observed = trace.events
    .filter((event) => event.kind === "worker-post" || event.kind === "worker-response")
    .slice(-24);
  throw new Error(
    `${label}: no successful real sideExplore pair matched ${JSON.stringify(criteria)}; observed=${JSON.stringify(observed)}`,
  );
}

function pairSummary(pair) {
  return {
    workerId: pair.post.workerId,
    id: pair.post.id,
    channel: pair.post.channel,
    op: pair.post.op,
    fen: pair.post.fen,
    side: pair.post.side,
    aggressive: pair.post.aggressive,
    uiEngineDepth: pair.post.uiEngineDepth,
    historyFens: pair.post.historyFens,
    context: pair.post.context,
    responseOk: pair.response.ok,
    dtoStateFen: pair.response.stateFen,
    dtoStateSideToMove: pair.response.stateSideToMove,
    dtoSide: pair.response.valueSide,
    dtoDepth: pair.response.valueDepth,
    dtoCandidateCount: pair.response.candidateCount,
    dtoReplyCandidateCount: pair.response.replyCandidateCount,
    dtoPrincipalLineLength: pair.response.principalLineLength,
    dtoNodes: pair.response.nodes,
    dtoSoundMarginCp: pair.response.soundMarginCp,
    dtoMateDetected: pair.response.mateDetected,
    elapsedMs: Math.round(pair.response.t - pair.post.t),
  };
}

async function browserSnapshot(cdp) {
  return evaluateJson(cdp, domSnapshotExpression);
}

function assertProductState(snapshot, label) {
  const issues = [];
  if (snapshot.appRoot !== true) issues.push("app shell is not mounted");
  if (snapshot.playRoot !== true) issues.push("production play root is not mounted");
  if (snapshot.boardSquares !== 64) issues.push(`board squares=${String(snapshot.boardSquares)}`);
  if (snapshot.boardLabel !== "Tablero de ajedrez") issues.push("board accessible name is not localized");
  if (snapshot.pieceSet !== "adr-0206-cburnett-v1") issues.push("production piece set is not Cburnett");
  if (snapshot.pieceCount <= 0) issues.push("production board has no rendered pieces");
  if (typeof snapshot.pieceAsset !== "string" || !snapshot.pieceAsset.includes("/assets/pieces/adr-0206-cburnett/")) {
    issues.push("production board is not rendering a Cburnett SVG asset");
  }
  if (snapshot.boardOrientation !== snapshot.reactionSide) {
    issues.push(`board orientation=${String(snapshot.boardOrientation)} does not match selected side=${String(snapshot.reactionSide)}`);
  }
  if (snapshot.exploreHeading !== "Qué jugar ahora") issues.push("Explore recommendation heading is not primary/localized");
  if (snapshot.recommendation?.width <= 0 || snapshot.recommendation?.height <= 0) issues.push("recommendation block has no rendered geometry");
  if (snapshot.recommendationNote === null || snapshot.recommendationNote.length === 0) issues.push("recommendation explanation is not rendered");
  if (snapshot.classical !== "true") issues.push("Classical is not selected");
  if (snapshot.aggressive !== "true") issues.push("Aggressive is not On");
  if (snapshot.mode !== "true") issues.push("Explore is not selected");
  if (snapshot.errorNodes !== 0) issues.push(`visible error nodes=${String(snapshot.errorNodes)}`);
  if (issues.length > 0) throw new Error(`${label}: ${issues.join(", ")}`);
}

async function geometrySmoke(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const geometry = await evaluateJson(
    cdp,
    `JSON.stringify((() => {
      document.scrollingElement.scrollTop = 0;
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return null;
        const value = element.getBoundingClientRect();
        return {
          left: Math.round(value.left),
          top: Math.round(value.top),
          right: Math.round(value.right),
          bottom: Math.round(value.bottom),
          width: Math.round(value.width),
          height: Math.round(value.height),
        };
      };
      const board = rect('[data-play-ui="board"]');
      const grid = rect('[data-play-ui="board-grid"]');
      const rail = rect('[data-play-ui="side-panel"]');
      const issues = [];
      if (board === null || board.width <= 0 || board.height <= 0) issues.push("board-missing");
      if (grid === null || grid.width <= 0 || grid.height <= 0) issues.push("board-grid-missing");
      if (grid !== null && Math.abs(grid.width - grid.height) > 2) issues.push("grid-not-square");
      if (rail === null || rail.width <= 0 || rail.height <= 0) issues.push("rail-missing");
      for (const [name, value] of [["board", board], ["rail", rail]]) {
        if (value !== null && (value.left < -1 || value.right > innerWidth + 1)) issues.push(name + "-horizontal-overflow");
      }
      if (document.documentElement.scrollWidth > innerWidth + 1) issues.push("page-horizontal-overflow");
      return {
        viewport: { width: innerWidth, height: innerHeight },
        board,
        grid,
        rail,
        issues,
      };
    })())`,
  );
  if (
    geometry.viewport.width !== width ||
    geometry.viewport.height !== height ||
    geometry.issues.length > 0
  ) {
    throw new Error(`geometry smoke failed at ${width}x${height}: ${JSON.stringify(geometry)}`);
  }
  return geometry;
}

async function screenshot(cdp, name) {
  const image = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const file = join(proofRoot, `${name}.png`);
  writeFileSync(file, Buffer.from(image.data, "base64"));
  return file;
}

async function runBrowserProof(url, debugPort) {
  return runCdpProof(proofRoot, debugPort, async (cdp) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: traceSource });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url });
    await waitFor(
      cdp,
      `document.querySelectorAll('[data-play-ui="board-square"]').length === 64 && document.querySelector('#chess-review-app [data-app-ui="root"]') !== null`,
      "production app entry did not mount a board",
    );
    await waitFor(
      cdp,
      `document.querySelector('[data-play-ui="status"]') !== null && document.querySelector('[data-play-ui="eval-button"][data-eval-mode="classical"]') !== null`,
      "production app controls did not mount",
    );

    const initial = await browserSnapshot(cdp);
    assertProductState(initial, "initial production state");
    const initialScreenshot = await screenshot(cdp, "production-initial-1440x900");

    await openDetails(cdp, '[data-play-ui="control-deck"]', "production session control deck");
    await openDetails(cdp, '[data-play-ui="tools"]', "production Tools disclosure");
    await clickButton(
      cdp,
      '[data-play-ui="play-mode-button"][data-play-mode="spectator-lens"]',
      "switch to production Spectator mode",
      true,
    );
    await waitFor(
      cdp,
      `document.querySelector('[data-play-ui="play-mode-button"][data-play-mode="spectator-lens"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-play-ui="load-position"]') !== null`,
      "production Spectator mode did not expose the FEN control",
    );
    await openDetails(cdp, '[data-play-ui="load-position"]', "production FEN disclosure");
    const loadResult = await evaluate(cdp, loadFenExpression(targetFen));
    if (loadResult?.ok !== true) throw new Error(`production FEN load: ${JSON.stringify(loadResult)}`);
    await waitFor(
      cdp,
      `document.querySelector('[data-play-ui="current-fen"] dd')?.textContent?.trim() === ${JSON.stringify(targetFen)} && document.querySelector('[data-play-ui="status"]')?.getAttribute('data-play-status-owner') !== 'system'`,
      "production UI did not load the known FEN",
    );
    const loaded = await browserSnapshot(cdp);
    if (loaded.currentFen !== targetFen) {
      throw new Error(`production FEN mismatch: ${JSON.stringify(loaded)}`);
    }

    await clickButton(
      cdp,
      '[data-play-ui="play-mode-button"][data-play-mode="reaction-lens"]',
      "return to production Explore mode",
      false,
    );
    await waitFor(
      cdp,
      `document.querySelector('[data-play-ui="play-mode-button"][data-play-mode="reaction-lens"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-play-ui="reaction-lens"]') !== null`,
      "production Explore mode did not mount after FEN load",
    );

    const initialPair = await waitForSideExplorePair(
      cdp,
      { fen: targetFen, side: "white", uiEngineDepth: 1, contextMode: "fast" },
      0,
      "initial selected-side Explore",
    );
    await waitFor(
      cdp,
      `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-status') === 'ready' && document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-source') === 'rich'`,
      "production Explore did not settle on a rich result",
    );
    const afterFen = await browserSnapshot(cdp);
    assertProductState(afterFen, "loaded selected-side Classical Explore state");
    if (
      afterFen.currentFen !== targetFen ||
      afterFen.white !== "true" ||
      afterFen.reactionSide !== "white" ||
      afterFen.reactionDepth !== "1"
    ) {
      throw new Error(`loaded Explore state mismatch: ${JSON.stringify(afterFen)}`);
    }

    const beforeSideChange = (await readRuntimeTrace(cdp)).nextSequence;
    await clickButton(
      cdp,
      '[data-play-ui="player-side-button"][data-player-side="black"]',
      "change selected side to Black",
      true,
    );
    await waitFor(
      cdp,
      `document.querySelector('[data-play-ui="player-side-button"][data-player-side="black"]')?.getAttribute('aria-pressed') === 'true'`,
      "selected-side control did not visibly change to Black",
    );
    const sideChangePair = await waitForSideExplorePair(
      cdp,
      { fen: targetFen, side: "black", uiEngineDepth: 1, contextMode: "fast" },
      beforeSideChange,
      "selected-side change Explore",
    );
    const afterSideChange = await browserSnapshot(cdp);
    if (afterSideChange.black !== "true" || afterSideChange.reactionSide !== "black") {
      throw new Error(`selected-side UI mismatch after Black change: ${JSON.stringify(afterSideChange)}`);
    }

    const beforeDepthChange = (await readRuntimeTrace(cdp)).nextSequence;
    await clickButton(
      cdp,
      '[data-play-ui="engine-depth-button"][data-engine-depth="3"]',
      "change visible Explore depth to 3",
      true,
    );
    await waitFor(
      cdp,
      `document.querySelector('[data-play-ui="engine-depth-button"][data-engine-depth="3"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute('data-reaction-engine-depth') === '3'`,
      "visible Explore depth did not change to 3",
    );
    const depthChangePair = await waitForSideExplorePair(
      cdp,
      { fen: targetFen, side: "black", uiEngineDepth: 3, contextMode: "fast" },
      beforeDepthChange,
      "visible depth change Explore",
    );
    const finalSnapshot = await browserSnapshot(cdp);
    assertProductState(finalSnapshot, "final production Explore state");
    if (
      finalSnapshot.currentFen !== targetFen ||
      finalSnapshot.black !== "true" ||
      finalSnapshot.depth3 !== "true" ||
      finalSnapshot.reactionDepth !== "3" ||
      finalSnapshot.reactionSource !== "rich" ||
      finalSnapshot.reactionStatus !== "ready"
    ) {
      throw new Error(`final Explore state mismatch: ${JSON.stringify(finalSnapshot)}`);
    }
    const finalScreenshot = await screenshot(cdp, "production-final-1440x900");

    const markers = await evaluateJson(cdp, markerSnapshotExpression);
    const unexpectedMarkers = Object.entries(markers).filter(([, value]) => value !== "undefined");
    if (unexpectedMarkers.length > 0) {
      throw new Error(`unexpected runtime marker/provider: ${JSON.stringify(unexpectedMarkers)}`);
    }

    const trace = await readRuntimeTrace(cdp);
    const runtimeErrors = trace.events.filter((event) =>
      ["page-error", "unhandled-rejection", "console-error", "worker-error", "worker-message-error", "worker-unavailable"].includes(event.kind),
    );
    if (runtimeErrors.length > 0) {
      throw new Error(`browser/runtime errors observed: ${JSON.stringify(runtimeErrors)}`);
    }
    const constructedUrls = trace.events
      .filter((event) => event.kind === "worker-constructed")
      .map((event) => event.url);
    for (const expectedUrl of expectedWorkerUrls) {
      if (!constructedUrls.includes(expectedUrl)) {
        throw new Error(`production Worker URL was not observed: ${expectedUrl}`);
      }
    }
    const workerPairs = trace.events
      .filter((event) => event.kind === "worker-post")
      .map((post) => {
        const pair = workerPair(trace, post);
        return pair === null ? null : pairSummary(pair);
      })
      .filter((pair) => pair !== null);
    if (!workerPairs.some((pair) => pair.channel === "move" && pair.responseOk === true)) {
      throw new Error("no successful production move Worker post/response pair was observed");
    }
    if (!workerPairs.some((pair) => pair.channel === "analysis" && pair.responseOk === true)) {
      throw new Error("no successful production analysis Worker post/response pair was observed");
    }

    const geometry = [
      await geometrySmoke(cdp, 1440, 900),
      await geometrySmoke(cdp, 1920, 1080),
    ];
    return {
      initial,
      loaded,
      afterFen,
      afterSideChange,
      finalSnapshot,
      screenshots: [initialScreenshot, finalScreenshot],
      selectedPairs: {
        initial: pairSummary(initialPair),
        sideChange: pairSummary(sideChangePair),
        depthChange: pairSummary(depthChangePair),
      },
      workerPairs,
      workerConstructedUrls: constructedUrls,
      traceEventCount: trace.events.length,
      geometry,
      runtimeErrors,
    };
  });
}

function assertServedProductionRequests(requests, servedResponses) {
  const required = [
    "/index.html",
    "/review.css",
    "/dist/app.js",
    ...expectedWorkerPaths,
    "/dist/pkg/chess_wasm_bridge_embedded.mjs",
    "/assets/pieces/adr-0206-cburnett/white-king-v1.svg",
  ];
  for (const path of required) {
    if (!requests.includes(path)) throw new Error(`required browser request was not observed: ${path}`);
    if (!servedResponses.some((response) => response.pathname === path)) {
      throw new Error(`required browser request was not served with HTTP 200: ${path}`);
    }
  }
  if (requests.some((path) => path.endsWith(".wasm"))) {
    throw new Error(`browser requested a non-embedded .wasm asset: ${requests.join(", ")}`);
  }
  const appResponse = servedResponses.find((response) => response.pathname === "/dist/app.js");
  if (appResponse?.contentType !== "text/javascript; charset=utf-8") {
    throw new Error(`dist/app.js was not served as JavaScript: ${JSON.stringify(appResponse)}`);
  }
  const pieceResponse = servedResponses.find(
    (response) => response.pathname === "/assets/pieces/adr-0206-cburnett/white-king-v1.svg",
  );
  if (pieceResponse?.contentType !== "image/svg+xml") {
    throw new Error(`Cburnett piece was not served as SVG: ${JSON.stringify(pieceResponse)}`);
  }
}

function writeSummary(summary) {
  mkdirSync(proofRoot, { recursive: true });
  writeFileSync(join(proofRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  let serverInfo;
  try {
    prepareProofOutput();
    serverInfo = await startStaticServer(proofRoot, betaCsp);
    const browser = await runBrowserProof(
      `http://127.0.0.1:${serverInfo.port}/index.html`,
      await reserveLoopbackPort(),
    );
    assertServedProductionRequests(serverInfo.requests, serverInfo.servedResponses);
    const summary = {
      status: "PASS",
      proof: "selected-side Classical Explore with Aggressive On",
      source: "current working tree",
      proofRoot,
      url: `http://127.0.0.1:${serverInfo.port}/index.html`,
      productEntry: {
        html: "/index.html",
        script: "/dist/app.js",
        mount: "mountReviewApp",
        workerUrls: expectedWorkerUrls,
        embeddedWasm: "/dist/pkg/chess_wasm_bridge_embedded.mjs",
      },
      target: { fen: targetFen, sideToMove: targetSideToMove, aggressive: true },
      selectedPairs: browser.selectedPairs,
      worker: {
        constructedUrls: browser.workerConstructedUrls,
        successfulPairCount: browser.workerPairs.filter((pair) => pair.responseOk === true).length,
        traceEventCount: browser.traceEventCount,
      },
      ui: {
        loadedFen: browser.loaded.currentFen,
        finalSide: browser.finalSnapshot.reactionSide,
        finalDepth: browser.finalSnapshot.reactionDepth,
        finalSource: browser.finalSnapshot.reactionSource,
        finalStatus: browser.finalSnapshot.reactionStatus,
      },
      geometry: browser.geometry,
      browserErrors: browser.runtimeErrors,
      probes: [
        "product HTML and app entry response/structure",
        "both production Worker URLs and embedded WASM module HTTP 200",
        "production Cburnett SVG delivery, rendered piece, board orientation, localized board name, and recommendation geometry",
        "production initial/final screenshots at 1440x900",
        "real Worker post/response correlation by workerId/id",
        "production UI FEN load, Explore, selected-side change, and visible depth change",
        "exact FEN/side/aggressive request, UI depth/context dispatch, and DTO state match",
        "legacy marker/provider absence and page/worker runtime error absence",
      ],
      commands: commandsUsed,
      limitations: [
        "This proves the current checkout browser/runtime path, rendered Cburnett/orientation/recommendation surface, and real Worker/WASM delivery; it is not an engine-strength claim.",
        "The trace proves a real sideExplore redispatch associated with UI depth 3, but the current sideExplore context remains the same mode and the DTO reports depth 5 for both UI depth 1 and 3; changing the underlying search budget is outside this UI/proof fence.",
        "Geometry is a smoke check at the two requested desktop viewports, not a visual redesign review.",
      ],
    };
    writeSummary(summary);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    const summary = {
      status: "FAIL",
      proof: "selected-side Classical Explore with Aggressive On",
      source: "current working tree",
      proofRoot,
      failure,
      commands: commandsUsed,
    };
    writeSummary(summary);
    process.exitCode = 1;
  } finally {
    serverInfo?.server.close();
  }
}

await main();
