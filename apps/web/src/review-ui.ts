import type {
  GameReviewDto,
  MoveLabelDto,
  ReviewArtifactsDto,
  ReviewEntryDto,
  ReviewSummaryDto,
  WasmBridgeError
} from "./engine-dtos.js";
import type {
  ReviewProfileDto,
  SavedRetryRouteAvailabilityDto,
  SavedRetryRouteFilterAvailabilityDto,
  ReviewStoreError,
  StorageLike,
  StoredReviewV3
} from "./review-store.js";
import {
  beginWorkflowReview,
  cancelWorkflowClearReviews,
  cancelWorkflowRecoverSavedReviewStore,
  confirmWorkflowClearReviews,
  confirmWorkflowRecoverSavedReviewStore,
  createInitialReviewWorkflow,
  deleteWorkflowReview,
  editWorkflowPgn,
  finishWorkflowReview,
  getSavedRetryRouteAvailability,
  getSelectedSavedReview,
  isCurrentReviewSaved,
  saveWorkflowReview,
  selectWorkflowSavedReview,
  setWorkflowDepth,
  requestWorkflowClearReviews,
  requestWorkflowRecoverSavedReviewStore,
  type ReviewPgnForWorkflow,
  type ReviewWorkflowError,
  type ReviewWorkflowState,
  failWorkflowSaveMetadata,
  type SaveWorkflowReviewMetadataResult
} from "./review-workflow.js";
import { isRecord } from "./review-validators.js";
import { copyFor, localizeVisibleMarkup, type UiLocale } from "./ui-localization.js";

export type ReviewUiSaveMetadataProvider = () => SaveWorkflowReviewMetadataResult;

export type ReviewUiDependencies = {
  readonly storage: StorageLike;
  readonly reviewPgn: ReviewPgnForWorkflow;
  readonly createSaveMetadata: ReviewUiSaveMetadataProvider;
  readonly locale?: UiLocale | undefined;
};

export type ReviewUiHandle = {
  readonly getState: () => ReviewWorkflowState;
  readonly render: () => void;
  readonly reviewPgn: (pgn: string) => Promise<void>;
  readonly destroy: () => void;
};

const depthOptions = [2, 3, 4, 5, 6] as const;
type FocusSnapshot =
  | {
      readonly name: TextFocusTarget;
      readonly selectionStart: number | null;
      readonly selectionEnd: number | null;
    }
  | { readonly name: "depth-control" | "analysis-report-input" };
type TextFocusTarget =
  | "pgn-input"
  | "retry-practice-input"
  | "saved-review-detail-practice-input";

type ImportedAnalysisReport = {
  readonly oracle: { readonly status: string; readonly depth: number | null };
  readonly games: readonly ImportedAnalysisGame[];
};
type ImportedAnalysisGame = {
  readonly id: string;
  readonly selectedSide: "white" | "black" | null;
  readonly aggressive: boolean | null;
  readonly moves: readonly ImportedAnalysisMove[];
  readonly labels: readonly ImportedAnalysisLabel[];
};
type ImportedAnalysisMove = {
  readonly ply: number;
  readonly role: string;
  readonly side: string;
  readonly selectedSide: string;
  readonly move: string;
  readonly san: string;
  readonly fenBefore: string;
  readonly engineDepth: number | null;
  readonly recommendation: ImportedAnalysisRecommendation | null;
};
type ImportedAnalysisRecommendation = {
  readonly level: number | null;
  readonly evaluatorBackend: string;
  readonly nodeBudget: number | null;
  readonly exploreMode: string;
  readonly aggressive: boolean;
  readonly userSide: string;
  readonly side: string;
  readonly onTurn: boolean;
  readonly fenBefore: string | null;
  readonly primaryMove: string | null;
  readonly primaryRenderState: string;
  readonly candidates: readonly ImportedAnalysisCandidate[];
};
type ImportedAnalysisCandidate = {
  readonly move: string;
  readonly rank: number | null;
  readonly kind: string;
  readonly exactScoreCp: number | null;
  readonly sound: boolean;
};
type ImportedAnalysisLabel = {
  readonly ply: number;
  readonly kind: string;
  readonly detail: Record<string, unknown> | null;
};

type RetryPracticeFeedback = "idle" | "correct" | "incorrect" | "revealed";
type RetryPracticeSourceState = {
  readonly activeIndex: number;
  readonly attempt: string;
  readonly feedback: RetryPracticeFeedback;
  readonly boardOrientation: BoardOrientationMode;
};
type RetryPracticeState = {
  readonly current: RetryPracticeSourceState;
  readonly saved: RetryPracticeSourceState;
};
type BoardColor = "white" | "black";
type BoardOrientationMode = "active" | BoardColor;
type BoardPieceKind = "king" | "queen" | "rook" | "bishop" | "knight" | "pawn";
type BoardFile = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";
type BoardRank = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";
type BoardSquare = `${BoardFile}${BoardRank}`;
type BoardArrowDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
type FenPiece = {
  readonly symbol: string;
  readonly color: BoardColor;
  readonly kind: BoardPieceKind;
};
type FenBoard = {
  readonly activeColor: BoardColor;
  readonly pieces: ReadonlyMap<BoardSquare, FenPiece>;
};
type BestMoveAnnotation = {
  readonly move: string;
  readonly from: BoardSquare;
  readonly to: BoardSquare;
  readonly direction: BoardArrowDirection;
};

const boardFiles = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const boardRanks = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
const whiteRanks = ["8", "7", "6", "5", "4", "3", "2", "1"] as const;
const blackRanks = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
const blackFiles = ["h", "g", "f", "e", "d", "c", "b", "a"] as const;
const boardArrowDirections: readonly BoardArrowDirection[] = [
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
  "nw"
];

export function mountReviewUi(
  root: HTMLElement,
  dependencies: ReviewUiDependencies
): ReviewUiHandle {
  let state = createInitialReviewWorkflow(dependencies.storage);
  let practiceState = emptyRetryPracticeState();
  let analysisReport: ImportedAnalysisReport | null = null;
  let analysisReportError: string | null = null;
  let locale = dependencies.locale ?? "en";
  let destroyed = false;
  const isDestroyed = (): boolean => destroyed;

  const render = (): void => {
    if (isDestroyed()) {
      return;
    }
    const focusSnapshot = captureFocus(root);
    practiceState = clampRetryPracticeState(state, practiceState);
    const copy = copyFor(locale);
    root.innerHTML = renderReviewUi(
      state,
      practiceState,
      copy,
      analysisReport,
      analysisReportError,
    );
    bindEvents();
    root.querySelector('[data-review-ui="locale-toggle"]')?.addEventListener("click", () => {
      locale = locale === "es" ? "en" : "es";
      render();
    });
    restoreFocus(root, focusSnapshot);
  };

  const openSavedRetryRouteCandidate = (
    route: SavedRetryRouteAvailabilityDto["route"]
  ): void => {
    if (route === null) {
      return;
    }
    state = selectWorkflowSavedReview(state, route.reviewId);
    practiceState = openSavedRetryRoute(practiceState, route.retryPositionIndex);
    render();
  };

  const bindEvents = (): void => {
    bindInput("pgn-input", (element) => {
      state = editWorkflowPgn(state, element.value);
      practiceState = resetRetryPractice(practiceState, "current");
      render();
    });
    bindInput("depth-control", (element) => {
      const depth = Number.parseInt(element.value, 10);
      if (isApprovedDepth(depth)) {
        state = setWorkflowDepth(state, depth);
        practiceState = resetRetryPractice(practiceState, "current");
        render();
      }
    });
    const reportInput = queryUi(root, "analysis-report-input") as HTMLInputElement | null;
    reportInput?.addEventListener("change", () => {
      const file = reportInput.files?.[0];
      if (file === undefined) {
        return;
      }
      void file.text().then((text) => {
        if (isDestroyed()) {
          return;
        }
        try {
          const parsed: unknown = JSON.parse(text);
          const validated = validateImportedAnalysisReport(parsed);
          if (validated === null) {
            throw new Error("invalid-report");
          }
          analysisReport = validated;
          analysisReportError = null;
        } catch {
          analysisReport = null;
          analysisReportError = "Analysis report could not be read";
        }
        render();
      });
    });
    bindClick("review-button", () => {
      practiceState = resetRetryPractice(practiceState, "current");
      void runReview();
    });
    bindClick("save-button", () => {
      const metadata = dependencies.createSaveMetadata();
      state = metadata.ok
        ? saveWorkflowReview(dependencies.storage, state, metadata.metadata)
        : failWorkflowSaveMetadata(state, metadata.error);
      render();
    });
    bindClick("current-review-copy-pgn-button", () => {
      if (state.currentReview !== null) {
        void copyTextToClipboard(
          root,
          "current-review-copy-pgn-status",
          state.inlinePgn,
          "PGN copied",
          "PGN copy unavailable"
        );
      }
    });
    bindClick("saved-review-detail-copy-pgn-button", () => {
      const review = getSelectedSavedReview(state);
      if (review?.sourcePgn !== null && review?.sourcePgn !== undefined) {
        void copyTextToClipboard(
          root,
          "saved-review-detail-copy-pgn-status",
          review.sourcePgn,
          "PGN copied",
          "PGN copy unavailable"
        );
      }
    });
    bindClick("clear-button", () => {
      state = requestWorkflowClearReviews(state);
      render();
    });
    bindClick("cancel-clear-button", () => {
      state = cancelWorkflowClearReviews(state);
      render();
    });
    bindClick("confirm-clear-button", () => {
      state = confirmWorkflowClearReviews(dependencies.storage, state);
      render();
    });
    bindClick("recover-store-button", () => {
      state = requestWorkflowRecoverSavedReviewStore(state);
      render();
    });
    bindClick("cancel-recover-store-button", () => {
      state = cancelWorkflowRecoverSavedReviewStore(state);
      render();
    });
    bindClick("confirm-recover-store-button", () => {
      state = confirmWorkflowRecoverSavedReviewStore(dependencies.storage, state);
      render();
    });
    bindClick("open-saved-retry-route-button", () => {
      openSavedRetryRouteCandidate(getSavedRetryRouteAvailability(state)?.route ?? null);
    });
    for (const [index] of (getSavedRetryRouteAvailability(state)?.filters ?? []).entries()) {
      bindClickForReview("open-filtered-saved-retry-route-button", index, () => {
        openSavedRetryRouteCandidate(
          getSavedRetryRouteAvailability(state)?.filters[index]?.route ?? null
        );
      });
    }

    for (const [index, record] of renderedStoredReviews(state.store?.reviews ?? []).entries()) {
      bindClickForReview("view-review-button", index, () => {
        state = selectWorkflowSavedReview(state, record.id);
        practiceState = resetRetryPractice(practiceState, "saved");
        render();
      });
      bindClickForReview("delete-review-button", index, () => {
        state = deleteWorkflowReview(dependencies.storage, state, record.id);
        practiceState = resetRetryPractice(practiceState, "saved");
        render();
      });
    }
    bindRetryPractice("retry-practice", "current");
    bindRetryPractice("saved-review-detail-practice", "saved");
  };

  const runReview = async (): Promise<void> => {
    if (isDestroyed()) {
      return;
    }
    state = beginWorkflowReview(state);
    render();

    const request = state.pendingReviewRequest;
    if (request === null) {
      return;
    }
    const result = await dependencies.reviewPgn(request);
    if (isDestroyed()) {
      return;
    }
    state = finishWorkflowReview(state, result, request);
    practiceState = resetRetryPractice(practiceState, "current");
    render();
  };

  const reviewPgn = async (pgn: string): Promise<void> => {
    if (isDestroyed() || state.status === "reviewing") {
      return;
    }
    practiceState = resetRetryPractice(practiceState, "current");
    state = editWorkflowPgn(state, pgn);
    render();
    await runReview();
  };

  const bindInput = (name: string, listener: (element: HTMLInputElement) => void): void => {
    const element = queryUi(root, name) as HTMLInputElement | null;
    element?.addEventListener("input", () => {
      if (!isDestroyed()) {
        listener(element);
      }
    });
    element?.addEventListener("change", () => {
      if (!isDestroyed()) {
        listener(element);
      }
    });
  };

  const bindClick = (name: string, listener: () => void): void => {
    const element = queryUi(root, name);
    element?.addEventListener("click", () => {
      if (!isDestroyed()) {
        listener();
      }
    });
  };

  const bindClickForReview = (name: string, index: number, listener: () => void): void => {
    const token = String(index);
    for (const element of Array.from(queryUiAll(root, name))) {
      if (element.getAttribute("data-review-index") === token) {
        element.addEventListener("click", () => {
          if (!isDestroyed()) {
            listener();
          }
        });
      }
    }
  };

  const bindRetryPractice = (
    prefix: "retry-practice" | "saved-review-detail-practice",
    source: keyof RetryPracticeState
  ): void => {
    const positions = retryPracticePositions(state, source);
    bindInput(`${prefix}-input`, (element) => {
      practiceState = setRetryPracticeAttempt(practiceState, source, element.value);
      syncRetryPracticePresentation(root, prefix, practiceState[source], positions);
      syncRetryPracticeBoardSelection(root, prefix, null);
    });
    for (const element of Array.from(queryUiAll(root, `${prefix}-board-square`))) {
      const square = element.getAttribute("data-square");
      if (square !== null && isBoardSquare(square)) {
        element.addEventListener("click", () => {
          if (!isDestroyed()) {
            if ((positions[practiceState[source].activeIndex]?.bestMove ?? null) === null) {
              return;
            }
            const selectedSquare = queryUi(root, `${prefix}-board`)?.getAttribute(
              "data-selected-square"
            ) ?? null;
            if (selectedSquare === null) {
              syncRetryPracticeBoardSelection(root, prefix, square);
              return;
            }
            applyRetryPracticeAttemptFromBoard(root, prefix, `${selectedSquare}${square}`);
          }
        });
      }
    }
    for (const element of Array.from(queryUiAll(root, `${prefix}-orientation-button`))) {
      const orientation = element.getAttribute("data-board-orientation");
      if (orientation !== null && isBoardOrientationMode(orientation)) {
        element.addEventListener("click", () => {
          if (!isDestroyed()) {
            practiceState = setRetryPracticeBoardOrientation(practiceState, source, orientation);
            render();
          }
        });
      }
    }
    bindClick(`${prefix}-copy-fen-button`, () => {
      const retry = positions[practiceState[source].activeIndex] ?? null;
      if (retry !== null) {
        void copyRetryPracticeFen(root, prefix, retry.fenBefore);
      }
    });
    bindClick(`${prefix}-submit-button`, () => {
      practiceState = checkRetryPracticeAttempt(practiceState, source, positions);
      render();
    });
    bindClick(`${prefix}-reveal-button`, () => {
      practiceState = revealRetryPracticeAnswer(practiceState, source);
      render();
    });
    bindClick(`${prefix}-reset-button`, () => {
      practiceState = resetRetryPracticeAttempt(practiceState, source);
      render();
    });
    bindClick(`${prefix}-prev-button`, () => {
      practiceState = moveRetryPractice(practiceState, source, positions, -1);
      render();
    });
    bindClick(`${prefix}-next-button`, () => {
      practiceState = moveRetryPractice(practiceState, source, positions, 1);
      render();
    });
  };

  render();

  return {
    getState: () => state,
    render,
    reviewPgn,
    destroy: () => {
      destroyed = true;
    }
  };
}

