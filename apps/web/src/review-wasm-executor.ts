import type {
  ReviewPgnWithArtifactsDto,
  ReviewPgnRequestDto,
  WasmBridgeError
} from "./engine-dtos.js";
import type {
  ReviewPgnForWorkflow,
  ReviewWorkflowReviewResult
} from "./review-workflow.js";
import {
  exactKeys,
  isRecord,
  validateCurrentReviewArtifactsDto as validateArtifacts,
  validateGameReviewDto as validateReview
} from "./review-validators.js";

export type ReviewWasmModule = {
  readonly review_pgn_json: (pgn: string, depth: number) => string;
  readonly review_pgn_with_artifacts_json?: (pgn: string, depth: number) => string;
};

export type ReviewWasmModuleLoader = () => Promise<ReviewWasmModule>;

export type ReviewWasmFailureKind =
  | "module-load"
  | "missing-artifact-export"
  | "wasm-call-threw"
  | "invalid-json"
  | "invalid-envelope"
  | "unknown-error-code"
  | "invalid-review-dto"
  | "invalid-artifacts-dto";

export type ReviewWasmFailureDiagnostic = {
  readonly kind: ReviewWasmFailureKind;
};

type ReviewWasmFailureReporter = (diagnostic: ReviewWasmFailureDiagnostic) => void;

export type ReviewWasmExecutorOptions = {
  readonly onFailure?: ReviewWasmFailureReporter;
};

export function createReviewWasmExecutor(
  loadModule: ReviewWasmModuleLoader,
  options: ReviewWasmExecutorOptions = {}
): ReviewPgnForWorkflow {
  let modulePromise: Promise<ReviewWasmModule> | null = null;
  const loadOnce = (): Promise<ReviewWasmModule> => {
    modulePromise = modulePromise ?? loadModule();
    return modulePromise;
  };

  return async (request: ReviewPgnRequestDto): Promise<ReviewWorkflowReviewResult> => {
    let wasmModule: ReviewWasmModule;
    try {
      wasmModule = await loadOnce();
    } catch {
      reportFailure(options.onFailure, "module-load");
      return { ok: false, error: "search-failed" };
    }
    try {
      return parseReviewResult(
        wasmModule.review_pgn_json(request.pgn, request.depth),
        false,
        options.onFailure
      );
    } catch {
      reportFailure(options.onFailure, "wasm-call-threw");
      return { ok: false, error: "search-failed" };
    }
  };
}

export function createReviewWasmArtifactExecutor(
  loadModule: ReviewWasmModuleLoader,
  options: ReviewWasmExecutorOptions = {}
): ReviewPgnForWorkflow {
  let modulePromise: Promise<ReviewWasmModule> | null = null;
  const loadOnce = (): Promise<ReviewWasmModule> => {
    modulePromise = modulePromise ?? loadModule();
    return modulePromise;
  };

  return async (request: ReviewPgnRequestDto): Promise<ReviewWorkflowReviewResult> => {
    let wasmModule: ReviewWasmModule;
    try {
      wasmModule = await loadOnce();
    } catch {
      reportFailure(options.onFailure, "module-load");
      return { ok: false, error: "search-failed" };
    }
    if (typeof wasmModule.review_pgn_with_artifacts_json !== "function") {
      reportFailure(options.onFailure, "missing-artifact-export");
      try {
        return parseReviewResult(
          wasmModule.review_pgn_json(request.pgn, request.depth),
          false,
          options.onFailure
        );
      } catch {
        reportFailure(options.onFailure, "wasm-call-threw");
        return { ok: false, error: "search-failed" };
      }
    }
    try {
      return parseReviewResult(
        wasmModule.review_pgn_with_artifacts_json(request.pgn, request.depth),
        true,
        options.onFailure
      );
    } catch {
      reportFailure(options.onFailure, "wasm-call-threw");
      return { ok: false, error: "search-failed" };
    }
  };
}

function parseReviewResult(
  serialized: string,
  requireArtifacts: boolean,
  report?: ReviewWasmFailureReporter
): ReviewWorkflowReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    reportFailure(report, "invalid-json");
    return { ok: false, error: "search-failed" };
  }

  if (!isRecord(parsed) || !("ok" in parsed)) {
    reportFailure(report, "invalid-envelope");
    return { ok: false, error: "search-failed" };
  }
  if (parsed.ok === false && isWasmBridgeError(parsed.error)) {
    return { ok: false, error: parsed.error };
  }
  if (parsed.ok === false) {
    reportFailure(report, "unknown-error-code");
    return { ok: false, error: "search-failed" };
  }
  if (parsed.ok === true) {
    if (requireArtifacts) {
      const reviewWithArtifacts = validateReviewWithArtifacts(parsed.reviewWithArtifacts, report);
      if (reviewWithArtifacts !== null) {
        return {
          ok: true,
          review: reviewWithArtifacts.review,
          artifacts: reviewWithArtifacts.artifacts
        };
      }
      return { ok: false, error: "search-failed" };
    } else {
      const review = validateReview(parsed.review);
      if (review !== null) {
        return { ok: true, review, artifacts: null };
      }
      reportFailure(report, "invalid-review-dto");
      return { ok: false, error: "search-failed" };
    }
  }
  reportFailure(report, "invalid-envelope");
  return { ok: false, error: "search-failed" };
}

function validateReviewWithArtifacts(
  value: unknown,
  report?: ReviewWasmFailureReporter
): ReviewPgnWithArtifactsDto | null {
  if (!isRecord(value) || !exactKeys(value, ["review", "artifacts"])) {
    reportFailure(report, "invalid-artifacts-dto");
    return null;
  }
  const review = validateReview(value.review);
  if (review === null) {
    reportFailure(report, "invalid-review-dto");
    return null;
  }
  const artifacts = validateArtifacts(value.artifacts);
  if (artifacts === null) {
    reportFailure(report, "invalid-artifacts-dto");
    return null;
  }
  return { review, artifacts };
}

function reportFailure(
  report: ReviewWasmFailureReporter | undefined,
  kind: ReviewWasmFailureKind
): void {
  report?.({ kind });
}

function isWasmBridgeError(value: unknown): value is WasmBridgeError {
  return (
    value === "invalid-fen" ||
    value === "invalid-pgn" ||
    value === "invalid-move" ||
    value === "invalid-depth" ||
    value === "invalid-position" ||
    value === "search-failed"
  );
}
