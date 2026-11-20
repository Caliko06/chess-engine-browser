import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join, relative } from "node:path";
import {
  assertWasmBindgenCliVersion,
  betaCsp,
  copyBuiltWeb,
  copyProductCss,
  copyProductHtml,
  repoRoot,
  run,
  scanStaticOutput,
  walk,
  writeEmbeddedWasmModule
} from "./beta-preview-support.mjs";
import {
  evaluate,
  evaluateJson,
  reserveLoopbackPort,
  runCdpProof,
  waitFor
} from "./browser-proof-support.mjs";
const proofRoot = "/private/tmp/chess-piece-candidate-sheet-proof";
const defaultSet = "adr-0206-cburnett-v1";
const retiredReviewSet = "adr-0108-staunton-v1";
const candidateSet = arg("--piece-candidate-set=");
const selfTest = arg("--self-test=");
const playCssPath = "apps/web/review.css";
const identitySquares = [
  ["white", "king", "e1"],
  ["white", "queen", "d1"],
  ["white", "rook", "a1"],
  ["white", "bishop", "c1"],
  ["white", "knight", "b1"],
  ["white", "pawn", "a2"],
  ["black", "king", "e8"],
  ["black", "queen", "d8"],
  ["black", "rook", "a8"],
  ["black", "bishop", "c8"],
  ["black", "knight", "b8"],
  ["black", "pawn", "a7"]
];
const setConfigs = new Map(
  [
    {
      candidateSet: defaultSet,
      manifestPath: "apps/web/assets/pieces/adr-0206-cburnett/manifest.json",
      status: "runtime-approved",
      assetKind: "svg",
      assetContentType: "image/svg+xml",
      requiresPromotionAdr: true,
      requiresSourceSheet: false,
      boardTheme: {
        light: "rgb(238, 238, 210)",
        dark: "rgb(118, 150, 86)"
      }
    }
  ].map((config) => [config.candidateSet, config])
);
const viewports = [
  { width: 1280, height: 900, label: "desktop" },
  { width: 390, height: 844, label: "narrow" }
];
const maxCandidatePieceBoxRatio = 0.94;

if (candidateSet === undefined || !setConfigs.has(candidateSet)) {
  throw new Error(`piece-candidate-set must be one of ${[...setConfigs.keys()].join(", ")}`);
}
const targetConfig = setConfigs.get(candidateSet);
const defaultConfig = setConfigs.get(defaultSet);
const manifest = JSON.parse(readFileSync(join(repoRoot, targetConfig.manifestPath), "utf8"));
const manifestIdentities = identitiesForManifest(manifest);
if (selfTest !== undefined) {
  runSelfTest(selfTest);
  process.exit(0);
}
const validated = validateManifest(manifest, targetConfig);
const targetIdentities = identitiesForManifest(validated);
const defaultValidated =
  targetConfig.candidateSet === defaultConfig.candidateSet
    ? validated
    : validateManifest(JSON.parse(readFileSync(join(repoRoot, defaultConfig.manifestPath), "utf8")), defaultConfig);
const defaultIdentities = identitiesForManifest(defaultValidated);
const assetDigests = digestManifestAssets(validated);
assertRetiredLegacyReviewCss(readFileSync(join(repoRoot, playCssPath), "utf8"));
prepareOutput();
const { server, requests, servedResponses, port } = await startPieceStaticServer(proofRoot, betaCsp);
let proofResults = [];
let runtimeChecks = [];
try {
  const proof = await runBrowserProof(`http://127.0.0.1:${port}/index.html`, requests);
  proofResults = proof.proofResults;
  runtimeChecks = proof.runtimeChecks;
} finally {
  server.close();
}
assertServedAssets(requests, servedResponses);
writeFileSync(join(proofRoot, "summary.json"), `${JSON.stringify(stableSummary({ proofResults, runtimeChecks, assetDigests }), null, 2)}\n`);
console.log("Piece runtime sheet browser proof passed.");
for (const result of proofResults) {
  console.log(
    `- ${result.viewport.label}: screenshot ${result.candidateScreenshot}, motion ${result.motion.move}, capture ${result.capture.captureScreenshot}`
  );
}
for (const check of runtimeChecks) {
  console.log(
    `- ${check.viewport.label} ${check.label}: pieceSet ${check.state.pieceSet}, reviewSet ${check.state.pieceReviewSet ?? "none"}, screenshot ${check.screenshot}`
  );
}

function arg(prefix) {
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value === undefined ? undefined : value.slice(prefix.length);
}

function runSelfTest(name) {
  if (name === "piece-request-leak") {
    expectRedFailure(name, () =>
      assertOnlyApprovedPieceAssetRequests(["/assets/pieces/adr-0108/white-king-review-v1.png"], manifestIdentities, "self-test")
    );
    return;
  }
  if (name === "missing-default-piece-set") {
    expectRedFailure(name, () =>
      assertApprovedPieceSetState(candidateStateFixture({ pieceSet: null }), { expectedReviewSet: null })
    );
    return;
  }
  if (name === "review-badge-leak") {
    expectRedFailure(name, () =>
      assertApprovedPieceSetState(candidateStateFixture({ reviewBadgeContent: '"Piece sheet review"' }), {
        expectedReviewSet: null
      })
    );
    return;
  }
  if (name === "legacy-query-leak") {
    expectRedFailure(name, () =>
      assertApprovedPieceSetState(
        candidateStateFixture({
          pieceSet: retiredReviewSet,
          pieceReviewSet: retiredReviewSet,
          reviewBadgeContent: '"Review-only piece candidate"'
        }),
        { expectedReviewSet: null }
      )
    );
    return;
  }
  if (name === "legacy-css-selector") {
    expectRedFailure(name, () =>
      assertRetiredLegacyReviewCss(`[data-piece-set="${retiredReviewSet}"] [data-play-ui="board-piece"] { font-size: 0; }`)
    );
    return;
  }
  if (name === "oversized-piece-box") {
    expectRedFailure(name, () =>
      assertApprovedPieceSetState(
        candidateStateFixture({
          issues: [{ kind: "piece-too-large", square: "e1", pieceRatio: 0.98 }]
        }),
        { expectedReviewSet: null }
      )
    );
    return;
  }
  if (name === "missing-occupied-marker") {
    expectRedFailure(name, () =>
      assertCaptureMarkerState(
        captureMarkerStateFixture({
          targetLegal: "false",
          targetColor: null,
          targetKind: null,
          legalDotExists: false
        })
      )
    );
    return;
  }
  if (name === "duplicate-motion-wrapper") {
    expectRedFailure(name, () => assertMotionState(motionStateFixture({ motionCount: 2 })));
    return;
  }
  if (name === "missing-drag-follower") {
    expectRedFailure(name, () => assertDragFollowerState(dragFollowerStateFixture({ followers: [] })));
    return;
  }
  const copy = JSON.parse(JSON.stringify(manifest));
  if (name === "bad-manifest-status") copy.status = "review-only";
  else if (name === "blocked-runtime-promotion") copy.runtimePromotion = "blocked pending approval";
  else if (name === "wrong-identity-count") copy.assets.pop();
  else if (name === "missing-asset") copy.assets[0].file = "apps/web/assets/pieces/adr-0137/missing-piece.png";
  else throw new Error(`unknown self-test ${name}`);
  expectRedFailure(name, () => validateManifest(copy, targetConfig));
}