function queryUi(root: HTMLElement, name: string): Element | null {
  return root.querySelector(`[data-review-ui="${name}"]`);
}

function queryUiAll(root: HTMLElement, name: string): NodeListOf<Element> {
  return root.querySelectorAll(`[data-review-ui="${name}"]`);
}

function applyRetryPracticeAttemptFromBoard(
  root: HTMLElement,
  prefix: "retry-practice" | "saved-review-detail-practice",
  attempt: string
): void {
  const input = queryUi(root, `${prefix}-input`) as HTMLInputElement | null;
  if (input === null || input.disabled) {
    return;
  }
  input.value = attempt;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function copyRetryPracticeFen(
  root: HTMLElement,
  prefix: "retry-practice" | "saved-review-detail-practice",
  fen: string
): Promise<void> {
  await copyTextToClipboard(
    root,
    `${prefix}-copy-fen-status`,
    fen,
    "FEN copied",
    "FEN copy unavailable"
  );
}

async function copyTextToClipboard(
  root: HTMLElement,
  statusName: string,
  text: string,
  successLabel: string,
  unavailableLabel: string
): Promise<void> {
  const status = queryUi(root, statusName);
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

function syncRetryPracticePresentation(
  root: HTMLElement,
  prefix: "retry-practice" | "saved-review-detail-practice",
  practice: RetryPracticeSourceState,
  retries: readonly ReviewArtifactsDto["retryPositions"][number][]
): void {
  const retry = retries[Math.min(practice.activeIndex, retries.length - 1)] ?? null;
  const bestMove = retry?.bestMove ?? null;
  const canCheck = bestMove !== null;
  const feedback = queryUi(root, `${prefix}-feedback`);
  if (feedback !== null) {
    feedback.textContent = retryPracticeFeedbackLabel(practice.feedback, canCheck);
  }
  const answer = queryUi(root, `${prefix}-answer`);
  if (answer !== null) {
    answer.textContent = bestMove === null ? "No local best move" : `Answer ${bestMove}`;
    const answerVisible = practice.feedback === "revealed" || practice.feedback === "correct";
    answer.toggleAttribute("hidden", !answerVisible);
  }
}

function syncRetryPracticeBoardSelection(
  root: HTMLElement,
  prefix: "retry-practice" | "saved-review-detail-practice",
  selectedSquare: BoardSquare | null
): void {
  const board = queryUi(root, `${prefix}-board`);
  if (selectedSquare === null) {
    board?.removeAttribute("data-selected-square");
  } else {
    board?.setAttribute("data-selected-square", selectedSquare);
  }
  for (const element of Array.from(queryUiAll(root, `${prefix}-board-square`))) {
    const square = element.getAttribute("data-square");
    const selected = square !== null && square === selectedSquare;
    element.setAttribute("data-board-selected", selected ? "true" : "false");
    element.setAttribute("aria-pressed", selected ? "true" : "false");
  }
}

function emptyRetryPracticeState(): RetryPracticeState {
  return {
    current: emptyRetryPracticeSourceState(),
    saved: emptyRetryPracticeSourceState()
  };
}

function emptyRetryPracticeSourceState(): RetryPracticeSourceState {
  return { activeIndex: 0, attempt: "", feedback: "idle", boardOrientation: "active" };
}

function clampRetryPracticeState(
  state: ReviewWorkflowState,
  practice: RetryPracticeState
): RetryPracticeState {
  return {
    current: clampRetryPracticeSourceState(
      practice.current,
      retryPracticePositions(state, "current").length
    ),
    saved: clampRetryPracticeSourceState(practice.saved, retryPracticePositions(state, "saved").length)
  };
}

function clampRetryPracticeSourceState(
  practice: RetryPracticeSourceState,
  count: number
): RetryPracticeSourceState {
  if (count === 0) {
    return emptyRetryPracticeSourceState();
  }
  const activeIndex = Math.min(Math.max(practice.activeIndex, 0), count - 1);
  return activeIndex === practice.activeIndex
    ? practice
    : { ...emptyRetryPracticeSourceState(), activeIndex, boardOrientation: practice.boardOrientation };
}

function retryPracticePositions(
  state: ReviewWorkflowState,
  source: keyof RetryPracticeState
): readonly ReviewArtifactsDto["retryPositions"][number][] {
  if (source === "current") {
    return state.currentArtifacts?.retryPositions ?? [];
  }
  return getSelectedSavedReview(state)?.artifacts?.retryPositions ?? [];
}

function resetRetryPractice(
  practice: RetryPracticeState,
  source: keyof RetryPracticeState
): RetryPracticeState {
  return { ...practice, [source]: emptyRetryPracticeSourceState() };
}

function openSavedRetryRoute(
  practice: RetryPracticeState,
  activeIndex: number
): RetryPracticeState {
  return {
    ...practice,
    saved: {
      ...emptyRetryPracticeSourceState(),
      activeIndex
    }
  };
}

function setRetryPracticeAttempt(
  practice: RetryPracticeState,
  source: keyof RetryPracticeState,
  attempt: string
): RetryPracticeState {
  return {
    ...practice,
    [source]: {
      ...practice[source],
      attempt,
      feedback: "idle"
    }
  };
}

function setRetryPracticeBoardOrientation(
  practice: RetryPracticeState,
  source: keyof RetryPracticeState,
  boardOrientation: BoardOrientationMode
): RetryPracticeState {
  return {
    ...practice,
    [source]: {
      ...practice[source],
      boardOrientation
    }
  };
}

function checkRetryPracticeAttempt(
  practice: RetryPracticeState,
  source: keyof RetryPracticeState,
  positions: readonly ReviewArtifactsDto["retryPositions"][number][]
): RetryPracticeState {
  const current = practice[source];
  const retry = positions[current.activeIndex];
  const bestMove = retry?.bestMove ?? null;
  if (bestMove === null) {
    return practice;
  }
  return {
    ...practice,
    [source]: {
      ...current,
      feedback: normalizeMove(current.attempt) === normalizeMove(bestMove) ? "correct" : "incorrect"
    }
  };
}

function revealRetryPracticeAnswer(
  practice: RetryPracticeState,
  source: keyof RetryPracticeState
): RetryPracticeState {
  return {
    ...practice,
    [source]: {
      ...practice[source],
      feedback: "revealed"
    }
  };
}

function resetRetryPracticeAttempt(
  practice: RetryPracticeState,
  source: keyof RetryPracticeState
): RetryPracticeState {
  return {
    ...practice,
    [source]: {
      ...practice[source],
      attempt: "",
      feedback: "idle"
    }
  };
}

function moveRetryPractice(
  practice: RetryPracticeState,
  source: keyof RetryPracticeState,
  positions: readonly ReviewArtifactsDto["retryPositions"][number][],
  delta: -1 | 1
): RetryPracticeState {
  if (positions.length === 0) {
    return resetRetryPractice(practice, source);
  }
  const activeIndex = Math.min(
    Math.max(practice[source].activeIndex + delta, 0),
    positions.length - 1
  );
  return {
    ...practice,
    [source]: {
      ...emptyRetryPracticeSourceState(),
      activeIndex,
      boardOrientation: practice[source].boardOrientation
    }
  };
}

function normalizeMove(value: string): string {
  return value.trim().toLowerCase();
}

function retryPracticeFeedbackLabel(feedback: RetryPracticeFeedback, canCheck: boolean): string {
  if (!canCheck) {
    return "No local best move available";
  }
  switch (feedback) {
    case "idle":
      return "Enter the local best move";
    case "correct":
      return "Correct";
    case "incorrect":
      return "Incorrect, try again";
    case "revealed":
      return "Answer revealed";
  }
}

function renderReviewUi(
  state: ReviewWorkflowState,
  practiceState: RetryPracticeState,
  copy: ReturnType<typeof copyFor>,
  analysisReport: ImportedAnalysisReport | null,
  analysisReportError: string | null,
): string {
  const storeUnavailable = state.store === null;
  const isReviewing = state.status === "reviewing";
  const currentReviewSaved = isCurrentReviewSaved(state);
  const canSave = state.currentReview !== null && !isReviewing && !currentReviewSaved;
  const savedRetryRouteAvailability = getSavedRetryRouteAvailability(state);
  const savedReviewCount = state.store === null ? 0 : state.store.reviews.length;
  const canRequestClear =
    !storeUnavailable &&
    !isReviewing &&
    !state.pendingClearSavedReviews &&
    savedReviewCount > 0;
  return localizeVisibleMarkup([
    `<section data-review-ui="root">`,
    renderProductHeader(copy),
    renderControls(state, isReviewing, canSave, canRequestClear, currentReviewSaved, copy),
    renderClearConfirmation(state, storeUnavailable, isReviewing),
    renderStoreRecovery(state, isReviewing),
    `<output data-review-ui="status" aria-live="polite">${escapeHtml(
      statusLabel(state.status, copy)
    )}</output>`,
    renderErrorOutput(state.error, copy),
    renderSummary(state.currentReview),
    renderMoveList(state.currentReview),
    renderArtifacts(state.currentReview, state.currentArtifacts, practiceState.current),
    renderProfile(state.profile),
    renderSavedRetryRouteAvailability(savedRetryRouteAvailability),
    renderStoredReviews(state.store?.reviews ?? [], state.selectedSavedReviewId, storeUnavailable),
    renderSavedReviewDetail(getSelectedSavedReview(state), practiceState.saved),
    renderAnalysisReport(analysisReport, analysisReportError),
    `</section>`
  ].join(""), copy.locale);
}

function renderProductHeader(copy: ReturnType<typeof copyFor>): string {
  return [
    `<header data-review-ui="product-header">`,
    `<button type="button" data-review-ui="locale-toggle" aria-label="${copy.language}">${copy.language}</button>`,
    `<h1 data-review-ui="product-title">${copy.trainer}</h1>`,
    `<span data-review-ui="release-badge">${copy.badge}</span>`,
    `<p data-review-ui="release-scope">${copy.scope}</p>`,
    `</header>`
  ].join("");
}

function statusLabel(status: ReviewWorkflowState["status"], copy: ReturnType<typeof copyFor>): string {
  switch (status) {
    case "idle":
      return copy.ready;
    case "reviewing":
      return copy.reviewing;
    case "reviewed":
      return copy.reviewComplete;
    case "failed":
      return copy.needsAttention;
  }
}

function renderErrorOutput(error: ReviewWorkflowError | null, copy: ReturnType<typeof copyFor>): string {
  if (error === null) {
    return `<output data-review-ui="error" hidden aria-hidden="true"></output>`;
  }
  return `<output data-review-ui="error" role="alert" aria-live="assertive" data-error-source="${escapeHtml(
    error.source
  )}" data-error-reason="${escapeHtml(error.reason)}">${escapeHtml(errorLabel(error, copy))}</output>`;
}

function renderArtifacts(
  review: GameReviewDto | null,
  artifacts: ReviewArtifactsDto | null,
  practice: RetryPracticeSourceState
): string {
  if (review === null) {
    return [
      `<section data-review-ui="coach-artifacts" aria-labelledby="coach-artifacts-title">`,
      `<h2 id="coach-artifacts-title">Coach artifacts</h2>`,
      `<p data-review-ui="coach-artifacts-no-current-review">No review yet</p>`,
      `</section>`
    ].join("");
  }

  return [
    `<section data-review-ui="coach-artifacts" aria-labelledby="coach-artifacts-title">`,
    `<h2 id="coach-artifacts-title">Coach artifacts</h2>`,
    renderKeyMoments(artifacts),
    renderEvidence(artifacts),
    renderForkCandidates(artifacts),
    renderEarlyDivergences(artifacts),
    renderRetryPositions(artifacts),
    renderRetryPractice("retry-practice", artifacts?.retryPositions ?? [], practice),
    `</section>`
  ].join("");
}

function renderKeyMoments(artifacts: ReviewArtifactsDto | null): string {
  const moments = artifacts?.keyMoments ?? [];
  return [
    `<section data-review-ui="key-moments" aria-labelledby="key-moments-title">`,
    `<h3 id="key-moments-title">Key moments</h3>`,
    moments.length === 0
      ? `<p data-review-ui="key-moment-empty">No key moments</p>`
      : moments.map(renderKeyMoment).join(""),
    `</section>`
  ].join("");
}

function renderKeyMoment(moment: ReviewArtifactsDto["keyMoments"][number], index: number): string {
  const token = String(index);
  return [
    `<article data-review-ui="key-moment-row" data-review-index="${token}">`,
    `<dl>`,
    renderIndexedFact("key-moment-rank", token, "Rank", String(moment.rank)),
    renderIndexedFact("key-moment-ply", token, "Ply", String(moment.ply)),
    renderIndexedFact("key-moment-san", token, "SAN", moment.san),
    renderIndexedFact("key-moment-played", token, "Played", moment.playedMove),
    renderIndexedFact("key-moment-best", token, "Best", moment.bestMove ?? "none"),
    renderIndexedFact("key-moment-cp-loss", token, "CP loss", formatCentipawnLoss(moment.cpLoss)),
    renderIndexedFact("key-moment-label", token, "Label", formatMoveLabel(moment.label)),
    `</dl>`,
    `</article>`
  ].join("");
}

function renderEvidence(artifacts: ReviewArtifactsDto | null): string {
  const evidence = artifacts?.evidence ?? [];
  return [
    `<section data-review-ui="evidence" aria-labelledby="evidence-title">`,
    `<h3 id="evidence-title">Evidence</h3>`,
    evidence.length === 0
      ? `<p data-review-ui="evidence-empty">No evidence</p>`
      : evidence.map(renderEvidenceRow).join(""),
    `</section>`
  ].join("");
}

function renderEvidenceRow(evidence: ReviewArtifactsDto["evidence"][number], index: number): string {
  const token = String(index);
  return [
    `<article data-review-ui="evidence-row" data-review-index="${token}">`,
    `<dl>`,
    renderIndexedFact("evidence-kind", token, "Kind", "Local search swing"),
    renderIndexedFact("evidence-ply", token, "Ply", String(evidence.ply)),
    renderIndexedFact("evidence-played", token, "Played", evidence.playedMove),
    renderIndexedFact("evidence-best", token, "Best", evidence.bestMove ?? "none"),
    renderIndexedFact(
      "evidence-score",
      token,
      "Score swing",
      formatCentipawnSwing(evidence.bestScoreCp, evidence.playedScoreCp)
    ),
    renderIndexedFact("evidence-cp-loss", token, "CP loss", formatCentipawnLoss(evidence.cpLoss)),
    renderIndexedFact("evidence-label", token, "Label", formatMoveLabel(evidence.label)),
    `</dl>`,
    `</article>`
  ].join("");
}

function renderForkCandidates(artifacts: ReviewArtifactsDto | null): string {
  return renderForkCandidateSection(
    "fork-candidates",
    "fork-candidate",
    "Fork candidates",
    artifacts?.forkCandidates ?? []
  );
}

function renderSavedReviewForkCandidates(artifacts: ReviewArtifactsDto | null): string {
  return renderForkCandidateSection(
    "saved-review-detail-fork-candidates",
    "saved-review-detail-fork-candidate",
    "Fork candidates",
    artifacts?.forkCandidates ?? []
  );
}

function renderForkCandidateSection(
  sectionName: string,
  rowPrefix: string,
  title: string,
  candidates: readonly ReviewArtifactsDto["forkCandidates"][number][]
): string {
  const titleId = `${sectionName}-title`;
  return [
    `<section data-review-ui="${sectionName}" aria-labelledby="${titleId}">`,
    `<h3 id="${titleId}">${title}</h3>`,
    candidates.length === 0
      ? `<p data-review-ui="${rowPrefix}-empty">No fork candidates</p>`
      : candidates.map((candidate, index) => renderForkCandidate(rowPrefix, candidate, index)).join(""),
    `</section>`
  ].join("");
}

function renderForkCandidate(
  prefix: string,
  candidate: ReviewArtifactsDto["forkCandidates"][number],
  index: number
): string {
  const token = String(index);
  return [
    `<article data-review-ui="${prefix}-row" data-review-index="${token}">`,
    `<dl>`,
    renderIndexedFact(`${prefix}-rank`, token, "Rank", String(candidate.rank)),
    renderIndexedFact(`${prefix}-ply`, token, "Ply", String(candidate.ply)),
    renderIndexedFact(`${prefix}-best-move`, token, "Best move", candidate.bestMove),
    renderIndexedFact(`${prefix}-moved-piece`, token, "Moved piece", formatPiece(candidate.movedPiece)),
    renderIndexedFact(`${prefix}-destination`, token, "Destination", candidate.destination),
    renderIndexedFact(`${prefix}-targets`, token, "Targets", formatForkTargets(candidate.targets)),
    renderIndexedFact(`${prefix}-cp-loss`, token, "CP loss", formatCentipawnLoss(candidate.cpLoss)),
    renderIndexedFact(`${prefix}-label`, token, "Label", formatMoveLabel(candidate.label)),
    `</dl>`,
    `</article>`
  ].join("");
}

function renderEarlyDivergences(artifacts: ReviewArtifactsDto | null): string {
  const divergences = artifacts?.earlyMoveDivergences ?? [];
  return [
    `<section data-review-ui="early-divergences" aria-labelledby="early-divergences-title">`,
    `<h3 id="early-divergences-title">Early divergences</h3>`,
    divergences.length === 0
      ? `<p data-review-ui="early-divergence-empty">No early divergences</p>`
      : divergences.map(renderEarlyDivergence).join(""),
    `</section>`
  ].join("");
}

function renderEarlyDivergence(
  divergence: ReviewArtifactsDto["earlyMoveDivergences"][number],
  index: number
): string {
  const token = String(index);
  return [
    `<article data-review-ui="early-divergence-row" data-review-index="${token}">`,
    `<dl>`,
    renderIndexedFact("early-divergence-ply", token, "Ply", String(divergence.ply)),
    renderIndexedFact("early-divergence-san", token, "SAN", divergence.san),
    renderIndexedFact("early-divergence-played", token, "Played", divergence.playedMove),
    renderIndexedFact("early-divergence-best", token, "Local best", divergence.localBestMove),
    renderIndexedFact("early-divergence-cp-loss", token, "CP loss", formatCentipawnLoss(divergence.cpLoss)),
    renderIndexedFact("early-divergence-label", token, "Label", formatMoveLabel(divergence.label)),
    `</dl>`,
    `</article>`
  ].join("");
}

function renderRetryPositions(artifacts: ReviewArtifactsDto | null): string {
  const retries = artifacts?.retryPositions ?? [];
  return [
    `<section data-review-ui="retry-positions" aria-labelledby="retry-positions-title">`,
    `<h3 id="retry-positions-title">Retry positions</h3>`,
    retries.length === 0
      ? `<p data-review-ui="retry-position-empty">No retry positions</p>`
      : retries.map(renderRetryPosition).join(""),
    `</section>`
  ].join("");
}

function renderRetryPosition(retry: ReviewArtifactsDto["retryPositions"][number], index: number): string {
  const token = String(index);
  return [
    `<article data-review-ui="retry-position-row" data-review-index="${token}">`,
    `<dl>`,
    renderIndexedFact("retry-position-rank", token, "Rank", String(retry.rank)),
    renderIndexedFact("retry-position-ply", token, "Ply", String(retry.ply)),
    renderIndexedFact("retry-position-fen", token, "FEN before", retry.fenBefore),
    renderIndexedFact("retry-position-played", token, "Played", retry.playedMove),
    renderIndexedFact("retry-position-best", token, "Best", retry.bestMove ?? "none"),
    renderIndexedFact("retry-position-cp-loss", token, "CP loss", formatCentipawnLoss(retry.cpLoss)),
    renderIndexedFact("retry-position-label", token, "Label", formatMoveLabel(retry.label)),
    `</dl>`,
    `</article>`
  ].join("");
}

function renderRetryPracticeBoard(
  prefix: "retry-practice" | "saved-review-detail-practice",
  fen: string,
  bestMove: string | null,
  canSelect: boolean,
  orientationMode: BoardOrientationMode
): string {
  const board = parseFenBoard(fen);
  if (board === null) {
    return "";
  }
  const boardSide = orientationMode === "active" ? board.activeColor : orientationMode;
  const ranks = boardSide === "white" ? whiteRanks : blackRanks;
  const files = boardSide === "white" ? boardFiles : blackFiles;
  const caption = `Board, ${capitalizeBoardColor(board.activeColor)} to move`;
  const annotation = bestMove === null ? null : bestMoveAnnotation(bestMove, boardSide);
  const annotationAttributes =
    annotation === null
      ? ""
      : ` data-best-move="${escapeHtml(annotation.move)}" data-best-move-from="${
          annotation.from
        }" data-best-move-to="${annotation.to}"`;
  return [
    `<div data-review-ui="${prefix}-board" data-board-side="${boardSide}" data-board-active-side="${
      board.activeColor
    }"${annotationAttributes} aria-label="${escapeHtml(
      `${caption}, ${capitalizeBoardColor(boardSide)} orientation`
    )}">`,
    renderRetryPracticeBoardControls(prefix, fen, board.activeColor, orientationMode),
    `<p data-review-ui="${prefix}-board-caption">${escapeHtml(caption)}</p>`,
    `<div data-review-ui="${prefix}-board-frame">`,
    `<div data-review-ui="${prefix}-board-rank-labels" aria-hidden="true">`,
    ranks
      .map(
        (rank) =>
          `<span data-review-ui="${prefix}-board-rank-label" data-board-rank="${rank}">${rank}</span>`
      )
      .join(""),
    `</div>`,
    `<div data-review-ui="${prefix}-board-grid" role="grid">`,
    ranks
      .flatMap((rank) =>
        files.map((file) =>
          renderRetryPracticeBoardSquare(
            prefix,
            `${file}${rank}`,
            board.pieces.get(`${file}${rank}`) ?? null,
            annotation,
            canSelect
          )
        )
      )
      .join(""),
    `</div>`,
    `<div></div>`,
    `<div data-review-ui="${prefix}-board-file-labels" aria-hidden="true">`,
    files
      .map(
        (file) =>
          `<span data-review-ui="${prefix}-board-file-label" data-board-file="${file}">${file}</span>`
      )
      .join(""),
    `</div>`,
    `</div>`,
    `</div>`
  ].join("");
}

function renderRetryPracticeBoardControls(
  prefix: "retry-practice" | "saved-review-detail-practice",
  fen: string,
  activeColor: BoardColor,
  orientationMode: BoardOrientationMode
): string {
  return [
    `<div data-review-ui="${prefix}-board-controls">`,
    `<div data-review-ui="${prefix}-orientation-controls" role="group" aria-label="Board orientation">`,
    renderBoardOrientationButton(
      prefix,
      "active",
      `Active ${capitalizeBoardColor(activeColor)}`,
      orientationMode
    ),
    renderBoardOrientationButton(prefix, "white", "White", orientationMode),
    renderBoardOrientationButton(prefix, "black", "Black", orientationMode),
    `</div>`,
    `<button type="button" data-review-ui="${prefix}-copy-fen-button" data-fen="${escapeHtml(
      fen
    )}">Copy FEN</button>`,
    `<output data-review-ui="${prefix}-copy-fen-status" aria-live="polite"></output>`,
    `</div>`
  ].join("");
}

function renderBoardOrientationButton(
  prefix: "retry-practice" | "saved-review-detail-practice",
  orientation: BoardOrientationMode,
  label: string,
  activeOrientation: BoardOrientationMode
): string {
  return `<button type="button" data-review-ui="${prefix}-orientation-button" data-board-orientation="${orientation}" aria-pressed="${
    orientation === activeOrientation ? "true" : "false"
  }">${escapeHtml(label)}</button>`;
}

function renderRetryPracticeBoardSquare(
  prefix: "retry-practice" | "saved-review-detail-practice",
  square: BoardSquare,
  piece: FenPiece | null,
  annotation: BestMoveAnnotation | null,
  canSelect: boolean
): string {
  const label = piece === null ? `${square} empty` : `${square} ${formatBoardPiece(piece)}`;
  const annotationAttributes =
    annotation === null
      ? ""
      : square === annotation.from
        ? ` data-board-arrow="from" data-board-arrow-direction="${annotation.direction}"`
        : square === annotation.to
          ? ` data-board-arrow="to"`
          : "";
  return [
    `<button type="button" data-review-ui="${prefix}-board-square" data-square="${square}"`,
    ` data-board-shade="${boardSquareShade(square)}" data-board-selected="false"`,
    annotationAttributes,
    piece === null
      ? ""
      : ` data-board-piece="${escapeHtml(piece.symbol)}" data-board-piece-color="${
          piece.color
        }" data-board-piece-kind="${piece.kind}"`,
    ` aria-label="${escapeHtml(label)}" aria-pressed="false" title="${escapeHtml(
      label
    )}" role="gridcell"${
      canSelect ? "" : " disabled"
    }>`,
    piece === null
      ? ""
      : `<span data-review-ui="${prefix}-board-piece" data-square="${square}" aria-hidden="true">${boardPieceGlyphHtml(
          piece
        )}</span>`,
    `</button>`
  ].join("");
}

function parseFenBoard(fen: string): FenBoard | null {
  const [placement, activeSide] = fen.trim().split(/\s+/u);
  if (placement === undefined || activeSide === undefined) {
    return null;
  }
  const activeColor = activeSide === "w" ? "white" : activeSide === "b" ? "black" : null;
  if (activeColor === null) {
    return null;
  }
  const rows = placement.split("/");
  if (rows.length !== 8) {
    return null;
  }
  const pieces = new Map<BoardSquare, FenPiece>();
  for (const [rankOffset, row] of rows.entries()) {
    const rank = whiteRanks[rankOffset];
    if (rank === undefined) {
      return null;
    }
    let fileOffset = 0;
    for (const symbol of row) {
      if (/^[1-8]$/u.test(symbol)) {
        fileOffset += Number.parseInt(symbol, 10);
        if (fileOffset > boardFiles.length) {
          return null;
        }
        continue;
      }
      const file = boardFiles[fileOffset];
      const piece = parseFenPiece(symbol);
      if (file === undefined || piece === null) {
        return null;
      }
      pieces.set(`${file}${rank}`, piece);
      fileOffset += 1;
    }
    if (fileOffset !== boardFiles.length) {
      return null;
    }
  }
  return { activeColor, pieces };
}

function parseFenPiece(symbol: string): FenPiece | null {
  const kind = fenPieceKind(symbol);
  if (kind === null) {
    return null;
  }
  return {
    symbol,
    color: symbol === symbol.toUpperCase() ? "white" : "black",
    kind
  };
}

function fenPieceKind(symbol: string): BoardPieceKind | null {
  switch (symbol.toLowerCase()) {
    case "k":
      return "king";
    case "q":
      return "queen";
    case "r":
      return "rook";
    case "b":
      return "bishop";
    case "n":
      return "knight";
    case "p":
      return "pawn";
    default:
      return null;
  }
}

function isBoardSquare(value: string): value is BoardSquare {
  if (value.length !== 2) {
    return false;
  }
  const [file, rank] = value;
  return isBoardFile(file) && isBoardRank(rank);
}

function isBoardFile(value: string | undefined): value is BoardFile {
  return value !== undefined && boardFiles.some((file) => file === value);
}

function isBoardRank(value: string | undefined): value is BoardRank {
  return value !== undefined && boardRanks.some((rank) => rank === value);
}

function isBoardOrientationMode(value: string): value is BoardOrientationMode {
  return value === "active" || value === "white" || value === "black";
}

function boardSquareShade(square: BoardSquare): "light" | "dark" {
  const file = square.slice(0, 1);
  const rank = square.slice(1, 2);
  const fileOffset = boardFiles.findIndex((candidate) => candidate === file);
  const rankNumber = Number.parseInt(rank, 10);
  return (fileOffset + rankNumber) % 2 === 1 ? "dark" : "light";
}

function bestMoveAnnotation(move: string, boardSide: BoardColor): BestMoveAnnotation | null {
  const from = boardSquareFromText(move.slice(0, 2).toLowerCase());
  const to = boardSquareFromText(move.slice(2, 4).toLowerCase());
  if (from === null || to === null || from === to) {
    return null;
  }
  const direction = boardArrowDirection(from, to, boardSide);
  return direction === null ? null : { move, from, to, direction };
}

function boardSquareFromText(value: string): BoardSquare | null {
  if (value.length !== 2) {
    return null;
  }
  const file = value[0];
  const rank = value[1];
  return isBoardFile(file) && isBoardRank(rank) ? `${file}${rank}` : null;
}

function boardArrowDirection(
  from: BoardSquare,
  to: BoardSquare,
  boardSide: BoardColor
): BoardArrowDirection | null {
  const fromCoordinates = boardDisplayCoordinates(from, boardSide);
  const toCoordinates = boardDisplayCoordinates(to, boardSide);
  if (fromCoordinates === null || toCoordinates === null) {
    return null;
  }
  const vertical =
    toCoordinates.row < fromCoordinates.row ? "n" : toCoordinates.row > fromCoordinates.row ? "s" : "";
  const horizontal =
    toCoordinates.column > fromCoordinates.column
      ? "e"
      : toCoordinates.column < fromCoordinates.column
        ? "w"
        : "";
  const direction = `${vertical}${horizontal}`;
  return isBoardArrowDirection(direction) ? direction : null;
}

function boardDisplayCoordinates(
  square: BoardSquare,
  boardSide: BoardColor
): { readonly column: number; readonly row: number } | null {
  const file = square.slice(0, 1);
  const rank = square.slice(1, 2);
  const files = boardSide === "white" ? boardFiles : blackFiles;
  const ranks = boardSide === "white" ? whiteRanks : blackRanks;
  const column = files.findIndex((candidate) => candidate === file);
  const row = ranks.findIndex((candidate) => candidate === rank);
  return column === -1 || row === -1 ? null : { column, row };
}

function isBoardArrowDirection(value: string): value is BoardArrowDirection {
  return boardArrowDirections.some((direction) => direction === value);
}

function formatBoardPiece(piece: FenPiece): string {
  return `${capitalizeBoardColor(piece.color)} ${piece.kind}`;
}

function capitalizeBoardColor(color: BoardColor): "White" | "Black" {
  return color === "white" ? "White" : "Black";
}

function boardPieceGlyphHtml(piece: FenPiece): string {
  switch (piece.symbol) {
    case "K":
      return "&#9812;";
    case "Q":
      return "&#9813;";
    case "R":
      return "&#9814;";
    case "B":
      return "&#9815;";
    case "N":
      return "&#9816;";
    case "P":
      return "&#9817;";
    case "k":
      return "&#9818;";
    case "q":
      return "&#9819;";
    case "r":
      return "&#9820;";
    case "b":
      return "&#9821;";
    case "n":
      return "&#9822;";
    case "p":
      return "&#9823;";
    default:
      return "";
  }
}

function renderRetryPractice(
  prefix: "retry-practice" | "saved-review-detail-practice",
  retries: readonly ReviewArtifactsDto["retryPositions"][number][],
  practice: RetryPracticeSourceState,
  unavailable = false
): string {
  const title = prefix === "retry-practice" ? "Retry practice" : "Saved retry practice";
  if (unavailable) {
    return [
      `<section data-review-ui="${prefix}" aria-labelledby="${prefix}-title">`,
      `<h3 id="${prefix}-title">${title}</h3>`,
      `<p data-review-ui="${prefix}-empty">No saved retry practice</p>`,
      `</section>`
    ].join("");
  }
  if (retries.length === 0) {
    return [
      `<section data-review-ui="${prefix}" aria-labelledby="${prefix}-title">`,
      `<h3 id="${prefix}-title">${title}</h3>`,
      `<p data-review-ui="${prefix}-empty">No retry positions</p>`,
      `</section>`
    ].join("");
  }

  const activeIndex = Math.min(practice.activeIndex, retries.length - 1);
  const retry = retries[activeIndex] ?? retries[0];
  if (retry === undefined) {
    return "";
  }
  const token = String(activeIndex);
  const bestMove = retry.bestMove;
  const canCheck = bestMove !== null;
  const answerVisible = practice.feedback === "revealed" || practice.feedback === "correct";
  return [
    `<section data-review-ui="${prefix}" aria-labelledby="${prefix}-title">`,
    `<h3 id="${prefix}-title">${title}</h3>`,
    `<p data-review-ui="${prefix}-index">Position ${String(activeIndex + 1)} of ${String(
      retries.length
    )}</p>`,
    renderRetryPracticeBoard(prefix, retry.fenBefore, bestMove, canCheck, practice.boardOrientation),
    `<article data-review-ui="${prefix}-position" data-review-index="${token}">`,
    `<dl>`,
    renderIndexedFact(`${prefix}-ply`, token, "Ply", String(retry.ply)),
    renderIndexedFact(`${prefix}-fen`, token, "FEN before", retry.fenBefore),
    renderIndexedFact(`${prefix}-played`, token, "Played", retry.playedMove),
    renderIndexedFact(`${prefix}-san`, token, "SAN", retry.san),
    renderIndexedFact(`${prefix}-cp-loss`, token, "CP loss", formatCentipawnLoss(retry.cpLoss)),
    renderIndexedFact(`${prefix}-label`, token, "Label", formatMoveLabel(retry.label)),
    `</dl>`,
    `</article>`,
    `<label data-review-ui="${prefix}-input-label" for="${prefix}-input">Best move</label>`,
    `<p id="${prefix}-input-hint" data-review-ui="${prefix}-input-hint">Coordinate notation, e.g. e2e4</p>`,
    `<input id="${prefix}-input" data-review-ui="${prefix}-input" value="${escapeHtml(
      practice.attempt
    )}" autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="off" inputmode="text" placeholder="e.g. e2e4" aria-describedby="${prefix}-input-hint"${
      canCheck ? "" : " disabled"
    }>`,
    `<div data-review-ui="${prefix}-actions">`,
    `<button type="button" data-review-ui="${prefix}-prev-button"${
      activeIndex === 0 ? " disabled" : ""
    }>Previous</button>`,
    `<button type="button" data-review-ui="${prefix}-next-button"${
      activeIndex === retries.length - 1 ? " disabled" : ""
    }>Next</button>`,
    `<button type="button" data-review-ui="${prefix}-submit-button"${
      canCheck ? "" : " disabled"
    }>Check</button>`,
    `<button type="button" data-review-ui="${prefix}-reveal-button"${
      canCheck ? "" : " disabled"
    }>Reveal</button>`,
    `<button type="button" data-review-ui="${prefix}-reset-button">Reset</button>`,
    `</div>`,
    `<output data-review-ui="${prefix}-feedback" aria-live="polite">${escapeHtml(
      retryPracticeFeedbackLabel(practice.feedback, canCheck)
    )}</output>`,
    `<p data-review-ui="${prefix}-answer"${answerVisible ? "" : " hidden"}>${escapeHtml(
      bestMove === null ? "No local best move" : `Answer ${bestMove}`
    )}</p>`,
    `</section>`
  ].join("");
}

function renderControls(
  state: ReviewWorkflowState,
  isReviewing: boolean,
  canSave: boolean,
  canRequestClear: boolean,
  currentReviewSaved: boolean,
  copy: ReturnType<typeof copyFor>
): string {
  return [
    `<form data-review-ui="review-form">`,
    `<label data-review-ui="pgn-label" for="review-pgn-input">PGN</label>`,
    `<textarea id="review-pgn-input" data-review-ui="pgn-input"${
      isReviewing ? " disabled" : ""
    }>${escapeHtml(state.inlinePgn)}</textarea>`,
    `<label data-review-ui="analysis-report-label" for="review-analysis-report-input">Play analysis JSON</label>`,
    `<input id="review-analysis-report-input" type="file" accept=".json,application/json" data-review-ui="analysis-report-input">`,
    `<label data-review-ui="depth-label" for="review-depth-control">${copy.reviewDepth}</label>`,
    `<select id="review-depth-control" data-review-ui="depth-control" data-depth-options="2,3,4,5,6"${
      isReviewing ? " disabled" : ""
    }>${depthOptions
      .map((depth) => renderDepthOption(depth, state.depth))
      .join("")}</select>`,
    `<button type="button" data-review-ui="review-button"${
      isReviewing ? " disabled" : ""
    }>${copy.review}</button>`,
    `<button type="button" data-review-ui="save-button"${
      canSave ? "" : " disabled"
    }>${copy.save}</button>`,
    `<p data-review-ui="save-state">${escapeHtml(saveStateLabel(state, currentReviewSaved))}</p>`,
    renderCurrentReviewPgnCopy(state.currentReview),
    `<button type="button" data-review-ui="clear-button"${
      canRequestClear ? "" : " disabled"
    }>Clear saved reviews</button>`,
    `</form>`
  ].join("");
}

function renderCurrentReviewPgnCopy(review: GameReviewDto | null): string {
  if (review === null) {
    return "";
  }

  return [
    `<div data-review-ui="current-review-copy-pgn">`,
    `<button type="button" data-review-ui="current-review-copy-pgn-button">Copy PGN</button>`,
    `<output data-review-ui="current-review-copy-pgn-status" aria-live="polite"></output>`,
    `</div>`
  ].join("");
}

function renderClearConfirmation(
  state: ReviewWorkflowState,
  storeUnavailable: boolean,
  isReviewing: boolean
): string {
  if (!state.pendingClearSavedReviews) {
    return "";
  }
  const confirmDisabled = storeUnavailable || isReviewing;
  return [
    `<section data-review-ui="clear-confirmation" aria-live="polite">`,
    `<p data-review-ui="clear-confirmation-message">Clear saved reviews?</p>`,
    `<button type="button" data-review-ui="cancel-clear-button">Cancel</button>`,
    `<button type="button" data-review-ui="confirm-clear-button"${
      confirmDisabled ? " disabled" : ""
    }>Clear saved reviews</button>`,
    `</section>`
  ].join("");
}

function renderStoreRecovery(state: ReviewWorkflowState, isReviewing: boolean): string {
  if (!hasRecoverableStoreError(state)) {
    return "";
  }

  if (!state.pendingRecoverSavedReviewStore) {
    return [
      `<section data-review-ui="recover-store" aria-live="polite">`,
      `<p data-review-ui="recover-store-message">Saved-review storage needs reset</p>`,
      `<button type="button" data-review-ui="recover-store-button"${
        isReviewing ? " disabled" : ""
      }>Reset saved reviews</button>`,
      `</section>`
    ].join("");
  }

  return [
    `<section data-review-ui="recover-store-confirmation" aria-live="polite">`,
    `<p data-review-ui="recover-store-confirmation-message">Reset saved-review storage?</p>`,
    `<button type="button" data-review-ui="cancel-recover-store-button">Cancel</button>`,
    `<button type="button" data-review-ui="confirm-recover-store-button"${
      isReviewing ? " disabled" : ""
    }>Reset saved reviews</button>`,
    `</section>`
  ].join("");
}

function hasRecoverableStoreError(state: ReviewWorkflowState): boolean {
  return (
    state.error?.source === "store" &&
    (state.error.reason === "corrupt-store" || state.error.reason === "unsupported-schema")
  );
}

function saveStateLabel(state: ReviewWorkflowState, currentReviewSaved: boolean): string {
  if (currentReviewSaved) {
    return "Current review saved";
  }
  return state.currentReview === null ? "No review yet" : "Unsaved review";
}

function renderDepthOption(depth: number, currentDepth: number): string {
  return `<option value="${String(depth)}"${depth === currentDepth ? " selected" : ""}>${String(
    depth
  )}</option>`;
}

function renderSummary(review: GameReviewDto | null): string {
  if (review === null) {
    return [
      `<section data-review-ui="summary" aria-labelledby="review-summary-title">`,
      `<h2 id="review-summary-title">Review summary</h2>`,
      `<p data-review-ui="summary-empty">No review yet</p>`,
      `</section>`
    ].join("");
  }

  return [
    `<section data-review-ui="summary" aria-labelledby="review-summary-title">`,
    `<h2 id="review-summary-title">Review summary</h2>`,
    `<dl>`,
    renderSummaryFacts("summary", review.summary),
    `</dl>`,
    `</section>`
  ].join("");
}

function renderMoveList(review: GameReviewDto | null): string {
  if (review === null) {
    return [
      `<section data-review-ui="move-list" aria-labelledby="move-list-title">`,
      `<h2 id="move-list-title">Move list</h2>`,
      `<p data-review-ui="move-list-no-current-review">No review yet</p>`,
      `</section>`
    ].join("");
  }

  const entries = review.entries;
  if (entries.length === 0) {
    return [
      `<section data-review-ui="move-list" aria-labelledby="move-list-title">`,
      `<h2 id="move-list-title">Move list</h2>`,
      `<p data-review-ui="move-list-empty">No moves reviewed</p>`,
      `</section>`
    ].join("");
  }

  return [
    `<section data-review-ui="move-list" aria-labelledby="move-list-title">`,
    `<h2 id="move-list-title">Move list</h2>`,
    `<table>`,
    `<thead><tr><th scope="col">Ply</th><th scope="col">SAN</th><th scope="col">Played</th><th scope="col">Best</th><th scope="col">Best score</th><th scope="col">Played score</th><th scope="col">CP loss</th><th scope="col">Label</th></tr></thead>`,
    `<tbody>`,
    entries.map(renderMoveRow).join(""),
    `</tbody>`,
    `</table>`,
    `</section>`
  ].join("");
}

function renderMoveRow(entry: ReviewEntryDto, index: number): string {
  const token = String(index);
  const bestMove = entry.bestMove ?? "none";
  return [
    `<tr data-review-ui="move-row" data-review-index="${token}">`,
    `<td><span data-review-ui="move-ply" data-review-index="${token}">${String(
      entry.ply
    )}</span></td>`,
    `<td><span data-review-ui="move-san" data-review-index="${token}">${escapeHtml(
      entry.san
    )}</span></td>`,
    `<td><span data-review-ui="move-played" data-review-index="${token}">${escapeHtml(
      entry.playedMove
    )}</span></td>`,
    `<td><span data-review-ui="move-best" data-review-index="${token}">${escapeHtml(
      bestMove
    )}</span></td>`,
    `<td><span data-review-ui="move-best-score" data-review-index="${token}">${formatCentipawnScore(
      entry.bestScoreCp
    )}</span></td>`,
    `<td><span data-review-ui="move-played-score" data-review-index="${token}">${formatCentipawnScore(
      entry.playedScoreCp
    )}</span></td>`,
    `<td><span data-review-ui="move-cp-loss" data-review-index="${token}">${formatCentipawnLoss(
      entry.cpLoss
    )}</span></td>`,
    `<td>${renderMoveLabelBadge("move-label", token, entry.label)}</td>`,
    `</tr>`
  ].join("");
}

function renderProfile(profile: ReviewProfileDto | null): string {
  if (profile === null) {
    return [
      `<section data-review-ui="profile" aria-labelledby="review-profile-title">`,
      `<h2 id="review-profile-title">Review profile</h2>`,
      `<p data-review-ui="profile-unavailable">Profile unavailable</p>`,
      `</section>`
    ].join("");
  }

  return [
    `<section data-review-ui="profile" aria-labelledby="review-profile-title">`,
    `<h2 id="review-profile-title">Review profile</h2>`,
    `<dl>`,
    renderFact("profile-total-reviews", "Saved reviews", String(profile.totalReviews)),
    renderFact("profile-total-moves", "Reviewed moves", String(profile.totalMoves)),
    renderFact("profile-cp-loss-total", "CP loss total", formatCentipawnLoss(profile.cpLossTotal)),
    renderSummaryFacts("profile", profile.labelTotals),
    `</dl>`,
    `<ul data-review-ui="profile-bucket-list">`,
    profile.plyBuckets.map(renderProfileBucket).join(""),
    `</ul>`,
    renderObservedPatterns(profile.observedPatterns),
    `</section>`
  ].join("");
}

function renderSavedRetryRouteAvailability(
  availability: SavedRetryRouteAvailabilityDto | null
): string {
  if (availability === null) {
    return `<section data-review-ui="saved-retry-route" hidden aria-hidden="true"></section>`;
  }

  const denominators = availability.denominators;
  return [
    `<section data-review-ui="saved-retry-route" aria-labelledby="saved-retry-route-title">`,
    `<h2 id="saved-retry-route-title">Local saved retry positions</h2>`,
    `<dl>`,
    renderFact(
      "saved-retry-route-saved-reviews",
      "Saved reviews",
      formatPlainCount(denominators.savedReviews, "saved review")
    ),
    renderFact(
      "saved-retry-route-reviewed-moves",
      "Reviewed moves",
      formatPlainCount(denominators.reviewedMoves, "reviewed move")
    ),
    renderFact(
      "saved-retry-route-artifact-backed-reviews",
      "Artifact-backed reviews",
      formatCountOf(denominators.artifactBackedReviews, denominators.savedReviews, "saved review")
    ),
    renderFact(
      "saved-retry-route-artifact-missing-reviews",
      "Artifact-missing reviews",
      formatCountOf(denominators.artifactMissingReviews, denominators.savedReviews, "saved review")
    ),
    renderFact(
      "saved-retry-route-saved-retry-positions",
      "Saved retry positions",
      formatCountFrom(
        denominators.savedRetryPositions,
        denominators.artifactBackedReviews,
        "artifact-backed review"
      )
    ),
    `</dl>`,
    renderSavedRetryRouteFilters(availability.filters),
    availability.route === null
      ? ""
      : `<button type="button" data-review-ui="open-saved-retry-route-button">Open saved retry position</button>`,
    `</section>`
  ].join("");
}

function renderSavedRetryRouteFilters(
  filters: readonly SavedRetryRouteFilterAvailabilityDto[]
): string {
  return `<div data-review-ui="saved-retry-route-filters">${filters
    .map(renderSavedRetryRouteFilter)
    .join("")}</div>`;
}

function renderSavedRetryRouteFilter(
  filter: SavedRetryRouteFilterAvailabilityDto,
  index: number
): string {
  const token = String(index);
  const label = savedRetryRouteFilterLabel(filter.kind);
  const unit = savedRetryRouteFilterUnit(filter.kind);
  return [
    `<section data-review-ui="saved-retry-route-filter" data-review-index="${token}" aria-labelledby="saved-retry-route-filter-title-${token}">`,
    `<h3 id="saved-retry-route-filter-title-${token}">${label}</h3>`,
    `<dl>`,
    renderIndexedFact(
      "saved-retry-route-filter-artifacts",
      token,
      label,
      formatPlainCount(filter.artifactCount, unit)
    ),
    renderIndexedFact(
      "saved-retry-route-filter-matched-retry-positions",
      token,
      "Matched retry positions",
      formatCountFrom(filter.matchedRetryPositions, filter.artifactCount, unit)
    ),
    `</dl>`,
    filter.route === null
      ? ""
      : `<button type="button" data-review-ui="open-filtered-saved-retry-route-button" data-review-index="${token}">Open saved retry position</button>`,
    `</section>`
  ].join("");
}

function savedRetryRouteFilterLabel(kind: SavedRetryRouteFilterAvailabilityDto["kind"]): string {
  switch (kind) {
    case "key-moments":
      return "Key moments";
    case "local-search-swings":
      return "Local search swings";
    case "fork-candidates":
      return "Fork candidates";
  }
}

function savedRetryRouteFilterUnit(kind: SavedRetryRouteFilterAvailabilityDto["kind"]): string {
  switch (kind) {
    case "key-moments":
      return "key moment";
    case "local-search-swings":
      return "local search swing";
    case "fork-candidates":
      return "fork candidate";
  }
}

function renderStoredReviews(
  reviews: readonly StoredReviewV3[],
  selectedReviewId: string | null,
  storeUnavailable: boolean
): string {
  const renderedReviews = renderedStoredReviews(reviews);
  return [
    `<section data-review-ui="stored-review-list" aria-labelledby="stored-review-title">`,
    `<h2 id="stored-review-title">Saved reviews</h2>`,
    renderedReviews.length === 0
      ? `<p data-review-ui="stored-review-empty">No saved reviews</p>`
      : renderedReviews
          .map((review, index) =>
            renderStoredReview(review, index, review.id === selectedReviewId, storeUnavailable)
          )
          .join(""),
    `</section>`
  ].join("");
}

function renderStoredReview(
  review: StoredReviewV3,
  index: number,
  selected: boolean,
  storeUnavailable: boolean
): string {
  const token = String(index);
  return [
    `<article data-review-ui="stored-review-row" data-review-index="${token}"${
      selected ? ` data-review-selected="true" aria-current="true"` : ""
    }>`,
    `<dl>`,
    renderIndexedFact("stored-review-saved-at", token, "Saved at", formatSavedAt(review.savedAtIso)),
    renderIndexedFact(
      "stored-review-move-count",
      token,
      "Moves",
      String(review.review.entries.length)
    ),
    renderIndexedSummaryFacts("stored-review-summary", token, review.review.summary),
    `</dl>`,
    selected
      ? `<span data-review-ui="stored-review-selected" data-review-index="${token}">Selected</span>`
      : "",
    `<button type="button" data-review-ui="view-review-button" data-review-index="${token}"${
      storeUnavailable ? " disabled" : ""
    }>View</button>`,
    `<button type="button" data-review-ui="delete-review-button" data-review-index="${token}"${
      storeUnavailable ? " disabled" : ""
    }>Delete</button>`,
    `</article>`
  ].join("");
}

function renderedStoredReviews(reviews: readonly StoredReviewV3[]): readonly StoredReviewV3[] {
  return reviews
    .map((review, originalIndex) => ({ review, originalIndex }))
    .sort((left, right) => {
      const bySavedAt = right.review.savedAtIso.localeCompare(left.review.savedAtIso);
      return bySavedAt === 0 ? left.originalIndex - right.originalIndex : bySavedAt;
    })
    .map(({ review }) => review);
}

function renderSavedReviewDetail(
  review: StoredReviewV3 | null,
  practice: RetryPracticeSourceState
): string {
  if (review === null) {
    return [
      `<section data-review-ui="saved-review-detail" aria-labelledby="saved-review-detail-title">`,
      `<h2 id="saved-review-detail-title">Saved review detail</h2>`,
      `<p data-review-ui="saved-review-detail-empty">No saved review selected</p>`,
      `</section>`
    ].join("");
  }

  return [
    `<section data-review-ui="saved-review-detail" aria-labelledby="saved-review-detail-title">`,
    `<h2 id="saved-review-detail-title">Saved review detail</h2>`,
    `<dl>`,
    renderFact("saved-review-detail-saved-at", "Saved at", formatSavedAt(review.savedAtIso)),
    renderFact("saved-review-detail-move-count", "Moves", String(review.review.entries.length)),
    renderSummaryFacts("saved-review-detail-summary", review.review.summary),
    `</dl>`,
    renderSavedReviewDetailPgnCopy(review.sourcePgn),
    renderSavedReviewDetailMoveList(review.review),
    renderSavedReviewForkCandidates(review.artifacts),
    renderRetryPractice(
      "saved-review-detail-practice",
      review.artifacts?.retryPositions ?? [],
      practice,
      review.artifacts === null
    ),
    `</section>`
  ].join("");
}

function renderAnalysisReport(
  report: ImportedAnalysisReport | null,
  error: string | null
): string {
  if (error !== null) {
    return [
      `<section data-review-ui="analysis-report" aria-labelledby="analysis-report-title">`,
      `<h2 id="analysis-report-title">Play evidence report</h2>`,
      `<p data-review-ui="analysis-report-error" role="alert">${escapeHtml(error)}</p>`,
      `</section>`
    ].join("");
  }
  if (report === null) {
    return [
      `<section data-review-ui="analysis-report" aria-labelledby="analysis-report-title">`,
      `<h2 id="analysis-report-title">Play evidence report</h2>`,
      `<p data-review-ui="analysis-report-empty">No report imported</p>`,
      `</section>`
    ].join("");
  }
  return [
    `<section data-review-ui="analysis-report" aria-labelledby="analysis-report-title">`,
    `<h2 id="analysis-report-title">Play evidence report</h2>`,
    `<dl>`,
    renderFact("analysis-report-oracle-status", "Oracle", report.oracle.status),
    renderFact("analysis-report-oracle-depth", "Oracle depth", report.oracle.depth === null ? "unknown" : String(report.oracle.depth)),
    renderFact("analysis-report-game-count", "Games", String(report.games.length)),
    `</dl>`,
    report.games.length === 0
      ? `<p data-review-ui="analysis-report-no-games">No accepted games</p>`
      : report.games.map(renderAnalysisGame).join(""),
    `</section>`
  ].join("");
}

function renderAnalysisGame(game: ImportedAnalysisGame): string {
  // User/Rival is a side perspective in the Analyzer. Do not trust a stale
  // stored role when rendering an imported historical report.
  const userMoves = game.moves.filter((move) => move.side === game.selectedSide);
  return [
    `<details data-review-ui="analysis-game" data-analysis-game-id="${escapeHtml(game.id)}">`,
    `<summary>${escapeHtml(game.id)} · ${String(userMoves.length)} <span data-review-ui="analysis-user-plies">user plies</span></summary>`,
    `<dl>`,
    renderFact("analysis-game-selected-side", "Selected side", game.selectedSide ?? "unknown"),
    renderFact("analysis-game-aggressive", "Aggressive", game.aggressive === null ? "unknown" : String(game.aggressive)),
    `</dl>`,
    userMoves.length === 0
      ? `<p data-review-ui="analysis-game-empty">No user plies</p>`
      : userMoves.map((move) => renderAnalysisMove(move, game.labels)).join(""),
    `</details>`
  ].join("");
}

function renderAnalysisMove(
  move: ImportedAnalysisMove,
  labels: readonly ImportedAnalysisLabel[]
): string {
  const recommendation = move.recommendation;
  const candidate = recommendation?.onTurn && recommendation.fenBefore === move.fenBefore
    ? recommendation.candidates.find((entry) => entry.move === move.move) ?? null
    : null;
  const rank = candidate?.rank ?? null;
  const relation = rank === null ? "not offered" : rank === 1 ? "primary" : `candidate ${String(rank)}`;
  const oracle = labels.find((entry) => entry.ply === move.ply && entry.kind === "oracle-move-delta") ?? null;
  return [
    `<details data-review-ui="analysis-move" data-analysis-ply="${String(move.ply)}">`,
    `<summary>Ply ${String(move.ply)} · ${escapeHtml(move.san)} · <span data-review-ui="analysis-move-relation-summary">${escapeHtml(relation)}</span></summary>`,
    `<dl>`,
    renderFact("analysis-move-played", "Played", move.move),
    renderFact("analysis-move-relation", "Recommendation", relation),
    renderFact("analysis-move-level", "Play level", recommendation?.level === null || recommendation === null ? "not captured" : String(recommendation.level)),
    renderFact("analysis-move-engine-depth", "Move depth", move.engineDepth === null ? "unknown" : String(move.engineDepth)),
    renderFact("analysis-move-explore-mode", "Explore", recommendation?.exploreMode ?? "none"),
    renderFact("analysis-move-oracle", "Oracle", renderAnalysisOracle(oracle)),
    `</dl>`,
    renderAnalysisCandidates(recommendation, move.move),
    `<details data-review-ui="analysis-move-evidence">`,
    `<summary>Evidence</summary>`,
    `<p data-review-ui="analysis-move-fen">${escapeHtml(move.fenBefore)}</p>`,
    `</details>`,
    `</details>`
  ].join("");
}

function renderAnalysisCandidates(
  recommendation: ImportedAnalysisRecommendation | null,
  playedMove: string
): string {
  if (recommendation === null || recommendation.candidates.length === 0) {
    return `<p data-review-ui="analysis-candidates-empty">No candidates captured</p>`;
  }
  return [
    `<ol data-review-ui="analysis-candidates">`,
    recommendation.candidates.map((candidate, index) => {
      const rank = candidate.rank ?? index + 1;
      const played = candidate.move === playedMove;
      return [
        `<li data-review-ui="analysis-candidate" data-analysis-rank="${String(rank)}" data-played="${String(played)}">`,
        `<span data-review-ui="analysis-candidate-rank">${String(rank)}</span> `,
        `<span data-review-ui="analysis-candidate-move">${escapeHtml(candidate.move)}</span> `,
        `<span data-review-ui="analysis-candidate-kind">${escapeHtml(candidate.kind)}</span> `,
        `<span data-review-ui="analysis-candidate-score">${candidate.exactScoreCp === null ? "score unknown" : formatCentipawnScore(candidate.exactScoreCp)}</span> `,
        `<span data-review-ui="analysis-candidate-sound">${candidate.sound ? "sound" : "not sound"}</span>`,
        played ? ` <strong data-review-ui="analysis-candidate-played">played</strong>` : "",
        `</li>`
      ].join("");
    }).join(""),
    `</ol>`
  ].join("");
}

function renderAnalysisOracle(label: ImportedAnalysisLabel | null): string {
  if (label === null || label.detail === null) {
    return "no result";
  }
  const delta = typeof label.detail.deltaCp === "number" ? formatCentipawnScore(label.detail.deltaCp) : "delta unknown";
  const band = typeof label.detail.qualityBand === "string" ? label.detail.qualityBand : "quality unknown";
  return `${band} · ${delta}`;
}

function validateImportedAnalysisReport(value: unknown): ImportedAnalysisReport | null {
  if (!isRecord(value) || value.source !== "play-game-archive-analysis" || !Array.isArray(value.games)) {
    return null;
  }
  const games = value.games.map(validateImportedAnalysisGame);
  if (games.some((game): game is null => game === null)) {
    return null;
  }
  const oracle = isRecord(value.oracle) ? value.oracle : {};
  return {
    oracle: {
      status: typeof oracle.status === "string" ? oracle.status : "unknown",
      depth: typeof oracle.depth === "number" ? oracle.depth : null
    },
    games: games as ImportedAnalysisGame[]
  };
}

function validateImportedAnalysisGame(value: unknown): ImportedAnalysisGame | null {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.moves) || !Array.isArray(value.labels)) {
    return null;
  }
  const moves = value.moves.map(validateImportedAnalysisMove);
  const labels = value.labels.map(validateImportedAnalysisLabel);
  if (moves.some((move): move is null => move === null) || labels.some((label): label is null => label === null)) {
    return null;
  }
  return {
    id: value.id,
    selectedSide: value.selectedSide === "white" || value.selectedSide === "black" ? value.selectedSide : null,
    aggressive: typeof value.aggressive === "boolean" ? value.aggressive : null,
    moves: moves as ImportedAnalysisMove[],
    labels: labels as ImportedAnalysisLabel[]
  };
}

