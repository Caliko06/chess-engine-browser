import type {
  GameReviewDto,
  ReviewArtifactsDto,
  ReviewEntryDto,
  ReviewPgnRequestDto,
  ReviewSummaryDto,
  WasmBridgeError
} from "./engine-dtos";
import type { StorageLike, StoredReviewV3 } from "./review-store";
import {
  mountReviewUi,
  type ReviewUiDependencies
} from "./review-ui";

type Listener = () => void | Promise<void>;

type FakeElement = {
  readonly selector: string;
  value: string;
  disabled: boolean;
  readonly textContent: string;
  readonly attributes: ReadonlyMap<string, string>;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  toggleAttribute: (name: string, force?: boolean) => boolean;
  addEventListener: (type: string, listener: Listener) => void;
  dispatchEvent: (event: Event) => boolean;
  dispatch: (type: string) => Promise<void>;
};

type FakeRoot = HTMLElement & {
  readonly elements: () => ReadonlyMap<string, FakeElement>;
  readonly html: () => string;
  querySelectorAll: (selector: string) => readonly FakeElement[];
};

type MemoryStorage = StorageLike & {
  readonly entries: () => ReadonlyMap<string, string>;
  readonly writeRaw: (key: string, value: string) => void;
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
    entries: () => values,
    writeRaw: (key: string, value: string) => {
      values.set(key, value);
    }
  };
}

function fakeRoot(): FakeRoot {
  let html = "";
  let elements = new Map<string, FakeElement>();
  const root = {
    get innerHTML() {
      return html;
    },
    set innerHTML(next: string) {
      html = next;
      elements = parseElements(next);
    },
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: (selector: string) =>
      [...elements.values()].filter((element) => elementMatchesSelector(element, selector)),
    elements: () => elements,
    html: () => html
  };
  return root as unknown as FakeRoot;
}

function parseElements(html: string): Map<string, FakeElement> {
  const elements = new Map<string, FakeElement>();
  const tokenPattern = /<(?<tag>[a-z][a-z0-9]*)(?<attributes>[^>]*)>/gu;
  for (const match of html.matchAll(tokenPattern)) {
    const tag = match.groups?.tag ?? "";
    const attributes = parseAttributes(match.groups?.attributes ?? "");
    const uiName = attributes.get("data-review-ui");
    if (uiName === undefined) {
      continue;
    }
    const body = bodyText(html, tag, match.index + match[0].length);
    const reviewId = attributes.get("data-review-id");
    const reviewIndex = attributes.get("data-review-index");
    const square = attributes.get("data-square");
    const boardRank = attributes.get("data-board-rank");
    const boardFile = attributes.get("data-board-file");
    const boardOrientation = attributes.get("data-board-orientation");
    let selector = `[data-review-ui="${uiName}"]`;
    if (reviewId !== undefined) {
      selector = `[data-review-ui="${uiName}"][data-review-id="${reviewId}"]`;
    } else if (reviewIndex !== undefined) {
      selector = `[data-review-ui="${uiName}"][data-review-index="${reviewIndex}"]`;
    } else if (square !== undefined) {
      selector = `[data-review-ui="${uiName}"][data-square="${square}"]`;
    } else if (boardRank !== undefined) {
      selector = `[data-review-ui="${uiName}"][data-board-rank="${boardRank}"]`;
    } else if (boardFile !== undefined) {
      selector = `[data-review-ui="${uiName}"][data-board-file="${boardFile}"]`;
    } else if (boardOrientation !== undefined) {
      selector = `[data-review-ui="${uiName}"][data-board-orientation="${boardOrientation}"]`;
    }
    elements.set(selector, fakeElement(tag, selector, attributes, stripTags(body)));
  }
  return elements;
}

function bodyText(html: string, tag: string, startIndex: number): string {
  const end = html.indexOf(`</${tag}>`, startIndex);
  return end === -1 ? "" : html.slice(startIndex, end);
}

function parseAttributes(text: string): Map<string, string> {
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

function fakeElement(
  tag: string,
  selector: string,
  attributes: ReadonlyMap<string, string>,
  textContent: string
): FakeElement {
  const listeners = new Map<string, Listener[]>();
  const mutableAttributes = new Map(attributes);
  return {
    selector,
    value: mutableAttributes.get("value") ?? (tag === "textarea" ? textContent : ""),
    disabled: mutableAttributes.has("disabled"),
    textContent,
    attributes: mutableAttributes,
    getAttribute: (name: string) => mutableAttributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      mutableAttributes.set(name, value);
    },
    removeAttribute: (name: string) => {
      mutableAttributes.delete(name);
    },
    toggleAttribute: (name: string, force?: boolean) => {
      const shouldSet = force ?? !mutableAttributes.has(name);
      if (shouldSet) {
        mutableAttributes.set(name, "");
      } else {
        mutableAttributes.delete(name);
      }
      return shouldSet;
    },
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) {
        void listener();
      }
      return true;
    },
    dispatch: async (type: string) => {
      for (const listener of listeners.get(type) ?? []) {
        await listener();
      }
    }
  };
}

function elementMatchesSelector(element: FakeElement, selector: string): boolean {
  const uiMatch = /\[data-review-ui="(?<name>[^"]+)"\]/u.exec(selector);
  const reviewIdMatch = /\[data-review-id="(?<id>.*)"\]/u.exec(selector);
  const reviewIndexMatch = /\[data-review-index="(?<index>.*)"\]/u.exec(selector);
  const squareMatch = /\[data-square="(?<square>.*)"\]/u.exec(selector);
  const boardRankMatch = /\[data-board-rank="(?<rank>.*)"\]/u.exec(selector);
  const boardFileMatch = /\[data-board-file="(?<file>.*)"\]/u.exec(selector);
  const boardOrientationMatch = /\[data-board-orientation="(?<orientation>.*)"\]/u.exec(selector);
  const uiName = uiMatch?.groups?.name;
  if (uiName !== undefined && element.attributes.get("data-review-ui") !== uiName) {
    return false;
  }
  const reviewId = reviewIdMatch?.groups?.id;
  if (reviewId !== undefined && element.attributes.get("data-review-id") !== reviewId) {
    return false;
  }
  const reviewIndex = reviewIndexMatch?.groups?.index;
  if (
    reviewIndex !== undefined &&
    element.attributes.get("data-review-index") !== reviewIndex
  ) {
    return false;
  }
  const square = squareMatch?.groups?.square;
  if (square !== undefined && element.attributes.get("data-square") !== square) {
    return false;
  }
  const boardRank = boardRankMatch?.groups?.rank;
  if (boardRank !== undefined && element.attributes.get("data-board-rank") !== boardRank) {
    return false;
  }
  const boardFile = boardFileMatch?.groups?.file;
  if (boardFile !== undefined && element.attributes.get("data-board-file") !== boardFile) {
    return false;
  }
  const boardOrientation = boardOrientationMatch?.groups?.orientation;
  if (
    boardOrientation !== undefined &&
    element.attributes.get("data-board-orientation") !== boardOrientation
  ) {
    return false;
  }
  return (
    uiName !== undefined ||
    reviewId !== undefined ||
    reviewIndex !== undefined ||
    square !== undefined ||
    boardRank !== undefined ||
    boardFile !== undefined ||
    boardOrientation !== undefined
  );
}

function element(root: FakeRoot, selector: string): FakeElement {
  const found = root.elements().get(selector);
  if (found === undefined) {
    throw new Error(`missing fake element ${selector}`);
  }
  return found;
}

function elements(root: FakeRoot, selector: string): readonly FakeElement[] {
  return root.querySelectorAll(selector) as unknown as readonly FakeElement[];
}

function boardSquares(
  root: FakeRoot,
  prefix: "retry-practice" | "saved-review-detail-practice"
): readonly FakeElement[] {
  return elements(root, `[data-review-ui="${prefix}-board-square"]`);
}

function boardSquare(
  root: FakeRoot,
  prefix: "retry-practice" | "saved-review-detail-practice",
  square: string
): FakeElement {
  return element(root, `[data-review-ui="${prefix}-board-square"][data-square="${square}"]`);
}

function boardOrientationButton(
  root: FakeRoot,
  prefix: "retry-practice" | "saved-review-detail-practice",
  orientation: "active" | "white" | "black"
): FakeElement {
  return element(
    root,
    `[data-review-ui="${prefix}-orientation-button"][data-board-orientation="${orientation}"]`
  );
}

async function typeIncrementally(root: FakeRoot, selector: string, text: string): Promise<void> {
  let typed = "";
  for (const char of text) {
    typed += char;
    element(root, selector).value = typed;
    await element(root, selector).dispatch("input");
    expectEqual(element(root, selector).value, typed);
  }
}

function stripTags(text: string): string {
  return decodeHtml(text.replace(/<[^>]+>/gu, ""));
}

function decodeHtml(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(?<codePoint>\d+);/gu, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 10))
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function withoutTextareaContents(html: string): string {
  return html.replace(/<textarea(?<attributes>[^>]*)>.*?<\/textarea>/gsu, "<textarea$<attributes>></textarea>");
}

function expectEqual<T>(actual: T, expected: T): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`expected ${expectedText}, got ${actualText}`);
  }
}

function expectIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}

function expectNotIncludes(actual: string, unexpected: string): void {
  if (actual.includes(unexpected)) {
    throw new Error(
      `expected ${JSON.stringify(actual)} not to include ${JSON.stringify(unexpected)}`
    );
  }
}

function chessGlyph(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

function installClipboardMock(options: { readonly reject?: boolean } = {}): {
  readonly writes: () => readonly string[];
  readonly restore: () => void;
} {
  const writes: string[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const restore = (): void => {
    if (original === undefined) {
      delete (globalThis as { navigator?: Navigator }).navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", original);
    }
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: (value: string): Promise<void> => {
          writes.push(value);
          if (options.reject === true) {
            return Promise.reject(new Error("clipboard unavailable"));
          }
          return Promise.resolve();
        }
      }
    }
  });
  return { writes: () => writes, restore };
}

function expectBefore(haystack: string, first: string, second: string): void {
  const firstIndex = haystack.indexOf(first);
  const secondIndex = haystack.indexOf(second);
  if (firstIndex === -1 || secondIndex === -1 || firstIndex >= secondIndex) {
    throw new Error(`expected ${first} to appear before ${second}`);
  }
}

function expectNoObservedPatternBannedWords(actual: string): void {
  const banned = [
    /weakness/iu,
    /you miss/iu,
    /tactic/iu,
    /opening/iu,
    /material/iu,
    /\bwin(?:s|ning)?\b/iu,
    /confidence/iu,
    /ranked/iu,
    /prescription/iu,
    /coach/iu
  ];
  for (const pattern of banned) {
    if (pattern.test(actual)) {
      throw new Error(`expected observed pattern text not to match ${String(pattern)}`);
    }
  }
}

