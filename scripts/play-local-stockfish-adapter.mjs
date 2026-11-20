import { accessSync, constants, existsSync, statSync } from "node:fs";
import { spawn as spawnProcess } from "node:child_process";
import { isAbsolute } from "node:path";

export const playStockfishBinaryEnv = "CHESS_PLAY_STOCKFISH_BIN";

const coordinateMovePattern = /^[a-h][1-8][a-h][1-8][qrbn]?$/u;
const forcedMateScoreCp = 100_000;

const defaultTimeouts = {
  handshakeMs: 1_000,
  readyMs: 1_000,
  searchMs: 5_000,
  stopMs: 500,
  quitMs: 500
};

export function resolvePlayStockfishBinary(env = process.env) {
  const rawPath = env[playStockfishBinaryEnv];
  if (rawPath === undefined || rawPath.trim() === "") {
    return { ok: false, reason: "not-configured" };
  }
  const binaryPath = rawPath.trim();
  if (!isAbsolute(binaryPath)) {
    return { ok: false, reason: "not-absolute" };
  }
  if (!existsSync(binaryPath)) {
    return { ok: false, reason: "not-found" };
  }
  const stat = statSync(binaryPath);
  if (!stat.isFile()) {
    return { ok: false, reason: "not-file" };
  }
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    return { ok: false, reason: "not-executable" };
  }
  return { ok: true, binaryPath };
}

export function createLocalStockfishBestMoveProvider(config = resolvePlayStockfishBinary(), options = {}) {
  let available = config.ok;
  let session = null;
  let operationQueue = Promise.resolve();
  const spawn = options.spawn ?? spawnProcess;
  const timeouts = { ...defaultTimeouts, ...(options.timeouts ?? {}) };

  const failClosed = async () => {
    available = false;
    if (session !== null) {
      session.kill();
      session = null;
    }
    return { ok: false, error: "search-failed" };
  };

  const failSearch = async () => {
    if (session !== null) {
      session.kill();
      session = null;
    }
    return { ok: false, error: "search-failed" };
  };

  const ensureSession = async () => {
    if (!config.ok || !available) {
      throw new Error("local Stockfish is unavailable");
    }
    session = session ?? new UciSession(config.binaryPath, { spawn, timeouts });
    await session.ensureReady();
    return session;
  };

  const enqueueOperation = (operation) => {
    const next = operationQueue.then(operation, operation);
    operationQueue = next.catch(() => undefined);
    return next;
  };

  return {
    isAvailable: () => available,
    prepareNewGame: () => enqueueOperation(async () => {
      try {
        const readySession = await ensureSession();
        await readySession.newGame();
        return { ok: true, value: undefined };
      } catch {
        return failClosed();
      }
    }),
    bestMove: (fen, depth) => enqueueOperation(async () => {
      try {
        const readySession = await ensureSession();
        const bestMove = await readySession.bestMove(fen, depth);
        return { ok: true, value: bestMove };
      } catch {
        if (!config.ok || !available) {
          return failClosed();
        }
        return failSearch();
      }
    }),
    cancelSearch: () => {
      session?.stop();
    },
    dispose: async () => {
      if (session !== null) {
        await session.quit();
        session = null;
      }
    }
  };
}

class UciSession {
  constructor(binaryPath, options) {
    this.binaryPath = binaryPath;
    this.spawn = options.spawn;
    this.timeouts = options.timeouts;
    this.child = null;
    this.stdoutBuffer = "";
    this.lines = [];
    this.waiters = [];
    this.lastScoreCp = 0;
    this.lastNodes = 0;
    this.stderrRing = [];
    this.handshakeComplete = false;
    this.activeSearchWaiter = null;
    this.quitting = false;
    this.deadError = null;
  }

  async ensureReady() {
    if (this.deadError !== null) {
      throw this.deadError;
    }
    if (this.handshakeComplete && this.child !== null && !this.child.killed) {
      return;
    }
    this.start();
    this.send("uci");
    await this.waitForLine((line) => line === "uciok", this.timeouts.handshakeMs, "uciok");
    await this.ready();
    this.handshakeComplete = true;
  }

  async ready() {
    this.send("isready");
    await this.waitForLine((line) => line === "readyok", this.timeouts.readyMs, "readyok");
  }

  async newGame() {
    await this.ensureReady();
    this.send("ucinewgame");
    await this.ready();
  }

  async bestMove(fen, depth) {
    await this.ensureReady();
    this.lastScoreCp = 0;
    this.lastNodes = 0;
    this.send(`position fen ${fen}`);
    this.send(`go depth ${String(depth)}`);
    const bestMoveLine = await this.waitForLine(
      (line) => line.startsWith("bestmove "),
      this.timeouts.searchMs,
      "bestmove",
      (waiter) => {
        this.activeSearchWaiter = waiter;
      }
    );
    const parsed = parseBestMoveLine(bestMoveLine);
    if (parsed === null) {
      throw new Error(`invalid bestmove line: ${bestMoveLine}`);
    }
    return {
      bestMove: parsed.bestMove,
      terminal: parsed.terminal,
      depth,
      scoreCp: this.lastScoreCp,
      nodes: this.lastNodes,
      ttHits: 0
    };
  }

