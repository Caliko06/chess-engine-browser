import type {
  GameReviewDto,
  ReviewArtifactsDto,
  ReviewEntryDto,
  ReviewSummaryDto
} from "./engine-dtos";
import {
  buildSavedRetryRouteAvailability,
  buildReviewProfile,
  clearReviewStore,
  deleteStoredReview,
  readReviewStore,
  storageOperationError,
  upsertStoredReview,
  type ReviewProfileDto,
  type SavedRetryRouteAvailabilityDto,
  type SavedRetryRouteFilterAvailabilityDto,
  type ReviewStoreV1,
  type ReviewStoreV3,
  type StorageLike,
  type StoredReviewV1Record,
  type StoredReviewV3
} from "./review-store";

type MemoryStorage = StorageLike & {
  readonly entries: () => ReadonlyMap<string, string>;
};
type StoredReviewV2Record = Omit<StoredReviewV3, "sourcePgn">;
type ReviewStoreV2Record = {
  readonly schemaVersion: 2;
  readonly reviews: readonly StoredReviewV2Record[];
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

function throwingStorage(
  operation: "getItem" | "setItem" | "removeItem",
  error: unknown = new Error("blocked")
): StorageLike {
  return {
    getItem: () => {
      if (operation === "getItem") {
        throw error;
      }
      return null;
    },
    setItem: () => {
      if (operation === "setItem") {
        throw error;
      }
    },
    removeItem: () => {
      if (operation === "removeItem") {
        throw error;
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

function expectMapEqual(actual: ReadonlyMap<string, string>, expected: ReadonlyMap<string, string>): void {
  expectEqual([...actual.entries()], [...expected.entries()]);
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
  overrides: Partial<ReviewProfileDto["observedPatterns"]> = {}
): ReviewProfileDto["observedPatterns"] {
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

function review(entries: readonly ReviewEntryDto[], storedSummary = summary()): GameReviewDto {
  return {
    summary: storedSummary,
    entries
  };
}

function artifacts(): ReviewArtifactsDto {
  return {
    keyMoments: [
      {
        rank: 1,
        entryIndex: 0,
        kind: "centipawn-loss",
        ply: 1,
        playedMove: "e2e4",
        san: "e4",
        bestMove: "a2a3",
        bestScoreCp: 20,
        playedScoreCp: -430,
        cpLoss: 450,
        label: "blunder"
      }
    ],
    evidence: [
      {
        rank: 1,
        entryIndex: 0,
        ply: 1,
        kind: "local-search-swing",
        playedMove: "e2e4",
        san: "e4",
        bestMove: "a2a3",
        bestScoreCp: 20,
        playedScoreCp: -430,
        cpLoss: 450,
        label: "blunder"
      }
    ],
    forkCandidates: [
      {
        rank: 1,
        entryIndex: 0,
        ply: 1,
        sourceKind: "best-move-after-position",
        bestMove: "e5f7",
        movedPiece: { color: "white", kind: "knight" },
        destination: "f7",
        targets: [
          { square: "d8", piece: { color: "black", kind: "queen" } },
          { square: "h8", piece: { color: "black", kind: "rook" } }
        ],
        cpLoss: 450,
        label: "blunder"
      }
    ],
    earlyMoveDivergences: [
      {
        entryIndex: 0,
        ply: 1,
        playedMove: "e2e4",
        san: "e4",
        localBestMove: "a2a3",
        bestScoreCp: 20,
        playedScoreCp: -430,
        cpLoss: 450,
        label: "blunder"
      }
    ],
    retryPositions: [
      {
        rank: 1,
        entryIndex: 0,
        ply: 1,
        fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        playedMove: "e2e4",
        bestMove: "a2a3",
        san: "e4",
        label: "blunder",
        cpLoss: 450
      }
    ]
  };
}

function storedReviewV1(id: string, entries: readonly ReviewEntryDto[]): StoredReviewV1Record {
  return {
    id,
    savedAtIso: "2026-05-15T12:00:00.000Z",
    source: "review-pgn",
    review: review(entries)
  };
}

function storedReview(id: string, entries: readonly ReviewEntryDto[]): StoredReviewV3 {
  return {
    id,
    savedAtIso: "2026-05-15T12:00:00.000Z",
    source: "review-pgn",
    sourcePgn: null,
    review: review(entries),
    artifacts: null
  };
}

function storedReviewV2(id: string, entries: readonly ReviewEntryDto[]): StoredReviewV2Record {
  return {
    ...storedReviewV1(id, entries),
    artifacts: null
  };
}

function storedReviewWithArtifacts(
  id: string,
  entries: readonly ReviewEntryDto[],
  artifactPayload: ReviewArtifactsDto = artifacts()
): StoredReviewV3 {
  return {
    id,
    savedAtIso: "2026-05-15T12:00:00.000Z",
    source: "review-pgn",
    sourcePgn: null,
    review: review(entries),
    artifacts: artifactPayload
  };
}

function storedReviewV2WithArtifacts(
  id: string,
  entries: readonly ReviewEntryDto[],
  artifactPayload: ReviewArtifactsDto = artifacts()
): StoredReviewV2Record {
  return {
    ...storedReviewV1(id, entries),
    artifacts: artifactPayload
  };
}

function requireStoredReview(record: StoredReviewV3 | undefined): StoredReviewV3 {
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

function requireKeyMoment(
  moment: ReviewArtifactsDto["keyMoments"][number] | undefined
): ReviewArtifactsDto["keyMoments"][number] {
  if (moment === undefined) {
    throw new Error("test fixture key moment should exist");
  }
  return moment;
}

function requireForkCandidate(
  candidate: ReviewArtifactsDto["forkCandidates"][number] | undefined
): ReviewArtifactsDto["forkCandidates"][number] {
  if (candidate === undefined) {
    throw new Error("test fixture fork candidate should exist");
  }
  return candidate;
}

function requireForkTarget(
  target: ReviewArtifactsDto["forkCandidates"][number]["targets"][number] | undefined
): ReviewArtifactsDto["forkCandidates"][number]["targets"][number] {
  if (target === undefined) {
    throw new Error("test fixture fork target should exist");
  }
  return target;
}

function requireArtifacts(
  artifactResult: StoredReviewV3["artifacts"]
): ReviewArtifactsDto {
  if (artifactResult === null) {
    throw new Error("test fixture artifacts should exist");
  }
  return artifactResult;
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

function routeCandidate(
  reviewId: string,
  retryPositionIndex: number,
  retryPosition: ReviewArtifactsDto["retryPositions"][number] | undefined
): SavedRetryRouteAvailabilityDto["route"] {
  return { reviewId, retryPositionIndex, retryPosition: requireRetryPosition(retryPosition) };
}

function emptyStore(): ReviewStoreV3 {
  return {
    schemaVersion: 3,
    reviews: []
  };
}

const storeKey = "chess.trainer.reviewStore.v1";

const validStore: ReviewStoreV3 = {
  schemaVersion: 3,
  reviews: [storedReview("review-1", [entry(1, "best", 0)])]
};
const validStoreWithSourcePgn: ReviewStoreV3 = {
  schemaVersion: 3,
  reviews: [
    {
      ...storedReview("review-source-pgn", [entry(1, "best", 0)]),
      sourcePgn: " 1. e4 * "
    }
  ]
};
const validStoreWithArtifacts: ReviewStoreV3 = {
  schemaVersion: 3,
  reviews: [storedReviewWithArtifacts("review-artifacts", [entry(1, "blunder", 450)])]
};
const legacyV2Store: ReviewStoreV2Record = {
  schemaVersion: 2,
  reviews: [storedReviewV2WithArtifacts("legacy-v2", [entry(1, "blunder", 450)])]
};
const legacyStore: ReviewStoreV1 = {
  schemaVersion: 1,
  reviews: [storedReviewV1("legacy-review", [entry(1, "good", 10)])]
};

expectEqual(readReviewStore(memoryStorage()), emptyStore());
expectEqual(
  readReviewStore(memoryStorage(new Map([[storeKey, JSON.stringify(validStore)]]))),
  validStore
);
expectEqual(
  readReviewStore(memoryStorage(new Map([[storeKey, JSON.stringify(validStoreWithSourcePgn)]]))),
  validStoreWithSourcePgn
);
expectEqual(
  readReviewStore(memoryStorage(new Map([[storeKey, JSON.stringify(validStoreWithArtifacts)]]))),
  validStoreWithArtifacts
);
expectEqual(readReviewStore(memoryStorage(new Map([[storeKey, JSON.stringify(legacyV2Store)]]))), {
  schemaVersion: 3,
  reviews: [
    {
      id: "legacy-v2",
      savedAtIso: "2026-05-15T12:00:00.000Z",
      source: "review-pgn",
      sourcePgn: null,
      review: review([entry(1, "blunder", 450)]),
      artifacts: artifacts()
    }
  ]
});
const legacyArtifactRead = readReviewStore(
  memoryStorage(
    new Map([
      [
        storeKey,
        JSON.stringify({
          schemaVersion: 2,
          reviews: [
            {
              ...storedReviewV2WithArtifacts("legacy-artifacts", [entry(1, "blunder", 450)]),
              artifacts: {
                keyMoments: artifacts().keyMoments,
                evidence: artifacts().evidence,
                earlyMoveDivergences: artifacts().earlyMoveDivergences,
                retryPositions: artifacts().retryPositions
              }
            }
          ]
        })
      ]
    ])
  )
);
if (typeof legacyArtifactRead === "string") {
  throw new Error(`legacy artifact store should read, got ${legacyArtifactRead}`);
}
const legacyArtifacts = requireArtifacts(requireStoredReview(legacyArtifactRead.reviews[0]).artifacts);
expectEqual(legacyArtifacts.forkCandidates, []);
expectEqual(Object.prototype.propertyIsEnumerable.call(legacyArtifacts, "forkCandidates"), false);
expectEqual(JSON.parse(JSON.stringify(legacyArtifactRead)), {
  schemaVersion: 3,
  reviews: [
    {
      ...storedReviewWithArtifacts("legacy-artifacts", [entry(1, "blunder", 450)]),
      sourcePgn: null,
      artifacts: {
        keyMoments: artifacts().keyMoments,
        evidence: artifacts().evidence,
        earlyMoveDivergences: artifacts().earlyMoveDivergences,
        retryPositions: artifacts().retryPositions
      }
    }
  ]
});
const legacyArtifactRoundTripRead = readReviewStore(
  memoryStorage(new Map([[storeKey, JSON.stringify(legacyArtifactRead)]]))
);
if (typeof legacyArtifactRoundTripRead === "string") {
  throw new Error(`legacy artifact round trip should read, got ${legacyArtifactRoundTripRead}`);
}
expectEqual(buildReviewProfile(legacyArtifactRoundTripRead.reviews).observedPatterns, observedPatterns({
  savedReviews: 1,
  reviewedMoves: 1,
  artifactMissingReviews: 1
}));
expectEqual(buildSavedRetryRouteAvailability(legacyArtifactRoundTripRead.reviews), {
  denominators: {
    savedReviews: 1,
    reviewedMoves: 1,
    artifactBackedReviews: 0,
    artifactMissingReviews: 1,
    savedRetryPositions: 0
  },
  route: null,
  filters: routeFilters()
});
expectEqual(readReviewStore(memoryStorage(new Map([[storeKey, JSON.stringify(legacyStore)]]))), {
  schemaVersion: 3,
  reviews: [
    {
      id: "legacy-review",
      savedAtIso: "2026-05-15T12:00:00.000Z",
      source: "review-pgn",
      sourcePgn: null,
      review: review([entry(1, "good", 10)]),
      artifacts: null
    }
  ]
});
expectEqual(readReviewStore(throwingStorage("getItem")), "storage-read-failed");
expectEqual(
  readReviewStore(throwingStorage("getItem", storageOperationError("storage-unavailable"))),
  "storage-unavailable"
);
expectEqual(readReviewStore(memoryStorage(new Map([[storeKey, "{"]]))), "corrupt-store");
expectEqual(
  readReviewStore(memoryStorage(new Map([[storeKey, JSON.stringify({ schemaVersion: 1 })]]))),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({
            schemaVersion: 1,
            reviews: [{ ...storedReviewV1("review-1", [entry(1, "best", 0)]), pgn: "1. e4 *" }]
          })
        ]
      ])
    )
  ),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({
            schemaVersion: 2,
            reviews: [
              {
                ...storedReviewV2("legacy-v2-extra-source-pgn", [entry(1, "best", 0)]),
                sourcePgn: "1. e4 *"
              }
            ]
          })
        ]
      ])
    )
  ),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({
            schemaVersion: 2,
            reviews: [
              {
                ...storedReviewV2("legacy-v2-extra-pgn", [entry(1, "best", 0)]),
                pgn: "1. e4 *"
              }
            ]
          })
        ]
      ])
    )
  ),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({
            schemaVersion: 3,
            reviews: [storedReviewV2("missing-source-pgn", [entry(1, "best", 0)])]
          })
        ]
      ])
    )
  ),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({
            schemaVersion: 3,
            reviews: [{ ...storedReview("bad-source-pgn", [entry(1, "best", 0)]), sourcePgn: 17 }]
          })
        ]
      ])
    )
  ),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({
            schemaVersion: 3,
            reviews: [{ ...storedReview("review-1", [entry(1, "best", 0)]), pgn: "1. e4 *" }]
          })
        ]
      ])
    )
  ),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({
            schemaVersion: 3,
            reviews: [
              {
                ...storedReviewWithArtifacts("bad-artifacts", [entry(1, "best", 0)]),
                artifacts: {
                  ...artifacts(),
                  retryPositions: [
                    { ...requireRetryPosition(artifacts().retryPositions[0]), pgn: "1. e4 *" }
                  ]
                }
              }
            ]
          })
        ]
      ])
    )
  ),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({
            schemaVersion: 3,
            reviews: [
              {
                ...storedReviewWithArtifacts("bad-fork-candidate", [entry(1, "best", 0)]),
                artifacts: {
                  ...artifacts(),
                  forkCandidates: [
                    {
                      ...requireForkCandidate(artifacts().forkCandidates[0]),
                      targets: [{ square: "d8", piece: { color: "black", kind: "dragon" } }]
                    }
                  ]
                }
              }
            ]
          })
        ]
      ])
    )
  ),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({
            schemaVersion: 3,
            reviews: [
              {
                ...storedReviewWithArtifacts("one-target-fork-candidate", [entry(1, "best", 0)]),
                artifacts: {
                  ...artifacts(),
                  forkCandidates: [
                    {
                      ...requireForkCandidate(artifacts().forkCandidates[0]),
                      targets: [
                        requireForkTarget(
                          requireForkCandidate(artifacts().forkCandidates[0]).targets[0]
                        )
                      ]
                    }
                  ]
                }
              }
            ]
          })
        ]
      ])
    )
  ),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(new Map([[storeKey, JSON.stringify({ schemaVersion: 3, reviews: [] })]]))
  ),
  { schemaVersion: 3, reviews: [] }
);
expectEqual(
  readReviewStore(
    memoryStorage(new Map([[storeKey, JSON.stringify({ schemaVersion: 4, reviews: [] })]]))
  ),
  "unsupported-schema"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({ schemaVersion: 3, reviews: [], futureSchemaVersion: 3 })
        ]
      ])
    )
  ),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({
            schemaVersion: 1,
            reviews: [
              storedReviewV1("duplicate", []),
              { ...storedReviewV1("duplicate", []), savedAtIso: "2026-05-15T13:00:00.000Z" }
            ]
          })
        ]
      ])
    )
  ),
  "corrupt-store"
);
expectEqual(
  readReviewStore(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({ schemaVersion: 1, reviews: [storedReviewV1("", [])] })
        ]
      ])
    )
  ),
  "corrupt-store"
);