function validateImportedAnalysisMove(value: unknown): ImportedAnalysisMove | null {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.ply) ||
    typeof value.role !== "string" ||
    typeof value.side !== "string" ||
    typeof value.selectedSide !== "string" ||
    typeof value.move !== "string" ||
    typeof value.fenBefore !== "string"
  ) {
    return null;
  }
  return {
    ply: value.ply as number,
    role: value.role,
    side: value.side,
    selectedSide: value.selectedSide,
    move: value.move,
    san: typeof value.san === "string" ? value.san : value.move,
    fenBefore: value.fenBefore,
    engineDepth: typeof value.engineDepth === "number" ? value.engineDepth : null,
    recommendation:
      value.recommendationBeforeMove === null || value.recommendationBeforeMove === undefined
        ? null
        : validateImportedAnalysisRecommendation(value.recommendationBeforeMove)
  };
}

function validateImportedAnalysisRecommendation(value: unknown): ImportedAnalysisRecommendation | null {
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    return null;
  }
  const candidates = value.candidates.map(validateImportedAnalysisCandidate);
  if (candidates.some((candidate): candidate is null => candidate === null)) {
    return null;
  }
  return {
    level: typeof value.level === "number" ? value.level : null,
    evaluatorBackend: typeof value.evaluatorBackend === "string" ? value.evaluatorBackend : "unknown",
    nodeBudget: typeof value.nodeBudget === "number" ? value.nodeBudget : null,
    exploreMode: typeof value.exploreMode === "string" ? value.exploreMode : "unknown",
    aggressive: value.aggressive === true,
    userSide: typeof value.userSide === "string" ? value.userSide : "unknown",
    side: typeof value.side === "string" ? value.side : "unknown",
    onTurn: value.onTurn === true,
    fenBefore: typeof value.fenBefore === "string" ? value.fenBefore : null,
    primaryMove: typeof value.primaryMove === "string" ? value.primaryMove : null,
    primaryRenderState: typeof value.primaryRenderState === "string" ? value.primaryRenderState : "unknown",
    candidates: candidates as ImportedAnalysisCandidate[]
  };
}

