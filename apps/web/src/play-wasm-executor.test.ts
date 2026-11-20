import type {
  EngineStateDto,
  ForcingMapDto,
  MoveResultDto,
  ReactionMapDto,
  SideExploreDto
} from "./engine-dtos";
import {
  createPlayWasmExecutor,
  validateEngineStateDto,
  validateForcingMapDto,
  validateReactionMapDto,
  validateSideExploreDto,
  type PlayWasmModule
} from "./play-wasm-executor";

function expectEqual<T>(actual: T, expected: T): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`expected ${expectedText}, got ${actualText}`);
  }
}

const startState: EngineStateDto = {
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["e2e3", "e2e4"]
};

const afterE4: MoveResultDto = {
  appliedMove: "e2e4",
  san: "e4",
  state: {
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    status: "ongoing",
    sideToMove: "black",
    legalMoves: ["b8c6"]
  }
};

const aggressiveThreatModel = {
  version: 1,
  side: "black",
  ownThreat: { kind: "check", move: "b8c6", mateIn: null },
  opponentDanger: { kind: "quiet", move: "g1f3", mateIn: null },
  followUp: { kind: "king-pressure", move: "g8f6", mateIn: null },
  risk: "bounded"
} as const;

const requests: string[] = [];
let loadCount = 0;
const wasmModule: PlayWasmModule = {
  new_game_json: () => {
    requests.push("new_game_json");
    return JSON.stringify({ ok: true, state: startState });
  },
  make_move_json: (fen: string, mv: string) => {
    requests.push(`make_move_json:${fen}:${mv}`);
    return JSON.stringify({ ok: true, move: afterE4 });
  },
  best_move_json: (fen: string, depth: number, aggressive: boolean, nodeBudget: number) => {
    requests.push(`best_move_json:${fen}:${String(depth)}:${String(aggressive)}:${String(nodeBudget)}`);
    return JSON.stringify({
      ok: true,
      bestMove: { bestMove: "b8c6", depth, scoreCp: 12, nodes: 20, ttHits: 0 }
    });
  }
};

const engine = createPlayWasmExecutor(() => {
  loadCount += 1;
  return Promise.resolve(wasmModule);
});

expectEqual(await engine.newGame(), { ok: true, value: startState });
expectEqual(await engine.makeMove(startState.fen, "e2e4"), { ok: true, value: afterE4 });
const contextRequests: string[] = [];
const contextEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    ...wasmModule,
    make_move_context_json: (fen: string, mv: string, historyFens: string) => {
      contextRequests.push(`${fen}:${mv}:${historyFens}`);
      return JSON.stringify({ ok: true, move: afterE4 });
    }
  })
);
expectEqual(await contextEngine.makeMove(startState.fen, "e2e4", [startState.fen]), {
  ok: true,
  value: afterE4
});
expectEqual(contextRequests, [`${startState.fen}:e2e4:${startState.fen}`]);
// Strength level 1 stays truly shallow while retaining its bounded node envelope.
expectEqual(await engine.bestMove(afterE4.state.fen, 1), {
  ok: true,
  value: { bestMove: "b8c6", depth: 1, scoreCp: 12, nodes: 20, ttHits: 0 }
});
expectEqual(await engine.bestMove(afterE4.state.fen, 3), {
  ok: true,
  value: { bestMove: "b8c6", depth: 12, scoreCp: 12, nodes: 20, ttHits: 0 }
});
expectEqual(loadCount, 1);
expectEqual(requests, [
  "new_game_json",
  `make_move_json:${startState.fen}:e2e4`,
  `best_move_json:${afterE4.state.fen}:1:false:60000`,
  `best_move_json:${afterE4.state.fen}:12:false:240000`
]);

