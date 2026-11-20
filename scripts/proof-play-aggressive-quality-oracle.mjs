import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const budget = 60_000;
const stockfishPath = "/opt/homebrew/bin/stockfish";
const cargoPath = [
  `${process.env.HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/bin`,
  `${process.env.HOME}/.cargo/bin`,
  "/opt/homebrew/opt/rustup/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  process.env.PATH ?? ""
].join(":");

const cases = [
  {
    label: "c2-normal-play",
    fen: "r2q1rk1/pp3pp1/2np1n1p/4p1N1/3PP3/2NB4/PPP2PPP/R1BQK2R w KQ - 0 12",
    forbidden: ["h2h4", "c1e3"],
    maxStockfishLossCp: 60
  },
  {
    label: "w7-bxh7-sacrifice",
    fen: "r1bq1rk1/pp3ppp/3p4/4p1N1/3P4/3B4/PPP1QPPP/R1B1K2R w KQ - 0 9",
    expected: "d3h7",
    maxStockfishLossCp: 60
  },
  {
    label: "greek-gift-qh5",
    fen: "r1bq1rk1/pppnbppp/4p3/3pP1B1/3P3P/2NB4/PPP2PP1/R2QK1NR w KQ - 1 8",
    expected: "d1h5",
    maxStockfishLossCp: 60
  }
];

function assert(condition, message, context) {
  if (!condition) {
    throw new Error(`${message}${context === undefined ? "" : `: ${JSON.stringify(context)}`}`);
  }
}

function runBestMove(fen) {
  const result = spawnSync(
    "cargo",
    [
      "run",
      "-p",
      "chess-cli",
      "--quiet",
      "--",
      "best-move",
      "--fen",
      fen,
      "--budget",
      String(budget),
      "--aggressive"
    ],
    {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, PATH: cargoPath },
      encoding: "utf8"
    }
  );
  assert(result.status === 0, "chess-cli best-move failed", {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status
  });
  return JSON.parse(result.stdout);
}

class StockfishSession {
  constructor() {
    assert(existsSync(stockfishPath), "Stockfish binary is missing", { stockfishPath });
    this.process = null;
    this.stdoutBuffer = "";
    this.waiters = [];
    this.activeSearch = null;
    this.quitting = false;
  }

  start() {
    this.process = spawn(stockfishPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.process.stdout.on("data", (chunk) => this.consumeStdout(chunk.toString("utf8")));
    this.process.once("error", (error) => this.rejectAll(error));
    this.process.once("exit", (code, signal) => {
      if (!this.quitting) {
        this.rejectAll(
          new Error(
            "Stockfish exited before the oracle completed: code="
              + String(code)
              + " signal="
              + String(signal)
          )
        );
      }
    });
  }

  send(command) {
    this.process.stdin.write(`${command}\n`);
  }

  consumeStdout(text) {
    this.stdoutBuffer += text;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.consumeLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  consumeLine(line) {
    if (this.activeSearch !== null && line.startsWith("info ") && line.includes(" score ")) {
      const parsed = parseStockfishScore(line);
      if (parsed !== null && parsed.depth >= this.activeSearch.requestedDepth) {
        this.activeSearch.score = parsed;
        this.activeSearch.lastInfo = parsed.raw;
      }
    }
    if (this.activeSearch !== null && line.startsWith("bestmove ")) {
      const bestMove = line.match(/^bestmove\s+(\S+)/u)?.[1] ?? null;
      const search = this.activeSearch;
      this.activeSearch = null;
      clearTimeout(search.timer);
      search.resolve({
        best: bestMove,
        score: search.score,
        raw: search.lastInfo
      });
      return;
    }
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(line)) {
        continue;
      }
      const index = this.waiters.indexOf(waiter);
      if (index !== -1) {
        this.waiters.splice(index, 1);
      }
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  }

  rejectAll(error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
    if (this.activeSearch !== null) {
      clearTimeout(this.activeSearch.timer);
      this.activeSearch.reject(error);
      this.activeSearch = null;
    }
  }

  waitForLine(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index !== -1) {
          this.waiters.splice(index, 1);
        }
        reject(new Error("Stockfish timeout after " + String(timeoutMs) + "ms"));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async ready() {
    const uciReady = this.waitForLine((line) => line === "uciok", 5000);
    this.send("uci");
    await uciReady;
    this.send("setoption name Threads value 1");
    this.send("setoption name Hash value 16");
    await this.waitUntilReady();
  }

  async waitUntilReady(clearHash = false) {
    const ready = this.waitForLine((line) => line === "readyok", 5000);
    if (clearHash) {
      this.send("setoption name Clear Hash");
    }
    this.send("isready");
    await ready;
  }

  async score(fen, move = null) {
    await this.waitUntilReady(true);
    const result = await new Promise((resolve, reject) => {
      const search = {
        best: null,
        score: null,
        lastInfo: "",
        requestedDepth: 14,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.activeSearch === search) {
            this.activeSearch = null;
            this.send("stop");
          }
          reject(
            new Error(
              "Stockfish search timeout for fen=" + fen + " move=" + String(move)
            )
          );
        }, 30_000)
      };
      this.activeSearch = search;
      this.send(
        "position fen " + fen + (move === null ? "" : " moves " + move)
      );
      this.send("go depth 14");
    });
    assert(result.best !== null, "Stockfish returned no bestmove", { fen, move, result });
    assert(result.score !== null, "Stockfish returned bestmove without a score", { fen, move, result });
    return {
      best: result.best,
      score: result.score.value,
      score_kind: result.score.kind,
      score_perspective: "side-to-move",
      raw: result.raw
    };
  }

  close() {
    this.quitting = true;
    this.send("quit");
  }
}

