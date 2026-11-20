import type { BestMoveDto } from "./engine-dtos.js";
import type {
  PlayBestMoveContext,
  PlayEngine,
  PlayEngineMode,
  PlayEngineResult
} from "./play-wasm-executor.js";

export type PlayBestMoveProvider = {
  readonly isAvailable: () => boolean;
  readonly prepareNewGame?: () => Promise<PlayEngineResult<void>>;
  readonly bestMove: (
    fen: string,
    depth: number,
    legalMoves: readonly string[]
  ) => Promise<PlayEngineResult<BestMoveDto>>;
  readonly cancelSearch?: () => void;
};

export type HybridPlayEngineOptions = {
  readonly owned: PlayEngine;
  readonly stockfishProvider?: PlayBestMoveProvider | undefined;
};

export function createHybridPlayEngine(options: HybridPlayEngineOptions): PlayEngine {
  const { owned, stockfishProvider } = options;
  let stockfishUnavailable = stockfishProvider === undefined || !stockfishProvider.isAvailable();

  const mode = (): PlayEngineMode => {
    if (stockfishProvider === undefined) {
      return owned.mode?.() ?? "owned-local";
    }
    return stockfishUnavailable || !stockfishProvider.isAvailable()
      ? "owned-local-stockfish-unavailable"
      : "local-stockfish";
  };

  const markStockfishUnavailable = (): void => {
    if (stockfishProvider !== undefined) {
      stockfishUnavailable = true;
    }
  };

  return {
    mode,
    cancelSearch: () => {
      stockfishProvider?.cancelSearch?.();
      owned.cancelSearch?.();
    },
    newGame: async () => {
      if (stockfishProvider !== undefined && !stockfishUnavailable) {
        const prepared = await runProviderOperation(() => stockfishProvider.prepareNewGame?.());
        if (prepared?.ok === false) {
          markStockfishUnavailable();
        }
      }
      return owned.newGame();
    },
    makeMove: (fen: string, mv: string) => owned.makeMove(fen, mv),
    ...(owned.loadPosition !== undefined && { loadPosition: owned.loadPosition }),
    bestMove: async (
      fen: string,
      depth: number,
      legalMoves?: readonly string[],
      aggressive = false,
      context?: PlayBestMoveContext
    ) => {
      // Stockfish has a context-free provider contract, so contextual requests must stay on the
      // owned engine; aggressive requests also stay owned because Stockfish has a neutral style.
      if (
        !aggressive &&
        context === undefined &&
        stockfishProvider !== undefined &&
        !stockfishUnavailable &&
        stockfishProvider.isAvailable()
      ) {
        if (legalMoves !== undefined) {
          const stockfishResult = await runProviderOperation(() =>
            stockfishProvider.bestMove(fen, depth, legalMoves)
          );
          if (
            stockfishResult?.ok === true &&
            stockfishResult.value.bestMove !== null &&
            isLegalProviderMove(stockfishResult.value.bestMove, legalMoves)
          ) {
            return stockfishResult;
          }
        }
        markStockfishUnavailable();
      }
      return owned.bestMove(fen, depth, legalMoves, aggressive, context);
    }
  };
}

async function runProviderOperation<T>(
  operation: () => Promise<PlayEngineResult<T>> | undefined
): Promise<PlayEngineResult<T> | undefined> {
  try {
    return await operation();
  } catch {
    return { ok: false, error: "search-failed" };
  }
}

function isLegalProviderMove(move: string, legalMoves?: readonly string[]): boolean {
  return legalMoves !== undefined && legalMoves.includes(move);
}