function expectRedFailure(name, action) {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes(name) ||
      message.includes("candidate-asset-missing") ||
      message.includes("unexpected-piece-asset-request") ||
      message.includes("missing-default-piece-set") ||
      message.includes("review-badge-leak") ||
      message.includes("legacy-piece-css-selector") ||
      message.includes("bad-manifest-runtime-promotion-claim") ||
      message.includes("piece-too-large") ||
      message.includes("duplicate-motion-wrapper") ||
      message.includes("drag-follower") ||
      message.includes("capture-marker")
    ) {
      console.log(`RED self-test ${name} passed: ${message}`);
      return;
    }
    throw error;
  }
  throw new Error(`RED self-test ${name} did not fail`);
}

function validateManifest(candidateManifest, config) {
  if (candidateManifest.status !== config.status) throw new Error(`bad-manifest-status: ${candidateManifest.status}`);
  if (candidateManifest.candidateSet !== config.candidateSet) throw new Error(`candidate-set-mismatch: ${candidateManifest.candidateSet}`);
  if (config.requiresPromotionAdr && candidateManifest.promotionAdr !== "docs/adr/0207-play-flat-classic-theme-promotion.md") {
    throw new Error(`bad-manifest-promotion-adr: ${candidateManifest.promotionAdr}`);
  }
  const runtimePromotion = String(candidateManifest.runtimePromotion ?? "").toLowerCase();
  if (config.requiresPromotionAdr && (!runtimePromotion.includes("adr-0207") || runtimePromotion.includes("blocked"))) {
    throw new Error("bad-manifest-runtime-promotion-claim");
  }
  if (!config.requiresPromotionAdr && runtimePromotion.includes("approved")) {
    throw new Error("bad-manifest-runtime-promotion-claim");
  }
  if (config.requiresSourceSheet) {
    const sheet = assertPng(candidateManifest.sourceSheet.file, "source-sheet");
    if (sheet.width < 1000 || sheet.height < 600) throw new Error(`source-sheet-size: ${JSON.stringify(sheet)}`);
  }
  if (!Array.isArray(candidateManifest.assets) || candidateManifest.assets.length !== 12) {
    throw new Error(`wrong-identity-count: ${candidateManifest.assets?.length ?? "missing"}`);
  }
  const expectedKeys = new Set(identitySquares.map(([color, kind]) => `${color}:${kind}`));
  const actualKeys = new Set();
  for (const asset of candidateManifest.assets) {
    const key = `${asset.color}:${asset.kind}`;
    actualKeys.add(key);
    if (!expectedKeys.has(key)) throw new Error(`unexpected-identity: ${key}`);
    if (config.assetKind === "png") {
      const info = assertPng(asset.file, "candidate-asset");
      if (info.width !== 512 || info.height !== 512) throw new Error(`candidate-asset-size: ${asset.file}`);
    } else if (config.assetKind === "svg") {
      assertSvg(asset.file, asset.sha256);
    } else {
      throw new Error(`unsupported-asset-kind: ${config.assetKind}`);
    }
  }
  if (JSON.stringify([...actualKeys].sort()) !== JSON.stringify([...expectedKeys].sort())) {
    throw new Error(`wrong-identity-count: ${JSON.stringify([...actualKeys].sort())}`);
  }
  if (config.assetKind === "svg") {
    if (candidateManifest.author !== "Colin M.L. Burnett") throw new Error(`bad-svg-author: ${candidateManifest.author}`);
    if (!Array.isArray(candidateManifest.sourceUrls) || candidateManifest.sourceUrls.length !== 12) {
      throw new Error(`bad-svg-source-url-count: ${candidateManifest.sourceUrls?.length ?? "missing"}`);
    }
    const licenses = new Set(candidateManifest.license?.terms ?? []);
    for (const term of ["GPLv2+", "GFDL", "BSD", "CC-BY-SA"]) {
      if (!licenses.has(term)) throw new Error(`missing-svg-license: ${term}`);
    }
  }
  return candidateManifest;
}

