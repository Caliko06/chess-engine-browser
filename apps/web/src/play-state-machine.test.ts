import {
  createRequestTracker,
  emptyAnalysisSlices,
  followUpForMode,
  idleAnalysisSlicesForState,
  transitionInvalidations,
  transitionPlayMode,
  transitionToResigned,
  type PlayMode,
  type PlayTransition,
  type RequestKind,
  type RequestTracker
} from "./play-state-machine.js";

function expectEqual<T>(actual: T, expected: T, label: string): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`${label}: expected ${expectedText}, got ${actualText}`);
  }
}

type Tokens = Record<RequestKind, number>;

function capture(tracker: RequestTracker): Tokens {
  return {
    game: tracker.game(),
    lens: tracker.nextLens(),
    forcing: tracker.nextForcing(),
    sideExplore: tracker.nextSideExplore()
  };
}

function currentKinds(tracker: RequestTracker, tokens: Tokens): readonly RequestKind[] {
  const kinds: readonly RequestKind[] = ["game", "lens", "forcing", "sideExplore"];
  return kinds.filter((kind) => tracker.isCurrent(kind, tokens[kind]));
}

// Fresh tokens are current until something invalidates them; a newer request supersedes an older one.
{
  const tracker = createRequestTracker();
  const first = capture(tracker);
  expectEqual(currentKinds(tracker, first), ["game", "lens", "forcing", "sideExplore"], "fresh");
  const secondLens = tracker.nextLens();
  expectEqual(tracker.isCurrent("lens", first.lens), false, "older lens request superseded");
  expectEqual(tracker.isCurrent("lens", secondLens), true, "newest lens request current");
  expectEqual(tracker.isCurrent("forcing", first.forcing), true, "other kinds untouched");
}

// Each invalidation scope drops exactly what it promises.
{
  const tracker = createRequestTracker();
  let tokens = capture(tracker);
  tracker.invalidateAnalysis();
  expectEqual(currentKinds(tracker, tokens), ["game", "lens"], "invalidateAnalysis");

  tokens = capture(tracker);
  tracker.invalidatePosition();
  expectEqual(currentKinds(tracker, tokens), ["game"], "invalidatePosition");

  tokens = capture(tracker);
  tracker.invalidateAll();
  expectEqual(currentKinds(tracker, tokens), [], "invalidateAll");

  tokens = capture(tracker);
  const nextGame = tracker.nextGame();
  expectEqual(nextGame, tracker.game(), "nextGame returns the new generation");
  expectEqual(tracker.isCurrent("game", tokens.game), false, "nextGame drops the old game");
  expectEqual(currentKinds(tracker, tokens), [], "nextGame drops every request");
}

// Regression: `resign` once bumped game, lens and Explore but forgot forcing, so a forcing answer
// requested before resigning could still land on the finished game.
for (const transition of Object.keys(transitionInvalidations) as PlayTransition[]) {
  const tracker = createRequestTracker();
  const before = capture(tracker);
  const returned = tracker.begin(transition);
  expectEqual(returned, tracker.game(), `${transition} returns the game generation`);
  const surviving = currentKinds(tracker, before);
  const scope = transitionInvalidations[transition];
  const expected: Record<typeof scope, readonly RequestKind[]> = {
    game: [],
    position: ["game"],
    analysis: ["game", "lens"]
  };
  expectEqual(surviving, expected[scope], `${transition} (${scope}) survivors`);
}

for (const transition of ["resign", "new-game", "undo", "load-position"] as const) {
  const tracker = createRequestTracker();
  const forcing = tracker.nextForcing();
  tracker.begin(transition);
  expectEqual(tracker.isCurrent("forcing", forcing), false, `${transition} drops forcing`);
}

// Pure transition helpers reset all four analysis slices (including forcing) and keep playMode singular.
{
  const engineState = {
    fen: "startpos",
    status: "ongoing" as const,
    sideToMove: "white" as const,
    legalMoves: ["e2e4"]
  };
  const dirty = {
    ...idleAnalysisSlicesForState(engineState, "white"),
    forcing: {
      status: "pending" as const,
      fen: "startpos",
      host: "white" as const,
      map: null,
      error: null
    },
    playMode: "opponent" as PlayMode,
    reactionLensView: "forcing" as const,
    selectedSquare: "e2",
    pendingPromotion: { from: "e7", to: "e8" },
    activeBoardMotion: { move: "e2e4" },
    status: "thinking" as const,
    error: { source: "engine-search", code: "search-failed" },
    engineMode: "owned-local" as const,
    completedGame: null as { readonly status: "resigned" } | null,
    setup: null as { readonly sideToMove: "white" } | null
  };

  const resigned = transitionToResigned(dirty, { status: "resigned" }, "owned-local");
  expectEqual(resigned.forcing, emptyAnalysisSlices().forcing, "resign clears forcing slice");
  expectEqual(resigned.lens, emptyAnalysisSlices().lens, "resign clears lens slice");
  expectEqual(resigned.sideExplore, emptyAnalysisSlices().sideExplore, "resign clears sideExplore");
  expectEqual(resigned.selectedSquare, null, "resign clears selection");
  expectEqual(resigned.status, "ready", "resign leaves UI ready");
  expectEqual(resigned.completedGame, { status: "resigned" }, "resign records completed game");

  const explored = transitionPlayMode(dirty, "reaction-lens", null, "owned-local");
  expectEqual(explored.playMode, "reaction-lens", "transitionPlayMode updates playMode");
  expectEqual(explored.reactionLensView, "reaction", "entering Explore focuses reaction view");
  expectEqual(explored.forcing, emptyAnalysisSlices().forcing, "mode switch clears forcing");
  expectEqual(explored.error, null, "mode switch clears error");
}

// A mode change keeps the game (the board is the same) but drops all analysis in flight.
{
  const tracker = createRequestTracker();
  const game = tracker.game();
  const sideExplore = tracker.nextSideExplore();
  tracker.begin("change-mode");
  expectEqual(tracker.isCurrent("game", game), true, "change-mode keeps the game");
  expectEqual(tracker.isCurrent("sideExplore", sideExplore), false, "change-mode drops Explore");
}

const followUps: Record<PlayMode, string> = {
  opponent: "engine-move",
  "spectator-lens": "lens-analysis",
  "reaction-lens": "explore-analysis",
  setup: "none"
};
for (const mode of Object.keys(followUps) as PlayMode[]) {
  expectEqual(followUpForMode(mode), followUps[mode] as never, `follow-up for ${mode}`);
}

console.log("play-state-machine tests passed");
