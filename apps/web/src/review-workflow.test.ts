import type {
  GameReviewDto,
  ReviewArtifactsDto,
  ReviewEntryDto,
  ReviewPgnRequestDto,
  ReviewSummaryDto,
  WasmBridgeError
} from "./engine-dtos";
import type {
  SavedRetryRouteAvailabilityDto,
  SavedRetryRouteFilterAvailabilityDto,
  StorageLike,
  StoredReviewV3
} from "./review-store";
import { storageOperationError } from "./review-store";
import {
  beginWorkflowReview,
  createInitialReviewWorkflow,
  deleteWorkflowReview,
  editWorkflowPgn,
  finishWorkflowReview,
  failWorkflowSaveMetadata,
  getSavedRetryRouteAvailability,
  getSelectedSavedReview,
  cancelWorkflowClearReviews,
  confirmWorkflowClearReviews,
  cancelWorkflowRecoverSavedReviewStore,
  confirmWorkflowRecoverSavedReviewStore,
  runWorkflowReview,
  saveWorkflowReview,
  selectWorkflowSavedReview,
  setWorkflowDepth,
  requestWorkflowClearReviews,
  requestWorkflowRecoverSavedReviewStore,
  type ReviewPgnForWorkflow,
  type ReviewWorkflowState
} from "./review-workflow";

type MemoryStorage = StorageLike & {
  readonly entries: () => ReadonlyMap<string, string>;
};

function memoryStorage(initial: ReadonlyMap<string, string> = new Map()): MemoryStorage {
  const values = new Map(initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    entries: () => values
  };
}

function throwingStorage(operation: "setItem" | "removeItem"): StorageLike {
  return {
    getItem: () => null,
    setItem: () => {
      if (operation === "setItem") {
        throw storageOperationError("storage-quota-exceeded");
      }
    },
    removeItem: () => {
      if (operation === "removeItem") {
        throw storageOperationError("storage-remove-failed");
      }
    }
  };
}

function expectEqual<T>(actual: T, expected: T): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`expected ${expectedText}, got ${actualText}`);
  }
}

function summary(overrides: Partial<ReviewSummaryDto> = {}): ReviewSummaryDto {
  return {
    totalMoves: 0,
    best: 0,
    good: 0,
    inaccuracies: 0,
    mistakes: 0,
    blunders: 0,
    ...overrides
  };
}

function observedPatterns(
  overrides: Partial<NonNullable<ReviewWorkflowState["profile"]>["observedPatterns"]> = {}
): NonNullable<ReviewWorkflowState["profile"]>["observedPatterns"] {
  return {
    savedReviews: 0,
    reviewedMoves: 0,
    artifactBackedReviews: 0,
    artifactMissingReviews: 0,
    keyMoments: 0,
    localSearchSwings: 0,
    forkCandidates: 0,
    retryPositions: 0,
    ...overrides
  };
}

function routeFilter(
  kind: SavedRetryRouteFilterAvailabilityDto["kind"],
  artifactCount = 0,
  matchedRetryPositions = 0,
  route: SavedRetryRouteFilterAvailabilityDto["route"] = null
): SavedRetryRouteFilterAvailabilityDto {
  return { kind, artifactCount, matchedRetryPositions, route };
}

function routeFilters(
  keyMoments = routeFilter("key-moments"),
  localSearchSwings = routeFilter("local-search-swings"),
  forkCandidates = routeFilter("fork-candidates")
): SavedRetryRouteAvailabilityDto["filters"] {
  return [keyMoments, localSearchSwings, forkCandidates];
}

function entry(ply: number, label: ReviewEntryDto["label"], cpLoss: number): ReviewEntryDto {
  return {
    ply,
    playedMove: "e2e4",
    san: "e4",
    bestMove: "a2a3",
    bestScoreCp: 20,
    playedScoreCp: 20 - cpLoss,
    cpLoss,
    label
  };
}

