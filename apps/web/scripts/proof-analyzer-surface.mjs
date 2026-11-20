// Rendered proof for the Analyzer surface (ADR-0242) composition.
//
// Contractual UI proof with deterministic fixtures: it mounts `mountAnalyzerUi` with a stub
// endpoint so every state is reachable offline, then proves the design contract in real Chrome:
// states, keyboard/focus visibility, reduced motion, no horizontal overflow, and that the
// surface is actually styled (not raw HTML). It does not exercise the local Stockfish pipeline;
// that path belongs to the preview endpoint proof.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  evaluate,
  evaluateJson,
  reserveLoopbackPort,
  runCdpProof,
  startStaticServer,
  waitFor
} from "../../../scripts/browser-proof-support.mjs";

const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
const webRoot = join(repoRoot, "apps/web");
const proofRoot = "/private/tmp/chess-analyzer-proof";
const shotsRoot = join(proofRoot, "shots");
const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self'; connect-src 'self'";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`analyzer surface proof failed: ${message}`);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Same fixture shape the analyzer unit test uses: one accepted game, one user blunder.
const fixture = `export default ${JSON.stringify({
  oracle: { status: "enabled", depth: 12 },
  understanding: { accepted: [{ id: "pgn-test", confidence: 0.9 }], quarantined: [], acceptedGames: 1, quarantinedGames: 0 },
  games: [
    {
      id: "pgn-test",
      selectedSide: "white",
      aggressive: true,
      result: "0-1",
      plies: 4,
      userPlies: 2,
      rivalPlies: 2,
      moves: [
        { ply: 1, side: "white", san: "f3", coordinate: "f2f3", fenBefore: "x" },
        { ply: 2, side: "black", san: "e5", coordinate: "e7e5", fenBefore: "x" },
        { ply: 3, side: "white", san: "g4", coordinate: "g2g4", fenBefore: "x" },
        { ply: 4, side: "black", san: "Qh4#", coordinate: "d8h4", fenBefore: "x" }
      ],
      labels: [
        { ply: 1, side: "white", role: "user", kind: "oracle-move-delta", severity: "info", detail: { deltaCp: -10, qualityBand: "good", bestBefore: "e2e4", deltaClass: "centipawn" } },
        { ply: 2, side: "black", role: "rival", kind: "oracle-move-delta", severity: "info", detail: { deltaCp: -5, qualityBand: "good", bestBefore: "e7e5", deltaClass: "centipawn" } },
        { ply: 3, side: "white", role: "user", kind: "oracle-move-delta", severity: "fail", detail: { deltaCp: -450, qualityBand: "blunder", bestBefore: "e2e4", deltaClass: "centipawn" } },
        { ply: 4, side: "black", role: "rival", kind: "oracle-move-delta", severity: "info", detail: { deltaCp: -20, qualityBand: "good", bestBefore: "d8h4", deltaClass: "centipawn" } }
      ]
    }
  ]
}, null, 2)};\n`;

const harnessHtml = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Analyzer surface proof</title>
    <link rel="stylesheet" href="./review.css" />
    <link rel="stylesheet" href="./analyzer.css" />
  </head>
  <body>
    <main id="host"></main>
    <script type="module">
      import { mountAnalyzerUi } from "./dist/analyzer-ui.js";
      import report from "./report.mjs";

      const mode = new URLSearchParams(location.search).get("mode") ?? "idle";
      const validPgn = "1. f3 e5 2. g4 Qh4# 0-1";
      const endpoint = async () => {
        if (mode === "error") {
          return { ok: false, report: null, error: "invalid PGN: PGN contains an illegal move" };
        }
        if (mode === "loading") {
          await new Promise((resolve) => setTimeout(resolve, 8000));
        }
        return { ok: true, report };
      };

      mountAnalyzerUi({ root: document.getElementById("host"), locale: "es", endpoint });

      window.__drive = (action) => {
        const root = document.getElementById("host");
        if (action === "type") {
          const input = root.querySelector('[data-analyzer-ui="pgn-input"]');
          input.value = validPgn;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
        if (action === "run") {
          root.querySelector('[data-analyzer-ui="run"]').click();
          return true;
        }
        return false;
      };
    </script>
  </body>
</html>
`;

function prepareProofRoot() {
  run("npm", ["run", "build"], webRoot);
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(shotsRoot, { recursive: true });
  cpSync(join(webRoot, "dist"), join(proofRoot, "dist"), { recursive: true });
  cpSync(join(webRoot, "review.css"), join(proofRoot, "review.css"));
  cpSync(join(webRoot, "analyzer.css"), join(proofRoot, "analyzer.css"));
  writeFileSync(join(proofRoot, "index.html"), harnessHtml);
  writeFileSync(join(proofRoot, "report.mjs"), fixture);
}

const viewport = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const mobileViewport = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };

prepareProofRoot();
const { server, port } = await startStaticServer(proofRoot, csp);
const debugPort = await reserveLoopbackPort();
const summary = {};

async function shoot(cdp, name) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(shotsRoot, `${name}.png`), Buffer.from(shot.data, "base64"));
}

async function phase(cdp) {
  return evaluate(
    cdp,
    `document.querySelector('[data-analyzer-ui="section"]')?.getAttribute('data-phase') ?? null`
  );
}

async function open(cdp, mode) {
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?mode=${mode}` });
  await waitFor(cdp, `!!document.querySelector('[data-analyzer-ui="section"]')`, `section for ${mode}`);
}