function parseStockfishScore(line) {
  if (/\b(?:lowerbound|upperbound)\b/u.test(line)) {
    return null;
  }
  const depth = line.match(/\bdepth\s+(\d+)/u);
  if (depth === null) {
    return null;
  }
  const depthValue = Number.parseInt(depth[1], 10);
  const mate = line.match(/\bscore\s+mate\s+(-?\d+)/u);
  if (mate !== null) {
    const moves = Number.parseInt(mate[1], 10);
    return {
      depth: depthValue,
      kind: "mate",
      // Keep the manual oracle's mate representation identical to the quality gauntlet:
      // mate 0 is delivered mate for the mover, and all mate scores clamp at 10_000 cp.
      value: moves >= 0 ? 10_000 : -10_000,
      raw: line.trim()
    };
  }
  const cp = line.match(/\bscore\s+cp\s+(-?\d+)/u);
  if (cp !== null) {
    return {
      depth: depthValue,
      kind: "cp",
      value: Number.parseInt(cp[1], 10),
      raw: line.trim()
    };
  }
  return null;
}

console.log("=== Play Aggressive quality oracle ===");
console.log(`budget=${budget}, stockfish_depth=14`);
const stockfish = new StockfishSession();
stockfish.start();
await stockfish.ready();
try {
  for (const testCase of cases) {
    const aggressive = runBestMove(testCase.fen);
    const sfRoot = await stockfish.score(testCase.fen);
    const sfAfterMove = await stockfish.score(testCase.fen, aggressive.best_move);
    const aggressivePovScore = -sfAfterMove.score;
    const rawLoss = Math.max(0, sfRoot.score - aggressivePovScore);
    const matchedStockfishBest = aggressive.best_move === sfRoot.best;
    // A matching judge best move measures judge self-disagreement between adjacent searches, not
    // an engine loss. Keep rawLoss visible for diagnosis while applying the accepted quality
    // convention used by the quality gauntlet (ADR-0194).
    const loss = matchedStockfishBest ? 0 : rawLoss;
    const context = {
      testCase,
      aggressive,
      sfRoot,
      sfAfterMove,
      aggressivePovScore,
      rawLoss,
      matchedStockfishBest,
      loss
    };

    if (testCase.expected !== undefined) {
      assert(aggressive.best_move === testCase.expected, "aggressive move mismatch", context);
    }
    for (const forbidden of testCase.forbidden ?? []) {
      assert(aggressive.best_move !== forbidden, "forbidden aggressive move survived", context);
    }
    assert(loss <= testCase.maxStockfishLossCp, "aggressive move exceeds Stockfish loss budget", context);

    console.log(
      `PASS ${testCase.label}: move=${aggressive.best_move} degraded=${String(
        aggressive.degraded
      )} engine=${aggressive.objective_score_cp}cp sfBest=${sfRoot.best} sfLoss=${loss}cp rawSfLoss=${rawLoss}cp matchedStockfishBest=${String(
        matchedStockfishBest
      )}`
    );
  }
} finally {
  stockfish.close();
}
console.log("Play Aggressive quality oracle passed.");
