import type {
  GameReviewDto,
  MoveLabelDto,
  ReviewArtifactsDto,
  ReviewSummaryDto
} from "./engine-dtos.js";
import {
  exactKeys,
  isRecord,
  validateCurrentReviewArtifactsDto,
  validateGameReviewDto as validateReview
} from "./review-validators.js";

const reviewStoreKey = "chess.trainer.reviewStore.v1";
const maxStoredReviews = 100;
const maxEntriesPerReview = 512;

export type ReviewStoreError =
  | "corrupt-store"
  | "unsupported-schema"
  | "record-limit-exceeded"
  | "entry-limit-exceeded"
  | "storage-unavailable"
  | "storage-read-failed"
  | "storage-write-failed"
  | "storage-quota-exceeded"
  | "storage-remove-failed";

export type StorageOperationErrorReason = Extract<
  ReviewStoreError,
  | "storage-unavailable"
  | "storage-read-failed"
  | "storage-write-failed"
  | "storage-quota-exceeded"
  | "storage-remove-failed"
>;

export class StorageOperationError extends Error {
  readonly reason: StorageOperationErrorReason;

  constructor(reason: StorageOperationErrorReason) {
    super(reason);
    this.name = "StorageOperationError";
    this.reason = reason;
  }
}

export type StorageLike = {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
};

export type ReviewStoreV1 = {
  readonly schemaVersion: 1;
  readonly reviews: readonly StoredReviewV1Record[];
};

export type StoredReviewV1Record = {
  readonly id: string;
  readonly savedAtIso: string;
  readonly source: "review-pgn";
  readonly review: GameReviewDto;
};

export type ReviewStoreV3 = {
  readonly schemaVersion: 3;
  readonly reviews: readonly StoredReviewV3[];
};

export type StoredReviewV3 = {
  readonly id: string;
  readonly savedAtIso: string;
  readonly source: "review-pgn";
  readonly sourcePgn: string | null;
  readonly review: GameReviewDto;
  readonly artifacts: ReviewArtifactsDto | null;
};

export function storageOperationError(reason: StorageOperationErrorReason): StorageOperationError {
  return new StorageOperationError(reason);
}

export type ReviewProfileDto = {
  readonly totalReviews: number;
  readonly totalMoves: number;
  readonly labelTotals: ReviewSummaryDto;
  readonly cpLossTotal: number;
  readonly plyBuckets: readonly ReviewProfilePlyBucketDto[];
  readonly observedPatterns: ObservedPatternProfileDto;
};

export type ObservedPatternProfileDto = {
  readonly savedReviews: number;
  readonly reviewedMoves: number;
  readonly artifactBackedReviews: number;
  readonly artifactMissingReviews: number;
  readonly keyMoments: number;
  readonly localSearchSwings: number;
  readonly forkCandidates: number;
  readonly retryPositions: number;
};

export type SavedRetryRouteDenominatorsDto = {
  readonly savedReviews: number;
  readonly reviewedMoves: number;
  readonly artifactBackedReviews: number;
  readonly artifactMissingReviews: number;
  readonly savedRetryPositions: number;
};

export type SavedRetryRouteCandidateDto = {
  readonly reviewId: string;
  readonly retryPositionIndex: number;
  readonly retryPosition: ReviewArtifactsDto["retryPositions"][number];
};

export type SavedRetryRouteFilterKindDto =
  | "key-moments"
  | "local-search-swings"
  | "fork-candidates";

export type SavedRetryRouteFilterAvailabilityDto = {
  readonly kind: SavedRetryRouteFilterKindDto;
  readonly artifactCount: number;
  readonly matchedRetryPositions: number;
  readonly route: SavedRetryRouteCandidateDto | null;
};

export type SavedRetryRouteAvailabilityDto = {
  readonly denominators: SavedRetryRouteDenominatorsDto;
  readonly route: SavedRetryRouteCandidateDto | null;
  readonly filters: readonly SavedRetryRouteFilterAvailabilityDto[];
};

export type ReviewProfilePlyBucketDto = {
  readonly bucket: "plies-1-10" | "plies-11-40" | "plies-41-plus";
  readonly totalMoves: number;
  readonly labelTotals: ReviewSummaryDto;
  readonly cpLossTotal: number;
};

