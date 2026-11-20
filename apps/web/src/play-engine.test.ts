import type { BestMoveDto, EngineStateDto, MoveResultDto } from "./engine-dtos";
import { createHybridPlayEngine, type PlayBestMoveProvider } from "./play-engine";
import type {
  PlayBestMoveContext,
  PlayEngine,
  PlayEngineResult
} from "./play-wasm-executor";

function expectEqual<T>(actual: T, expected: T): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`expected ${expectedText}, got ${actualText}`);
  }
}

const startState: EngineStateDto = {
  fen: "startpos",
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["e2e4"]
};

const afterE4: MoveResultDto = {
  appliedMove: "e2e4",
  san: "e4",
  state: {
    fen: "after e4",
    status: "ongoing",
    sideToMove: "black",
    legalMoves: ["b8c6"]
  }
};

function ownedEngine(
  calls: string[],
  onBestMove?: (context: PlayBestMoveContext | undefined) => void
): PlayEngine {
  return {
    mode: () => "owned-local",
    cancelSearch: () => {
      calls.push("owned:cancel");
    },
    newGame: () => {
      calls.push("owned:newGame");
      return Promise.resolve({ ok: true, value: startState });
    },
    makeMove: (_fen, mv) => {
      calls.push(`owned:makeMove:${mv}`);
      return Promise.resolve({ ok: true, value: afterE4 });
    },
    bestMove: (_fen, depth, _legalMoves, _aggressive, context) => {
      onBestMove?.(context);
      calls.push(`owned:bestMove:${String(depth)}`);
      return Promise.resolve({
        ok: true,
        value: { bestMove: "g1f3", depth, scoreCp: 3, nodes: 5, ttHits: 0 }
      });
    }
  };
}

function provider(
  calls: string[],
  result: PlayEngineResult<BestMoveDto>,
  available = true
): PlayBestMoveProvider {
  return {
    isAvailable: () => available,
    cancelSearch: () => {
      calls.push("stockfish:cancel");
    },
    prepareNewGame: () => {
      calls.push("stockfish:newGame");
      return Promise.resolve({ ok: true, value: undefined });
    },
    bestMove: (_fen, depth) => {
      calls.push(`stockfish:bestMove:${String(depth)}`);
      return Promise.resolve(result);
    }
  };
}

const ownedOnlyCalls: string[] = [];
const ownedOnly = createHybridPlayEngine({ owned: ownedEngine(ownedOnlyCalls) });
expectEqual(ownedOnly.mode?.(), "owned-local");
expectEqual(await ownedOnly.newGame(), { ok: true, value: startState });
expectEqual(await ownedOnly.bestMove("startpos", 1), {
  ok: true,
  value: { bestMove: "g1f3", depth: 1, scoreCp: 3, nodes: 5, ttHits: 0 }
});
expectEqual(ownedOnlyCalls, ["owned:newGame", "owned:bestMove:1"]);

const stockfishCalls: string[] = [];
const stockfishEngine = createHybridPlayEngine({
  owned: ownedEngine(stockfishCalls),
  stockfishProvider: provider(stockfishCalls, {
    ok: true,
    value: { bestMove: "b8c6", depth: 2, scoreCp: 17, nodes: 123, ttHits: 0 }
  })
});
expectEqual(stockfishEngine.mode?.(), "local-stockfish");
expectEqual(await stockfishEngine.newGame(), { ok: true, value: startState });
expectEqual(await stockfishEngine.bestMove("after e4", 2, ["b8c6"]), {
  ok: true,
  value: { bestMove: "b8c6", depth: 2, scoreCp: 17, nodes: 123, ttHits: 0 }
});
expectEqual(await stockfishEngine.makeMove("startpos", "e2e4"), { ok: true, value: afterE4 });
stockfishEngine.cancelSearch?.();
expectEqual(stockfishCalls, [
  "stockfish:newGame",
  "owned:newGame",
  "stockfish:bestMove:2",
  "owned:makeMove:e2e4",
  "stockfish:cancel",
  "owned:cancel"
]);

