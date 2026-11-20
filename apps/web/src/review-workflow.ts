import type {
  GameReviewDto,
  ReviewArtifactsDto,
  ReviewPgnRequestDto,
  WasmBridgeError
} from "./engine-dtos.js";
import {
  buildSavedRetryRouteAvailability,
  buildReviewProfile,
  clearReviewStore,
  deleteStoredReview,
  readReviewStore,
  upsertStoredReview,
  type ReviewProfileDto,
  type SavedRetryRouteAvailabilityDto,
  type ReviewStoreError,
  type ReviewStoreV3,
  type StoredReviewV3,
  type StorageLike
} from "./review-store.js";

export type ReviewWorkflowStatus = "idle" | "reviewing" | "reviewed" | "failed";

export type ReviewWorkflowError =
  | { readonly source: "review"; readonly reason: WasmBridgeError }
  | { readonly source: "store"; readonly reason: ReviewStoreError }
  | { readonly source: "metadata"; readonly reason: "metadata-unavailable" }
  | { readonly source: "workflow"; readonly reason: "no-current-review" };

export type ReviewWorkflowState = {
  readonly inlinePgn: string;
  readonly depth: number;
  readonly status: ReviewWorkflowStatus;
  readonly currentReview: GameReviewDto | null;
  readonly currentArtifacts: ReviewArtifactsDto | null;
  readonly pendingReviewRequest: ReviewPgnRequestDto | null;
  readonly pendingClearSavedReviews: boolean;
  readonly pendingRecoverSavedReviewStore: boolean;
  readonly selectedSavedReviewId: string | null;
  readonly lastSavedReviewId: string | null;
  readonly error: ReviewWorkflowError | null;
  readonly store: ReviewStoreV3 | null;
  readonly profile: ReviewProfileDto | null;
};

export type ReviewWorkflowReviewResult =
  | { readonly ok: true; readonly review: GameReviewDto; readonly artifacts: ReviewArtifactsDto | null }
  | { readonly ok: false; readonly error: WasmBridgeError };

export type ReviewPgnForWorkflow = (
  request: ReviewPgnRequestDto
) => Promise<ReviewWorkflowReviewResult>;

export type SaveWorkflowReviewMetadata = {
  readonly id: string;
  readonly savedAtIso: string;
};

export type SaveWorkflowReviewMetadataResult =
  | { readonly ok: true; readonly metadata: SaveWorkflowReviewMetadata }
  | { readonly ok: false; readonly error: "metadata-unavailable" };

export function createInitialReviewWorkflow(storage: StorageLike): ReviewWorkflowState {
  const store = readReviewStore(storage);
  if (typeof store === "string") {
    return {
      ...baseState(),
      status: "failed",
      error: { source: "store", reason: store }
    };
  }

  return withStore(baseState(), store);
}

export function editWorkflowPgn(
  state: ReviewWorkflowState,
  inlinePgn: string
): ReviewWorkflowState {
  if (state.status === "reviewing") {
    return state;
  }
  return resetReview({ ...state, inlinePgn });
}

export function setWorkflowDepth(
  state: ReviewWorkflowState,
  depth: number
): ReviewWorkflowState {
  if (state.status === "reviewing") {
    return state;
  }
  return resetReview({ ...state, depth });
}

export function beginWorkflowReview(state: ReviewWorkflowState): ReviewWorkflowState {
  if (state.status === "reviewing") {
    return state;
  }
  return {
    ...state,
    status: "reviewing",
    currentReview: null,
    currentArtifacts: null,
    pendingReviewRequest: { pgn: state.inlinePgn, depth: state.depth },
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: false,
    lastSavedReviewId: null,
    error: null
  };
}