const appendStorage = memoryStorage();
expectEqual(upsertStoredReview(appendStorage, requireStoredReview(validStore.reviews[0])), validStore);
expectEqual(upsertStoredReview(throwingStorage("setItem"), storedReview("write", [])), "storage-write-failed");
expectEqual(
  upsertStoredReview(
    throwingStorage("setItem", new DOMException("full", "QuotaExceededError")),
    storedReview("raw-quota", [])
  ),
  "storage-quota-exceeded"
);
expectEqual(
  upsertStoredReview(throwingStorage("setItem", { code: 22 }), storedReview("raw-quota-code", [])),
  "storage-quota-exceeded"
);
expectEqual(
  upsertStoredReview(
    throwingStorage("setItem", storageOperationError("storage-quota-exceeded")),
    storedReview("quota", [])
  ),
  "storage-quota-exceeded"
);

const replacementStorage = memoryStorage(new Map([[storeKey, JSON.stringify(validStore)]]));
const replacement = storedReview("review-1", [entry(2, "blunder", 400)]);
expectEqual(upsertStoredReview(replacementStorage, replacement), {
  schemaVersion: 3,
  reviews: [replacement]
});

const twoReviewStore: ReviewStoreV3 = {
  schemaVersion: 3,
  reviews: [storedReview("first", [entry(1, "good", 10)]), storedReview("second", [])]
};
const deleteStorage = memoryStorage(new Map([[storeKey, JSON.stringify(twoReviewStore)]]));
expectEqual(deleteStoredReview(deleteStorage, "first"), {
  schemaVersion: 3,
  reviews: [requireStoredReview(twoReviewStore.reviews[1])]
});
const missingDeleteStorage = memoryStorage(new Map([[storeKey, JSON.stringify(twoReviewStore)]]));
expectEqual(deleteStoredReview(missingDeleteStorage, "missing"), twoReviewStore);
expectMapEqual(missingDeleteStorage.entries(), new Map([[storeKey, JSON.stringify(twoReviewStore)]]));