function expectNoSavedRetryRouteBannedWords(actual: string): void {
  const banned = [
    /weakness/iu,
    /weak spot/iu,
    /skill gap/iu,
    /tendency/iu,
    /habit/iu,
    /you miss/iu,
    /tactic/iu,
    /motif/iu,
    /opening/iu,
    /material/iu,
    /conversion/iu,
    /confidence/iu,
    /likely/iu,
    /statistically significant/iu,
    /priority/iu,
    /ranking/iu,
    /recommend/iu,
    /recommended/iu,
    /you should practice/iu,
    /schedule/iu,
    /\bdue\b/iu,
    /progress/iu,
    /no issue/iu,
    /cleared/iu,
    /absent/iu,
    /\bsafe\b/iu,
    /not a problem/iu
  ];
  for (const pattern of banned) {
    if (pattern.test(actual)) {
      throw new Error(`expected saved retry route text not to match ${String(pattern)}`);
    }
  }
}

function expectStatusPresentation(root: FakeRoot, expected: string): void {
  const status = element(root, `[data-review-ui="status"]`);
  expectEqual(status.textContent, expected);
  expectEqual(status.attributes.get("aria-live"), "polite");
  expectEqual(status.attributes.has("hidden"), false);
}

function expectNoErrorPresentation(root: FakeRoot): void {
  const error = element(root, `[data-review-ui="error"]`);
  expectEqual(error.textContent, "");
  expectEqual(error.attributes.has("hidden"), true);
  expectEqual(error.attributes.get("aria-hidden"), "true");
  expectEqual(error.attributes.has("role"), false);
  expectEqual(error.attributes.has("aria-live"), false);
  expectEqual(error.attributes.has("data-error-source"), false);
  expectEqual(error.attributes.has("data-error-reason"), false);
}

function expectProductHeader(root: FakeRoot): void {
  expectEqual(element(root, `[data-review-ui="product-title"]`).textContent, "Explore");
  expectEqual(element(root, `[data-review-ui="release-badge"]`).textContent, "Explore");
  expectEqual(
    element(root, `[data-review-ui="release-scope"]`).textContent,
    "Local review and visual retry practice"
  );
}

function expectActiveErrorPresentation(
  root: FakeRoot,
  expected: string,
  expectedSource?: string,
  expectedReason?: string
): void {
  const error = element(root, `[data-review-ui="error"]`);
  expectIncludes(error.textContent, expected);
  expectEqual(error.attributes.has("hidden"), false);
  expectEqual(error.attributes.has("aria-hidden"), false);
  expectEqual(error.attributes.get("role"), "alert");
  expectEqual(error.attributes.get("aria-live"), "assertive");
  expectEqual(error.attributes.has("data-error-source"), true);
  expectEqual(error.attributes.has("data-error-reason"), true);
  if (expectedSource !== undefined) {
    expectEqual(error.attributes.get("data-error-source"), expectedSource);
  }
  if (expectedReason !== undefined) {
    expectEqual(error.attributes.get("data-error-reason"), expectedReason);
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

function review(
  entries: readonly ReviewEntryDto[],
  summaryOverrides: Partial<ReviewSummaryDto> = {}
): GameReviewDto {
  return {
    summary: summary({ totalMoves: entries.length, ...summaryOverrides }),
    entries
  };
}

function artifacts(): ReviewArtifactsDto {
  return {
    keyMoments: [
      {
        rank: 1,
        entryIndex: 1,
        kind: "centipawn-loss",
        ply: 41,
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
        entryIndex: 1,
        ply: 41,
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
        entryIndex: 1,
        ply: 41,
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
        entryIndex: 1,
        ply: 4,
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
        entryIndex: 1,
        ply: 41,
        fenBefore: "rnbqkbnr/pppp1ppp/8/4p3/5P2/8/PPPPP1PP/RNBQKBNR w KQkq - 0 2",
        playedMove: "e2e4",
        bestMove: "a2a3",
        san: "e4",
        label: "blunder",
        cpLoss: 450
      }
    ]
  };
}

function storedReview(
  id: string,
  entries: readonly ReviewEntryDto[],
  savedAtIso = "2026-05-15T12:00:00.000Z",
  summaryOverrides: Partial<ReviewSummaryDto> = {},
  artifactPayload: ReviewArtifactsDto | null = null,
  sourcePgn: string | null = null
): StoredReviewV3 {
  return {
    id,
    savedAtIso,
    source: "review-pgn",
    sourcePgn,
    review: review(entries, summaryOverrides),
    artifacts: artifactPayload
  };
}

function requireRetryPosition(
  retry: ReviewArtifactsDto["retryPositions"][number] | undefined
): ReviewArtifactsDto["retryPositions"][number] {
  if (retry === undefined) {
    throw new Error("test fixture retry position should exist");
  }
  return retry;
}

function dependencies(
  storage: MemoryStorage,
  reviewResult: GameReviewDto = review([entry(10, "best", 0), entry(41, "blunder", 450)]),
  artifactResult: ReviewArtifactsDto = artifacts()
): ReviewUiDependencies & {
  readonly storage: MemoryStorage;
  readonly requests: () => readonly ReviewPgnRequestDto[];
} {
  const requests: ReviewPgnRequestDto[] = [];
  return {
    storage,
    reviewPgn: (request: ReviewPgnRequestDto) => {
      requests.push(request);
      return Promise.resolve({ ok: true, review: reviewResult, artifacts: artifactResult });
    },
    createSaveMetadata: () => ({
      ok: true,
      metadata: {
        id: "saved-review",
        savedAtIso: "2026-05-15T16:00:00.000Z"
      }
    }),
    requests: () => requests
  };
}

function deferredReview(): {
  readonly promise: Promise<{ readonly ok: true; readonly review: GameReviewDto; readonly artifacts: ReviewArtifactsDto }>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<{
    readonly ok: true;
    readonly review: GameReviewDto;
    readonly artifacts: ReviewArtifactsDto;
  }>((resolve) => {
    resolvePromise = () => {
      resolve({ ok: true, review: review([entry(7, "mistake", 200)]), artifacts: artifacts() });
    };
  });
  return {
    promise,
    resolve: () => {
      if (resolvePromise === null) {
        throw new Error("deferred review resolver missing");
      }
      resolvePromise();
    }
  };
}

const storeKey = "chess.trainer.reviewStore.v1";
const stored = {
  schemaVersion: 3,
  reviews: [storedReview("stored", [entry(1, "mistake", 180)])]
} as const;

const orderedStore = {
  schemaVersion: 3,
  reviews: [
    storedReview("old", [entry(1, "good", 10)], "2026-05-15T10:00:00.000Z", { good: 1 }),
    storedReview("new", [entry(2, "blunder", 450)], "2026-05-15T18:00:00.000Z", { blunders: 1 }),
    storedReview("tie-a", [entry(3, "mistake", 180)], "2026-05-15T15:00:00.000Z", { mistakes: 1 }),
    storedReview("tie-b", [entry(4, "inaccuracy", 80)], "2026-05-15T15:00:00.000Z", { inaccuracies: 1 })
  ]
} as const;
const orderedStorageText = JSON.stringify(orderedStore);
const orderedStorage = memoryStorage(new Map([[storeKey, orderedStorageText]]));
const orderedRoot = fakeRoot();
mountReviewUi(orderedRoot, dependencies(orderedStorage));
expectProductHeader(orderedRoot);
expectIncludes(
  element(orderedRoot, `[data-review-ui="stored-review-row"][data-review-index="0"]`).textContent,
  "Saved at2026-05-15 18:00 UTCMoves1"
);
expectIncludes(
  element(orderedRoot, `[data-review-ui="stored-review-row"][data-review-index="1"]`).textContent,
  "Saved at2026-05-15 15:00 UTCMoves1"
);
expectEqual(
  element(orderedRoot, `[data-review-ui="stored-review-move-count"][data-review-index="1"]`).textContent,
  "Moves1"
);
expectEqual(
  element(orderedRoot, `[data-review-ui="stored-review-summary-best"][data-review-index="0"]`).textContent,
  "Best0"
);
expectEqual(
  element(orderedRoot, `[data-review-ui="stored-review-summary-blunders"][data-review-index="0"]`).textContent,
  "Blunders1"
);
expectEqual(
  element(orderedRoot, `[data-review-ui="stored-review-summary-mistakes"][data-review-index="1"]`).textContent,
  "Mistakes1"
);
expectEqual(
  element(orderedRoot, `[data-review-ui="stored-review-summary-inaccuracies"][data-review-index="2"]`).textContent,
  "Inaccuracies1"
);
expectEqual(
  element(orderedRoot, `[data-review-ui="stored-review-summary-good"][data-review-index="3"]`).textContent,
  "Good1"
);
expectIncludes(
  element(orderedRoot, `[data-review-ui="stored-review-row"][data-review-index="2"]`).textContent,
  "Saved at2026-05-15 15:00 UTCMoves1"
);
expectIncludes(
  element(orderedRoot, `[data-review-ui="stored-review-row"][data-review-index="3"]`).textContent,
  "Saved at2026-05-15 10:00 UTCMoves1"
);
expectEqual(orderedStorage.entries().get(storeKey), orderedStorageText);
await element(orderedRoot, `[data-review-ui="view-review-button"][data-review-index="1"]`).dispatch("click");
expectProductHeader(orderedRoot);
expectEqual(orderedStorage.entries().get(storeKey), orderedStorageText);
expectEqual(
  element(orderedRoot, `[data-review-ui="saved-review-detail-saved-at"]`).textContent,
  "Saved at2026-05-15 15:00 UTC"
);
expectEqual(
  element(orderedRoot, `[data-review-ui="saved-review-detail-move-ply"][data-review-index="0"]`).textContent,
  "3"
);
expectEqual(
  element(orderedRoot, `[data-review-ui="stored-review-selected"][data-review-index="1"]`).textContent,
  "Selected"
);
expectNotIncludes(orderedRoot.html(), "tie-a");
await element(orderedRoot, `[data-review-ui="delete-review-button"][data-review-index="0"]`).dispatch("click");
expectProductHeader(orderedRoot);
const orderedAfterDelete = JSON.parse(orderedStorage.entries().get(storeKey) ?? "") as {
  readonly reviews: readonly StoredReviewV3[];
};
expectEqual(orderedAfterDelete.reviews.map((item) => item.id), ["old", "tie-a", "tie-b"]);

const malformedTimeStore = {
  schemaVersion: 3,
  reviews: [storedReview("bad-time", [entry(1, "good", 10)], "not-a-date")]
} as const;
const malformedTimeText = JSON.stringify(malformedTimeStore);
const malformedTimeStorage = memoryStorage(new Map([[storeKey, malformedTimeText]]));
const malformedTimeRoot = fakeRoot();
mountReviewUi(malformedTimeRoot, dependencies(malformedTimeStorage));
expectStatusPresentation(malformedTimeRoot, "Ready");
expectNoErrorPresentation(malformedTimeRoot);
expectEqual(
  element(malformedTimeRoot, `[data-review-ui="stored-review-saved-at"][data-review-index="0"]`).textContent,
  "Saved atSaved time unavailable"
);
expectNotIncludes(
  element(malformedTimeRoot, `[data-review-ui="stored-review-list"]`).textContent,
  "not-a-date"
);
await element(
  malformedTimeRoot,
  `[data-review-ui="view-review-button"][data-review-index="0"]`
).dispatch("click");
expectEqual(
  element(malformedTimeRoot, `[data-review-ui="saved-review-detail-saved-at"]`).textContent,
  "Saved atSaved time unavailable"
);
expectNotIncludes(
  element(malformedTimeRoot, `[data-review-ui="saved-review-detail"]`).textContent,
  "not-a-date"
);
expectEqual(malformedTimeStorage.entries().get(storeKey), malformedTimeText);

const labelEntries = [
  entry(1, "best", 0),
  entry(2, "good", 10),
  entry(3, "inaccuracy", 80),
  entry(4, "mistake", 180),
  entry(5, "blunder", 450)
] as const;
const expectedMoveLabels = ["Best", "Good", "Inaccuracy", "Mistake", "Blunder"] as const;
const labelRoot = fakeRoot();
mountReviewUi(labelRoot, dependencies(memoryStorage(), review(labelEntries)));
await element(labelRoot, `[data-review-ui="review-button"]`).dispatch("click");
for (const [index, expectedLabel] of expectedMoveLabels.entries()) {
  const label = element(labelRoot, `[data-review-ui="move-label"][data-review-index="${String(index)}"]`);
  expectEqual(
    label.textContent,
    expectedLabel
  );
  expectEqual(label.attributes.get("data-label"), labelEntries[index]?.label);
}

const savedLabelRoot = fakeRoot();
mountReviewUi(
  savedLabelRoot,
  dependencies(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({ schemaVersion: 3, reviews: [storedReview("labels", labelEntries)] })
        ]
      ])
    )
  )
);
await element(savedLabelRoot, `[data-review-ui="view-review-button"][data-review-index="0"]`).dispatch("click");
for (const [index, expectedLabel] of expectedMoveLabels.entries()) {
  const label = element(
    savedLabelRoot,
    `[data-review-ui="saved-review-detail-move-label"][data-review-index="${String(index)}"]`
  );
  expectEqual(
    label.textContent,
    expectedLabel
  );
  expectEqual(label.attributes.get("data-label"), labelEntries[index]?.label);
}

