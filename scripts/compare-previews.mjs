import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  evaluateJson,
  reserveLoopbackPort,
  runCdpProof,
  waitFor
} from "./browser-proof-support.mjs";

const repoRoot = new URL("../", import.meta.url).pathname;
const baselineSha = "5687b794938838d4704684cb2a14acce4ac4cd93";
const baselineWorktree = "/private/tmp/chess-compare-baseline-worktree";
const baselinePreviewRoot = "/private/tmp/chess-compare-baseline-preview";
const candidatePreviewRoot = "/private/tmp/chess-compare-candidate-browser";
const baselinePort = 7802;
const candidatePort = 7801;
const reactionQuery = "playReactionMap=adr-0143-engine-lines";

function assert(condition, message, context) {
  if (!condition) {
    throw new Error(`${message}${context === undefined ? "" : `: ${JSON.stringify(context)}`}`);
  }
}

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function prepareBaselineWorktree() {
  if (existsSync(baselineWorktree)) {
    run("git", ["worktree", "remove", "--force", baselineWorktree]);
  }
  rmSync(baselinePreviewRoot, { recursive: true, force: true });
  run("git", ["worktree", "add", "--detach", baselineWorktree, baselineSha]);
  const scriptPath = join(baselineWorktree, "scripts/preview-beta-0-1.mjs");
  const source = readFileSync(scriptPath, "utf8");
  const patched = source.replace(
    'const previewRoot = "/private/tmp/chess-beta-0-1-preview";',
    `const previewRoot = ${JSON.stringify(baselinePreviewRoot)};`
  );
  if (patched === source) {
    throw new Error("baseline previewRoot patch did not apply");
  }
  writeFileSync(scriptPath, patched);
}

function shortSha(cwd) {
  return run("git", ["rev-parse", "--short", "HEAD"], cwd);
}

async function startPreview({ cwd, port, label }) {
  const env = {
    ...process.env,
    CHESS_PREVIEW_PORT: String(port)
  };
  const child = spawn("node", ["scripts/preview-beta-0-1.mjs"], {
    cwd,
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
  const expectedUrl = `http://127.0.0.1:${String(port)}/index.html`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (output.includes(expectedUrl)) {
      return { child, label, output: () => output, url: `${expectedUrl}?${reactionQuery}` };
    }
    if (child.exitCode !== null) {
      throw new Error(`${label} preview exited early with ${String(child.exitCode)}:\n${output}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  child.kill();
  throw new Error(`${label} preview did not start:\n${output}`);
}

function previewSnapshot(label) {
  return `JSON.stringify((() => ({
    label: ${JSON.stringify(label)},
    boardSquares: document.querySelectorAll('[data-play-ui="board-square"]').length,
    reactionStatus: document.querySelector('[data-play-ui="reaction-lens"]')?.getAttribute("data-reaction-status") ?? null,
    modeLabel: document.querySelector('[data-play-ui="mode-label"]')?.textContent?.trim() ?? null,
    best: document.querySelector('[data-play-ui="reaction-best"] dd')?.textContent?.trim() ?? null,
    evidenceStatus: document.querySelector('[data-play-ui="evidence-status"]')?.textContent?.trim() ?? null
  }))())`;
}

async function provePreview(cdp, preview) {
  await cdp.send("Page.navigate", { url: preview.url });
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-play-ui=\"board-square\"]').length === 64",
    `${preview.label} board did not mount`
  );
  await waitFor(
    cdp,
    "document.querySelector('[data-play-ui=\"reaction-lens\"]')?.getAttribute('data-reaction-status') === 'ready'",
    `${preview.label} Explore did not settle`
  );
  const snapshot = await evaluateJson(cdp, previewSnapshot(preview.label));
  assert(snapshot.boardSquares === 64, "board square count mismatch", snapshot);
  assert(snapshot.reactionStatus === "ready", "Explore did not settle ready", snapshot);
  return snapshot;
}

prepareBaselineWorktree();
const candidateSha = shortSha(repoRoot);
const baselineLabel = `baseline-sat-${baselineSha.slice(0, 7)}`;
const candidateLabel = `candidate-${candidateSha}`;
const baseline = await startPreview({ cwd: baselineWorktree, port: baselinePort, label: baselineLabel });
const candidate = await startPreview({ cwd: repoRoot, port: candidatePort, label: candidateLabel });
try {
  const debugPort = await reserveLoopbackPort();
  const snapshots = await runCdpProof(candidatePreviewRoot, debugPort, async (cdp) => [
    await provePreview(cdp, baseline),
    await provePreview(cdp, candidate)
  ]);
  console.log("Preview comparison proof passed.");
  console.log(`baseline=${baseline.url}`);
  console.log(`candidate=${candidate.url}`);
  console.log(`baseline_backend=${snapshots[0].modeLabel ?? "unknown"}`);
  console.log(`candidate_backend=${snapshots[1].modeLabel ?? "unknown"}`);
  console.log(`snapshots=${JSON.stringify(snapshots)}`);
  console.log("relaunch=just compare-previews");
} finally {
  baseline.child.kill("SIGINT");
  candidate.child.kill("SIGINT");
}
