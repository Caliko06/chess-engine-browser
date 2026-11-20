import type {
  GameReviewDto,
  ReviewArtifactsDto,
  ReviewPgnRequestDto,
  ReviewSummaryDto,
  WasmBridgeError
} from "./engine-dtos";
import {
  createReviewWasmArtifactExecutor,
  createReviewWasmExecutor,
  type ReviewWasmFailureDiagnostic,
  type ReviewWasmModuleLoader
} from "./review-wasm-executor";

type ReviewWasmModule = Awaited<ReturnType<ReviewWasmModuleLoader>>;

function expectEqual<T>(actual: T, expected: T): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`expected ${expectedText}, got ${actualText}`);
  }
}

function diagnosticRecorder(): {
  readonly diagnostics: () => readonly ReviewWasmFailureDiagnostic[];
  readonly record: (diagnostic: ReviewWasmFailureDiagnostic) => void;
} {
  const diagnostics: ReviewWasmFailureDiagnostic[] = [];
  return {
    diagnostics: () => diagnostics,
    record: (diagnostic) => {
      diagnostics.push(diagnostic);
    }
  };
}

function summary(overrides: Partial<ReviewSummaryDto> = {}): ReviewSummaryDto {
  return {
    totalMoves: 1,
    best: 0,
    good: 0,
    inaccuracies: 0,
    mistakes: 0,
    blunders: 1,
    ...overrides
  };
}

const review: GameReviewDto = {
  summary: summary(),
  entries: [
    {
      ply: 4,
      playedMove: "g2g4",
      san: "g4",
      bestMove: "g2g3",
      bestScoreCp: 40,
      playedScoreCp: -460,
      cpLoss: 500,
      label: "blunder"
    }
  ]
};

const artifacts: ReviewArtifactsDto = {
  keyMoments: [
    {
      rank: 1,
      entryIndex: 0,
      kind: "centipawn-loss",
      ply: 4,
      playedMove: "g2g4",
      san: "g4",
      bestMove: "g2g3",
      bestScoreCp: 40,
      playedScoreCp: -460,
      cpLoss: 500,
      label: "blunder"
    }
  ],
  evidence: [
    {
      rank: 1,
      entryIndex: 0,
      ply: 4,
      kind: "local-search-swing",
      playedMove: "g2g4",
      san: "g4",
      bestMove: "g2g3",
      bestScoreCp: 40,
      playedScoreCp: -460,
      cpLoss: 500,
      label: "blunder"
    }
  ],
  forkCandidates: [
    {
      rank: 1,
      entryIndex: 0,
      ply: 4,
      sourceKind: "best-move-after-position",
      bestMove: "e5f7",
      movedPiece: { color: "white", kind: "knight" },
      destination: "f7",
      targets: [
        { square: "d8", piece: { color: "black", kind: "queen" } },
        { square: "h8", piece: { color: "black", kind: "rook" } }
      ],
      cpLoss: 500,
      label: "blunder"
    }
  ],
  earlyMoveDivergences: [
    {
      entryIndex: 0,
      ply: 4,
      playedMove: "g2g4",
      san: "g4",
      localBestMove: "g2g3",
      bestScoreCp: 40,
      playedScoreCp: -460,
      cpLoss: 500,
      label: "blunder"
    }
  ],
  retryPositions: [
    {
      rank: 1,
      entryIndex: 0,
      ply: 4,
      fenBefore: "rnbqkbnr/pppp1ppp/8/4p3/5P2/8/PPPPP1PP/RNBQKBNR w KQkq - 0 2",
      playedMove: "g2g4",
      bestMove: "g2g3",
      san: "g4",
      label: "blunder",
      cpLoss: 500
    }
  ]
};

function requireForkCandidate(
  candidate: ReviewArtifactsDto["forkCandidates"][number] | undefined
): ReviewArtifactsDto["forkCandidates"][number] {
  if (candidate === undefined) {
    throw new Error("test fixture fork candidate should exist");
  }
  return candidate;
}

function requireReviewEntry(
  entry: GameReviewDto["entries"][number] | undefined
): GameReviewDto["entries"][number] {
  if (entry === undefined) {
    throw new Error("test fixture review entry should exist");
  }
  return entry;
}

function requireKeyMoment(
  keyMoment: ReviewArtifactsDto["keyMoments"][number] | undefined
): ReviewArtifactsDto["keyMoments"][number] {
  if (keyMoment === undefined) {
    throw new Error("test fixture key moment should exist");
  }
  return keyMoment;
}

const maxEntriesPerReview = 512;

const requests: ReviewPgnRequestDto[] = [];
let loadCount = 0;
const wasmModule: ReviewWasmModule = {
  review_pgn_json: (pgn: string, depth: number) => {
    requests.push({ pgn, depth });
    return JSON.stringify({ ok: true, review });
  }
};
const loader: ReviewWasmModuleLoader = () => {
  loadCount += 1;
  return Promise.resolve(wasmModule);
};