const root = fakeRoot();
const deps = dependencies(
  memoryStorage(
    new Map([
      [storeKey, JSON.stringify(stored)],
      ["other-key", "kept"]
    ])
  )
);
const ui = mountReviewUi(root, deps);
expectProductHeader(root);
expectStatusPresentation(root, "Ready");
expectNoErrorPresentation(root);
expectEqual(element(root, `[data-review-ui="pgn-label"]`).textContent, "PGN");
expectEqual(element(root, `[data-review-ui="depth-label"]`).textContent, "Review depth");
expectEqual(element(root, `[data-review-ui="profile-total-reviews"]`).textContent, "Saved reviews1");
expectEqual(element(root, `[data-review-ui="observed-patterns-title"]`).textContent, "Observed patterns");
expectEqual(
  element(root, `[data-review-ui="observed-pattern-saved-reviews"]`).textContent,
  "Saved reviews1 saved review"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-reviewed-moves"]`).textContent,
  "Reviewed moves1 reviewed move"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-artifact-backed-reviews"]`).textContent,
  "Artifact-backed reviews0 of 1 saved review"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-artifact-missing-reviews"]`).textContent,
  "Artifact-missing reviews1 of 1 saved review"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-fork-candidates"]`).textContent,
  "Fork candidates0 from 0 artifact-backed reviews"
);
expectNoObservedPatternBannedWords(element(root, `[data-review-ui="observed-patterns"]`).textContent);
expectEqual(
  element(root, `[data-review-ui="saved-retry-route-saved-reviews"]`).textContent,
  "Saved reviews1 saved review"
);
expectEqual(
  element(root, `[data-review-ui="saved-retry-route-reviewed-moves"]`).textContent,
  "Reviewed moves1 reviewed move"
);
expectEqual(
  element(root, `[data-review-ui="saved-retry-route-artifact-backed-reviews"]`).textContent,
  "Artifact-backed reviews0 of 1 saved review"
);
expectEqual(
  element(root, `[data-review-ui="saved-retry-route-artifact-missing-reviews"]`).textContent,
  "Artifact-missing reviews1 of 1 saved review"
);
expectEqual(
  element(root, `[data-review-ui="saved-retry-route-saved-retry-positions"]`).textContent,
  "Saved retry positions0 from 0 artifact-backed reviews"
);
expectEqual(
  element(root, `[data-review-ui="saved-retry-route-filter-artifacts"][data-review-index="0"]`).textContent,
  "Key moments0 key moments"
);
expectEqual(
  element(root, `[data-review-ui="saved-retry-route-filter-matched-retry-positions"][data-review-index="0"]`).textContent,
  "Matched retry positions0 from 0 key moments"
);
expectEqual(root.elements().has(`[data-review-ui="open-saved-retry-route-button"]`), false);
expectEqual(
  root.elements().has(`[data-review-ui="open-filtered-saved-retry-route-button"][data-review-index="0"]`),
  false
);
expectNoSavedRetryRouteBannedWords(element(root, `[data-review-ui="saved-retry-route"]`).textContent);
expectIncludes(
  element(root, `[data-review-ui="stored-review-row"][data-review-index="0"]`).textContent,
  "Saved at2026-05-15 12:00 UTCMoves1"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-empty"]`).textContent,
  "No saved review selected"
);
expectEqual(root.elements().has(`[data-review-ui="saved-review-detail-copy-pgn"]`), false);
expectEqual(
  element(root, `[data-review-ui="move-list-no-current-review"]`).textContent,
  "No review yet"
);
expectEqual(root.elements().has(`[data-review-ui="current-review-copy-pgn"]`), false);
expectEqual(
  element(root, `[data-review-ui="coach-artifacts-no-current-review"]`).textContent,
  "No review yet"
);
expectNotIncludes(element(root, `[data-review-ui="move-list"]`).textContent, "No moves reviewed");
expectNotIncludes(element(root, `[data-review-ui="coach-artifacts"]`).textContent, "No key moments");
expectNotIncludes(element(root, `[data-review-ui="coach-artifacts"]`).textContent, "No evidence");
expectNotIncludes(element(root, `[data-review-ui="coach-artifacts"]`).textContent, "No early divergences");
expectNotIncludes(element(root, `[data-review-ui="coach-artifacts"]`).textContent, "No retry positions");
await element(root, `[data-review-ui="view-review-button"][data-review-index="0"]`).dispatch("click");
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-saved-at"]`).textContent,
  "Saved at2026-05-15 12:00 UTC"
);
expectEqual(element(root, `[data-review-ui="saved-review-detail-move-count"]`).textContent, "Moves1");
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-summary-total-moves"]`).textContent,
  "Total moves1"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-move-label"][data-review-index="0"]`).textContent,
  "Mistake"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-move-best-score"][data-review-index="0"]`).textContent,
  "+20 cp"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-move-played-score"][data-review-index="0"]`).textContent,
  "-160 cp"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-move-cp-loss"][data-review-index="0"]`).textContent,
  "180 cp"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-empty"]`).textContent,
  "No saved retry practice"
);
expectEqual(root.elements().has(`[data-review-ui="saved-review-detail-copy-pgn"]`), false);
expectNotIncludes(element(root, `[data-review-ui="saved-review-detail"]`).textContent, "stored");
expectNotIncludes(element(root, `[data-review-ui="saved-review-detail"]`).textContent, "Key moments");
expectNotIncludes(
  element(root, `[data-review-ui="stored-review-row"][data-review-index="0"]`).textContent,
  "stored"
);

const savedPgnRoot = fakeRoot();
mountReviewUi(
  savedPgnRoot,
  dependencies(
    memoryStorage(
      new Map([
        [
          storeKey,
          JSON.stringify({
            schemaVersion: 3,
            reviews: [
              {
                ...storedReview("saved-source-pgn", [entry(1, "good", 10)]),
                sourcePgn: " 1. d4 d5 2. c4 * "
              }
            ]
          })
        ]
      ])
    )
  )
);
await element(
  savedPgnRoot,
  `[data-review-ui="view-review-button"][data-review-index="0"]`
).dispatch("click");
expectEqual(
  element(savedPgnRoot, `[data-review-ui="saved-review-detail-copy-pgn-button"]`).textContent,
  "Copy PGN"
);
const savedSourcePgnClipboard = installClipboardMock();
try {
  await element(
    savedPgnRoot,
    `[data-review-ui="saved-review-detail-copy-pgn-button"]`
  ).dispatch("click");
  expectEqual(savedSourcePgnClipboard.writes(), [" 1. d4 d5 2. c4 * "]);
  expectEqual(
    element(savedPgnRoot, `[data-review-ui="saved-review-detail-copy-pgn-status"]`).textContent,
    "PGN copied"
  );
} finally {
  savedSourcePgnClipboard.restore();
}
const unavailableSavedSourcePgnClipboard = installClipboardMock({ reject: true });
try {
  await element(
    savedPgnRoot,
    `[data-review-ui="saved-review-detail-copy-pgn-button"]`
  ).dispatch("click");
  expectEqual(unavailableSavedSourcePgnClipboard.writes(), [" 1. d4 d5 2. c4 * "]);
  expectEqual(
    element(savedPgnRoot, `[data-review-ui="saved-review-detail-copy-pgn-status"]`).textContent,
    "PGN copy unavailable"
  );
} finally {
  unavailableSavedSourcePgnClipboard.restore();
}