const contextualRequests: string[] = [];
const contextualEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: startState }),
    make_move_json: () => JSON.stringify({ ok: true, move: afterE4 }),
    best_move_json: () => JSON.stringify({ ok: false, error: "search-failed" }),
    best_move_context_json: (
      fen: string,
      depth: number,
      aggressive: boolean,
      side: string,
      historyFens: string,
      previousLine: string,
      nodeBudget: number
    ) => {
      contextualRequests.push(
        `best_move_context_json:${fen}:${String(depth)}:${String(aggressive)}:${side}:${historyFens}:${previousLine}:${String(nodeBudget)}`
      );
      return JSON.stringify({
        ok: true,
        bestMove: {
          bestMove: "b8c6",
          depth,
          scoreCp: 18,
          nodes: 40,
          ttHits: 0,
          principalLine: ["b8c6", "g1f3", "g8f6"],
          followedPlan: true,
          plan: {
            version: 1,
            side: "black",
            status: "followed",
            reason: "matched-history-and-gate",
            line: ["b8c6", "g1f3", "g8f6"],
            expectedReply: "g1f3",
            continuation: "g8f6",
            degraded: false,
            threatModel: aggressiveThreatModel
          }
        }
      });
    }
  })
);
expectEqual(
  await contextualEngine.bestMove(afterE4.state.fen, 1, afterE4.state.legalMoves, true, {
    side: "black",
    userSide: "white",
    historyFens: [startState.fen],
    previousLine: ["e2e4", "b8c6", "g1f3"]
  }),
  {
    ok: true,
    value: {
      bestMove: "b8c6",
      depth: 1,
      scoreCp: 18,
      nodes: 40,
      ttHits: 0,
      principalLine: ["b8c6", "g1f3", "g8f6"],
      followedPlan: true,
      plan: {
        version: 1,
        side: "black",
        status: "followed",
        reason: "matched-history-and-gate",
        line: ["b8c6", "g1f3", "g8f6"],
        expectedReply: "g1f3",
        continuation: "g8f6",
        degraded: false,
        threatModel: aggressiveThreatModel
      }
    }
  }
);
expectEqual(contextualRequests, [
  `best_move_context_json:${afterE4.state.fen}:1:true:black:${startState.fen}:e2e4,b8c6,g1f3:60000`
]);

const userPerspectiveRequests: string[] = [];
const userPerspectiveEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: startState }),
    make_move_json: () => JSON.stringify({ ok: true, move: afterE4 }),
    best_move_json: () => JSON.stringify({ ok: false, error: "search-failed" }),
    engine_move_json: (
      fen: string,
      historyFens: string,
      level: number,
      nodeBudget: number,
      seed: number
    ) => {
      userPerspectiveRequests.push(
        `engine_move_json:${fen}:${historyFens}:${String(level)}:${String(nodeBudget)}:${String(Number.isInteger(seed) && seed >= 0 && seed < 0x1_0000_0000)}`
      );
      return JSON.stringify({
        ok: true,
        bestMove: { bestMove: "b8c6", depth: 4, scoreCp: 22, nodes: 30, ttHits: 0 }
      });
    }
  })
);
expectEqual(
  await userPerspectiveEngine.bestMove(afterE4.state.fen, 3, afterE4.state.legalMoves, true, {
    side: "black",
    userSide: "white",
    historyFens: [startState.fen],
    previousLine: []
  }),
  {
    ok: true,
    value: { bestMove: "b8c6", depth: 4, scoreCp: 22, nodes: 30, ttHits: 0 }
  }
);
expectEqual(userPerspectiveRequests, [
  `engine_move_json:${afterE4.state.fen}:${startState.fen}:3:1000000:true`
]);

const malformedContextEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: startState }),
    make_move_json: () => JSON.stringify({ ok: true, move: afterE4 }),
    best_move_json: () => JSON.stringify({ ok: false, error: "search-failed" }),
    best_move_context_json: () =>
      JSON.stringify({
        ok: true,
        bestMove: {
          bestMove: "b8c6",
          depth: 8,
          scoreCp: 18,
          nodes: 40,
          ttHits: 0,
          principalLine: ["b8c6", "g1f3", "g8f6"],
          followedPlan: true,
          plan: {
            version: 1,
            side: "black",
            status: "followed",
            reason: "matched-history-and-gate",
            line: ["b8c6", "g1f3", "g8f6"],
            expectedReply: "g1f3",
            continuation: "g8f6",
            degraded: false,
            threatModel: { ...aggressiveThreatModel, risk: "loose" }
          }
        }
      })
  })
);
expectEqual(
  await malformedContextEngine.bestMove(afterE4.state.fen, 1, afterE4.state.legalMoves, true, {
    side: "black",
    userSide: "white",
    historyFens: [startState.fen],
    previousLine: ["e2e4", "b8c6", "g1f3"]
  }),
  { ok: false, error: "invalid-response" }
);

const errorEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: false, error: "invalid-fen" }),
    make_move_json: () => JSON.stringify({ ok: false, error: "invalid-move" }),
    best_move_json: () => JSON.stringify({ ok: false, error: "invalid-depth" })
  })
);
expectEqual(await errorEngine.newGame(), { ok: false, error: "invalid-fen" });
expectEqual(await errorEngine.makeMove(startState.fen, "e2e5"), {
  ok: false,
  error: "invalid-move"
});
expectEqual(await errorEngine.bestMove(startState.fen, 0), {
  ok: false,
  error: "invalid-depth"
});

const malformedEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: { ...startState, extra: true } }),
    make_move_json: () => "{",
    best_move_json: () =>
      JSON.stringify({
        ok: true,
        bestMove: { bestMove: "B8C6", depth: 1, scoreCp: 0, nodes: 0, ttHits: 0 }
      })
  })
);
expectEqual(await malformedEngine.newGame(), { ok: false, error: "invalid-response" });
expectEqual(await malformedEngine.makeMove(startState.fen, "e2e4"), {
  ok: false,
  error: "invalid-response"
});
expectEqual(await malformedEngine.bestMove(startState.fen, 1), {
  ok: false,
  error: "invalid-response"
});

// A module that throws is a real engine failure and keeps its cause.
const throwingEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => {
      throw new Error("wasm trap");
    },
    make_move_json: () => "{}",
    best_move_json: () => "{}"
  })
);
expectEqual(await throwingEngine.newGame(), {
  ok: false,
  error: "search-failed",
  detail: "wasm trap"
});

expectEqual(validateEngineStateDto(startState), startState);
expectEqual(
  validateEngineStateDto({
    ...startState,
    status: "draw",
    drawReason: "threefold-repetition"
  }),
  {
    fen: startState.fen,
    status: "draw",
    drawReason: "threefold-repetition",
    sideToMove: startState.sideToMove,
    legalMoves: startState.legalMoves
  }
);
expectEqual(validateEngineStateDto({ ...startState, legalMoves: ["e2e9"] }), null);

const reactionMap: ReactionMapDto = {
  state: afterE4.state,
  rootCandidates: [
    { move: "b8c6", scoreCp: 16, hangs: false, mateIn: null, quality: "best" },
    { move: "g8f6", scoreCp: 8, hangs: false, mateIn: null, quality: "mistake" }
  ],
  principalLine: ["b8c6", "g1f3"],
  projectedLine: ["b8c6", "g1f3"],
  mateDetected: false,
  depth: 2,
  nodes: 42
};

const reactionRequests: string[] = [];
const reactionEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: startState }),
    make_move_json: () => JSON.stringify({ ok: true, move: afterE4 }),
    best_move_json: () => JSON.stringify({ ok: false, error: "search-failed" }),
    reaction_map_json: (fen: string, depth: number, deep: boolean) => {
      reactionRequests.push(`reaction_map_json:${fen}:${String(depth)}:${String(deep)}`);
      return JSON.stringify({ ok: true, reactionMap });
    }
  })
);
expectEqual(await reactionEngine.reactionMap?.(afterE4.state.fen, 2, true), {
  ok: true,
  value: reactionMap
});
expectEqual(reactionRequests, [`reaction_map_json:${afterE4.state.fen}:2:true`]);

const missingReactionEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: startState }),
    make_move_json: () => JSON.stringify({ ok: true, move: afterE4 }),
    best_move_json: () => JSON.stringify({ ok: false, error: "search-failed" })
  })
);
expectEqual(await missingReactionEngine.reactionMap?.(startState.fen, 2, false), {
  ok: false,
  error: "search-failed"
});

const malformedReactionEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: startState }),
    make_move_json: () => JSON.stringify({ ok: true, move: afterE4 }),
    best_move_json: () => JSON.stringify({ ok: false, error: "search-failed" }),
    reaction_map_json: () =>
      JSON.stringify({ ok: true, reactionMap: { ...reactionMap, principalLine: ["e2e9"] } })
  })
);
expectEqual(await malformedReactionEngine.reactionMap?.(startState.fen, 2, false), {
  ok: false,
  error: "invalid-response"
});

// Levels 1..6 each have a distinct depth/node envelope (level 5 and level 6 must not share 960k).
const levelRequests: string[] = [];
const levelEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: startState }),
    make_move_json: () => JSON.stringify({ ok: true, move: afterE4 }),
    best_move_json: (_fen: string, depth: number, _aggressive: boolean, nodeBudget: number) => {
      levelRequests.push(`${String(depth)}:${String(nodeBudget)}`);
      return JSON.stringify({
        ok: true,
        bestMove: { bestMove: "b8c6", depth, scoreCp: 0, nodes: nodeBudget, ttHits: 0 }
      });
    }
  })
);
for (const level of [1, 2, 3, 4, 5, 6]) {
  await levelEngine.bestMove(afterE4.state.fen, level);
}
expectEqual(levelRequests, [
  "1:60000",
  "8:120000",
  "12:240000",
  "14:480000",
  "16:960000",
  "18:1920000"
]);