function digestManifestAssets(candidateManifest) {
  return [
    ...(candidateManifest.sourceSheet?.file === undefined ? [] : [{ label: "source-sheet", file: candidateManifest.sourceSheet.file }]),
    ...candidateManifest.assets.map((asset) => ({ label: `${asset.color}-${asset.kind}`, file: asset.file }))
  ].map(({ label, file }) => {
    const bytes = readFileSync(join(repoRoot, file));
    return { label, file, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

function identitiesForManifest(candidateManifest) {
  return identitySquares.map(([color, kind, square]) => {
    const asset = candidateManifest.assets.find((entry) => entry.color === color && entry.kind === kind);
    if (asset === undefined) throw new Error(`missing-identity: ${color}:${kind}`);
    const fileName = asset.file.split("/").at(-1);
    return {
      color,
      kind,
      square,
      fileName,
      request: `/${asset.file.replace("apps/web/", "")}`
    };
  });
}

function assertPng(relativePath, label) {
  if (!relativePath.startsWith("apps/web/assets/pieces/") || relativePath.includes("..")) {
    throw new Error(`${label}-nonlocal-path: ${relativePath}`);
  }
  const path = join(repoRoot, relativePath);
  if (!existsSync(path)) throw new Error(`candidate-asset-missing: ${relativePath}`);
  const info = pngInfo(path);
  if (info.mode !== "RGBA" || info.corners.some((value) => value !== 0) || info.opaquePixels <= 1000) {
    throw new Error(`${label}-alpha-invalid: ${relativePath} ${JSON.stringify(info)}`);
  }
  return info;
}

function assertSvg(relativePath, expectedSha256) {
  if (!relativePath.startsWith("apps/web/assets/pieces/") || relativePath.includes("..")) {
    throw new Error(`candidate-asset-nonlocal-path: ${relativePath}`);
  }
  const path = join(repoRoot, relativePath);
  if (!existsSync(path)) throw new Error(`candidate-asset-missing: ${relativePath}`);
  const text = readFileSync(path, "utf8");
  if (!text.includes("<svg") || text.includes("<script") || text.includes("<image") || text.includes("base64")) {
    throw new Error(`candidate-svg-static-vector-invalid: ${relativePath}`);
  }
  if (typeof expectedSha256 !== "string" || expectedSha256.length !== 64) {
    throw new Error(`candidate-svg-missing-sha256: ${relativePath}`);
  }
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== expectedSha256) throw new Error(`candidate-svg-sha256-mismatch: ${relativePath}`);
}
function pngInfo(path) {
  const code = [
    "from PIL import Image",
    "import json, sys",
    "im=Image.open(sys.argv[1]).convert('RGBA')",
    "w,h=im.size; px=im.load(); a=im.getchannel('A')",
    "corners=[px[0,0][3],px[w-1,0][3],px[0,h-1][3],px[w-1,h-1][3]]",
    "opaque=sum(1 for v in a.getdata() if v>220)",
    "print(json.dumps({'width':w,'height':h,'mode':'RGBA','corners':corners,'opaquePixels':opaque}))"
  ].join("\n");
  const result = spawnSync("python3", ["-c", code, path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`png-info-failed: ${path} ${result.stderr}`);
  return JSON.parse(result.stdout);
}
function prepareOutput() {
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(join(proofRoot, "dist/pkg"), { recursive: true });
  run("node", ["scripts/audit-policy.mjs"]);
  run("pnpm", ["--filter", "web", "run", "build"]);
  assertWasmBindgenCliVersion("piece candidate sheet proof");
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
    missingMessage: "piece candidate product HTML is missing",
    scanBeforeChecks: true,
    cspCheck: "meta",
    cspMismatchMessage: (metaCsp) => `piece candidate CSP mismatch: ${metaCsp}`,
    requiredIncludes: [
      { text: 'id="chess-review-app"', message: "product root is missing" },
      { text: 'href="./review.css"', message: "stylesheet href is missing" },
      { text: 'src="./dist/app.js"', message: "app entrypoint is missing" }
    ]
  });
  installPieceProofBestMoveProvider(proofRoot);
  copyProductCss(proofRoot, { missingMessage: "Play stylesheet is missing" });
  scanStaticOutput(proofRoot, { extraForbiddenTokens: ['<script type="importmap"', "ServiceWorker"] });
}

function installPieceProofBestMoveProvider(outputRoot) {
  writeFileSync(
    join(outputRoot, "piece-proof-best-move-provider.js"),
    [
      "const calls = [];",
      "Object.defineProperty(globalThis, '__pieceProofBestMoveCalls', { configurable: true, value: calls });",
      "Object.defineProperty(globalThis, '__chessPlayBestMoveProvider', {",
      "  configurable: true,",
      "  value: {",
      "    isAvailable: () => true,",
      "    bestMove: async (_fen, depth, legalMoves = []) => {",
      "      calls.push({ depth, legalMoves });",
      "      const preferred = ['b8c6', 'g8f6'].find((move) => legalMoves.includes(move));",
      "      const bestMove = preferred ?? legalMoves[0] ?? null;",
      "      return { ok: true, value: { bestMove, depth, scoreCp: 0, nodes: 1, ttHits: 0 } };",
      "    }",
      "  }",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
  const htmlPath = join(outputRoot, "index.html");
  const html = readFileSync(htmlPath, "utf8");
  const appScript = '    <script type="module" src="./dist/app.js"></script>';
  if (!html.includes(appScript)) throw new Error("piece proof app script tag missing");
  writeFileSync(
    htmlPath,
    html.replace(appScript, '    <script type="module" src="./piece-proof-best-move-provider.js"></script>\n' + appScript),
    "utf8"
  );
}
async function runBrowserProof(baseUrl, requests) {
  return runCdpProof(proofRoot, await reserveLoopbackPort(), async (cdp) => {
    const results = [];
    const runtimeChecks = [];
    const candidateUrl =
      targetConfig.candidateSet === defaultConfig.candidateSet
        ? baseUrl
        : `${baseUrl}?generatedPieceReview=${targetConfig.candidateSet}`;
    const expectedCandidateReviewSet =
      targetConfig.candidateSet === defaultConfig.candidateSet ? null : targetConfig.candidateSet;
    for (const viewport of viewports) {
      await setViewport(cdp, viewport);
      const badQueryStart = requests.length;
      runtimeChecks.push(
        await runApprovedRuntime(cdp, `${baseUrl}?generatedPieceReview=unknown`, viewport, "bad-query-default", null, defaultConfig, defaultIdentities)
      );
      const badQueryRequests = requests.slice(badQueryStart);
      assertOnlyApprovedPieceAssetRequests(badQueryRequests, defaultIdentities, `${viewport.label}-bad-query`);
      const legacyQueryStart = requests.length;
      runtimeChecks.push(
        await runApprovedRuntime(
          cdp,
          `${baseUrl}?generatedPieceReview=${retiredReviewSet}`,
          viewport,
          "legacy-query-default",
          null,
          defaultConfig,
          defaultIdentities
        )
      );
      const legacyQueryRequests = requests.slice(legacyQueryStart);
      assertOnlyApprovedPieceAssetRequests(legacyQueryRequests, defaultIdentities, `${viewport.label}-legacy-query`);
      const defaultStart = requests.length;
      runtimeChecks.push(await runApprovedRuntime(cdp, baseUrl, viewport, "default-runtime", null, defaultConfig, defaultIdentities));
      const defaultRequests = requests.slice(defaultStart);
      assertOnlyApprovedPieceAssetRequests(defaultRequests, defaultIdentities, `${viewport.label}-default`);
      results.push(await runCandidate(cdp, candidateUrl, viewport, expectedCandidateReviewSet, targetConfig, targetIdentities));
      runtimeChecks.push(
        await runApprovedRuntime(
          cdp,
          `${baseUrl}?generatedPieceReview=${targetConfig.candidateSet}`,
          viewport,
          "query-review-marker",
          targetConfig.candidateSet,
          targetConfig,
          targetIdentities
        )
      );
    }
    for (const result of results) {
      await setViewport(cdp, result.viewport);
      result.capture = await runCaptureMarker(cdp, candidateUrl, result.viewport, targetIdentities);
    }
    return { proofResults: results, runtimeChecks };
  });
}

async function setViewport(cdp, viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
}

async function mount(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64", "play board did not mount");
  await waitFor(cdp, "Array.from(document.styleSheets).some((sheet) => sheet.href?.endsWith('/review.css'))", "stylesheet did not load");
}

async function runApprovedRuntime(cdp, url, viewport, label, expectedReviewSet, config, identities) {
  await mount(cdp, url);
  const state = await evaluateJson(cdp, snapshotExpression(viewport, label, config, identities));
  assertApprovedPieceSetState(state, { expectedReviewSet, config });
  const runtimeScreenshot = await screenshot(cdp, `${label}-${viewport.label}.png`);
  return { label, viewport, state, screenshot: runtimeScreenshot };
}

async function runCandidate(cdp, url, viewport, expectedReviewSet, config, identities) {
  await mount(cdp, url);
  const initial = await evaluateJson(cdp, snapshotExpression(viewport, "candidate-initial", config, identities));
  assertApprovedPieceSetState(initial, { expectedReviewSet, config });
  await click(cdp, "e2");
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"board-square\"][data-square=\"e4\"]')?.getAttribute('data-board-legal-target') === 'true'", `${viewport.label} legal target did not render`);
  const selected = await evaluateJson(cdp, snapshotExpression(viewport, "candidate-selected", config, identities));
  if (selected.e4Legal !== "true" || selected.issues.length > 0) throw new Error(`candidate-selected-proof-failed: ${JSON.stringify(selected)}`);
  const dragFollower = await dragWithFollowerSample(cdp, "e2", "e4", viewport);
  assertDragFollowerState(dragFollower, identities);
  const motion = await waitForMotion(cdp, viewport, identities);
  const motionScreenshot = await screenshot(cdp, `candidate-motion-${viewport.label}.png`);
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 2", `${viewport.label} engine reply did not complete`);
  const afterMove = await evaluateJson(cdp, snapshotExpression(viewport, "candidate-after-move", config, identities));
  if (afterMove.fen === initial.fen || afterMove.lastMoveSquares.length !== 2 || afterMove.issues.length > 0) {
    throw new Error(`candidate-after-move-proof-failed: ${JSON.stringify(afterMove)}`);
  }
  await clickNewGame(cdp);
  await waitFor(cdp, "document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 0", "new game did not reset moves");
  const reset = await evaluateJson(cdp, snapshotExpression(viewport, "candidate-reset", config, identities));
  assertApprovedPieceSetState(reset, { expectedReviewSet, config });
  const candidateScreenshot = await screenshot(cdp, `candidate-${viewport.label}.png`);
  return { viewport, initial, selected, dragFollower, motion, afterMove, reset, candidateScreenshot, motionScreenshot };
}

async function runCaptureMarker(cdp, url, viewport, identities) {
  await mount(cdp, url);
  await click(cdp, "b1");
  await waitFor(cdp, "document.querySelector('[data-play-ui=\"board-square\"][data-square=\"a3\"]')?.getAttribute('data-board-legal-target') === 'true'", `${viewport.label} capture setup a3 target did not render`);
  await click(cdp, "a3");
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 2 && document.querySelector('[data-play-ui=\"board-square\"][data-square=\"a3\"]')?.getAttribute('data-board-piece-kind') === 'knight' && document.querySelector('[data-play-ui=\"board-square\"][data-square=\"c6\"]')?.getAttribute('data-board-piece-color') === 'black'",
    `${viewport.label} owned b8c6 reply did not complete`
  );
  await click(cdp, "a3");
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"board-square\"][data-square=\"b5\"]')?.getAttribute('data-board-legal-target') === 'true'",
    `${viewport.label} capture setup b5 target did not render`
  );
  await click(cdp, "b5");
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-play-ui=\"move-row\"]').length === 4 && document.querySelector('[data-play-ui=\"board-square\"][data-square=\"b5\"]')?.getAttribute('data-board-piece-kind') === 'knight' && document.querySelector('[data-play-ui=\"board-square\"][data-square=\"f6\"]')?.getAttribute('data-board-piece-color') === 'black'",
    `${viewport.label} owned g8f6 reply did not complete`
  );
  await click(cdp, "b5");
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"board-square\"][data-square=\"c7\"]')?.getAttribute('data-board-legal-target') === 'true'",
    `${viewport.label} occupied capture marker did not render`
  );
  const capture = await evaluateJson(cdp, captureMarkerExpression(viewport));
  assertCaptureMarkerState(capture, identities);
  const captureScreenshot = await screenshot(cdp, `candidate-capture-${viewport.label}.png`);
  return { ...capture, captureScreenshot };
}