export function finishWorkflowReview(
  state: ReviewWorkflowState,
  result: ReviewWorkflowReviewResult,
  request: ReviewPgnRequestDto | null = state.pendingReviewRequest
): ReviewWorkflowState {
  if (state.pendingReviewRequest === null) {
    if (request !== null || state.status !== "idle") {
      return state;
    }
  } else if (request === null || !sameReviewRequest(state.pendingReviewRequest, request)) {
    return state;
  }

  if (result.ok) {
    return {
      ...state,
      status: "reviewed",
      currentReview: result.review,
      currentArtifacts: result.artifacts,
      pendingReviewRequest: null,
      pendingClearSavedReviews: false,
      pendingRecoverSavedReviewStore: false,
      lastSavedReviewId: null,
      error: null
    };
  }

  return {
    ...state,
    status: "failed",
    currentReview: null,
    currentArtifacts: null,
    pendingReviewRequest: null,
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: false,
    lastSavedReviewId: null,
    error: { source: "review", reason: result.error }
  };
}

export async function runWorkflowReview(
  state: ReviewWorkflowState,
  reviewPgn: ReviewPgnForWorkflow
): Promise<ReviewWorkflowState> {
  if (state.status === "reviewing") {
    return state;
  }
  const reviewing = beginWorkflowReview(state);
  if (reviewing.pendingReviewRequest === null) {
    return reviewing;
  }
  const request = reviewing.pendingReviewRequest;
  const result = await reviewPgn(request);
  return finishWorkflowReview(reviewing, result, request);
}

export function saveWorkflowReview(
  storage: StorageLike,
  state: ReviewWorkflowState,
  metadata: SaveWorkflowReviewMetadata
): ReviewWorkflowState {
  if (state.currentReview === null) {
    return {
      ...state,
      status: "failed",
      pendingClearSavedReviews: false,
      pendingRecoverSavedReviewStore: false,
      error: { source: "workflow", reason: "no-current-review" }
    };
  }
  if (isCurrentReviewSaved(state)) {
    return { ...state, pendingClearSavedReviews: false, pendingRecoverSavedReviewStore: false };
  }

  const store = upsertStoredReview(storage, {
    id: metadata.id,
    savedAtIso: metadata.savedAtIso,
    source: "review-pgn",
    sourcePgn: state.inlinePgn,
    review: state.currentReview,
    artifacts: state.currentArtifacts
  });
  if (typeof store === "string") {
    return withStoreError(state, store);
  }

  return {
    ...withStore(state, store),
    status: statusAfterStoreWrite(state),
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: false,
    lastSavedReviewId: metadata.id,
    error: null
  };
}

export function requestWorkflowClearReviews(state: ReviewWorkflowState): ReviewWorkflowState {
  if (state.status === "reviewing" || state.store === null || state.store.reviews.length === 0) {
    return { ...state, pendingClearSavedReviews: false, pendingRecoverSavedReviewStore: false };
  }
  return { ...state, pendingClearSavedReviews: true, pendingRecoverSavedReviewStore: false };
}

export function cancelWorkflowClearReviews(state: ReviewWorkflowState): ReviewWorkflowState {
  return { ...state, pendingClearSavedReviews: false };
}

export function confirmWorkflowClearReviews(
  storage: StorageLike,
  state: ReviewWorkflowState
): ReviewWorkflowState {
  if (!state.pendingClearSavedReviews) {
    return state;
  }
  return clearWorkflowReviews(storage, state);
}

export function requestWorkflowRecoverSavedReviewStore(
  state: ReviewWorkflowState
): ReviewWorkflowState {
  if (state.status === "reviewing" || !isRecoverableStoreError(state.error)) {
    return { ...state, pendingRecoverSavedReviewStore: false };
  }
  return {
    ...state,
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: true
  };
}

export function cancelWorkflowRecoverSavedReviewStore(
  state: ReviewWorkflowState
): ReviewWorkflowState {
  return { ...state, pendingRecoverSavedReviewStore: false };
}

export function confirmWorkflowRecoverSavedReviewStore(
  storage: StorageLike,
  state: ReviewWorkflowState
): ReviewWorkflowState {
  if (!state.pendingRecoverSavedReviewStore || !isRecoverableStoreError(state.error)) {
    return state;
  }

  const store = clearReviewStore(storage);
  if (typeof store === "string") {
    return withStoreError(state, store);
  }

  return {
    ...withStore(state, store),
    status: statusAfterStoreWrite(state),
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: false,
    selectedSavedReviewId: null,
    lastSavedReviewId: null,
    error: null
  };
}

