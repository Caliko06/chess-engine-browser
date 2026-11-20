import { explainRecommendation } from "./move-explanation.js";
import {
  createRequestTracker,
  emptyAnalysisSlices,
  emptyForcing,
  emptyReaction,
  emptySideExplore,
  followUpForMode,
  forcingFromState,
  idleAnalysisSlicesForState,
  isSetupMode,
  isSpectatorMode,
  lensFromState,
  reactionFromState,
  sideExploreFromState,
  transitionPlayMode,
  transitionToResigned,
  type PlayErrorCode,
  type PlayForcingState,
  type PlayLensState,
  type PlayMode,
  type PlayReactionState,
  type PlaySideExploreState,
  type ReactionLensDepth,
  type ReactionLensView
} from "./play-state-machine.js";

export type { PlaySideExploreState };
import type {
  BestMoveDto,
  ColorDto,
  DrawReasonDto,
  EngineStateDto,
  ForcingKindDto,
  ForcingCandidateDto,
  MoveResultDto,
  SideExploreDto
} from "./engine-dtos.js";
import {
  hasLegalMoveFrom,
  isBoardSquare,
  legalMovesFromSelection,
  legalTargetsFromSelection,
  renderPlayBoard,
  type BoardSquare,
  type CandidateArrow,
  type PlayBoardLabels,
  type PlayBoardMotion,
  type ReplyArrow
} from "./play-board.js";
import {
  readManualAggressiveEvidenceStore,
  type ManualAggressiveEvidenceSession,
  type ManualAggressiveEvidenceStorageLike,
  type ManualAggressiveEvidenceStoreError
} from "./play-evidence-store.js";
import { copyFor, localizeVisibleMarkup, type UiLocale } from "./ui-localization.js";
import { refutationMemoryHit, type PlayRefutationMemoryCase } from "./play-refutation-memory.js";
import type {
  PlayEngine,
  PlayEngineMode,
  PlayEngineResult
} from "./play-wasm-executor.js";

export type PlayMove = {
  readonly ply: number;
  readonly actor: "player" | "engine";
  readonly side: ColorDto;
  readonly coordinate: string;
  readonly san: string;
  readonly fenBefore: string;
  readonly fenAfter: string;
  readonly attribution: PlayMoveAttribution;
};

type PlayMoveAttribution = {
  readonly buildSha: string;
  readonly evaluatorBackend: PlayEngineMode;
  readonly engineDepth: number;
  readonly aggressive: boolean;
};

export type CompletedPlayGame = {
  readonly status: Exclude<EngineStateDto["status"], "ongoing"> | "resigned";
  readonly result: "1-0" | "0-1" | "1/2-1/2";
  readonly drawReason?: DrawReasonDto | null;
  readonly resignedSide?: ColorDto;
  readonly resignedBy?: "user" | "rival";
  readonly finalFen: string;
  readonly pgn: string;
  readonly moves: readonly PlayMove[];
};

type PlayUiStatus = "loading" | "ready" | "thinking" | "failed";
type PlayStatusOwner = "engine" | "player" | "system" | "terminal";
type SetupPieceKind = "king" | "queen" | "rook" | "bishop" | "knight" | "pawn";
type SetupPieceColor = "white" | "black";
type SetupPiece = { readonly color: SetupPieceColor; readonly kind: SetupPieceKind };
type SetupState = {
  readonly pieces: ReadonlyMap<BoardSquare, SetupPiece>;
  readonly sideToMove: SetupPieceColor;
  readonly cursor: SetupPiece | null;
  readonly cursorSource: BoardSquare | null;
};
type PromotionPiece = "queen" | "rook" | "bishop" | "knight";
type PlayerSide = ColorDto;
type PlayErrorSource = "new-game" | "invalid-input" | "player-move" | "engine-search" | "engine-move";
type ControlledEngineResult<T> = PlayEngineResult<T> | { readonly ok: false; readonly error: "operation-failed" };
type PlayAnalysisEngine = Pick<PlayEngine, "bestMove" | "reactionMap" | "forcingMap" | "sideExplore"> & {
  readonly cancelSearch?: () => void;
};

const reactionArrowLimit = 4;
const playDepthOptions = [1, 2, 3, 4, 5, 6] as const;
const setupStartFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
type PlayDepth = (typeof playDepthOptions)[number];
const selectionTargetPreviewLimit = 8;
const browserEngineReplyMinDelayMs = 0;
const browserEngineMoveAnimationMs = 220;
const sideExploreFallbackDepth = 1;
const sideExploreFastDeadlineMs = 10_000;
const sideExploreDeepDeadlineMs = 15_000;

type PromotionMoveChoice = {
  readonly piece: PromotionPiece;
  readonly move: string;
};

type PendingPromotion = {
  readonly from: BoardSquare;
  readonly to: BoardSquare;
  readonly choices: readonly PromotionMoveChoice[];
};

type PlayErrorState = { readonly source: PlayErrorSource; readonly code: PlayErrorCode };

type PlayEvidenceStatus = "idle" | "saved" | "skipped" | "copied" | "downloaded" | "imported" | "failed";
type PlayGameArchiveStatus =
  | "idle"
  | "saved-local"
  | "saved-disk"
  | "degraded"
  | "skipped"
  | "copied"
  | "downloaded"
  | "failed";
type PlayAutomaticEvidenceStatus = "live" | "degraded";
type PlayEvidenceState = {
  readonly savedCount: number;
  readonly savedSessions: readonly ManualAggressiveEvidenceSession[];
  readonly status: PlayEvidenceStatus;
  readonly automaticStatus: PlayAutomaticEvidenceStatus;
  readonly error:
    | ManualAggressiveEvidenceStoreError
    | "clipboard-unavailable"
    | "download-unavailable"
    | null;
  readonly savedFingerprint: string | null;
};
export type PlayGameArchiveMove = PlayMove & {
  readonly role: "user" | "rival";
  readonly selectedSide: PlayerSide;
  readonly buildSha: string;
  readonly evaluatorBackend: PlayEngineMode;
  readonly engineDepth: number;
  readonly aggressive: boolean;
  readonly recommendationBeforeMove: PlayGameArchiveRecommendationSnapshot | null;
};
type PlayGameArchiveRecommendationCandidate = {
  readonly move: string;
  readonly kind: ForcingKindDto;
  readonly exactScoreCp: number;
  readonly sound: boolean;
  readonly sacrifice: boolean;
  readonly aftermath: "accepted" | "defended" | null;
  readonly mateIn: number | null;
  readonly continuation: string | null;
  readonly rank: number;
};
type PlayGameArchiveRecommendationSnapshot = {
  readonly schema: 1;
  readonly sessionId: string;
  readonly seq: number;
  readonly buildSha: string;
  readonly evaluatorBackend: PlayEngineMode;
  readonly level: number;
  readonly nodeBudget: number;
  readonly exploreMode: PlayRecommendationEvidenceLane;
  readonly aggressive: boolean;
  readonly userSide: PlayerSide;
  readonly ply: number;
  readonly fenBefore: string;
  readonly side: ColorDto;
  readonly onTurn: boolean;
  readonly primaryMove: string | null;
  readonly primaryRenderState: "recommended" | "alt-risk" | "unverified";
  readonly candidates: readonly PlayGameArchiveRecommendationCandidate[];
  readonly replyCandidates: SideExploreDto["replyCandidates"];
  readonly principalLine: readonly string[];
  readonly principalLineFirst: string | null;
  readonly replyCandidateFirst: string | null;
};
export type PlayGameArchiveRecord = {
  readonly schema: 1;
  readonly id: string;
  readonly savedAtIso: string;
  readonly source: "play-game-archive";
  readonly saveReason: "manual-save" | "new-game" | "terminal";
  readonly engineBuildSha: string;
  readonly selectedSide: PlayerSide;
  readonly playMode: PlayMode;
  readonly aggressive: boolean;
  readonly engineDepth: number;
  readonly startFen: string;
  readonly finalFen: string;
  readonly pgn: string;
  readonly result?: CompletedPlayGame["result"];
  readonly termination?: CompletedPlayGame["status"];
  readonly resignedSide?: ColorDto;
  readonly resignedBy?: "user" | "rival";
  readonly moves: readonly PlayGameArchiveMove[];
};
type PlayGameArchiveStore = {
  readonly schemaVersion: 1;
  readonly games: readonly PlayGameArchiveRecord[];
};
type PlayGameArchiveState = {
  readonly savedCount: number;
  readonly status: PlayGameArchiveStatus;
  readonly error:
    | "storage-unavailable"
    | "storage-read-failed"
    | "storage-write-failed"
    | "storage-quota-exceeded"
    | "disk-sink-failed"
    | "clipboard-unavailable"
    | "download-unavailable"
    | null;
  readonly savedFingerprint: string | null;
  readonly savedGameId: string | null;
};