function review(entries: readonly ReviewEntryDto[]): GameReviewDto {
  return {
    summary: summary({ totalMoves: entries.length }),
    entries
  };
}

function storedReview(
  id: string,
  entries: readonly ReviewEntryDto[],
  artifacts: ReviewArtifactsDto | null = null
): StoredReviewV3 {
  return {
    id,
    savedAtIso: "2026-05-15T12:00:00.000Z",
    source: "review-pgn",
    sourcePgn: null,
    review: review(entries),
    artifacts
  };
}

function requireStored(record: StoredReviewV3 | undefined): StoredReviewV3 {
  if (record === undefined) {
    throw new Error("test fixture review should exist");
  }
  return record;
}

function requireRetryPosition(
  retry: ReviewArtifactsDto["retryPositions"][number] | undefined
): ReviewArtifactsDto["retryPositions"][number] {
  if (retry === undefined) {
    throw new Error("test fixture retry position should exist");
  }
  return retry;
}

function requireStateStore(state: ReviewWorkflowState): NonNullable<ReviewWorkflowState["store"]> {
  if (state.store === null) {
    throw new Error("workflow store should exist");
  }
  return state.store;
}

function requireStateProfile(
  state: ReviewWorkflowState
): NonNullable<ReviewWorkflowState["profile"]> {
  if (state.profile === null) {
    throw new Error("workflow profile should exist");
  }
  return state.profile;
}

const storeKey = "chess.trainer.reviewStore.v1";
const oneReviewStore = {
  schemaVersion: 3,
  reviews: [storedReview("stored", [entry(1, "mistake", 180)])]
} as const;
const reviewResult = review([entry(10, "best", 0), entry(41, "blunder", 450)]);
const artifactResult: ReviewArtifactsDto = {
  keyMoments: [],
  evidence: [],
  forkCandidates: [],
  earlyMoveDivergences: [],
  retryPositions: []
};
const routeArtifacts: ReviewArtifactsDto = {
  keyMoments: [
    {
      rank: 1,
      entryIndex: 0,
      kind: "centipawn-loss",
      ply: 1,
      playedMove: "g1f3",
      san: "Nf3",
      bestMove: "d2d4",
      bestScoreCp: 20,
      playedScoreCp: -60,
      cpLoss: 80,
      label: "inaccuracy"
    }
  ],
  evidence: [
    {
      rank: 1,
      entryIndex: 0,
      ply: 1,
      kind: "local-search-swing",
      playedMove: "g1f3",
      san: "Nf3",
      bestMove: "d2d4",
      bestScoreCp: 20,
      playedScoreCp: -60,
      cpLoss: 80,
      label: "inaccuracy"
    }
  ],
  forkCandidates: [
    {
      rank: 1,
      entryIndex: 0,
      ply: 1,
      sourceKind: "best-move-after-position",
      bestMove: "d2d4",
      movedPiece: { color: "white", kind: "pawn" },
      destination: "d4",
      targets: [
        { square: "e5", piece: { color: "black", kind: "pawn" } },
        { square: "d8", piece: { color: "black", kind: "queen" } }
      ],
      cpLoss: 80,
      label: "inaccuracy"
    }
  ],
  earlyMoveDivergences: [],
  retryPositions: [
    {
      rank: 1,
      entryIndex: 0,
      ply: 1,
      fenBefore: "rn1qkbnr/pppbpppp/8/3p4/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 3",
      playedMove: "g1f3",
      bestMove: "d2d4",
      san: "Nf3",
      label: "inaccuracy",
      cpLoss: 80
    }
  ]
};

