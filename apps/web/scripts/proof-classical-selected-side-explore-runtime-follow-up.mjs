import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  assertNoInlineStyles,
  assertNoRuntimeNetworkTokens,
  assertWasmBindgenCliVersion,
  betaCsp,
  scanStaticOutput,
  writeEmbeddedWasmModule
} from "../../../scripts/beta-preview-support.mjs";
import {
  evaluate,
  evaluateJson,
  reserveLoopbackPort,
  runCdpProof,
  startStaticServer,
  waitFor
} from "../../../scripts/browser-proof-support.mjs";

const repoRoot = new URL("../../../", import.meta.url).pathname;
const runRoot = "/private/tmp/chess-classical-selected-side-explore-runtime-follow-up";
const headRoot = join(runRoot, "head");
const previewRoot = join(runRoot, "preview");
const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const reactionQuery = "playReactionMap=adr-0143-engine-lines";

function runAt(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.cargo/bin:/opt/homebrew/opt/rustup/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`
    },
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${String(result.status)}`);
  }
}

function archiveHead() {
  rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(headRoot, { recursive: true });
  const archive = execFileSync("git", ["archive", "HEAD"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  const extracted = spawnSync("tar", ["-x", "-f", "-", "-C", headRoot], {
    input: archive,
    stdio: ["pipe", "inherit", "inherit"]
  });
  if (extracted.status !== 0) throw new Error("could not extract current HEAD snapshot");
}

function copyJavaScriptTree(sourceRoot, targetRoot) {
  mkdirSync(targetRoot, { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name);
    const target = join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      copyJavaScriptTree(source, target);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      cpSync(source, target);
    }
  }
}

function prepareHeadPreview() {
  archiveHead();
  const webDist = join(headRoot, "apps-web-dist");
  runAt(repoRoot, join(repoRoot, "apps/web/node_modules/.bin/tsc"), [
    "-p",
    join(repoRoot, "apps/web/tsconfig.build.json"),
    "--outDir",
    webDist
  ]);
  assertWasmBindgenCliVersion("current-HEAD runtime follow-up");
  runAt(headRoot, "cargo", ["build", "-p", "chess-wasm-bridge", "--target", "wasm32-unknown-unknown", "--release"]);
  mkdirSync(join(previewRoot, "dist/pkg"), { recursive: true });
  runAt(headRoot, "wasm-bindgen", [
    join(headRoot, "target/wasm32-unknown-unknown/release/chess_wasm_bridge.wasm"),
    "--target",
    "bundler",
    "--out-dir",
    join(previewRoot, "dist/pkg")
  ]);
  copyJavaScriptTree(webDist, join(previewRoot, "dist"));
  for (const file of ["index.html", "review.css"]) {
    const source = join(headRoot, "apps/web", file);
    const text = readFileSync(source, "utf8");
    assertNoRuntimeNetworkTokens(source, text);
    assertNoInlineStyles(source, text);
    cpSync(source, join(previewRoot, file));
  }
  cpSync(join(headRoot, "apps/web/assets"), join(previewRoot, "assets"), { recursive: true });
  writeEmbeddedWasmModule(previewRoot, { assertExpectedImports: true, removeWasmAsset: true });
  scanStaticOutput(previewRoot, { extraForbiddenTokens: ["<script type=\"importmap\"", "ServiceWorker"] });
}

const traceSource = `
(() => {
  const events = [];
  const push = (event) => {
    if (events.length < 12000) events.push({ ...event, t: performance.now() });
  };
  const NativeWorker = window.Worker;
  window.__chessRuntimeTrace = events;
  window.Worker = function WrappedWorker(...args) {
    const worker = new NativeWorker(...args);
    const url = String(args[0] ?? "");
    const channel = url.includes("play-move-worker") ? "move" : "analysis";
    const postMessage = worker.postMessage.bind(worker);
    worker.postMessage = (message, ...rest) => {
      push({ kind: "worker-post", channel, op: message?.op ?? null, fen: message?.fen ?? null });
      return postMessage(message, ...rest);
    };
    worker.addEventListener("message", (event) => {
      push({ kind: "worker-message", channel, op: event.data?.op ?? null, ok: event.data?.ok ?? null });
    });
    return worker;
  };
  window.Worker.prototype = NativeWorker.prototype;
  const snapshot = () => ({
    currentFen: document.querySelector('[data-play-ui="current-fen"]')?.textContent?.trim() ?? null,
    status: document.querySelector('[data-play-ui="status"]')?.textContent?.trim() ?? null,
    reactionStatus: document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute("data-reaction-status") ?? null,
    reactionSource: document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute("data-reaction-source") ?? null,
    best: document.querySelector('[data-play-ui="reaction-best"] dd')?.textContent?.trim() ?? null
  });
  const observer = new MutationObserver(() => push({ kind: "ui-mutation", snapshot: snapshot() }));
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  let frame = 0;
  const paint = () => {
    frame += 1;
    if (frame % 4 === 0) push({ kind: "paint", snapshot: snapshot() });
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);
})();
`;

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

function triggerMoveExpression() {
  return `(() => {
    const trace = window.__chessRuntimeTrace;
    trace.push({ kind: "user-move-input", t: performance.now() });
    const toggle = document.querySelector('[data-play-ui="aggressive-toggle-button"]');
    const from = document.querySelector('[data-play-ui="board-square"][data-square="e2"]');
    const to = document.querySelector('[data-play-ui="board-square"][data-square="e4"]');
    if (!(toggle instanceof HTMLButtonElement) || !(from instanceof HTMLButtonElement) || !(to instanceof HTMLButtonElement)) return false;
    toggle.click();
    from.click();
    to.click();
    return true;
  })()`;
}

const domSnapshotExpression = `JSON.stringify({
  t: performance.now(),
  currentFen: document.querySelector('[data-play-ui="current-fen"]')?.textContent?.trim() ?? null,
  status: document.querySelector('[data-play-ui="status"]')?.textContent?.trim() ?? null,
  reactionStatus: document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute("data-reaction-status") ?? null,
  reactionSource: document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute("data-reaction-source") ?? null,
  best: document.querySelector('[data-play-ui="reaction-best"] dd')?.textContent?.trim() ?? null
})`;

function deriveTrial(trace, samples) {
  const input = trace.find((event) => event.kind === "user-move-input");
  const movePost = trace.find((event) => event.kind === "worker-post" && event.channel === "move" && event.op === "makeMove");
  const analysisPost = trace.find((event) => event.kind === "worker-post" && event.channel === "analysis" && event.op === "sideExplore");
  const moveMessage = trace.find((event) => event.kind === "worker-message" && event.channel === "move" && event.t > (movePost?.t ?? 0));
  const richMessages = trace.filter((event) => event.kind === "worker-message" && event.channel === "analysis" && event.t > (analysisPost?.t ?? 0));
  const richUi = trace.find((event) =>
    (event.kind === "ui-mutation" || event.kind === "paint") &&
    event.t > (analysisPost?.t ?? 0) &&
    event.snapshot?.reactionSource === "rich"
  );
  const firstRichSample = samples.find((sample) => sample.t > (analysisPost?.t ?? 0) && sample.reactionSource === "rich");
  const staleWindow = samples.filter((sample) =>
    sample.t > (movePost?.t ?? Number.POSITIVE_INFINITY) &&
    sample.t < (moveMessage?.t ?? Number.NEGATIVE_INFINITY) &&
    sample.reactionSource === "rich"
  );
  return {
    inputAtMs: input?.t ?? null,
    movePostAtMs: movePost?.t ?? null,
    moveResponseAtMs: moveMessage?.t ?? null,
    analysisPostAtMs: analysisPost?.t ?? null,
    analysisResponseCount: richMessages.length,
    richUiAtMs: firstRichSample?.t ?? richUi?.t ?? null,
    moveToRichMs: firstRichSample === undefined || movePost === undefined ? null : firstRichSample.t - movePost.t,
    staleUiBetweenMoveStartAndReturn: staleWindow.length > 0,
    staleWindow,
    finalSnapshot: samples.at(-1) ?? null,
    domSamples: samples,
    trace
  };
}

async function runTrial(cdp, port, index) {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: traceSource });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?${reactionQuery}` });
  await waitFor(cdp, 'document.querySelectorAll(\'[data-play-ui="board-square"]\').length === 64', "board did not mount");
  await waitFor(cdp, 'document.querySelector(\'[data-play-ui="status"]\') !== null', "status did not mount");
  if (!(await evaluate(cdp, loadFenExpression(startFen)))) throw new Error("could not load start FEN");
  await waitFor(cdp, 'document.querySelector(\'[data-play-ui="reaction-lens"]\')?.getAttribute("data-reaction-status") === "ready"', "initial Explore did not settle");
  if (!(await evaluate(cdp, triggerMoveExpression()))) throw new Error("could not trigger real board move");
  const samples = [];
  for (let sampleIndex = 0; sampleIndex < 160; sampleIndex += 1) {
    samples.push(await evaluateJson(cdp, domSnapshotExpression));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const trace = await evaluateJson(cdp, "JSON.stringify(window.__chessRuntimeTrace ?? [])");
  return { repetition: index + 1, ...deriveTrial(trace, samples) };
}

prepareHeadPreview();
const { server, port } = await startStaticServer(previewRoot, betaCsp);
const debugPort = await reserveLoopbackPort();
const trials = [];
try {
  await runCdpProof(previewRoot, debugPort, async (cdp) => {
    for (let index = 0; index < 3; index += 1) {
      trials.push(await runTrial(cdp, port, index));
    }
  });
} finally {
  server.close();
}

const summary = {
  source: "git archive HEAD",
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
  evaluator: "Classical",
  aggressive: true,
  fen: startFen,
  repetitions: trials,
  deterministicRed: trials.some((trial) => trial.staleUiBetweenMoveStartAndReturn),
  note: "Real Worker/WASM browser path. A stale-window flag means rich UI applied before move Worker return; it is not a product acceptance claim by itself."
};
writeFileSync(join(runRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