export type PlayUiMotionConfig = {
  readonly engineReplyMinDelayMs?: number;
  readonly engineMoveAnimationMs?: number;
  readonly sideExploreFastDeadlineMs?: number;
  readonly sideExploreDeepDeadlineMs?: number;
  readonly reducedMotion?: boolean;
  readonly delay?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

export type PlayEvidenceCandidateRecord = {
  readonly move: string;
  readonly scoreCp: number;
  readonly sound: boolean;
  readonly sacrifice: boolean;
  readonly rank: number;
};

type PlayRecommendationEvidenceLane = ReactionLensDepth | "fallback";

export type PlayAutomaticEvidenceEvent =
  | {
      readonly schema: 2;
      readonly type: "move";
      readonly sessionId: string;
      readonly seq: number;
      readonly buildSha: string;
      readonly evaluatorBackend: PlayEngineMode;
      readonly level: number;
      readonly nodeBudget: number;
      readonly exploreMode: ReactionLensDepth;
      readonly aggressive: boolean;
      readonly userSide: PlayerSide;
      readonly ply: number;
      readonly fenBefore: string;
      readonly move: string;
      readonly actor: "user" | "rival";
    }
  | {
      readonly schema: 2;
      readonly type: "recommendation";
      readonly sessionId: string;
      readonly seq: number;
      readonly buildSha: string;
      readonly evaluatorBackend: PlayEngineMode;
      readonly level: number;
      readonly nodeBudget: number;
      readonly exploreMode: PlayRecommendationEvidenceLane;
      readonly aggressive: boolean;
      readonly userSide: PlayerSide;
      readonly ply: number;
      readonly fenBefore: string;
      readonly primaryMove: string | null;
      readonly primaryRenderState: "recommended" | "alt-risk" | "unverified";
      readonly candidates: readonly PlayEvidenceCandidateRecord[];
    }
  | {
      readonly schema: 2;
      readonly type: "discrepancy";
      readonly sessionId: string;
      readonly seq: number;
      readonly buildSha: string;
      readonly evaluatorBackend: PlayEngineMode;
      readonly level: number;
      readonly nodeBudget: number;
      readonly exploreMode: PlayRecommendationEvidenceLane;
      readonly aggressive: boolean;
      readonly userSide: PlayerSide;
      readonly ply: number;
      readonly fenBefore: string;
      readonly previousCandidates: readonly PlayEvidenceCandidateRecord[];
      readonly currentCandidates: readonly PlayEvidenceCandidateRecord[];
    };

export type PlayAutomaticEvidenceSink = (
  event: PlayAutomaticEvidenceEvent
) => Promise<boolean>;

export type PlayAutomaticEvidenceConfig = {
  readonly buildSha: string;
  readonly sessionId?: string | undefined;
  readonly sink: PlayAutomaticEvidenceSink;
};

/// ADR-0241: localStorage remains the recoverable source of truth while the optional
/// preview-server sink reports disk persistence separately.
export type PlayGameArchiveSink = (record: PlayGameArchiveRecord) => Promise<boolean>;

type PlayUiState = {
  readonly engineState: EngineStateDto | null;
  readonly moves: readonly PlayMove[];
  readonly selectedSquare: BoardSquare | null;
  readonly pendingPromotion: PendingPromotion | null;
  readonly lastMove: string | null;
  readonly status: PlayUiStatus;
  readonly error: PlayErrorState | null;
  readonly playerSide: PlayerSide;
  readonly engineDepth: number;
  readonly aggressive: boolean;
  readonly engineMode: PlayEngineMode;
  readonly playMode: PlayMode;
  readonly reactionLensView: ReactionLensView;
  readonly reactionLensDepth: ReactionLensDepth;
  readonly lastBestMove: BestMoveDto | null;
  readonly sideExplorePreviousLine: readonly string[];
  readonly lens: PlayLensState;
  readonly reaction: PlayReactionState;
  readonly forcing: PlayForcingState;
  readonly sideExplore: PlaySideExploreState;
  readonly completedGame: CompletedPlayGame | null;
  readonly activeBoardMotion: PlayBoardMotion | null;
  readonly fenInputValue: string;
  readonly setup: SetupState | null;
  readonly evidence: PlayEvidenceState;
  readonly gameArchive: PlayGameArchiveState;
};

export type PlayUiDependencies = {
  readonly engine: PlayEngine;
  readonly analysisEngine?: PlayAnalysisEngine | undefined;
  readonly spectatorLens?: boolean | undefined;
  readonly reactionLens?: boolean | undefined;
  readonly initialAggressive?: boolean | undefined;
  readonly locale?: UiLocale | undefined;
  readonly onReviewGame?: (game: CompletedPlayGame) => void;
  readonly onPlayReset?: () => void;
  readonly motion?: PlayUiMotionConfig;
  readonly gameArchiveSink?: PlayGameArchiveSink | undefined;
  readonly evidenceStorage?: ManualAggressiveEvidenceStorageLike | undefined;
  readonly automaticEvidence?: PlayAutomaticEvidenceConfig | undefined;
};

export type PlayUiHandle = {
  readonly ready: Promise<void>;
  readonly loadPosition: (fen: string) => Promise<void>;
};

export function mountPlayUi(root: HTMLElement, dependencies: PlayUiDependencies): PlayUiHandle {
  const tracker = createRequestTracker();
  const motion = resolvePlayMotion(dependencies.motion);
  let locale = dependencies.locale ?? "en";
  const gameArchiveStorage = dependencies.evidenceStorage ?? browserManualAggressiveEvidenceStorage();
  const evidenceStorage = dependencies.evidenceStorage ?? browserManualAggressiveEvidenceStorage();
  const automaticEvidenceSessionId =
    dependencies.automaticEvidence?.sessionId ?? createAutomaticEvidenceSessionId();
  let automaticEvidenceSeq = 0;
  const gameArchiveRecommendations = new Map<string, PlayGameArchiveRecommendationSnapshot>();
  const initialPlayMode: PlayMode =
    dependencies.reactionLens === true
      ? "reaction-lens"
      : dependencies.spectatorLens === true
        ? "spectator-lens"
        : "opponent";
  let state: PlayUiState = {
    engineState: null,
    moves: [],
    selectedSquare: null,
    pendingPromotion: null,
    lastMove: null,
    status: "loading",
    error: null,
    playerSide: "white",
    engineDepth: 1,
    aggressive: dependencies.initialAggressive === true,
    engineMode: currentEngineMode(dependencies.engine),
    playMode: initialPlayMode,
    reactionLensView: "reaction",
    // Explore opens in the responsive lane. Deep remains an explicit user choice when the
    // position warrants more analysis, but it must not be the first-contact latency cost.
    reactionLensDepth: "fast",
    lastBestMove: null,
    sideExplorePreviousLine: [],
    ...emptyAnalysisSlices(),
    completedGame: null,
    activeBoardMotion: null,
    fenInputValue: "",
    setup: null,
    evidence: initialEvidenceState(evidenceStorage),
    gameArchive: initialGameArchiveState(gameArchiveStorage)
  };
  let completedGameWasNull = true;
  // The bar keeps the last finished evaluation while the next search runs, so it does not jump to
  // the middle on every move. CSP forbids inline style attributes, so the share is set through CSSOM.
  let lastEval: { readonly share: string; readonly label: string } | null = null;

  const applyEvalBar = (): void => {
    const bar = root.querySelector<HTMLElement>('[data-play-ui="eval-bar"]');
    // Test doubles of the DOM have no CSSOM.
    if (bar === null || !("style" in bar)) {
      return;
    }
    const share = bar.getAttribute("data-eval-white");
    const label = bar.querySelector('[data-play-ui="eval-bar-label"]');
    if (share !== null) {
      lastEval = { share, label: label?.textContent ?? "" };
    } else if (lastEval !== null && label !== null) {
      label.textContent = lastEval.label;
    }
    bar.style.setProperty("--eval-white", lastEval?.share ?? "0.5");
  };

  const render = (): void => {
    const copy = copyFor(locale);
    const autoOpenSecondaryDrawer = state.completedGame !== null && completedGameWasNull;
    const ownerDocument = (root as unknown as { readonly ownerDocument?: Document }).ownerDocument;
    const activeElement = ownerDocument === undefined ? null : ownerDocument.activeElement;
    const rootContainsActive =
      activeElement !== null &&
      typeof (root as unknown as { readonly contains?: unknown }).contains === "function" &&
      root.contains(activeElement);
    const focusedUi =
      rootContainsActive && isElementWithListeners(activeElement)
        ? activeElement.getAttribute("data-play-ui")
        : null;
    const focusedSquare =
      focusedUi === "board-square" && rootContainsActive && isElementWithListeners(activeElement)
        ? activeElement.getAttribute("data-square")
        : null;
    const openDisclosureKeys = new Set(
      Array.from(root.querySelectorAll("details[data-play-ui]"))
        .filter((element) => (element as HTMLDetailsElement).open)
        .map((element) => element.getAttribute("data-play-ui"))
        .filter((key): key is string => key !== null)
    );
    root.innerHTML = renderPlayUi(state, copy, autoOpenSecondaryDrawer);
    completedGameWasNull = state.completedGame === null;
    applyEvalBar();
    for (const details of Array.from(root.querySelectorAll("details[data-play-ui]"))) {
      const key = details.getAttribute("data-play-ui");
      if (key !== null && openDisclosureKeys.has(key)) {
        (details as HTMLDetailsElement).open = true;
      }
    }
    if (focusedUi !== null) {
      const focusTarget =
        focusedUi === "board-square" && focusedSquare !== null && isBoardSquare(focusedSquare)
          ? root.querySelector(
              `[data-play-ui="board-square"][data-square="${focusedSquare}"]`
            )
          : root.querySelector(`[data-play-ui="${focusedUi}"]`);
      const focus = focusTarget as unknown as { readonly focus?: unknown } | null;
      if (typeof focus?.focus === "function") {
        (focus.focus as () => void)();
      }
    }
    bindPlayEvents(root, state, {
      newGame: () => {
        void startNewGame({ notifyReset: true });
      },
      resignGame: (actor) => {
        resignGame(actor);
      },
      saveGameArchive: () => {
        saveGameArchive("manual-save");
      },
      copyGameArchiveJson: () => {
        void copyGameArchiveJson();
      },
      downloadGameArchivePgn: () => {
        downloadGameArchivePgn();
      },
      copyAnalyzeCommand: () => {
        void copyAnalyzeCommand(root);
      },
      rematchGame: () => {
        void startNewGame({ notifyReset: true });
      },
      selectSquare: (square) => {
        void selectSquare(square);
      },
      dragMove: (from, to) => {
        void moveDraggedPiece(from, to);
      },
      reviewGame: () => {
        if (state.completedGame !== null) {
          dependencies.onReviewGame?.(state.completedGame);
        }
      },
      copyTerminalPgn: () => {
        if (state.completedGame !== null) {
          void copyTerminalPgn(root, state.completedGame.pgn);
        }
      },
      copyCurrentFen: () => {
        if (state.engineState !== null) {
          void copyCurrentFen(root, state.engineState.fen);
        }
      },
      choosePromotion: (move) => {
        void applyPromotionMove(move);
      },
      choosePlayerSide: (side) => {
        choosePlayerSide(side);
      },
      chooseEngineDepth: (depth) => {
        chooseEngineDepth(depth);
      },
      toggleAggressive: () => {
        toggleAggressive();
      },
      undoMove: () => {
        void undoMove();
      },
      choosePlayMode: (mode) => {
        choosePlayMode(mode);
      },
      chooseReactionView: (view) => {
        chooseReactionView(view);
      },
      chooseReactionDepth: (depth) => {
        chooseReactionDepth(depth);
      },
      loadPosition: (fen) => {
        void applyLoadPosition(fen);
      },
      onFenInput: (value) => {
        state = { ...state, fenInputValue: value };
      },
      setupClickSquare: (square) => {
        applySetupClick(square);
      },
      setupMovePiece: (from, to) => {
        applySetupMove(from, to);
      },
      setupPlacePiece: (piece, to) => {
        applySetupPlace(piece, to);
      },
      setupSelectCursor: (piece) => {
        if (state.setup !== null) {
          state = { ...state, setup: { ...state.setup, cursor: piece, cursorSource: null } };
          render();
        }
      },
      setupToggleSide: () => {
        if (state.setup !== null) {
          state = {
            ...state,
            setup: {
              ...state.setup,
              sideToMove: state.setup.sideToMove === "white" ? "black" : "white"
            }
          };
          render();
        }
      },
      setupClear: () => {
        if (state.setup !== null) {
          state = { ...state, setup: { ...state.setup, pieces: new Map(), cursor: null, cursorSource: null } };
          render();
        }
      },
      setupAnalyze: () => {
        void applySetupAnalyze();
      },
      toggleLocale: () => {
        locale = locale === "es" ? "en" : "es";
        render();
      }
    });
  };

  const cancelActiveSearches = (): void => {
    dependencies.engine.cancelSearch?.();
    // Explore shares the owned Classic engine for move execution and analysis. Cancelling the
    // same worker twice can recreate it twice and race its fresh configuration with Undo's
    // recomputation.
    if (dependencies.analysisEngine !== dependencies.engine) {
      dependencies.analysisEngine?.cancelSearch?.();
    }
  };

  const resignGame = (actor: "user" | "rival"): void => {
    const currentState = state.engineState;
    if (!canResign(state) || currentState === null) {
      return;
    }
    tracker.begin("resign");
    cancelActiveSearches();
    state = transitionToResigned(
      state,
      buildResignedPlayGame(state.moves, currentState, resignationSide(state, actor), actor),
      currentEngineMode(dependencies.engine)
    );
    state = { ...state, gameArchive: captureGameArchive("terminal") };
    render();
  };

  const markAutomaticEvidenceDegraded = (): void => {
    if (state.evidence.automaticStatus === "degraded") {
      return;
    }
    state = {
      ...state,
      evidence: { ...state.evidence, automaticStatus: "degraded" }
    };
    render();
  };

  const emitAutomaticEvidence = (
    event:
      | Omit<Extract<PlayAutomaticEvidenceEvent, { readonly type: "move" }>, "schema" | "sessionId" | "seq" | "buildSha" | "evaluatorBackend" | "level" | "aggressive" | "userSide">
      | Omit<Extract<PlayAutomaticEvidenceEvent, { readonly type: "recommendation" }>, "schema" | "sessionId" | "seq" | "buildSha" | "evaluatorBackend" | "level" | "aggressive" | "userSide">
      | Omit<Extract<PlayAutomaticEvidenceEvent, { readonly type: "discrepancy" }>, "schema" | "sessionId" | "seq" | "buildSha" | "evaluatorBackend" | "level" | "aggressive" | "userSide">
  ): PlayAutomaticEvidenceEvent | null => {
    const automaticEvidence = dependencies.automaticEvidence;
    if (automaticEvidence === undefined) {
      return null;
    }
    automaticEvidenceSeq += 1;
    const fullEvent = {
      ...event,
      schema: 2,
      sessionId: automaticEvidenceSessionId,
      seq: automaticEvidenceSeq,
      buildSha: automaticEvidence.buildSha,
      evaluatorBackend: currentEngineMode(dependencies.engine),
      level: state.engineDepth,
      aggressive: state.aggressive,
      userSide: state.playerSide
    } as PlayAutomaticEvidenceEvent;
    void automaticEvidence.sink(fullEvent).then((ok) => {
      if (!ok) {
        markAutomaticEvidenceDegraded();
      }
    }, markAutomaticEvidenceDegraded);
    return fullEvent;
  };

  const emitMoveEvidence = (move: PlayMove): void => {
    emitAutomaticEvidence({
      type: "move",
      nodeBudget: playEvidenceMoveNodeBudget(state.engineDepth),
      exploreMode: state.reactionLensDepth,
      ply: move.ply,
      fenBefore: move.fenBefore,
      move: move.coordinate,
      actor: move.actor === "player" ? "user" : "rival"
    });
  };

  const candidateEvidenceRecords = (
    result: SideExploreDto
  ): readonly PlayEvidenceCandidateRecord[] =>
    result.candidates.map((candidate, index) => ({
      move: candidate.move,
      scoreCp: candidate.exactScoreCp,
      sound: candidate.sound,
      sacrifice: candidate.sacrifice,
      rank: index + 1
    }));

  const emitSideExploreEvidence = (
    fenBefore: string,
    result: SideExploreDto,
    lane: PlayRecommendationEvidenceLane,
    nodeBudget: number
  ): void => {
    const event = emitAutomaticEvidence({
      type: "recommendation",
      nodeBudget,
      exploreMode: lane,
      ply: state.moves.length + 1,
      fenBefore,
      primaryMove: result.candidates[0]?.move ?? null,
      primaryRenderState: sideExplorePrimaryRenderState(result),
      candidates: candidateEvidenceRecords(result)
    });
    if (event?.type === "recommendation") {
      gameArchiveRecommendations.set(
        playGameArchiveRecommendationKey(event.ply, event.fenBefore),
        buildPlayGameArchiveRecommendationSnapshot(event, result)
      );
    }
  };

  const emitSideExploreDiscrepancyEvidence = (
    fenBefore: string,
    previous: SideExploreDto,
    current: SideExploreDto,
    lane: PlayRecommendationEvidenceLane,
    nodeBudget: number
  ): void => {
    emitAutomaticEvidence({
      type: "discrepancy",
      nodeBudget,
      exploreMode: lane,
      ply: state.moves.length + 1,
      fenBefore,
      previousCandidates: candidateEvidenceRecords(previous),
      currentCandidates: candidateEvidenceRecords(current)
    });
  };

  const saveGameArchive = (reason: PlayGameArchiveRecord["saveReason"]): void => {
    const nextArchive = captureGameArchive(reason);
    state = { ...state, gameArchive: nextArchive };
    render();
  };

  const captureGameArchive = (
    reason: PlayGameArchiveRecord["saveReason"]
  ): PlayGameArchiveState => {
    if (gameArchiveStorage === null) {
      return { ...state.gameArchive, status: "failed", error: "storage-unavailable" };
    }
    const record = buildPlayGameArchiveRecord(state, reason, {
      recommendations: gameArchiveRecommendations
    });
    if (record === null) {
      return { ...state.gameArchive, status: "skipped", error: null };
    }
    const fingerprint = playGameArchiveFingerprint(state);
    if (state.gameArchive.savedFingerprint === fingerprint) {
      return {
        ...state.gameArchive,
        status: state.gameArchive.status === "saved-disk" ? "saved-disk" : "saved-local",
        error: null
      };
    }
    const store = appendPlayGameArchiveRecord(gameArchiveStorage, record);
    if (typeof store === "string") {
      return { ...state.gameArchive, status: "failed", error: store };
    }
    const savedState: PlayGameArchiveState = {
      savedCount: store.games.length,
      status: "saved-local",
      error: null,
      savedFingerprint: fingerprint,
      savedGameId: record.id
    };
    const sink = dependencies.gameArchiveSink;
    if (sink !== undefined) {
      void Promise.resolve()
        .then(() => sink(record))
        .then(
          (ok) => {
            if (state.gameArchive.savedFingerprint !== fingerprint) {
              return;
            }
            state = {
              ...state,
              gameArchive: {
                ...state.gameArchive,
                status: ok ? "saved-disk" : "degraded",
                error: ok ? null : "disk-sink-failed"
              }
            };
            render();
          },
          () => {
            if (state.gameArchive.savedFingerprint !== fingerprint) {
              return;
            }
            state = {
              ...state,
              gameArchive: {
                ...state.gameArchive,
                status: "degraded",
                error: "disk-sink-failed"
              }
            };
            render();
          }
        );
    }
    if (reason === "new-game") {
      gameArchiveRecommendations.clear();
    }
    return savedState;
  };

  const completeAndCaptureTerminal = (nextState: PlayUiState): PlayUiState => {
    const completedState = completeIfTerminal(nextState);
    if (completedState.completedGame === null || nextState.completedGame !== null) {
      return completedState;
    }
    state = completedState;
    return { ...completedState, gameArchive: captureGameArchive("terminal") };
  };

  const copyGameArchiveJson = async (): Promise<void> => {
    if (gameArchiveStorage === null) {
      state = {
        ...state,
        gameArchive: { ...state.gameArchive, status: "failed", error: "storage-unavailable" }
      };
      render();
      return;
    }
    const store = readPlayGameArchiveStore(gameArchiveStorage);
    if (typeof store === "string") {
      state = { ...state, gameArchive: { ...state.gameArchive, status: "failed", error: store } };
      render();
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(store, null, 2));
      state = {
        ...state,
        gameArchive: { ...state.gameArchive, savedCount: store.games.length, status: "copied", error: null }
      };
    } catch {
      state = {
        ...state,
        gameArchive: { ...state.gameArchive, savedCount: store.games.length, status: "failed", error: "clipboard-unavailable" }
      };
    }
    render();
  };

  const downloadGameArchivePgn = (): void => {
    if (gameArchiveStorage === null) {
      state = {
        ...state,
        gameArchive: { ...state.gameArchive, status: "failed", error: "storage-unavailable" }
      };
      render();
      return;
    }
    const store = readPlayGameArchiveStore(gameArchiveStorage);
    if (typeof store === "string") {
      state = { ...state, gameArchive: { ...state.gameArchive, status: "failed", error: store } };
      render();
      return;
    }
    const lastGame = store.games[store.games.length - 1] ?? null;
    if (lastGame === null) {
      state = { ...state, gameArchive: { ...state.gameArchive, status: "skipped", error: null } };
      render();
      return;
    }
    const pgn = lastGame.pgn;
    const downloaded = downloadJson(pgn, `${safeFileName(lastGame.id)}.pgn`);
    state = {
      ...state,
      gameArchive: {
        ...state.gameArchive,
        savedCount: store.games.length,
        status: downloaded ? "downloaded" : "failed",
        error: downloaded ? null : "download-unavailable"
      }
    };
    render();
  };

  const startNewGame = async (options: { readonly notifyReset: boolean }): Promise<void> => {
    const evidence = state.evidence;
    const gameArchive = options.notifyReset ? captureGameArchive("new-game") : state.gameArchive;
    if (options.notifyReset) {
      gameArchiveRecommendations.clear();
    }
    const version = tracker.begin("new-game");
    const playerSide = state.playerSide;
    const engineDepth = state.engineDepth;
    if (options.notifyReset) {
      cancelActiveSearches();
      dependencies.onPlayReset?.();
    }
    state = {
      engineState: null,
      moves: [],
      selectedSquare: null,
      pendingPromotion: null,
      lastMove: null,
      status: "loading",
      error: null,
      playerSide,
      engineDepth,
      aggressive: state.aggressive,
      engineMode: currentEngineMode(dependencies.engine),
      playMode: state.playMode,
      reactionLensView: state.reactionLensView,
      reactionLensDepth: state.reactionLensDepth,
      lastBestMove: null,
      sideExplorePreviousLine: [],
      ...emptyAnalysisSlices(),
      completedGame: null,
      activeBoardMotion: null,
      fenInputValue: state.fenInputValue,
      setup: null,
      evidence,
      gameArchive
    };
    render();
    const result = await runEngineOperation(() => dependencies.engine.newGame());
    if (!tracker.isCurrent("game", version)) {
      return;
    }
    state = result.ok
      ? {
          ...state,
          engineState: result.value,
          status: "ready",
          error: null,
          activeBoardMotion: null,
          ...idleAnalysisSlicesForState(result.value, state.playerSide),
          reactionLensView:
            state.playMode === "reaction-lens"
              ? focusedReactionLensView()
              : state.reactionLensView,
          engineMode: currentEngineMode(dependencies.engine)
        }
      : {
          ...state,
          status: "failed",
          error: playError("new-game", result.error),
          activeBoardMotion: null,
          ...emptyAnalysisSlices(),
          engineMode: currentEngineMode(dependencies.engine)
        };
    render();
    if (result.ok) {
      switch (followUpForMode(state.playMode)) {
        case "explore-analysis":
          void requestActiveLensAnalysis(version, result.value);
          break;
        case "lens-analysis":
          void requestLensAnalysis(version, result.value);
          break;
        case "engine-move":
          await requestEngineMove(version, result.value);
          break;
        case "none":
          break;
      }
    }
  };

  const choosePlayerSide = (side: PlayerSide): void => {
    if (!canChangePlayerSide(state)) {
      return;
    }
    const currentState = state.engineState;
    tracker.begin("change-side");
    state = {
      ...state,
      playerSide: side,
      reactionLensView:
        state.playMode === "reaction-lens"
          ? focusedReactionLensView()
          : state.reactionLensView,
      reaction: emptyReaction(),
      selectedSquare: null,
      pendingPromotion: null,
      activeBoardMotion: null,
      error: state.status === "failed" ? state.error : null,
      forcing:
        currentState !== null ? forcingFromState(currentState, side, "idle") : emptyForcing(),
      sideExplore:
        currentState !== null ? sideExploreFromState(currentState, side, "idle") : emptySideExplore(),
      sideExplorePreviousLine: [],
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();
    if (currentState !== null && state.status === "ready" && state.playMode === "reaction-lens") {
      void requestActiveLensAnalysis(tracker.game(), currentState);
    }
  };

  const chooseReactionView = (view: ReactionLensView): void => {
    if (state.playMode !== "reaction-lens" || state.reactionLensView === view) {
      return;
    }
    dependencies.analysisEngine?.cancelSearch?.();
    tracker.begin("change-lens-view");
    const currentState = state.engineState;
    state = {
      ...state,
      reactionLensView: view,
      reaction: emptyReaction(),
      forcing: emptyForcing(),
      sideExplore: currentState !== null
        ? sideExploreFromState(currentState, state.playerSide, "idle")
        : emptySideExplore(),
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();
    if (currentState !== null && state.status === "ready") {
      void requestActiveLensAnalysis(tracker.game(), currentState);
    }
  };

  const chooseReactionDepth = (depth: ReactionLensDepth): void => {
    if (state.playMode !== "reaction-lens" || state.reactionLensDepth === depth) {
      return;
    }
    dependencies.analysisEngine?.cancelSearch?.();
    tracker.begin("change-lens-depth");
    const currentState = state.engineState;
    state = {
      ...state,
      reactionLensDepth: depth,
      reaction: emptyReaction(),
      forcing: emptyForcing(),
      sideExplore: currentState !== null
        ? sideExploreFromState(currentState, state.playerSide, "idle")
        : emptySideExplore(),
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();
    if (currentState !== null && state.status === "ready") {
      void requestActiveLensAnalysis(tracker.game(), currentState);
    }
  };

  const chooseEngineDepth = (depth: PlayDepth): void => {
    if (!canChangeEngineDepth(state)) {
      return;
    }
    const currentState = state.engineState;
    state = {
      ...state,
      engineDepth: depth,
      activeBoardMotion: null,
      error: state.status === "failed" ? state.error : null,
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();
    if (currentState !== null && state.status === "ready") {
      if (state.playMode === "reaction-lens") {
        void requestActiveLensAnalysis(tracker.game(), currentState);
      } else if (state.playMode === "spectator-lens") {
        void requestLensAnalysis(tracker.game(), currentState);
      }
    }
  };

  const toggleAggressive = (): void => {
    if (!canChangeEngineDepth(state)) {
      return;
    }
    const currentState = state.engineState;
    state = {
      ...state,
      aggressive: !state.aggressive,
      activeBoardMotion: null,
      error: state.status === "failed" ? state.error : null,
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();
    // The Explore (reaction-lens) surface is the only lens coloured by the aggressive toggle, so
    // recompute it in place when the toggle flips; the spectator lens stays neutral.
    if (
      currentState !== null &&
      state.status === "ready" &&
      state.playMode === "reaction-lens"
    ) {
      void requestActiveLensAnalysis(tracker.game(), currentState);
    }
  };

  const undoMove = async (): Promise<void> => {
    const loadPosition = dependencies.engine.loadPosition;
    if (!canUndoMove(state) || loadPosition === undefined) {
      return;
    }
    const moves = state.moves;
    if (moves.length === 0) {
      return;
    }
    // How many trailing plies to take back so the turn returns to the side the user inputs for. In
    // Explore/Analyze the user moves both sides, so a single ply is undone; against the engine the
    // engine's reply is taken back together with the player's move so it stays the player's turn.
    let popCount = 1;
    if (!isSpectatorMode(state.playMode)) {
      while (popCount < moves.length) {
        const ply = moves[moves.length - popCount];
        if (ply === undefined || ply.side === state.playerSide) {
          break;
        }
        popCount += 1;
      }
    }
    const restored = moves[moves.length - popCount];
    if (restored === undefined) {
      return;
    }
    const remaining = moves.slice(0, moves.length - popCount);

    const version = tracker.begin("undo");
    cancelActiveSearches();

    state = {
      ...state,
      selectedSquare: null,
      pendingPromotion: null,
      activeBoardMotion: null,
      status: "loading",
      error: null,
      completedGame: null,
      lastBestMove: null,
      sideExplorePreviousLine: [],
      ...emptyAnalysisSlices(),
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();

    const loaded = await runEngineOperation(() => loadPosition(restored.fenBefore));
    if (!tracker.isCurrent("game", version)) {
      return;
    }
    if (!loaded.ok) {
      state = {
        ...state,
        status: "failed",
        error: playError("player-move", loaded.error),
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }

    const lastRemaining = remaining[remaining.length - 1];
    state = {
      ...state,
      engineState: loaded.value,
      moves: remaining,
      lastMove: lastRemaining?.coordinate ?? null,
      status: "ready",
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();

    if (loaded.value.status === "ongoing") {
      switch (followUpForMode(state.playMode)) {
        case "explore-analysis":
          void requestActiveLensAnalysis(version, loaded.value);
          break;
        case "lens-analysis":
          void requestLensAnalysis(version, loaded.value);
          break;
        case "engine-move":
        case "none":
          break;
      }
    }
  };

  const choosePlayMode = (mode: PlayMode): void => {
    if (!canChangePlayMode(state) || state.playMode === mode) {
      return;
    }
    const currentState = state.engineState;
    cancelActiveSearches();
    tracker.begin("change-mode");
    const isSetup = mode === "setup";
    const setupState: SetupState | null = isSetup
      ? {
          pieces: parsePiecesFromFen(currentState?.fen ?? setupStartFen),
          sideToMove: currentState?.sideToMove ?? "white",
          cursor: null,
          cursorSource: null
        }
      : null;
    state = transitionPlayMode(state, mode, setupState, currentEngineMode(dependencies.engine));
    render();
    if (!isSetup && currentState !== null && currentState.status === "ongoing") {
      switch (followUpForMode(mode)) {
        case "explore-analysis":
          void requestActiveLensAnalysis(tracker.game(), currentState);
          break;
        case "lens-analysis":
          void requestLensAnalysis(tracker.game(), currentState);
          break;
        case "engine-move":
          void requestEngineMove(tracker.game(), currentState);
          break;
        case "none":
          break;
      }
    }
  };

  const applySetupClick = (square: BoardSquare): void => {
    const setup = state.setup;
    if (setup === null) return;
    const existing = setup.pieces.get(square);

    if (setup.cursor !== null) {
      const newPieces = new Map(setup.pieces);
      newPieces.set(square, setup.cursor);
      let newCursorSource: BoardSquare | null = null;
      let newCursor: SetupPiece | null = setup.cursor;
      if (setup.cursorSource !== null) {
        newPieces.delete(setup.cursorSource);
        newCursor = null;
        newCursorSource = null;
      }
      state = { ...state, setup: { ...setup, pieces: newPieces, cursor: newCursor, cursorSource: newCursorSource } };
    } else if (existing !== undefined) {
      const newPieces = new Map(setup.pieces);
      newPieces.delete(square);
      state = { ...state, setup: { ...setup, pieces: newPieces, cursor: existing, cursorSource: square } };
    }
    render();
  };

  const applySetupMove = (from: BoardSquare, to: BoardSquare): void => {
    const setup = state.setup;
    if (setup === null || from === to) return;
    const piece = setup.pieces.get(from);
    if (piece === undefined) return;
    const newPieces = new Map(setup.pieces);
    newPieces.delete(from);
    newPieces.set(to, piece);
    state = { ...state, setup: { ...setup, pieces: newPieces, cursor: null, cursorSource: null } };
    render();
  };

  const applySetupPlace = (piece: SetupPiece, to: BoardSquare): void => {
    const setup = state.setup;
    if (setup === null) return;
    const newPieces = new Map(setup.pieces);
    newPieces.set(to, piece);
    state = { ...state, setup: { ...setup, pieces: newPieces, cursor: null, cursorSource: null } };
    render();
  };

  const applySetupAnalyze = async (): Promise<void> => {
    const setup = state.setup;
    if (setup === null || state.status === "loading" || dependencies.engine.loadPosition === undefined) {
      return;
    }
    const fen = buildSetupFen(setup.pieces, setup.sideToMove);
    // Enter Explore (reaction-lens) before loading so applyLoadPosition's
    // post-load path runs the reaction analysis on the composed position
    // instead of treating it as an opponent game (which would request an
    // engine move and leave the lens idle).
    state = { ...state, playMode: "reaction-lens", setup: null };
    await applyLoadPosition(fen);
  };

  const applyLoadPosition = async (fen: string): Promise<void> => {
    const loadPos = dependencies.engine.loadPosition;
    if (state.status === "loading" || loadPos === undefined) {
      return;
    }
    cancelActiveSearches();
    const version = tracker.begin("load-position");
    state = {
      ...state,
      engineState: null,
      moves: [],
      selectedSquare: null,
      pendingPromotion: null,
      lastMove: null,
      status: "loading",
      error: null,
      lastBestMove: null,
      sideExplorePreviousLine: [],
      ...emptyAnalysisSlices(),
      completedGame: null,
      activeBoardMotion: null
    };
    render();
    const result = await runEngineOperation(() => loadPos(fen));
    if (!tracker.isCurrent("game", version)) {
      return;
    }
    state = result.ok
      ? {
          ...state,
          engineState: result.value,
          status: "ready",
          error: null,
          ...idleAnalysisSlicesForState(result.value, state.playerSide),
          reactionLensView:
            state.playMode === "reaction-lens"
              ? focusedReactionLensView()
              : state.reactionLensView,
          engineMode: currentEngineMode(dependencies.engine)
        }
      : {
          ...state,
          status: "failed",
          error: playError("new-game", result.error),
          engineMode: currentEngineMode(dependencies.engine)
        };
    render();
    if (result.ok) {
      switch (followUpForMode(state.playMode)) {
        case "explore-analysis":
          void requestActiveLensAnalysis(version, result.value);
          break;
        case "lens-analysis":
          void requestLensAnalysis(version, result.value);
          break;
        case "engine-move":
          await requestEngineMove(version, result.value);
          break;
        case "none":
          break;
      }
    }
  };

  const moveDraggedPiece = async (from: BoardSquare, to: BoardSquare): Promise<void> => {
    const currentState = state.engineState;
    if (!canAcceptBoardInput(state) || currentState === null || from === to) {
      return;
    }
    if (!hasLegalMoveFrom(currentState, from)) {
      return;
    }

    const legalMoves = legalMovesFromSelection(currentState, from, to);
    if (legalMoves.length === 0) {
      state = {
        ...state,
        selectedSquare: from,
        pendingPromotion: null,
        activeBoardMotion: null,
        error: playError("invalid-input", "invalid-move"),
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }

    if (legalMoves.length === 1) {
      const [legalMove] = legalMoves;
      if (legalMove !== undefined) {
        await applyPlayerMove(legalMove);
      }
      return;
    }

    const choices = promotionChoicesFromMoves(legalMoves);
    if (choices.length !== legalMoves.length) {
      state = {
        ...state,
        selectedSquare: from,
        pendingPromotion: null,
        error: playError("invalid-input", "invalid-move"),
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }

    state = {
      ...state,
      selectedSquare: from,
      pendingPromotion: { from, to, choices },
      activeBoardMotion: null,
      error: null,
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();
  };

  const selectSquare = async (square: BoardSquare): Promise<void> => {
    const currentState = state.engineState;
    if (!canAcceptBoardInput(state) || currentState === null) {
      return;
    }

    if (state.selectedSquare === null) {
      state = {
        ...state,
        selectedSquare: hasLegalMoveFrom(currentState, square) ? square : null,
        pendingPromotion: null,
        activeBoardMotion: null,
        error: null,
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }

    if (state.selectedSquare === square) {
      state = {
        ...state,
        selectedSquare: null,
        pendingPromotion: null,
        activeBoardMotion: null,
        error: null,
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }

    const legalMoves = legalMovesFromSelection(currentState, state.selectedSquare, square);
    if (legalMoves.length === 0) {
      state = {
        ...state,
        selectedSquare: hasLegalMoveFrom(currentState, square) ? square : null,
        pendingPromotion: null,
        activeBoardMotion: null,
        error: playError("invalid-input", "invalid-move"),
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }

    if (legalMoves.length === 1) {
      const [legalMove] = legalMoves;
      if (legalMove !== undefined) {
        await applyPlayerMove(legalMove);
      }
      return;
    }

    const choices = promotionChoicesFromMoves(legalMoves);
    if (choices.length !== legalMoves.length) {
      state = {
        ...state,
        pendingPromotion: null,
        error: playError("invalid-input", "invalid-move"),
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }

    state = {
      ...state,
      pendingPromotion: { from: state.selectedSquare, to: square, choices },
      activeBoardMotion: null,
      error: null,
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();
  };

  const applyPromotionMove = async (move: string): Promise<void> => {
    if (
      !canAcceptBoardInput(state) ||
      state.pendingPromotion === null ||
      !state.pendingPromotion.choices.some((choice) => choice.move === move)
    ) {
      return;
    }
    await applyPlayerMove(move);
  };

  const applyPlayerMove = async (move: string): Promise<void> => {
    const before = state.engineState;
    if (before === null) {
      return;
    }
    const version = tracker.game();
    const moveAttribution = currentPlayMoveAttribution(state, dependencies);
    state = {
      ...state,
      selectedSquare: null,
      pendingPromotion: null,
      activeBoardMotion: null,
      status: "thinking",
      error: null,
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();

    const playerResult = await runEngineOperation(() =>
      dependencies.engine.makeMove(
        before.fen,
        move,
        state.moves.map((playedMove) => playedMove.fenBefore)
      )
    );
    if (!tracker.isCurrent("game", version)) {
      return;
    }
    if (!playerResult.ok) {
      state = {
        ...state,
        status: "failed",
        error: playError("player-move", playerResult.error),
        activeBoardMotion: null,
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }

    state = appendMove(state, playerResult.value, "player", before.sideToMove, before.fen, moveAttribution);
    const playerMove = state.moves[state.moves.length - 1];
    if (playerMove !== undefined) {
      emitMoveEvidence(playerMove);
    }
    render();

    if (state.playMode === "reaction-lens") {
      tracker.begin("player-move-in-explore");
      state = completeAndCaptureTerminal({
        ...state,
        status: "ready",
        activeBoardMotion: null,
        engineMode: currentEngineMode(dependencies.engine),
        reactionLensView: focusedReactionLensView(),
        reaction: reactionFromState(playerResult.value.state, "idle"),
        forcing: forcingFromState(playerResult.value.state, state.playerSide, "idle"),
        sideExplore: sideExploreFromState(playerResult.value.state, state.playerSide, "idle")
      });
      render();
      // A new FEN supersedes in-flight Explore work. Version guards preserve correctness, while
      // terminating the old analysis prevents stale work from occupying the analysis worker.
      dependencies.analysisEngine?.cancelSearch?.();
      void requestActiveLensAnalysis(version, playerResult.value.state);
      return;
    }

    if (state.playMode === "spectator-lens") {
      state = completeAndCaptureTerminal({
        ...state,
        status: "ready",
        activeBoardMotion: null,
        engineMode: currentEngineMode(dependencies.engine),
        lens: lensFromState(playerResult.value.state, "idle")
      });
      render();
      void requestLensAnalysis(version, playerResult.value.state);
      return;
    }

    await requestEngineMove(version, playerResult.value.state);
  };

  const requestEngineMove = async (version: number, before: EngineStateDto): Promise<void> => {
    if (!tracker.isCurrent("game", version)) {
      return;
    }
    if (before.status !== "ongoing" || before.sideToMove === state.playerSide) {
      state = completeAndCaptureTerminal({
        ...state,
        engineState: before,
        activeBoardMotion: null,
        status: "ready",
        engineMode: currentEngineMode(dependencies.engine)
      });
      render();
      return;
    }

    const depth = state.engineDepth;
    const moveAttribution = currentPlayMoveAttribution(state, dependencies);
    state = {
      ...state,
      engineState: before,
      selectedSquare: null,
      pendingPromotion: null,
      activeBoardMotion: null,
      status: "thinking",
      error: null,
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();

    const pacingStartedAt = motion.now();
    const previousLine = state.lastBestMove?.principalLine?.length
      ? state.lastBestMove.principalLine
      : [];
    const best = await runEngineOperation(() =>
      dependencies.engine.bestMove(
        before.fen,
        depth,
        before.legalMoves,
        state.aggressive,
        {
          side: before.sideToMove,
          userSide: state.playerSide,
          historyFens: state.moves.map((move) => move.fenBefore),
          previousLine
        }
      )
    );
    if (!tracker.isCurrent("game", version)) {
      return;
    }
    if (!best.ok) {
      state = {
        ...state,
        status: "failed",
        error: playError("engine-search", best.error),
        activeBoardMotion: null,
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }
    if (best.value.bestMove === null) {
      state = {
        ...state,
        status: "failed",
        error: playError("engine-search", "search-failed"),
        activeBoardMotion: null,
        engineMode: currentEngineMode(dependencies.engine),
        lastBestMove: best.value
      };
      render();
      return;
    }

    const engineMove = best.value.bestMove;
    const engineResult = await runEngineOperation(() =>
      dependencies.engine.makeMove(
        before.fen,
        engineMove,
        state.moves.map((playedMove) => playedMove.fenBefore)
      )
    );
    if (!tracker.isCurrent("game", version)) {
      return;
    }
    if (!engineResult.ok) {
      state = {
        ...state,
        status: "failed",
        error: playError("engine-move", engineResult.error),
        activeBoardMotion: null,
        engineMode: currentEngineMode(dependencies.engine),
        lastBestMove: best.value
      };
      render();
      return;
    }

    if (!(await waitForEnginePacing(motion, pacingStartedAt, () => tracker.isCurrent("game", version)))) {
      return;
    }
    const activeBoardMotion = engineBoardMotion(engineMove, motion.engineMoveAnimationMs);
    if (activeBoardMotion !== null) {
      state = {
        ...state,
        engineState: before,
        status: "thinking",
        error: null,
        activeBoardMotion,
        engineMode: currentEngineMode(dependencies.engine),
        lastBestMove: best.value
      };
      render();
      await motion.delay(activeBoardMotion.durationMs);
      if (!tracker.isCurrent("game", version)) {
        return;
      }
    }

    state = {
      ...completeAndCaptureTerminal(
        appendMove(
          state,
          engineResult.value,
          "engine",
          before.sideToMove,
          before.fen,
          moveAttribution
        )
      ),
      status: "ready",
      activeBoardMotion: null,
      engineMode: currentEngineMode(dependencies.engine),
      lastBestMove: best.value
    };
    const committedEngineMove = state.moves[state.moves.length - 1];
    if (committedEngineMove !== undefined) {
      emitMoveEvidence(committedEngineMove);
    }
    render();
  };

  const requestLensAnalysis = async (version: number, before: EngineStateDto): Promise<void> => {
    if (state.playMode !== "spectator-lens" || !tracker.isCurrent("game", version)) {
      return;
    }
    const requestVersion = tracker.nextLens();
    if (before.status !== "ongoing") {
      state = {
        ...state,
        lens: lensFromState(before, "idle"),
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }

    const depth = state.engineDepth;
    state = {
      ...state,
      lens: lensFromState(before, "pending"),
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();

    const analysisEngine = dependencies.analysisEngine;
    const result =
      analysisEngine === undefined
        ? ({ ok: false, error: "search-failed" } as const)
        : await runEngineOperation(() => analysisEngine.bestMove(before.fen, depth, before.legalMoves));
    if (
      !tracker.isCurrent("game", version) ||
      !tracker.isCurrent("lens", requestVersion) ||
      state.engineState?.fen !== before.fen
    ) {
      return;
    }
    if (!result.ok && result.error === "cancelled") {
      // Abandoned on purpose, not an engine fault: leave the lens waiting for its next request.
      state = { ...state, lens: lensFromState(before, "idle") };
      render();
      return;
    }

    state = {
      ...state,
      lens: result.ok
        ? {
            status: "ready",
            fen: before.fen,
            legalMoveCount: before.legalMoves.length,
            bestMove: result.value,
            error: null
          }
        : {
            status: "failed",
            fen: before.fen,
            legalMoveCount: before.legalMoves.length,
            bestMove: null,
            error: result.error
          },
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();
  };

  const requestActiveLensAnalysis = (version: number, before: EngineStateDto): Promise<void> => {
    return state.reactionLensView === "forcing"
      ? requestForcingAnalysis(version, before)
      : requestSideExploreAnalysis(version, before);
  };

  const requestSideExploreAnalysis = async (
    version: number,
    before: EngineStateDto
  ): Promise<void> => {
    if (state.playMode !== "reaction-lens" || !tracker.isCurrent("game", version)) {
      return;
    }
    const side = state.playerSide;
    const requestVersion = tracker.nextSideExplore();
    if (before.status !== "ongoing") {
      state = {
        ...state,
        sideExplore: sideExploreFromState(before, side, "idle"),
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }

    state = {
      ...state,
      sideExplore: sideExploreFromState(before, side, "pending"),
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();

    const analysisEngine = dependencies.analysisEngine;
    const sideExploreFn = analysisEngine?.sideExplore;
    const sideExploreContext = {
      mode: state.reactionLensDepth,
      previousLine: state.sideExplorePreviousLine
    } as const;
    const fallbackSearch =
      analysisEngine !== undefined && before.sideToMove === side
        ? runEngineOperation(() =>
            analysisEngine.bestMove(before.fen, sideExploreFallbackDepth, before.legalMoves, false)
          ).then((fallbackResult) =>
            fallbackResult.ok
              ? provisionalSideExploreFromBestMove(before, side, fallbackResult.value)
              : null
          )
        : Promise.resolve(null);

    const richSearch =
      sideExploreFn === undefined
        ? Promise.resolve({ ok: false, error: "search-failed" } as const)
        : runEngineOperation(() =>
            sideExploreFn(
              before.fen,
              side,
              state.aggressive,
              state.moves.map((move) => move.fenBefore),
              sideExploreContext
            )
          );

    const applyRichResult = (result: ControlledEngineResult<SideExploreDto>): void => {
      if (
        !tracker.isCurrent("game", version) ||
        !tracker.isCurrent("sideExplore", requestVersion) ||
        state.engineState?.fen !== before.fen
      ) {
        return;
      }
      if (!result.ok && result.error === "cancelled") {
        // Keep a fallback already on screen; otherwise return to idle instead of "failed".
        if (state.sideExplore.status === "pending") {
          state = { ...state, sideExplore: sideExploreFromState(before, side, "idle") };
        }
        render();
        return;
      }

      const nextPreviousLine =
        result.ok &&
        result.value.side === side &&
        result.value.principalLine.length >= 3
          ? result.value.principalLine
          : state.sideExplorePreviousLine;
      const previousRich =
        result.ok &&
        state.sideExplore.status === "ready" &&
        state.sideExplore.fen === before.fen &&
        state.sideExplore.side === side &&
        state.sideExplore.source === "rich" &&
        state.sideExplore.result !== null
          ? state.sideExplore.result
          : null;
      state = {
        ...state,
        sideExplore: result.ok
          ? { status: "ready", fen: before.fen, side, result: result.value, source: "rich", error: null }
          : state.sideExplore.status === "ready" &&
              state.sideExplore.fen === before.fen &&
              state.sideExplore.side === side &&
              state.sideExplore.result !== null
            ? state.sideExplore
            : { status: "failed", fen: before.fen, side, result: null, source: null, error: result.error },
        sideExplorePreviousLine: nextPreviousLine,
        engineMode: currentEngineMode(dependencies.engine)
      };
      if (result.ok) {
        const nodeBudget = sideExploreNodeBudget(sideExploreContext.mode);
        if (
          previousRich !== null &&
          JSON.stringify(candidateEvidenceRecords(previousRich)) !==
            JSON.stringify(candidateEvidenceRecords(result.value))
        ) {
          emitSideExploreDiscrepancyEvidence(before.fen, previousRich, result.value, sideExploreContext.mode, nodeBudget);
        }
        emitSideExploreEvidence(before.fen, result.value, sideExploreContext.mode, nodeBudget);
      }
      render();
    };

    const applyFallback = (fallback: SideExploreDto | null): void => {
      if (
        fallback === null ||
        !tracker.isCurrent("game", version) ||
        !tracker.isCurrent("sideExplore", requestVersion) ||
        state.engineState?.fen !== before.fen ||
        state.sideExplore.fen !== before.fen ||
        state.sideExplore.side !== side ||
        state.sideExplore.source === "rich" ||
        (state.sideExplore.status !== "pending" &&
          !(state.sideExplore.status === "failed" && state.sideExplore.result === null))
      ) {
        return;
      }
      state = {
        ...state,
        sideExplore: { status: "ready", fen: before.fen, side, result: fallback, source: "provisional", error: null },
        engineMode: currentEngineMode(dependencies.engine)
      };
      emitSideExploreEvidence(before.fen, fallback, "fallback", playEvidenceMoveNodeBudget(sideExploreFallbackDepth));
      render();
    };

    // The depth-1 fallback is legal and explicitly provisional. Surface it as soon as it is
    // available instead of withholding a usable move until the rich deadline; the rich result
    // still owns the final recommendation and replaces it only when its request guards match.
    const fallbackReady = fallbackSearch.then((fallback) => {
      applyFallback(fallback);
      return fallback;
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutSearch = new Promise<"deadline">((resolve) => {
      timeout = setTimeout(() => {
        resolve("deadline");
      }, sideExploreContext.mode === "fast" ? motion.sideExploreFastDeadlineMs : motion.sideExploreDeepDeadlineMs);
    });
    const firstResult = await Promise.race([
      richSearch.then((result) => ({ kind: "rich" as const, result })),
      timeoutSearch.then((result) => ({ kind: result as "deadline" }))
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (firstResult.kind === "rich") {
      applyRichResult(firstResult.result);
      return;
    }
    await fallbackReady;
    applyRichResult(await richSearch);
  };

  const requestForcingAnalysis = async (
    version: number,
    before: EngineStateDto
  ): Promise<void> => {
    if (state.playMode !== "reaction-lens" || !tracker.isCurrent("game", version)) {
      return;
    }
    const host = state.playerSide;
    const requestVersion = tracker.nextForcing();
    // The lens only surfaces forcing options the host can play right now; when it is not the
    // host's turn (or the game is over) there is nothing to search.
    if (before.status !== "ongoing" || before.sideToMove !== host) {
      state = {
        ...state,
        forcing: forcingFromState(before, host, "idle"),
        engineMode: currentEngineMode(dependencies.engine)
      };
      render();
      return;
    }

    const depth = state.engineDepth;
    state = {
      ...state,
      forcing: forcingFromState(before, host, "pending"),
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();

    const forcingMap = dependencies.analysisEngine?.forcingMap;
    const result =
      forcingMap === undefined
        ? ({ ok: false, error: "search-failed" } as const)
        : await runEngineOperation(() =>
            forcingMap(before.fen, depth, host, state.reactionLensDepth === "deep")
          );
    if (
      !tracker.isCurrent("game", version) ||
      !tracker.isCurrent("forcing", requestVersion) ||
      state.engineState?.fen !== before.fen
    ) {
      return;
    }
    if (!result.ok && result.error === "cancelled") {
      state = { ...state, forcing: forcingFromState(before, host, "idle") };
      render();
      return;
    }

    state = {
      ...state,
      forcing: result.ok
        ? { status: "ready", fen: before.fen, host, map: result.value, error: null }
        : { status: "failed", fen: before.fen, host, map: null, error: result.error },
      engineMode: currentEngineMode(dependencies.engine)
    };
    render();
  };

  closeMoreMenuOnOutsideClick(root);
  const ready = startNewGame({ notifyReset: false });
  return { ready, loadPosition: applyLoadPosition };
}

function appendMove(
  state: PlayUiState,
  result: MoveResultDto,
  actor: PlayMove["actor"],
  side: ColorDto,
  fenBefore: string,
  attribution: PlayMoveAttribution
): PlayUiState {
  return {
    ...state,
    engineState: result.state,
    pendingPromotion: null,
    activeBoardMotion: null,
    moves: [
      ...state.moves,
      {
        ply: state.moves.length + 1,
        actor,
        side,
        coordinate: result.appliedMove,
        san: result.san,
        fenBefore,
        fenAfter: result.state.fen,
        attribution
      }
    ],
    lastMove: result.appliedMove,
    error: null
  };
}

function currentPlayMoveAttribution(
  state: PlayUiState,
  dependencies: PlayUiDependencies
): PlayMoveAttribution {
  return {
    buildSha: dependencies.automaticEvidence?.buildSha ?? "unknown",
    evaluatorBackend: currentEngineMode(dependencies.engine),
    engineDepth: state.engineDepth,
    aggressive: state.aggressive
  };
}

function provisionalSideExploreFromBestMove(
  engineState: EngineStateDto,
  side: ColorDto,
  bestMove: BestMoveDto
): SideExploreDto | null {
  const move = bestMove.bestMove;
  if (move === null || !engineState.legalMoves.includes(move)) {
    return null;
  }
  return {
    state: engineState,
    side,
    onTurn: true,
    replyCandidates: [],
    candidates: [
      {
        move,
        kind: "defense",
        exactScoreCp: bestMove.scoreCp,
        sound: false,
        sacrifice: false,
        mateIn: null,
        aftermath: null,
        continuation: null,
        prospectiveBrilliant: false
      }
    ],
    principalLine:
      bestMove.principalLine !== undefined && bestMove.principalLine.length > 0
        ? bestMove.principalLine
        : [move],
    mateDetected: false,
    depth: bestMove.depth,
    nodes: bestMove.nodes,
    soundMarginCp: 50,
    planStatus: "none",
    planReason: "no-previous-line"
  };
}

function browserManualAggressiveEvidenceStorage(): ManualAggressiveEvidenceStorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function initialEvidenceState(
  storage: ManualAggressiveEvidenceStorageLike | null
): PlayEvidenceState {
  if (storage === null) {
    return {
      savedCount: 0,
      savedSessions: [],
      status: "idle",
      automaticStatus: "live",
      error: null,
      savedFingerprint: null
    };
  }
  const store = readManualAggressiveEvidenceStore(storage);
  return typeof store === "string"
    ? {
        savedCount: 0,
        savedSessions: [],
        status: "failed",
        automaticStatus: "live",
        error: store,
        savedFingerprint: null
      }
    : {
        savedCount: store.sessions.length,
        savedSessions: store.sessions,
        status: "idle",
        automaticStatus: "live",
        error: null,
        savedFingerprint: null
      };
}

const playGameArchiveStoreKey = "chess.play.gameArchive.v1";
const maxArchivedGames = 200;
const minArchivedPlies = 2;

function initialGameArchiveState(
  storage: ManualAggressiveEvidenceStorageLike | null
): PlayGameArchiveState {
  if (storage === null) {
    return { savedCount: 0, status: "idle", error: null, savedFingerprint: null, savedGameId: null };
  }
  const store = readPlayGameArchiveStore(storage);
  if (typeof store === "string") {
    return { savedCount: 0, status: "failed", error: store, savedFingerprint: null, savedGameId: null };
  }
  const lastGame = store.games.length > 0 ? store.games[store.games.length - 1] : null;
  return { savedCount: store.games.length, status: "idle", error: null, savedFingerprint: null, savedGameId: lastGame?.id ?? null };
}

function readPlayGameArchiveStore(
  storage: ManualAggressiveEvidenceStorageLike
): PlayGameArchiveStore | NonNullable<PlayGameArchiveState["error"]> {
  let raw: string | null;
  try {
    raw = storage.getItem(playGameArchiveStoreKey);
  } catch {
    return "storage-read-failed";
  }
  if (raw === null) {
    return { schemaVersion: 1, games: [] };
  }
  try {
    const parsed = JSON.parse(raw) as { readonly schemaVersion?: unknown; readonly games?: unknown };
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.games)) {
      return "storage-read-failed";
    }
    return { schemaVersion: 1, games: parsed.games as readonly PlayGameArchiveRecord[] };
  } catch {
    return "storage-read-failed";
  }
}

function appendPlayGameArchiveRecord(
  storage: ManualAggressiveEvidenceStorageLike,
  record: PlayGameArchiveRecord
): PlayGameArchiveStore | NonNullable<PlayGameArchiveState["error"]> {
  const current = readPlayGameArchiveStore(storage);
  if (typeof current === "string") {
    return current;
  }
  const next = {
    schemaVersion: 1,
    games: [...current.games, record].slice(-maxArchivedGames)
  } satisfies PlayGameArchiveStore;
  try {
    storage.setItem(playGameArchiveStoreKey, JSON.stringify(next));
  } catch (error) {
    return isQuotaExceededError(error) ? "storage-quota-exceeded" : "storage-write-failed";
  }
  return next;
}

function isQuotaExceededError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const { name, code } = error as { readonly name?: unknown; readonly code?: unknown };
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014;
}

function buildPlayGameArchiveRecord(
  state: PlayUiState,
  reason: PlayGameArchiveRecord["saveReason"],
  metadata: {
    readonly recommendations: ReadonlyMap<string, PlayGameArchiveRecommendationSnapshot>;
  }
): PlayGameArchiveRecord | null {
  if (state.moves.length < minArchivedPlies && state.completedGame === null) {
    return null;
  }
  const finalFen =
    state.engineState?.fen ??
    state.completedGame?.finalFen ??
    state.moves[state.moves.length - 1]?.fenAfter ??
    setupStartFen;
  const result = state.completedGame?.result ?? "*";
  const moves = state.moves.map((move): PlayGameArchiveMove => ({
    ...move,
    // Role is the user-facing side perspective. Actor remains execution provenance:
    // reaction-lens can record player clicks for either side.
    role: move.side === state.playerSide ? "user" : "rival",
    selectedSide: state.playerSide,
    buildSha: move.attribution.buildSha,
    evaluatorBackend: move.attribution.evaluatorBackend,
    engineDepth: move.attribution.engineDepth,
    aggressive: move.attribution.aggressive,
    recommendationBeforeMove:
      metadata.recommendations.get(playGameArchiveRecommendationKey(move.ply, move.fenBefore)) ?? null
  }));
  const firstMoveBuildSha = moves[0]?.buildSha ?? "unknown";
  return {
    schema: 1,
    id: `game-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    savedAtIso: new Date().toISOString(),
    source: "play-game-archive",
    saveReason: reason,
    engineBuildSha: firstMoveBuildSha,
    selectedSide: state.playerSide,
    playMode: state.playMode,
    aggressive: state.aggressive,
    engineDepth: state.engineDepth,
    startFen: state.moves[0]?.fenBefore ?? setupStartFen,
    finalFen,
    pgn: buildReviewPgn(state.moves, result),
    ...(state.completedGame === null
      ? {}
      : {
          result: state.completedGame.result,
          termination: state.completedGame.status,
          ...(state.completedGame.resignedSide === undefined
            ? {}
            : { resignedSide: state.completedGame.resignedSide }),
          ...(state.completedGame.resignedBy === undefined
            ? {}
            : { resignedBy: state.completedGame.resignedBy })
        }),
    moves
  };
}

function playGameArchiveFingerprint(state: PlayUiState): string {
  return JSON.stringify({
    selectedSide: state.playerSide,
    playMode: state.playMode,
    aggressive: state.aggressive,
    engineDepth: state.engineDepth,
    completedGame:
      state.completedGame === null
        ? null
        : {
            status: state.completedGame.status,
            result: state.completedGame.result,
            resignedSide: state.completedGame.resignedSide ?? null,
            resignedBy: state.completedGame.resignedBy ?? null,
            finalFen: state.completedGame.finalFen
          },
    moves: state.moves.map((move) => ({
      ply: move.ply,
      side: move.side,
      coordinate: move.coordinate,
      fenAfter: move.fenAfter
    }))
  });
}

function createAutomaticEvidenceSessionId(): string {
  const cryptoHost = globalThis.crypto;
  if (typeof cryptoHost.randomUUID === "function") {
    return cryptoHost.randomUUID();
  }
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function playEvidenceMoveNodeBudget(level: number): number {
  if (level === 3) {
    return 240_000;
  }
  if (level === 5) {
    return 960_000;
  }
  return 60_000;
}

function sideExploreNodeBudget(mode: ReactionLensDepth): number {
  return mode === "fast" ? 100_000 : 300_000;
}

function sideExplorePrimaryRenderState(
  result: SideExploreDto
): Extract<PlayAutomaticEvidenceEvent, { readonly type: "recommendation" }>["primaryRenderState"] {
  const primary = result.candidates[0];
  if (primary === undefined) {
    return "unverified";
  }
  if (primary.sound) {
    return "recommended";
  }
  return "alt-risk";
}

function playGameArchiveRecommendationKey(ply: number, fenBefore: string): string {
  return `${String(ply)}:${fenBefore}`;
}

function buildPlayGameArchiveRecommendationSnapshot(
  event: Extract<PlayAutomaticEvidenceEvent, { readonly type: "recommendation" }>,
  result: SideExploreDto
): PlayGameArchiveRecommendationSnapshot {
  return {
    schema: 1,
    sessionId: event.sessionId,
    seq: event.seq,
    buildSha: event.buildSha,
    evaluatorBackend: event.evaluatorBackend,
    level: event.level,
    nodeBudget: event.nodeBudget,
    exploreMode: event.exploreMode,
    aggressive: event.aggressive,
    userSide: event.userSide,
    ply: event.ply,
    fenBefore: event.fenBefore,
    side: result.side,
    onTurn: result.onTurn,
    primaryMove: event.primaryMove,
    primaryRenderState: event.primaryRenderState,
    candidates: result.candidates.map((candidate, index) => ({
      move: candidate.move,
      kind: candidate.kind,
      exactScoreCp: candidate.exactScoreCp,
      sound: candidate.sound,
      sacrifice: candidate.sacrifice,
      aftermath: candidate.aftermath,
      mateIn: candidate.mateIn,
      continuation: candidate.continuation,
      rank: index + 1
    })),
    replyCandidates: result.replyCandidates.map((candidate) => ({ ...candidate })),
    principalLine: [...result.principalLine],
    principalLineFirst: result.principalLine[0] ?? null,
    replyCandidateFirst: objectiveReplyForResult(result)?.move ?? null
  };
}

function safeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

function downloadJson(json: string, filename: string): boolean {
  if (
    typeof document === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    return false;
  }

  const anchor = document.createElement("a");
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}

function completeIfTerminal(state: PlayUiState): PlayUiState {
  if (state.engineState === null || state.engineState.status === "ongoing") {
    return state;
  }
  return {
    ...state,
    completedGame: buildCompletedPlayGame(state.moves, state.engineState)
  };
}

export function buildCompletedPlayGame(
  moves: readonly PlayMove[],
  finalState: EngineStateDto
): CompletedPlayGame | null {
  if (finalState.status === "ongoing") {
    return null;
  }
  const result = terminalResult(finalState);
  return {
    status: finalState.status,
    result,
    ...(finalState.status === "draw" ? { drawReason: finalState.drawReason ?? null } : {}),
    finalFen: finalState.fen,
    pgn: buildReviewPgn(moves, result),
    moves
  };
}

function buildResignedPlayGame(
  moves: readonly PlayMove[],
  finalState: EngineStateDto,
  resignedSide: ColorDto,
  resignedBy: "user" | "rival"
): CompletedPlayGame {
  const result = resignationResult(resignedSide);
  return {
    status: "resigned",
    result,
    resignedSide,
    resignedBy,
    finalFen: finalState.fen,
    pgn: buildReviewPgn(moves, result),
    moves
  };
}

function buildReviewPgn(moves: readonly PlayMove[], result: CompletedPlayGame["result"] | "*"): string {
  const turns: string[] = [];
  for (let index = 0; index < moves.length; index += 2) {
    const whiteMove = moves[index];
    if (whiteMove === undefined) {
      continue;
    }
    const blackMove = moves[index + 1];
    const moveNumber = Math.floor(index / 2) + 1;
    turns.push(
      blackMove === undefined
        ? `${String(moveNumber)}. ${whiteMove.san}`
        : `${String(moveNumber)}. ${whiteMove.san} ${blackMove.san}`
    );
  }
  return `${turns.join(" ")} ${result}`.trim();
}

function terminalResult(state: EngineStateDto): CompletedPlayGame["result"] {
  if (state.status === "stalemate" || state.status === "draw") {
    return "1/2-1/2";
  }
  return state.sideToMove === "white" ? "0-1" : "1-0";
}

function resignationResult(playerSide: PlayerSide): CompletedPlayGame["result"] {
  return playerSide === "white" ? "0-1" : "1-0";
}

function playError(source: PlayErrorSource, code: PlayErrorCode): PlayErrorState {
  return { source, code };
}

function currentEngineMode(engine: PlayEngine): PlayEngineMode {
  return engine.mode?.() ?? "owned-local";
}

async function runEngineOperation<T>(
  operation: () => Promise<PlayEngineResult<T>>
): Promise<ControlledEngineResult<T>> {
  try {
    return await operation();
  } catch {
    return { ok: false, error: "operation-failed" };
  }
}

type ResolvedPlayMotion = {
  readonly engineReplyMinDelayMs: number;
  readonly engineMoveAnimationMs: number;
  readonly sideExploreFastDeadlineMs: number;
  readonly sideExploreDeepDeadlineMs: number;
  readonly delay: (ms: number) => Promise<void>;
  readonly now: () => number;
};

function resolvePlayMotion(config: PlayUiMotionConfig | undefined): ResolvedPlayMotion {
  const browserRuntime = typeof window !== "undefined";
  const reducedMotion = config?.reducedMotion ?? prefersReducedMotion();
  return {
    engineReplyMinDelayMs: normalizeMotionMs(
      config?.engineReplyMinDelayMs ?? (browserRuntime ? browserEngineReplyMinDelayMs : 0),
      browserEngineReplyMinDelayMs
    ),
    engineMoveAnimationMs: reducedMotion
      ? 0
      : normalizeEngineMoveAnimationMs(
          config?.engineMoveAnimationMs ?? (browserRuntime ? browserEngineMoveAnimationMs : 0),
          browserEngineMoveAnimationMs
        ),
    sideExploreFastDeadlineMs: normalizeSideExploreDeadlineMs(
      config?.sideExploreFastDeadlineMs ?? sideExploreFastDeadlineMs,
      sideExploreFastDeadlineMs
    ),
    sideExploreDeepDeadlineMs: normalizeSideExploreDeadlineMs(
      config?.sideExploreDeepDeadlineMs ?? sideExploreDeepDeadlineMs,
      sideExploreDeepDeadlineMs
    ),
    delay: config?.delay ?? delay,
    now: config?.now ?? monotonicNow
  };
}

function normalizeMotionMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(2_000, Math.round(value));
}

function normalizeEngineMoveAnimationMs(value: number, fallback: number): number {
  const normalized = normalizeMotionMs(value, fallback);
  return normalized === 0 || normalized === 180 || normalized === 220 || normalized === 260 ? normalized : fallback;
}

function normalizeSideExploreDeadlineMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0 || value > sideExploreDeepDeadlineMs) {
    return fallback;
  }
  return Math.round(value);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForEnginePacing(
  motion: ResolvedPlayMotion,
  startedAt: number,
  isCurrent: () => boolean
): Promise<boolean> {
  const remaining = Math.max(0, motion.engineReplyMinDelayMs - (motion.now() - startedAt));
  if (remaining > 0) {
    await motion.delay(remaining);
  }
  return isCurrent();
}

function engineBoardMotion(move: string, durationMs: number): PlayBoardMotion | null {
  const from = move.slice(0, 2);
  const to = move.slice(2, 4);
  if (durationMs <= 0 || !isBoardSquare(from) || !isBoardSquare(to)) {
    return null;
  }
  return { actor: "engine", move, from, to, durationMs };
}

function parsePiecesFromFen(fen: string | null): ReadonlyMap<BoardSquare, SetupPiece> {
  const pieces = new Map<BoardSquare, SetupPiece>();
  if (fen === null) return pieces;
  const placement = fen.split(" ")[0];
  if (placement === undefined) return pieces;
  const rows = placement.split("/");
  const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"] as const;
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
  for (const [rankIndex, row] of rows.entries()) {
    const rank = ranks[rankIndex];
    if (rank === undefined) continue;
    let fileIndex = 0;
    for (const char of row) {
      if (/^[1-8]$/u.test(char)) {
        fileIndex += Number.parseInt(char, 10);
        continue;
      }
      const file = files[fileIndex];
      if (file === undefined) { fileIndex++; continue; }
      const square: BoardSquare = `${file}${rank}`;
      const piece = fenCharToSetupPiece(char);
      if (piece !== null) pieces.set(square, piece);
      fileIndex++;
    }
  }
  return pieces;
}

function fenCharToSetupPiece(char: string): SetupPiece | null {
  const map: Record<string, SetupPieceKind> = {
    k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn"
  };
  const lower = char.toLowerCase();
  const kind = map[lower];
  if (kind === undefined) return null;
  return { color: char === lower ? "black" : "white", kind };
}

function setupPieceSymbol(piece: SetupPiece): string {
  const map: Record<SetupPieceKind, string> = {
    king: "k", queen: "q", rook: "r", bishop: "b", knight: "n", pawn: "p"
  };
  const symbol = map[piece.kind];
  return piece.color === "white" ? symbol.toUpperCase() : symbol;
}

function buildSetupFen(pieces: ReadonlyMap<BoardSquare, SetupPiece>, sideToMove: SetupPieceColor): string {
  const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"] as const;
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
  const rows: string[] = [];
  for (const rank of ranks) {
    let row = "";
    let empty = 0;
    for (const file of files) {
      const square: BoardSquare = `${file}${rank}`;
      const piece = pieces.get(square);
      if (piece === undefined) {
        empty++;
      } else {
        if (empty > 0) { row += String(empty); empty = 0; }
        row += setupPieceSymbol(piece);
      }
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  const side = sideToMove === "white" ? "w" : "b";
  let castling = "";
  if (pieces.get("e1")?.kind === "king" && pieces.get("e1")?.color === "white") {
    if (pieces.get("h1")?.kind === "rook" && pieces.get("h1")?.color === "white") castling += "K";
    if (pieces.get("a1")?.kind === "rook" && pieces.get("a1")?.color === "white") castling += "Q";
  }
  if (pieces.get("e8")?.kind === "king" && pieces.get("e8")?.color === "black") {
    if (pieces.get("h8")?.kind === "rook" && pieces.get("h8")?.color === "black") castling += "k";
    if (pieces.get("a8")?.kind === "rook" && pieces.get("a8")?.color === "black") castling += "q";
  }
  return `${rows.join("/")} ${side} ${castling === "" ? "-" : castling} - 0 1`;
}

function buildSetupEngineState(setup: SetupState): EngineStateDto {
  const fen = buildSetupFen(setup.pieces, setup.sideToMove);
  return { fen, status: "ongoing", sideToMove: setup.sideToMove, legalMoves: [] };
}

function canAcceptBoardInput(state: PlayUiState): boolean {
  if (isSetupMode(state.playMode)) {
    return state.status !== "loading";
  }
  return (
    state.status === "ready" &&
    state.completedGame === null &&
    state.engineState !== null &&
    state.engineState.status === "ongoing" &&
    (isSpectatorMode(state.playMode) || state.engineState.sideToMove === state.playerSide)
  );
}

function canResign(state: PlayUiState): boolean {
  return (
    state.playMode !== "spectator-lens" &&
    state.status !== "loading" &&
    state.status !== "failed" &&
    state.completedGame === null &&
    state.engineState !== null &&
    state.engineState.status === "ongoing"
  );
}

function resignationSide(state: PlayUiState, actor: "user" | "rival"): PlayerSide {
  if (actor === "user") {
    return state.playerSide;
  }
  return state.playerSide === "white" ? "black" : "white";
}

function resignationActionLabel(
  state: PlayUiState,
  actor: "user" | "rival",
  copy: ReturnType<typeof copyFor>
): string {
  const side = resignationSide(state, actor);
  const actorLabel = actor === "rival" ? copy.resignRival : copy.resignUser;
  return `${actorLabel} (${side === "white" ? copy.white : copy.black})`;
}

function canChangePlayerSide(state: PlayUiState): boolean {
  if (isSpectatorMode(state.playMode)) {
    return state.status !== "loading" && state.status !== "thinking";
  }
  return (
    state.status !== "loading" &&
    state.status !== "thinking" &&
    (state.moves.length === 0 || state.engineState?.status !== "ongoing" || state.completedGame !== null)
  );
}

function playInputSide(state: PlayUiState): PlayerSide {
  return isSpectatorMode(state.playMode) && state.engineState !== null
    ? state.engineState.sideToMove
    : state.playerSide;
}

function canChangeEngineDepth(state: PlayUiState): boolean {
  return state.status !== "loading" && state.status !== "thinking";
}

// A takeback is available whenever there is a move to revert and the engine is idle. It is allowed
// after the game ends too, so a mistaken final move can be undone (the undo clears the terminal).
function canUndoMove(state: PlayUiState): boolean {
  return state.moves.length > 0 && state.status !== "loading" && state.status !== "thinking";
}

function canChangePlayMode(state: PlayUiState): boolean {
  return state.status !== "loading" && state.status !== "thinking";
}

function isPlayMode(value: string | null): value is PlayMode {
  return value === "opponent" || value === "spectator-lens" || value === "reaction-lens" || value === "setup";
}

function isReactionLensView(value: string | null): value is ReactionLensView {
  return value === "reaction" || value === "forcing";
}

function isReactionLensDepth(value: string | null): value is ReactionLensDepth {
  return value === "fast" || value === "deep";
}

function isSetupPieceColor(value: string | null): value is SetupPieceColor {
  return value === "white" || value === "black";
}

function isSetupPieceKind(value: string | null): value is SetupPieceKind {
  return (
    value === "king" ||
    value === "queen" ||
    value === "rook" ||
    value === "bishop" ||
    value === "knight" ||
    value === "pawn"
  );
}

function isPlayerSide(value: string | null): value is PlayerSide {
  return value === "white" || value === "black";
}

function isElementWithListeners(value: unknown): value is HTMLElement {
  const candidate = value as {
    readonly addEventListener?: unknown;
    readonly getAttribute?: unknown;
    readonly removeAttribute?: unknown;
    readonly setAttribute?: unknown;
  };
  return (
    typeof candidate.addEventListener === "function" &&
    typeof candidate.getAttribute === "function" &&
    typeof candidate.removeAttribute === "function" &&
    typeof candidate.setAttribute === "function"
  );
}

function isInputElement(value: unknown): value is HTMLInputElement {
  if (value === null || value === undefined) {
    return false;
  }
  const candidate = value as { readonly addEventListener?: unknown; readonly value?: unknown };
  return typeof candidate.addEventListener === "function" && typeof candidate.value === "string";
}

function isRenderableElement(value: unknown): value is HTMLElement {
  const candidate = value as {
    readonly getBoundingClientRect?: unknown;
    readonly innerHTML?: unknown;
  };
  return typeof candidate.getBoundingClientRect === "function" && typeof candidate.innerHTML === "string";
}

function isPrimaryMouseEvent(event: Event): event is MouseEvent {
  return typeof MouseEvent !== "undefined" && event instanceof MouseEvent && event.button === 0;
}

function parsePlayDepth(value: string | null): PlayDepth | null {
  const depth = value === null ? Number.NaN : Number.parseInt(value, 10);
  return playDepthOptions.some((option) => option === depth) ? (depth as PlayDepth) : null;
}

function bindPlayEvents(
  root: HTMLElement,
  state: PlayUiState,
  actions: {
    readonly newGame: () => void;
    readonly resignGame: (actor: "user" | "rival") => void;
    readonly saveGameArchive: () => void;
    readonly copyGameArchiveJson: () => void;
    readonly downloadGameArchivePgn: () => void;
    readonly rematchGame: () => void;
    readonly selectSquare: (square: BoardSquare) => void;
    readonly dragMove: (from: BoardSquare, to: BoardSquare) => void;
    readonly reviewGame: () => void;
    readonly copyTerminalPgn: () => void;
    readonly copyCurrentFen: () => void;
    readonly copyAnalyzeCommand: () => void;
    readonly choosePromotion: (move: string) => void;
    readonly choosePlayerSide: (side: PlayerSide) => void;
    readonly chooseEngineDepth: (depth: PlayDepth) => void;
    readonly toggleAggressive: () => void;
    readonly undoMove: () => void;
    readonly choosePlayMode: (mode: PlayMode) => void;
    readonly chooseReactionView: (view: ReactionLensView) => void;
    readonly chooseReactionDepth: (depth: ReactionLensDepth) => void;
    readonly loadPosition: (fen: string) => void;
    readonly onFenInput: (value: string) => void;
    readonly setupClickSquare: (square: BoardSquare) => void;
    readonly setupMovePiece: (from: BoardSquare, to: BoardSquare) => void;
    readonly setupPlacePiece: (piece: SetupPiece, to: BoardSquare) => void;
    readonly setupSelectCursor: (piece: SetupPiece | null) => void;
    readonly setupToggleSide: () => void;
    readonly setupClear: () => void;
    readonly setupAnalyze: () => void;
    readonly toggleLocale: () => void;
  }
): void {
  root
    .querySelector('[data-play-ui="new-game-button"]')
    ?.addEventListener("click", actions.newGame);
  root
    .querySelector('[data-play-ui="locale-toggle"]')
    ?.addEventListener("click", actions.toggleLocale);
  for (const button of Array.from(root.querySelectorAll('[data-play-ui="resign-button"]'))) {
    button.addEventListener("click", () => {
      const actor = button.getAttribute("data-resign-actor");
      if (actor === "user" || actor === "rival") {
        actions.resignGame(actor);
      }
    });
  }
  root
    .querySelector('[data-play-ui="archive-save-button"]')
    ?.addEventListener("click", actions.saveGameArchive);
  root
    .querySelector('[data-play-ui="archive-pgn-button"]')
    ?.addEventListener("click", actions.downloadGameArchivePgn);
  root
    .querySelector('[data-play-ui="analyze-command-button"]')
    ?.addEventListener("click", actions.copyAnalyzeCommand);
  root
    .querySelector('[data-play-ui="rematch-button"]')
    ?.addEventListener("click", actions.rematchGame);
  type ActiveBoardDrag = {
    readonly from: BoardSquare;
    readonly source: HTMLElement;
    readonly identifier: number | null;
    readonly startX: number;
    readonly startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    follower: HTMLElement | null;
  };
  let activeDrag: ActiveBoardDrag | null = null;
  let suppressClick = false;
  const dragThreshold = 5;
  const cssPx = (value: number): string => `${value.toFixed(2)}px`;
  const clearDragging = (): void => {
    for (const element of Array.from(root.querySelectorAll('[data-board-dragging="true"]'))) {
      element.removeAttribute("data-board-dragging");
      element.removeAttribute("data-board-drag-active");
    }
  };
  const suppressNextClick = (): void => {
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 0);
  };
  const removeDragFollower = (drag: ActiveBoardDrag): void => {
    drag.follower?.remove();
    drag.follower = null;
    drag.source.removeAttribute("data-board-drag-active");
    drag.source.removeAttribute("data-board-dragging");
  };
  const updateDragFollower = (drag: ActiveBoardDrag, clientX: number, clientY: number): void => {
    const rect = drag.source.getBoundingClientRect();
    if (drag.follower === null) {
      const piece = drag.source.querySelector(':scope > [data-play-ui="board-piece"]');
      if (!isRenderableElement(piece)) {
        return;
      }
      const follower = document.createElement("span");
      follower.setAttribute("data-play-ui", "board-drag-piece");
      follower.setAttribute("data-board-drag-from", drag.from);
      const color = drag.source.getAttribute("data-board-piece-color");
      const kind = drag.source.getAttribute("data-board-piece-kind");
      if (color !== null) {
        follower.setAttribute("data-board-piece-color", color);
      }
      if (kind !== null) {
        follower.setAttribute("data-board-piece-kind", kind);
      }
      follower.style.inlineSize = cssPx(rect.width);
      follower.style.blockSize = cssPx(rect.height);
      follower.innerHTML = `<span data-play-ui="board-piece" aria-hidden="true">${piece.innerHTML}</span>`;
      root.append(follower);
      drag.follower = follower;
      drag.source.setAttribute("data-board-drag-active", "true");
    }
    drag.follower.style.left = cssPx(clientX - rect.width / 2);
    drag.follower.style.top = cssPx(clientY - rect.height / 2);
  };
  const beginBoardDrag = (
    source: HTMLElement,
    from: BoardSquare,
    clientX: number,
    clientY: number,
    identifier: number | null
  ): void => {
    activeDrag = {
      from,
      source,
      identifier,
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
      moved: false,
      follower: null
    };
    source.setAttribute("data-board-dragging", "true");
  };
  const moveBoardDrag = (clientX: number, clientY: number): boolean => {
    const drag = activeDrag;
    if (drag === null) {
      return false;
    }
    drag.lastX = clientX;
    drag.lastY = clientY;
    const distance = Math.hypot(clientX - drag.startX, clientY - drag.startY);
    if (distance < dragThreshold && !drag.moved) {
      return false;
    }
    drag.moved = true;
    updateDragFollower(drag, clientX, clientY);
    return true;
  };
  const finishBoardDrag = (clientX: number, clientY: number): void => {
    const drag = activeDrag;
    activeDrag = null;
    if (drag === null) {
      return;
    }
    const moved = drag.moved;
    removeDragFollower(drag);
    clearDragging();
    if (!moved) {
      return;
    }
    suppressNextClick();
    const to = boardSquareAtPoint(clientX, clientY);
    if (to !== null) {
      if (state.playMode === "setup") {
        actions.setupMovePiece(drag.from, to);
      } else {
        actions.dragMove(drag.from, to);
      }
    }
  };
  for (const square of Array.from(root.querySelectorAll('[data-play-ui="board-square"]'))) {
    if (!isElementWithListeners(square)) {
      continue;
    }
    const value = square.getAttribute("data-square");
    if (value !== null && isBoardSquare(value)) {
      square.addEventListener("click", (event) => {
        if (suppressClick) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (state.playMode === "setup") {
          actions.setupClickSquare(value);
        } else {
          actions.selectSquare(value);
        }
      });
      square.addEventListener("keydown", (event) => {
        if (!(event instanceof KeyboardEvent)) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (state.playMode === "setup") {
            actions.setupClickSquare(value);
          } else {
            actions.selectSquare(value);
          }
          return;
        }
        const orientation =
          root
            .querySelector('[data-play-ui="board"]')
            ?.getAttribute("data-board-orientation") === "black"
            ? "black"
            : "white";
        const fileIndex = value.charCodeAt(0) - "a".charCodeAt(0);
        const rank = Number(value[1]);
        let nextFileIndex = fileIndex;
        let nextRank = rank;
        switch (event.key) {
          case "ArrowLeft":
            nextFileIndex += orientation === "black" ? 1 : -1;
            break;
          case "ArrowRight":
            nextFileIndex += orientation === "black" ? -1 : 1;
            break;
          case "ArrowUp":
            nextRank += orientation === "black" ? -1 : 1;
            break;
          case "ArrowDown":
            nextRank += orientation === "black" ? 1 : -1;
            break;
          default:
            return;
        }
        if (nextFileIndex < 0 || nextFileIndex > 7 || nextRank < 1 || nextRank > 8) {
          return;
        }
        const nextSquare = `${String.fromCharCode("a".charCodeAt(0) + nextFileIndex)}${String(nextRank)}`;
        if (!isBoardSquare(nextSquare)) {
          return;
        }
        const target = root.querySelector(
          `[data-play-ui="board-square"][data-square="${nextSquare}"]`
        ) as unknown as { readonly focus?: unknown } | null;
        if (typeof target?.focus !== "function") {
          return;
        }
        event.preventDefault();
        (target.focus as () => void)();
      });
      square.addEventListener("dragstart", (event) => {
        event.preventDefault();
      });
      square.addEventListener("mousedown", (event) => {
        if (!isPrimaryMouseEvent(event) || square.getAttribute("data-board-draggable") !== "true") {
          return;
        }
        beginBoardDrag(square, value, event.clientX, event.clientY, null);
        const moveListener = (moveEvent: MouseEvent): void => {
          if (moveBoardDrag(moveEvent.clientX, moveEvent.clientY)) {
            moveEvent.preventDefault();
          }
        };
        const upListener = (upEvent: MouseEvent): void => {
          document.removeEventListener("mousemove", moveListener);
          document.removeEventListener("mouseup", upListener);
          finishBoardDrag(upEvent.clientX, upEvent.clientY);
        };
        document.addEventListener("mousemove", moveListener);
        document.addEventListener("mouseup", upListener);
      });
      square.addEventListener("touchstart", (event) => {
        if (!isTouchEvent(event) || square.getAttribute("data-board-draggable") !== "true") {
          return;
        }
        const touch = event.changedTouches.item(0);
        if (touch === null) {
          return;
        }
        beginBoardDrag(square, value, touch.clientX, touch.clientY, touch.identifier);
      });
      square.addEventListener(
        "touchmove",
        (event) => {
          const drag = activeDrag;
          if (!isTouchEvent(event) || drag === null || drag.identifier === null) {
            return;
          }
          const touch = touchByIdentifier(event.touches, drag.identifier);
          if (touch === null) {
            return;
          }
          if (moveBoardDrag(touch.clientX, touch.clientY)) {
            event.preventDefault();
          }
        },
        { passive: false }
      );
      square.addEventListener("touchend", (event) => {
        const drag = activeDrag;
        if (!isTouchEvent(event) || drag === null || drag.identifier === null) {
          return;
        }
        const touch = touchByIdentifier(event.changedTouches, drag.identifier);
        if (touch === null) {
          finishBoardDrag(drag.lastX, drag.lastY);
          return;
        }
        if (drag.moved) {
          event.preventDefault();
        }
        finishBoardDrag(touch.clientX, touch.clientY);
      });
      square.addEventListener("touchcancel", (event) => {
        if (!isTouchEvent(event) || activeDrag === null) {
          return;
        }
        removeDragFollower(activeDrag);
        activeDrag = null;
        clearDragging();
      });
    }
  }
  const focusBoardMove = (move: string): void => {
    const from = move.slice(0, 2);
    if (!isBoardSquare(from)) {
      return;
    }
    const target = root.querySelector(`[data-play-ui="board-square"][data-square="${from}"]`);
    if (target === null || !isElementWithListeners(target)) {
      return;
    }
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
    }
    target.focus();
    if (state.sideExplore.result?.onTurn === true) {
      actions.selectSquare(from);
    }
  };
  const recommendationBridge = root.querySelector('[data-play-ui="recommendation-bridge"]');
  if (recommendationBridge !== null && isElementWithListeners(recommendationBridge)) {
    const move = recommendationBridge.getAttribute("data-recommendation-move");
    if (move !== null) {
      recommendationBridge.addEventListener("click", () => {
        focusBoardMove(move);
      });
    }
  }
  for (const alternative of Array.from(root.querySelectorAll('[data-play-ui="alternative-item"]'))) {
    if (!isElementWithListeners(alternative)) {
      continue;
    }
    const move = alternative.getAttribute("data-alternative-move");
    if (move !== null) {
      alternative.addEventListener("click", () => {
        focusBoardMove(move);
      });
    }
  }
  root
    .querySelector('[data-play-ui="post-game-review-button"]')
    ?.addEventListener("click", actions.reviewGame);
  root
    .querySelector('[data-play-ui="terminal-copy-pgn-button"]')
    ?.addEventListener("click", actions.copyTerminalPgn);
  root
    .querySelector('[data-play-ui="current-fen-copy-button"]')
    ?.addEventListener("click", actions.copyCurrentFen);
  for (const button of Array.from(root.querySelectorAll('[data-play-ui="promotion-button"]'))) {
    const move = button.getAttribute("data-promotion-move");
    if (move !== null) {
      button.addEventListener("click", () => {
        actions.choosePromotion(move);
      });
    }
  }
  for (const button of Array.from(root.querySelectorAll('[data-play-ui="player-side-button"]'))) {
    const side = button.getAttribute("data-player-side");
    if (isPlayerSide(side)) {
      button.addEventListener("click", () => {
        actions.choosePlayerSide(side);
      });
    }
  }
  for (const button of Array.from(root.querySelectorAll('[data-play-ui="engine-depth-button"]'))) {
    const depth = parsePlayDepth(button.getAttribute("data-engine-depth"));
    if (depth !== null) {
      button.addEventListener("click", () => {
        actions.chooseEngineDepth(depth);
      });
    }
  }
  root
    .querySelector('[data-play-ui="aggressive-toggle-button"]')
    ?.addEventListener("click", actions.toggleAggressive);
  root.querySelector('[data-play-ui="undo-button"]')?.addEventListener("click", actions.undoMove);
  for (const button of Array.from(root.querySelectorAll('[data-play-ui="play-mode-button"]'))) {
    const mode = button.getAttribute("data-play-mode");
    if (isPlayMode(mode)) {
      button.addEventListener("click", () => {
        actions.choosePlayMode(mode);
      });
    }
  }
  for (const button of Array.from(root.querySelectorAll('[data-play-ui="reaction-view-button"]'))) {
    const view = button.getAttribute("data-reaction-view");
    if (isReactionLensView(view)) {
      button.addEventListener("click", () => {
        actions.chooseReactionView(view);
      });
    }
  }
  for (const button of Array.from(root.querySelectorAll('[data-play-ui="reaction-depth-button"]'))) {
    const depth = button.getAttribute("data-reaction-depth");
    if (isReactionLensDepth(depth)) {
      button.addEventListener("click", () => {
        actions.chooseReactionDepth(depth);
      });
    }
  }
  const fenInput = root.querySelector('[data-play-ui="load-position-input"]');
  if (isInputElement(fenInput)) {
    fenInput.addEventListener("input", () => {
      actions.onFenInput(fenInput.value);
    });
  }
  root.querySelector('[data-play-ui="load-position-button"]')?.addEventListener("click", () => {
    const input = root.querySelector('[data-play-ui="load-position-input"]');
    if (isInputElement(input) && input.value.trim().length > 0) {
      actions.loadPosition(input.value.trim());
    }
  });
  for (const button of Array.from(root.querySelectorAll('[data-play-ui="setup-palette-piece"]'))) {
    const color = button.getAttribute("data-piece-color");
    const kind = button.getAttribute("data-piece-kind");
    if (!isSetupPieceColor(color) || !isSetupPieceKind(kind) || !isElementWithListeners(button)) {
      continue;
    }
    const piece: SetupPiece = { color, kind };
    button.addEventListener("click", () => {
      actions.setupSelectCursor(piece);
    });
    const beginPaletteDrag = (clientX: number, clientY: number, identifier: number | null): void => {
      beginSetupPaletteDrag(piece, button, clientX, clientY, identifier);
    };
    button.addEventListener("mousedown", (event) => {
      if (!isPrimaryMouseEvent(event)) return;
      beginPaletteDrag(event.clientX, event.clientY, null);
      const moveListener = (moveEvent: MouseEvent): void => {
        if (moveBoardDrag(moveEvent.clientX, moveEvent.clientY)) moveEvent.preventDefault();
      };
      const upListener = (upEvent: MouseEvent): void => {
        document.removeEventListener("mousemove", moveListener);
        document.removeEventListener("mouseup", upListener);
        finishPaletteDrag(upEvent.clientX, upEvent.clientY);
      };
      document.addEventListener("mousemove", moveListener);
      document.addEventListener("mouseup", upListener);
    });
    button.addEventListener("touchstart", (event) => {
      if (!isTouchEvent(event)) return;
      const touch = event.changedTouches.item(0);
      if (touch === null) return;
      beginPaletteDrag(touch.clientX, touch.clientY, touch.identifier);
    });
    button.addEventListener("touchmove", (event) => {
      if (!isTouchEvent(event) || activePaletteDrag === null || activePaletteDrag.identifier === null) return;
      const touch = touchByIdentifier(event.touches, activePaletteDrag.identifier);
      if (touch === null) return;
      if (movePaletteDrag(touch.clientX, touch.clientY)) event.preventDefault();
    }, { passive: false });
    button.addEventListener("touchend", (event) => {
      if (!isTouchEvent(event) || activePaletteDrag === null || activePaletteDrag.identifier === null) return;
      const touch = touchByIdentifier(event.changedTouches, activePaletteDrag.identifier);
      if (touch === null) {
        finishPaletteDrag(activePaletteDrag.lastX, activePaletteDrag.lastY);
        return;
      }
      finishPaletteDrag(touch.clientX, touch.clientY);
    });
  }

  type ActivePaletteDrag = {
    readonly piece: SetupPiece;
    readonly source: HTMLElement;
    readonly identifier: number | null;
    readonly startX: number;
    readonly startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    follower: HTMLElement | null;
  };
  let activePaletteDrag: ActivePaletteDrag | null = null;
  const beginSetupPaletteDrag = (
    piece: SetupPiece,
    source: HTMLElement,
    clientX: number,
    clientY: number,
    identifier: number | null
  ): void => {
    activePaletteDrag = {
      piece,
      source,
      identifier,
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
      moved: false,
      follower: null
    };
  };
  const movePaletteDrag = (clientX: number, clientY: number): boolean => {
    const drag = activePaletteDrag;
    if (drag === null) return false;
    drag.lastX = clientX;
    drag.lastY = clientY;
    const distance = Math.hypot(clientX - drag.startX, clientY - drag.startY);
    if (distance < dragThreshold && !drag.moved) return false;
    drag.moved = true;
    const rect = drag.source.getBoundingClientRect();
    if (drag.follower === null) {
      const follower = document.createElement("span");
      follower.setAttribute("data-play-ui", "board-drag-piece");
      follower.setAttribute("data-board-piece-color", drag.piece.color);
      follower.setAttribute("data-board-piece-kind", drag.piece.kind);
      follower.style.inlineSize = cssPx(rect.width);
      follower.style.blockSize = cssPx(rect.height);
      follower.innerHTML = drag.source.innerHTML;
      root.append(follower);
      drag.follower = follower;
    }
    drag.follower.style.left = cssPx(clientX - rect.width / 2);
    drag.follower.style.top = cssPx(clientY - rect.height / 2);
    return true;
  };
  const finishPaletteDrag = (clientX: number, clientY: number): void => {
    const drag = activePaletteDrag;
    activePaletteDrag = null;
    if (drag === null) return;
    const moved = drag.moved;
    drag.follower?.remove();
    if (!moved) return;
    suppressNextClick();
    const to = boardSquareAtPoint(clientX, clientY);
    if (to !== null) {
      actions.setupPlacePiece(drag.piece, to);
    }
  };
  root.querySelector('[data-play-ui="setup-toggle-side"]')?.addEventListener("click", actions.setupToggleSide);
  root.querySelector('[data-play-ui="setup-clear"]')?.addEventListener("click", actions.setupClear);
  root.querySelector('[data-play-ui="setup-analyze"]')?.addEventListener("click", actions.setupAnalyze);
  const busyRoot = root.querySelector('[data-play-ui="root"]') ?? root;
  if (state.status === "loading") {
    busyRoot.setAttribute("aria-busy", "true");
  } else {
    busyRoot.removeAttribute("aria-busy");
  }
}

function isTouchEvent(event: Event): event is TouchEvent {
  return typeof TouchEvent !== "undefined" && event instanceof TouchEvent;
}

function touchByIdentifier(touches: TouchList, identifier: number): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch?.identifier === identifier) {
      return touch;
    }
  }
  return null;
}

function boardSquareAtPoint(clientX: number, clientY: number): BoardSquare | null {
  const element = document.elementFromPoint(clientX, clientY);
  const square =
    element instanceof Element ? element.closest('[data-play-ui="board-square"]') : null;
  const value = square?.getAttribute("data-square") ?? null;
  return value !== null && isBoardSquare(value) ? value : null;
}

function renderPlayUi(
  state: PlayUiState,
  copy: ReturnType<typeof copyFor>,
  autoOpenSecondaryDrawer = false
): string {
  const heading = state.playMode === "reaction-lens" ? copy.explore : copy.play;
  const surfaceCopy = copy.exploreSurface;
  return localizeVisibleMarkup([
    `<section data-play-ui="root" data-play-mode="${state.playMode}" data-play-surface="board-first" data-engine-mode="${state.engineMode}" aria-labelledby="play-title">`,
    `<header data-play-ui="header">`,
    `<div data-play-ui="header-brand">`,
    `<span data-play-ui="brand-mark" aria-hidden="true">♞</span>`,
    `<h1 id="play-title" data-play-ui="title">${heading}</h1>`,
    `<p data-play-ui="mode-label">${escapeHtml(engineModeLabel(
      state.engineMode,
      state.playMode === "reaction-lens" ? surfaceCopy.engine : "Engine: Owned local",
      copy.locale
    ))}</p>`,
    `</div>`,
    `<div data-play-ui="header-actions">`,
    renderPlayerSideControl(state, copy),
    renderAggressiveButton(state.aggressive, canChangeEngineDepth(state) ? "" : " disabled", copy),
    renderMoreMenu(state, copy),
    `</div>`,
    `</header>`,
    `<div data-play-ui="layout">`,
    renderBoardPanel(state, copy),
    renderSidePanel(state, copy, autoOpenSecondaryDrawer),
    `</div>`,
    `</section>`
  ].join(""), copy.locale);
}

function renderPlayControls(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  const modeDisabled = canChangePlayMode(state) ? "" : " disabled";
  return [
    `<div data-play-ui="controls" aria-label="${copy.settings}">`,
    `<fieldset data-play-ui="play-mode-control">`,
    `<legend>${copy.mode}</legend>`,
    (["reaction-lens", "setup", "opponent", "spectator-lens"] as const)
      .map((mode) => renderPlayModeButton(mode, state.playMode, modeDisabled, copy))
      .join(""),
    `</fieldset>`,
    `</div>`
  ].join("");
}

function renderPlayerSideControl(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  const sideDisabled = canChangePlayerSide(state) ? "" : " disabled";
  const sideLabel = state.playMode === "reaction-lens" ? copy.exploreSurface.player : copy.side;
  return [
    `<fieldset data-play-ui="player-side-control">`,
    `<legend>${escapeHtml(sideLabel)}</legend>`,
    renderPlayerSideButton("white", state.playerSide, sideDisabled, copy),
    renderPlayerSideButton("black", state.playerSide, sideDisabled, copy),
    `</fieldset>`
  ].join("");
}

function renderEngineDepthControl(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  const depthDisabled = canChangeEngineDepth(state) ? "" : " disabled";
  const depthLabel = state.playMode === "reaction-lens" ? copy.exploreSurface.engineDepth : copy.depth;
  return [
    `<fieldset data-play-ui="engine-depth-control">`,
    `<legend>${escapeHtml(depthLabel)}</legend>`,
    playDepthOptions
      .map((depth) => renderEngineDepthButton(depth, state.engineDepth, depthDisabled, depthLabel))
      .join(""),
    `</fieldset>`
  ].join("");
}

// The "⋯" menu holds everything that is not needed move to move: depth, modes, language and the
// rival's resignation (the player's own resignation sits under the board).
function renderMoreMenu(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  return [
    `<details data-play-ui="more-menu">`,
    `<summary data-play-ui="more-menu-summary" aria-label="${escapeHtml(copy.exploreSurface.sessionControl)}"><span aria-hidden="true">⋯</span></summary>`,
    `<div data-play-ui="more-menu-panel">`,
    renderEngineDepthControl(state, copy),
    renderPlayControls(state, copy),
    `<div data-play-ui="more-menu-actions">`,
    `<button type="button" data-play-ui="locale-toggle" aria-label="${copy.language}">${copy.language}</button>`,
    canResign(state) ? renderResignButton(state, "rival", copy) : "",
    `</div>`,
    `</div>`,
    `</details>`
  ].join("");
}

// The "⋯" menu is a disclosure that also closes on an outside click or Escape, like a popover.
function closeMoreMenuOnOutsideClick(root: HTMLElement): void {
  const ownerDocument = (root as unknown as { readonly ownerDocument?: Document }).ownerDocument;
  if (ownerDocument === undefined || typeof ownerDocument.addEventListener !== "function") {
    return;
  }
  const close = (): void => {
    const menu = root.querySelector<HTMLDetailsElement>('details[data-play-ui="more-menu"]');
    if (menu !== null && menu.open) {
      menu.open = false;
    }
  };
  ownerDocument.addEventListener("click", (event) => {
    const menu = root.querySelector('details[data-play-ui="more-menu"]');
    if (menu !== null && !menu.contains(event.target as Node)) {
      close();
    }
  });
  ownerDocument.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    }
  });
}

function renderResignButton(state: PlayUiState, actor: "user" | "rival", copy: ReturnType<typeof copyFor>): string {
  const side = resignationSide(state, actor);
  const label = actor === "user" ? copy.resign : resignationActionLabel(state, actor, copy);
  return `<button type="button" data-play-ui="resign-button" data-resign-actor="${actor}" data-resign-side="${side}" aria-label="${escapeHtml(
    resignationActionLabel(state, actor, copy)
  )}">${escapeHtml(label)}</button>`;
}

function renderAggressiveButton(aggressive: boolean, disabled: string, copy: ReturnType<typeof copyFor>): string {
  return `<button type="button" data-play-ui="aggressive-toggle-button" aria-pressed="${String(
    aggressive
  )}"${disabled}>${copy.aggressive}: ${aggressive ? copy.exploreSurface.on : copy.exploreSurface.off}</button>`;
}

function playModeLabel(mode: PlayMode, copy: ReturnType<typeof copyFor>): string {
  switch (mode) {
    case "opponent":
      return copy.opponent;
    case "spectator-lens":
      return copy.spectator;
    case "reaction-lens":
      return copy.explore;
    case "setup":
      return copy.setup;
  }
}

function renderPlayModeButton(mode: PlayMode, currentMode: PlayMode, disabled: string, copy: ReturnType<typeof copyFor>): string {
  return `<button type="button" data-play-ui="play-mode-button" data-play-mode="${mode}" aria-pressed="${String(
    mode === currentMode
  )}"${disabled}>${playModeLabel(mode, copy)}</button>`;
}

function renderPlayerSideButton(
  side: PlayerSide,
  currentSide: PlayerSide,
  disabled: string,
  copy: ReturnType<typeof copyFor>
): string {
  return `<button type="button" data-play-ui="player-side-button" data-player-side="${side}" aria-pressed="${String(
    side === currentSide
  )}"${disabled}>${side === "white" ? copy.white : copy.black}</button>`;
}

function renderEngineDepthButton(
  depth: PlayDepth,
  currentDepth: number,
  disabled: string,
  label: string
): string {
  return `<button type="button" data-play-ui="engine-depth-button" data-engine-depth="${String(
    depth
  )}" aria-label="${escapeHtml(`${label} ${String(depth)}`)}" aria-pressed="${String(
    depth === currentDepth
  )}"${disabled}>${String(depth)}</button>`;
}

function engineModeLabel(mode: PlayEngineMode, classicalLabel: string, locale: UiLocale): string {
  if (locale === "en") {
    switch (mode) {
      case "owned-local":
        return "Engine: Owned local";
      case "local-stockfish":
        return "Engine: Local Stockfish";
      case "owned-local-stockfish-unavailable":
        return "Engine: Owned local (Stockfish unavailable)";
    }
  }
  switch (mode) {
    case "owned-local":
      return classicalLabel;
    case "local-stockfish":
      return "Engine: Local Stockfish";
    case "owned-local-stockfish-unavailable":
      return "Engine: Owned local (Stockfish unavailable)";
  }
}

function renderBoardPanel(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  const surfaceCopy = copy.exploreSurface;
  const boardLabels = playBoardLabels(surfaceCopy);
  return [
    `<section data-play-ui="board-panel" aria-label="${escapeHtml(surfaceCopy.board)}">`,
    `<div data-play-ui="board-stage">`,
    renderEvalBar(state, copy),
    state.setup !== null
      ? renderPlayBoard({
          engineState: buildSetupEngineState(state.setup),
          selectedSquare: state.setup.cursorSource,
          lastMove: null,
          acceptsInput: canAcceptBoardInput(state),
          playerSide: state.playerSide,
          inputSide: state.setup.sideToMove,
          activeMotion: null,
          freeInput: true,
          labels: boardLabels
        })
      : renderPlayBoard({
          engineState: state.engineState,
          selectedSquare: state.selectedSquare,
          lastMove: state.lastMove,
          acceptsInput: canAcceptBoardInput(state),
          playerSide: state.playerSide,
          inputSide: playInputSide(state),
          activeMotion: state.activeBoardMotion,
          reactionLine: reactionLensBoardLine(state),
          reactionPrimaryHanging: reactionLensPrimaryHangs(),
          reactionPrimaryMating: reactionLensPrimaryMating(state),
          reactionPrimaryOpening: reactionLensPrimaryOpening(state),
          reactionPrimaryReply: reactionLensPrimaryReply(state),
          replyArrows: reactionLensReplyArrows(state),
          lensLine: lensBoardLine(state),
          candidateArrows: reactionLensCandidateArrows(state),
          labels: boardLabels
        }),
    `</div>`,
    renderPromotionChoice(state, copy),
    renderBoardActions(state, copy),
    `</section>`
  ].join("");
}

function renderBoardActions(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  return [
    `<div data-play-ui="board-actions" role="group" aria-label="${escapeHtml(copy.settings)}">`,
    canUndoMove(state) ? `<button type="button" data-play-ui="undo-button">${copy.undo}</button>` : "",
    `<button type="button" data-play-ui="new-game-button">${copy.newGame}</button>`,
    canResign(state) ? renderResignButton(state, "user", copy) : "",
    `</div>`
  ].join("");
}

type EvalBarModel = {
  readonly whiteShare: number;
  readonly label: string;
  readonly leader: ColorDto | null;
};

// White's share of the bar from the engine's top candidate, which is signed from the explored side.
// A logistic curve keeps small edges visible and saturates near ±6 pawns.
function evalBarModel(state: PlayUiState): EvalBarModel | null {
  const result = state.sideExplore.status === "ready" ? state.sideExplore.result : null;
  const top = result?.candidates[0];
  if (result === null || top === undefined) {
    return null;
  }
  const sign = result.side === "white" ? 1 : -1;
  if (top.mateIn !== null) {
    const leader: ColorDto = sign > 0 ? "white" : "black";
    return { whiteShare: leader === "white" ? 1 : 0, label: `M${String(top.mateIn)}`, leader };
  }
  const whiteCp = top.exactScoreCp * sign;
  const pawns = Math.abs(whiteCp) / 100;
  return {
    whiteShare: 1 / (1 + Math.exp(-whiteCp / 250)),
    label: `${whiteCp >= 0 ? "+" : "−"}${pawns.toFixed(pawns >= 10 ? 0 : 1)}`,
    leader: whiteCp === 0 ? null : whiteCp > 0 ? "white" : "black"
  };
}

function renderEvalBar(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  if (state.playMode !== "reaction-lens") {
    return "";
  }
  const model = evalBarModel(state);
  const surfaceCopy = copy.exploreSurface;
  if (model === null) {
    return `<div data-play-ui="eval-bar" data-eval-state="pending" data-eval-orientation="${state.playerSide}" role="img" aria-label="${escapeHtml(surfaceCopy.evaluation)}: ${escapeHtml(surfaceCopy.calculating)}"><span data-play-ui="eval-bar-fill"></span><span data-play-ui="eval-bar-label"></span></div>`;
  }
  const leaderLabel = model.leader === null ? "=" : exploreColorLabel(model.leader, surfaceCopy);
  return `<div data-play-ui="eval-bar" data-eval-state="ready" data-eval-orientation="${state.playerSide}" data-eval-white="${model.whiteShare.toFixed(3)}" data-eval-leader="${model.leader ?? "even"}" role="img" aria-label="${escapeHtml(`${surfaceCopy.evaluation}: ${model.label} (${leaderLabel})`)}"><span data-play-ui="eval-bar-fill"></span><span data-play-ui="eval-bar-label">${escapeHtml(model.label)}</span></div>`;
}

function renderBoardStatus(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  const owner = statusOwner(state);
  const side = statusSide(state);
  const sideAttribute = side === null ? "" : ` data-play-status-side="${side}"`;
  return `<output data-play-ui="status" data-play-status-owner="${owner}"${sideAttribute} aria-live="polite">${escapeHtml(
    statusLabel(state, copy)
  )}</output>`;
}

function playBoardLabels(
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): PlayBoardLabels {
  return {
    board: surfaceCopy.boardAria,
    emptySquare: surfaceCopy.emptySquare,
    colors: { white: surfaceCopy.whitePiece, black: surfaceCopy.blackPiece },
    pieces: surfaceCopy.boardPieces
  };
}

function renderPromotionChoice(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  if (state.pendingPromotion === null) {
    return "";
  }
  return [
    `<section data-play-ui="promotion-choice" data-promotion-from="${
      state.pendingPromotion.from
    }" data-promotion-to="${state.pendingPromotion.to}" aria-label="${escapeHtml(copy.exploreSurface.promotion)}">`,
    state.pendingPromotion.choices
      .map(
        (choice) =>
          `<button type="button" data-play-ui="promotion-button" data-promotion-piece="${
            choice.piece
          }" data-promotion-move="${escapeHtml(choice.move)}"${
            canAcceptBoardInput(state) ? "" : " disabled"
          }>${escapeHtml(promotionPieceLabel(choice.piece, copy.exploreSurface))}</button>`
      )
      .join(""),
    `</section>`
  ].join("");
}

function renderSidePanel(
  state: PlayUiState,
  copy: ReturnType<typeof copyFor>,
  autoOpenSecondaryDrawer: boolean
): string {
  const exploreFirst = state.playMode === "reaction-lens";
  return [
    `<aside data-play-ui="side-panel">`,
    `<div data-play-ui="panel-status">`,
    renderBoardStatus(state, copy),
    exploreFirst ? renderExploreStatus(state, copy) : "",
    `</div>`,
    renderPlayError(state.error, copy),
    exploreFirst ? renderReactionLens(state, copy) : "",
    `<section data-play-ui="facts" aria-labelledby="facts-title"${exploreFirst ? " hidden" : ""}>`,
    `<h2 id="facts-title">Position</h2>`,
    `<dl>`,
    renderFact("player-side", isSpectatorMode(state.playMode) ? "View" : "Player", state.playerSide),
    renderFact("side-to-move", "Turn", state.engineState?.sideToMove ?? "loading"),
    renderFact("game-status", "Status", gameStatusFact(state)),
    renderSelectionAssist(state),
    renderFact("engine-depth", "Depth", String(state.engineDepth)),
    renderFact("last-engine-depth", "Last search", state.lastBestMove?.depth.toString() ?? "none"),
    renderLastMoveSummary(state.moves),
    `</dl>`,
    renderEngineThinking(state),
    `</section>`,
    renderSetupPanel(state),
    exploreFirst ? "" : renderLoadPosition(state),
    renderSpectatorLens(state),
    exploreFirst ? "" : renderReactionLens(state, copy),
    renderPositionTechnical(state, copy),
    renderSecondaryDrawer(state, copy, autoOpenSecondaryDrawer),
    `</aside>`
  ].join("");
}

function renderPositionTechnical(
  state: PlayUiState,
  copy: ReturnType<typeof copyFor>
): string {
  if (state.engineState === null) {
    return "";
  }
  const surfaceCopy = copy.exploreSurface;
  return [
    `<details data-play-ui="position-technical">`,
    `<summary data-play-ui="position-technical-summary">${escapeHtml(surfaceCopy.technicalPosition)}<span>${escapeHtml(surfaceCopy.fenCopy)}</span></summary>`,
    `<dl>`,
    renderCurrentFen(state.engineState),
    `</dl>`,
    renderCurrentFenCopy(state.engineState),
    `</details>`
  ].join("");
}

function renderSecondaryDrawer(
  state: PlayUiState,
  copy: ReturnType<typeof copyFor>,
  autoOpen = false
): string {
  const surfaceCopy = copy.exploreSurface;
  const title = surfaceCopy.moreTools;
  const detail = surfaceCopy.movesArchiveEvidence;
  const open = autoOpen ? " open" : "";
  return [
    `<details data-play-ui="secondary-drawer"${open}>`,
    `<summary data-play-ui="secondary-drawer-summary"><span>${title}</span><small>${detail}</small></summary>`,
    renderGameArchive(state),
    state.playMode === "reaction-lens" ? renderLoadPosition(state) : "",
    `<section data-play-ui="move-list" aria-labelledby="move-list-title">`,
    `<h2 id="move-list-title">${escapeHtml(surfaceCopy.moves)}</h2>`,
    renderMoveList(state.moves, copy),
    `</section>`,
    `<section data-play-ui="post-game" aria-labelledby="post-game-title">`,
    `<h2 id="post-game-title">${escapeHtml(state.completedGame === null ? surfaceCopy.postGameReview : surfaceCopy.gameComplete)}</h2>`,
    renderTerminalResult(state.completedGame),
    `<div data-play-ui="terminal-actions">`,
    state.completedGame === null
      ? ""
      : `<button type="button" data-play-ui="rematch-button" data-terminal-action="primary">${escapeHtml(surfaceCopy.rematch)}</button>`,
    `<button type="button" data-play-ui="post-game-review-button" data-terminal-action="secondary"${
      state.completedGame === null ? " disabled" : ""
    }>${escapeHtml(surfaceCopy.reviewGame)}</button>`,
    renderTerminalPgnCopy(state.completedGame),
    `</div>`,
    `</section>`,
    `</details>`
  ].join("");
}

function renderFact(name: string, label: string, value: string): string {
  return `<div data-play-ui="${name}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function renderEngineThinking(state: PlayUiState): string {
  if (
    state.status !== "thinking" ||
    isSpectatorMode(state.playMode) ||
    state.engineState === null ||
    state.engineState.status !== "ongoing" ||
    state.engineState.sideToMove === state.playerSide
  ) {
    return "";
  }
  return `<p data-play-ui="engine-thinking" aria-live="polite">Engine thinking… (level ${String(
    state.engineDepth
  )})</p>`;
}

function renderGameArchive(state: PlayUiState): string {
  const canSaveCompletedGame = state.moves.length >= minArchivedPlies || state.completedGame !== null;
  const saveDisabled = canSaveCompletedGame ? "" : " disabled";
  const pgnDisabled = state.gameArchive.savedCount > 0 ? "" : " disabled";
  const isSaved = state.gameArchive.status === "saved-local" || state.gameArchive.status === "saved-disk";
  const statusIcon = isSaved ? "✓" : state.gameArchive.status === "failed" ? "✗" : "○";
  const statusClass = isSaved ? "saved" : state.gameArchive.status === "failed" ? "failed" : "idle";
  return [
    `<section data-play-ui="game-archive" data-archive-status="${statusClass}" aria-labelledby="game-archive-title">`,
    `<h2 id="game-archive-title">Game archive</h2>`,
    `<div data-play-ui="archive-card">`,
    `<div data-play-ui="archive-status-line">`,
    `<span data-play-ui="archive-status-icon">${statusIcon}</span>`,
    `<span data-play-ui="archive-status-text">${archiveStatusLabel(state.gameArchive)}</span>`,
    `</div>`,
    isSaved && state.gameArchive.savedGameId !== null
      ? `<span data-play-ui="archive-game-id">${escapeHtml(state.gameArchive.savedGameId)}</span>`
      : "",
    `<div data-play-ui="archive-actions">`,
    `<button type="button" data-play-ui="archive-save-button"${saveDisabled}>${isSaved ? "✓ Save again" : "Save game"}</button>`,
    `<button type="button" data-play-ui="archive-pgn-button"${pgnDisabled}>PGN</button>`,
    isSaved && state.gameArchive.savedGameId !== null
      ? `<button type="button" data-play-ui="analyze-command-button" title="Copy just analyze command to clipboard">Analyze</button>`
      : "",
    `</div>`,
    `<small data-play-ui="archive-count">${String(state.gameArchive.savedCount)} saved</small>`,
    `</div>`,
    `</section>`
  ].join("");
}

function archiveStatusLabel(archive: PlayGameArchiveState): string {
  switch (archive.status) {
    case "saved-local":
      return "Saved";
    case "saved-disk":
      return "Saved to disk";
    case "degraded":
      return "⚠ Export required";
    case "skipped":
      return "Already saved";
    case "copied":
      return "Copied";
    case "downloaded":
      return "Downloaded";
    case "failed":
      return archive.error ?? "Error";
    case "idle":
    default:
      return "Not saved";
  }
}

function renderSetupPanel(state: PlayUiState): string {
  if (state.playMode !== "setup" || state.setup === null) {
    return "";
  }
  const setup = state.setup;
  const disabled = state.status === "loading" ? " disabled" : "";
  const pieceKinds: SetupPieceKind[] = ["queen", "rook", "bishop", "knight", "pawn", "king"];
  const colors: SetupPieceColor[] = ["white", "black"];
  return [
    `<section data-play-ui="setup-panel" aria-labelledby="setup-panel-title">`,
    `<h2 id="setup-panel-title">Setup board</h2>`,
    `<div data-play-ui="setup-palette">`,
    ...colors.map((color) =>
      [
        `<div data-play-ui="setup-palette-row" data-palette-color="${color}">`,
        ...pieceKinds.map((kind) => {
          const piece: SetupPiece = { color, kind };
          const isActive =
            setup.cursor !== null &&
            setup.cursor.color === color &&
            setup.cursor.kind === kind &&
            setup.cursorSource === null;
          return `<button type="button" data-play-ui="setup-palette-piece" data-piece-color="${color}" data-piece-kind="${kind}" aria-pressed="${String(isActive)}"${disabled}>${setupPieceGlyph(piece)}</button>`;
        }),
        `</div>`
      ].join("")
    ),
    `</div>`,
    `<div data-play-ui="setup-controls">`,
    `<button type="button" data-play-ui="setup-toggle-side"${disabled}>Turn: ${capitalizeColor(setup.sideToMove)}</button>`,
    `<button type="button" data-play-ui="setup-clear"${disabled}>Clear</button>`,
    `<button type="button" data-play-ui="setup-analyze"${disabled}>Analyze →</button>`,
    `</div>`,
    `</section>`
  ].join("");
}

function setupPieceGlyph(piece: SetupPiece): string {
  const glyphs: Record<SetupPieceKind, [string, string]> = {
    king: ["♔", "♚"],
    queen: ["♕", "♛"],
    rook: ["♖", "♜"],
    bishop: ["♗", "♝"],
    knight: ["♘", "♞"],
    pawn: ["♙", "♟"]
  };
  const [white, black] = glyphs[piece.kind];
  return piece.color === "white" ? white : black;
}

function renderLoadPosition(state: PlayUiState): string {
  if (!isSpectatorMode(state.playMode)) {
    return "";
  }
  const disabled = state.status === "loading" || state.status === "thinking" ? " disabled" : "";
  return [
    `<details data-play-ui="load-position">`,
    `<summary data-play-ui="load-position-summary"><span>Load position</span><small>FEN</small></summary>`,
    `<div data-play-ui="load-position-content">`,
    `<input type="text" data-play-ui="load-position-input" placeholder="Paste FEN…" aria-label="FEN string" value="${escapeHtml(state.fenInputValue)}"${disabled}>`,
    `<button type="button" data-play-ui="load-position-button"${disabled}>Load</button>`,
    `</div>`,
    `</details>`
  ].join("");
}

function renderSpectatorLens(state: PlayUiState): string {
  if (state.playMode !== "spectator-lens") {
    return "";
  }
  const activeSide = state.engineState?.sideToMove ?? null;
  const best = state.lens.bestMove;
  return [
    `<section data-play-ui="analysis-lens" data-lens-status="${state.lens.status}" aria-labelledby="analysis-lens-title">`,
    `<h2 id="analysis-lens-title">Lens</h2>`,
    `<dl>`,
    renderFact("lens-mode", "Mode", "Spectator"),
    renderFact("lens-input", "Input", "Both sides"),
    renderFact("lens-turn", "Turn", activeSide === null ? "loading" : capitalizeColor(activeSide)),
    renderFact("lens-legal-count", "Legal moves", String(state.lens.legalMoveCount)),
    renderFact("lens-best-move", "Best move", lensBestMoveLabel(state.lens)),
    renderFact("lens-score", "Score", best === null ? lensUnavailableLabel(state.lens) : formatScoreCp(best.scoreCp)),
    renderFact("lens-depth", "Depth", best === null ? "none" : String(best.depth)),
    renderFact("lens-nodes", "Nodes", best === null ? "none" : String(best.nodes)),
    `</dl>`,
    `</section>`
  ].join("");
}

function lensBestMoveLabel(lens: PlayLensState): string {
  if (lens.status === "pending") {
    return "searching";
  }
  if (lens.status === "failed") {
    return "unavailable";
  }
  return lens.bestMove?.bestMove ?? "none";
}

function lensUnavailableLabel(lens: PlayLensState): string {
  if (lens.status === "pending") {
    return "searching";
  }
  if (lens.status === "failed") {
    return lens.error === null ? "unavailable" : errorLabel(lens.error);
  }
  return "none";
}

function formatScoreCp(scoreCp: number): string {
  if (scoreCp === 0) {
    return "0 cp";
  }
  return `${scoreCp > 0 ? "+" : ""}${String(scoreCp)} cp`;
}

function renderReactionLens(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  if (state.playMode !== "reaction-lens") {
    return "";
  }
  return state.reactionLensView === "forcing"
    ? renderForcingLens(state, copy)
    : renderReactionMapLens(state, copy);
}

function renderReactionViewToggle(view: ReactionLensView, copy: ReturnType<typeof copyFor>): string {
  const surfaceCopy = copy.exploreSurface;
  return [
    `<fieldset data-play-ui="reaction-view-control">`,
    `<legend>${escapeHtml(surfaceCopy.view)}</legend>`,
    renderReactionViewButton("reaction", surfaceCopy.reactionMap, view),
    renderReactionViewButton("forcing", surfaceCopy.forcing, view),
    `</fieldset>`
  ].join("");
}

function renderReactionViewButton(
  view: ReactionLensView,
  label: string,
  currentView: ReactionLensView
): string {
  return `<button type="button" data-play-ui="reaction-view-button" data-reaction-view="${view}" aria-pressed="${String(
    view === currentView
  )}">${label}</button>`;
}

function renderReactionDepthToggle(depth: ReactionLensDepth, copy: ReturnType<typeof copyFor>): string {
  const surfaceCopy = copy.exploreSurface;
  return [
    `<fieldset data-play-ui="reaction-depth-control">`,
    `<legend>${escapeHtml(surfaceCopy.reactionDepth)}</legend>`,
    renderReactionDepthButton("fast", surfaceCopy.fast, depth),
    renderReactionDepthButton("deep", surfaceCopy.deep, depth),
    `</fieldset>`
  ].join("");
}

function renderReactionDepthButton(
  depth: ReactionLensDepth,
  label: string,
  currentDepth: ReactionLensDepth
): string {
  return `<button type="button" data-play-ui="reaction-depth-button" data-reaction-depth="${depth}" aria-pressed="${String(
    depth === currentDepth
  )}">${label}</button>`;
}

type ExploreViewModel = {
  readonly activeSide: ColorDto | null;
  readonly result: SideExploreDto | null;
  readonly onTurn: boolean;
  readonly showReplyToken: boolean;
  readonly riskState: "none" | "not-recommended";
  readonly sacrifice: string;
  readonly mate: string;
  readonly showSacrifice: boolean;
  readonly showMate: boolean;
  readonly bestLabel: string;
  readonly bestMove: string;
  readonly scoreLabel: string;
  readonly score: string;
  readonly recommendationNote: string | null;
  readonly recommendationNoteKind: "pending" | "provisional" | "risk" | "reason" | "unavailable" | null;
};

function buildExploreViewModel(
  state: PlayUiState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"],
  locale: UiLocale
): ExploreViewModel {
  const activeSide = state.engineState?.sideToMove ?? null;
  const result = state.sideExplore.result;
  const onTurn = result?.onTurn ?? (activeSide === state.playerSide);
  const sacrifice = sideExploreSacrificeLabel(state.sideExplore, surfaceCopy);
  const mate = sideExploreMateLabel(state.sideExplore, surfaceCopy);
  const riskState = sideExplorePrimaryRiskCandidate(state.sideExplore) === null ? "none" : "not-recommended";
  const base = {
    activeSide,
    result,
    onTurn,
    showReplyToken: !onTurn && activeSide !== null,
    riskState,
    sacrifice,
    mate,
    showSacrifice: sideExploreHasVerifiedSacrifice(state.sideExplore),
    showMate: sideExploreHasMateSignal(state.sideExplore)
  } as const;
  if (state.sideExplore.status === "idle") {
    return {
      ...base,
      bestLabel: surfaceCopy.preparingRecommendation,
      bestMove: surfaceCopy.noValue,
      scoreLabel: surfaceCopy.status,
      score: surfaceCopy.preparing,
      recommendationNote: surfaceCopy.pendingNote,
      recommendationNoteKind: "pending"
    };
  }
  if (state.sideExplore.status === "pending") {
    return {
      ...base,
      bestLabel: surfaceCopy.pendingRecommendation,
      bestMove: surfaceCopy.noValue,
      scoreLabel: surfaceCopy.status,
      score: surfaceCopy.calculating,
      recommendationNote: surfaceCopy.pendingNote,
      recommendationNoteKind: "pending"
    };
  }
  if (state.sideExplore.status === "failed" || result === null) {
    return {
      ...base,
      bestLabel: surfaceCopy.unavailableRecommendation,
      bestMove: surfaceCopy.noValue,
      scoreLabel: surfaceCopy.status,
      score: surfaceCopy.unavailable,
      recommendationNote: surfaceCopy.unavailableNote,
      recommendationNoteKind: "unavailable"
    };
  }
  const recommendationNote = sideExploreRecommendationNote(state, surfaceCopy, riskState, locale);
  const recommendationNoteKind =
    state.sideExplore.source === "provisional"
      ? "provisional"
      : riskState === "not-recommended"
        ? "risk"
        : "reason";
  return {
    ...base,
    bestLabel: sideExploreBestFactLabel(state.sideExplore, onTurn, surfaceCopy),
    bestMove: sideExploreBestMoveLabel(state.sideExplore, surfaceCopy),
    scoreLabel: sideExploreScoreFactLabel(state.sideExplore, onTurn, surfaceCopy),
    score: sideExploreScoreLabel(state.sideExplore, surfaceCopy),
    recommendationNote,
    recommendationNoteKind
  };
}

function sideExploreRecommendationNote(
  state: PlayUiState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"],
  riskState: ExploreViewModel["riskState"],
  locale: UiLocale
): string {
  const result = state.sideExplore.result;
  if (result === null) {
    return surfaceCopy.waitingReason;
  }
  const move = sideExploreRecommendationMove(result);
  if (move === null) {
    return surfaceCopy.waitingReason;
  }
  const moveLabel = humanMoveLabel(move, surfaceCopy);
  if (riskState === "not-recommended") {
    return `${surfaceCopy.riskIntro} ${moveLabel}: ${surfaceCopy.riskReason}`;
  }
  if (state.sideExplore.source === "provisional") {
    return `${surfaceCopy.playMove} ${moveLabel}: ${surfaceCopy.provisionalNote}`;
  }
  if (!result.onTurn) {
    const reply = objectiveReplyForResult(result)?.move;
    return reply === undefined
      ? `${surfaceCopy.prepareMove} ${moveLabel}: ${surfaceCopy.verifiedReason}`
      : `${surfaceCopy.afterMoveLead} ${humanMoveLabel(reply, surfaceCopy)}: ${surfaceCopy.prepareMove} ${moveLabel}; ${surfaceCopy.verifiedReason}`;
  }
  const candidate = result.candidates[0];
  if (result.explanation !== undefined && candidate !== undefined) {
    return explainRecommendation(result.explanation, candidate, locale);
  }
  const reason = candidate?.mateIn !== null && candidate?.mateIn !== undefined
    ? `${surfaceCopy.mateIn} ${String(candidate.mateIn)}.`
    : candidate?.sacrifice === true
      ? surfaceCopy.sacrificeReason
      : surfaceCopy.verifiedReason;
  return `${surfaceCopy.playMove} ${moveLabel}: ${reason}`;
}

function sideExploreRecommendationMove(result: SideExploreDto): string | null {
  if (result.onTurn) {
    return result.candidates[0]?.move ?? result.principalLine[0] ?? null;
  }
  return result.principalLine[0] ?? result.candidates[0]?.move ?? null;
}

function humanMoveLabel(
  move: string,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  const from = move.slice(0, 2);
  const to = move.slice(2, 4);
  if (!isBoardSquare(from) || !isBoardSquare(to)) {
    return surfaceCopy.noValue;
  }
  const promotion = move.slice(4, 5).toLowerCase();
  if (promotion === "") {
    return `${from} → ${to}`;
  }
  const promotionPiece = promotion === "q"
    ? "queen"
    : promotion === "r"
      ? "rook"
      : promotion === "b"
        ? "bishop"
        : promotion === "n"
          ? "knight"
          : null;
  return promotionPiece === null
    ? `${from} → ${to}`
    : `${from} → ${to} · ${surfaceCopy.promotion} ${surfaceCopy.boardPieces[promotionPiece]}`;
}

type ExploreAlternativeItem = {
  readonly kind: "candidate" | "reply";
  readonly move: string;
  readonly rank: number;
  readonly role: "alternative" | "diagnostic" | "reply";
  readonly safety: CandidateArrow["safety"];
  readonly roleLabel: string;
  readonly safetyLabel: string;
  readonly score: string | null;
};

function exploreCandidateRoleLabel(
  candidate: SideExploreDto["candidates"][number],
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  switch (sideExploreCandidateSafety(candidate)) {
    case "mating":
      return surfaceCopy.forcedMate;
    case "hanging":
      return surfaceCopy.avoid;
    case "caution":
      return surfaceCopy.caution;
    case "safe":
      return candidate.sacrifice ? surfaceCopy.sacrifice : surfaceCopy.alternativeRole;
  }
}

function exploreAlternativeItems(
  result: SideExploreDto,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): readonly ExploreAlternativeItem[] {
  if (result.onTurn) {
    const primaryMove = sideExploreRecommendationMove(result);
    return result.candidates
      .flatMap((candidate, index): readonly ExploreAlternativeItem[] => {
        if (candidate.move === primaryMove) {
          return [];
        }
        const safety = sideExploreCandidateSafety(candidate);
        return [{
          kind: "candidate",
          move: candidate.move,
          rank: index + 1,
          role: candidate.sound ? "alternative" : "diagnostic",
          safety,
          roleLabel: exploreCandidateRoleLabel(candidate, surfaceCopy),
          safetyLabel: riskSafetyLabel(safety, surfaceCopy),
          score: formatScoreCp(candidate.exactScoreCp)
        }];
      })
      .slice(0, 3);
  }

  const primaryReply = objectiveReplyForResult(result)?.move;
  return result.replyCandidates
    .filter((reply) => (reply.sound || reply.mateIn !== null) && reply.move !== primaryReply)
    .slice(0, 2)
    .map((reply, index): ExploreAlternativeItem => {
      const safety = sideExploreReplyArrowSafety(reply.mateIn);
      return {
        kind: "reply",
        move: reply.move,
        rank: index + 2,
        role: "reply",
        safety,
        roleLabel: surfaceCopy.rivalVariant,
        safetyLabel: riskSafetyLabel(safety, surfaceCopy),
        score: null
      };
    });
}

function renderExploreAlternatives(
  state: PlayUiState,
  viewModel: ExploreViewModel,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  const result = viewModel.result;
  if (state.sideExplore.status !== "ready" || result === null) {
    return "";
  }
  const items = exploreAlternativeItems(result, surfaceCopy);
  const replies = !result.onTurn;
  if (items.length === 0 && replies) {
    return "";
  }
  const title = replies ? surfaceCopy.rivalAlternatives : surfaceCopy.alternatives;
  const hint = replies ? surfaceCopy.rivalAlternativesHint : surfaceCopy.alternativesHint;
  const titleId = "explore-alternatives-title";
  const alternativeList = items.length === 0
    ? `<p data-play-ui="alternatives-empty">${escapeHtml(surfaceCopy.alternativesEmpty)}</p>`
    : [
        `<ol data-play-ui="alternative-list" aria-label="${escapeHtml(surfaceCopy.arrowRoles)}">`,
        items
          .map(
            (item) => [
              `<li data-play-ui="alternative-row" data-alternative-kind="${item.kind}" data-alternative-rank="${String(item.rank)}" data-alternative-role="${item.role}" data-alternative-safety="${item.safety}">`,
              `<button type="button" data-play-ui="alternative-item" data-alternative-move="${escapeHtml(item.move)}" aria-label="${escapeHtml([item.roleLabel, humanMoveLabel(item.move, surfaceCopy), item.score, item.safetyLabel].filter((value): value is string => value !== null).join(", "))}">`,
              `<span data-play-ui="alternative-index" aria-hidden="true">${String(item.rank).padStart(2, "0")}</span>`,
              `<div data-play-ui="alternative-move"><strong>${escapeHtml(item.roleLabel)}</strong><span>${escapeHtml(humanMoveLabel(item.move, surfaceCopy))}</span></div>`,
              `<div data-play-ui="alternative-meta">${item.score === null ? "" : `<span>${escapeHtml(item.score)}</span>`}<small>${escapeHtml(item.safetyLabel)}</small></div>`,
              `<span data-play-ui="alternative-chevron" aria-hidden="true">→</span>`,
              `</button>`,
              `</li>`
            ].join("")
          )
          .join(""),
        `</ol>`
      ].join("");
  return [
    `<section data-play-ui="explore-alternatives" data-alternatives-kind="${replies ? "replies" : "candidates"}" aria-labelledby="${titleId}">`,
    `<div data-play-ui="explore-alternatives-heading"><div><p>${escapeHtml(hint)}</p><h3 id="${titleId}">${escapeHtml(title)}</h3></div><span data-play-ui="explore-alternatives-count">${String(items.length)}</span></div>`,
    alternativeList,
    `</section>`
  ].join("");
}

function renderRecommendationBridge(
  viewModel: ExploreViewModel,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  const result = viewModel.result;
  const move = result === null ? null : sideExploreRecommendationMove(result);
  if (move === null) {
    return "";
  }
  const label = viewModel.onTurn ? surfaceCopy.showOnBoard : surfaceCopy.showResponsePlan;
  return `<button type="button" data-play-ui="recommendation-bridge" data-recommendation-move="${escapeHtml(move)}" aria-label="${escapeHtml(`${label}: ${humanMoveLabel(move, surfaceCopy)}`)}">${escapeHtml(label)}<span aria-hidden="true">↗</span></button>`;
}

function renderExploreStatus(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  const sideExplore = state.sideExplore;
  return `<span data-play-ui="explore-status" data-explore-status="${sideExplore.status}" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(exploreStatusLabel(sideExplore, copy.exploreSurface))}</span>`;
}

function formatNodeCount(nodes: number): string {
  if (nodes >= 1_000_000) {
    return `${(nodes / 1_000_000).toFixed(1)} M`;
  }
  if (nodes >= 1_000) {
    return `${(nodes / 1_000).toFixed(0)} k`;
  }
  return String(nodes);
}

// The principal line as numbered coordinate moves ("12. e2-e4 e7-e5"), starting from the current turn.
function formatPrincipalLine(result: SideExploreDto, maxPlies = 8): string {
  const fields = result.state.fen.split(" ");
  let moveNumber = Number(fields[5] ?? "1");
  let white = (fields[1] ?? "w") === "w";
  const parts: string[] = [];
  // Off-turn the engine line starts after the rival's expected reply, so that reply leads it.
  const reply = result.onTurn ? undefined : objectiveReplyForResult(result)?.move;
  const line = reply === undefined ? result.principalLine : [reply, ...result.principalLine];
  line.slice(0, maxPlies).forEach((move, index) => {
    const label = `${move.slice(0, 2)}-${move.slice(2)}`;
    if (white) {
      parts.push(`${String(moveNumber)}. ${label}`);
    } else {
      parts.push(index === 0 ? `${String(moveNumber)}… ${label}` : label);
      moveNumber += 1;
    }
    white = !white;
  });
  return parts.join(" ");
}

function renderReactionMapLens(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  const surfaceCopy = copy.exploreSurface;
  const sideExplore = state.sideExplore;
  const viewModel = buildExploreViewModel(state, surfaceCopy, copy.locale);
  const result = viewModel.result;
  return [
    `<section data-play-ui="reaction-lens" data-reaction-status="${sideExplore.status}" data-reaction-state="${sideExplorePresentationState(sideExplore)}" data-reaction-source="${sideExplore.source ?? "none"}" data-reaction-side="${state.playerSide}" data-reaction-on-turn="${String(viewModel.onTurn)}" data-reaction-engine-depth="${String(state.engineDepth)}" data-reaction-risk-state="${viewModel.riskState}" aria-labelledby="reaction-lens-title">`,
    `<h2 id="reaction-lens-title" data-play-ui="explore-title">${escapeHtml(surfaceCopy.whatToPlayNow)}</h2>`,
    `<section data-play-ui="explore-section" data-explore-section="recommendation" aria-label="${escapeHtml(surfaceCopy.recommendation)}">`,
    viewModel.recommendationNote === null
      ? ""
      : `<p data-play-ui="recommendation-note" data-recommendation-note="${viewModel.recommendationNoteKind ?? "pending"}" aria-live="polite">${escapeHtml(viewModel.recommendationNote)}</p>`,
    `<dl data-play-ui="best-facts">`,
    renderFact("reaction-best", viewModel.bestLabel, viewModel.bestMove),
    renderFact("reaction-score", viewModel.scoreLabel, viewModel.score),
    viewModel.showSacrifice ? renderFact("reaction-sacrifice", surfaceCopy.sacrifice, viewModel.sacrifice) : "",
    viewModel.showMate ? renderFact("reaction-mate", surfaceCopy.mate, viewModel.mate) : "",
    `</dl>`,
    renderRecommendationBridge(viewModel, surfaceCopy),
    `</section>`,
    renderExploreAlternatives(state, viewModel, surfaceCopy),
    `<section data-play-ui="explore-section" data-explore-section="metrics" aria-label="${escapeHtml(surfaceCopy.searchDetail)}">`,
    `<dl>`,
    renderFact("reaction-line", surfaceCopy.line, result === null || result.principalLine.length === 0 ? surfaceCopy.noValue : formatPrincipalLine(result)),
    renderFact("reaction-depth", surfaceCopy.completedDepth, result === null ? surfaceCopy.none : String(result.depth)),
    renderFact("reaction-nodes", surfaceCopy.nodes, result === null ? surfaceCopy.none : formatNodeCount(result.nodes)),
    `</dl>`,
    `</section>`,
    `<details data-play-ui="explore-details" data-explore-tier="evidence">`,
    `<summary data-play-ui="explore-details-summary"><span>${escapeHtml(surfaceCopy.moreDetail)}</span><small>${escapeHtml(surfaceCopy.deepenReadingHint)}</small></summary>`,
    `<div data-play-ui="explore-details-content">`,
    renderPathKey(surfaceCopy, viewModel.showReplyToken, state.aggressive),
    `<div data-play-ui="explore-controls">`,
    renderReactionViewToggle(state.reactionLensView, copy),
    renderReactionDepthToggle(state.reactionLensDepth, copy),
    `</div>`,
    renderProspectiveBrilliant(sideExplore, surfaceCopy),
    `<section data-play-ui="explore-section" data-explore-section="context" aria-labelledby="explore-context-title">`,
    `<h3 id="explore-context-title">${escapeHtml(surfaceCopy.context)}</h3>`,
    `<dl>`,
    renderFact("reaction-input", surfaceCopy.side, exploreColorLabel(state.playerSide, surfaceCopy)),
    renderFact("reaction-turn", surfaceCopy.turn, viewModel.activeSide === null ? surfaceCopy.calculating : exploreColorLabel(viewModel.activeSide, surfaceCopy)),
    renderFact("reaction-candidate-count", surfaceCopy.candidates, String(result?.candidates.length ?? 0)),
    renderFact("reaction-sacrifice", surfaceCopy.sacrifice, viewModel.sacrifice),
    renderFact("reaction-mate", surfaceCopy.mate, viewModel.mate),
    renderFact("reaction-mode", surfaceCopy.mode, sideExploreModeLabel(state, viewModel.onTurn, surfaceCopy)),
    renderFact("reaction-objective", surfaceCopy.objective, sideExploreObjectiveLabel(state, viewModel.onTurn, surfaceCopy)),
    renderFact(
      "reaction-rival-best",
      state.aggressive ? surfaceCopy.rivalVariant : surfaceCopy.rivalBest,
      sideExploreRivalBestLabel(sideExplore, surfaceCopy)
    ),
    renderFact(
      "reaction-side-follow-up",
      sideExploreFollowUpFactLabel(state, viewModel.onTurn, surfaceCopy),
      sideExploreFollowUpLabel(sideExplore, surfaceCopy)
    ),
    renderFact("reaction-plan", surfaceCopy.plan, sideExplorePlanLabel(sideExplore, surfaceCopy)),
    renderFact("reaction-result-source", surfaceCopy.result, sideExploreSourceLabel(sideExplore, surfaceCopy)),
    renderFact("reaction-stage", surfaceCopy.stage, sideExploreStageLabel(sideExplore, surfaceCopy)),
    renderFact("reaction-opening", surfaceCopy.opening, sideExploreOpeningLabel(sideExplore, surfaceCopy)),
    `</dl>`,
    `</section>`,
    renderOpeningLine(sideExplore, surfaceCopy),
    renderRefutationMemoryAnnotations(sideExplore, undefined, surfaceCopy),
    renderRiskHierarchy(sideExplore, surfaceCopy),
    `</div>`,
    `</details>`,
    `</section>`
  ].join("");
}

function exploreStatusLabel(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.status === "idle") {
    return surfaceCopy.preparing;
  }
  if (sideExplore.status === "pending") {
    return surfaceCopy.calculating;
  }
  if (sideExplore.status === "failed") {
    return surfaceCopy.unavailable;
  }
  return sideExplore.source === "provisional" ? surfaceCopy.provisional : surfaceCopy.richResult;
}

function sideExplorePresentationState(
  sideExplore: PlaySideExploreState
): "idle" | "pending" | "provisional" | "rich" | "error" {
  if (sideExplore.status === "pending") {
    return "pending";
  }
  if (sideExplore.status === "failed") {
    return "error";
  }
  if (sideExplore.source === "provisional") {
    return "provisional";
  }
  if (sideExplore.source === "rich") {
    return "rich";
  }
  return "idle";
}

export function renderRefutationMemoryAnnotations(
  sideExplore: PlaySideExploreState,
  cases?: readonly PlayRefutationMemoryCase[],
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"] = copyFor("es").exploreSurface
): string {
  const result = sideExplore.result;
  if (sideExplore.status !== "ready" || result === null || sideExplore.fen === null) {
    return "";
  }
  const fen = sideExplore.fen;
  const hits = result.candidates
    .map((candidate) => ({
      move: candidate.move,
      hit: refutationMemoryHit(fen, candidate.move, cases)
    }))
    .filter((entry): entry is { readonly move: string; readonly hit: PlayRefutationMemoryCase } => entry.hit !== null);
  if (hits.length === 0) {
    return "";
  }
  return [
    `<ul data-play-ui="refutation-memory" aria-label="${escapeHtml(surfaceCopy.oracleRefutedCandidates)}">`,
    hits
      .map(
       (entry) =>
          `<li data-play-ui="refutation-memory-item" data-play-refuted="oracle" data-refuted-move="${escapeHtml(entry.move)}"><span>${escapeHtml(humanMoveLabel(entry.move, surfaceCopy))}</span><small>${escapeHtml(surfaceCopy.refutedRequiresNewProof)}</small></li>`
      )
      .join(""),
    `</ul>`
  ].join("");
}

function renderProspectiveBrilliant(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  const result = sideExplore.result;
  const candidate = result?.onTurn
    ? result.candidates.find((item) => item.sound && item.prospectiveBrilliant)
    : undefined;
  if (sideExplore.status !== "ready" || result === null || candidate?.continuation === null || candidate === undefined) {
    return "";
  }
  return [
    `<aside data-play-ui="prospective-brilliant" aria-label="${escapeHtml(surfaceCopy.brilliantCandidate)}">`,
    `<strong>${escapeHtml(surfaceCopy.brilliantCandidate)}</strong>`,
    `<span data-play-ui="prospective-brilliant-move">${escapeHtml(humanMoveLabel(candidate.move, surfaceCopy))}</span>`,
    `<small>${escapeHtml(surfaceCopy.completedDepth)} ${String(result.depth)} · ${escapeHtml(surfaceCopy.continuation)} ${escapeHtml(humanMoveLabel(candidate.continuation, surfaceCopy))}</small>`,
    `</aside>`
  ].join("");
}

function renderForcingLens(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  const surfaceCopy = copy.exploreSurface;
  const forcing = state.forcing;
  return [
    `<section data-play-ui="forcing-lens" data-forcing-status="${forcing.status}" aria-labelledby="forcing-lens-title">`,
    `<h2 id="forcing-lens-title">${escapeHtml(surfaceCopy.forcing)}</h2>`,
    renderReactionViewToggle(state.reactionLensView, copy),
    renderReactionDepthToggle(state.reactionLensDepth, copy),
    renderPathKey(surfaceCopy),
    `<dl>`,
    renderFact("forcing-host", "Focus", capitalizeColor(state.playerSide)),
    renderFact("forcing-turn", "Turn", forcingTurnLabel(state)),
    renderFact("forcing-count", "Board ideas", String(forcingBoardIdeaCount(state))),
    renderFact("forcing-mate", "Mate", forcingMateLabel(forcing)),
    `</dl>`,
    renderForcingCandidates(state),
    `</section>`
  ].join("");
}

function renderPathKey(
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"],
  reply = false,
  aggressive = false
): string {
  const tokens: readonly [string, string][] = [
    ...(reply
      ? ([["reply", aggressive ? surfaceCopy.rivalVariant : surfaceCopy.rivalBest]] as readonly [string, string][])
      : []),
    ["main", surfaceCopy.line],
    ["alternative", surfaceCopy.alternative],
    ["sacrifice", surfaceCopy.sacrifice],
    ["mate", surfaceCopy.mate],
    ["caution", surfaceCopy.caution],
    ["hanging", surfaceCopy.hanging]
  ];
  return [
    `<ul data-play-ui="path-key" aria-label="${escapeHtml(surfaceCopy.pathSignals)}">`,
    tokens
      .map(
        ([signal, label]) =>
          `<li data-play-ui="path-key-token" data-path-signal="${signal}"><span>${label}</span></li>`
      )
      .join(""),
    `</ul>`
  ].join("");
}

function renderForcingCandidates(state: PlayUiState): string {
  const forcing = state.forcing;
  if (forcing.status === "pending") {
    return `<p data-play-ui="forcing-empty">Searching forcing moves…</p>`;
  }
  if (forcing.status === "failed") {
    return `<p data-play-ui="forcing-empty">${escapeHtml(
      forcing.error === null ? "Forcing search unavailable" : errorLabel(forcing.error)
    )}</p>`;
  }
  const map = forcing.map;
  if (map === null || !map.onTurn) {
    return `<p data-play-ui="forcing-empty">Waiting for ${escapeHtml(
      capitalizeColor(state.playerSide)
    )} to move</p>`;
  }
  if (map.candidates.length === 0) {
    return `<p data-play-ui="forcing-empty">No legal moves</p>`;
  }
  if (forcingBoardIdeaCount(state) === 0) {
    return `<p data-play-ui="forcing-empty">No forcing idea</p>`;
  }
  return "";
}

function forcingBoardIdeaCount(state: PlayUiState): number {
  return forcingBoardCandidates(state).length;
}

function forcingTurnLabel(state: PlayUiState): string {
  if (state.forcing.status === "pending") {
    return "searching";
  }
  const activeSide = state.engineState?.sideToMove ?? null;
  if (activeSide === null) {
    return "loading";
  }
  return activeSide === state.playerSide ? "Host to move" : `${capitalizeColor(activeSide)} to move`;
}

function forcingMateLabel(forcing: PlayForcingState): string {
  if (forcing.status === "pending") {
    return "searching";
  }
  if (forcing.status === "failed") {
    return "unavailable";
  }
  const top = forcing.map?.candidates[0];
  if (top === undefined || top.kind !== "mate" || top.mateIn === null) {
    return "None";
  }
  return `Forced mate in ${String(top.mateIn)}`;
}

function focusedReactionLensView(): ReactionLensView {
  return "reaction";
}

function exploreColorLabel(
  color: ColorDto,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  return color === "white" ? surfaceCopy.white : surfaceCopy.black;
}

function sideExploreModeLabel(
  state: PlayUiState,
  onTurn: boolean,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  const activeSide = state.engineState?.sideToMove ?? null;
  if (activeSide === null) {
    return surfaceCopy.calculating;
  }
  const side = exploreColorLabel(state.playerSide, surfaceCopy);
  if (onTurn) {
    if (state.aggressive) {
      return `${surfaceCopy.aggressiveLine} ${side}`;
    }
    return `${surfaceCopy.bestLine} ${side}`;
  }
  const projectedReply = state.sideExplore.result === null
    ? null
    : objectiveReplyForResult(state.sideExplore.result)?.move ?? null;
  if (projectedReply === null) {
    return `${surfaceCopy.projectedLine} ${side}`;
  }
  return `${surfaceCopy.projectedLine} ${side} ${surfaceCopy.afterMove} ${humanMoveLabel(projectedReply, surfaceCopy)}`;
}

function sideExploreObjectiveLabel(
  state: PlayUiState,
  onTurn: boolean,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  const side = exploreColorLabel(state.playerSide, surfaceCopy);
  if (state.sideExplore.status === "pending") {
    return `${surfaceCopy.calculating} · ${side}`;
  }
  if (state.aggressive && onTurn) {
    return surfaceCopy.aggressiveTieBreak;
  }
  if (state.aggressive) {
    return `${surfaceCopy.rivalVariant} · ${side} ${surfaceCopy.userResponse}`;
  }
  if (!onTurn) {
    return `${surfaceCopy.rivalReplyFirst} · ${side} ${surfaceCopy.projectedResponse}`;
  }
  return `${surfaceCopy.bestOutcomeFor} ${side}`;
}

function sideExploreFollowUpFactLabel(
  state: PlayUiState,
  onTurn: boolean,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  const side = exploreColorLabel(state.playerSide, surfaceCopy);
  return onTurn ? `${side} · ${surfaceCopy.next}` : `${side} · ${surfaceCopy.projected}`;
}

function sideExploreRivalBestLabel(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.status === "pending") {
    return `${surfaceCopy.independent} · ${surfaceCopy.calculating}`;
  }
  const result = sideExplore.result;
  const move = result === null
    ? undefined
    : result.onTurn
      ? result.principalLine[1]
      : objectiveReplyForResult(result)?.move;
  return `${surfaceCopy.independent} · ${move === undefined ? surfaceCopy.unavailable : humanMoveLabel(move, surfaceCopy)}`;
}

function sideExploreFollowUpLabel(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.status === "pending") {
    return surfaceCopy.calculating;
  }
  const result = sideExplore.result;
  const move = result?.onTurn ? result.principalLine[2] : result?.principalLine[0];
  return move === undefined ? surfaceCopy.unavailable : humanMoveLabel(move, surfaceCopy);
}

function sideExplorePlanLabel(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.status === "pending") {
    return surfaceCopy.calculating;
  }
  if (sideExplore.status === "failed") {
    return surfaceCopy.unavailable;
  }
  const result = sideExplore.result;
  if (result === null) {
    return surfaceCopy.none;
  }
  if (sideExplore.source === "provisional") {
    return surfaceCopy.provisionalUncertified;
  }
  switch (result.planStatus) {
    case "followed":
      return surfaceCopy.followed;
    case "replaced":
      return result.planReason === "illegal-continuation"
        ? `${surfaceCopy.replaced} · ${surfaceCopy.continuationIllegal}`
        : `${surfaceCopy.replaced} · ${surfaceCopy.recomputed}`;
    case "none":
    case undefined:
      return surfaceCopy.liveBoardStatus;
  }
  return surfaceCopy.liveBoardStatus;
}

function sideExploreSourceLabel(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.status === "pending") {
    return surfaceCopy.calculating;
  }
  if (sideExplore.status === "failed") {
    return surfaceCopy.unavailable;
  }
  if (sideExplore.source === "provisional") {
    return surfaceCopy.provisionalUncertified;
  }
  if (sideExplore.source === "rich") {
    return surfaceCopy.richResult;
  }
  return surfaceCopy.none;
}

function sideExploreStageLabel(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.status === "pending") {
    return surfaceCopy.richSearchRunning;
  }
  if (sideExplore.status === "failed") {
    return surfaceCopy.richSearchUnavailable;
  }
  if (sideExplore.source === "provisional") {
    return surfaceCopy.fallbackSearchRunning;
  }
  if (sideExplore.source === "rich") {
    return surfaceCopy.richResult;
  }
  return surfaceCopy.none;
}

function sideExploreBestFactLabel(
  sideExplore: PlaySideExploreState,
  onTurn: boolean,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.source === "provisional") {
    return surfaceCopy.provisionalRecommendation;
  }
  if (sideExplorePrimaryRiskCandidate(sideExplore) !== null) {
    return surfaceCopy.riskChoice;
  }
  return onTurn ? surfaceCopy.bestIdea : surfaceCopy.projectedIdea;
}

function sideExploreBestMoveLabel(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.status === "pending") {
    return surfaceCopy.calculating;
  }
  if (sideExplore.status === "failed") {
    return surfaceCopy.unavailable;
  }
  const result = sideExplore.result;
  const top = result?.candidates[0];
  if (result?.onTurn === false) {
    const move = result.principalLine[0] ?? top?.move;
    const reply = objectiveReplyForResult(result)?.move;
    if (move === undefined) {
      return surfaceCopy.waitingOnRival;
    }
    return reply === undefined
      ? humanMoveLabel(move, surfaceCopy)
      : `${surfaceCopy.afterMoveLead} ${humanMoveLabel(reply, surfaceCopy)}: ${humanMoveLabel(move, surfaceCopy)}`;
  }
  if (result?.onTurn === true && top?.sound === false) {
    return humanMoveLabel(top.move, surfaceCopy);
  }
  return top === undefined ? surfaceCopy.noValue : humanMoveLabel(top.move, surfaceCopy);
}

function sideExploreScoreFactLabel(
  sideExplore: PlaySideExploreState,
  onTurn: boolean,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.source === "provisional") {
    return surfaceCopy.status;
  }
  if (sideExplorePrimaryRiskCandidate(sideExplore) !== null) {
    return surfaceCopy.riskEvaluation;
  }
  return onTurn ? surfaceCopy.evaluation : surfaceCopy.projectedEvaluation;
}

// `mateDetected` with no candidates means the mate closes in before `side` gets a move: either the
// current position is already checkmate, or (off-turn) the opponent's projected reply mates. In a
// terminal position whoever is to move is the mated one; an ongoing position with the flag and no
// candidates can only be the projected reply mating `side`. With candidates present the mate is
// `side`'s own forced mate.
function sideExploreMateAgainstSide(result: SideExploreDto): boolean {
  if (!result.mateDetected || result.candidates.length > 0) {
    return false;
  }
  return result.state.status === "checkmate" ? result.state.sideToMove === result.side : true;
}

function sideExploreScoreLabel(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.status === "pending") {
    return surfaceCopy.calculating;
  }
  if (sideExplore.status === "failed") {
    return surfaceCopy.unavailable;
  }
  if (sideExplore.source === "provisional") {
    return surfaceCopy.provisional;
  }
  const result = sideExplore.result;
  if (result === null) {
    return surfaceCopy.noValue;
  }
  if (result.mateDetected) {
    return sideExploreMateAgainstSide(result) ? surfaceCopy.mated : surfaceCopy.forcedMate;
  }
  const top = result.candidates[0];
  if (result.onTurn && top?.sound === false) {
    return `${surfaceCopy.notRecommendedScore} ${formatScoreCp(top.exactScoreCp)}`;
  }
  return top === undefined ? surfaceCopy.noValue : formatScoreCp(top.exactScoreCp);
}

function sideExploreSacrificeLabel(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.status === "pending") {
    return surfaceCopy.calculating;
  }
  if (sideExplore.status === "failed") {
    return surfaceCopy.unavailable;
  }
  const top = sideExplore.result?.candidates[0];
  if (top === undefined) {
    return surfaceCopy.none;
  }
  if (sideExplore.result?.onTurn === true && !top.sound) {
    return surfaceCopy.none;
  }
  return top.sacrifice ? surfaceCopy.verified : surfaceCopy.none;
}

function sideExploreHasVerifiedSacrifice(sideExplore: PlaySideExploreState): boolean {
  if (sideExplore.status !== "ready" || sideExplore.result === null) {
    return false;
  }
  const top = sideExplore.result.candidates[0];
  return top !== undefined && top.sacrifice && (!sideExplore.result.onTurn || top.sound);
}

function sideExploreMateLabel(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  if (sideExplore.status === "pending") {
    return surfaceCopy.calculating;
  }
  if (sideExplore.status === "failed") {
    return surfaceCopy.unavailable;
  }
  const result = sideExplore.result;
  if (result?.mateDetected === true) {
    return sideExploreMateAgainstSide(result) ? surfaceCopy.mated : surfaceCopy.forcedMate;
  }
  const top = result?.candidates[0];
  if (top?.mateIn !== null && top?.mateIn !== undefined) {
    return `${surfaceCopy.mateIn} ${String(top.mateIn)}`;
  }
  return surfaceCopy.none;
}

function sideExploreHasMateSignal(sideExplore: PlaySideExploreState): boolean {
  if (sideExplore.status !== "ready" || sideExplore.result === null) {
    return false;
  }
  const top = sideExplore.result.candidates[0];
  return sideExplore.result.mateDetected || (top?.mateIn !== null && top?.mateIn !== undefined);
}

type SideExploreRiskHierarchyItem = {
  readonly move: string;
  readonly riskLabel: NonNullable<CandidateArrow["riskLabel"]>;
  readonly rank: number;
  readonly safety: CandidateArrow["safety"];
};

function sideExplorePrimaryRiskCandidate(
  sideExplore: PlaySideExploreState
): SideExploreDto["candidates"][number] | null {
  const result = sideExplore.result;
  const top = result?.candidates[0];
  if (sideExplore.status !== "ready" || result?.onTurn !== true || top === undefined || top.sound) {
    return null;
  }
  return top;
}

function sideExploreRiskHierarchyItems(
  sideExplore: PlaySideExploreState
): readonly SideExploreRiskHierarchyItem[] {
  if (sideExplorePrimaryRiskCandidate(sideExplore) === null) {
    return [];
  }
  const result = sideExplore.result;
  if (result === null) {
    return [];
  }
  return result.candidates.flatMap((candidate, index): readonly SideExploreRiskHierarchyItem[] => {
    if (candidate.sound) {
      return [];
    }
    const safety = sideExploreCandidateSafety(candidate);
    return [
      {
        move: candidate.move,
        riskLabel: index === 0 ? "least-bad-risk" : safety === "hanging" ? "avoid" : "risky-alternative",
        rank: index + 1,
        safety
      }
    ];
  });
}

function renderRiskHierarchy(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  const items = sideExploreRiskHierarchyItems(sideExplore);
  if (items.length === 0) {
    return "";
  }
  return [
    `<ol data-play-ui="risk-hierarchy" aria-label="${escapeHtml(surfaceCopy.arrowRoles)}">`,
    items
      .map(
        (item) =>
          `<li data-play-ui="risk-hierarchy-item" data-risk-rank="${String(item.rank)}" data-risk-label="${item.riskLabel}" data-risk-safety="${item.safety}"><strong>${escapeHtml(riskLabelDisplay(item.riskLabel, surfaceCopy))}</strong><span>${escapeHtml(
            humanMoveLabel(item.move, surfaceCopy)
          )}</span><small>${escapeHtml(riskSafetyLabel(item.safety, surfaceCopy))}</small></li>`
      )
      .join(""),
    `</ol>`
  ].join("");
}

function riskLabelDisplay(
  label: NonNullable<CandidateArrow["riskLabel"]>,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  switch (label) {
    case "least-bad-risk":
      return surfaceCopy.leastBadRisk;
    case "risky-alternative":
      return surfaceCopy.riskyAlternative;
    case "avoid":
      return surfaceCopy.avoid;
  }
}

function riskSafetyLabel(
  safety: CandidateArrow["safety"],
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  switch (safety) {
    case "mating":
      return surfaceCopy.mate;
    case "safe":
      return surfaceCopy.verified;
    case "caution":
      return surfaceCopy.caution;
    case "hanging":
      return surfaceCopy.hanging;
  }
}

function sideExploreBoardLine(state: PlayUiState): readonly string[] {
  if (
    state.playMode !== "reaction-lens" ||
    state.reactionLensView !== "reaction" ||
    state.sideExplore.status !== "ready"
  ) {
    return [];
  }
  const result = state.sideExplore.result;
  if (
    result === null ||
    state.engineState === null ||
    state.sideExplore.fen !== state.engineState.fen ||
    state.sideExplore.source === "provisional"
  ) {
    return [];
  }
  // Off-turn the opponent moves first, so the lead arrow must be its assumed reply (the input that
  // comes before any of `side`'s plan), with `side`'s own plan trailing as the faded continuation.
  // Drawing `principalLine` directly would paint `side`'s next move onto the current board as if it
  // moved immediately, ignoring the pending opponent reply.
  if (!result.onTurn) {
    const reply = objectiveReplyForResult(result)?.move;
    const line = reply === undefined ? result.principalLine : [reply, ...result.principalLine];
    return line.slice(0, reactionArrowLimit);
  }
  if (result.candidates[0]?.sound === false) {
    return [];
  }
  return result.principalLine.slice(0, reactionArrowLimit);
}

function sideExplorePrimaryMating(state: PlayUiState): boolean {
  if (
    state.playMode !== "reaction-lens" ||
    state.reactionLensView !== "reaction" ||
    state.sideExplore.status !== "ready"
  ) {
    return false;
  }
  const result = state.sideExplore.result;
  if (
    result === null ||
    state.engineState === null ||
    state.sideExplore.fen !== state.engineState.fen
  ) {
    return false;
  }
  // Off-turn the lead arrow is the opponent's reply, not `side`'s finishing move, so the mating
  // highlight (which means "`side` mates here") must never attach to it.
  if (!result.onTurn) {
    return false;
  }
  return result.mateDetected || isImminentMate(result.candidates[0]?.mateIn ?? null);
}

function sideExploreCandidateArrows(state: PlayUiState): readonly CandidateArrow[] {
  if (
    state.playMode !== "reaction-lens" ||
    state.reactionLensView !== "reaction" ||
    state.sideExplore.status !== "ready"
  ) {
    return [];
  }
  const result = state.sideExplore.result;
  if (
    result === null ||
    state.engineState === null ||
    state.sideExplore.fen !== state.engineState.fen ||
    state.sideExplore.source === "provisional"
  ) {
    return [];
  }
  // Off-turn these candidates are `side`'s alternatives in the post-reply child position; drawing
  // them on the current board would again paint `side`'s moves as if it were on turn. The deferred
  // plan is carried by the faded reaction continuation instead.
  if (!result.onTurn) {
    return [];
  }
  const primaryMove = result.candidates[0]?.sound === false
    ? null
    : result.principalLine[0] ?? result.candidates[0]?.move ?? null;
  // Draw exact-scored selected-side alternatives. Unsound candidates stay visible as Alt/risk
  // lanes, but never inherit the verified-sacrifice attributes or the main-line arrow.
  return result.candidates
    .flatMap((c, index): readonly CandidateArrow[] => {
      if (c.move === primaryMove) {
        return [];
      }
      const safety = sideExploreCandidateSafety(c);
      if (!c.sound) {
        const riskLabel = index === 0
          ? "least-bad-risk"
          : safety === "hanging"
            ? "avoid"
            : "risky-alternative";
        return [{ move: c.move, safety, role: "diagnostic", displayRank: index + 1, riskRank: index + 1, riskLabel }];
      }
      return [{
        move: c.move,
        safety,
        role: "alternative",
        displayRank: index + 1,
        sacrifice: c.sacrifice,
        opening: c.opening !== undefined && c.opening !== null,
        ...(c.aftermath !== null ? { aftermath: c.aftermath } : {})
      }];
    });
}

function sideExploreOpeningLabel(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  const line = sideExploreOpeningLine(sideExplore);
  return line === null ? surfaceCopy.unavailable : `${line.name} · ${humanMoveLabel(line.move, surfaceCopy)}`;
}

function renderOpeningLine(
  sideExplore: PlaySideExploreState,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  const line = sideExploreOpeningLine(sideExplore);
  if (line === null) {
    return "";
  }
  return [
    `<div data-play-ui="opening-line" data-opening-move="${escapeHtml(line.move)}">`,
    `<strong>${escapeHtml(line.name)}</strong>`,
    `<span>${escapeHtml(humanMoveLabel(line.move, surfaceCopy))}</span>`,
    `</div>`
  ].join("");
}

function sideExploreOpeningLine(sideExplore: PlaySideExploreState): { readonly name: string; readonly move: string } | null {
  if (sideExplore.status !== "ready" || sideExplore.source !== "rich") {
    return null;
  }
  const status = sideExplore.result?.openingStatus;
  if (status?.status !== "available" || status.name === null || status.move === null) {
    return null;
  }
  return { name: status.name, move: status.move };
}

function reactionLensPrimaryOpening(state: PlayUiState): boolean {
  if (
    state.playMode !== "reaction-lens" ||
    state.reactionLensView !== "reaction" ||
    state.sideExplore.status !== "ready" ||
    state.sideExplore.source !== "rich" ||
    state.engineState === null ||
    state.sideExplore.fen !== state.engineState.fen
  ) {
    return false;
  }
  const result = state.sideExplore.result;
  if (result === null || !result.onTurn) {
    return false;
  }
  const primaryMove = result.principalLine[0] ?? result.candidates[0]?.move ?? null;
  return result.candidates.some(
    (candidate) =>
      candidate.move === primaryMove && candidate.opening !== undefined && candidate.opening !== null
  );
}

function sideExploreCandidateSafety(candidate: SideExploreDto["candidates"][number]): CandidateArrow["safety"] {
  if (isImminentMate(candidate.mateIn)) {
    return "mating";
  }
  if (candidate.sound) {
    return "safe";
  }
  if (
    candidate.sacrifice ||
    candidate.exactScoreCp <= -300 ||
    candidate.kind === "check" ||
    candidate.kind === "capture"
  ) {
    return "hanging";
  }
  return "caution";
}


// Only the last move (mate in one) and the penultimate one (mate in two) earn the distinct mating
// colour, so the highlight stays meaningful for the imminent finish rather than every winning line.
const matingMoveHorizon = 2;

function isImminentMate(mateIn: number | null): boolean {
  return mateIn !== null && mateIn >= 1 && mateIn <= matingMoveHorizon;
}

function sideExploreReplyArrowSafety(mateIn: number | null): ReplyArrow["safety"] {
  return isImminentMate(mateIn) ? "mating" : "safe";
}

function sideExploreVisibleReplyArrows(result: SideExploreDto): readonly ReplyArrow[] {
  return result.replyCandidates
    .filter((reply) => reply.sound || reply.mateIn !== null)
    .slice(0, 3)
    .map((reply): ReplyArrow => ({
      move: reply.move,
      safety: sideExploreReplyArrowSafety(reply.mateIn),
      quality: reply.quality,
      sacrifice: reply.sacrifice
    }));
}

function objectiveReplyForResult(result: SideExploreDto): SideExploreDto["replyCandidates"][number] | null {
  const hasExplicitRoles = result.replyCandidates.some((reply) => reply.role !== undefined);
  return (
    result.replyCandidates.find((reply) => reply.role === "objective-primary") ??
    (hasExplicitRoles ? null : result.replyCandidates[0] ?? null)
  );
}



function forcingBoardCandidates(state: PlayUiState): readonly ForcingCandidateDto[] {
  if (
    state.playMode !== "reaction-lens" ||
    state.reactionLensView !== "forcing" ||
    state.forcing.status !== "ready"
  ) {
    return [];
  }
  const map = state.forcing.map;
  if (
    map === null ||
    !map.onTurn ||
    state.engineState === null ||
    state.forcing.fen !== state.engineState.fen
  ) {
    return [];
  }
  // Only draw a true forcing recommendation. Quiet `defense` candidates are legal moves, not
  // forcing ideas, and must not be promoted into board advice.
  return map.candidates
    .filter(
      (candidate) =>
        candidate.kind === "mate" ||
        (candidate.sound && (candidate.kind === "check" || candidate.kind === "capture"))
    )
    .slice(0, 1);
}

function reactionLensBoardLine(state: PlayUiState): readonly string[] {
  const forcingCandidates = forcingBoardCandidates(state);
  if (forcingCandidates.length > 0) {
    return forcingCandidates.slice(0, 1).map((candidate) => candidate.move);
  }
  return sideExploreBoardLine(state);
}

function reactionLensPrimaryHangs(): boolean {
  // Unsound sideExplore ideas are rendered as alternatives, and the forcing view leads with a
  // verified sound shot or mate, so the primary arrow never hangs in either view.
  return false;
}

// Off-turn the opponent contributes only solid classified replies: sound alternatives or mates. The
// lead reply travels on the primary reaction arrow, so this layer starts at rank 2 and the total
// rival arrows stay capped at three.
function reactionLensReplyArrows(state: PlayUiState): readonly ReplyArrow[] {
  if (
    state.playMode !== "reaction-lens" ||
    state.reactionLensView !== "reaction" ||
    state.sideExplore.status !== "ready"
  ) {
    return [];
  }
  const result = state.sideExplore.result;
  if (
    result !== null &&
    !result.onTurn &&
    state.engineState !== null &&
    state.sideExplore.fen === state.engineState.fen
  ) {
    return sideExploreVisibleReplyArrows(result).slice(1);
  }
  return [];
}

function reactionLensPrimaryMating(state: PlayUiState): boolean {
  const forcingCandidates = forcingBoardCandidates(state);
  if (forcingCandidates.length > 0) {
    return isImminentMate(forcingCandidates[0]?.mateIn ?? null);
  }
  return sideExplorePrimaryMating(state);
}

// Off-turn the reaction line leads with the opponent's assumed reply, so the primary arrow belongs
// to the rival, not `side`. The board receives its classification so it no longer renders as a
// semantically mute gray arrow.
function reactionLensPrimaryReply(state: PlayUiState): ReplyArrow | null {
  if (
    state.playMode !== "reaction-lens" ||
    state.reactionLensView !== "reaction" ||
    state.sideExplore.status !== "ready"
  ) {
    return null;
  }
  const result = state.sideExplore.result;
  if (
    result === null ||
    result.onTurn ||
    state.engineState === null ||
    state.sideExplore.fen !== state.engineState.fen
  ) {
    return null;
  }
  return sideExploreVisibleReplyArrows(result)[0] ?? null;
}

function reactionLensCandidateArrows(state: PlayUiState): readonly CandidateArrow[] {
  const forcingCandidates = forcingBoardCandidates(state);
  if (forcingCandidates.length > 0) {
    return [];
  }
  // Exact scores from sideExplore: ADR-0150 depth-containment lifted.
  return sideExploreCandidateArrows(state);
}

function lensBoardLine(state: PlayUiState): readonly string[] {
  if (state.playMode !== "spectator-lens" || state.lens.status !== "ready") {
    return [];
  }
  const move = state.lens.bestMove?.bestMove;
  if (move === null || move === undefined) {
    return [];
  }
  if (state.engineState === null || state.lens.fen !== state.engineState.fen) {
    return [];
  }
  return [move];
}

function renderSelectionAssist(state: PlayUiState): string {
  if (state.engineState === null || state.selectedSquare === null) {
    return renderFact("selection-assist", "Selection", "No selection");
  }
  const destinations = legalTargetsFromSelection(
    state.engineState,
    state.selectedSquare,
    playInputSide(state)
  );
  const countLabel = `${String(destinations.length)} legal ${
    destinations.length === 1 ? "destination" : "destinations"
  }`;
  return [
    `<div data-play-ui="selection-assist">`,
    `<dt>Selection</dt>`,
    `<dd><span data-play-ui="selected-square">${escapeHtml(state.selectedSquare)}</span>`,
    ` <span aria-hidden="true">-&gt;</span> `,
    `<span data-play-ui="selection-legal-count">${escapeHtml(countLabel)}</span>`,
    destinations.length === 0
      ? ""
      : `: <span data-play-ui="selection-legal-targets">${escapeHtml(
          legalDestinationSummary(destinations)
        )}</span>`,
    `</dd>`,
    `</div>`
  ].join("");
}

function legalDestinationSummary(destinations: readonly BoardSquare[]): string {
  const visible = destinations.slice(0, selectionTargetPreviewLimit);
  const hiddenCount = destinations.length - visible.length;
  if (hiddenCount <= 0) {
    return visible.join(", ");
  }
  return `${visible.join(", ")} +${String(hiddenCount)} more`;
}

function renderCurrentFen(engineState: EngineStateDto | null): string {
  if (engineState === null) {
    return "";
  }
  return renderFact("current-fen", "FEN", engineState.fen);
}

function renderLastMoveSummary(moves: readonly PlayMove[]): string {
  const move = moves.at(-1);
  if (move === undefined) {
    return "";
  }
  return renderFact(
    "last-move",
    "Last move",
    `${capitalizeColor(move.side)} ${move.actor}: ${move.san} (${move.coordinate})`
  );
}

function renderCurrentFenCopy(engineState: EngineStateDto | null): string {
  if (engineState === null) {
    return "";
  }
  return [
    `<div data-play-ui="current-fen-copy">`,
    `<button type="button" data-play-ui="current-fen-copy-button">Copy FEN</button>`,
    `<output data-play-ui="current-fen-copy-status" aria-live="polite"></output>`,
    `</div>`
  ].join("");
}

function renderMoveList(moves: readonly PlayMove[], copy: ReturnType<typeof copyFor>): string {
  if (moves.length === 0) {
    return `<p data-play-ui="move-list-empty">No moves</p>`;
  }
  return [
    `<ol data-play-ui="move-rows">`,
    moves
      .map(
        (move) => {
          const turn = moveTurnNumber(move.ply);
          return `<li data-play-ui="move-row" data-play-ply="${String(
            move.ply
          )}" data-play-actor="${move.actor}" data-play-turn="${String(
            turn
          )}" data-play-side="${move.side}"><span data-play-ui="move-turn">${escapeHtml(
            moveTurnLabel(move.ply, turn)
          )}</span><span data-play-ui="move-actor" data-play-actor="${move.actor}">${escapeHtml(
            move.actor === "player" ? copy.user : copy.rival
          )}</span><span data-play-ui="move-side">${capitalizeColor(
            move.side
          )}</span><span data-play-ui="move-san">${escapeHtml(
            move.san
          )}</span><span data-play-ui="move-coordinate">${escapeHtml(move.coordinate)}</span></li>`;
        }
      )
      .join(""),
    `</ol>`
  ].join("");
}

function moveTurnNumber(ply: number): number {
  return Math.floor((ply - 1) / 2) + 1;
}

function moveTurnLabel(ply: number, turn: number): string {
  return ply % 2 === 0 ? `${String(turn)}...` : `${String(turn)}.`;
}

function renderTerminalResult(game: CompletedPlayGame | null): string {
  if (game === null) {
    return "";
  }
  return [
    `<section data-play-ui="terminal-result" aria-label="Game result">`,
    `<dl>`,
    renderFact("terminal-result-value", "Result", game.result),
    renderFact("terminal-result-winner", "Winner", terminalWinnerLabel(game.result)),
    renderFact("terminal-result-reason", "Reason", terminalReasonLabel(game)),
    game.status === "resigned"
      ? renderFact("terminal-result-actor", "Resigned by", game.resignedBy === "rival" ? "Rival" : "User")
      : "",
    `</dl>`,
    `</section>`
  ].join("");
}

function renderTerminalPgnCopy(game: CompletedPlayGame | null): string {
  if (game === null) {
    return "";
  }
  return [
    `<div data-play-ui="terminal-pgn-copy">`,
    `<button type="button" data-play-ui="terminal-copy-pgn-button" data-terminal-action="utility">Copy PGN</button>`,
    `<output data-play-ui="terminal-copy-pgn-status" aria-live="polite"></output>`,
    `</div>`
  ].join("");
}

async function copyCurrentFen(root: HTMLElement, fen: string): Promise<void> {
  await copyPlayTextToClipboard(
    root,
    "current-fen-copy-status",
    fen,
    "FEN copied",
    "FEN copy unavailable"
  );
}

async function copyTerminalPgn(root: HTMLElement, pgn: string): Promise<void> {
  await copyPlayTextToClipboard(
    root,
    "terminal-copy-pgn-status",
    pgn,
    "PGN copied",
    "PGN copy unavailable"
  );
}

async function copyAnalyzeCommand(root: HTMLElement): Promise<void> {
  const gameId = root.querySelector('[data-play-ui="archive-game-id"]');
  if (gameId === null) return;
  const id = gameId.textContent;
  if (id === "") return;
  const command = `just analyze ${id}`;
  await copyPlayTextToClipboard(
    root,
    "archive-game-id",
    command,
    "Copied: " + command,
    "Copy unavailable"
  );
}

async function copyPlayTextToClipboard(
  root: HTMLElement,
  statusName: string,
  text: string,
  successLabel: string,
  unavailableLabel: string
): Promise<void> {
  const status = root.querySelector(`[data-play-ui="${statusName}"]`);
  try {
    await navigator.clipboard.writeText(text);
    if (status !== null) {
      status.textContent = successLabel;
    }
  } catch {
    if (status !== null) {
      status.textContent = unavailableLabel;
    }
  }
}

function renderPlayError(error: PlayErrorState | null, copy: ReturnType<typeof copyFor>): string {
  if (error === null) {
    return `<section data-play-ui="error" aria-live="polite" hidden></section>`;
  }
  return [
    `<section data-play-ui="error" data-play-error-source="${error.source}" aria-live="polite" role="status">`,
    `<h3 data-play-ui="error-title">${escapeHtml(errorTitleLabel(error.source, copy.locale))}</h3>`,
    `<dl>`,
    renderFact("error-operation", copy.locale === "es" ? "Operación" : "Operation", errorOperationLabel(error.source, copy.locale)),
    renderFact("error-reason", copy.locale === "es" ? "Motivo" : "Reason", errorLabel(error.code, copy.locale)),
    renderFact("error-recovery", copy.locale === "es" ? "Recuperación" : "Recovery", errorRecoveryLabel(error.source, copy.locale)),
    `</dl>`,
    `</section>`
  ].join("");
}

function terminalWinnerLabel(result: CompletedPlayGame["result"]): "White won" | "Black won" | "Draw" {
  switch (result) {
    case "1-0":
      return "White won";
    case "0-1":
      return "Black won";
    case "1/2-1/2":
      return "Draw";
  }
}

function terminalReasonLabel(game: CompletedPlayGame): string {
  if (game.status === "checkmate") {
    return "Checkmate";
  }
  if (game.status === "stalemate") {
    return "Stalemate";
  }
  if (game.status === "draw") {
    return drawReasonLabel(game.drawReason);
  }
  return resignedStatusLabel(game);
}

function promotionChoicesFromMoves(moves: readonly string[]): readonly PromotionMoveChoice[] {
  const choices = moves
    .map((move) => {
      const piece = promotionPieceFromMove(move);
      return piece === null ? null : { move, piece };
    })
    .filter((choice): choice is PromotionMoveChoice => choice !== null);
  const pieceOrder: readonly PromotionPiece[] = ["queen", "rook", "bishop", "knight"];
  return pieceOrder.flatMap((piece) => choices.filter((choice) => choice.piece === piece));
}

function promotionPieceFromMove(move: string): PromotionPiece | null {
  switch (move.slice(4, 5)) {
    case "q":
      return "queen";
    case "r":
      return "rook";
    case "b":
      return "bishop";
    case "n":
      return "knight";
    default:
      return null;
  }
}

function promotionPieceLabel(
  piece: PromotionPiece,
  surfaceCopy: ReturnType<typeof copyFor>["exploreSurface"]
): string {
  return surfaceCopy.boardPieces[piece];
}

function statusLabel(state: PlayUiState, copy: ReturnType<typeof copyFor>): string {
  if (state.status === "loading") {
    return copy.loading;
  }
  if (state.status === "failed") {
    return state.error === null ? copy.failed : errorTitleLabel(state.error.source, copy.locale);
  }
  if (state.engineState === null) {
    return "Ready";
  }
  if (state.completedGame?.status === "resigned") {
    return resignedStatusLabel(state.completedGame);
  }
  if (state.engineState.status === "ongoing") {
    if (state.status === "thinking") {
      return isSpectatorMode(state.playMode) ? "Applying move" : "Engine thinking";
    }
    const localizedSide = state.engineState.sideToMove === "white" ? copy.white : copy.black;
    if (isSpectatorMode(state.playMode)) {
      return copy.locale === "en" ? `${localizedSide} to move` : `${copy.exploreSurface.turn}: ${localizedSide}`;
    }
    if (copy.locale === "en") {
      return state.engineState.sideToMove === state.playerSide
        ? `${copy.yourMove} as ${localizedSide}`
        : `${copy.engineMove} as ${localizedSide}`;
    }
    return state.engineState.sideToMove === state.playerSide
      ? `${copy.yourMove} · ${localizedSide}`
      : `${copy.engineMove} · ${localizedSide}`;
  }
  if (state.engineState.status === "checkmate") {
    return copy.checkmate;
  }
  if (state.engineState.status === "draw") {
    return drawReasonLabel(state.engineState.drawReason, copy.locale);
  }
  return copy.stalemate;
}

function statusOwner(state: PlayUiState): PlayStatusOwner {
  if (state.status === "loading" || state.status === "failed" || state.engineState === null) {
    return "system";
  }
  if (state.completedGame !== null || state.engineState.status !== "ongoing") {
    return "terminal";
  }
  if (state.status === "thinking") {
    return isSpectatorMode(state.playMode) ? "system" : "engine";
  }
  if (isSpectatorMode(state.playMode)) {
    return "player";
  }
  return state.engineState.sideToMove === state.playerSide ? "player" : "engine";
}

function statusSide(state: PlayUiState): ColorDto | null {
  if (state.engineState === null || state.engineState.status !== "ongoing") {
    return null;
  }
  return state.engineState.sideToMove;
}

function gameStatusFact(state: PlayUiState): string {
  if (state.status === "failed") {
    return "failed";
  }
  return state.completedGame?.status ?? state.engineState?.status ?? "loading";
}

function resignedStatusLabel(game: CompletedPlayGame): "White resigned" | "Black resigned" {
  return game.result === "0-1" ? "White resigned" : "Black resigned";
}

function drawReasonLabel(reason: DrawReasonDto | null | undefined, locale: UiLocale = "en"): string {
  const draw = locale === "es" ? "Tablas" : "Draw";
  switch (reason) {
    case "fifty-move":
      return locale === "es" ? "Tablas: regla de cincuenta movimientos" : "Draw: fifty-move rule";
    case "insufficient-material":
      return locale === "es" ? "Tablas: material insuficiente" : "Draw: insufficient material";
    case "threefold-repetition":
      return locale === "es" ? "Tablas: triple repetición" : "Draw: threefold repetition";
    default:
      return draw;
  }
}

function errorLabel(error: PlayErrorCode, locale: UiLocale = "en"): string {
  if (locale === "es") {
    switch (error) {
      case "operation-failed":
        return "Operación fallida";
      case "invalid-fen":
        return "FEN no válido";
      case "invalid-move":
        return "Movimiento no válido";
      case "invalid-depth":
        return "Profundidad no válida";
      case "invalid-position":
        return "Posición no válida";
      case "invalid-pgn":
        return "PGN no válido";
      case "search-failed":
        return "Búsqueda fallida";
      case "invalid-response":
        return "Respuesta del motor no válida";
      case "cancelled":
        return "Búsqueda cancelada";
    }
  }
  switch (error) {
    case "operation-failed":
      return "Operation failed";
    case "invalid-fen":
      return "Invalid FEN";
    case "invalid-move":
      return "Invalid move";
    case "invalid-depth":
      return "Invalid depth";
    case "invalid-position":
      return "Invalid position";
    case "invalid-pgn":
      return "Invalid PGN";
    case "search-failed":
      return "Search failed";
    case "invalid-response":
      return "Invalid engine response";
    case "cancelled":
      return "Search cancelled";
  }
}

const errorTitles: Record<PlayErrorSource, string> = {
  "new-game": "New game failed",
  "invalid-input": "Invalid move",
  "player-move": "Move failed",
  "engine-search": "Engine failed",
  "engine-move": "Engine failed"
};

const errorOperationLabels: Record<PlayErrorSource, string> = {
  "new-game": "New Game",
  "invalid-input": "Move selection",
  "player-move": "Player move",
  "engine-search": "Engine search",
  "engine-move": "Engine move"
};

function errorTitle(source: PlayErrorSource): string {
  return errorTitles[source];
}

function errorTitleLabel(source: PlayErrorSource, locale: UiLocale): string {
  if (locale !== "es") {
    return errorTitle(source);
  }
  switch (source) {
    case "new-game":
      return "No se pudo iniciar la partida";
    case "invalid-input":
      return "Movimiento no válido";
    case "player-move":
      return "No se pudo aplicar el movimiento";
    case "engine-search":
    case "engine-move":
      return "No se pudo ejecutar el motor";
  }
}

function errorOperationLabel(source: PlayErrorSource, locale: UiLocale = "en"): string {
  if (locale === "es") {
    switch (source) {
      case "new-game":
        return "Partida nueva";
      case "invalid-input":
        return "Selección de movimiento";
      case "player-move":
        return "Movimiento del jugador";
      case "engine-search":
        return "Búsqueda del motor";
      case "engine-move":
        return "Movimiento del motor";
    }
  }
  return errorOperationLabels[source];
}

function errorRecoveryLabel(source: PlayErrorSource, locale: UiLocale = "en"): string {
  if (source === "invalid-input") {
    return locale === "es" ? "Elige un movimiento legal." : "Choose a legal move.";
  }
  return locale === "es" ? "Usa Nueva partida para reiniciar." : "Use New Game to reset.";
}

function capitalizeColor(color: ColorDto): "White" | "Black" {
  return color === "white" ? "White" : "Black";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