const initialized = createInitialReviewWorkflow(
  memoryStorage(new Map([[storeKey, JSON.stringify(oneReviewStore)]]))
);
expectEqual(initialized.status, "idle");
expectEqual(initialized.pendingReviewRequest, null);
expectEqual(requireStateProfile(initialized).totalReviews, 1);
expectEqual(requireStateProfile(initialized).labelTotals.mistakes, 1);
expectEqual(requireStateProfile(initialized).observedPatterns, observedPatterns({
  savedReviews: 1,
  reviewedMoves: 1,
  artifactMissingReviews: 1
}));
expectEqual(getSelectedSavedReview(initialized), null);
const selectedStored = selectWorkflowSavedReview(initialized, "stored");
expectEqual(getSelectedSavedReview(selectedStored), requireStored(oneReviewStore.reviews[0]));
expectEqual(selectedStored.inlinePgn, initialized.inlinePgn);
expectEqual(selectedStored.currentReview, initialized.currentReview);
expectEqual(selectedStored.currentArtifacts, initialized.currentArtifacts);
expectEqual(selectedStored.pendingReviewRequest, initialized.pendingReviewRequest);
expectEqual(selectedStored.lastSavedReviewId, initialized.lastSavedReviewId);
expectEqual(getSelectedSavedReview(selectWorkflowSavedReview(initialized, "missing")), null);
expectEqual(getSavedRetryRouteAvailability(initialized)?.route ?? null, null);

const routeStore = {
  schemaVersion: 3,
  reviews: [
    storedReview("route", [entry(1, "inaccuracy", 80)], routeArtifacts),
    storedReview("route-missing", [entry(2, "good", 10)])
  ]
} as const;
const routeState = createInitialReviewWorkflow(
  memoryStorage(new Map([[storeKey, JSON.stringify(routeStore)]]))
);
const routeCandidate = {
  reviewId: "route",
  retryPositionIndex: 0,
  retryPosition: requireRetryPosition(routeArtifacts.retryPositions[0])
};
expectEqual(getSavedRetryRouteAvailability(routeState), {
  denominators: {
    savedReviews: 2,
    reviewedMoves: 2,
    artifactBackedReviews: 1,
    artifactMissingReviews: 1,
    savedRetryPositions: 1
  },
  route: routeCandidate,
  filters: routeFilters(
    routeFilter("key-moments", 1, 1, routeCandidate),
    routeFilter("local-search-swings", 1, 1, routeCandidate),
    routeFilter("fork-candidates", 1, 1, routeCandidate)
  )
});
expectEqual(
  getSavedRetryRouteAvailability({
    ...routeState,
    error: { source: "store", reason: "storage-write-failed" }
  }),
  null
);
expectEqual(getSavedRetryRouteAvailability({ ...routeState, store: null }), null);

const clearGuardStorage = memoryStorage(new Map([[storeKey, JSON.stringify(oneReviewStore)]]));
const clearGuardSelected = selectWorkflowSavedReview(
  createInitialReviewWorkflow(clearGuardStorage),
  "stored"
);
const armedClear = requestWorkflowClearReviews(clearGuardSelected);
expectEqual(armedClear.pendingClearSavedReviews, true);
expectEqual(JSON.parse(clearGuardStorage.entries().get(storeKey) ?? ""), oneReviewStore);
expectEqual(getSelectedSavedReview(armedClear), requireStored(oneReviewStore.reviews[0]));
const canceledClear = cancelWorkflowClearReviews(armedClear);
expectEqual(canceledClear.pendingClearSavedReviews, false);
expectEqual(JSON.parse(clearGuardStorage.entries().get(storeKey) ?? ""), oneReviewStore);
expectEqual(
  requestWorkflowClearReviews(
    createInitialReviewWorkflow(memoryStorage())
  ).pendingClearSavedReviews,
  false
);
expectEqual(editWorkflowPgn(armedClear, "1. e4 *").pendingClearSavedReviews, false);
expectEqual(beginWorkflowReview(armedClear).pendingClearSavedReviews, false);
expectEqual(selectWorkflowSavedReview(armedClear, "stored").pendingClearSavedReviews, false);