const clearStorage = memoryStorage(
  new Map([
    [storeKey, JSON.stringify(validStore)],
    ["other-key", "kept"]
  ])
);
expectEqual(clearReviewStore(clearStorage), emptyStore());
expectMapEqual(clearStorage.entries(), new Map([["other-key", "kept"]]));
expectEqual(clearReviewStore(throwingStorage("removeItem")), "storage-remove-failed");

const tooManyReviews = Array.from({ length: 101 }, (_unused, index) =>
  storedReview(`review-${String(index)}`, [])
);
const overflowReview = requireStoredReview(tooManyReviews[100]);
expectEqual(upsertStoredReview(memoryStorage(), overflowReview), {
  schemaVersion: 3,
  reviews: [overflowReview]
});
const fullStorage = memoryStorage(
  new Map([[storeKey, JSON.stringify({ schemaVersion: 3, reviews: tooManyReviews.slice(0, 100) })]])
);
expectEqual(upsertStoredReview(fullStorage, overflowReview), "record-limit-exceeded");
expectEqual(
  upsertStoredReview(
    memoryStorage(),
    storedReview("too-large", Array.from({ length: 513 }, () => entry(1, "best", 0)))
  ),
  "entry-limit-exceeded"
);

const profileInput: readonly StoredReviewV3[] = [
  {
    ...storedReview("profile-1", [
      entry(10, "best", 0),
      entry(11, "mistake", 180),
      entry(40, "inaccuracy", 70),
      entry(41, "blunder", 450)
    ]),
    review: review(
      [
        entry(10, "best", 0),
        entry(11, "mistake", 180),
        entry(40, "inaccuracy", 70),
        entry(41, "blunder", 450)
      ],
      summary({ totalMoves: 99, best: 99 })
    )
  }
];

