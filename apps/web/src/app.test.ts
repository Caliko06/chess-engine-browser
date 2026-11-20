import {
  createReviewWasmModuleLoader,
  defaultPlayPieceSet,
  mountReviewApp,
  playReactionMapEngineLines,
  playSpectatorLensFoundation,
  resolveBootstrappedPreviewBuildSha,
  resolveBootstrappedPlayBestMoveProvider,
  resolveGeneratedPieceReviewSet,
  resolvePlayPieceSet,
  resolvePlayReactionMap,
  resolvePlaySpectatorLens,
  reviewAppRootId,
  reviewWasmModuleSpecifier
} from "./app";
import type { PlayBestMoveProvider } from "./play-engine";

function expectEqual<T>(actual: T, expected: T): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`expected ${expectedText}, got ${actualText}`);
  }
}

async function expectRejects(action: () => Promise<unknown>, expectedMessage: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && error.message === expectedMessage) {
      return;
    }
    throw error;
  }
  throw new Error(`expected rejection ${expectedMessage}`);
}

function expectThrows(action: () => unknown, expectedMessage: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && error.message === expectedMessage) {
      return;
    }
    throw error;
  }
  throw new Error(`expected throw ${expectedMessage}`);
}

expectEqual(reviewAppRootId, "chess-review-app");
expectEqual(reviewWasmModuleSpecifier, "./pkg/chess_wasm_bridge_embedded.mjs");
expectEqual(defaultPlayPieceSet, "adr-0206-cburnett-v1");
expectEqual(resolveGeneratedPieceReviewSet("?generatedPieceReview=adr-0108-staunton-v1"), null);
expectEqual(
  resolveGeneratedPieceReviewSet("?generatedPieceReview=adr-0206-cburnett-v1"),
  "adr-0206-cburnett-v1"
);
expectEqual(resolveGeneratedPieceReviewSet("?generatedPieceReview=unknown"), null);
expectEqual(resolveGeneratedPieceReviewSet(""), null);
expectEqual(resolvePlayPieceSet(""), defaultPlayPieceSet);
expectEqual(resolvePlayPieceSet("?generatedPieceReview=unknown"), defaultPlayPieceSet);
expectEqual(resolvePlayPieceSet("?generatedPieceReview=adr-0108-staunton-v1"), defaultPlayPieceSet);
expectEqual(resolvePlayPieceSet("?generatedPieceReview=adr-0137-staunton-sheet-v1"), defaultPlayPieceSet);
expectEqual(playSpectatorLensFoundation, "adr-0142-foundation");
expectEqual(resolvePlaySpectatorLens(""), false);
expectEqual(resolvePlaySpectatorLens("?playSpectatorLens=unknown"), false);
expectEqual(resolvePlaySpectatorLens("?playSpectatorLens=adr-0142-foundation"), true);
expectEqual(playReactionMapEngineLines, "adr-0143-engine-lines");
expectEqual(resolvePlayReactionMap(""), false);
expectEqual(resolvePlayReactionMap("?playReactionMap=unknown"), false);
expectEqual(resolvePlayReactionMap("?playReactionMap=adr-0143-engine-lines"), true);
const bootstrappedProvider: PlayBestMoveProvider = {
  isAvailable: () => true,
  bestMove: () =>
    Promise.resolve({
      ok: true,
      value: { bestMove: "e2e4", depth: 1, scoreCp: 0, nodes: 1, ttHits: 0 }
    })
};
expectEqual(resolveBootstrappedPlayBestMoveProvider({}), undefined);
expectEqual(
  resolveBootstrappedPlayBestMoveProvider({
    __chessPlayBestMoveProvider: bootstrappedProvider
  }),
  bootstrappedProvider
);
expectEqual(resolveBootstrappedPreviewBuildSha({}), "unknown");
expectEqual(
  resolveBootstrappedPreviewBuildSha({
    __chessPreviewBuildSha: "abcdef"
  }),
  "abcdef"
);

expectThrows(
  () =>
    mountReviewApp({
      document: { getElementById: () => null },
      importModule: () =>
        Promise.resolve({
          new_game_json: () => "{}",
          make_move_json: () => "{}",
          best_move_json: () => "{}",
          review_pgn_json: () => "{}",
          review_pgn_with_artifacts_json: () => "{}"
        })
    }),
  "Review app root #chess-review-app was not found"
);

await expectRejects(
  () => createReviewWasmModuleLoader(() => Promise.resolve({}))(),
  "Generated chess wasm module is unavailable"
);