const corruptStorage = memoryStorage(new Map([[storeKey, "{"]]));
expectEqual(createInitialReviewWorkflow(corruptStorage), {
  inlinePgn: "",
  depth: 3,
  status: "failed",
  currentReview: null,
  currentArtifacts: null,
  pendingReviewRequest: null,
  pendingClearSavedReviews: false,
  pendingRecoverSavedReviewStore: false,
  selectedSavedReviewId: null,
  lastSavedReviewId: null,
  error: { source: "store", reason: "corrupt-store" },
  store: null,
  profile: null
});
expectEqual([...corruptStorage.entries()], [[storeKey, "{"]]);
const requestedCorruptRecovery = requestWorkflowRecoverSavedReviewStore(
  createInitialReviewWorkflow(corruptStorage)
);
expectEqual(requestedCorruptRecovery.pendingRecoverSavedReviewStore, true);
expectEqual([...corruptStorage.entries()], [[storeKey, "{"]]);
expectEqual(
  cancelWorkflowRecoverSavedReviewStore(requestedCorruptRecovery).pendingRecoverSavedReviewStore,
  false
);
expectEqual([...corruptStorage.entries()], [[storeKey, "{"]]);
const recoveredCorruptStore = confirmWorkflowRecoverSavedReviewStore(
  corruptStorage,
  requestedCorruptRecovery
);
expectEqual([...corruptStorage.entries()], []);
expectEqual(recoveredCorruptStore.status, "idle");
expectEqual(recoveredCorruptStore.error, null);
expectEqual(recoveredCorruptStore.pendingRecoverSavedReviewStore, false);
expectEqual(requireStateStore(recoveredCorruptStore), { schemaVersion: 3, reviews: [] });
expectEqual(requireStateProfile(recoveredCorruptStore).totalReviews, 0);
expectEqual(requireStateProfile(recoveredCorruptStore).observedPatterns, observedPatterns());
expectEqual(getSavedRetryRouteAvailability(recoveredCorruptStore), {
  denominators: {
    savedReviews: 0,
    reviewedMoves: 0,
    artifactBackedReviews: 0,
    artifactMissingReviews: 0,
    savedRetryPositions: 0
  },
  route: null,
  filters: routeFilters()
});
const unsupportedRecoveryStorage = memoryStorage(
  new Map([[storeKey, JSON.stringify({ schemaVersion: 4, reviews: [] })], ["other-key", "kept"]])
);
const unsupportedRecoveryState = requestWorkflowRecoverSavedReviewStore(
  createInitialReviewWorkflow(unsupportedRecoveryStorage)
);
expectEqual(unsupportedRecoveryState.pendingRecoverSavedReviewStore, true);
const recoveredUnsupportedStore = confirmWorkflowRecoverSavedReviewStore(
  unsupportedRecoveryStorage,
  unsupportedRecoveryState
);
expectEqual([...unsupportedRecoveryStorage.entries()], [["other-key", "kept"]]);
expectEqual(requireStateStore(recoveredUnsupportedStore), { schemaVersion: 3, reviews: [] });
expectEqual(requireStateProfile(recoveredUnsupportedStore).observedPatterns, observedPatterns());
expectEqual(getSavedRetryRouteAvailability(recoveredUnsupportedStore)?.route ?? null, null);
expectEqual(
  requestWorkflowRecoverSavedReviewStore({
    ...createInitialReviewWorkflow(memoryStorage()),
    status: "failed",
    error: { source: "store", reason: "storage-read-failed" }
  }).pendingRecoverSavedReviewStore,
  false
);
expectEqual(
  createInitialReviewWorkflow(
    memoryStorage(new Map([[storeKey, JSON.stringify({ schemaVersion: 4, reviews: [] })]]))
  ).error,
  { source: "store", reason: "unsupported-schema" }
);