type RecordValue = Record<string, unknown>;
type MutableSummary = {
  totalMoves: number;
  best: number;
  good: number;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
};
type MutableBucket = {
  bucket: ReviewProfilePlyBucketDto["bucket"];
  totalMoves: number;
  labelTotals: MutableSummary;
  cpLossTotal: number;
};
type MutableObservedPatternProfile = {
  savedReviews: number;
  reviewedMoves: number;
  artifactBackedReviews: number;
  artifactMissingReviews: number;
  keyMoments: number;
  localSearchSwings: number;
  forkCandidates: number;
  retryPositions: number;
};
type MutableSavedRetryRouteDenominators = {
  savedReviews: number;
  reviewedMoves: number;
  artifactBackedReviews: number;
  artifactMissingReviews: number;
  savedRetryPositions: number;
};
type InternalSavedRetryRouteCandidate = SavedRetryRouteCandidateDto & {
  readonly reviewIndex: number;
  readonly sourceIndex: number;
};
type RetryRouteArtifactCoordinate = {
  readonly entryIndex: number;
  readonly ply: number;
};
type MutableSavedRetryRouteFilter = {
  readonly kind: SavedRetryRouteFilterKindDto;
  artifactCount: number;
  matchedRetryPositions: number;
  readonly candidates: InternalSavedRetryRouteCandidate[];
};
type MutableSavedRetryRouteFilters = readonly [
  MutableSavedRetryRouteFilter,
  MutableSavedRetryRouteFilter,
  MutableSavedRetryRouteFilter
];
type StorageReadResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly error: StorageOperationErrorReason };

export function readReviewStore(storage: StorageLike): ReviewStoreV3 | ReviewStoreError {
  const stored = getStorageItem(storage, reviewStoreKey);
  if (!stored.ok) {
    return stored.error;
  }
  if (stored.value === null) {
    return emptyStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.value);
  } catch {
    return "corrupt-store";
  }
  return validateStore(parsed);
}

export function upsertStoredReview(
  storage: StorageLike,
  record: StoredReviewV3
): ReviewStoreV3 | ReviewStoreError {
  if (record.review.entries.length > maxEntriesPerReview) {
    return "entry-limit-exceeded";
  }

  const current = readReviewStore(storage);
  if (typeof current === "string") {
    return current;
  }

  const existingIndex = current.reviews.findIndex((review) => review.id === record.id);
  if (existingIndex === -1 && current.reviews.length >= maxStoredReviews) {
    return "record-limit-exceeded";
  }

  const reviews = current.reviews.slice();
  if (existingIndex === -1) {
    reviews.push(record);
  } else {
    reviews[existingIndex] = record;
  }

  const nextStore = { schemaVersion: 3, reviews } satisfies ReviewStoreV3;
  const writeResult = setStorageItem(storage, reviewStoreKey, JSON.stringify(nextStore));
  if (writeResult !== null) {
    return writeResult;
  }
  return nextStore;
}

export function deleteStoredReview(
  storage: StorageLike,
  id: string
): ReviewStoreV3 | ReviewStoreError {
  const current = readReviewStore(storage);
  if (typeof current === "string") {
    return current;
  }

  const nextStore = {
    schemaVersion: 3,
    reviews: current.reviews.filter((review) => review.id !== id)
  } satisfies ReviewStoreV3;
  if (nextStore.reviews.length === current.reviews.length) {
    return current;
  }

  const writeResult = setStorageItem(storage, reviewStoreKey, JSON.stringify(nextStore));
  if (writeResult !== null) {
    return writeResult;
  }
  return nextStore;
}

export function clearReviewStore(storage: StorageLike): ReviewStoreV3 | ReviewStoreError {
  const removeResult = removeStorageItem(storage, reviewStoreKey);
  if (removeResult !== null) {
    return removeResult;
  }
  return emptyStore();
}

export function buildReviewProfile(reviews: readonly StoredReviewV3[]): ReviewProfileDto {
  const labelTotals = mutableSummary();
  const buckets = [
    mutableBucket("plies-1-10"),
    mutableBucket("plies-11-40"),
    mutableBucket("plies-41-plus")
  ];
  let totalMoves = 0;
  let cpLossTotal = 0;
  const observedPatterns = mutableObservedPatterns();

  for (const review of reviews) {
    observedPatterns.savedReviews += 1;
    observedPatterns.reviewedMoves += review.review.entries.length;
    recordObservedArtifacts(observedPatterns, review.artifacts);

    for (const entry of review.review.entries) {
      totalMoves += 1;
      cpLossTotal += entry.cpLoss;
      recordLabel(labelTotals, entry.label);

      const bucket = bucketForPly(buckets, entry.ply);
      bucket.totalMoves += 1;
      bucket.cpLossTotal += entry.cpLoss;
      recordLabel(bucket.labelTotals, entry.label);
    }
  }

  return {
    totalReviews: reviews.length,
    totalMoves,
    labelTotals: freezeSummary(labelTotals),
    cpLossTotal,
    plyBuckets: buckets.map((bucket) => ({
      bucket: bucket.bucket,
      totalMoves: bucket.totalMoves,
      labelTotals: freezeSummary(bucket.labelTotals),
      cpLossTotal: bucket.cpLossTotal
    })),
    observedPatterns: freezeObservedPatterns(observedPatterns)
  };
}

