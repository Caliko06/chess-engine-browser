import type {
  BestMoveDto,
  ColorDto,
  EngineStateDto,
  ForcingMapDto,
  PlayEngineError,
  ReactionMapDto,
  SideExploreDto
} from "./engine-dtos.js";
import type { PlayEngineMode } from "./play-wasm-executor.js";

/**
 * Explicit request/transition bookkeeping and pure state transitions for the play UI.
 *
 * The UI starts asynchronous engine work (moves, Explore, forcing lens, spectator lens) and must
 * drop any answer that arrives after the position, game or view it was asked for has changed.
 * That used to be four loose `let ...Version` counters, each bumped by hand at every call site,
 * plus four analysis slices reset by hand, so a site could (and did: `resign` forgot both the
 * forcing counter and the forcing slice) leave stale forcing state alive.
 *
 * Here every user-visible transition declares once which in-flight work it invalidates
 * (`transitionInvalidations`), `RequestTracker.begin` is the only way the UI applies it, and the
 * pure transition helpers reset all four analysis slices together.
 */

export type PlayMode = "opponent" | "spectator-lens" | "reaction-lens" | "setup";
export type ReactionLensView = "reaction" | "forcing";
export type ReactionLensDepth = "fast" | "deep";
export type PlayErrorCode = PlayEngineError | "operation-failed";

export type PlayLensState = {
  readonly status: "idle" | "pending" | "ready" | "failed";
  readonly fen: string | null;
  readonly legalMoveCount: number;
  readonly bestMove: BestMoveDto | null;
  readonly error: PlayErrorCode | null;
};

export type PlayReactionState = {
  readonly status: "idle" | "pending" | "ready" | "failed";
  readonly fen: string | null;
  readonly legalMoveCount: number;
  readonly map: ReactionMapDto | null;
  readonly error: PlayErrorCode | null;
};

export type PlayForcingState = {
  readonly status: "idle" | "pending" | "ready" | "failed";
  readonly fen: string | null;
  readonly host: ColorDto | null;
  readonly map: ForcingMapDto | null;
  readonly error: PlayErrorCode | null;
};

export type PlaySideExploreState = {
  readonly status: "idle" | "pending" | "ready" | "failed";
  readonly fen: string | null;
  readonly side: ColorDto | null;
  readonly result: SideExploreDto | null;
  readonly source: "provisional" | "rich" | null;
  readonly error: PlayErrorCode | null;
};

export type PlayAnalysisSlices = {
  readonly lens: PlayLensState;
  readonly reaction: PlayReactionState;
  readonly forcing: PlayForcingState;
  readonly sideExplore: PlaySideExploreState;
};

/** A kind of work whose answer can become stale. */
export type RequestKind = "game" | "lens" | "forcing" | "sideExplore";

/** What a transition throws away. `game` implies everything below it. */
export type InvalidationScope =
  | "game" // new game generation + every analysis request
  | "position" // every analysis request (spectator lens, forcing, Explore)
  | "analysis"; // Explore-side analysis only (forcing + Explore), not the spectator lens

export type PlayTransition =
  | "new-game"
  | "load-position"
  | "undo"
  | "resign"
  | "change-mode"
  | "change-side"
  | "change-lens-view"
  | "change-lens-depth"
  | "player-move-in-explore";

/**
 * The single table of what each transition invalidates. `Record<PlayTransition, ...>` makes
 * adding a transition without declaring its effect a compile error. Cancelling the engine
 * workers is a separate, explicit step at each call site: it depends on which engine owns the
 * work, and invalidating the answers is what guarantees correctness.
 */
export const transitionInvalidations: Readonly<Record<PlayTransition, InvalidationScope>> = {
  "new-game": "game",
  "load-position": "game",
  undo: "game",
  resign: "game",
  "change-mode": "position",
  "change-side": "analysis",
  "change-lens-view": "analysis",
  "change-lens-depth": "analysis",
  "player-move-in-explore": "analysis"
};

export type RequestTracker = {
  /** Current game generation; capture it before an `await` and compare after with `isCurrent`. */
  readonly game: () => number;
  /** Starts a new game generation, invalidating every analysis request too. */
  readonly nextGame: () => number;
  /** Starts a spectator-lens request and invalidates the previous one. */
  readonly nextLens: () => number;
  /** Starts a forcing-lens request and invalidates the previous one. */
  readonly nextForcing: () => number;
  /** Starts an Explore request and invalidates the previous one. */
  readonly nextSideExplore: () => number;
  /** Invalidates spectator lens, forcing and Explore requests; the game generation is kept. */
  readonly invalidatePosition: () => void;
  /** Invalidates forcing and Explore requests; the spectator lens and game are kept. */
  readonly invalidateAnalysis: () => void;
  /** Invalidates everything, including the game generation. */
  readonly invalidateAll: () => void;
  readonly isCurrent: (kind: RequestKind, token: number) => boolean;
  /** Applies a declared transition and returns the game generation to capture afterwards. */
  readonly begin: (transition: PlayTransition) => number;
};

export function createRequestTracker(): RequestTracker {
  const counters: Record<RequestKind, number> = { game: 0, lens: 0, forcing: 0, sideExplore: 0 };

  const invalidateAnalysis = (): void => {
    counters.forcing += 1;
    counters.sideExplore += 1;
  };
  const invalidatePosition = (): void => {
    counters.lens += 1;
    invalidateAnalysis();
  };
  const invalidateAll = (): void => {
    counters.game += 1;
    invalidatePosition();
  };
  const next = (kind: Exclude<RequestKind, "game">): number => {
    counters[kind] += 1;
    return counters[kind];
  };

  return {
    game: () => counters.game,
    nextGame: () => {
      invalidateAll();
      return counters.game;
    },
    nextLens: () => next("lens"),
    nextForcing: () => next("forcing"),
    nextSideExplore: () => next("sideExplore"),
    invalidatePosition,
    invalidateAnalysis,
    invalidateAll,
    isCurrent: (kind, token) => counters[kind] === token,
    begin: (transition) => {
      switch (transitionInvalidations[transition]) {
        case "game":
          invalidateAll();
          break;
        case "position":
          invalidatePosition();
          break;
        case "analysis":
          invalidateAnalysis();
          break;
      }
      return counters.game;
    }
  };
}