async function driveTo(cdp, mode, waitSelector, label) {
  await open(cdp, mode);
  await evaluate(cdp, `window.__drive('type')`);
  await evaluate(cdp, `window.__drive('run')`);
  await waitFor(cdp, `!!document.querySelector('${waitSelector}')`, label);
}

try {
  await runCdpProof(proofRoot, debugPort, async (cdp) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", viewport);
    // Headless Chrome can report `prefers-reduced-motion: reduce`; pin the default explicitly so
    // the animated and reduced states are each proven, not inherited from the host.
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
    });

    await open(cdp, "idle");
    summary.idlePhase = await phase(cdp);
    assert(summary.idlePhase === "idle", `idle phase was ${String(summary.idlePhase)}`);
    await shoot(cdp, "1-idle-empty");

    await driveTo(cdp, "result", '[data-analyzer-ui="report"]', "result state");
    summary.resultPhase = await phase(cdp);
    assert(summary.resultPhase === "done", `result phase was ${String(summary.resultPhase)}`);
    await shoot(cdp, "2-result");

    await driveTo(cdp, "loading", '[data-analyzer-ui="progress"]', "loading state");
    summary.loadingPhase = await phase(cdp);
    assert(summary.loadingPhase === "running", `loading phase was ${String(summary.loadingPhase)}`);
    summary.ringAnimation = await evaluate(
      cdp,
      `getComputedStyle(document.querySelector('[data-analyzer-ui="progress"]'), '::before').animationName`
    );
    assert(summary.ringAnimation !== "none", "loading ring is not animated in the default state");
    await shoot(cdp, "3-loading");

    await driveTo(cdp, "error", '[data-analyzer-ui="error"]', "error state");
    summary.errorPhase = await phase(cdp);
    summary.errorText = await evaluate(
      cdp,
      `document.querySelector('[data-analyzer-ui="error"]')?.textContent ?? null`
    );
    assert(summary.errorPhase === "error", `error phase was ${String(summary.errorPhase)}`);
    assert(
      typeof summary.errorText === "string" && summary.errorText.includes("vuelve a intentarlo"),
      "error copy does not say what to do next"
    );
    await shoot(cdp, "4-error");

    // The surface must be styled, not raw HTML.
    summary.styledRules = await evaluate(
      cdp,
      `(() => {
        let count = 0;
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch { continue; }
          for (const rule of rules) { if (rule.cssText && rule.cssText.includes("data-analyzer-ui")) count += 1; }
        }
        return count;
      })()`
    );
    assert(summary.styledRules > 0, "no CSS rule targets the analyzer hooks");

    // Keyboard: every tabbable control keeps a visible ring.
    await driveTo(cdp, "result", '[data-analyzer-ui="report"]', "focus path");
    const tabPath = [];
    for (let index = 0; index < 8; index += 1) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      tabPath.push(
        await evaluateJson(
          cdp,
          `(() => {
            const el = document.activeElement;
            const cs = getComputedStyle(el);
            return JSON.stringify({
              hook: el.getAttribute && el.getAttribute("data-analyzer-ui"),
              outlineWidth: cs.outlineWidth,
              outlineStyle: cs.outlineStyle
            });
          })()`
        )
      );
    }
    summary.tabPath = tabPath;
    for (const stop of tabPath) {
      assert(
        stop.outlineStyle === "solid" && stop.outlineWidth !== "0px",
        `focus ring missing on ${String(stop.hook)}`
      );
    }

    // Reduced motion: the ring holds still.
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }]
    });
    await driveTo(cdp, "loading", '[data-analyzer-ui="progress"]', "reduced-motion loading");
    summary.reducedRingAnimation = await evaluate(
      cdp,
      `getComputedStyle(document.querySelector('[data-analyzer-ui="progress"]'), '::before').animationName`
    );
    assert(summary.reducedRingAnimation === "none", "reduced motion does not stop the looping ring");
    await shoot(cdp, "5-loading-reduced-motion");
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });

    // Mobile: the console stacks and nothing overflows horizontally.
    await cdp.send("Emulation.setDeviceMetricsOverride", mobileViewport);
    await driveTo(cdp, "result", '[data-analyzer-ui="report"]', "mobile report");
    summary.mobile = await evaluateJson(
      cdp,
      `JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })`
    );
    assert(
      summary.mobile.scrollWidth <= summary.mobile.clientWidth,
      `horizontal overflow at 390px: ${JSON.stringify(summary.mobile)}`
    );
    await shoot(cdp, "6-result-mobile");
  });
} finally {
  server.close();
}

console.log("Analyzer surface contract PASS");
console.log(JSON.stringify(summary, null, 2));
console.log(`screenshots: ${shotsRoot}`);