export function buildSavedRetryRouteAvailability(
  reviews: readonly StoredReviewV3[]
): SavedRetryRouteAvailabilityDto {
  const denominators = mutableSavedRetryRouteDenominators();
  const candidates: InternalSavedRetryRouteCandidate[] = [];
  const filters = mutableSavedRetryRouteFilters();
  let sourceIndex = 0;

  for (const [reviewIndex, review] of reviews.entries()) {
    denominators.savedReviews += 1;
    denominators.reviewedMoves += review.review.entries.length;
    if (!hasCompleteArtifactEvidence(review.artifacts)) {
      denominators.artifactMissingReviews += 1;
      continue;
    }

    denominators.artifactBackedReviews += 1;
    denominators.savedRetryPositions += review.artifacts.retryPositions.length;
    const reviewCandidates: InternalSavedRetryRouteCandidate[] = [];
    for (const [retryPositionIndex, retryPosition] of review.artifacts.retryPositions.entries()) {
      const candidate = {
        reviewId: review.id,
        reviewIndex,
        retryPositionIndex,
        retryPosition,
        sourceIndex
      };
      candidates.push(candidate);
      reviewCandidates.push(candidate);
      sourceIndex += 1;
    }

    recordSavedRetryRouteFilterMatches(filters[0], review.artifacts.keyMoments, reviewCandidates);
    recordSavedRetryRouteFilterMatches(filters[1], review.artifacts.evidence, reviewCandidates);
    recordSavedRetryRouteFilterMatches(
      filters[2],
      review.artifacts.forkCandidates,
      reviewCandidates
    );
  }

  const eligible =
    denominators.savedReviews >= 1 &&
    denominators.artifactBackedReviews >= 1 &&
    denominators.savedRetryPositions >= 1;
  const route = eligible ? candidates.sort(compareSavedRetryRouteCandidates)[0] ?? null : null;
  return {
    denominators: freezeSavedRetryRouteDenominators(denominators),
    route: route === null ? null : routeCandidateDto(route),
    filters: freezeSavedRetryRouteFilters(filters, eligible)
  };
}

function validateStore(value: unknown): ReviewStoreV3 | ReviewStoreError {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "reviews"])) {
    return "corrupt-store";
  }
  if (value.schemaVersion === 1) {
    return validateLegacyStore(value);
  }
  if (value.schemaVersion === 2) {
    return validateLegacyArtifactStore(value);
  }
  if (value.schemaVersion !== 3) {
    return "unsupported-schema";
  }
  if (!Array.isArray(value.reviews) || value.reviews.length > maxStoredReviews) {
    return "corrupt-store";
  }

  const reviews: StoredReviewV3[] = [];
  const ids = new Set<string>();
  for (const review of value.reviews) {
    const validated = validateStoredReview(review);
    if (validated === null || ids.has(validated.id)) {
      return "corrupt-store";
    }
    ids.add(validated.id);
    reviews.push(validated);
  }
  return { schemaVersion: 3, reviews };
}

function validateLegacyStore(value: RecordValue): ReviewStoreV3 | ReviewStoreError {
  if (!Array.isArray(value.reviews) || value.reviews.length > maxStoredReviews) {
    return "corrupt-store";
  }

  const reviews: StoredReviewV3[] = [];
  const ids = new Set<string>();
  for (const review of value.reviews) {
    const validated = validateStoredReviewV1(review);
    if (validated === null || ids.has(validated.id)) {
      return "corrupt-store";
    }
    ids.add(validated.id);
    reviews.push({
      id: validated.id,
      savedAtIso: validated.savedAtIso,
      source: "review-pgn",
      sourcePgn: null,
      review: validated.review,
      artifacts: null
    });
  }
  return { schemaVersion: 3, reviews };
}