function validateImportedAnalysisCandidate(value: unknown): ImportedAnalysisCandidate | null {
  if (!isRecord(value) || typeof value.move !== "string") {
    return null;
  }
  return {
    move: value.move,
    rank: typeof value.rank === "number" ? value.rank : null,
    kind: typeof value.kind === "string" ? value.kind : "unknown",
    exactScoreCp: typeof value.exactScoreCp === "number" ? value.exactScoreCp : null,
    sound: value.sound === true
  };
}

function validateImportedAnalysisLabel(value: unknown): ImportedAnalysisLabel | null {
  if (!isRecord(value) || !Number.isInteger(value.ply) || typeof value.kind !== "string") {
    return null;
  }
  return {
    ply: value.ply as number,
    kind: value.kind,
    detail: isRecord(value.detail) ? value.detail : null
  };
}

function renderSavedReviewDetailPgnCopy(sourcePgn: string | null): string {
  if (sourcePgn === null) {
    return "";
  }

  return [
    `<div data-review-ui="saved-review-detail-copy-pgn">`,
    `<button type="button" data-review-ui="saved-review-detail-copy-pgn-button">Copy PGN</button>`,
    `<output data-review-ui="saved-review-detail-copy-pgn-status" aria-live="polite"></output>`,
    `</div>`
  ].join("");
}