const forcingMap: ForcingMapDto = {
  state: startState,
  host: "white",
  onTurn: true,
  candidates: [
    { move: "e2e4", kind: "defense", scoreCp: 16, sound: true, mateIn: null },
    { move: "e2e3", kind: "defense", scoreCp: 8, sound: true, mateIn: null }
  ],
  depth: 2,
  nodes: 20
};

const forcingRequests: string[] = [];
const forcingEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: startState }),
    make_move_json: () => JSON.stringify({ ok: true, move: afterE4 }),
    best_move_json: () => JSON.stringify({ ok: false, error: "search-failed" }),
    forcing_map_json: (fen: string, depth: number, host: string, deep: boolean) => {
      forcingRequests.push(`forcing_map_json:${fen}:${String(depth)}:${host}:${String(deep)}`);
      return JSON.stringify({ ok: true, forcingMap });
    }
  })
);
expectEqual(await forcingEngine.forcingMap?.(startState.fen, 2, "white", true), {
  ok: true,
  value: forcingMap
});
expectEqual(forcingRequests, [`forcing_map_json:${startState.fen}:2:white:true`]);

const missingForcingEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: startState }),
    make_move_json: () => JSON.stringify({ ok: true, move: afterE4 }),
    best_move_json: () => JSON.stringify({ ok: false, error: "search-failed" })
  })
);
expectEqual(await missingForcingEngine.forcingMap?.(startState.fen, 2, "white", false), {
  ok: false,
  error: "search-failed"
});

expectEqual(validateForcingMapDto(forcingMap), forcingMap);
expectEqual(validateForcingMapDto({ ...forcingMap, onTurn: "yes" }), null);
expectEqual(validateForcingMapDto({ ...forcingMap, host: "green" }), null);
expectEqual(
  validateForcingMapDto({
    ...forcingMap,
    candidates: [{ move: "e2e4", kind: "trap", scoreCp: 1, sound: true, mateIn: null }]
  }),
  null
);
expectEqual(
  validateForcingMapDto({
    ...forcingMap,
    candidates: [{ move: "e2e4", kind: "mate", scoreCp: 1, sound: true, mateIn: 0 }]
  }),
  null
);
expectEqual(
  validateForcingMapDto({
    ...forcingMap,
    candidates: [{ move: "e2e4", kind: "check", scoreCp: 1, sound: "no", mateIn: null }]
  }),
  null
);

expectEqual(validateReactionMapDto(reactionMap), reactionMap);
expectEqual(validateReactionMapDto({ ...reactionMap, mateDetected: "yes" }), null);
expectEqual(
  validateReactionMapDto({
    ...reactionMap,
    rootCandidates: [{ move: "B8C6", scoreCp: 1, hangs: false, mateIn: null, quality: "best" }]
  }),
  null
);
expectEqual(
  validateReactionMapDto({
    ...reactionMap,
    rootCandidates: [{ move: "b8c6", scoreCp: 1, hangs: "no", mateIn: null }]
  }),
  null
);
expectEqual(
  validateReactionMapDto({
    ...reactionMap,
    rootCandidates: [{ move: "b8c6", scoreCp: 1, hangs: false, mateIn: 0 }]
  }),
  null
);
expectEqual(
  validateReactionMapDto({
    ...reactionMap,
    principalLine: ["b8c6", "g1f3", "e7e5", "d2d4", "g8f6", "c2c4", "b8c6"]
  }),
  null
);

const sideExplore: SideExploreDto = {
  state: afterE4.state,
  side: "white",
  onTurn: false,
  replyCandidates: [
    {
      move: "b8c6",
      role: "objective-primary",
      kind: "defense",
      quality: "best",
      sound: true,
      sacrifice: false,
      mateIn: null
    },
    {
      move: "g8f6",
      role: "alternative",
      kind: "defense",
      quality: "excellent",
      sound: true,
      sacrifice: false,
      mateIn: null
    }
  ],
  candidates: [
    {
      move: "g1f3",
      kind: "defense",
      exactScoreCp: 18,
      sound: true,
      sacrifice: false,
      prospectiveBrilliant: false,
      mateIn: null,
      aftermath: null,
      continuation: null
    }
  ],
  principalLine: ["g1f3"],
  mateDetected: false,
  depth: 2,
  nodes: 44,
  soundMarginCp: 50
};

