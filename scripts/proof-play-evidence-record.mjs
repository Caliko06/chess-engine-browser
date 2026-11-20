import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  evaluate,
  evaluateJson,
  reserveLoopbackPort,
  runCdpProof,
  waitFor
} from "./browser-proof-support.mjs";

const repoRoot = new URL("../", import.meta.url).pathname;
const proofRoot = join(repoRoot, "target/proofs/play-evidence-record");
const evidenceRoot = join(repoRoot, "tmp/play-evidence");
const reactionQuery = "playReactionMap=adr-0143-engine-lines";
const settledFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const deepNodeBudget = 44_000;
const qg30Fen = "rn2kb1r/pq3pp1/b1p1p1n1/4P2p/BpNP4/3PBN2/PP1Q1PPP/2R1K2R b Kkq - 1 15";

function assert(condition, message, context) {
  if (!condition) {
    throw new Error(`${message}${context === undefined ? "" : `: ${JSON.stringify(context)}`}`);
  }
}

function clickSquareExpression(square) {
  return `(() => {
    const element = document.querySelector('[data-play-ui="board-square"][data-square="${square}"]');
    if (!(element instanceof HTMLButtonElement)) return false;
    element.click();
    return true;
  })()`;
}

function snapshotExpression() {
  return `JSON.stringify((() => ({
    rows: document.querySelectorAll('[data-play-ui="move-row"]').length,
    reactionStatus: document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute("data-reaction-status") ?? null,
    evidenceStatus: document.querySelector('[data-play-ui="evidence-status"]')?.textContent?.trim() ?? null,
    status: document.querySelector('[data-play-ui="status"]')?.textContent?.trim() ?? null
  }))())`;
}

function clickSelectorExpression(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLButtonElement)) return false;
    element.click();
    return true;
  })()`;
}

function loadFenExpression(fen) {
  return `(() => {
    const input = document.querySelector('[data-play-ui="load-position-input"]');
    const button = document.querySelector('[data-play-ui="load-position-button"]');
    if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) return false;
    input.value = ${JSON.stringify(fen)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
    return true;
  })()`;
}

async function playMove(cdp, from, to, expectedRows) {
  assert(await evaluate(cdp, clickSquareExpression(from)), `could not select ${from}`);
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="selected-square"]')?.textContent?.trim() === '${from}'`,
    `${from} selection did not register`
  );
  assert(await evaluate(cdp, clickSquareExpression(to)), `could not move ${from}${to}`);
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-play-ui="move-row"]').length === ${String(expectedRows)}`,
    `${from}${to} row did not record`
  );
  await waitFor(
    cdp,
    `document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute("data-reaction-status") === "ready"`,
    `${from}${to} Explore did not settle`
  );
}