export function selectWorkflowSavedReview(
  state: ReviewWorkflowState,
  id: string
): ReviewWorkflowState {
  const selected = state.store?.reviews.find((review) => review.id === id) ?? null;
  return {
    ...state,
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: false,
    selectedSavedReviewId: selected === null ? null : selected.id
  };
}

export function getSelectedSavedReview(state: ReviewWorkflowState): StoredReviewV3 | null {
  const selectedId = state.selectedSavedReviewId;
  if (selectedId === null) {
    return null;
  }
  return state.store?.reviews.find((review) => review.id === selectedId) ?? null;
}

export function getSavedRetryRouteAvailability(
  state: ReviewWorkflowState
): SavedRetryRouteAvailabilityDto | null {
  if (state.store === null || state.error?.source === "store") {
    return null;
  }
  return buildSavedRetryRouteAvailability(state.store.reviews);
}

export function isCurrentReviewSaved(state: ReviewWorkflowState): boolean {
  return state.currentReview !== null && state.lastSavedReviewId !== null;
}

export function deleteWorkflowReview(
  storage: StorageLike,
  state: ReviewWorkflowState,
  id: string
): ReviewWorkflowState {
  const store = deleteStoredReview(storage, id);
  if (typeof store === "string") {
    return withStoreError(state, store);
  }

  return {
    ...withStore(state, store),
    status: statusAfterStoreWrite(state),
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: false,
    lastSavedReviewId: state.lastSavedReviewId === id ? null : state.lastSavedReviewId,
    selectedSavedReviewId:
      state.selectedSavedReviewId === id ? null : state.selectedSavedReviewId,
    error: null
  };
}

function clearWorkflowReviews(
  storage: StorageLike,
  state: ReviewWorkflowState
): ReviewWorkflowState {
  const store = clearReviewStore(storage);
  if (typeof store === "string") {
    return withStoreError(state, store);
  }
  return {
    ...withStore(state, store),
    status: statusAfterStoreWrite(state),
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: false,
    selectedSavedReviewId: null,
    lastSavedReviewId: null,
    error: null
  };
}

export function failWorkflowSaveMetadata(
  state: ReviewWorkflowState,
  reason: "metadata-unavailable"
): ReviewWorkflowState {
  return {
    ...state,
    status: "failed",
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: false,
    error: { source: "metadata", reason }
  };
}

function baseState(): ReviewWorkflowState {
  return {
    inlinePgn: "",
    depth: 3,
    status: "idle",
    currentReview: null,
    currentArtifacts: null,
    pendingReviewRequest: null,
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: false,
    selectedSavedReviewId: null,
    lastSavedReviewId: null,
    error: null,
    store: null,
    profile: null
  };
}

function resetReview(state: ReviewWorkflowState): ReviewWorkflowState {
  return {
    ...state,
    status: "idle",
    currentReview: null,
    currentArtifacts: null,
    pendingReviewRequest: null,
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: false,
    lastSavedReviewId: null,
    error: null
  };
}

function isRecoverableStoreError(error: ReviewWorkflowError | null): boolean {
  return (
    error?.source === "store" &&
    (error.reason === "corrupt-store" || error.reason === "unsupported-schema")
  );
}

function sameReviewRequest(left: ReviewPgnRequestDto, right: ReviewPgnRequestDto): boolean {
  return left.pgn === right.pgn && left.depth === right.depth;
}

function withStore(state: ReviewWorkflowState, store: ReviewStoreV3): ReviewWorkflowState {
  return {
    ...state,
    store,
    profile: buildReviewProfile(store.reviews),
    error: null
  };
}

function withStoreError(
  state: ReviewWorkflowState,
  reason: ReviewStoreError
): ReviewWorkflowState {
  return {
    ...state,
    status: "failed",
    pendingClearSavedReviews: false,
    pendingRecoverSavedReviewStore: false,
    error: { source: "store", reason }
  };
}

function statusAfterStoreWrite(state: ReviewWorkflowState): ReviewWorkflowStatus {
  return state.currentReview === null ? "idle" : "reviewed";
}