function snapshotExpression(viewport, label, config, identities) {
  return `(() => {
    const issues = [], pieces = ${JSON.stringify(identities)};
    const pieceSet = document.querySelector('[data-piece-set]')?.getAttribute('data-piece-set') ?? null;
    const pieceReviewSet = document.querySelector('[data-piece-review-set]')?.getAttribute('data-piece-review-set') ?? null;
    const header = document.querySelector('[data-play-ui="header"]');
    const reviewBadgeContent = header instanceof HTMLElement ? getComputedStyle(header, "::after").content : null;
    const board = document.querySelector('[data-play-ui="board"]'), grid = document.querySelector('[data-play-ui="board-grid"]');
    const lightSquare = document.querySelector('[data-play-ui="board-square"][data-board-shade="light"]');
    const darkSquare = document.querySelector('[data-play-ui="board-square"][data-board-shade="dark"]');
    const lightStyle = lightSquare instanceof HTMLElement ? getComputedStyle(lightSquare) : null;
    const darkStyle = darkSquare instanceof HTMLElement ? getComputedStyle(darkSquare) : null;
    const squares = Array.from(document.querySelectorAll('[data-play-ui="board-square"]'));
    const visible = (element, selector) => {
      if (!(element instanceof HTMLElement)) { issues.push({ kind: "missing", selector }); return null; }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) issues.push({ kind: "zero", selector });
      if (rect.left < -1 || rect.right > window.innerWidth + 1) issues.push({ kind: "horizontal-overflow", selector, left: rect.left, right: rect.right });
      return rect;
    };
    const gridRect = visible(grid, "board-grid"); visible(board, "board");
    if (squares.length !== 64) issues.push({ kind: "square-count", count: squares.length });
    if (gridRect === null || Math.abs(gridRect.width - gridRect.height) > 2) issues.push({ kind: "grid-not-square", rect: gridRect });
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    if (pageWidth > window.innerWidth + 1) issues.push({ kind: "page-overflow", pageWidth, viewportWidth: window.innerWidth });
    for (const element of document.querySelectorAll('[data-play-ui="status"], [data-play-ui="new-game-button"], [data-play-ui="move-row"], [data-play-ui="current-fen"] dd, [data-play-ui="last-move"] dd')) {
      if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1) issues.push({ kind: "text-overflow", ui: element.getAttribute("data-play-ui") ?? element.tagName });
    }
    for (const square of squares) {
      const piece = square.querySelector(':scope > [data-play-ui="board-piece"]');
      if (piece instanceof HTMLElement) {
        const pieceRect = piece.getBoundingClientRect(), squareRect = square.getBoundingClientRect();
        if (pieceRect.width > squareRect.width + 1 || pieceRect.height > squareRect.height + 1) issues.push({ kind: "piece-overflow", square: square.getAttribute("data-square"), pieceRect, squareRect });
        const pieceRatio = Math.max(pieceRect.width / squareRect.width, pieceRect.height / squareRect.height);
        if (pieceSet === ${JSON.stringify(config.candidateSet)} && pieceRatio > ${String(maxCandidatePieceBoxRatio)}) issues.push({ kind: "piece-too-large", square: square.getAttribute("data-square"), pieceRatio, pieceRect, squareRect });
      }
    }
    const candidateMatches = pieces.map((piece) => {
      const element = document.querySelector('[data-play-ui="board-square"][data-square="' + piece.square + '"] > [data-play-ui="board-piece"]');
      const style = element instanceof HTMLElement ? getComputedStyle(element) : null;
      return { square: piece.square, fileName: piece.fileName, matches: style !== null && style.backgroundImage.includes(piece.fileName), fontSize: style?.fontSize ?? null, backgroundSize: style?.backgroundSize ?? null };
    });
    const pieceAssetBackgrounds = Array.from(document.querySelectorAll('[data-play-ui="board-piece"]'), (piece) => {
      const style = piece instanceof HTMLElement ? getComputedStyle(piece) : null;
      return { square: piece.closest('[data-play-ui="board-square"]')?.getAttribute('data-square') ?? null, backgroundImage: style?.backgroundImage ?? "none" };
    }).filter((entry) => entry.backgroundImage.includes('/assets/pieces/'));
    return JSON.stringify({
      label: ${JSON.stringify(label)}, expectedViewport: ${JSON.stringify(viewport)}, actualViewport: { width: window.innerWidth, height: window.innerHeight },
      pieceSet, pieceReviewSet, reviewBadgeContent,
      boardTheme: {
        lightBackgroundColor: lightStyle?.backgroundColor ?? null,
        lightBackgroundImage: lightStyle?.backgroundImage ?? null,
        darkBackgroundColor: darkStyle?.backgroundColor ?? null,
        darkBackgroundImage: darkStyle?.backgroundImage ?? null
      },
      squares: squares.length, occupied: squares.filter((square) => square.getAttribute('data-board-piece') !== null).length,
      glyphPieces: Array.from(document.querySelectorAll('[data-play-ui="board-square"] > [data-play-ui="board-piece"]')).filter((piece) => piece.textContent.trim().length > 0 && getComputedStyle(piece).fontSize !== '0px').length,
      candidateMatches, pieceAssetBackgrounds, e4Legal: document.querySelector('[data-play-ui="board-square"][data-square="e4"]')?.getAttribute('data-board-legal-target') ?? null,
      fen: document.querySelector('[data-play-ui="current-fen"] dd')?.textContent?.trim() ?? "", lastMove: document.querySelector('[data-play-ui="last-move"] dd')?.textContent?.trim() ?? "",
      lastMoveSquares: Array.from(document.querySelectorAll('[data-play-ui="board-square"][data-board-last-move="true"]'), (square) => square.getAttribute('data-square')),
      moveRows: Array.from(document.querySelectorAll('[data-play-ui="move-row"]'), (row) => row.getAttribute('data-play-actor')), issues
    });
  })()`;
}