const expectedProfile: ReviewProfileDto = {
  totalReviews: 1,
  totalMoves: 4,
  labelTotals: summary({ totalMoves: 4, best: 1, inaccuracies: 1, mistakes: 1, blunders: 1 }),
  cpLossTotal: 700,
  plyBuckets: [
    {
      bucket: "plies-1-10",
      totalMoves: 1,
      labelTotals: summary({ totalMoves: 1, best: 1 }),
      cpLossTotal: 0
    },
    {
      bucket: "plies-11-40",
      totalMoves: 2,
      labelTotals: summary({ totalMoves: 2, inaccuracies: 1, mistakes: 1 }),
      cpLossTotal: 250
    },
    {
      bucket: "plies-41-plus",
      totalMoves: 1,
      labelTotals: summary({ totalMoves: 1, blunders: 1 }),
      cpLossTotal: 450
    }
  ],
  observedPatterns: observedPatterns({
    savedReviews: 1,
    reviewedMoves: 4,
    artifactMissingReviews: 1
  })
};

expectEqual(buildReviewProfile([]), {
  totalReviews: 0,
  totalMoves: 0,
  labelTotals: summary(),
  cpLossTotal: 0,
  plyBuckets: [
    { bucket: "plies-1-10", totalMoves: 0, labelTotals: summary(), cpLossTotal: 0 },
    { bucket: "plies-11-40", totalMoves: 0, labelTotals: summary(), cpLossTotal: 0 },
    { bucket: "plies-41-plus", totalMoves: 0, labelTotals: summary(), cpLossTotal: 0 }
  ],
  observedPatterns: observedPatterns()
});
expectEqual(buildReviewProfile(profileInput), expectedProfile);
expectEqual(buildReviewProfile(profileInput), buildReviewProfile(profileInput));