const retry = requireRetryPosition(artifacts().retryPositions[0]);
const routeArtifactsOld: ReviewArtifactsDto = {
  ...artifacts(),
  retryPositions: [{ ...retry, rank: 5, fenBefore: "fen-route-old", bestMove: "h2h3" }]
};
const routeArtifactsNew: ReviewArtifactsDto = {
  ...artifacts(),
  keyMoments: [],
  evidence: [],
  forkCandidates: [],
  retryPositions: [{ ...retry, rank: 1, fenBefore: "fen-route-new", bestMove: "a2a3" }]
};
const routeStorePayload = {
  schemaVersion: 3,
  reviews: [
    storedReview(
      "route-old",
      [entry(1, "blunder", 450)],
      "2026-05-15T10:00:00.000Z",
      { blunders: 1 },
      routeArtifactsOld
    ),
    storedReview(
      "route-new",
      [entry(2, "inaccuracy", 80)],
      "2026-05-15T18:00:00.000Z",
      { inaccuracies: 1 },
      routeArtifactsNew
    )
  ]
} as const;
const routeRoot = fakeRoot();
mountReviewUi(
  routeRoot,
  dependencies(
    memoryStorage(
      new Map([
        [storeKey, JSON.stringify(routeStorePayload)]
      ])
    )
  )
);
expectEqual(
  element(routeRoot, `[data-review-ui="saved-retry-route-saved-retry-positions"]`).textContent,
  "Saved retry positions2 from 2 artifact-backed reviews"
);
expectEqual(
  Array.from(
    routeRoot.querySelectorAll(`[data-review-ui="saved-retry-route-filter"]`),
    (row) => row.textContent
  ),
  [
    "Key momentsKey moments1 key momentMatched retry positions1 from 1 key momentOpen saved retry position",
    "Local search swingsLocal search swings1 local search swingMatched retry positions1 from 1 local search swingOpen saved retry position",
    "Fork candidatesFork candidates1 fork candidateMatched retry positions1 from 1 fork candidateOpen saved retry position"
  ]
);
expectEqual(
  element(routeRoot, `[data-review-ui="open-saved-retry-route-button"]`).textContent,
  "Open saved retry position"
);
expectEqual(
  element(routeRoot, `[data-review-ui="open-filtered-saved-retry-route-button"][data-review-index="2"]`).textContent,
  "Open saved retry position"
);
expectNoSavedRetryRouteBannedWords(
  element(routeRoot, `[data-review-ui="saved-retry-route"]`).textContent
);
await element(routeRoot, `[data-review-ui="open-saved-retry-route-button"]`).dispatch("click");
expectEqual(
  element(routeRoot, `[data-review-ui="saved-review-detail-saved-at"]`).textContent,
  "Saved at2026-05-15 10:00 UTC"
);
expectEqual(
  element(routeRoot, `[data-review-ui="saved-review-detail-practice-fen"][data-review-index="0"]`).textContent,
  "FEN beforefen-route-old"
);
await element(routeRoot, `[data-review-ui="view-review-button"][data-review-index="0"]`).dispatch("click");
expectEqual(
  element(routeRoot, `[data-review-ui="saved-review-detail-saved-at"]`).textContent,
  "Saved at2026-05-15 18:00 UTC"
);
await element(routeRoot, `[data-review-ui="open-filtered-saved-retry-route-button"][data-review-index="0"]`).dispatch("click");
expectEqual(
  element(routeRoot, `[data-review-ui="saved-review-detail-saved-at"]`).textContent,
  "Saved at2026-05-15 10:00 UTC"
);
expectEqual(
  element(routeRoot, `[data-review-ui="saved-review-detail-practice-fen"][data-review-index="0"]`).textContent,
  "FEN beforefen-route-old"
);

const pgnInput = element(root, `[data-review-ui="pgn-input"]`);
pgnInput.value = " 1. e4 * ";
await pgnInput.dispatch("input");
expectEqual(ui.getState().inlinePgn, " 1. e4 * ");
expectEqual(element(root, `[data-review-ui="profile-total-reviews"]`).textContent, "Saved reviews1");
expectEqual(element(root, `[data-review-ui="profile-cp-loss-total"]`).textContent, "CP loss total180 cp");
expectEqual(
  element(root, `[data-review-ui="profile-bucket-cp-loss-total"][data-review-index="0"]`).textContent,
  "CP loss180 cp"
);

const depthControl = element(root, `[data-review-ui="depth-control"]`);
expectEqual(depthControl.attributes.get("data-depth-options"), "2,3,4,5,6");
expectEqual(depthControl.attributes.has("value"), false);
depthControl.value = "4";
await depthControl.dispatch("change");
expectEqual(ui.getState().depth, 4);