const reviewPgn = createReviewWasmExecutor(loader);
expectEqual(await reviewPgn({ pgn: "1. f3 e5 2. g4 Qh4# 0-1", depth: 3 }), {
  ok: true,
  review,
  artifacts: null
});
expectEqual(await reviewPgn({ pgn: "1. e4 *", depth: 4 }), { ok: true, review, artifacts: null });
expectEqual(loadCount, 1);
expectEqual(requests, [
  { pgn: "1. f3 e5 2. g4 Qh4# 0-1", depth: 3 },
  { pgn: "1. e4 *", depth: 4 }
]);

const errors: readonly WasmBridgeError[] = [
  "invalid-fen",
  "invalid-pgn",
  "invalid-move",
  "invalid-depth",
  "invalid-position",
  "search-failed"
];
for (const error of errors) {
  const recorder = diagnosticRecorder();
  const failingExecutor = createReviewWasmExecutor(
    () =>
      Promise.resolve({
        review_pgn_json: () => JSON.stringify({ ok: false, error })
      }),
    { onFailure: recorder.record }
  );
  expectEqual(await failingExecutor({ pgn: "bad", depth: 3 }), { ok: false, error });
  expectEqual(recorder.diagnostics(), []);
}

const invalidJsonDiagnostics = diagnosticRecorder();
const invalidJsonExecutor = createReviewWasmExecutor(
  () =>
    Promise.resolve({
      review_pgn_json: () => "{"
    }),
  { onFailure: invalidJsonDiagnostics.record }
);
expectEqual(await invalidJsonExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});
expectEqual(invalidJsonDiagnostics.diagnostics(), [{ kind: "invalid-json" }]);

const malformedDiagnostics = diagnosticRecorder();
const malformedExecutor = createReviewWasmExecutor(
  () =>
    Promise.resolve({
      review_pgn_json: () => JSON.stringify({ ok: true, review: { entries: [] } })
    }),
  { onFailure: malformedDiagnostics.record }
);
expectEqual(await malformedExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});
expectEqual(malformedDiagnostics.diagnostics(), [{ kind: "invalid-review-dto" }]);

const unknownErrorDiagnostics = diagnosticRecorder();
const unknownErrorExecutor = createReviewWasmExecutor(
  () =>
    Promise.resolve({
      review_pgn_json: () => JSON.stringify({ ok: false, error: "not-a-bridge-error" })
    }),
  { onFailure: unknownErrorDiagnostics.record }
);
expectEqual(await unknownErrorExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});
expectEqual(unknownErrorDiagnostics.diagnostics(), [{ kind: "unknown-error-code" }]);

const throwingDiagnostics = diagnosticRecorder();
const throwingExecutor = createReviewWasmExecutor(
  () =>
    Promise.resolve({
      review_pgn_json: () => {
        throw new Error("bridge call failed");
      }
    }),
  { onFailure: throwingDiagnostics.record }
);
expectEqual(await throwingExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});
expectEqual(throwingDiagnostics.diagnostics(), [{ kind: "wasm-call-threw" }]);

const rejectedLoaderDiagnostics = diagnosticRecorder();
const rejectedLoaderExecutor = createReviewWasmExecutor(
  () => Promise.reject(new Error("load failed")),
  { onFailure: rejectedLoaderDiagnostics.record }
);
expectEqual(await rejectedLoaderExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});
expectEqual(rejectedLoaderDiagnostics.diagnostics(), [{ kind: "module-load" }]);

const artifactRequests: ReviewPgnRequestDto[] = [];
const artifactExecutor = createReviewWasmArtifactExecutor(() =>
  Promise.resolve({
    review_pgn_json: () => JSON.stringify({ ok: true, review }),
    review_pgn_with_artifacts_json: (pgn: string, depth: number) => {
      artifactRequests.push({ pgn, depth });
      return JSON.stringify({ ok: true, reviewWithArtifacts: { review, artifacts } });
    }
  })
);
expectEqual(await artifactExecutor({ pgn: "1. f3 e5 2. g4 Qh4# 0-1", depth: 3 }), {
  ok: true,
  review,
  artifacts
});
expectEqual(artifactRequests, [{ pgn: "1. f3 e5 2. g4 Qh4# 0-1", depth: 3 }]);

const missingArtifactDiagnostics = diagnosticRecorder();
const missingArtifactExecutor = createReviewWasmArtifactExecutor(
  () =>
    Promise.resolve({
      review_pgn_json: () => JSON.stringify({ ok: true, review })
    }),
  { onFailure: missingArtifactDiagnostics.record }
);
expectEqual(await missingArtifactExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: true,
  review,
  artifacts: null
});
expectEqual(missingArtifactDiagnostics.diagnostics(), [{ kind: "missing-artifact-export" }]);

const invalidFallbackDiagnostics = diagnosticRecorder();
const invalidFallbackExecutor = createReviewWasmArtifactExecutor(
  () =>
    Promise.resolve({
      review_pgn_json: () => JSON.stringify({ ok: true, review: { entries: [] } })
    }),
  { onFailure: invalidFallbackDiagnostics.record }
);
expectEqual(await invalidFallbackExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});
expectEqual(invalidFallbackDiagnostics.diagnostics(), [
  { kind: "missing-artifact-export" },
  { kind: "invalid-review-dto" }
]);