function validateLegacyArtifactStore(value: RecordValue): ReviewStoreV3 | ReviewStoreError {
  if (!Array.isArray(value.reviews) || value.reviews.length > maxStoredReviews) {
    return "corrupt-store";
  }

  const reviews: StoredReviewV3[] = [];
  const ids = new Set<string>();
  for (const review of value.reviews) {
    const validated = validateStoredReviewV2(review);
    if (validated === null || ids.has(validated.id)) {
      return "corrupt-store";
    }
    ids.add(validated.id);
    reviews.push({
      id: validated.id,
      savedAtIso: validated.savedAtIso,
      source: "review-pgn",
      sourcePgn: null,
      review: validated.review,
      artifacts: validated.artifacts
    });
  }
  return { schemaVersion: 3, reviews };
}

function validateStoredReview(value: unknown): StoredReviewV3 | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["id", "savedAtIso", "source", "sourcePgn", "review", "artifacts"])
  ) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.savedAtIso !== "string" ||
    value.source !== "review-pgn" ||
    !(typeof value.sourcePgn === "string" || value.sourcePgn === null)
  ) {
    return null;
  }

  const review = validateReview(value.review);
  const artifacts = value.artifacts === null ? null : validateArtifacts(value.artifacts);
  return review === null || artifacts === null && value.artifacts !== null
    ? null
    : {
        id: value.id,
        savedAtIso: value.savedAtIso,
        source: "review-pgn",
        sourcePgn: value.sourcePgn,
        review,
        artifacts
      };
}

function validateStoredReviewV2(
  value: unknown
): Omit<StoredReviewV3, "sourcePgn"> | null {
  if (!isRecord(value) || !exactKeys(value, ["id", "savedAtIso", "source", "review", "artifacts"])) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.savedAtIso !== "string" ||
    value.source !== "review-pgn"
  ) {
    return null;
  }

  const review = validateReview(value.review);
  const artifacts = value.artifacts === null ? null : validateArtifacts(value.artifacts);
  return review === null || artifacts === null && value.artifacts !== null
    ? null
    : { id: value.id, savedAtIso: value.savedAtIso, source: "review-pgn", review, artifacts };
}

function validateStoredReviewV1(value: unknown): StoredReviewV1Record | null {
  if (!isRecord(value) || !exactKeys(value, ["id", "savedAtIso", "source", "review"])) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.savedAtIso !== "string" ||
    value.source !== "review-pgn"
  ) {
    return null;
  }

  const review = validateReview(value.review);
  return review === null
    ? null
    : { id: value.id, savedAtIso: value.savedAtIso, source: "review-pgn", review };
}

function validateArtifacts(value: unknown): ReviewArtifactsDto | null {
  if (!isRecord(value)) {
    return null;
  }
  const hasCurrentArtifactShape = exactKeys(value, [
    "keyMoments",
    "evidence",
    "forkCandidates",
    "earlyMoveDivergences",
    "retryPositions"
  ]);
  const hasLegacyArtifactShape = exactKeys(value, [
    "keyMoments",
    "evidence",
    "earlyMoveDivergences",
    "retryPositions"
  ]);
  if (!hasCurrentArtifactShape && !hasLegacyArtifactShape) {
    return null;
  }

  const currentArtifacts = validateCurrentReviewArtifactsDto(
    hasCurrentArtifactShape
      ? value
      : {
          keyMoments: value.keyMoments,
          evidence: value.evidence,
          forkCandidates: [],
          earlyMoveDivergences: value.earlyMoveDivergences,
          retryPositions: value.retryPositions
        }
  );
  if (currentArtifacts === null) {
    return null;
  }

  return hasCurrentArtifactShape
    ? currentArtifacts
    : legacyArtifactsWithoutForkCandidates({
        keyMoments: currentArtifacts.keyMoments,
        evidence: currentArtifacts.evidence,
        earlyMoveDivergences: currentArtifacts.earlyMoveDivergences,
        retryPositions: currentArtifacts.retryPositions
      });
}

function legacyArtifactsWithoutForkCandidates(
  artifacts: Omit<ReviewArtifactsDto, "forkCandidates">
): ReviewArtifactsDto {
  const result = { ...artifacts } as ReviewArtifactsDto;
  Object.defineProperty(result, "forkCandidates", {
    value: [],
    enumerable: false,
    configurable: false,
    writable: false
  });
  return result;
}

function emptyStore(): ReviewStoreV3 {
  return { schemaVersion: 3, reviews: [] };
}