function latestEvidenceFile(startedAtMs) {
  if (!existsSync(evidenceRoot)) {
    return null;
  }
  const candidates = readdirSync(evidenceRoot)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const path = join(evidenceRoot, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .filter((entry) => entry.mtimeMs >= startedAtMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path ?? null;
}

async function waitForEvidence(startedAtMs) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const path = latestEvidenceFile(startedAtMs);
    if (path !== null) {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      const events = lines.map((line) => JSON.parse(line));
      const moveEvents = events.filter((event) => event.type === "move");
      const recommendationEvents = events.filter((event) => event.type === "recommendation");
      const qg30Recommendations = recommendationEvents.filter((event) => event.fenBefore === qg30Fen);
      if (
        moveEvents.length >= 2 &&
        qg30Recommendations.some((event) => event.exploreMode === "fallback") &&
        recommendationEvents.some(
          (event) =>
            event.exploreMode === "deep" &&
            event.nodeBudget === deepNodeBudget &&
            event.primaryRenderState === "recommended"
        )
      ) {
        return { path, lines, moveEvents, recommendationEvents };
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error("evidence JSONL did not contain two move events and one recommendation event");
}

function assertEvidenceBuildIdentifiers(evidence) {
  for (const event of [...evidence.moveEvents, ...evidence.recommendationEvents]) {
    assert(event.schema === 2, "evidence event did not use schema 2", event);
    assert(
      typeof event.buildSha === "string" && event.buildSha.length > 0,
      "evidence event did not record a buildSha",
      event
    );
    assert(
      typeof event.wasmSha256 === "string" && /^[a-f0-9]{64}$/u.test(event.wasmSha256),
      "evidence event did not record the served wasm SHA-256",
      event
    );
  }
}

function assertEvidenceHonesty(evidence) {
  const [firstMove, secondMove] = evidence.moveEvents;
  assert(firstMove?.actor === "user", "first scripted move should be recorded as user", firstMove);
  assert(secondMove?.actor === "user", "manually entered opponent move must retain human execution provenance", secondMove);
  const qg30 = evidence.recommendationEvents.find(
    (event) => event.fenBefore === qg30Fen && event.exploreMode === "fallback"
  );
  assert(qg30 !== undefined, "missing QG-30 recommendation evidence");
  assert(qg30.exploreMode === "fallback", "QG-30 browser row should record the provisional lane under the UI deadline", qg30);
  assert(qg30.nodeBudget === 60_000, "QG-30 fallback should record the best-move budget actually sent", qg30);
  assert(qg30.primaryRenderState === "alt-risk", "QG-30 fallback must not render as recommended", qg30);
  assert(
    Array.isArray(qg30.candidates) && qg30.candidates[0]?.sound === false,
    "QG-30 fallback must carry an unsound provisional candidate",
    qg30
  );
  const settledRecommended = evidence.recommendationEvents.find(
    (event) =>
      event.exploreMode === "deep" &&
      event.nodeBudget === deepNodeBudget &&
      event.primaryRenderState === "recommended"
  );
  assert(settledRecommended !== undefined, "missing settled recommended evidence row");
  assert(
    Array.isArray(settledRecommended.candidates) && settledRecommended.candidates[0]?.sound === true,
    "settled recommended row must have a sound primary",
    settledRecommended
  );
}

async function startPreview(port) {
  const env = {
    ...process.env,
    CHESS_PREVIEW_PORT: String(port)
  };
  const child = spawn("node", ["scripts/preview-beta-0-1.mjs"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (output.includes(`http://127.0.0.1:${String(port)}/index.html`)) {
      return { child, output: () => output };
    }
    if (child.exitCode !== null) {
      throw new Error(`preview exited early with ${String(child.exitCode)}:\n${output}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  child.kill();
  throw new Error(`preview did not start:\n${output}`);
}

mkdirSync(proofRoot, { recursive: true });
mkdirSync(evidenceRoot, { recursive: true });
const startedAtMs = Date.now();
const previewPort = await reserveLoopbackPort();
const debugPort = await reserveLoopbackPort();
const preview = await startPreview(previewPort);
try {
  const url = `http://127.0.0.1:${String(previewPort)}/index.html?${reactionQuery}`;
  const browserSnapshot = await runCdpProof(proofRoot, debugPort, async (cdp) => {
    await cdp.send("Page.navigate", { url });
    await waitFor(
      cdp,
      "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64",
      "Play board did not mount"
    );
    await waitFor(
      cdp,
      "document.querySelector('[data-play-ui=\"reaction-lens\"]')?.getAttribute('data-reaction-status') === 'ready'",
      "initial Explore did not settle"
    );
    await playMove(cdp, "e2", "e4", 1);
    await playMove(cdp, "b8", "c6", 2);
    assert(
      await evaluate(cdp, clickSelectorExpression('[data-play-ui="player-side-button"][data-player-side="black"]')),
      "could not select black side"
    );
    await evaluate(cdp, `document.querySelector('[data-play-ui="explore-options-summary"]').click()`);
    assert(
      await evaluate(cdp, clickSelectorExpression('[data-play-ui="reaction-depth-button"][data-reaction-depth="deep"]')),
      "could not select Deep Explore"
    );
    assert(await evaluate(cdp, loadFenExpression(settledFen)), "could not load the settled recommendation FEN");
    await waitFor(
      cdp,
      "document.querySelector('[data-play-ui=\"reaction-lens\"]')?.getAttribute('data-reaction-source') === 'rich' && document.querySelector('[data-play-ui=\"reaction-lens\"]')?.getAttribute('data-reaction-status') === 'ready'",
      "Deep Explore did not settle before loading QG-30"
    );
    assert(await evaluate(cdp, loadFenExpression(qg30Fen)), "could not load QG-30 FEN");
    await waitFor(
      cdp,
      `document.querySelector('[data-play-ui="current-fen"]')?.textContent?.includes(${JSON.stringify(qg30Fen)}) === true`,
      "QG-30 FEN did not load"
    );
    await waitFor(
      cdp,
      "document.querySelector('[data-play-ui=\"reaction-lens\"]')?.getAttribute('data-reaction-status') === 'ready'",
      "QG-30 Explore did not settle"
    );
    const snapshot = await evaluateJson(cdp, snapshotExpression());
    assert(snapshot.evidenceStatus !== "Statusdegraded", "evidence status degraded", snapshot);
    return snapshot;
  });
  const evidence = await waitForEvidence(startedAtMs);
  assertEvidenceBuildIdentifiers(evidence);
  assertEvidenceHonesty(evidence);
  console.log("Play evidence record proof passed.");
  console.log(`url=${url}`);
  console.log(`evidence=${evidence.path}`);
  console.log(`snapshot=${JSON.stringify(browserSnapshot)}`);
  console.log(`buildSha=${String(evidence.moveEvents[0].buildSha)}`);
  console.log(`wasmSha256=${String(evidence.moveEvents[0].wasmSha256)}`);
  console.log(`first=${evidence.lines[0]}`);
  console.log(`second=${evidence.lines[1]}`);
} finally {
  preview.child.kill("SIGINT");
}