const reviewedState = finishWorkflowReview(initialized, {
  ok: true,
  review: reviewResult,
  artifacts: null
});
const reviewedWithArtifacts = finishWorkflowReview(initialized, {
  ok: true,
  review: reviewResult,
  artifacts: artifactResult
});
const requestedState = setWorkflowDepth(editWorkflowPgn(initialized, " 1. e4 * "), 4);
expectEqual(reviewedWithArtifacts.currentArtifacts, artifactResult);
expectEqual(beginWorkflowReview(requestedState), {
  ...requestedState,
  status: "reviewing",
  currentReview: null,
  currentArtifacts: null,
  pendingReviewRequest: { pgn: " 1. e4 * ", depth: 4 },
  lastSavedReviewId: null,
  error: null
});
expectEqual(editWorkflowPgn(reviewedState, " 1. e4 * "), {
  ...reviewedState,
  inlinePgn: " 1. e4 * ",
  status: "idle",
  currentReview: null,
  currentArtifacts: null,
  pendingReviewRequest: null,
  lastSavedReviewId: null,
  error: null
});
expectEqual(setWorkflowDepth(reviewedState, 5), {
  ...reviewedState,
  depth: 5,
  status: "idle",
  currentReview: null,
  currentArtifacts: null,
  pendingReviewRequest: null,
  lastSavedReviewId: null,
  error: null
});
const reviewingState = beginWorkflowReview(requestedState);
expectEqual(editWorkflowPgn(reviewingState, " 1. d4 * "), reviewingState);
expectEqual(setWorkflowDepth(reviewingState, 5), reviewingState);

let capturedRequest = { pgn: "", depth: 0 };
const reviewPgn: ReviewPgnForWorkflow = (request: ReviewPgnRequestDto) => {
  capturedRequest = request;
  return Promise.resolve({ ok: true, review: reviewResult, artifacts: artifactResult });
};
const runState = await runWorkflowReview(requestedState, reviewPgn);
expectEqual(capturedRequest, { pgn: " 1. e4 * ", depth: 4 });
expectEqual(runState.currentReview, reviewResult);
expectEqual(runState.currentArtifacts, artifactResult);
expectEqual(runState.pendingReviewRequest, null);
expectEqual([...memoryStorage().entries()], []);

let duplicateReviewCalls = 0;
const duplicateRunState = await runWorkflowReview(reviewingState, () => {
  duplicateReviewCalls += 1;
  return Promise.resolve({ ok: true, review: reviewResult, artifacts: artifactResult });
});
expectEqual(duplicateRunState, reviewingState);
expectEqual(duplicateReviewCalls, 0);

const preSaveRouteStorage = memoryStorage();
const preSaveRouteState = await runWorkflowReview(
  editWorkflowPgn(createInitialReviewWorkflow(preSaveRouteStorage), " 1. Nf3 * "),
  () => Promise.resolve({ ok: true, review: reviewResult, artifacts: routeArtifacts })
);
expectEqual(getSavedRetryRouteAvailability(preSaveRouteState), {
  denominators: {
    savedReviews: 0,
    reviewedMoves: 0,
    artifactBackedReviews: 0,
    artifactMissingReviews: 0,
    savedRetryPositions: 0
  },
  route: null,
  filters: routeFilters()
});
const savedPreSaveRoute = saveWorkflowReview(preSaveRouteStorage, preSaveRouteState, {
  id: "pre-save-route",
  savedAtIso: "2026-05-15T14:00:00.000Z"
});
const savedPreSaveCandidate = {
  reviewId: "pre-save-route",
  retryPositionIndex: 0,
  retryPosition: requireRetryPosition(routeArtifacts.retryPositions[0])
};
expectEqual(getSavedRetryRouteAvailability(savedPreSaveRoute)?.filters[0], {
  ...routeFilter("key-moments", 1, 1, savedPreSaveCandidate)
});

const newerReview = review([entry(3, "good", 20)]);
const newerArtifacts: ReviewArtifactsDto = {
  keyMoments: [],
  evidence: [],
  forkCandidates: [],
  earlyMoveDivergences: [],
  retryPositions: []
};
const newerReviewedState = finishWorkflowReview(beginWorkflowReview(requestedState), {
  ok: true,
  review: newerReview,
  artifacts: newerArtifacts
});
expectEqual(
  finishWorkflowReview(newerReviewedState, {
    ok: true,
    review: reviewResult,
    artifacts: artifactResult
  }),
  newerReviewedState
);

