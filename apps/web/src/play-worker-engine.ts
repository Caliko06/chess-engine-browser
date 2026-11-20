import type {
  BestMoveDto,
  ColorDto,
  EngineStateDto,
  ForcingMapDto,
  MoveResultDto,
  ReactionMapDto,
  SideExploreDto
} from "./engine-dtos.js";
import type {
  PlayBestMoveContext,
  PlayEngine,
  PlayEngineResult,
  PlaySideExploreContext
} from "./play-wasm-executor.js";

type WorkerResponse = { readonly id: number; readonly result: PlayEngineResult<unknown> };

function makeWorker(url: string): Worker {
  return new Worker(url, { type: "module" });
}

function makeChannel(worker: Worker): {
  send: <T>(
    msg: Record<string, unknown>,
    options?: { readonly cancelable?: boolean }
  ) => Promise<PlayEngineResult<T>>;
  cancel: () => void;
} {
  let nextId = 1;
  const pending = new Map<
    number,
    {
      readonly cancelable: boolean;
      readonly resolve: (r: PlayEngineResult<unknown>) => void;
    }
  >();

  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const { id, result } = event.data;
    const entry = pending.get(id);
    if (entry !== undefined) {
      pending.delete(id);
      entry.resolve(result);
    }
  });

  // A worker that dies (script error, failed module load) never answers: fail its requests with
  // the reason instead of leaving the UI waiting forever.
  worker.addEventListener("error", (event: ErrorEvent) => {
    const detail = event.message.length > 0 ? event.message : "worker error";
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.resolve({ ok: false, error: "search-failed", detail });
    }
  });

  return {
    send: <T>(
      msg: Record<string, unknown>,
      options: { readonly cancelable?: boolean } = {}
    ): Promise<PlayEngineResult<T>> => {
      const id = nextId++;
      return new Promise<PlayEngineResult<T>>((resolve) => {
        pending.set(id, {
          cancelable: options.cancelable ?? true,
          resolve: resolve as (r: PlayEngineResult<unknown>) => void
        });
        worker.postMessage({ ...msg, id });
      });
    },
    cancel: () => {
      for (const [id, entry] of pending) {
        if (!entry.cancelable) {
          continue;
        }
        entry.resolve({ ok: false, error: "cancelled" });
        pending.delete(id);
      }
    }
  };
}

export function createPlayWorkerEngine(
  moveWorkerUrl: string,
  analysisWorkerUrl: string
): PlayEngine {
  const moveWorker = makeWorker(moveWorkerUrl);
  let analysisWorker = makeWorker(analysisWorkerUrl);
  const move = makeChannel(moveWorker);
  let analysis = makeChannel(analysisWorker);
  const recreateAnalysisWorker = (): void => {
    analysis.cancel();
    analysisWorker.terminate();
    analysisWorker = makeWorker(analysisWorkerUrl);
    analysis = makeChannel(analysisWorker);
  };

  return {
    mode: () => "owned-local",
    newGame: () => move.send<EngineStateDto>({ op: "newGame" }),
    makeMove: (fen: string, mv: string) => move.send<MoveResultDto>({ op: "makeMove", fen, mv }),
    loadPosition: (fen: string) => move.send<EngineStateDto>({ op: "loadPosition", fen }),
    bestMove: async (
      fen: string,
      depth: number,
      legalMoves?: readonly string[],
      aggressive = false,
      context: PlayBestMoveContext | undefined = undefined
    ) => {
      return move.send<BestMoveDto>({
        op: "bestMove",
        fen,
        depth,
        legalMoves,
        aggressive,
        ...(context !== undefined ? { context } : {})
      });
    },
    reactionMap: async (fen: string, depth: number, deep: boolean) => {
      return analysis.send<ReactionMapDto>({ op: "reactionMap", fen, depth, deep });
    },
    forcingMap: async (fen: string, depth: number, host: ColorDto, deep: boolean) => {
      return analysis.send<ForcingMapDto>({ op: "forcingMap", fen, depth, host, deep });
    },
    sideExplore: async (
      fen: string,
      side: ColorDto,
      aggressive = false,
      historyFens = [],
      context: PlaySideExploreContext | undefined = undefined
    ) => {
      return analysis.send<SideExploreDto>({
        op: "sideExplore",
        fen,
        side,
        aggressive,
        historyFens,
        ...(context !== undefined ? { context } : {})
      });
    },
    cancelSearch: (): void => {
      recreateAnalysisWorker();
    }
  };
}