const reviewButton = element(root, `[data-review-ui="review-button"]`);
const reviewPromise = reviewButton.dispatch("click");
expectStatusPresentation(root, "Reviewing");
expectNoErrorPresentation(root);
expectEqual(element(root, `[data-review-ui="review-button"]`).disabled, true);
await reviewPromise;
expectProductHeader(root);
expectEqual(deps.requests(), [{ pgn: " 1. e4 * ", depth: 4 }]);
expectStatusPresentation(root, "Review complete");
expectNoErrorPresentation(root);
expectEqual(element(root, `[data-review-ui="summary-total-moves"]`).textContent, "Total moves2");
expectEqual(element(root, `[data-review-ui="save-state"]`).textContent, "Unsaved review");
expectEqual(element(root, `[data-review-ui="current-review-copy-pgn-button"]`).textContent, "Copy PGN");
const pgnClipboard = installClipboardMock();
try {
  await element(root, `[data-review-ui="current-review-copy-pgn-button"]`).dispatch("click");
  expectEqual(pgnClipboard.writes(), [" 1. e4 * "]);
  expectEqual(
    element(root, `[data-review-ui="current-review-copy-pgn-status"]`).textContent,
    "PGN copied"
  );
} finally {
  pgnClipboard.restore();
}
const unavailablePgnClipboard = installClipboardMock({ reject: true });
try {
  await element(root, `[data-review-ui="current-review-copy-pgn-button"]`).dispatch("click");
  expectEqual(unavailablePgnClipboard.writes(), [" 1. e4 * "]);
  expectEqual(
    element(root, `[data-review-ui="current-review-copy-pgn-status"]`).textContent,
    "PGN copy unavailable"
  );
} finally {
  unavailablePgnClipboard.restore();
}
expectEqual(element(root, `[data-review-ui="move-ply"][data-review-index="1"]`).textContent, "41");
expectEqual(element(root, `[data-review-ui="move-san"][data-review-index="1"]`).textContent, "e4");
expectEqual(element(root, `[data-review-ui="move-label"][data-review-index="1"]`).textContent, "Blunder");
expectEqual(element(root, `[data-review-ui="move-best-score"][data-review-index="1"]`).textContent, "+20 cp");
expectEqual(element(root, `[data-review-ui="move-played-score"][data-review-index="1"]`).textContent, "-430 cp");
expectEqual(element(root, `[data-review-ui="move-cp-loss"][data-review-index="1"]`).textContent, "450 cp");
expectEqual(element(root, `[data-review-ui="move-cp-loss"][data-review-index="0"]`).textContent, "0 cp");
expectIncludes(element(root, `[data-review-ui="key-moment-row"][data-review-index="0"]`).textContent, "Rank1Ply41");
expectEqual(element(root, `[data-review-ui="key-moment-label"][data-review-index="0"]`).textContent, "LabelBlunder");
expectEqual(element(root, `[data-review-ui="key-moment-cp-loss"][data-review-index="0"]`).textContent, "CP loss450 cp");
expectIncludes(element(root, `[data-review-ui="evidence-row"][data-review-index="0"]`).textContent, "Local search swing");
expectEqual(
  element(root, `[data-review-ui="evidence-score"][data-review-index="0"]`).textContent,
  "Score swing+20 cp to -430 cp"
);
expectEqual(element(root, `[data-review-ui="evidence-cp-loss"][data-review-index="0"]`).textContent, "CP loss450 cp");
expectEqual(element(root, `[data-review-ui="evidence-label"][data-review-index="0"]`).textContent, "LabelBlunder");
expectEqual(
  element(root, `[data-review-ui="fork-candidate-best-move"][data-review-index="0"]`).textContent,
  "Best movee5f7"
);
expectEqual(
  element(root, `[data-review-ui="fork-candidate-moved-piece"][data-review-index="0"]`).textContent,
  "Moved pieceWhite knight"
);
expectEqual(
  element(root, `[data-review-ui="fork-candidate-destination"][data-review-index="0"]`).textContent,
  "Destinationf7"
);
expectEqual(
  element(root, `[data-review-ui="fork-candidate-targets"][data-review-index="0"]`).textContent,
  "Targetsd8 Black queen, h8 Black rook"
);
expectEqual(
  element(root, `[data-review-ui="fork-candidate-label"][data-review-index="0"]`).textContent,
  "LabelBlunder"
);
expectNotIncludes(element(root, `[data-review-ui="fork-candidates"]`).textContent, "tactic");
expectNotIncludes(element(root, `[data-review-ui="fork-candidates"]`).textContent, "weakness");
expectNotIncludes(element(root, `[data-review-ui="fork-candidates"]`).textContent, "opening");
expectNotIncludes(element(root, `[data-review-ui="fork-candidates"]`).textContent, "material");
expectIncludes(element(root, `[data-review-ui="early-divergence-row"][data-review-index="0"]`).textContent, "Local besta2a3");
expectEqual(
  element(root, `[data-review-ui="early-divergence-cp-loss"][data-review-index="0"]`).textContent,
  "CP loss450 cp"
);
expectEqual(
  element(root, `[data-review-ui="early-divergence-label"][data-review-index="0"]`).textContent,
  "LabelBlunder"
);
expectIncludes(element(root, `[data-review-ui="retry-position-row"][data-review-index="0"]`).textContent, "FEN before");
expectEqual(
  element(root, `[data-review-ui="retry-position-cp-loss"][data-review-index="0"]`).textContent,
  "CP loss450 cp"
);
expectEqual(
  element(root, `[data-review-ui="retry-position-label"][data-review-index="0"]`).textContent,
  "LabelBlunder"
);
expectEqual(element(root, `[data-review-ui="retry-practice-index"]`).textContent, "Position 1 of 1");
expectEqual(
  element(root, `[data-review-ui="retry-practice-feedback"]`).textContent,
  "Enter the local best move"
);
const retryPracticeInput = element(root, `[data-review-ui="retry-practice-input"]`);
expectEqual(retryPracticeInput.attributes.get("spellcheck"), "false");
expectEqual(retryPracticeInput.attributes.get("autocorrect"), "off");
expectEqual(retryPracticeInput.attributes.get("autocapitalize"), "off");
expectEqual(retryPracticeInput.attributes.get("placeholder"), "e.g. e2e4");
expectEqual(retryPracticeInput.attributes.get("aria-describedby"), "retry-practice-input-hint");
expectEqual(
  element(root, `[data-review-ui="retry-practice-input-hint"]`).textContent,
  "Coordinate notation, e.g. e2e4"
);
expectEqual(element(root, `[data-review-ui="retry-practice-answer"]`).attributes.has("hidden"), true);
expectEqual(
  element(root, `[data-review-ui="retry-practice-board"]`).attributes.get("data-board-side"),
  "white"
);
expectEqual(
  element(root, `[data-review-ui="retry-practice-board-caption"]`).textContent,
  "Board, White to move"
);
expectEqual(
  element(root, `[data-review-ui="retry-practice-board"]`).attributes.get("data-board-active-side"),
  "white"
);
expectEqual(
  element(root, `[data-review-ui="retry-practice-board"]`).attributes.get("data-best-move"),
  "a2a3"
);
expectEqual(
  element(root, `[data-review-ui="retry-practice-board"]`).attributes.get("data-best-move-from"),
  "a2"
);
expectEqual(
  element(root, `[data-review-ui="retry-practice-board"]`).attributes.get("data-best-move-to"),
  "a3"
);
expectEqual(
  boardOrientationButton(root, "retry-practice", "active").attributes.get("aria-pressed"),
  "true"
);
const currentBoardSquares = elements(root, `[data-review-ui="retry-practice-board-square"]`);
expectEqual(currentBoardSquares.length, 64);
expectEqual(
  elements(root, `[data-review-ui="retry-practice-board-rank-label"]`).map(
    (label) => label.textContent
  ),
  ["8", "7", "6", "5", "4", "3", "2", "1"]
);
expectEqual(
  elements(root, `[data-review-ui="retry-practice-board-file-label"]`).map(
    (label) => label.textContent
  ),
  ["a", "b", "c", "d", "e", "f", "g", "h"]
);
expectEqual(currentBoardSquares[0]?.attributes.get("data-square"), "a8");
expectEqual(currentBoardSquares[63]?.attributes.get("data-square"), "h1");
expectBefore(root.html(), `data-square="a8"`, `data-square="a1"`);
await boardOrientationButton(root, "retry-practice", "black").dispatch("click");
expectEqual(
  element(root, `[data-review-ui="retry-practice-board"]`).attributes.get("data-board-side"),
  "black"
);
expectEqual(
  boardOrientationButton(root, "retry-practice", "black").attributes.get("aria-pressed"),
  "true"
);
expectEqual(
  elements(root, `[data-review-ui="retry-practice-board-square"]`)[0]?.attributes.get(
    "data-square"
  ),
  "h1"
);
expectEqual(boardSquare(root, "retry-practice", "a2").attributes.get("data-board-arrow"), "from");
expectEqual(
  boardSquare(root, "retry-practice", "a2").attributes.get("data-board-arrow-direction"),
  "s"
);
expectEqual(boardSquare(root, "retry-practice", "a3").attributes.get("data-board-arrow"), "to");
await boardOrientationButton(root, "retry-practice", "active").dispatch("click");
expectEqual(
  element(root, `[data-review-ui="retry-practice-board"]`).attributes.get("data-board-side"),
  "white"
);
const clipboard = installClipboardMock();
try {
  await element(root, `[data-review-ui="retry-practice-copy-fen-button"]`).dispatch("click");
  expectEqual(clipboard.writes(), [
    "rnbqkbnr/pppp1ppp/8/4p3/5P2/8/PPPPP1PP/RNBQKBNR w KQkq - 0 2"
  ]);
  expectEqual(
    element(root, `[data-review-ui="retry-practice-copy-fen-status"]`).textContent,
    "FEN copied"
  );
} finally {
  clipboard.restore();
}
const currentFromSquare = boardSquare(root, "retry-practice", "a2");
expectEqual(element(root, `[data-review-ui="retry-practice-board-grid"]`).attributes.get("role"), "grid");
expectEqual(boardSquare(root, "retry-practice", "a8").attributes.get("type"), "button");
expectEqual(boardSquare(root, "retry-practice", "a8").attributes.get("role"), "gridcell");
expectEqual(
  boardSquare(root, "retry-practice", "a8").attributes.get("aria-label"),
  "a8 Black rook"
);
expectEqual(boardSquare(root, "retry-practice", "a8").attributes.get("title"), "a8 Black rook");
expectEqual(boardSquare(root, "retry-practice", "a8").attributes.get("data-board-piece-color"), "black");
expectEqual(boardSquare(root, "retry-practice", "a8").attributes.get("data-board-piece-kind"), "rook");
expectEqual(
  boardSquare(root, "retry-practice", "e5").attributes.get("aria-label"),
  "e5 Black pawn"
);
expectEqual(boardSquare(root, "retry-practice", "e5").attributes.get("data-board-piece-color"), "black");
expectEqual(boardSquare(root, "retry-practice", "e5").attributes.get("data-board-piece-kind"), "pawn");
expectEqual(
  boardSquare(root, "retry-practice", "f4").attributes.get("aria-label"),
  "f4 White pawn"
);
expectEqual(boardSquare(root, "retry-practice", "f4").attributes.get("data-board-piece-color"), "white");
expectEqual(boardSquare(root, "retry-practice", "f4").attributes.get("data-board-piece-kind"), "pawn");
expectEqual(
  boardSquare(root, "retry-practice", "e7").attributes.get("aria-label"),
  "e7 empty"
);
expectEqual(boardSquare(root, "retry-practice", "e7").attributes.get("data-board-piece-kind"), undefined);
expectEqual(currentFromSquare.textContent, chessGlyph(9817));
expectEqual(currentFromSquare.attributes.get("aria-label"), "a2 White pawn");
expectEqual(currentFromSquare.attributes.get("data-board-arrow"), "from");
expectEqual(currentFromSquare.attributes.get("data-board-arrow-direction"), "n");
expectEqual(boardSquare(root, "retry-practice", "a3").attributes.get("data-board-arrow"), "to");
expectEqual(boardSquare(root, "retry-practice", "a3").textContent, "");
await currentFromSquare.dispatch("click");
expectEqual(element(root, `[data-review-ui="retry-practice-input"]`).value, "");
expectEqual(
  boardSquare(root, "retry-practice", "a2").attributes.get("data-board-selected"),
  "true"
);
await boardSquare(root, "retry-practice", "a3").dispatch("click");
expectEqual(element(root, `[data-review-ui="retry-practice-input"]`).value, "a2a3");
await element(root, `[data-review-ui="retry-practice-submit-button"]`).dispatch("click");
expectEqual(element(root, `[data-review-ui="retry-practice-feedback"]`).textContent, "Correct");
await typeIncrementally(root, `[data-review-ui="retry-practice-input"]`, "a2a4");
await element(root, `[data-review-ui="retry-practice-submit-button"]`).dispatch("click");
expectEqual(
  element(root, `[data-review-ui="retry-practice-feedback"]`).textContent,
  "Incorrect, try again"
);
await typeIncrementally(root, `[data-review-ui="retry-practice-input"]`, " A2A3 ");
expectEqual(
  element(root, `[data-review-ui="retry-practice-feedback"]`).textContent,
  "Enter the local best move"
);
await element(root, `[data-review-ui="retry-practice-submit-button"]`).dispatch("click");
expectEqual(element(root, `[data-review-ui="retry-practice-feedback"]`).textContent, "Correct");
expectEqual(element(root, `[data-review-ui="retry-practice-answer"]`).textContent, "Answer a2a3");
expectEqual(element(root, `[data-review-ui="retry-practice-answer"]`).attributes.has("hidden"), false);
await typeIncrementally(root, `[data-review-ui="retry-practice-input"]`, "a2a4");
expectEqual(
  element(root, `[data-review-ui="retry-practice-feedback"]`).textContent,
  "Enter the local best move"
);
expectEqual(element(root, `[data-review-ui="retry-practice-answer"]`).attributes.has("hidden"), true);
await element(root, `[data-review-ui="retry-practice-reset-button"]`).dispatch("click");
expectEqual(element(root, `[data-review-ui="retry-practice-input"]`).value, "");
expectEqual(
  element(root, `[data-review-ui="retry-practice-feedback"]`).textContent,
  "Enter the local best move"
);
await element(root, `[data-review-ui="retry-practice-reveal-button"]`).dispatch("click");
expectEqual(
  element(root, `[data-review-ui="retry-practice-feedback"]`).textContent,
  "Answer revealed"
);
expectEqual(element(root, `[data-review-ui="retry-practice-answer"]`).textContent, "Answer a2a3");
expectNotIncludes(element(root, `[data-review-ui="summary"]`).textContent, "totalMoves=");
expectNotIncludes(element(root, `[data-review-ui="move-list"]`).textContent, "ply=");
expectNotIncludes(withoutTextareaContents(root.html()), " 1. e4 * ");

const firstRetry = requireRetryPosition(artifacts().retryPositions[0]);
const multiRetryArtifacts: ReviewArtifactsDto = {
  ...artifacts(),
  retryPositions: [
    firstRetry,
    {
      ...firstRetry,
      rank: 2,
      entryIndex: 2,
      ply: 42,
      fenBefore: "rnbqkbnr/pppp1ppp/8/4p3/5P2/8/PPPPP1PP/RNBQKBNR b KQkq - 0 2",
      playedMove: "e7e5",
      bestMove: "b7b6",
      san: "e5"
    }
  ]
};
const multiPracticeRoot = fakeRoot();
mountReviewUi(multiPracticeRoot, dependencies(memoryStorage(), review([entry(41, "blunder", 450)]), multiRetryArtifacts));
await element(multiPracticeRoot, `[data-review-ui="review-button"]`).dispatch("click");
await element(multiPracticeRoot, `[data-review-ui="retry-practice-next-button"]`).dispatch("click");
expectEqual(
  element(multiPracticeRoot, `[data-review-ui="retry-practice-index"]`).textContent,
  "Position 2 of 2"
);
expectEqual(
  element(multiPracticeRoot, `[data-review-ui="retry-practice-fen"][data-review-index="1"]`).textContent,
  "FEN beforernbqkbnr/pppp1ppp/8/4p3/5P2/8/PPPPP1PP/RNBQKBNR b KQkq - 0 2"
);
expectEqual(
  element(multiPracticeRoot, `[data-review-ui="retry-practice-board"]`).attributes.get(
    "data-board-side"
  ),
  "black"
);
const blackBoardSquares = elements(multiPracticeRoot, `[data-review-ui="retry-practice-board-square"]`);
expectEqual(blackBoardSquares.length, 64);
expectEqual(
  elements(multiPracticeRoot, `[data-review-ui="retry-practice-board-rank-label"]`).map(
    (label) => label.textContent
  ),
  ["1", "2", "3", "4", "5", "6", "7", "8"]
);
expectEqual(
  elements(multiPracticeRoot, `[data-review-ui="retry-practice-board-file-label"]`).map(
    (label) => label.textContent
  ),
  ["h", "g", "f", "e", "d", "c", "b", "a"]
);
expectEqual(blackBoardSquares[0]?.attributes.get("data-square"), "h1");
expectEqual(blackBoardSquares[63]?.attributes.get("data-square"), "a8");
expectBefore(multiPracticeRoot.html(), `data-square="h1"`, `data-square="h8"`);
await element(multiPracticeRoot, `[data-review-ui="retry-practice-prev-button"]`).dispatch("click");
expectEqual(
  element(multiPracticeRoot, `[data-review-ui="retry-practice-index"]`).textContent,
  "Position 1 of 2"
);