const reviewErrors: readonly WasmBridgeError[] = [
  "invalid-fen",
  "invalid-pgn",
  "invalid-move",
  "invalid-depth",
  "invalid-position",
  "search-failed"
];
for (const error of reviewErrors) {
  expectEqual(finishWorkflowReview(beginWorkflowReview(reviewedState), { ok: false, error }).error, {
    source: "review",
    reason: error
  });
}

const noReviewStorage = memoryStorage();
const noReviewSave = saveWorkflowReview(noReviewStorage, initialized, {
  id: "not-written",
  savedAtIso: "2026-05-15T13:00:00.000Z"
});
expectEqual(noReviewSave.error, { source: "workflow", reason: "no-current-review" });
expectEqual([...noReviewStorage.entries()], []);

const saveStorage = memoryStorage();
const saved = saveWorkflowReview(saveStorage, runState, {
  id: "review-id",
  savedAtIso: "2026-05-15T13:00:00.000Z"
});
expectEqual(saved.lastSavedReviewId, "review-id");
expectEqual(requireStateProfile(saved).labelTotals.blunders, 1);
expectEqual(requireStateProfile(saved).observedPatterns, observedPatterns({
  savedReviews: 1,
  reviewedMoves: 2,
  artifactBackedReviews: 1
}));
expectEqual(JSON.parse(saveStorage.entries().get(storeKey) ?? ""), {
  schemaVersion: 3,
  reviews: [
    {
      id: "review-id",
      savedAtIso: "2026-05-15T13:00:00.000Z",
      source: "review-pgn",
      sourcePgn: " 1. e4 * ",
      review: reviewResult,
      artifacts: artifactResult
    }
  ]
});

const duplicateSaved = saveWorkflowReview(saveStorage, saved, {
  id: "second-review-id",
  savedAtIso: "2026-05-15T13:01:00.000Z"
});
expectEqual(duplicateSaved, saved);
expectEqual(JSON.parse(saveStorage.entries().get(storeKey) ?? ""), {
  schemaVersion: 3,
  reviews: [
    {
      id: "review-id",
      savedAtIso: "2026-05-15T13:00:00.000Z",
      source: "review-pgn",
      sourcePgn: " 1. e4 * ",
      review: reviewResult,
      artifacts: artifactResult
    }
  ]
});

const twoStored = {
  schemaVersion: 3,
  reviews: [storedReview("keep", [entry(1, "good", 10)]), storedReview("delete", [entry(1, "blunder", 450)])]
} as const;
const deleteStorage = memoryStorage(new Map([[storeKey, JSON.stringify(twoStored)]]));
const deleteState = {
  ...createInitialReviewWorkflow(deleteStorage),
  currentReview: reviewResult,
  lastSavedReviewId: "delete",
  status: "reviewed" as const
};
const deleted = deleteWorkflowReview(deleteStorage, deleteState, "delete");
expectEqual(requireStateStore(deleted).reviews, [requireStored(twoStored.reviews[0])]);
expectEqual(requireStateProfile(deleted).labelTotals.good, 1);
expectEqual(requireStateProfile(deleted).observedPatterns, observedPatterns({
  savedReviews: 1,
  reviewedMoves: 1,
  artifactMissingReviews: 1
}));
expectEqual(deleted.lastSavedReviewId, null);
expectEqual(deleteWorkflowReview(deleteStorage, requestWorkflowClearReviews(deleteState), "delete").pendingClearSavedReviews, false);