const contextualCalls: string[] = [];
let receivedContext: PlayBestMoveContext | undefined;
const contextualEngine = createHybridPlayEngine({
  owned: ownedEngine(contextualCalls, context => {
    receivedContext = context;
  }),
  stockfishProvider: provider(contextualCalls, {
    ok: true,
    value: { bestMove: "b8c6", depth: 6, scoreCp: 17, nodes: 123, ttHits: 0 }
  })
});
const context: PlayBestMoveContext = {
  side: "black",
  userSide: "white",
  historyFens: ["startpos"],
  previousLine: ["e2e4", "b8c6"]
};
expectEqual(await contextualEngine.bestMove("after e4", 6, ["b8c6"], false, context), {
  ok: true,
  value: { bestMove: "g1f3", depth: 6, scoreCp: 3, nodes: 5, ttHits: 0 }
});
expectEqual(receivedContext, context);
expectEqual(await contextualEngine.bestMove("after e4", 6, ["b8c6"]), {
  ok: true,
  value: { bestMove: "b8c6", depth: 6, scoreCp: 17, nodes: 123, ttHits: 0 }
});
expectEqual(contextualCalls, ["owned:bestMove:6", "stockfish:bestMove:6"]);

const illegalMoveCalls: string[] = [];
const illegalMoveEngine = createHybridPlayEngine({
  owned: ownedEngine(illegalMoveCalls),
  stockfishProvider: provider(illegalMoveCalls, {
    ok: true,
    value: { bestMove: "a7a6", depth: 4, scoreCp: 50, nodes: 50, ttHits: 0 }
  })
});
expectEqual(await illegalMoveEngine.bestMove("after e4", 4, ["b8c6"]), {
  ok: true,
  value: { bestMove: "g1f3", depth: 4, scoreCp: 3, nodes: 5, ttHits: 0 }
});
expectEqual(illegalMoveEngine.mode?.(), "owned-local-stockfish-unavailable");
expectEqual(illegalMoveCalls, ["stockfish:bestMove:4", "owned:bestMove:4"]);

const unavailableCalls: string[] = [];
const unavailableEngine = createHybridPlayEngine({
  owned: ownedEngine(unavailableCalls),
  stockfishProvider: provider(
    unavailableCalls,
    { ok: false, error: "search-failed" },
    false
  )
});
expectEqual(unavailableEngine.mode?.(), "owned-local-stockfish-unavailable");
expectEqual(await unavailableEngine.bestMove("after e4", 3), {
  ok: true,
  value: { bestMove: "g1f3", depth: 3, scoreCp: 3, nodes: 5, ttHits: 0 }
});
expectEqual(unavailableCalls, ["owned:bestMove:3"]);

const missingLegalMovesCalls: string[] = [];
const missingLegalMovesEngine = createHybridPlayEngine({
  owned: ownedEngine(missingLegalMovesCalls),
  stockfishProvider: provider(missingLegalMovesCalls, {
    ok: true,
    value: { bestMove: "b8c6", depth: 5, scoreCp: 21, nodes: 80, ttHits: 0 }
  })
});
expectEqual(await missingLegalMovesEngine.bestMove("after e4", 5), {
  ok: true,
  value: { bestMove: "g1f3", depth: 5, scoreCp: 3, nodes: 5, ttHits: 0 }
});
expectEqual(missingLegalMovesEngine.mode?.(), "owned-local-stockfish-unavailable");
expectEqual(missingLegalMovesCalls, ["owned:bestMove:5"]);

for (const failedStockfishResult of [
  { ok: false, error: "search-failed" },
  { ok: true, value: { bestMove: null, depth: 1, scoreCp: 0, nodes: 0, ttHits: 0 } }
] as const) {
  const fallbackCalls: string[] = [];
  const fallbackEngine = createHybridPlayEngine({
    owned: ownedEngine(fallbackCalls),
    stockfishProvider: provider(fallbackCalls, failedStockfishResult)
  });
  expectEqual(await fallbackEngine.bestMove("after e4", 1, ["b8c6"]), {
    ok: true,
    value: { bestMove: "g1f3", depth: 1, scoreCp: 3, nodes: 5, ttHits: 0 }
  });
  expectEqual(fallbackEngine.mode?.(), "owned-local-stockfish-unavailable");
  expectEqual(fallbackCalls, ["stockfish:bestMove:1", "owned:bestMove:1"]);
}