function renderSavedReviewDetailMoveList(review: GameReviewDto): string {
  if (review.entries.length === 0) {
    return `<p data-review-ui="saved-review-detail-move-empty">No moves reviewed</p>`;
  }

  return [
    `<table data-review-ui="saved-review-detail-move-list">`,
    `<thead><tr><th scope="col">Ply</th><th scope="col">SAN</th><th scope="col">Played</th><th scope="col">Best</th><th scope="col">Best score</th><th scope="col">Played score</th><th scope="col">CP loss</th><th scope="col">Label</th></tr></thead>`,
    `<tbody>`,
    review.entries.map(renderSavedReviewDetailMoveRow).join(""),
    `</tbody>`,
    `</table>`
  ].join("");
}

function renderSavedReviewDetailMoveRow(entry: ReviewEntryDto, index: number): string {
  const token = String(index);
  const bestMove = entry.bestMove ?? "none";
  return [
    `<tr data-review-ui="saved-review-detail-move-row" data-review-index="${token}">`,
    `<td><span data-review-ui="saved-review-detail-move-ply" data-review-index="${token}">${String(
      entry.ply
    )}</span></td>`,
    `<td><span data-review-ui="saved-review-detail-move-san" data-review-index="${token}">${escapeHtml(
      entry.san
    )}</span></td>`,
    `<td><span data-review-ui="saved-review-detail-move-played" data-review-index="${token}">${escapeHtml(
      entry.playedMove
    )}</span></td>`,
    `<td><span data-review-ui="saved-review-detail-move-best" data-review-index="${token}">${escapeHtml(
      bestMove
    )}</span></td>`,
    `<td><span data-review-ui="saved-review-detail-move-best-score" data-review-index="${token}">${formatCentipawnScore(
      entry.bestScoreCp
    )}</span></td>`,
    `<td><span data-review-ui="saved-review-detail-move-played-score" data-review-index="${token}">${formatCentipawnScore(
      entry.playedScoreCp
    )}</span></td>`,
    `<td><span data-review-ui="saved-review-detail-move-cp-loss" data-review-index="${token}">${formatCentipawnLoss(
      entry.cpLoss
    )}</span></td>`,
    `<td>${renderMoveLabelBadge("saved-review-detail-move-label", token, entry.label)}</td>`,
    `</tr>`
  ].join("");
}