const unrelatedDeleteStorage = memoryStorage(new Map([[storeKey, JSON.stringify(twoStored)]]));
const unrelatedDeleteState = {
  ...createInitialReviewWorkflow(unrelatedDeleteStorage),
  currentReview: reviewResult,
  lastSavedReviewId: "delete",
  status: "reviewed" as const
};
const unrelatedDeleted = deleteWorkflowReview(unrelatedDeleteStorage, unrelatedDeleteState, "keep");
expectEqual(unrelatedDeleted.lastSavedReviewId, "delete");
expectEqual(requireStateStore(unrelatedDeleted).reviews, [requireStored(twoStored.reviews[1])]);
expectEqual(requireStateProfile(unrelatedDeleted).observedPatterns, observedPatterns({
  savedReviews: 1,
  reviewedMoves: 1,
  artifactMissingReviews: 1
}));

const selectedDeleteState = selectWorkflowSavedReview(
  createInitialReviewWorkflow(memoryStorage(new Map([[storeKey, JSON.stringify(twoStored)]]))),
  "delete"
);
const selectedDeleted = deleteWorkflowReview(
  memoryStorage(new Map([[storeKey, JSON.stringify(twoStored)]])),
  selectedDeleteState,
  "delete"
);
expectEqual(getSelectedSavedReview(selectedDeleted), null);
const selectedUnrelatedDeleted = deleteWorkflowReview(
  memoryStorage(new Map([[storeKey, JSON.stringify(twoStored)]])),
  selectedDeleteState,
  "keep"
);
expectEqual(getSelectedSavedReview(selectedUnrelatedDeleted), requireStored(twoStored.reviews[1]));

const unconfirmedClear = confirmWorkflowClearReviews(saveStorage, saved);
expectEqual(unconfirmedClear, saved);
expectEqual(requireStateStore(unconfirmedClear).reviews.length, 1);
const cleared = confirmWorkflowClearReviews(saveStorage, requestWorkflowClearReviews(saved));
expectEqual(requireStateStore(cleared), { schemaVersion: 3, reviews: [] });
expectEqual(requireStateProfile(cleared).totalReviews, 0);
expectEqual(requireStateProfile(cleared).observedPatterns, observedPatterns());
expectEqual(cleared.currentReview, reviewResult);
expectEqual(cleared.lastSavedReviewId, null);
expectEqual(cleared.pendingClearSavedReviews, false);
expectEqual(
  getSelectedSavedReview(confirmWorkflowClearReviews(saveStorage, requestWorkflowClearReviews(selectedStored))),
  null
);
const routeDeleted = deleteWorkflowReview(
  memoryStorage(new Map([[storeKey, JSON.stringify(routeStore)]])),
  routeState,
  "route"
);
expectEqual(getSavedRetryRouteAvailability(routeDeleted)?.route ?? null, null);
expectEqual(getSavedRetryRouteAvailability(routeDeleted)?.filters ?? [], routeFilters());
expectEqual(
  getSavedRetryRouteAvailability(
    deleteWorkflowReview(
      memoryStorage(new Map([[storeKey, JSON.stringify(routeStore)]])),
      routeState,
      "route-missing"
    )
  )?.filters[2]?.route?.reviewId ?? null,
  "route"
);
const routeCleared = confirmWorkflowClearReviews(
  memoryStorage(new Map([[storeKey, JSON.stringify(routeStore)]])),
  requestWorkflowClearReviews(routeState)
);
expectEqual(getSavedRetryRouteAvailability(routeCleared), {
  denominators: {
    savedReviews: 0,
    reviewedMoves: 0,
    artifactBackedReviews: 0,
    artifactMissingReviews: 0,
    savedRetryPositions: 0
  },
  route: null,
  filters: routeFilters()
});

const failedClear = confirmWorkflowClearReviews(throwingStorage("removeItem"), requestWorkflowClearReviews(saved));
expectEqual(failedClear.error, { source: "store", reason: "storage-remove-failed" });
expectEqual(failedClear.pendingClearSavedReviews, false);
expectEqual(failedClear.store, saved.store);
expectEqual(failedClear.profile, saved.profile);
expectEqual(failedClear.currentReview, saved.currentReview);
expectEqual(failedClear.currentArtifacts, saved.currentArtifacts);
expectEqual(failedClear.pendingReviewRequest, saved.pendingReviewRequest);
const failedRouteClear = confirmWorkflowClearReviews(
  throwingStorage("removeItem"),
  requestWorkflowClearReviews(routeState)
);
expectEqual(failedRouteClear.error, { source: "store", reason: "storage-remove-failed" });
expectEqual(getSavedRetryRouteAvailability(failedRouteClear), null);