/** Which asynchronous work follows a position becoming active in a given mode. */
export type ModeFollowUp = "explore-analysis" | "lens-analysis" | "engine-move" | "none";

export function followUpForMode(mode: PlayMode): ModeFollowUp {
  switch (mode) {
    case "reaction-lens":
      return "explore-analysis";
    case "spectator-lens":
      return "lens-analysis";
    case "opponent":
      return "engine-move";
    case "setup":
      return "none";
  }
}

export function isSpectatorMode(mode: PlayMode): boolean {
  return mode === "spectator-lens" || mode === "reaction-lens";
}

export function isSetupMode(mode: PlayMode): boolean {
  return mode === "setup";
}

export function emptyLens(): PlayLensState {
  return {
    status: "idle",
    fen: null,
    legalMoveCount: 0,
    bestMove: null,
    error: null
  };
}

export function lensFromState(
  engineState: EngineStateDto,
  status: PlayLensState["status"]
): PlayLensState {
  return {
    status,
    fen: engineState.fen,
    legalMoveCount: engineState.legalMoves.length,
    bestMove: null,
    error: null
  };
}

export function emptyReaction(): PlayReactionState {
  return {
    status: "idle",
    fen: null,
    legalMoveCount: 0,
    map: null,
    error: null
  };
}

export function reactionFromState(
  engineState: EngineStateDto,
  status: PlayReactionState["status"]
): PlayReactionState {
  return {
    status,
    fen: engineState.fen,
    legalMoveCount: engineState.legalMoves.length,
    map: null,
    error: null
  };
}

export function emptyForcing(): PlayForcingState {
  return {
    status: "idle",
    fen: null,
    host: null,
    map: null,
    error: null
  };
}

export function forcingFromState(
  engineState: EngineStateDto,
  host: ColorDto,
  status: PlayForcingState["status"]
): PlayForcingState {
  return {
    status,
    fen: engineState.fen,
    host,
    map: null,
    error: null
  };
}

export function emptySideExplore(): PlaySideExploreState {
  return {
    status: "idle",
    fen: null,
    side: null,
    result: null,
    source: null,
    error: null
  };
}

export function sideExploreFromState(
  engineState: EngineStateDto,
  side: ColorDto,
  status: PlaySideExploreState["status"]
): PlaySideExploreState {
  return {
    status,
    fen: engineState.fen,
    side,
    result: null,
    source: null,
    error: null
  };
}

/**
 * Resets all four analysis slices together so no transition (like `resign`) can ever clear
 * `lens`, `reaction` and `sideExplore` while forgetting `forcing`.
 */
export function emptyAnalysisSlices(): PlayAnalysisSlices {
  return {
    lens: emptyLens(),
    reaction: emptyReaction(),
    forcing: emptyForcing(),
    sideExplore: emptySideExplore()
  };
}

export function idleAnalysisSlicesForState(
  engineState: EngineStateDto,
  playerSide: ColorDto
): PlayAnalysisSlices {
  return {
    lens: lensFromState(engineState, "idle"),
    reaction: reactionFromState(engineState, "idle"),
    forcing: forcingFromState(engineState, playerSide, "idle"),
    sideExplore: sideExploreFromState(engineState, playerSide, "idle")
  };
}

type InteractiveStateSlice<TCompletedGame, TSetup> = PlayAnalysisSlices & {
  readonly playMode: PlayMode;
  readonly reactionLensView: ReactionLensView;
  readonly selectedSquare: unknown;
  readonly pendingPromotion: unknown;
  readonly activeBoardMotion: unknown;
  readonly status: "loading" | "ready" | "thinking" | "failed";
  readonly error: unknown;
  readonly engineMode: PlayEngineMode;
  readonly completedGame: TCompletedGame;
  readonly setup: TSetup;
};

/**
 * Pure state transition for resignation: clears any active board selection/promotion/motion,
 * resets all four analysis slices (including `forcing`), and records the completed resigned game.
 */
export function transitionToResigned<
  TState extends InteractiveStateSlice<unknown, unknown>
>(
  state: TState,
  completedGame: NonNullable<TState["completedGame"]>,
  engineMode: PlayEngineMode
): TState {
  return {
    ...state,
    ...emptyAnalysisSlices(),
    selectedSquare: null,
    pendingPromotion: null,
    activeBoardMotion: null,
    status: "ready",
    error: null,
    engineMode,
    completedGame
  };
}

/**
 * Pure state transition for switching `playMode`: keeps `state.playMode` as the single source of
 * truth, focuses the reaction view when entering Explore, clears interaction and all four analysis
 * slices, and attaches the setup board state when entering setup mode.
 */
export function transitionPlayMode<
  TState extends InteractiveStateSlice<unknown, unknown>
>(
  state: TState,
  mode: PlayMode,
  setup: TState["setup"],
  engineMode: PlayEngineMode
): TState {
  return {
    ...state,
    ...emptyAnalysisSlices(),
    playMode: mode,
    reactionLensView: mode === "reaction-lens" ? "reaction" : state.reactionLensView,
    status: "ready",
    selectedSquare: null,
    pendingPromotion: null,
    activeBoardMotion: null,
    error: null,
    engineMode,
    setup
  };
}