function renderProfileBucket(
  bucket: ReviewProfileDto["plyBuckets"][number],
  index: number
): string {
  const token = String(index);
  return [
    `<li data-review-ui="profile-bucket-row" data-review-index="${token}">`,
    `<dl>`,
    renderIndexedFact("profile-bucket-name", token, "Ply bucket", bucketLabel(bucket.bucket)),
    renderIndexedFact("profile-bucket-total-moves", token, "Moves", String(bucket.totalMoves)),
    renderIndexedFact("profile-bucket-cp-loss-total", token, "CP loss", formatCentipawnLoss(bucket.cpLossTotal)),
    `</dl>`,
    `</li>`
  ].join("");
}

function renderObservedPatterns(profile: ReviewProfileDto["observedPatterns"]): string {
  return [
    `<section data-review-ui="observed-patterns" aria-labelledby="observed-patterns-title">`,
    `<h3 id="observed-patterns-title" data-review-ui="observed-patterns-title">Observed patterns</h3>`,
    `<dl>`,
    renderFact(
      "observed-pattern-saved-reviews",
      "Saved reviews",
      formatPlainCount(profile.savedReviews, "saved review")
    ),
    renderFact(
      "observed-pattern-reviewed-moves",
      "Reviewed moves",
      formatPlainCount(profile.reviewedMoves, "reviewed move")
    ),
    renderFact(
      "observed-pattern-artifact-backed-reviews",
      "Artifact-backed reviews",
      formatCountOf(profile.artifactBackedReviews, profile.savedReviews, "saved review")
    ),
    renderFact(
      "observed-pattern-artifact-missing-reviews",
      "Artifact-missing reviews",
      formatCountOf(profile.artifactMissingReviews, profile.savedReviews, "saved review")
    ),
    renderFact(
      "observed-pattern-key-moments",
      "Key moments",
      formatCountFrom(profile.keyMoments, profile.artifactBackedReviews, "artifact-backed review")
    ),
    renderFact(
      "observed-pattern-local-search-swings",
      "Local search swings",
      formatCountFrom(
        profile.localSearchSwings,
        profile.artifactBackedReviews,
        "artifact-backed review"
      )
    ),
    renderFact(
      "observed-pattern-fork-candidates",
      "Fork candidates",
      formatCountFrom(profile.forkCandidates, profile.artifactBackedReviews, "artifact-backed review")
    ),
    renderFact(
      "observed-pattern-retry-positions",
      "Retry positions",
      formatCountFrom(profile.retryPositions, profile.artifactBackedReviews, "artifact-backed review")
    ),
    `</dl>`,
    `</section>`
  ].join("");
}