function hasReviewBadge(state) {
  return (
    typeof state.reviewBadgeContent === "string" &&
    state.reviewBadgeContent !== "none" &&
    state.reviewBadgeContent !== "normal" &&
    state.reviewBadgeContent !== '""'
  );
}

function assertApprovedPieceSetState(state, { expectedReviewSet, config = targetConfig }) {
  if (state.pieceSet !== config.candidateSet) {
    throw new Error(`missing-default-piece-set: ${JSON.stringify(state)}`);
  }
  if (expectedReviewSet === null && (state.pieceReviewSet !== null || hasReviewBadge(state))) {
    throw new Error(`review-badge-leak: ${JSON.stringify(state)}`);
  }
  if (expectedReviewSet !== null && (state.pieceReviewSet !== expectedReviewSet || !hasReviewBadge(state))) {
    throw new Error(`review-badge-missing: ${JSON.stringify(state)}`);
  }
  if (config.boardTheme !== null) {
    if (
      state.boardTheme.lightBackgroundColor !== config.boardTheme.light ||
      state.boardTheme.darkBackgroundColor !== config.boardTheme.dark ||
      state.boardTheme.lightBackgroundImage !== "none" ||
      state.boardTheme.darkBackgroundImage !== "none"
    ) {
      throw new Error(`board-theme-proof-failed: ${JSON.stringify(state.boardTheme)}`);
    }
  }
  if (
    state.actualViewport.width !== state.expectedViewport.width ||
    state.actualViewport.height !== state.expectedViewport.height ||
    state.squares !== 64 ||
    state.occupied !== 32 ||
    state.glyphPieces !== 0 ||
    state.issues.length > 0 ||
    state.candidateMatches.some((match) => !match.matches || match.fontSize !== "0px" || !match.backgroundSize.includes("contain"))
  ) {
    throw new Error(`approved-piece-set-state-proof-failed: ${JSON.stringify(state)}`);
  }
}