const diagonalArrowRoot = fakeRoot();
mountReviewUi(
  diagonalArrowRoot,
  dependencies(memoryStorage(), review([entry(41, "blunder", 450)]), {
    ...artifacts(),
    retryPositions: [{ ...firstRetry, bestMove: "a2b3" }]
  })
);
await element(diagonalArrowRoot, `[data-review-ui="review-button"]`).dispatch("click");
expectEqual(
  boardSquare(diagonalArrowRoot, "retry-practice", "a2").attributes.get(
    "data-board-arrow-direction"
  ),
  "ne"
);
await boardOrientationButton(diagonalArrowRoot, "retry-practice", "black").dispatch("click");
expectEqual(
  boardSquare(diagonalArrowRoot, "retry-practice", "a2").attributes.get(
    "data-board-arrow-direction"
  ),
  "sw"
);

const malformedFenRoot = fakeRoot();
mountReviewUi(
  malformedFenRoot,
  dependencies(memoryStorage(), review([entry(41, "blunder", 450)]), {
    ...artifacts(),
    retryPositions: [{ ...firstRetry, fenBefore: "not-a-fen" }]
  })
);
await element(malformedFenRoot, `[data-review-ui="review-button"]`).dispatch("click");
expectEqual(
  malformedFenRoot.elements().has(`[data-review-ui="retry-practice-board"]`),
  false
);
expectEqual(
  element(malformedFenRoot, `[data-review-ui="retry-practice-fen"][data-review-index="0"]`).textContent,
  "FEN beforenot-a-fen"
);

const noBestMoveRoot = fakeRoot();
mountReviewUi(
  noBestMoveRoot,
  dependencies(memoryStorage(), review([entry(41, "blunder", 450)]), {
    ...artifacts(),
    retryPositions: [{ ...firstRetry, bestMove: null }]
  })
);
await element(noBestMoveRoot, `[data-review-ui="review-button"]`).dispatch("click");
expectEqual(
  element(noBestMoveRoot, `[data-review-ui="retry-practice-feedback"]`).textContent,
  "No local best move available"
);
expectEqual(element(noBestMoveRoot, `[data-review-ui="retry-practice-input"]`).disabled, true);
expectEqual(
  element(noBestMoveRoot, `[data-review-ui="retry-practice-board"]`).attributes.get("data-best-move"),
  undefined
);
expectEqual(
  boardSquare(noBestMoveRoot, "retry-practice", "a2").attributes.get("data-board-arrow"),
  undefined
);
expectEqual(boardSquare(noBestMoveRoot, "retry-practice", "a2").disabled, true);
await boardSquare(noBestMoveRoot, "retry-practice", "a2").dispatch("click");
await boardSquare(noBestMoveRoot, "retry-practice", "a3").dispatch("click");
expectEqual(element(noBestMoveRoot, `[data-review-ui="retry-practice-input"]`).value, "");
expectEqual(
  boardSquare(noBestMoveRoot, "retry-practice", "a2").attributes.get("data-board-selected"),
  "false"
);

const pendingRoot = fakeRoot();
const pendingStorage = memoryStorage();
const pending = deferredReview();
const pendingRequests: ReviewPgnRequestDto[] = [];
mountReviewUi(pendingRoot, {
  storage: pendingStorage,
  reviewPgn: (request) => {
    pendingRequests.push(request);
    return pending.promise;
  },
  createSaveMetadata: deps.createSaveMetadata
});
element(pendingRoot, `[data-review-ui="pgn-input"]`).value = " 1. c4 * ";
await element(pendingRoot, `[data-review-ui="pgn-input"]`).dispatch("input");
element(pendingRoot, `[data-review-ui="depth-control"]`).value = "5";
await element(pendingRoot, `[data-review-ui="depth-control"]`).dispatch("change");
const pendingClick = element(pendingRoot, `[data-review-ui="review-button"]`).dispatch("click");
expectEqual(element(pendingRoot, `[data-review-ui="pgn-input"]`).disabled, true);
expectEqual(element(pendingRoot, `[data-review-ui="depth-control"]`).disabled, true);
expectEqual(element(pendingRoot, `[data-review-ui="save-button"]`).disabled, true);
element(pendingRoot, `[data-review-ui="pgn-input"]`).value = " 1. d4 * ";
await element(pendingRoot, `[data-review-ui="pgn-input"]`).dispatch("input");
element(pendingRoot, `[data-review-ui="depth-control"]`).value = "2";
await element(pendingRoot, `[data-review-ui="depth-control"]`).dispatch("change");
expectEqual(pendingRequests, [{ pgn: " 1. c4 * ", depth: 5 }]);
expectEqual(element(pendingRoot, `[data-review-ui="pgn-input"]`).textContent, " 1. c4 * ");
pending.resolve();
await pendingClick;
expectEqual(element(pendingRoot, `[data-review-ui="summary-total-moves"]`).textContent, "Total moves1");
expectEqual(element(pendingRoot, `[data-review-ui="pgn-input"]`).disabled, false);

const emptyReviewRoot = fakeRoot();
mountReviewUi(
  emptyReviewRoot,
  dependencies(memoryStorage(), review([]), {
    keyMoments: [],
    evidence: [],
    forkCandidates: [],
    earlyMoveDivergences: [],
    retryPositions: []
  })
);
element(emptyReviewRoot, `[data-review-ui="pgn-input"]`).value = "*";
await element(emptyReviewRoot, `[data-review-ui="pgn-input"]`).dispatch("input");
await element(emptyReviewRoot, `[data-review-ui="review-button"]`).dispatch("click");
expectStatusPresentation(emptyReviewRoot, "Review complete");
expectNoErrorPresentation(emptyReviewRoot);
expectEqual(
  element(emptyReviewRoot, `[data-review-ui="summary-total-moves"]`).textContent,
  "Total moves0"
);
expectEqual(
  element(emptyReviewRoot, `[data-review-ui="move-list-empty"]`).textContent,
  "No moves reviewed"
);
expectEqual(
  element(emptyReviewRoot, `[data-review-ui="key-moment-empty"]`).textContent,
  "No key moments"
);
expectEqual(element(emptyReviewRoot, `[data-review-ui="evidence-empty"]`).textContent, "No evidence");
expectEqual(
  element(emptyReviewRoot, `[data-review-ui="fork-candidate-empty"]`).textContent,
  "No fork candidates"
);
expectEqual(
  element(emptyReviewRoot, `[data-review-ui="early-divergence-empty"]`).textContent,
  "No early divergences"
);
expectEqual(
  element(emptyReviewRoot, `[data-review-ui="retry-position-empty"]`).textContent,
  "No retry positions"
);
expectEqual(
  element(emptyReviewRoot, `[data-review-ui="retry-practice-empty"]`).textContent,
  "No retry positions"
);
expectEqual(
  emptyReviewRoot.elements().has(`[data-review-ui="coach-artifacts-no-current-review"]`),
  false
);