const observedInput: readonly StoredReviewV3[] = [
  {
    ...storedReviewWithArtifacts("observed-backed", [entry(1, "blunder", 450)]),
    review: review([entry(1, "blunder", 450)], summary({ totalMoves: 99, best: 99 }))
  },
  storedReview("observed-null", [entry(2, "good", 10), entry(3, "mistake", 180)]),
  {
    id: "legacy-review",
    savedAtIso: "2026-05-15T12:00:00.000Z",
    source: "review-pgn",
    sourcePgn: null,
    review: review([entry(1, "good", 10)]),
    artifacts: null
  }
];
expectEqual(buildReviewProfile(observedInput).observedPatterns, observedPatterns({
  savedReviews: 3,
  reviewedMoves: 4,
  artifactBackedReviews: 1,
  artifactMissingReviews: 2,
  keyMoments: 1,
  localSearchSwings: 1,
  forkCandidates: 1,
  retryPositions: 1
}));
expectEqual(buildReviewProfile(legacyArtifactRead.reviews).observedPatterns, observedPatterns({
  savedReviews: 1,
  reviewedMoves: 1,
  artifactMissingReviews: 1
}));

expectEqual(buildSavedRetryRouteAvailability([]), {
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
expectEqual(buildSavedRetryRouteAvailability([storedReview("route-null", [entry(1, "good", 10)])]), {
  denominators: {
    savedReviews: 1,
    reviewedMoves: 1,
    artifactBackedReviews: 0,
    artifactMissingReviews: 1,
    savedRetryPositions: 0
  },
  route: null,
  filters: routeFilters()
});
expectEqual(buildSavedRetryRouteAvailability(legacyArtifactRead.reviews), {
  denominators: {
    savedReviews: 1,
    reviewedMoves: 1,
    artifactBackedReviews: 0,
    artifactMissingReviews: 1,
    savedRetryPositions: 0
  },
  route: null,
  filters: routeFilters()
});
const legacyV1RouteRead = readReviewStore(
  memoryStorage(new Map([[storeKey, JSON.stringify(legacyStore)]]))
);
if (typeof legacyV1RouteRead === "string") {
  throw new Error(`legacy v1 route store should read, got ${legacyV1RouteRead}`);
}
expectEqual(buildSavedRetryRouteAvailability(legacyV1RouteRead.reviews), {
  denominators: {
    savedReviews: 1,
    reviewedMoves: 1,
    artifactBackedReviews: 0,
    artifactMissingReviews: 1,
    savedRetryPositions: 0
  },
  route: null,
  filters: routeFilters()
});
const currentEmptyForkCandidates = storedReviewWithArtifacts(
  "current-empty-forks",
  [entry(1, "blunder", 450)],
  {
    ...artifacts(),
    forkCandidates: []
  }
);
const currentEmptyForkCandidatesRead = readReviewStore(
  memoryStorage(
    new Map([
      [
        storeKey,
        JSON.stringify({
          schemaVersion: 3,
          reviews: [currentEmptyForkCandidates]
        })
      ]
    ])
  )
);
if (typeof currentEmptyForkCandidatesRead === "string") {
  throw new Error(`current empty fork candidates should read, got ${currentEmptyForkCandidatesRead}`);
}
expectEqual(
  Object.prototype.propertyIsEnumerable.call(
    requireArtifacts(requireStoredReview(currentEmptyForkCandidatesRead.reviews[0]).artifacts),
    "forkCandidates"
  ),
  true
);
expectEqual(buildReviewProfile(currentEmptyForkCandidatesRead.reviews).observedPatterns, observedPatterns({
  savedReviews: 1,
  reviewedMoves: 1,
  artifactBackedReviews: 1,
  keyMoments: 1,
  localSearchSwings: 1,
  retryPositions: 1
}));
const currentEmptyForkRoute = routeCandidate(
  "current-empty-forks",
  0,
  currentEmptyForkCandidates.artifacts?.retryPositions[0]
);
expectEqual(buildSavedRetryRouteAvailability(currentEmptyForkCandidatesRead.reviews), {
  denominators: {
    savedReviews: 1,
    reviewedMoves: 1,
    artifactBackedReviews: 1,
    artifactMissingReviews: 0,
    savedRetryPositions: 1
  },
  route: currentEmptyForkRoute,
  filters: routeFilters(
    routeFilter("key-moments", 1, 1, currentEmptyForkRoute),
    routeFilter("local-search-swings", 1, 1, currentEmptyForkRoute),
    routeFilter("fork-candidates")
  )
});
const exactRouteReview = storedReviewWithArtifacts("route-exact", [entry(1, "blunder", 450)]);
const exactRoute = {
  reviewId: "route-exact",
  retryPositionIndex: 0,
  retryPosition: requireRetryPosition(exactRouteReview.artifacts?.retryPositions[0])
};
expectEqual(buildSavedRetryRouteAvailability([exactRouteReview]), {
  denominators: {
    savedReviews: 1,
    reviewedMoves: 1,
    artifactBackedReviews: 1,
    artifactMissingReviews: 0,
    savedRetryPositions: 1
  },
  route: exactRoute,
  filters: routeFilters(
    routeFilter("key-moments", 1, 1, exactRoute),
    routeFilter("local-search-swings", 1, 1, exactRoute),
    routeFilter("fork-candidates", 1, 1, exactRoute)
  )
});
const baseRetry = requireRetryPosition(artifacts().retryPositions[0]);
const sameReviewRoutes = storedReviewWithArtifacts("route-same-review", [entry(1, "blunder", 450)], {
  ...artifacts(),
  retryPositions: [
    { ...baseRetry, rank: 2, entryIndex: 0, ply: 3, fenBefore: "fen-b", bestMove: "b2b3", playedMove: "b2b4" },
    { ...baseRetry, rank: 1, entryIndex: 9, ply: 41, fenBefore: "fen-a", bestMove: "a2a3", playedMove: "a2a4" }
  ]
});
expectEqual(buildSavedRetryRouteAvailability([sameReviewRoutes]).route, {
  reviewId: "route-same-review",
  retryPositionIndex: 1,
  retryPosition: requireRetryPosition(sameReviewRoutes.artifacts?.retryPositions[1])
});
const laterReview = storedReviewWithArtifacts("route-later", [entry(1, "blunder", 450)], {
  ...artifacts(),
  retryPositions: [{ ...baseRetry, rank: 1, entryIndex: 0, ply: 1, fenBefore: "fen-a" }]
});
const earlierReview = storedReviewWithArtifacts("route-earlier", [entry(2, "mistake", 180)], {
  ...artifacts(),
  retryPositions: [{ ...baseRetry, rank: 5, entryIndex: 4, ply: 50, fenBefore: "fen-z" }]
});
const laterFilterRoute = {
  reviewId: "route-later",
  retryPositionIndex: 0,
  retryPosition: requireRetryPosition(laterReview.artifacts?.retryPositions[0])
};
expectEqual(buildSavedRetryRouteAvailability([earlierReview, laterReview]), {
  denominators: {
    savedReviews: 2,
    reviewedMoves: 2,
    artifactBackedReviews: 2,
    artifactMissingReviews: 0,
    savedRetryPositions: 2
  },
  route: {
    reviewId: "route-earlier",
    retryPositionIndex: 0,
    retryPosition: requireRetryPosition(earlierReview.artifacts?.retryPositions[0])
  },
  filters: routeFilters(
    routeFilter("key-moments", 2, 1, laterFilterRoute),
    routeFilter("local-search-swings", 2, 1, laterFilterRoute),
    routeFilter("fork-candidates", 2, 1, laterFilterRoute)
  )
});

const filterMinusReview = storedReviewWithArtifacts("filter-minus", [entry(1, "good", 10)], {
  ...artifacts(),
  keyMoments: [],
  evidence: [],
  forkCandidates: []
});
expectEqual(buildSavedRetryRouteAvailability([filterMinusReview]).filters, routeFilters());

const filterPlusRetry = { ...baseRetry, rank: 2, fenBefore: "fen-plus-b" };
const baseKeyMoment = requireKeyMoment(exactRouteReview.artifacts?.keyMoments[0]);
const filterPlusReview = storedReviewWithArtifacts("filter-plus", [entry(1, "blunder", 450)], {
  ...artifacts(),
  keyMoments: [
    baseKeyMoment,
    { ...baseKeyMoment, rank: 2 }
  ],
  retryPositions: [baseRetry, filterPlusRetry]
});
const filterPlusRoute = routeCandidate("filter-plus", 0, filterPlusReview.artifacts?.retryPositions[0]);
expectEqual(buildSavedRetryRouteAvailability([filterPlusReview]).filters[0], {
  ...routeFilter("key-moments", 2, 2, filterPlusRoute)
});

const wrongReviewArtifact = storedReviewWithArtifacts("wrong-review-artifact", [entry(1, "good", 10)], {
  ...artifacts(),
  evidence: [],
  forkCandidates: [],
  retryPositions: []
});
const wrongReviewRetry = storedReviewWithArtifacts("wrong-review-retry", [entry(2, "good", 10)], {
  ...artifacts(),
  keyMoments: [],
  evidence: [],
  forkCandidates: [],
  retryPositions: [baseRetry]
});
expectEqual(
  buildSavedRetryRouteAvailability([wrongReviewArtifact, wrongReviewRetry]).filters[0],
  routeFilter("key-moments", 1, 0)
);

const wrongCoordinates = storedReviewWithArtifacts("wrong-coordinates", [entry(1, "good", 10)], {
  ...artifacts(),
  keyMoments: [baseKeyMoment],
  evidence: [],
  forkCandidates: [],
  retryPositions: [
    { ...baseRetry, entryIndex: baseRetry.entryIndex + 1 },
    { ...baseRetry, ply: baseRetry.ply + 1 }
  ]
});
expectEqual(
  buildSavedRetryRouteAvailability([wrongCoordinates]).filters[0],
  routeFilter("key-moments", 1, 0)
);

const wrongKindReview = storedReviewWithArtifacts("wrong-kind", [entry(1, "blunder", 450)], {
  ...artifacts(),
  keyMoments: [],
  forkCandidates: [],
  retryPositions: [baseRetry]
});
expectEqual(
  buildSavedRetryRouteAvailability([wrongKindReview]).filters,
  routeFilters(
    routeFilter("key-moments", 0, 0),
    routeFilter("local-search-swings", 1, 1, routeCandidate("wrong-kind", 0, wrongKindReview.artifacts?.retryPositions[0])),
    routeFilter("fork-candidates", 0, 0)
  )
);