function candidateStateFixture(overrides = {}) {
  const viewport = { width: 390, height: 844, label: "self-test" };
  return {
    label: "self-test",
    expectedViewport: viewport,
    actualViewport: { width: viewport.width, height: viewport.height },
    pieceSet: targetConfig.candidateSet,
    pieceReviewSet: null,
    reviewBadgeContent: "none",
    boardTheme: {
      lightBackgroundColor: targetConfig.boardTheme?.light ?? "rgb(234, 223, 202)",
      lightBackgroundImage: targetConfig.boardTheme === null ? 'url("/assets/board/adr-0106/light-square.jpg")' : "none",
      darkBackgroundColor: targetConfig.boardTheme?.dark ?? "rgb(142, 163, 111)",
      darkBackgroundImage: targetConfig.boardTheme === null ? 'url("/assets/board/adr-0106/dark-square.jpg")' : "none"
    },
    squares: 64,
    occupied: 32,
    glyphPieces: 0,
    candidateMatches: manifestIdentities.map((identity) => ({
      square: identity.square,
      fileName: identity.fileName,
      matches: true,
      fontSize: "0px",
      backgroundSize: "contain"
    })),
    pieceAssetBackgrounds: manifestIdentities.map((identity) => ({
      square: identity.square,
      backgroundImage: `url("${identity.request}")`
    })),
    e4Legal: "false",
    fen: "",
    lastMove: "",
    lastMoveSquares: [],
    moveRows: [],
    issues: [],
    ...overrides
  };
}

async function waitForMotion(cdp, viewport, identities) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await evaluateJson(cdp, motionExpression(viewport));
    if (state.exists === true) {
      assertMotionState(state, identities);
      return state;
    }
    await sleep(40);
  }
  const debug = await evaluateJson(cdp, snapshotExpression(viewport, "motion-timeout", targetConfig, identities));
  throw new Error(`${viewport.label} engine move motion did not render: ${JSON.stringify(debug)}`);
}

function motionExpression(viewport) {
  return `(() => {
    const motions = Array.from(document.querySelectorAll('[data-play-ui="board-motion-piece"]'))
      .filter((entry) => entry instanceof HTMLElement);
    const motion = motions[0];
    if (!(motion instanceof HTMLElement)) return JSON.stringify({ exists: false, motionCount: motions.length, viewport: ${JSON.stringify(viewport)} });
    const inner = motion.querySelector(':scope > [data-play-ui="board-piece"]'), fromSquare = motion.closest('[data-play-ui="board-square"]');
    const toSquare = document.querySelector('[data-play-ui="board-square"][data-square="' + motion.getAttribute('data-board-motion-to') + '"]');
    const motionStyle = getComputedStyle(motion), innerStyle = inner instanceof HTMLElement ? getComputedStyle(inner) : null;
    return JSON.stringify({
      exists: true, viewport: ${JSON.stringify(viewport)}, actor: motion.getAttribute('data-board-motion-actor'),
      motionCount: motions.length,
      move: motion.getAttribute('data-board-motion-move'), color: motion.getAttribute('data-board-piece-color'), kind: motion.getAttribute('data-board-piece-kind'),
      wrapperBackgroundImage: motionStyle.backgroundImage, wrapperBackgroundColor: motionStyle.backgroundColor,
      innerBackgroundImage: innerStyle?.backgroundImage ?? null, innerFontSize: innerStyle?.fontSize ?? null, innerBackgroundSize: innerStyle?.backgroundSize ?? null,
      innerRect: inner instanceof HTMLElement ? inner.getBoundingClientRect() : null, squareRect: fromSquare instanceof HTMLElement ? fromSquare.getBoundingClientRect() : null,
      fromSquareBackground: fromSquare instanceof HTMLElement ? getComputedStyle(fromSquare).backgroundImage : null,
      toSquareBackground: toSquare instanceof HTMLElement ? getComputedStyle(toSquare).backgroundImage : null
    });
  })()`;
}

function assertMotionState(state, identities = manifestIdentities) {
  if (state.motionCount !== 1) {
    throw new Error(`duplicate-motion-wrapper: ${JSON.stringify(state)}`);
  }
  const expectedFile = identities.find((identity) => identity.color === state.color && identity.kind === state.kind)?.fileName;
  if (expectedFile === undefined) {
    throw new Error(`candidate-motion-identity-missing: ${JSON.stringify(state)}`);
  }
  const widthRatio = state.innerRect.width / state.squareRect.width;
  const heightRatio = state.innerRect.height / state.squareRect.height;
  if (
    state.actor !== "engine" ||
    state.wrapperBackgroundImage !== "none" ||
    !state.wrapperBackgroundColor.endsWith(", 0)") ||
    !state.innerBackgroundImage.includes(expectedFile) ||
    state.innerFontSize !== "0px" ||
    !state.innerBackgroundSize.includes("contain") ||
    widthRatio > maxCandidatePieceBoxRatio ||
    heightRatio > maxCandidatePieceBoxRatio ||
    state.fromSquareBackground.includes("/assets/pieces/") ||
    state.toSquareBackground.includes("/assets/pieces/")
  ) {
    throw new Error(`candidate-motion-wrapper-proof-failed: ${JSON.stringify(state)}`);
  }
}

async function dragWithFollowerSample(cdp, fromSquare, toSquare, viewport) {
  const from = await squarePoint(cdp, fromSquare);
  const to = await squarePoint(cdp, toSquare);
  const steps = 8;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    button: "left",
    buttons: 1,
    clickCount: 1
  });
  let state = null;
  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
      button: "left",
      buttons: 1
    });
    if (index === Math.ceil(steps / 2)) {
      state = await evaluateJson(cdp, dragFollowerExpression(viewport, fromSquare));
    }
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.x,
    y: to.y,
    button: "left",
    buttons: 0,
    clickCount: 1
  });
  return state ?? (await evaluateJson(cdp, dragFollowerExpression(viewport, fromSquare)));
}