function mutableSummary(): MutableSummary {
  return { totalMoves: 0, best: 0, good: 0, inaccuracies: 0, mistakes: 0, blunders: 0 };
}

function mutableBucket(bucket: MutableBucket["bucket"]): MutableBucket {
  return { bucket, totalMoves: 0, labelTotals: mutableSummary(), cpLossTotal: 0 };
}

function mutableObservedPatterns(): MutableObservedPatternProfile {
  return {
    savedReviews: 0,
    reviewedMoves: 0,
    artifactBackedReviews: 0,
    artifactMissingReviews: 0,
    keyMoments: 0,
    localSearchSwings: 0,
    forkCandidates: 0,
    retryPositions: 0
  };
}

function mutableSavedRetryRouteDenominators(): MutableSavedRetryRouteDenominators {
  return {
    savedReviews: 0,
    reviewedMoves: 0,
    artifactBackedReviews: 0,
    artifactMissingReviews: 0,
    savedRetryPositions: 0
  };
}

function mutableSavedRetryRouteFilters(): MutableSavedRetryRouteFilters {
  return [
    mutableSavedRetryRouteFilter("key-moments"),
    mutableSavedRetryRouteFilter("local-search-swings"),
    mutableSavedRetryRouteFilter("fork-candidates")
  ];
}

function mutableSavedRetryRouteFilter(
  kind: SavedRetryRouteFilterKindDto
): MutableSavedRetryRouteFilter {
  return { kind, artifactCount: 0, matchedRetryPositions: 0, candidates: [] };
}

function bucketForPly(buckets: readonly MutableBucket[], ply: number): MutableBucket {
  if (ply <= 10) {
    return buckets[0] ?? mutableBucket("plies-1-10");
  }
  if (ply <= 40) {
    return buckets[1] ?? mutableBucket("plies-11-40");
  }
  return buckets[2] ?? mutableBucket("plies-41-plus");
}

function recordLabel(summary: MutableSummary, label: MoveLabelDto): void {
  summary.totalMoves += 1;
  switch (label) {
    case "best":
      summary.best += 1;
      break;
    case "good":
      summary.good += 1;
      break;
    case "inaccuracy":
      summary.inaccuracies += 1;
      break;
    case "mistake":
      summary.mistakes += 1;
      break;
    case "blunder":
      summary.blunders += 1;
      break;
  }
}

function recordObservedArtifacts(
  profile: MutableObservedPatternProfile,
  artifacts: ReviewArtifactsDto | null
): void {
  if (!hasCompleteArtifactEvidence(artifacts)) {
    profile.artifactMissingReviews += 1;
    return;
  }

  profile.artifactBackedReviews += 1;
  profile.keyMoments += artifacts.keyMoments.length;
  profile.localSearchSwings += artifacts.evidence.length;
  profile.forkCandidates += artifacts.forkCandidates.length;
  profile.retryPositions += artifacts.retryPositions.length;
}

function freezeSummary(summary: MutableSummary): ReviewSummaryDto {
  return {
    totalMoves: summary.totalMoves,
    best: summary.best,
    good: summary.good,
    inaccuracies: summary.inaccuracies,
    mistakes: summary.mistakes,
    blunders: summary.blunders
  };
}

function freezeObservedPatterns(
  profile: MutableObservedPatternProfile
): ObservedPatternProfileDto {
  return {
    savedReviews: profile.savedReviews,
    reviewedMoves: profile.reviewedMoves,
    artifactBackedReviews: profile.artifactBackedReviews,
    artifactMissingReviews: profile.artifactMissingReviews,
    keyMoments: profile.keyMoments,
    localSearchSwings: profile.localSearchSwings,
    forkCandidates: profile.forkCandidates,
    retryPositions: profile.retryPositions
  };
}

function freezeSavedRetryRouteDenominators(
  denominators: MutableSavedRetryRouteDenominators
): SavedRetryRouteDenominatorsDto {
  return {
    savedReviews: denominators.savedReviews,
    reviewedMoves: denominators.reviewedMoves,
    artifactBackedReviews: denominators.artifactBackedReviews,
    artifactMissingReviews: denominators.artifactMissingReviews,
    savedRetryPositions: denominators.savedRetryPositions
  };
}