function bucketLabel(bucket: ReviewProfileDto["plyBuckets"][number]["bucket"]): string {
  switch (bucket) {
    case "plies-1-10":
      return "Plies 1-10";
    case "plies-11-40":
      return "Plies 11-40";
    case "plies-41-plus":
      return "Plies 41+";
  }
}

function formatPlainCount(count: number, singular: string): string {
  return `${String(count)} ${pluralize(count, singular)}`;
}

function formatCountOf(count: number, denominator: number, denominatorSingular: string): string {
  return `${String(count)} of ${String(denominator)} ${pluralize(denominator, denominatorSingular)}`;
}

function formatCountFrom(count: number, denominator: number, denominatorSingular: string): string {
  return `${String(count)} from ${String(denominator)} ${pluralize(denominator, denominatorSingular)}`;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function renderSummaryFacts(prefix: string, summary: ReviewSummaryDto): string {
  return [
    renderFact(`${prefix}-total-moves`, "Total moves", String(summary.totalMoves)),
    renderFact(`${prefix}-best`, "Best", String(summary.best)),
    renderFact(`${prefix}-good`, "Good", String(summary.good)),
    renderFact(`${prefix}-inaccuracies`, "Inaccuracies", String(summary.inaccuracies)),
    renderFact(`${prefix}-mistakes`, "Mistakes", String(summary.mistakes)),
    renderFact(`${prefix}-blunders`, "Blunders", String(summary.blunders))
  ].join("");
}

function renderIndexedSummaryFacts(prefix: string, index: string, summary: ReviewSummaryDto): string {
  return [
    renderIndexedFact(`${prefix}-best`, index, "Best", String(summary.best)),
    renderIndexedFact(`${prefix}-good`, index, "Good", String(summary.good)),
    renderIndexedFact(`${prefix}-inaccuracies`, index, "Inaccuracies", String(summary.inaccuracies)),
    renderIndexedFact(`${prefix}-mistakes`, index, "Mistakes", String(summary.mistakes)),
    renderIndexedFact(`${prefix}-blunders`, index, "Blunders", String(summary.blunders))
  ].join("");
}

function formatSavedAt(savedAtIso: string): string {
  const timestamp = Date.parse(savedAtIso);
  if (!Number.isFinite(timestamp)) {
    return "Saved time unavailable";
  }

  const savedAt = new Date(timestamp);
  return `${formatUtcYear(savedAt.getUTCFullYear())}-${padUtcPart(
    savedAt.getUTCMonth() + 1
  )}-${padUtcPart(savedAt.getUTCDate())} ${padUtcPart(savedAt.getUTCHours())}:${padUtcPart(
    savedAt.getUTCMinutes()
  )} UTC`;
}

function formatMoveLabel(label: MoveLabelDto): string {
  switch (label) {
    case "best":
      return "Best";
    case "good":
      return "Good";
    case "inaccuracy":
      return "Inaccuracy";
    case "mistake":
      return "Mistake";
    case "blunder":
      return "Blunder";
  }
}

function renderMoveLabelBadge(uiName: string, index: string, label: MoveLabelDto): string {
  return `<span data-review-ui="${uiName}" data-review-index="${index}" data-label="${escapeHtml(
    label
  )}">${escapeHtml(formatMoveLabel(label))}</span>`;
}

function formatCentipawnScore(score: number): string {
  if (score === 0) {
    return "0 cp";
  }
  return `${score > 0 ? "+" : ""}${String(score)} cp`;
}

function formatCentipawnLoss(loss: number): string {
  return `${String(loss)} cp`;
}

function formatCentipawnSwing(bestScore: number, playedScore: number): string {
  return `${formatCentipawnScore(bestScore)} to ${formatCentipawnScore(playedScore)}`;
}

function formatPiece(piece: ReviewArtifactsDto["forkCandidates"][number]["movedPiece"]): string {
  return `${formatColor(piece.color)} ${piece.kind}`;
}

function formatForkTargets(
  targets: readonly ReviewArtifactsDto["forkCandidates"][number]["targets"][number][]
): string {
  return targets.length === 0
    ? "none"
    : targets.map((target) => `${target.square} ${formatPiece(target.piece)}`).join(", ");
}

function formatColor(color: ReviewArtifactsDto["forkCandidates"][number]["movedPiece"]["color"]): string {
  return color === "white" ? "White" : "Black";
}

function formatUtcYear(year: number): string {
  return String(year).padStart(4, "0");
}

function padUtcPart(value: number): string {
  return String(value).padStart(2, "0");
}

function renderFact(name: string, label: string, value: string): string {
  return `<div data-review-ui="${name}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(
    value
  )}</dd></div>`;
}

function renderIndexedFact(name: string, index: string, label: string, value: string): string {
  return `<div data-review-ui="${name}" data-review-index="${index}"><dt>${escapeHtml(
    label
  )}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function errorLabel(error: ReviewWorkflowError | null, copy: ReturnType<typeof copyFor>): string {
  if (error === null) {
    return "";
  }
  switch (error.source) {
    case "review":
      return reviewErrorLabel(error.reason, copy);
    case "store":
      return storeErrorLabel(error.reason, copy);
    case "metadata":
      return copy.locale === "es" ? "No se pudo guardar la metadata" : "Save metadata unavailable";
    case "workflow":
      return copy.locale === "es" ? "No hay revisión para guardar" : "No review to save";
  }
}

function reviewErrorLabel(error: WasmBridgeError, copy: ReturnType<typeof copyFor>): string {
  switch (error) {
    case "invalid-pgn":
      return copy.locale === "es" ? "PGN inválido" : "Invalid PGN";
    case "invalid-depth":
      return copy.locale === "es" ? "Profundidad de revisión inválida" : "Invalid review depth";
    case "invalid-move":
      return copy.locale === "es" ? "Movimiento ilegal" : "Illegal move";
    case "invalid-position":
    case "invalid-fen":
      return copy.locale === "es" ? "Posición inválida" : "Invalid position";
    case "search-failed":
      return copy.locale === "es" ? "La revisión falló" : "Review failed";
  }
}

function storeErrorLabel(error: ReviewStoreError, copy: ReturnType<typeof copyFor>): string {
  switch (error) {
    case "corrupt-store":
      return copy.locale === "es" ? "No se pudieron leer las revisiones guardadas" : "Stored reviews could not be read";
    case "unsupported-schema":
      return copy.locale === "es" ? "Las revisiones usan un esquema más reciente" : "Stored reviews use a newer schema";
    case "record-limit-exceeded":
      return copy.locale === "es" ? "Se alcanzó el límite de revisiones guardadas" : "Stored review limit reached";
    case "entry-limit-exceeded":
      return copy.locale === "es" ? "La revisión es demasiado grande para guardar" : "Review is too large to save";
    case "storage-unavailable":
      return copy.locale === "es" ? "Las revisiones guardadas no están disponibles" : "Stored reviews are unavailable";
    case "storage-read-failed":
      return copy.locale === "es" ? "No se pudieron leer las revisiones guardadas" : "Stored reviews could not be read";
    case "storage-write-failed":
      return copy.locale === "es" ? "No se pudieron guardar las revisiones" : "Stored reviews could not be saved";
    case "storage-quota-exceeded":
      return copy.locale === "es" ? "La cuota de revisiones guardadas está llena" : "Stored review quota is full";
    case "storage-remove-failed":
      return copy.locale === "es" ? "No se pudieron eliminar las revisiones guardadas" : "Stored reviews could not be removed";
  }
}

function isApprovedDepth(depth: number): depth is (typeof depthOptions)[number] {
  return depthOptions.some((allowed) => allowed === depth);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function captureFocus(root: HTMLElement): FocusSnapshot | null {
  if (typeof document === "undefined") {
    return null;
  }
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) {
    return null;
  }
  const name = active.getAttribute("data-review-ui");
  if (
    isTextFocusTarget(name) &&
    (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
  ) {
    return {
      name,
      selectionStart: active.selectionStart,
      selectionEnd: active.selectionEnd
    };
  }
  if (name === "depth-control" || name === "analysis-report-input") {
    return { name };
  }
  return null;
}

function restoreFocus(root: HTMLElement, snapshot: FocusSnapshot | null): void {
  if (snapshot === null) {
    return;
  }
  const restore = (deferred: boolean): void => {
    const element = queryUi(root, snapshot.name);
    if (!(element instanceof HTMLElement)) {
      return;
    }
    if (deferred) {
      const active = typeof document === "undefined" ? null : document.activeElement;
      if (active instanceof HTMLElement && root.contains(active) && active !== element) {
        return;
      }
    }
    element.focus();
    if (
      "selectionStart" in snapshot &&
      (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)
    ) {
      const selectionStart =
        snapshot.name === "pgn-input"
          ? Math.min(snapshot.selectionStart ?? element.value.length, element.value.length)
          : element.value.length;
      const selectionEnd =
        snapshot.name === "pgn-input"
          ? Math.min(snapshot.selectionEnd ?? selectionStart, element.value.length)
          : selectionStart;
      element.setSelectionRange(selectionStart, selectionEnd);
    }
  };
  restore(false);
  if ("selectionStart" in snapshot) {
    if (typeof queueMicrotask === "function") {
      queueMicrotask(() => {
        restore(true);
      });
    }
    setTimeout(() => {
      restore(true);
    }, 0);
  }
}

function isTextFocusTarget(name: string | null): name is TextFocusTarget {
  return (
    name === "pgn-input" ||
    name === "retry-practice-input" ||
    name === "saved-review-detail-practice-input"
  );
}