const sideExploreRequests: string[] = [];
const sideExploreEngine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: startState }),
    make_move_json: () => JSON.stringify({ ok: true, move: afterE4 }),
    best_move_json: () => JSON.stringify({ ok: false, error: "search-failed" }),
    side_explore_json: (fen: string, side: string, aggressive: boolean) => {
      sideExploreRequests.push(`side_explore_json:${fen}:${side}:${String(aggressive)}`);
      return JSON.stringify({ ok: true, sideExplore });
    }
  })
);
expectEqual(await sideExploreEngine.sideExplore?.(afterE4.state.fen, "white", true), {
  ok: true,
  value: sideExplore
});
expectEqual(sideExploreRequests, [`side_explore_json:${afterE4.state.fen}:white:true`]);
expectEqual(validateSideExploreDto(sideExplore), sideExplore);
expectEqual(
  validateSideExploreDto({
    ...sideExplore,
    planStatus: "followed",
    planReason: "matched-history-and-gate"
  }),
  {
    ...sideExplore,
    planStatus: "followed",
    planReason: "matched-history-and-gate"
  }
);
expectEqual(
  validateSideExploreDto({
    ...sideExplore,
    candidates: [{ ...sideExplore.candidates[0], quality: "blunder" }]
  }),
  null
);

const sideExploreExplanation: NonNullable<SideExploreDto["explanation"]> = {
  inCheck: false,
  threatened: [{ square: "d8", piece: "queen" }],
  best: {
    move: "g1f3",
    piece: "knight",
    captured: null,
    promotion: null,
    castle: null,
    check: false,
    mate: false,
    threats: [{ square: "a8", piece: "rook" }],
    savesThreatened: false,
    hangs: false
  },
  lineMaterialCp: 100
};
expectEqual(
  validateSideExploreDto({ ...sideExplore, explanation: sideExploreExplanation }),
  { ...sideExplore, explanation: sideExploreExplanation }
);
expectEqual(
  validateSideExploreDto({
    ...sideExplore,
    openingStatus: { status: "unavailable", eco: null, name: null, move: null },
    planStatus: "followed",
    planReason: "matched-history-and-gate",
    explanation: sideExploreExplanation
  })?.explanation,
  sideExploreExplanation
);
expectEqual(
  validateSideExploreDto({
    ...sideExplore,
    explanation: { ...sideExploreExplanation, extra: true }
  }),
  null
);
expectEqual(
  validateSideExploreDto({
    ...sideExplore,
    explanation: {
      ...sideExploreExplanation,
      best: { ...sideExploreExplanation.best, piece: "dragon" }
    }
  }),
  null
);
expectEqual(
  validateSideExploreDto({
    ...sideExplore,
    explanation: { ...sideExploreExplanation, threatened: [{ square: "z9", piece: "queen" }] }
  }),
  null
);

const sideExploreV2Requests: string[] = [];
const sideExploreV2Engine = createPlayWasmExecutor(() =>
  Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: true, state: startState }),
    make_move_json: () => JSON.stringify({ ok: true, move: afterE4 }),
    best_move_json: () => JSON.stringify({ ok: false, error: "search-failed" }),
    side_explore_context_v2_json: (
      fen: string,
      side: string,
      aggressive: boolean,
      historyFens: string,
      nodeBudget: number,
      previousLine: string
    ) => {
      sideExploreV2Requests.push(
        `side_explore_context_v2_json:${fen}:${side}:${String(aggressive)}:${historyFens}:${String(nodeBudget)}:${previousLine}`
      );
      return JSON.stringify({
        ok: true,
        sideExplore: {
          ...sideExplore,
          planStatus: "followed",
          planReason: "matched-history-and-gate"
        }
      });
    }
  })
);
expectEqual(
  await sideExploreV2Engine.sideExplore?.(afterE4.state.fen, "white", true, [startState.fen], {
    mode: "fast",
    previousLine: ["e2e4", "b8c6", "g1f3"]
  }),
  {
    ok: true,
    value: {
      ...sideExplore,
      planStatus: "followed",
      planReason: "matched-history-and-gate"
    }
  }
);
expectEqual(sideExploreV2Requests, [
  `side_explore_context_v2_json:${afterE4.state.fen}:white:true:${startState.fen}:100000:e2e4,b8c6,g1f3`
]);
await sideExploreV2Engine.sideExplore?.(afterE4.state.fen, "white", true, [startState.fen], {
  mode: "deep",
  previousLine: ["e2e4", "b8c6", "g1f3"]
});
expectEqual(sideExploreV2Requests.at(-1), [
  `side_explore_context_v2_json:${afterE4.state.fen}:white:true:${startState.fen}:300000:e2e4,b8c6,g1f3`
][0]);
expectEqual(
  validateSideExploreDto({
    ...sideExplore,
    candidates: [{ ...sideExplore.candidates[0], prospectiveBrilliant: "yes" }]
  }),
  null
);
