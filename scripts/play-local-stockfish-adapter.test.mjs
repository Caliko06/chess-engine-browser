import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalStockfishBestMoveProvider,
  playStockfishBinaryEnv,
  resolvePlayStockfishBinary
} from "./play-local-stockfish-adapter.mjs";

function expectEqual(actual, expected, label) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`${label}: expected ${expectedText}, got ${actualText}`);
  }
}

function expectIncludes(actual, expected, label) {
  if (!actual.includes(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(actual)} to include ${expected}`);
  }
}

async function delay(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const tempRoot = mkdtempSync(join(tmpdir(), "chess-fake-uci-"));

function writeFakeUci(name, behavior) {
  const binaryPath = join(tempRoot, `${name}.mjs`);
  const logPath = join(tempRoot, `${name}.log`);
  writeFileSync(
    binaryPath,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      'import { createInterface } from "node:readline";',
      `const logPath = ${JSON.stringify(logPath)};`,
      `const behavior = ${JSON.stringify(behavior)};`,
      'let searchCount = 0;',
      'const lines = createInterface({ input: process.stdin });',
      'lines.on("line", (line) => {',
      '  appendFileSync(logPath, `${line}\\n`, "utf8");',
      '  if (line === "uci") {',
      '    if (behavior === "stderr") console.error("fake stderr noise");',
      '    console.log("id name Fake Local UCI");',
      '    console.log("uciok");',
      '  } else if (line === "isready") {',
      '    console.log("readyok");',
      '  } else if (line.startsWith("go ")) {',
      '    searchCount += 1;',
      '    if (behavior === "valid" || behavior === "stderr") {',
      '      console.log("info depth 2 score cp 17 nodes 123");',
      '      console.log("bestmove b8c6");',
      '    } else if (behavior === "terminal-once" && searchCount === 1) {',
      '      console.log("info depth 0 score mate 0 nodes 1");',
      '      console.log("bestmove (none)");',
      '    } else if (behavior === "terminal-once") {',
      '      console.log("info depth 2 score cp 17 nodes 123");',
      '      console.log("bestmove b8c6");',
      '    } else if (behavior === "null") {',
      '      console.log("bestmove 0000");',
      '    } else if (behavior === "malformed") {',
      '      console.log("bestmove not-a-move");',
      '    } else if (behavior === "crash") {',
      '      process.exit(2);',
      '    } else if (behavior === "stop-delayed" && searchCount > 1) {',
      '      console.log("info depth 2 score cp 17 nodes 123");',
      '      console.log("bestmove b8c6");',
      '    }',
      '  } else if (line === "stop") {',
      '    if (behavior === "stop-delayed") console.log("bestmove b8c6");',
      '  } else if (line === "quit") {',
      '    process.exit(0);',
      '  }',
      '});',
      ""
    ].join("\n"),
    "utf8"
  );
  chmodSync(binaryPath, 0o700);
  return { binaryPath, logPath };
}

expectEqual(resolvePlayStockfishBinary({}), { ok: false, reason: "not-configured" }, "missing config");
expectEqual(
  resolvePlayStockfishBinary({ [playStockfishBinaryEnv]: "stockfish" }),
  { ok: false, reason: "not-absolute" },
  "relative config"
);
expectEqual(
  resolvePlayStockfishBinary({ [playStockfishBinaryEnv]: join(tempRoot, "missing") }),
  { ok: false, reason: "not-found" },
  "missing binary"
);

const notExecutable = join(tempRoot, "not-executable");
writeFileSync(notExecutable, "#!/usr/bin/env node\n", "utf8");
chmodSync(notExecutable, 0o600);
expectEqual(
  resolvePlayStockfishBinary({ [playStockfishBinaryEnv]: notExecutable }),
  { ok: false, reason: "not-executable" },
  "not executable"
);

const validFake = writeFakeUci("valid-fake-uci", "valid");
const resolved = resolvePlayStockfishBinary({ [playStockfishBinaryEnv]: validFake.binaryPath });
expectEqual(resolved, { ok: true, binaryPath: validFake.binaryPath }, "valid fake config");

const provider = createLocalStockfishBestMoveProvider(resolved, {
  timeouts: { handshakeMs: 1_000, readyMs: 1_000, searchMs: 1_000, quitMs: 500 }
});
expectEqual(provider.isAvailable(), true, "provider starts available");
expectEqual(await provider.prepareNewGame(), { ok: true }, "new game readiness");
expectEqual(
  await provider.bestMove("startpos fen", 2),
  { ok: true, value: { bestMove: "b8c6", terminal: false, depth: 2, scoreCp: 17, nodes: 123, ttHits: 0 } },
  "best move"
);
await provider.dispose();
const validLog = readFileSync(validFake.logPath, "utf8");
expectIncludes(validLog, "uci\n", "handshake command");
expectIncludes(validLog, "isready\n", "ready command");
expectIncludes(validLog, "ucinewgame\n", "new game command");
expectIncludes(validLog, "position fen startpos fen\n", "position command");
expectIncludes(validLog, "go depth 2\n", "depth search command");
expectIncludes(validLog, "quit\n", "quit command");

const stderrFake = writeFakeUci("stderr-fake-uci", "stderr");
const stderrProvider = createLocalStockfishBestMoveProvider(
  { ok: true, binaryPath: stderrFake.binaryPath },
  { timeouts: { handshakeMs: 1_000, readyMs: 1_000, searchMs: 1_000, quitMs: 100 } }
);
expectEqual(
  await stderrProvider.bestMove("stderr fen", 3),
  { ok: true, value: { bestMove: "b8c6", terminal: false, depth: 3, scoreCp: 17, nodes: 123, ttHits: 0 } },
  "stderr noise does not fail search"
);
await stderrProvider.dispose();

const stopFake = writeFakeUci("stop-delayed-fake-uci", "stop-delayed");
const stopProvider = createLocalStockfishBestMoveProvider(
  { ok: true, binaryPath: stopFake.binaryPath },
  { timeouts: { handshakeMs: 1_000, readyMs: 1_000, searchMs: 1_000, stopMs: 100, quitMs: 100 } }
);
const stoppedSearch = stopProvider.bestMove("stopped fen", 1);
await delay(25);
stopProvider.cancelSearch();
expectEqual(
  await stoppedSearch,
  { ok: true, value: { bestMove: "b8c6", terminal: false, depth: 1, scoreCp: 0, nodes: 0, ttHits: 0 } },
  "stopped search consumes stopped bestmove"
);
expectEqual(
  await stopProvider.bestMove("fresh fen", 2),
  { ok: true, value: { bestMove: "b8c6", terminal: false, depth: 2, scoreCp: 17, nodes: 123, ttHits: 0 } },
  "fresh search after stop"
);
await stopProvider.dispose();
const stopLog = readFileSync(stopFake.logPath, "utf8");
expectIncludes(stopLog, "stop\n", "stop command");
expectIncludes(stopLog, "position fen fresh fen\n", "fresh search after stop command");

const ignoreStopFake = writeFakeUci("ignore-stop-fake-uci", "timeout");
const ignoreStopProvider = createLocalStockfishBestMoveProvider(
  { ok: true, binaryPath: ignoreStopFake.binaryPath },
  { timeouts: { handshakeMs: 200, readyMs: 200, searchMs: 1_000, stopMs: 30, quitMs: 30 } }
);
const ignoredStopSearch = ignoreStopProvider.bestMove("ignored stop fen", 1);
await delay(25);
ignoreStopProvider.cancelSearch();
expectEqual(
  await ignoredStopSearch,
  { ok: false, error: "search-failed" },
  "ignored stop fails closed"
);
expectEqual(ignoreStopProvider.isAvailable(), true, "ignored stop keeps provider recoverable");

const queuedFake = writeFakeUci("queued-fake-uci", "valid");
const queuedProvider = createLocalStockfishBestMoveProvider(
  { ok: true, binaryPath: queuedFake.binaryPath },
  { timeouts: { handshakeMs: 1_000, readyMs: 1_000, searchMs: 1_000, quitMs: 100 } }
);
expectEqual(
  await Promise.all([
    queuedProvider.bestMove("queued one", 1),
    queuedProvider.bestMove("queued two", 2)
  ]),
  [
    { ok: true, value: { bestMove: "b8c6", terminal: false, depth: 1, scoreCp: 17, nodes: 123, ttHits: 0 } },
    { ok: true, value: { bestMove: "b8c6", terminal: false, depth: 2, scoreCp: 17, nodes: 123, ttHits: 0 } }
  ],
  "queued searches"
);
await queuedProvider.dispose();
const queuedLog = readFileSync(queuedFake.logPath, "utf8");
if (queuedLog.indexOf("position fen queued one\n") > queuedLog.indexOf("position fen queued two\n")) {
  throw new Error("queued searches were not serialized");
}

for (const behavior of ["null", "malformed", "timeout", "crash"]) {
  const fake = writeFakeUci(`${behavior}-fake-uci`, behavior);
  const failingProvider = createLocalStockfishBestMoveProvider(
    { ok: true, binaryPath: fake.binaryPath },
    { timeouts: { handshakeMs: 200, readyMs: 200, searchMs: 50, stopMs: 50, quitMs: 50 } }
  );
  expectEqual(
    await failingProvider.bestMove("startpos fen", 1),
    { ok: false, error: "search-failed" },
    `${behavior} fallback result`
  );
  expectEqual(failingProvider.isAvailable(), true, `${behavior} keeps provider recoverable`);
}

const terminalFake = writeFakeUci("terminal-once-fake-uci", "terminal-once");
const terminalProvider = createLocalStockfishBestMoveProvider(
  { ok: true, binaryPath: terminalFake.binaryPath },
  { timeouts: { handshakeMs: 1_000, readyMs: 1_000, searchMs: 1_000, quitMs: 100 } }
);
expectEqual(
  await terminalProvider.bestMove("terminal fen", 12),
  { ok: true, value: { bestMove: null, terminal: true, depth: 12, scoreCp: -100000, nodes: 1, ttHits: 0 } },
  "terminal bestmove none is valid"
);
expectEqual(
  await terminalProvider.bestMove("healthy fen", 12),
  { ok: true, value: { bestMove: "b8c6", terminal: false, depth: 12, scoreCp: 17, nodes: 123, ttHits: 0 } },
  "healthy search survives terminal bestmove"
);
await terminalProvider.dispose();

const unavailableProvider = createLocalStockfishBestMoveProvider({ ok: false, reason: "not-configured" });
expectEqual(unavailableProvider.isAvailable(), false, "unconfigured provider unavailable");
expectEqual(
  await unavailableProvider.bestMove("startpos fen", 1),
  { ok: false, error: "search-failed" },
  "unconfigured provider fails closed"
);

console.log("Play local Stockfish adapter tests passed.");