function dragFollowerExpression(viewport, sourceSquare) {
  return `(() => {
    const source = document.querySelector('[data-play-ui="board-square"][data-square="${sourceSquare}"]');
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
        rect: rect === null ? null : { width: rect.width, height: rect.height },
        innerBackgroundImage: innerStyle?.backgroundImage ?? null,
        innerBackgroundSize: innerStyle?.backgroundSize ?? null,
        innerFontSize: innerStyle?.fontSize ?? null,
        innerRect: innerRect === null ? null : { width: innerRect.width, height: innerRect.height }
      };
    });
    return JSON.stringify({
      viewport: ${JSON.stringify(viewport)},
      sourceSquare: source instanceof HTMLElement ? source.getAttribute('data-square') : null,
      sourceDragActive: source instanceof HTMLElement ? source.getAttribute('data-board-drag-active') : null,
      sourceDragging: source instanceof HTMLElement ? source.getAttribute('data-board-dragging') : null,
      sourcePieceOpacity: sourcePieceStyle?.opacity ?? null,
      sourceBackgroundImage: sourceStyle?.backgroundImage ?? null,
      draggingSquares: Array.from(document.querySelectorAll('[data-play-ui="board-square"][data-board-dragging="true"]'), (square) => square.getAttribute('data-square')),
      followers
    });
  })()`;
}

function assertDragFollowerState(state, identities = manifestIdentities) {
  if (
    state.sourceSquare !== "e2" ||
    state.sourceDragActive !== "true" ||
    state.sourceDragging !== "true" ||
    state.sourcePieceOpacity !== "0" ||
    JSON.stringify(state.draggingSquares) !== JSON.stringify(["e2"])
  ) {
    throw new Error(`drag-follower-source-proof-failed: ${JSON.stringify(state)}`);
  }
  if (typeof state.sourceBackgroundImage === "string" && state.sourceBackgroundImage.includes("/assets/pieces/")) {
    throw new Error(`drag-follower-square-leak: ${JSON.stringify(state)}`);
  }
  if (state.followers.length !== 1) {
    throw new Error(`drag-follower-count-proof-failed: ${JSON.stringify(state)}`);
  }
  const [follower] = state.followers;
  const expectedFile = identities.find((identity) => identity.color === "white" && identity.kind === "pawn")?.fileName;
  if (expectedFile === undefined) throw new Error(`drag-follower-identity-missing: ${JSON.stringify(state)}`);
  if (
    follower.from !== "e2" ||
    follower.color !== "white" ||
    follower.kind !== "pawn" ||
    follower.backgroundImage !== "none" ||
    typeof follower.backgroundColor !== "string" ||
    !follower.backgroundColor.endsWith(", 0)") ||
    follower.borderTopWidth !== "0px" ||
    follower.boxShadow !== "none" ||
    follower.pointerEvents !== "none" ||
    follower.rect === null ||
    follower.innerRect === null ||
    follower.innerBackgroundImage === null ||
    !follower.innerBackgroundImage.includes(expectedFile) ||
    follower.innerFontSize !== "0px" ||
    typeof follower.innerBackgroundSize !== "string" ||
    !follower.innerBackgroundSize.includes("contain") ||
    follower.rect.width <= 0 ||
    follower.rect.height <= 0 ||
    follower.innerRect.width <= 0 ||
    follower.innerRect.height <= 0
  ) {
    throw new Error(`drag-follower-piece-only-proof-failed: ${JSON.stringify(follower)}`);
  }
  const widthRatio = follower.innerRect.width / follower.rect.width;
  const heightRatio = follower.innerRect.height / follower.rect.height;
  if (widthRatio > maxCandidatePieceBoxRatio || heightRatio > maxCandidatePieceBoxRatio) {
    throw new Error(`drag-follower-scale-proof-failed: ${JSON.stringify(follower)}`);
  }
}

function dragFollowerStateFixture(overrides = {}) {
  const whitePawn = manifestIdentities.find((identity) => identity.color === "white" && identity.kind === "pawn");
  return {
    viewport: { width: 390, height: 844, label: "self-test" },
    sourceSquare: "e2",
    sourceDragActive: "true",
    sourceDragging: "true",
    sourcePieceOpacity: "0",
    sourceBackgroundImage: 'url("/assets/board/adr-0106/light-square.jpg")',
    draggingSquares: ["e2"],
    followers: [
      {
        from: "e2",
        color: "white",
        kind: "pawn",
        text: "",
        backgroundImage: "none",
        backgroundColor: "rgba(0, 0, 0, 0)",
        borderTopWidth: "0px",
        boxShadow: "none",
        pointerEvents: "none",
        rect: { width: 42, height: 42 },
        innerBackgroundImage: `url("${whitePawn?.request ?? "/assets/pieces/missing/white-pawn.png"}")`,
        innerBackgroundSize: "contain",
        innerFontSize: "0px",
        innerRect: { width: 42, height: 42 }
      }
    ],
    ...overrides
  };
}

function motionStateFixture(overrides = {}) {
  const blackKnight = manifestIdentities.find((identity) => identity.color === "black" && identity.kind === "knight");
  return {
    exists: true,
    viewport: { width: 390, height: 844, label: "self-test" },
    actor: "engine",
    motionCount: 1,
    move: "b8c6",
    color: "black",
    kind: "knight",
    wrapperBackgroundImage: "none",
    wrapperBackgroundColor: "rgba(0, 0, 0, 0)",
    innerBackgroundImage: `url("${blackKnight?.request ?? "/assets/pieces/missing/black-knight.png"}")`,
    innerFontSize: "0px",
    innerBackgroundSize: "contain",
    innerRect: { width: 36, height: 36 },
    squareRect: { width: 42, height: 42 },
    fromSquareBackground: 'url("/assets/board/adr-0106/dark-square.jpg")',
    toSquareBackground: 'url("/assets/board/adr-0106/light-square.jpg")',
    ...overrides
  };
}

function captureMarkerExpression(viewport) {
  return `(() => {
    const square = document.querySelector('[data-play-ui="board-square"][data-square="c7"]');
    const selected = document.querySelector('[data-play-ui="board-square"][data-square="b5"]');
    const piece = square?.querySelector(':scope > [data-play-ui="board-piece"]');
    const legalDot = square?.querySelector(':scope > [data-play-ui="legal-dot"]');
    const squareRect = square instanceof HTMLElement ? square.getBoundingClientRect() : null;
    const pieceRect = piece instanceof HTMLElement ? piece.getBoundingClientRect() : null;
    const legalDotRect = legalDot instanceof HTMLElement ? legalDot.getBoundingClientRect() : null;
    const pieceStyle = piece instanceof HTMLElement ? getComputedStyle(piece) : null;
    const legalDotStyle = legalDot instanceof HTMLElement ? getComputedStyle(legalDot) : null;
    return JSON.stringify({
      viewport: ${JSON.stringify(viewport)},
      selectedSquare: selected instanceof HTMLElement ? selected.getAttribute('data-board-selected') : null,
      targetLegal: square instanceof HTMLElement ? square.getAttribute('data-board-legal-target') : null,
      targetColor: square instanceof HTMLElement ? square.getAttribute('data-board-piece-color') : null,
      targetKind: square instanceof HTMLElement ? square.getAttribute('data-board-piece-kind') : null,
      pieceBackgroundImage: pieceStyle?.backgroundImage ?? null,
      pieceFontSize: pieceStyle?.fontSize ?? null,
      pieceZIndex: pieceStyle?.zIndex ?? null,
      legalDotExists: legalDot instanceof HTMLElement,
      legalDotZIndex: legalDotStyle?.zIndex ?? null,
      squareRect,
      pieceRect,
      legalDotRect
    });
  })()`;
}

