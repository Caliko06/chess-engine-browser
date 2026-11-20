import {
  createBrowserSaveMetadataProvider,
  createBrowserStorage,
  type BrowserMetadataHost,
  type BrowserStorageHost
} from "./review-browser-edge.js";
import { mountAnalyzerUi, type AnalyzerUiHandle } from "./analyzer-ui.js";
import { createHybridPlayEngine, type PlayBestMoveProvider } from "./play-engine.js";
import {
  mountPlayUi,
  type PlayAutomaticEvidenceSink,
  type PlayGameArchiveSink,
  type PlayUiHandle
} from "./play-ui.js";
import { createPlayWasmExecutor, type PlayWasmModule } from "./play-wasm-executor.js";
import { createPlayWorkerEngine } from "./play-worker-engine.js";
import { mountReviewUi, type ReviewUiHandle } from "./review-ui.js";
import {
  createReviewWasmArtifactExecutor,
  type ReviewWasmModule
} from "./review-wasm-executor.js";

export const reviewAppRootId = "chess-review-app";
export const reviewWasmModuleSpecifier = "./pkg/chess_wasm_bridge_embedded.mjs";

export type ReviewAppDocument = {
  readonly getElementById: (id: string) => HTMLElement | null;
  readonly documentElement?: { readonly lang: string };
};

export type ReviewWasmDynamicImporter = (specifier: string) => Promise<unknown>;

export type ChessWasmModule = ReviewWasmModule & PlayWasmModule;
export type ChessWasmModuleLoader = () => Promise<ChessWasmModule>;

export type ReviewAppOptions = {
  readonly document?: ReviewAppDocument;
  readonly storageHost?: BrowserStorageHost;
  readonly metadataHost?: BrowserMetadataHost;
  readonly importModule?: ReviewWasmDynamicImporter;
  readonly locationSearch?: string;
  readonly playBestMoveProvider?: PlayBestMoveProvider;
  readonly playEvidenceSink?: PlayAutomaticEvidenceSink;
  readonly playGameArchiveSink?: PlayGameArchiveSink;
  readonly bootstrapHost?: ReviewAppBootstrapHost;
};

export type ReviewAppBootstrapHost = {
  readonly __chessPlayBestMoveProvider?: PlayBestMoveProvider;
  readonly __chessPreviewBuildSha?: string;
};

export type ChessAppHandle = {
  readonly play: PlayUiHandle;
  readonly review: ReviewUiHandle;
  readonly analyzer: AnalyzerUiHandle;
};

const generatedPieceReviewParam = "generatedPieceReview";
const playSpectatorLensParam = "playSpectatorLens";
const playReactionMapParam = "playReactionMap";
export const defaultPlayPieceSet = "adr-0206-cburnett-v1";
export const playSpectatorLensFoundation = "adr-0142-foundation";
export const playReactionMapEngineLines = "adr-0143-engine-lines";
const generatedPieceReviewSets = new Set([
  defaultPlayPieceSet
]);

export function resolveGeneratedPieceReviewSet(search: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const value = params.get(generatedPieceReviewParam);
  return value !== null && generatedPieceReviewSets.has(value) ? value : null;
}

export function resolvePlayPieceSet(search: string): string {
  return resolveGeneratedPieceReviewSet(search) ?? defaultPlayPieceSet;
}

export function resolvePlaySpectatorLens(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return params.get(playSpectatorLensParam) === playSpectatorLensFoundation;
}

export function resolvePlayReactionMap(search: string): boolean {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return params.get(playReactionMapParam) === playReactionMapEngineLines;
}

export function resolveBootstrappedPlayBestMoveProvider(
  host: ReviewAppBootstrapHost
): PlayBestMoveProvider | undefined {
  return host.__chessPlayBestMoveProvider;
}

export function resolveBootstrappedPreviewBuildSha(host: ReviewAppBootstrapHost): string {
  return typeof host.__chessPreviewBuildSha === "string" && host.__chessPreviewBuildSha.length > 0
    ? host.__chessPreviewBuildSha
    : "unknown";
}