const failedQuotaSave = saveWorkflowReview(throwingStorage("setItem"), runState, {
  id: "quota",
  savedAtIso: "2026-05-15T14:30:00.000Z"
});
expectEqual(failedQuotaSave.error, { source: "store", reason: "storage-quota-exceeded" });
expectEqual(failedQuotaSave.currentReview, runState.currentReview);
expectEqual(failedQuotaSave.currentArtifacts, runState.currentArtifacts);
expectEqual(failedQuotaSave.pendingReviewRequest, runState.pendingReviewRequest);

const failedMetadataSave = failWorkflowSaveMetadata(saved, "metadata-unavailable");
expectEqual(failedMetadataSave.error, { source: "metadata", reason: "metadata-unavailable" });
expectEqual(failedMetadataSave.currentReview, saved.currentReview);
expectEqual(failedMetadataSave.currentArtifacts, saved.currentArtifacts);
expectEqual(failedMetadataSave.pendingReviewRequest, saved.pendingReviewRequest);
expectEqual(failedMetadataSave.store, saved.store);
expectEqual(failedMetadataSave.profile, saved.profile);

const staleGoodState = createInitialReviewWorkflow(
  memoryStorage(new Map([[storeKey, JSON.stringify(oneReviewStore)]]))
);
const brokenStorage = memoryStorage(new Map([[storeKey, "{"]]));
const failedStoreSave = saveWorkflowReview(
  brokenStorage,
  { ...staleGoodState, currentReview: reviewResult, status: "reviewed" },
  { id: "blocked", savedAtIso: "2026-05-15T14:00:00.000Z" }
);
expectEqual(failedStoreSave.error, { source: "store", reason: "corrupt-store" });
expectEqual(failedStoreSave.currentReview, reviewResult);
expectEqual(failedStoreSave.currentArtifacts, null);
expectEqual(failedStoreSave.pendingReviewRequest, null);
expectEqual(failedStoreSave.store, staleGoodState.store);
expectEqual(failedStoreSave.profile, staleGoodState.profile);
const recoveredAfterSaveFailure = confirmWorkflowRecoverSavedReviewStore(
  brokenStorage,
  requestWorkflowRecoverSavedReviewStore(failedStoreSave)
);
expectEqual([...brokenStorage.entries()], []);
expectEqual(recoveredAfterSaveFailure.currentReview, reviewResult);
expectEqual(recoveredAfterSaveFailure.currentArtifacts, null);
expectEqual(recoveredAfterSaveFailure.status, "reviewed");
expectEqual(recoveredAfterSaveFailure.lastSavedReviewId, null);
expectEqual(requireStateStore(recoveredAfterSaveFailure), { schemaVersion: 3, reviews: [] });
expectEqual(requireStateProfile(recoveredAfterSaveFailure).observedPatterns, observedPatterns());

const repeatedA = saveWorkflowReview(
  memoryStorage(),
  await runWorkflowReview(setWorkflowDepth(editWorkflowPgn(createInitialReviewWorkflow(memoryStorage()), "1. a3 *"), 3), reviewPgn),
  { id: "stable", savedAtIso: "2026-05-15T15:00:00.000Z" }
);
const repeatedB = saveWorkflowReview(
  memoryStorage(),
  await runWorkflowReview(setWorkflowDepth(editWorkflowPgn(createInitialReviewWorkflow(memoryStorage()), "1. a3 *"), 3), reviewPgn),
  { id: "stable", savedAtIso: "2026-05-15T15:00:00.000Z" }
);
expectEqual(repeatedA, repeatedB);