function freezeSavedRetryRouteFilters(
  filters: readonly MutableSavedRetryRouteFilter[],
  globalEligible: boolean
): readonly SavedRetryRouteFilterAvailabilityDto[] {
  return filters.map((filter) => {
    const route =
      globalEligible && filter.matchedRetryPositions >= 1
        ? [...filter.candidates].sort(compareSavedRetryRouteCandidates)[0] ?? null
        : null;
    return {
      kind: filter.kind,
      artifactCount: filter.artifactCount,
      matchedRetryPositions: filter.matchedRetryPositions,
      route: route === null ? null : routeCandidateDto(route)
    };
  });
}

function routeCandidateDto(
  candidate: InternalSavedRetryRouteCandidate
): SavedRetryRouteCandidateDto {
  return {
    reviewId: candidate.reviewId,
    retryPositionIndex: candidate.retryPositionIndex,
    retryPosition: candidate.retryPosition
  };
}

function compareSavedRetryRouteCandidates(
  left: InternalSavedRetryRouteCandidate,
  right: InternalSavedRetryRouteCandidate
): number {
  return (
    compareNumber(left.reviewIndex, right.reviewIndex) ||
    compareNumber(left.retryPosition.rank, right.retryPosition.rank) ||
    compareNumber(left.retryPosition.entryIndex, right.retryPosition.entryIndex) ||
    compareNumber(left.retryPosition.ply, right.retryPosition.ply) ||
    left.retryPosition.fenBefore.localeCompare(right.retryPosition.fenBefore) ||
    (left.retryPosition.bestMove ?? "").localeCompare(right.retryPosition.bestMove ?? "") ||
    left.retryPosition.playedMove.localeCompare(right.retryPosition.playedMove) ||
    compareNumber(left.sourceIndex, right.sourceIndex)
  );
}

function recordSavedRetryRouteFilterMatches(
  filter: MutableSavedRetryRouteFilter,
  artifacts: readonly RetryRouteArtifactCoordinate[],
  reviewCandidates: readonly InternalSavedRetryRouteCandidate[]
): void {
  filter.artifactCount += artifacts.length;
  if (artifacts.length === 0 || reviewCandidates.length === 0) {
    return;
  }

  const coordinates = new Set(artifacts.map(routeArtifactCoordinateKey));
  for (const candidate of reviewCandidates) {
    if (coordinates.has(routeArtifactCoordinateKey(candidate.retryPosition))) {
      filter.matchedRetryPositions += 1;
      filter.candidates.push(candidate);
    }
  }
}

function routeArtifactCoordinateKey(coordinate: RetryRouteArtifactCoordinate): string {
  return `${String(coordinate.entryIndex)}:${String(coordinate.ply)}`;
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function hasCompleteArtifactEvidence(
  artifacts: ReviewArtifactsDto | null
): artifacts is ReviewArtifactsDto {
  return artifacts !== null && Object.prototype.propertyIsEnumerable.call(artifacts, "forkCandidates");
}

function getStorageItem(
  storage: StorageLike,
  key: string
): StorageReadResult {
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch (error) {
    return { ok: false, error: caughtStorageReason(error, "storage-read-failed") };
  }
}

function setStorageItem(
  storage: StorageLike,
  key: string,
  value: string
): StorageOperationErrorReason | null {
  try {
    storage.setItem(key, value);
    return null;
  } catch (error) {
    return caughtStorageReason(error, "storage-write-failed");
  }
}

function removeStorageItem(
  storage: StorageLike,
  key: string
): StorageOperationErrorReason | null {
  try {
    storage.removeItem(key);
    return null;
  } catch (error) {
    return caughtStorageReason(error, "storage-remove-failed");
  }
}

function caughtStorageReason(
  error: unknown,
  fallback: StorageOperationErrorReason
): StorageOperationErrorReason {
  if (error instanceof StorageOperationError || isStorageOperationErrorRecord(error)) {
    return error.reason;
  }
  if (fallback === "storage-write-failed" && isQuotaExceeded(error)) {
    return "storage-quota-exceeded";
  }
  return fallback;
}

function isStorageOperationErrorRecord(
  error: unknown
): error is { readonly reason: StorageOperationErrorReason } {
  if (!isRecord(error)) {
    return false;
  }
  const reason = error["reason"];
  return typeof reason === "string" && isStorageOperationErrorReason(reason);
}

function isQuotaExceeded(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const name = error["name"];
  const code = error["code"];
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  );
}

function isStorageOperationErrorReason(value: string): value is StorageOperationErrorReason {
  return (
    value === "storage-unavailable" ||
    value === "storage-read-failed" ||
    value === "storage-write-failed" ||
    value === "storage-quota-exceeded" ||
    value === "storage-remove-failed"
  );
}