// The archive and evidence endpoints exist only on the local preview server (`just preview`);
// the public site (calichess.cc) is static files, so it does not post to them.
function isLocalPreviewHost(): boolean {
  const hostname = typeof location === "undefined" ? "" : location.hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export function createBrowserPlayGameArchiveSink(): PlayGameArchiveSink | undefined {
  if (!isLocalPreviewHost()) {
    return undefined;
  }
  // eslint-disable-next-line no-restricted-globals -- ADR-0241 allows this same-origin archive endpoint only.
  if (typeof fetch !== "function") {
    return undefined;
  }
  return async (record) => {
    try {
      // eslint-disable-next-line no-restricted-globals -- ADR-0241 allows this same-origin archive endpoint only.
      const response = await fetch("/game-archive/append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record)
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}

export function createBrowserPlayEvidenceSink(): PlayAutomaticEvidenceSink | undefined {
  if (!isLocalPreviewHost()) {
    return undefined;
  }
  // eslint-disable-next-line no-restricted-globals -- ADR-0227 allows this same-origin evidence endpoint only.
  if (typeof fetch !== "function") {
    return undefined;
  }
  return async (event) => {
    try {
      // eslint-disable-next-line no-restricted-globals -- ADR-0227 allows this same-origin evidence endpoint only.
      const response = await fetch("/evidence/append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event)
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}

export function mountReviewApp(options: ReviewAppOptions = {}): ChessAppHandle {
  const ownerDocument = options.document ?? document;
  const root = ownerDocument.getElementById(reviewAppRootId);
  if (root === null) {
    throw new Error(`Review app root #${reviewAppRootId} was not found`);
  }
  root.innerHTML = [
    `<div data-app-ui="root">`,
    `<div data-app-ui="play-root"></div>`,
    `<section data-app-ui="analyzer-root" aria-label="Analyzer"></section>`,
    `<section data-app-ui="post-game-review" aria-labelledby="post-game-review-title" hidden>`,
    `<h2 id="post-game-review-title" data-app-ui="post-game-review-title">Post-game review</h2>`,
    `<div data-app-ui="review-root"></div>`,
    `</section>`,
    `</div>`
  ].join("");
  const playRoot = root.querySelector('[data-app-ui="play-root"]');
  const postGameReview = root.querySelector('[data-app-ui="post-game-review"]');
  const reviewRoot = root.querySelector('[data-app-ui="review-root"]');
  if (
    !(playRoot instanceof HTMLElement) ||
    !(postGameReview instanceof HTMLElement) ||
    !(reviewRoot instanceof HTMLElement)
  ) {
    throw new Error("Chess app shell was not mounted");
  }
  const locationSearch = options.locationSearch ?? (typeof window === "undefined" ? "" : window.location.search);
  const pieceReviewSet = resolveGeneratedPieceReviewSet(locationSearch);
  const pieceSet = resolvePlayPieceSet(locationSearch);
  // A flag-free production mount is the Explore workspace. Explicit query routes keep
  // their existing opt-in/opt-out semantics for compatibility and proof isolation.
  const reactionLens = locationSearch === "" ? true : resolvePlayReactionMap(locationSearch);
  const spectatorLens = !reactionLens && resolvePlaySpectatorLens(locationSearch);
  const bootstrapHost =
    options.bootstrapHost ?? (globalThis as ReviewAppBootstrapHost);
  const previewBuildSha = resolveBootstrappedPreviewBuildSha(bootstrapHost);
  playRoot.setAttribute("data-piece-set", pieceSet);
  if (pieceReviewSet !== null) {
    playRoot.setAttribute("data-piece-review-set", pieceReviewSet);
  }
  if (spectatorLens) {
    playRoot.setAttribute("data-play-spectator-lens", playSpectatorLensFoundation);
  }
  if (reactionLens) {
    playRoot.setAttribute("data-play-reaction-map", playReactionMapEngineLines);
  }

  const storageHost = options.storageHost ?? window;
  const storage = createBrowserStorage(storageHost);
  const createSaveMetadata =
    options.metadataHost === undefined
      ? createBrowserSaveMetadataProvider()
      : createBrowserSaveMetadataProvider(options.metadataHost);
  const wasmModule = createReviewWasmModuleLoader(options.importModule ?? dynamicImport);
  let reviewHandle: ReviewUiHandle | null = null;
  const ownedPlayEngine =
    typeof Worker !== "undefined"
      ? createPlayWorkerEngine("./dist/play-move-worker.js", "./dist/play-worker.js")
      : createPlayWasmExecutor(wasmModule);
  const ownedEngineOnly = spectatorLens || reactionLens;
  const playEngine = ownedEngineOnly
    ? ownedPlayEngine
    : createHybridPlayEngine({
        owned: ownedPlayEngine,
        stockfishProvider: options.playBestMoveProvider
      });
  // The page language picks the UI language: index.html says "es"; calichess.cc sets it from the browser.
  const locale = ownerDocument.documentElement?.lang.startsWith("en") === true ? "en" : "es";
  const play = mountPlayUi(playRoot, {
    engine: playEngine,
    analysisEngine: ownedPlayEngine,
    initialAggressive: reactionLens,
    locale,
    spectatorLens,
    reactionLens,
    onPlayReset: () => {
      postGameReview.hidden = true;
      playRoot.scrollIntoView({ block: "start" });
    },
    onReviewGame: (game) => {
      postGameReview.hidden = false;
      void reviewHandle?.reviewPgn(game.pgn);
      postGameReview.scrollIntoView({ block: "start" });
    },
    automaticEvidence: {
      buildSha: previewBuildSha,
      sink: options.playEvidenceSink ?? createBrowserPlayEvidenceSink() ?? (() => Promise.resolve(false))
    },
    gameArchiveSink: options.playGameArchiveSink ?? createBrowserPlayGameArchiveSink()
  });
  const reviewPgn = createReviewWasmArtifactExecutor(wasmModule);
  const review = mountReviewUi(reviewRoot, {
    storage,
    reviewPgn,
    createSaveMetadata,
    locale
  });
  reviewHandle = review;
  const analyzerRoot = root.querySelector('[data-app-ui="analyzer-root"]');
  if (!(analyzerRoot instanceof HTMLElement)) {
    throw new Error("Chess app shell was not mounted");
  }
  const analyzer = mountAnalyzerUi({ root: analyzerRoot, locale });

  return { play, review, analyzer };
}

export function createReviewWasmModuleLoader(
  importModule: ReviewWasmDynamicImporter = dynamicImport
): ChessWasmModuleLoader {
  return async () => {
    const module = await importModule(reviewWasmModuleSpecifier);
    if (!isChessWasmModule(module)) {
      throw new Error("Generated chess wasm module is unavailable");
    }
    return module;
  };
}

function isChessWasmModule(value: unknown): value is ChessWasmModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "new_game_json" in value &&
    typeof value.new_game_json === "function" &&
    "make_move_json" in value &&
    typeof value.make_move_json === "function" &&
    "best_move_json" in value &&
    typeof value.best_move_json === "function" &&
    (!("reaction_map_json" in value) || typeof value.reaction_map_json === "function") &&
    (!("forcing_map_json" in value) || typeof value.forcing_map_json === "function") &&
    "review_pgn_json" in value &&
    typeof value.review_pgn_json === "function" &&
    (!("review_pgn_with_artifacts_json" in value) ||
      typeof value.review_pgn_with_artifacts_json === "function")
  );
}

function dynamicImport(specifier: string): Promise<unknown> {
  return import(specifier);
}

if (typeof document !== "undefined") {
  const playBestMoveProvider = resolveBootstrappedPlayBestMoveProvider(
    globalThis as ReviewAppBootstrapHost
  );
  if (playBestMoveProvider === undefined) {
    mountReviewApp();
  } else {
    mountReviewApp({ playBestMoveProvider });
  }
}