  stop() {
    if (this.child !== null && !this.child.killed) {
      this.send("stop");
    }
    const waiter = this.activeSearchWaiter;
    if (waiter !== null && waiter.stopTimeout === null) {
      waiter.stopTimeout = setTimeout(() => {
        this.rejectWaiter(waiter, new Error("timed out waiting for stopped bestmove"));
        this.kill();
      }, this.timeouts.stopMs);
    }
  }

  async quit() {
    if (this.child === null) {
      return;
    }
    const child = this.child;
    this.quitting = true;
    if (!child.killed) {
      this.send("quit");
    }
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        resolve();
      }, this.timeouts.quitMs);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.child = null;
    this.handshakeComplete = false;
    this.activeSearchWaiter = null;
    this.quitting = false;
  }

  kill() {
    if (this.child !== null && !this.child.killed) {
      this.child.kill("SIGKILL");
    }
    this.rejectWaiters(new Error("local Stockfish process was killed"));
    this.child = null;
    this.handshakeComplete = false;
    this.activeSearchWaiter = null;
  }

  start() {
    if (this.deadError !== null) {
      throw this.deadError;
    }
    if (this.child !== null && !this.child.killed) {
      return;
    }
    const child = this.spawn(this.binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error("local Stockfish process stdio was unavailable");
    }
    child.stdout.on("data", (chunk) => {
      this.consumeStdout(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      this.stderrRing.push(chunk.toString("utf8"));
      this.stderrRing = this.stderrRing.slice(-20);
    });
    child.once("error", (error) => {
      this.deadError = error;
      this.rejectWaiters(error);
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`local Stockfish exited: code=${String(code)} signal=${String(signal)}`);
      if (this.child === child) {
        this.child = null;
        this.handshakeComplete = false;
      }
      if (!this.quitting) {
        this.deadError = error;
      }
      this.rejectWaiters(error);
    });
    this.child = child;
  }

  send(command) {
    if (this.child === null || this.child.stdin === null || this.child.killed) {
      throw new Error("local Stockfish process is not running");
    }
    this.child.stdin.write(`${command}\n`);
  }

  consumeStdout(text) {
    this.stdoutBuffer += text;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.consumeLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  consumeLine(line) {
    this.captureInfoLine(line);
    this.lines.push(line);
    this.resolveWaiters();
  }

  captureInfoLine(line) {
    if (!line.startsWith("info ")) {
      return;
    }
    const score = /(?:^|\s)score\s+cp\s+(-?\d+)(?:\s|$)/u.exec(line);
    if (score !== null) {
      this.lastScoreCp = Number.parseInt(score[1], 10);
    }
    const mate = /(?:^|\s)score\s+mate\s+(-?\d+)(?:\s|$)/u.exec(line);
    if (mate !== null) {
      const mateIn = Number.parseInt(mate[1], 10);
      this.lastScoreCp = mateIn > 0
        ? forcedMateScoreCp - Math.abs(mateIn)
        : -forcedMateScoreCp + Math.abs(mateIn);
    }
    const nodes = /(?:^|\s)nodes\s+(\d+)(?:\s|$)/u.exec(line);
    if (nodes !== null) {
      this.lastNodes = Number.parseInt(nodes[1], 10);
    }
  }

  waitForLine(predicate, timeoutMs, label, onWaiter) {
    const existingIndex = this.lines.findIndex(predicate);
    if (existingIndex !== -1) {
      const [line] = this.lines.splice(existingIndex, 1);
      return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        stopTimeout: null,
        timeout: setTimeout(() => {
          this.rejectWaiter(waiter, new Error(`timed out waiting for ${label}`));
        }, timeoutMs)
      };
      this.waiters.push(waiter);
      onWaiter?.(waiter);
    });
  }

  resolveWaiters() {
    for (const waiter of [...this.waiters]) {
      const lineIndex = this.lines.findIndex(waiter.predicate);
      if (lineIndex === -1) {
        continue;
      }
      const [line] = this.lines.splice(lineIndex, 1);
      this.clearWaiter(waiter);
      waiter.resolve(line);
    }
  }

  rejectWaiter(waiter, error) {
    if (!this.waiters.some((candidate) => candidate === waiter)) {
      return;
    }
    this.clearWaiter(waiter);
    waiter.reject(error);
  }

  clearWaiter(waiter) {
    clearTimeout(waiter.timeout);
    if (waiter.stopTimeout !== null) {
      clearTimeout(waiter.stopTimeout);
    }
    this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
    if (this.activeSearchWaiter === waiter) {
      this.activeSearchWaiter = null;
    }
  }

  rejectWaiters(error) {
    for (const waiter of [...this.waiters]) {
      this.clearWaiter(waiter);
      waiter.reject(error);
    }
    this.waiters = [];
    this.activeSearchWaiter = null;
  }
}

function parseBestMoveLine(line) {
  const [, move] = /^bestmove\s+(\S+)/u.exec(line) ?? [];
  if (move === undefined || move === "0000") {
    return null;
  }
  if (move === "(none)") {
    return { bestMove: null, terminal: true };
  }
  if (!coordinateMovePattern.test(move)) {
    return null;
  }
  return { bestMove: move, terminal: false };
}