await expectRejects(
  () =>
    createReviewWasmModuleLoader(() =>
      Promise.resolve({
        new_game_json: () => "{}",
        make_move_json: () => "{}",
        best_move_json: () => "{}",
        review_pgn_json: () => "{}",
        review_pgn_with_artifacts_json: "{}"
      })
    )(),
  "Generated chess wasm module is unavailable"
);

let importedSpecifier = "";
const loaded = await createReviewWasmModuleLoader((specifier: string) => {
  importedSpecifier = specifier;
  return Promise.resolve({
    new_game_json: () => JSON.stringify({ ok: false, error: "search-failed" }),
    make_move_json: () => JSON.stringify({ ok: false, error: "invalid-move" }),
    best_move_json: () => JSON.stringify({ ok: false, error: "invalid-depth" }),
    review_pgn_json: () => JSON.stringify({ ok: false, error: "invalid-pgn" }),
    review_pgn_with_artifacts_json: () => JSON.stringify({ ok: false, error: "invalid-pgn" })
  });
})();
expectEqual(importedSpecifier, reviewWasmModuleSpecifier);
expectEqual(loaded.new_game_json(), JSON.stringify({ ok: false, error: "search-failed" }));
expectEqual(loaded.review_pgn_json("", 3), JSON.stringify({ ok: false, error: "invalid-pgn" }));
const reviewWithArtifactsJson = loaded.review_pgn_with_artifacts_json;
if (reviewWithArtifactsJson === undefined) {
  throw new Error("expected artifact review function");
}
expectEqual(
  reviewWithArtifactsJson("", 3),
  JSON.stringify({ ok: false, error: "invalid-pgn" })
);

await expectRejects(
  () =>
    createReviewWasmModuleLoader(() =>
      Promise.resolve({ review_pgn_json: () => JSON.stringify({ ok: false, error: "invalid-pgn" }) })
    )(),
  "Generated chess wasm module is unavailable"
);

class FakeHtmlElement {
  readonly attributes = new Map<string, string>();
  private htmlValue = "";
  private readonly childElements: FakeHtmlElement[] = [];
  value = "";
  selectionStart: number | null = null;
  selectionEnd: number | null = null;

  constructor(attributes: ReadonlyMap<string, string> = new Map(), private textValue = "") {
    for (const [name, value] of attributes) {
      this.attributes.set(name, value);
    }
    this.value = attributes.get("value") ?? "";
  }

  get innerHTML(): string {
    return this.htmlValue;
  }

  set innerHTML(value: string) {
    this.htmlValue = value;
    this.childElements.splice(0, this.childElements.length, ...parseFakeElements(value));
  }

  get textContent(): string {
    return this.textValue;
  }

  set textContent(value: string) {
    this.textValue = value;
  }

  get hidden(): boolean {
    return this.attributes.has("hidden");
  }

  set hidden(value: boolean) {
    this.toggleAttribute("hidden", value);
  }

  querySelector(selector: string): FakeHtmlElement | null {
    return this.childElements.find((element) => matchesSelector(element, selector)) ?? null;
  }

  querySelectorAll(selector: string): FakeHtmlElement[] {
    return this.childElements.filter((element) => matchesSelector(element, selector));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const shouldSet = force ?? !this.attributes.has(name);
    if (shouldSet) {
      this.attributes.set(name, "");
    } else {
      this.attributes.delete(name);
    }
    return shouldSet;
  }

  addEventListener(): void {
  }

  scrollIntoView(): void {
  }

  focus(): void {
  }

  contains(candidate: unknown): boolean {
    return candidate === this || this.childElements.some((element) => element === candidate);
  }
}

function parseFakeElements(html: string): FakeHtmlElement[] {
  const elements: FakeHtmlElement[] = [];
  const tokenPattern = /<(?<tag>[a-z][a-z0-9]*)(?<attributes>[^>]*)>/gu;
  for (const match of html.matchAll(tokenPattern)) {
    const attributes = parseFakeAttributes(match.groups?.attributes ?? "");
    if (![...attributes.keys()].some((name) => name.startsWith("data-"))) {
      continue;
    }
    const tag = match.groups?.tag ?? "";
    const body = bodyText(html, tag, match.index + match[0].length);
    elements.push(new FakeHtmlElement(attributes, stripTags(body)));
  }
  return elements;
}

function parseFakeAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const attributePattern = /(?<name>[a-z-]+)(?:="(?<value>[^"]*)")?/gu;
  for (const match of text.matchAll(attributePattern)) {
    const name = match.groups?.name;
    if (name !== undefined) {
      attributes.set(name, decodeHtml(match.groups?.value ?? ""));
    }
  }
  return attributes;
}

function bodyText(html: string, tag: string, startIndex: number): string {
  const end = html.indexOf(`</${tag}>`, startIndex);
  return end === -1 ? "" : html.slice(startIndex, end);
}

function matchesSelector(element: FakeHtmlElement, selector: string): boolean {
  const attributePattern = /\[(?<name>data-[a-z-]+)="(?<value>[^"]+)"\]/gu;
  const matches = [...selector.matchAll(attributePattern)];
  return (
    matches.length > 0 &&
    matches.every((match) => element.getAttribute(match.groups?.name ?? "") === match.groups?.value)
  );
}

function stripTags(value: string): string {
  return decodeHtml(value.replaceAll(/<[^>]*>/gu, ""));
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function installFakeElementGlobals(): () => void {
  type ElementGlobalScope = {
    HTMLElement?: unknown;
    HTMLInputElement?: unknown;
    HTMLTextAreaElement?: unknown;
    Element?: unknown;
  };
  const scope = globalThis as ElementGlobalScope;
  const previous = {
    HTMLElement: scope.HTMLElement,
    HTMLInputElement: scope.HTMLInputElement,
    HTMLTextAreaElement: scope.HTMLTextAreaElement,
    Element: scope.Element
  };
  scope.HTMLElement = FakeHtmlElement;
  scope.HTMLInputElement = FakeHtmlElement;
  scope.HTMLTextAreaElement = FakeHtmlElement;
  scope.Element = FakeHtmlElement;
  return () => {
    scope.HTMLElement = previous.HTMLElement;
    scope.HTMLInputElement = previous.HTMLInputElement;
    scope.HTMLTextAreaElement = previous.HTMLTextAreaElement;
    scope.Element = previous.Element;
  };
}

function fakeStorageHost(): { readonly localStorage: Storage } {
  const values = new Map<string, string>();
  return {
    localStorage: {
      length: 0,
      clear: () => {
        values.clear();
      },
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => {
        values.delete(key);
      },
      setItem: (key: string, value: string) => {
        values.set(key, value);
      }
    }
  };
}

const restoreElementGlobals = installFakeElementGlobals();
try {
  const appRoot = new FakeHtmlElement();
  let providerPrepareCalls = 0;
  let providerBestMoveCalls = 0;
  let ownedBestMoveCalls = 0;
  const reviewCalls: string[] = [];
  const playBestMoveProvider: PlayBestMoveProvider = {
    isAvailable: () => true,
    prepareNewGame: () => {
      providerPrepareCalls += 1;
      return Promise.resolve({ ok: true, value: undefined });
    },
    bestMove: () => {
      providerBestMoveCalls += 1;
      return Promise.resolve({
        ok: true,
        value: { bestMove: "b8c6", depth: 1, scoreCp: 1, nodes: 1, ttHits: 0 }
      });
    }
  };
  const handle = mountReviewApp({
    document: {
      getElementById: (id) => (id === reviewAppRootId ? appRoot as unknown as HTMLElement : null)
    },
    storageHost: fakeStorageHost(),
    metadataHost: {
      crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
      clock: { nowIso: () => "2026-05-28T00:00:00.000Z" }
    },
    locationSearch: "?play=classic",
    importModule: () =>
      Promise.resolve({
        new_game_json: () =>
          JSON.stringify({
            ok: true,
            state: {
              fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
              status: "ongoing",
              sideToMove: "white",
              legalMoves: ["e2e4"]
            }
          }),
        make_move_json: () => JSON.stringify({ ok: false, error: "invalid-move" }),
        best_move_json: () => {
          ownedBestMoveCalls += 1;
          return JSON.stringify({ ok: false, error: "search-failed" });
        },
        review_pgn_json: (pgn: string, depth: number) => {
          reviewCalls.push(`review:${pgn}:${String(depth)}`);
          return JSON.stringify({ ok: false, error: "invalid-pgn" });
        },
        review_pgn_with_artifacts_json: (pgn: string, depth: number) => {
          reviewCalls.push(`artifacts:${pgn}:${String(depth)}`);
          return JSON.stringify({ ok: false, error: "invalid-pgn" });
        }
      }),
    playBestMoveProvider
  });
  await handle.play.ready;
  const playRoot = appRoot.querySelector('[data-app-ui="play-root"]');
  expectEqual(playRoot?.getAttribute("data-piece-set"), defaultPlayPieceSet);
  expectEqual(playRoot?.getAttribute("data-piece-review-set"), null);
  expectEqual(
    playRoot?.querySelector('[data-play-ui="mode-label"]')?.textContent,
    "Engine: Local Stockfish"
  );
  expectEqual(providerPrepareCalls, 1);
  expectEqual(providerBestMoveCalls, 0);
  expectEqual(ownedBestMoveCalls, 0);
  await handle.review.reviewPgn("1. e4");
  expectEqual(reviewCalls, ["artifacts:1. e4:3"]);
  expectEqual(providerBestMoveCalls, 0);

  const lensAppRoot = new FakeHtmlElement();
  let lensProviderPrepareCalls = 0;
  let lensProviderBestMoveCalls = 0;
  let lensOwnedBestMoveCalls = 0;
  const lensProvider: PlayBestMoveProvider = {
    isAvailable: () => true,
    prepareNewGame: () => {
      lensProviderPrepareCalls += 1;
      return Promise.resolve({ ok: true, value: undefined });
    },
    bestMove: () => {
      lensProviderBestMoveCalls += 1;
      return Promise.resolve({
        ok: true,
        value: { bestMove: "b8c6", depth: 1, scoreCp: 1, nodes: 1, ttHits: 0 }
      });
    }
  };
  const lensHandle = mountReviewApp({
    document: {
      getElementById: (id) => (id === reviewAppRootId ? lensAppRoot as unknown as HTMLElement : null)
    },
    storageHost: fakeStorageHost(),
    metadataHost: {
      crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
      clock: { nowIso: () => "2026-06-02T00:00:00.000Z" }
    },
    locationSearch: `?playSpectatorLens=${playSpectatorLensFoundation}`,
    importModule: () =>
      Promise.resolve({
        new_game_json: () =>
          JSON.stringify({
            ok: true,
            state: {
              fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
              status: "ongoing",
              sideToMove: "white",
              legalMoves: ["e2e4"]
            }
          }),
        make_move_json: () => JSON.stringify({ ok: false, error: "invalid-move" }),
        best_move_json: () => {
          lensOwnedBestMoveCalls += 1;
          return JSON.stringify({
            ok: true,
            bestMove: { bestMove: "e2e4", depth: 1, scoreCp: 4, nodes: 7, ttHits: 0 }
          });
        },
        review_pgn_json: () => JSON.stringify({ ok: false, error: "invalid-pgn" }),
        review_pgn_with_artifacts_json: () => JSON.stringify({ ok: false, error: "invalid-pgn" })
      }),
    playBestMoveProvider: lensProvider
  });
  await lensHandle.play.ready;
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  const lensPlayRoot = lensAppRoot.querySelector('[data-app-ui="play-root"]');
  expectEqual(lensPlayRoot?.getAttribute("data-play-spectator-lens"), playSpectatorLensFoundation);
  expectEqual(
    lensPlayRoot?.querySelector('[data-play-ui="mode-label"]')?.textContent,
    "Motor local propio"
  );
  expectEqual(
    lensPlayRoot?.querySelector('[data-play-ui="analysis-lens"]')?.getAttribute("data-lens-status"),
    "ready"
  );
  expectEqual(lensProviderPrepareCalls, 0);
  expectEqual(lensProviderBestMoveCalls, 0);
  expectEqual(lensOwnedBestMoveCalls, 1);

  const reactionAppRoot = new FakeHtmlElement();
  let reactionProviderPrepareCalls = 0;
  let reactionProviderBestMoveCalls = 0;
  let reactionOwnedBestMoveCalls = 0;
  let reactionSideExploreCalls = 0;
  let reactionForcingMapCalls = 0;
  const reactionEvidenceEvents: unknown[] = [];
  const reactionProvider: PlayBestMoveProvider = {
    isAvailable: () => true,
    prepareNewGame: () => {
      reactionProviderPrepareCalls += 1;
      return Promise.resolve({ ok: true, value: undefined });
    },
    bestMove: () => {
      reactionProviderBestMoveCalls += 1;
      return Promise.resolve({
        ok: true,
        value: { bestMove: "b8c6", depth: 1, scoreCp: 1, nodes: 1, ttHits: 0 }
      });
    }
  };
  const reactionHandle = mountReviewApp({
    document: {
      getElementById: (id) =>
        id === reviewAppRootId ? (reactionAppRoot as unknown as HTMLElement) : null
    },
    storageHost: fakeStorageHost(),
    metadataHost: {
      crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000002" },
      clock: { nowIso: () => "2026-06-03T00:00:00.000Z" }
    },
    locationSearch: `?playReactionMap=${playReactionMapEngineLines}`,
    bootstrapHost: {
      __chessPreviewBuildSha: "test-build-sha"
    },
    playEvidenceSink: (event) => {
      reactionEvidenceEvents.push(event);
      return Promise.resolve(true);
    },
    importModule: () =>
      Promise.resolve({
        new_game_json: () =>
          JSON.stringify({
            ok: true,
            state: {
              fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
              status: "ongoing",
              sideToMove: "white",
              legalMoves: ["e2e4"]
            }
          }),
        make_move_json: () => JSON.stringify({ ok: false, error: "invalid-move" }),
        best_move_json: () => {
          reactionOwnedBestMoveCalls += 1;
          return JSON.stringify({ ok: false, error: "search-failed" });
        },
        side_explore_json: () => {
          reactionSideExploreCalls += 1;
          return JSON.stringify({
            ok: true,
            sideExplore: {
              state: {
                fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                status: "ongoing",
                sideToMove: "white",
                legalMoves: ["e2e4"]
              },
              side: "white",
              onTurn: true,
              replyCandidates: [],
              candidates: [{ move: "e2e4", kind: "capture", exactScoreCp: 4, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }],
              principalLine: ["e2e4"],
              mateDetected: false,
              depth: 1,
              nodes: 7,
              soundMarginCp: 50
            }
          });
        },
        forcing_map_json: () => {
          reactionForcingMapCalls += 1;
          return JSON.stringify({
            ok: true,
            forcingMap: {
              state: {
                fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                status: "ongoing",
                sideToMove: "white",
                legalMoves: ["e2e4"]
              },
              host: "white",
              onTurn: true,
              candidates: [{ move: "e2e4", kind: "defense", scoreCp: 4, sound: true, mateIn: null }],
              depth: 1,
              nodes: 7
            }
          });
        },
        review_pgn_json: () => JSON.stringify({ ok: false, error: "invalid-pgn" }),
        review_pgn_with_artifacts_json: () => JSON.stringify({ ok: false, error: "invalid-pgn" })
      }),
    playBestMoveProvider: reactionProvider
  });
  await reactionHandle.play.ready;
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  const reactionPlayRoot = reactionAppRoot.querySelector('[data-app-ui="play-root"]');
  expectEqual(
    reactionPlayRoot?.getAttribute("data-play-reaction-map"),
    playReactionMapEngineLines
  );
  expectEqual(reactionPlayRoot?.getAttribute("data-play-spectator-lens"), null);
  expectEqual(
    reactionPlayRoot?.querySelector('[data-play-ui="mode-label"]')?.textContent,
    "Análisis local"
  );
  expectEqual(
    reactionPlayRoot
      ?.querySelector('[data-play-ui="reaction-lens"]')
      ?.getAttribute("data-reaction-status"),
    "ready"
  );
  expectEqual(
    reactionPlayRoot?.querySelector('[data-play-ui="reaction-best"]')?.textContent,
    "Jugada recomendadae2 → e4"
  );
  expectEqual(reactionProviderPrepareCalls, 0);
  expectEqual(reactionProviderBestMoveCalls, 0);
  expectEqual(reactionOwnedBestMoveCalls, 1);
  expectEqual(reactionSideExploreCalls, 1);
  expectEqual(reactionForcingMapCalls, 0);
  const recommendationEvidence = reactionEvidenceEvents[0] as {
    readonly schema?: unknown;
    readonly type?: unknown;
    readonly buildSha?: unknown;
    readonly nodeBudget?: unknown;
    readonly primaryMove?: unknown;
    readonly primaryRenderState?: unknown;
    readonly candidates?: readonly unknown[];
  };
  expectEqual(recommendationEvidence.schema, 2);
  expectEqual(recommendationEvidence.type, "recommendation");
  expectEqual(recommendationEvidence.buildSha, "test-build-sha");
  expectEqual(recommendationEvidence.nodeBudget, 100_000);
  expectEqual(recommendationEvidence.primaryMove, "e2e4");
  expectEqual(recommendationEvidence.primaryRenderState, "recommended");
  expectEqual(recommendationEvidence.candidates?.length, 1);
} finally {
  restoreElementGlobals();
}
