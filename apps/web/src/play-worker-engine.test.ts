import type { EngineStateDto, ReactionMapDto } from "./engine-dtos";
import { createPlayWorkerEngine } from "./play-worker-engine";
import type { PlayEngineResult } from "./play-wasm-executor";

function expectEqual<T>(actual: T, expected: T): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`expected ${expectedText}, got ${actualText}`);
  }
}

type WorkerEnvelope = {
  readonly id: number;
  readonly result: PlayEngineResult<unknown>;
};

type WorkerMessage = Record<string, unknown>;

type WorkerMessageListener = (event: MessageEvent<WorkerEnvelope>) => void;

class FakeWorker {
  static readonly instances: FakeWorker[] = [];

  readonly messages: WorkerMessage[] = [];
  terminated = false;
  private listener: WorkerMessageListener | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;

  constructor(
    readonly url: string,
    readonly options?: WorkerOptions
  ) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: "message" | "error", listener: unknown): void {
    if (type === "message") {
      this.listener = listener as WorkerMessageListener;
    } else {
      this.errorListener = listener as (event: ErrorEvent) => void;
    }
  }

  crash(message: string): void {
    if (this.errorListener === null) {
      throw new Error("worker error listener missing");
    }
    this.errorListener({ message } as ErrorEvent);
  }

  postMessage(message: unknown): void {
    if (isRecord(message)) {
      this.messages.push(message);
    }
  }

  respond(id: number, result: PlayEngineResult<unknown>): void {
    if (this.listener === null) {
      throw new Error("worker listener missing");
    }
    this.listener({ data: { id, result } } as MessageEvent<WorkerEnvelope>);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageAt(worker: FakeWorker, index: number): WorkerMessage {
  const message = worker.messages[index];
  if (message === undefined) {
    throw new Error(`missing worker message ${String(index)}`);
  }
  return message;
}

function messageId(message: WorkerMessage): number {
  if (typeof message.id !== "number") {
    throw new Error("worker message id missing");
  }
  return message.id;
}

async function flushWorkerContinuations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const startState: EngineStateDto = {
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["e2e4"]
};

const reactionMap: ReactionMapDto = {
  state: startState,
  rootCandidates: [{ move: "e2e4", scoreCp: 12, hangs: false, mateIn: null, quality: "best" }],
  principalLine: ["e2e4"],
  projectedLine: ["e2e4"],
  mateDetected: false,
  depth: 2,
  nodes: 12
};

const workerHost = globalThis as unknown as { Worker?: typeof Worker };
const originalWorker = workerHost.Worker;
workerHost.Worker = FakeWorker as unknown as typeof Worker;

try {
  const engine = createPlayWorkerEngine("./move-worker.js", "./analysis-worker.js");
  expectEqual(FakeWorker.instances.map((worker) => worker.url), [
    "./move-worker.js",
    "./analysis-worker.js"
  ]);
  expectEqual(FakeWorker.instances.map((worker) => worker.options?.type), ["module", "module"]);

  const analysisWorker = FakeWorker.instances[1];
  if (analysisWorker === undefined || engine.reactionMap === undefined) {
    throw new Error("analysis worker missing");
  }
  if (engine.sideExplore === undefined) {
    throw new Error("side Explore worker operation missing");
  }
  const moveWorker = FakeWorker.instances[0];
  if (moveWorker === undefined) {
    throw new Error("move worker missing");
  }

  const moveRequest = engine.bestMove(startState.fen, 1, startState.legalMoves);
  const sideExploreRequest = engine.sideExplore(startState.fen, "white", true);
  await flushWorkerContinuations();
  const moveMessage = messageAt(moveWorker, 0);
  const sideExploreMessage = messageAt(analysisWorker, 0);
  expectEqual(moveMessage.op, "bestMove");
  expectEqual(sideExploreMessage.op, "sideExplore");
  const moveResult = { ok: false, error: "search-failed" } as const;
  const sideExploreResult = { ok: false, error: "search-failed" } as const;
  moveWorker.respond(messageId(moveMessage), moveResult);
  analysisWorker.respond(messageId(sideExploreMessage), sideExploreResult);
  expectEqual(await moveRequest, moveResult);
  expectEqual(await sideExploreRequest, sideExploreResult);

  const staleRequest = engine.reactionMap(startState.fen, 2, false);
  await flushWorkerContinuations();
  const staleMessage = messageAt(analysisWorker, 1);
  expectEqual(staleMessage.op, "reactionMap");

  engine.cancelSearch?.();
  // A deliberate cancel is its own outcome, never reported as an engine failure.
  expectEqual(await staleRequest, { ok: false, error: "cancelled" });
  expectEqual(moveWorker.terminated, false);
  expectEqual(analysisWorker.terminated, true);

  const freshRequest = engine.reactionMap(startState.fen, 2, false);
  await flushWorkerContinuations();
  const freshAnalysisWorker = FakeWorker.instances[2];
  if (freshAnalysisWorker === undefined) {
    throw new Error("fresh analysis worker missing after cancel");
  }
  expectEqual(freshAnalysisWorker.url, "./analysis-worker.js");
  expectEqual(freshAnalysisWorker.options?.type, "module");
  const freshMessage = messageAt(freshAnalysisWorker, 0);
  freshAnalysisWorker.respond(messageId(freshMessage), { ok: true, value: reactionMap });
  expectEqual(await freshRequest, { ok: true, value: reactionMap });

  // A crashed worker fails its in-flight request with the real reason.
  const crashedRequest = engine.reactionMap(startState.fen, 2, false);
  await flushWorkerContinuations();
  freshAnalysisWorker.crash("module failed to load");
  expectEqual(await crashedRequest, {
    ok: false,
    error: "search-failed",
    detail: "module failed to load"
  });
} finally {
  if (originalWorker === undefined) {
    delete workerHost.Worker;
  } else {
    workerHost.Worker = originalWorker;
  }
}