const malformedArtifactDiagnostics = diagnosticRecorder();
const malformedArtifactExecutor = createReviewWasmArtifactExecutor(
  () =>
    Promise.resolve({
      review_pgn_json: () => JSON.stringify({ ok: true, review }),
      review_pgn_with_artifacts_json: () =>
        JSON.stringify({
          ok: true,
          reviewWithArtifacts: {
            review,
            artifacts: { ...artifacts, keyMoments: [{ ...artifacts.keyMoments[0], extra: true }] }
          }
        })
    }),
  { onFailure: malformedArtifactDiagnostics.record }
);
expectEqual(await malformedArtifactExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});
expectEqual(malformedArtifactDiagnostics.diagnostics(), [{ kind: "invalid-artifacts-dto" }]);

const oversizedReviewDiagnostics = diagnosticRecorder();
const oversizedReviewExecutor = createReviewWasmArtifactExecutor(
  () =>
    Promise.resolve({
      review_pgn_json: () => JSON.stringify({ ok: true, review }),
      review_pgn_with_artifacts_json: () =>
        JSON.stringify({
          ok: true,
          reviewWithArtifacts: {
            review: {
              ...review,
              entries: Array.from(
                { length: maxEntriesPerReview + 1 },
                () => requireReviewEntry(review.entries[0])
              )
            },
            artifacts
          }
        })
    }),
  { onFailure: oversizedReviewDiagnostics.record }
);
expectEqual(await oversizedReviewExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});
expectEqual(oversizedReviewDiagnostics.diagnostics(), [{ kind: "invalid-review-dto" }]);

const oversizedArtifactDiagnostics = diagnosticRecorder();
const oversizedArtifactExecutor = createReviewWasmArtifactExecutor(
  () =>
    Promise.resolve({
      review_pgn_json: () => JSON.stringify({ ok: true, review }),
      review_pgn_with_artifacts_json: () =>
        JSON.stringify({
          ok: true,
          reviewWithArtifacts: {
            review,
            artifacts: {
              ...artifacts,
              keyMoments: Array.from(
                { length: maxEntriesPerReview + 1 },
                () => requireKeyMoment(artifacts.keyMoments[0])
              )
            }
          }
        })
    }),
  { onFailure: oversizedArtifactDiagnostics.record }
);
expectEqual(await oversizedArtifactExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});
expectEqual(oversizedArtifactDiagnostics.diagnostics(), [{ kind: "invalid-artifacts-dto" }]);

const missingForkCandidatesExecutor = createReviewWasmArtifactExecutor(() =>
  Promise.resolve({
    review_pgn_json: () => JSON.stringify({ ok: true, review }),
    review_pgn_with_artifacts_json: () =>
      JSON.stringify({
        ok: true,
        reviewWithArtifacts: {
          review,
          artifacts: {
            keyMoments: artifacts.keyMoments,
            evidence: artifacts.evidence,
            earlyMoveDivergences: artifacts.earlyMoveDivergences,
            retryPositions: artifacts.retryPositions
          }
        }
      })
  })
);
expectEqual(await missingForkCandidatesExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});

const incompleteForkCandidateDiagnostics = diagnosticRecorder();
const incompleteForkCandidateExecutor = createReviewWasmArtifactExecutor(
  () =>
    Promise.resolve({
      review_pgn_json: () => JSON.stringify({ ok: true, review }),
      review_pgn_with_artifacts_json: () =>
        JSON.stringify({
          ok: true,
          reviewWithArtifacts: {
            review,
            artifacts: {
              ...artifacts,
              forkCandidates: [
                {
                  ...requireForkCandidate(artifacts.forkCandidates[0]),
                  targets: [{ square: "d8", piece: { color: "black", kind: "queen" } }]
                }
              ]
            }
          }
        })
    }),
  { onFailure: incompleteForkCandidateDiagnostics.record }
);
expectEqual(await incompleteForkCandidateExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});
expectEqual(incompleteForkCandidateDiagnostics.diagnostics(), [{ kind: "invalid-artifacts-dto" }]);

const malformedForkCandidateExecutor = createReviewWasmArtifactExecutor(() =>
  Promise.resolve({
    review_pgn_json: () => JSON.stringify({ ok: true, review }),
    review_pgn_with_artifacts_json: () =>
      JSON.stringify({
        ok: true,
        reviewWithArtifacts: {
          review,
          artifacts: {
            ...artifacts,
            forkCandidates: [
              {
                ...requireForkCandidate(artifacts.forkCandidates[0]),
                targets: [{ square: "d8", piece: { color: "black", kind: "dragon" } }]
              }
            ]
          }
        }
      })
  })
);
expectEqual(await malformedForkCandidateExecutor({ pgn: "1. e4 *", depth: 3 }), {
  ok: false,
  error: "search-failed"
});