const saveButton = element(root, `[data-review-ui="save-button"]`);
await saveButton.dispatch("click");
expectProductHeader(root);
expectEqual(JSON.parse(deps.storage.entries().get(storeKey) ?? ""), {
  schemaVersion: 3,
  reviews: [
    stored.reviews[0],
    {
      id: "saved-review",
      savedAtIso: "2026-05-15T16:00:00.000Z",
      source: "review-pgn",
      sourcePgn: " 1. e4 * ",
      review: review([entry(10, "best", 0), entry(41, "blunder", 450)]),
      artifacts: artifacts()
    }
  ]
});
expectEqual(element(root, `[data-review-ui="profile-total-reviews"]`).textContent, "Saved reviews2");
expectEqual(
  element(root, `[data-review-ui="observed-pattern-artifact-backed-reviews"]`).textContent,
  "Artifact-backed reviews1 of 2 saved reviews"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-artifact-missing-reviews"]`).textContent,
  "Artifact-missing reviews1 of 2 saved reviews"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-key-moments"]`).textContent,
  "Key moments1 from 1 artifact-backed review"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-local-search-swings"]`).textContent,
  "Local search swings1 from 1 artifact-backed review"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-fork-candidates"]`).textContent,
  "Fork candidates1 from 1 artifact-backed review"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-retry-positions"]`).textContent,
  "Retry positions1 from 1 artifact-backed review"
);
expectNoObservedPatternBannedWords(element(root, `[data-review-ui="observed-patterns"]`).textContent);
expectEqual(element(root, `[data-review-ui="save-state"]`).textContent, "Current review saved");
expectEqual(element(root, `[data-review-ui="save-button"]`).disabled, true);
expectNotIncludes(element(root, `[data-review-ui="save-state"]`).textContent, "saved-review");
await element(root, `[data-review-ui="save-button"]`).dispatch("click");
const savedStore = JSON.parse(deps.storage.entries().get(storeKey) ?? "") as {
  readonly reviews: readonly StoredReviewV3[];
};
expectEqual(savedStore.reviews.map((item) => item.id), ["stored", "saved-review"]);
await element(root, `[data-review-ui="view-review-button"][data-review-index="0"]`).dispatch("click");
expectEqual(element(root, `[data-review-ui="saved-review-detail-copy-pgn-button"]`).textContent, "Copy PGN");
const savedAfterSavePgnClipboard = installClipboardMock();
try {
  await element(root, `[data-review-ui="saved-review-detail-copy-pgn-button"]`).dispatch("click");
  expectEqual(savedAfterSavePgnClipboard.writes(), [" 1. e4 * "]);
  expectEqual(
    element(root, `[data-review-ui="saved-review-detail-copy-pgn-status"]`).textContent,
    "PGN copied"
  );
} finally {
  savedAfterSavePgnClipboard.restore();
}
const unavailableSavedAfterSavePgnClipboard = installClipboardMock({ reject: true });
try {
  await element(root, `[data-review-ui="saved-review-detail-copy-pgn-button"]`).dispatch("click");
  expectEqual(unavailableSavedAfterSavePgnClipboard.writes(), [" 1. e4 * "]);
  expectEqual(
    element(root, `[data-review-ui="saved-review-detail-copy-pgn-status"]`).textContent,
    "PGN copy unavailable"
  );
} finally {
  unavailableSavedAfterSavePgnClipboard.restore();
}
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-fork-candidate-best-move"][data-review-index="0"]`).textContent,
  "Best movee5f7"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-fork-candidate-moved-piece"][data-review-index="0"]`).textContent,
  "Moved pieceWhite knight"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-fork-candidate-targets"][data-review-index="0"]`).textContent,
  "Targetsd8 Black queen, h8 Black rook"
);
expectNotIncludes(element(root, `[data-review-ui="saved-review-detail-fork-candidates"]`).textContent, "tactic");
expectNotIncludes(element(root, `[data-review-ui="saved-review-detail-fork-candidates"]`).textContent, "weakness");
expectNotIncludes(element(root, `[data-review-ui="saved-review-detail-fork-candidates"]`).textContent, "opening");
expectNotIncludes(element(root, `[data-review-ui="saved-review-detail-fork-candidates"]`).textContent, "material");
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-index"]`).textContent,
  "Position 1 of 1"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-fen"][data-review-index="0"]`).textContent,
  "FEN beforernbqkbnr/pppp1ppp/8/4p3/5P2/8/PPPPP1PP/RNBQKBNR w KQkq - 0 2"
);
const savedRetryPracticeInput = element(root, `[data-review-ui="saved-review-detail-practice-input"]`);
expectEqual(savedRetryPracticeInput.attributes.get("spellcheck"), "false");
expectEqual(savedRetryPracticeInput.attributes.get("autocorrect"), "off");
expectEqual(savedRetryPracticeInput.attributes.get("autocapitalize"), "off");
expectEqual(savedRetryPracticeInput.attributes.get("placeholder"), "e.g. e2e4");
expectEqual(
  savedRetryPracticeInput.attributes.get("aria-describedby"),
  "saved-review-detail-practice-input-hint"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-input-hint"]`).textContent,
  "Coordinate notation, e.g. e2e4"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-board"]`).attributes.get(
    "data-board-side"
  ),
  "white"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-board"]`).attributes.get(
    "data-best-move"
  ),
  "a2a3"
);
await boardOrientationButton(root, "saved-review-detail-practice", "black").dispatch("click");
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-board"]`).attributes.get(
    "data-board-side"
  ),
  "black"
);
expectEqual(
  boardSquare(root, "saved-review-detail-practice", "a2").attributes.get("data-board-arrow"),
  "from"
);
expectEqual(
  boardSquare(root, "saved-review-detail-practice", "a2").attributes.get(
    "data-board-arrow-direction"
  ),
  "s"
);
expectEqual(
  boardSquare(root, "saved-review-detail-practice", "a3").attributes.get("data-board-arrow"),
  "to"
);
const savedClipboard = installClipboardMock();
try {
  await element(root, `[data-review-ui="saved-review-detail-practice-copy-fen-button"]`).dispatch(
    "click"
  );
  expectEqual(savedClipboard.writes(), [
    "rnbqkbnr/pppp1ppp/8/4p3/5P2/8/PPPPP1PP/RNBQKBNR w KQkq - 0 2"
  ]);
  expectEqual(
    element(root, `[data-review-ui="saved-review-detail-practice-copy-fen-status"]`).textContent,
    "FEN copied"
  );
} finally {
  savedClipboard.restore();
}
expectEqual(
  boardSquares(root, "saved-review-detail-practice").length,
  64
);
expectEqual(
  elements(root, `[data-review-ui="saved-review-detail-practice-board-file-label"]`).map(
    (label) => label.textContent
  ),
  ["h", "g", "f", "e", "d", "c", "b", "a"]
);
await boardSquare(root, "saved-review-detail-practice", "a2").dispatch("click");
await boardSquare(root, "saved-review-detail-practice", "a3").dispatch("click");
expectEqual(element(root, `[data-review-ui="saved-review-detail-practice-input"]`).value, "a2a3");
await element(root, `[data-review-ui="saved-review-detail-practice-submit-button"]`).dispatch("click");
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-feedback"]`).textContent,
  "Correct"
);
await typeIncrementally(root, `[data-review-ui="saved-review-detail-practice-input"]`, "a2a3");
await element(root, `[data-review-ui="saved-review-detail-practice-submit-button"]`).dispatch("click");
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-feedback"]`).textContent,
  "Correct"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-answer"]`).textContent,
  "Answer a2a3"
);
await typeIncrementally(root, `[data-review-ui="saved-review-detail-practice-input"]`, "a2a4");
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-feedback"]`).textContent,
  "Enter the local best move"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-practice-answer"]`).attributes.has("hidden"),
  true
);

await element(root, `[data-review-ui="delete-review-button"][data-review-index="1"]`).dispatch("click");
expectProductHeader(root);
expectIncludes(element(root, `[data-review-ui="stored-review-list"]`).textContent, "Moves2");
expectNotIncludes(element(root, `[data-review-ui="stored-review-list"]`).textContent, "stored");
expectEqual(
  element(root, `[data-review-ui="observed-pattern-artifact-backed-reviews"]`).textContent,
  "Artifact-backed reviews1 of 1 saved review"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-artifact-missing-reviews"]`).textContent,
  "Artifact-missing reviews0 of 1 saved review"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-fork-candidates"]`).textContent,
  "Fork candidates1 from 1 artifact-backed review"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-move-count"]`).textContent,
  "Moves2"
);
expectEqual(element(root, `[data-review-ui="save-state"]`).textContent, "Current review saved");
await element(root, `[data-review-ui="delete-review-button"][data-review-index="0"]`).dispatch("click");
expectEqual(
  element(root, `[data-review-ui="observed-pattern-saved-reviews"]`).textContent,
  "Saved reviews0 saved reviews"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-fork-candidates"]`).textContent,
  "Fork candidates0 from 0 artifact-backed reviews"
);
expectEqual(element(root, `[data-review-ui="save-state"]`).textContent, "Unsaved review");
expectEqual(element(root, `[data-review-ui="save-button"]`).disabled, false);

const hostileId = `stored\u0000 "quoted" [id]\\`;
const hostileStorage = memoryStorage(
  new Map([
    [
      storeKey,
      JSON.stringify({
        schemaVersion: 3,
        reviews: [
          storedReview(hostileId, [entry(1, "good", 10)]),
          storedReview(`${hostileId}-keep`, [entry(1, "mistake", 180)])
        ]
      })
    ]
  ])
);
const hostileRoot = fakeRoot();
mountReviewUi(hostileRoot, dependencies(hostileStorage));
await element(
  hostileRoot,
  `[data-review-ui="delete-review-button"][data-review-index="0"]`
).dispatch("click");
const hostileStored = JSON.parse(hostileStorage.entries().get(storeKey) ?? "") as {
  readonly reviews: readonly StoredReviewV3[];
};
expectEqual(hostileStored.reviews.map((item) => item.id), [`${hostileId}-keep`]);

await element(root, `[data-review-ui="save-button"]`).dispatch("click");
const expectedUiSavedStore = {
  schemaVersion: 3,
  reviews: [
    {
      id: "saved-review",
      savedAtIso: "2026-05-15T16:00:00.000Z",
      source: "review-pgn",
      sourcePgn: " 1. e4 * ",
      review: review([entry(10, "best", 0), entry(41, "blunder", 450)]),
      artifacts: artifacts()
    }
  ]
};
await element(root, `[data-review-ui="clear-button"]`).dispatch("click");
expectProductHeader(root);
expectEqual(JSON.parse(deps.storage.entries().get(storeKey) ?? ""), expectedUiSavedStore);
expectEqual(
  element(root, `[data-review-ui="clear-confirmation"]`).textContent,
  "Clear saved reviews?CancelClear saved reviews"
);
expectEqual(
  element(root, `[data-review-ui="saved-review-detail-empty"]`).textContent,
  "No saved review selected"
);
await element(root, `[data-review-ui="view-review-button"][data-review-index="0"]`).dispatch("click");
expectEqual(root.elements().has(`[data-review-ui="clear-confirmation"]`), false);
await element(root, `[data-review-ui="clear-button"]`).dispatch("click");
await element(root, `[data-review-ui="cancel-clear-button"]`).dispatch("click");
expectEqual(JSON.parse(deps.storage.entries().get(storeKey) ?? ""), expectedUiSavedStore);
await element(root, `[data-review-ui="clear-button"]`).dispatch("click");
await element(root, `[data-review-ui="confirm-clear-button"]`).dispatch("click");
expectProductHeader(root);
expectEqual([...deps.storage.entries()], [["other-key", "kept"]]);
expectEqual(element(root, `[data-review-ui="profile-total-reviews"]`).textContent, "Saved reviews0");
expectEqual(
  element(root, `[data-review-ui="observed-pattern-artifact-backed-reviews"]`).textContent,
  "Artifact-backed reviews0 of 0 saved reviews"
);
expectEqual(
  element(root, `[data-review-ui="observed-pattern-retry-positions"]`).textContent,
  "Retry positions0 from 0 artifact-backed reviews"
);
expectEqual(
  element(root, `[data-review-ui="saved-retry-route-saved-retry-positions"]`).textContent,
  "Saved retry positions0 from 0 artifact-backed reviews"
);
expectNoObservedPatternBannedWords(element(root, `[data-review-ui="observed-patterns"]`).textContent);
expectEqual(element(root, `[data-review-ui="clear-button"]`).disabled, true);

const corruptStorage = memoryStorage(new Map([[storeKey, "{"]]));
const corruptRoot = fakeRoot();
mountReviewUi(corruptRoot, dependencies(corruptStorage));
expectProductHeader(corruptRoot);
expectStatusPresentation(corruptRoot, "Needs attention");
expectActiveErrorPresentation(corruptRoot, "Stored reviews could not be read", "store", "corrupt-store");
expectEqual([...corruptStorage.entries()], [[storeKey, "{"]]);
expectEqual(element(corruptRoot, `[data-review-ui="clear-button"]`).disabled, true);
expectEqual(element(corruptRoot, `[data-review-ui="saved-retry-route"]`).attributes.has("hidden"), true);
expectEqual(element(corruptRoot, `[data-review-ui="recover-store-button"]`).disabled, false);
await element(corruptRoot, `[data-review-ui="recover-store-button"]`).dispatch("click");
expectEqual([...corruptStorage.entries()], [[storeKey, "{"]]);
expectEqual(
  element(corruptRoot, `[data-review-ui="recover-store-confirmation"]`).textContent,
  "Reset saved-review storage?CancelReset saved reviews"
);
await element(corruptRoot, `[data-review-ui="cancel-recover-store-button"]`).dispatch("click");
expectEqual([...corruptStorage.entries()], [[storeKey, "{"]]);
await element(corruptRoot, `[data-review-ui="recover-store-button"]`).dispatch("click");
await element(corruptRoot, `[data-review-ui="confirm-recover-store-button"]`).dispatch("click");
expectProductHeader(corruptRoot);
expectEqual([...corruptStorage.entries()], []);
expectStatusPresentation(corruptRoot, "Ready");
expectNoErrorPresentation(corruptRoot);
expectEqual(element(corruptRoot, `[data-review-ui="profile-total-reviews"]`).textContent, "Saved reviews0");
expectEqual(
  element(corruptRoot, `[data-review-ui="observed-pattern-saved-reviews"]`).textContent,
  "Saved reviews0 saved reviews"
);