function stableSummary(value) {
  return JSON.parse(JSON.stringify(value).replaceAll(/http:\/\/127\.0\.0\.1:\d+\//g, "/"));
}

function assertCaptureMarkerState(state, identities = manifestIdentities) {
  if (state.squareRect === null || state.pieceRect === null || state.legalDotRect === null) {
    throw new Error(`capture-marker-proof-failed: ${JSON.stringify(state)}`);
  }
  const blackPawn = identities.find((identity) => identity.color === "black" && identity.kind === "pawn")?.fileName;
  if (blackPawn === undefined) throw new Error(`capture-marker-identity-missing: ${JSON.stringify(state)}`);
  const dotWidthRatio = state.legalDotRect.width / state.squareRect.width;
  const dotHeightRatio = state.legalDotRect.height / state.squareRect.height;
  if (
    state.selectedSquare !== "true" ||
    state.targetLegal !== "true" ||
    state.targetColor !== "black" ||
    state.targetKind !== "pawn" ||
    !state.legalDotExists ||
    !state.pieceBackgroundImage.includes(blackPawn) ||
    state.pieceFontSize !== "0px" ||
    Number.parseInt(state.legalDotZIndex, 10) <= Number.parseInt(state.pieceZIndex, 10) ||
    dotWidthRatio < 0.6 ||
    dotWidthRatio > 0.75 ||
    dotHeightRatio < 0.6 ||
    dotHeightRatio > 0.75
  ) {
    throw new Error(`capture-marker-proof-failed: ${JSON.stringify(state)}`);
  }
}

function captureMarkerStateFixture(overrides = {}) {
  const blackPawn = manifestIdentities.find((identity) => identity.color === "black" && identity.kind === "pawn");
  return {
    viewport: { width: 390, height: 844, label: "self-test" },
    selectedSquare: "true",
    targetLegal: "true",
    targetColor: "black",
    targetKind: "pawn",
    pieceBackgroundImage: `url("${blackPawn?.request ?? "/assets/pieces/missing/black-pawn.png"}")`,
    pieceFontSize: "0px",
    pieceZIndex: "1",
    legalDotExists: true,
    legalDotZIndex: "2",
    squareRect: { width: 39, height: 39 },
    pieceRect: { width: 36, height: 36 },
    legalDotRect: { width: 26.5, height: 26.5 },
    ...overrides
  };
}

async function click(cdp, square) {
  const point = await squarePoint(cdp, square);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function squarePoint(cdp, square) {
  const point = await evaluateJson(
    cdp,
    `(() => { const square = document.querySelector('[data-play-ui="board-square"][data-square="${square}"]'); if (!(square instanceof HTMLElement)) return JSON.stringify(null); const rect = square.getBoundingClientRect(); return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }); })()`
  );
  if (point === null) throw new Error(`could not find square ${square}`);
  return point;
}

async function clickNewGame(cdp) {
  const ok = await evaluate(cdp, '(() => { const button = document.querySelector(\'[data-play-ui="new-game-button"]\'); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()');
  if (ok !== true) throw new Error("could not click New Game");
}

async function screenshot(cdp, fileName) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true });
  const path = join(proofRoot, fileName);
  writeFileSync(path, result.data, "base64");
  return path;
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function assertOnlyApprovedPieceAssetRequests(stepRequests, identities, label) {
  const expectedRequests = new Set(identities.map((identity) => identity.request));
  const leaked = stepRequests.filter(
    (request) => request.startsWith("/assets/pieces/") && !expectedRequests.has(request)
  );
  if (leaked.length > 0) throw new Error(`unexpected-piece-asset-request: ${label} ${leaked.join(", ")}`);
}

function assertRetiredLegacyReviewCss(cssText) {
  const retiredSelectors = [
    `data-piece-set="${retiredReviewSet}"`,
    `data-piece-review-set="${retiredReviewSet}"`
  ];
  const matched = retiredSelectors.filter((selector) => cssText.includes(selector));
  if (matched.length > 0) throw new Error(`legacy-piece-css-selector: ${matched.join(", ")}`);
}

function assertServedAssets(requests, servedResponses) {
  if (!requests.includes("/review.css")) throw new Error(`piece proof did not request review.css: ${requests.join(", ")}`);
  for (const identity of targetIdentities) {
    if (!requests.includes(identity.request)) throw new Error(`piece proof did not request candidate asset ${identity.request}`);
    if (!servedResponses.some((response) => response.pathname === identity.request && response.contentType === targetConfig.assetContentType)) {
      throw new Error(`piece proof did not serve ${identity.request} as ${targetConfig.assetContentType}`);
    }
  }
  if (targetConfig.requiresSourceSheet && !existsSync(join(proofRoot, validated.sourceSheet.file.replace("apps/web/", "")))) {
    throw new Error(`piece proof did not copy source sheet`);
  }
}

async function startPieceStaticServer(root, csp) {
  const files = new Map(
    walk(root)
      .filter((path) =>
        [".html", ".css", ".js", ".mjs", ".jpg", ".jpeg", ".png", ".svg", ".webp"].includes(
          extname(path)
        )
      )
      .map((file) => [`/${relative(root, file).split("/").map(encodeURIComponent).join("/")}`, file])
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
    const type = pieceProofContentType(file);
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

function pieceProofContentType(path) {
  if (extname(path) === ".html") return "text/html; charset=utf-8";
  if (extname(path) === ".css") return "text/css; charset=utf-8";
  if (extname(path) === ".jpg" || extname(path) === ".jpeg") return "image/jpeg";
  if (extname(path) === ".png") return "image/png";
  if (extname(path) === ".svg") return "image/svg+xml";
  if (extname(path) === ".webp") return "image/webp";
  return "text/javascript; charset=utf-8";
}