const unsupportedStorage = memoryStorage(
  new Map([[storeKey, JSON.stringify({ schemaVersion: 4, reviews: [] })], ["other-key", "kept"]])
);
const unsupportedRoot = fakeRoot();
mountReviewUi(unsupportedRoot, dependencies(unsupportedStorage));
expectStatusPresentation(unsupportedRoot, "Needs attention");
expectActiveErrorPresentation(
  unsupportedRoot,
  "Stored reviews use a newer schema",
  "store",
  "unsupported-schema"
);
expectEqual(element(unsupportedRoot, `[data-review-ui="clear-button"]`).disabled, true);
await element(unsupportedRoot, `[data-review-ui="recover-store-button"]`).dispatch("click");
await element(unsupportedRoot, `[data-review-ui="confirm-recover-store-button"]`).dispatch("click");
expectStatusPresentation(unsupportedRoot, "Ready");
expectNoErrorPresentation(unsupportedRoot);
expectEqual([...unsupportedStorage.entries()], [["other-key", "kept"]]);
expectEqual(element(unsupportedRoot, `[data-review-ui="stored-review-empty"]`).textContent, "No saved reviews");
expectEqual(
  element(unsupportedRoot, `[data-review-ui="observed-pattern-saved-reviews"]`).textContent,
  "Saved reviews0 saved reviews"
);

const saveErrorStorage = memoryStorage();
const saveErrorRoot = fakeRoot();
mountReviewUi(saveErrorRoot, dependencies(saveErrorStorage));
await element(saveErrorRoot, `[data-review-ui="review-button"]`).dispatch("click");
expectEqual(
  element(saveErrorRoot, `[data-review-ui="summary-total-moves"]`).textContent,
  "Total moves2"
);
saveErrorStorage.writeRaw(storeKey, "{");
await element(saveErrorRoot, `[data-review-ui="save-button"]`).dispatch("click");
expectStatusPresentation(saveErrorRoot, "Needs attention");
expectActiveErrorPresentation(saveErrorRoot, "Stored reviews could not be read", "store", "corrupt-store");
expectEqual(element(saveErrorRoot, `[data-review-ui="save-state"]`).textContent, "Unsaved review");
expectEqual(element(saveErrorRoot, `[data-review-ui="save-button"]`).disabled, false);
expectEqual(
  element(saveErrorRoot, `[data-review-ui="summary-total-moves"]`).textContent,
  "Total moves2"
);
expectEqual([...saveErrorStorage.entries()], [[storeKey, "{"]]);
await element(saveErrorRoot, `[data-review-ui="recover-store-button"]`).dispatch("click");
await element(saveErrorRoot, `[data-review-ui="confirm-recover-store-button"]`).dispatch("click");
expectEqual([...saveErrorStorage.entries()], []);
expectStatusPresentation(saveErrorRoot, "Review complete");
expectNoErrorPresentation(saveErrorRoot);
expectEqual(element(saveErrorRoot, `[data-review-ui="summary-total-moves"]`).textContent, "Total moves2");
expectEqual(element(saveErrorRoot, `[data-review-ui="save-state"]`).textContent, "Unsaved review");

const routeErrorStorage = memoryStorage(new Map([[storeKey, JSON.stringify(routeStorePayload)]]));
const routeErrorRoot = fakeRoot();
mountReviewUi(routeErrorRoot, dependencies(routeErrorStorage));
expectEqual(
  element(routeErrorRoot, `[data-review-ui="open-saved-retry-route-button"]`).textContent,
  "Open saved retry position"
);
await element(routeErrorRoot, `[data-review-ui="review-button"]`).dispatch("click");
routeErrorStorage.writeRaw(storeKey, "{");
await element(routeErrorRoot, `[data-review-ui="save-button"]`).dispatch("click");
expectActiveErrorPresentation(routeErrorRoot, "Stored reviews could not be read", "store", "corrupt-store");
expectEqual(element(routeErrorRoot, `[data-review-ui="saved-retry-route"]`).attributes.has("hidden"), true);

const readFailureRoot = fakeRoot();
mountReviewUi(readFailureRoot, dependencies({
  getItem: () => {
    throw new Error("read failed");
  },
  setItem: () => {},
  removeItem: () => {},
  entries: () => new Map(),
  writeRaw: () => {}
}));
expectStatusPresentation(readFailureRoot, "Needs attention");
expectActiveErrorPresentation(readFailureRoot, "Stored reviews could not be read", "store", "storage-read-failed");
expectEqual(readFailureRoot.elements().has(`[data-review-ui="recover-store-button"]`), false);

const errors: readonly WasmBridgeError[] = [
  "invalid-fen",
  "invalid-pgn",
  "invalid-move",
  "invalid-depth",
  "invalid-position",
  "search-failed"
];
for (const error of errors) {
  const errorRoot = fakeRoot();
  const errorDeps: ReviewUiDependencies = {
    storage: memoryStorage(),
    reviewPgn: () => Promise.resolve({ ok: false, error }),
    createSaveMetadata: () => ({
      ok: true,
      metadata: { id: "unused", savedAtIso: "2026-05-15T16:00:00.000Z" }
    })
  };
  mountReviewUi(errorRoot, errorDeps);
  await element(errorRoot, `[data-review-ui="review-button"]`).dispatch("click");
  expectProductHeader(errorRoot);
  expectStatusPresentation(errorRoot, "Needs attention");
  expectActiveErrorPresentation(errorRoot, expectedErrorLabel(error), "review", error);
  if (error === "search-failed") {
    expectNotIncludes(element(errorRoot, `[data-review-ui="status"]`).textContent, "Review failed");
  }
}

const resetAfterFailureRoot = fakeRoot();
mountReviewUi(resetAfterFailureRoot, {
  storage: memoryStorage(),
  reviewPgn: () => Promise.resolve({ ok: false, error: "invalid-pgn" }),
  createSaveMetadata: () => ({
    ok: true,
    metadata: { id: "unused", savedAtIso: "2026-05-15T16:00:00.000Z" }
  })
});
await element(resetAfterFailureRoot, `[data-review-ui="review-button"]`).dispatch("click");
expectStatusPresentation(resetAfterFailureRoot, "Needs attention");
expectActiveErrorPresentation(resetAfterFailureRoot, "Invalid PGN", "review", "invalid-pgn");
element(resetAfterFailureRoot, `[data-review-ui="pgn-input"]`).value = "1. e4 *";
await element(resetAfterFailureRoot, `[data-review-ui="pgn-input"]`).dispatch("input");
expectStatusPresentation(resetAfterFailureRoot, "Ready");
expectNoErrorPresentation(resetAfterFailureRoot);

const noReviewRoot = fakeRoot();
const noReviewStorage = memoryStorage();
mountReviewUi(noReviewRoot, dependencies(noReviewStorage));
await element(noReviewRoot, `[data-review-ui="save-button"]`).dispatch("click");
expectStatusPresentation(noReviewRoot, "Needs attention");
expectActiveErrorPresentation(noReviewRoot, "No review to save", "workflow", "no-current-review");
expectEqual([...noReviewStorage.entries()], []);

const metadataErrorRoot = fakeRoot();
const metadataErrorStorage = memoryStorage();
mountReviewUi(metadataErrorRoot, {
  ...dependencies(metadataErrorStorage),
  createSaveMetadata: () => ({ ok: false, error: "metadata-unavailable" })
});
await element(metadataErrorRoot, `[data-review-ui="review-button"]`).dispatch("click");
await element(metadataErrorRoot, `[data-review-ui="save-button"]`).dispatch("click");
expectStatusPresentation(metadataErrorRoot, "Needs attention");
expectActiveErrorPresentation(
  metadataErrorRoot,
  "Save metadata unavailable",
  "metadata",
  "metadata-unavailable"
);
expectEqual(element(metadataErrorRoot, `[data-review-ui="save-state"]`).textContent, "Unsaved review");
expectEqual(element(metadataErrorRoot, `[data-review-ui="save-button"]`).disabled, false);
expectEqual([...metadataErrorStorage.entries()], []);

const repeatedA = fakeRoot();
const repeatedDepsA = dependencies(memoryStorage());
mountReviewUi(repeatedA, repeatedDepsA);
await element(repeatedA, `[data-review-ui="review-button"]`).dispatch("click");
await element(repeatedA, `[data-review-ui="save-button"]`).dispatch("click");

const repeatedB = fakeRoot();
const repeatedDepsB = dependencies(memoryStorage());
mountReviewUi(repeatedB, repeatedDepsB);
await element(repeatedB, `[data-review-ui="review-button"]`).dispatch("click");
await element(repeatedB, `[data-review-ui="save-button"]`).dispatch("click");
expectEqual(repeatedA.html(), repeatedB.html());

const handoffRoot = fakeRoot();
const handoffDeps = dependencies(memoryStorage());
const handoffUi = mountReviewUi(handoffRoot, handoffDeps);
await handoffUi.reviewPgn("1. f3 e5 2. g4 Qh4# 0-1");
expectEqual(handoffUi.getState().inlinePgn, "1. f3 e5 2. g4 Qh4# 0-1");
expectEqual(handoffDeps.requests(), [{ pgn: "1. f3 e5 2. g4 Qh4# 0-1", depth: 3 }]);
expectStatusPresentation(handoffRoot, "Review complete");

ui.destroy();
const afterDestroy = ui.getState();
await element(root, `[data-review-ui="review-button"]`).dispatch("click");
expectEqual(ui.getState(), afterDestroy);

function expectedErrorLabel(error: WasmBridgeError): string {
  switch (error) {
    case "invalid-fen":
    case "invalid-position":
      return "Invalid position";
    case "invalid-pgn":
      return "Invalid PGN";
    case "invalid-move":
      return "Illegal move";
    case "invalid-depth":
      return "Invalid review depth";
    case "search-failed":
      return "Review failed";
  }
}
