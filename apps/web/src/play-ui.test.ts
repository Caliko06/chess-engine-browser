import type {
  BestMoveDto,
  ColorDto,
  EngineStateDto,
  ForcingMapDto,
  MoveResultDto,
  SideExploreDto
} from "./engine-dtos";
import type { PlayEngine, PlayEngineMode, PlayEngineResult } from "./play-wasm-executor";
import {
  buildCompletedPlayGame,
  mountPlayUi,
  renderRefutationMemoryAnnotations,
  type CompletedPlayGame,
  type PlayMove
} from "./play-ui";
import { playRefutationMemoryCases, refutationMemoryHit } from "./play-refutation-memory.js";

type Listener = () => void | Promise<void>;

type DeferredResult<T> = {
  readonly promise: Promise<{ readonly ok: true; readonly value: T }>;
  readonly resolve: (value: { readonly ok: true; readonly value: T }) => void;
};

type DeferredEngineResult<T> = {
  readonly promise: Promise<PlayEngineResult<T>>;
  readonly resolve: (value: PlayEngineResult<T>) => void;
};

type FakeElement = {
  readonly selector: string;
  readonly textContent: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly disabled: boolean;
  readonly getAttribute: (name: string) => string | null;
  readonly setAttribute: (name: string, value: string) => void;
  readonly removeAttribute: (name: string) => void;
  readonly toggleAttribute: (name: string, force?: boolean) => boolean;
  readonly addEventListener: (type: string, listener: Listener) => void;
  readonly dispatch: (type: string) => Promise<void>;
};

type FakeRoot = HTMLElement & {
  readonly elements: () => ReadonlyMap<string, FakeElement>;
  readonly html: () => string;
  readonly querySelectorAll: (selector: string) => readonly FakeElement[];
};

function expectEqual<T>(actual: T, expected: T): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`expected ${expectedText}, got ${actualText}`);
  }
}

function fakeRoot(): FakeRoot {
  let html = "";
  let elements = new Map<string, FakeElement>();
  const attributes = new Map<string, string>();
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
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
    elements: () => elements,
    html: () => html
  };
  return root as unknown as FakeRoot;
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

type EvidenceMemoryStorage = {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
  readonly entries: () => ReadonlyMap<string, string>;
};

function evidenceMemoryStorage(): EvidenceMemoryStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    entries: () => values
  };
}

function storedEvidenceSessions(storage: EvidenceMemoryStorage): readonly unknown[] {
  const serialized = storage.entries().get("chess.play.aggressiveEvidenceStore.v1");
  if (serialized === undefined) {
    return [];
  }
  const parsed = JSON.parse(serialized) as { readonly sessions?: readonly unknown[] };
  return parsed.sessions ?? [];
}

function storedGameArchive(storage: EvidenceMemoryStorage): readonly unknown[] {
  const serialized = storage.entries().get("chess.play.gameArchive.v1");
  if (serialized === undefined) {
    return [];
  }
  const parsed = JSON.parse(serialized) as { readonly games?: readonly unknown[] };
  return parsed.games ?? [];
}

function parseElements(html: string): Map<string, FakeElement> {
  const elements = new Map<string, FakeElement>();
  const tokenPattern = /<(?<tag>[a-z][a-z0-9]*)(?<attributes>[^>]*)>/gu;
  for (const match of html.matchAll(tokenPattern)) {
    const tag = match.groups?.tag ?? "";
    const attributes = parseAttributes(match.groups?.attributes ?? "");
    const uiName = attributes.get("data-play-ui");
    if (uiName === undefined) {
      continue;
    }
    const body = bodyText(html, tag, match.index + match[0].length);
    let selector = `[data-play-ui="${uiName}"]`;
    const square = attributes.get("data-square");
    const ply = attributes.get("data-play-ply");
    const promotionPiece = attributes.get("data-promotion-piece");
    const playerSide = attributes.get("data-player-side");
    const engineDepth = attributes.get("data-engine-depth");
    const evalMode = attributes.get("data-eval-mode");
    const playMode = uiName === "play-mode-button" ? attributes.get("data-play-mode") : undefined;
    const reactionView = attributes.get("data-reaction-view");
    const reactionDepth = attributes.get("data-reaction-depth");
    const forcingKind =
      uiName === "forcing-candidate" ? attributes.get("data-forcing-kind") : undefined;
    const resignActor = uiName === "resign-button" ? attributes.get("data-resign-actor") : undefined;
    if (square !== undefined) {
      selector = `${selector}[data-square="${square}"]`;
    } else if (ply !== undefined) {
      selector = `${selector}[data-play-ply="${ply}"]`;
    } else if (promotionPiece !== undefined) {
      selector = `${selector}[data-promotion-piece="${promotionPiece}"]`;
    } else if (playerSide !== undefined) {
      selector = `${selector}[data-player-side="${playerSide}"]`;
    } else if (engineDepth !== undefined) {
      selector = `${selector}[data-engine-depth="${engineDepth}"]`;
    } else if (evalMode !== undefined) {
      selector = `${selector}[data-eval-mode="${evalMode}"]`;
    } else if (playMode !== undefined) {
      selector = `${selector}[data-play-mode="${playMode}"]`;
    } else if (reactionView !== undefined) {
      selector = `${selector}[data-reaction-view="${reactionView}"]`;
    } else if (reactionDepth !== undefined) {
      selector = `${selector}[data-reaction-depth="${reactionDepth}"]`;
    } else if (forcingKind !== undefined) {
      selector = `${selector}[data-forcing-kind="${forcingKind}"]`;
    } else if (resignActor !== undefined) {
      selector = `${selector}[data-resign-actor="${resignActor}"]`;
    }
    elements.set(selector, fakeElement(selector, attributes, stripTags(body)));
  }
  return elements;
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

function bodyText(html: string, tag: string, startIndex: number): string {
  const end = html.indexOf(`</${tag}>`, startIndex);
  return end === -1 ? "" : html.slice(startIndex, end);
}

function fakeElement(
  selector: string,
  attributes: ReadonlyMap<string, string>,
  textContent: string
): FakeElement {
  const listeners = new Map<string, Listener[]>();
  const mutableAttributes = new Map(attributes);
  return {
    selector,
    textContent,
    attributes: mutableAttributes,
    get disabled() {
      return mutableAttributes.has("disabled");
    },
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
    dispatch: async (type: string) => {
      for (const listener of listeners.get(type) ?? []) {
        await listener();
      }
    }
  };
}

function elementMatchesSelector(element: FakeElement, selector: string): boolean {
  const uiName = /\[data-play-ui="(?<name>[^"]+)"\]/u.exec(selector)?.groups?.name;
  const square = /\[data-square="(?<square>[^"]+)"\]/u.exec(selector)?.groups?.square;
  const ply = /\[data-play-ply="(?<ply>[^"]+)"\]/u.exec(selector)?.groups?.ply;
  const promotionPiece = /\[data-promotion-piece="(?<piece>[^"]+)"\]/u.exec(selector)?.groups
    ?.piece;
  const playerSide = /\[data-player-side="(?<side>[^"]+)"\]/u.exec(selector)?.groups?.side;
  const engineDepth = /\[data-engine-depth="(?<depth>[^"]+)"\]/u.exec(selector)?.groups?.depth;
  const evalMode = /\[data-eval-mode="(?<mode>[^"]+)"\]/u.exec(selector)?.groups?.mode;
  const playMode = /\[data-play-mode="(?<mode>[^"]+)"\]/u.exec(selector)?.groups?.mode;
  const reactionView = /\[data-reaction-view="(?<view>[^"]+)"\]/u.exec(selector)?.groups?.view;
  const reactionDepth = /\[data-reaction-depth="(?<depth>[^"]+)"\]/u.exec(selector)?.groups?.depth;
  const forcingKind = /\[data-forcing-kind="(?<kind>[^"]+)"\]/u.exec(selector)?.groups?.kind;
  const resignActor = /\[data-resign-actor="(?<actor>[^"]+)"\]/u.exec(selector)?.groups?.actor;
  if (uiName !== undefined && element.attributes.get("data-play-ui") !== uiName) {
    return false;
  }
  if (square !== undefined && element.attributes.get("data-square") !== square) {
    return false;
  }
  if (ply !== undefined && element.attributes.get("data-play-ply") !== ply) {
    return false;
  }
  if (
    promotionPiece !== undefined &&
    element.attributes.get("data-promotion-piece") !== promotionPiece
  ) {
    return false;
  }
  if (playerSide !== undefined && element.attributes.get("data-player-side") !== playerSide) {
    return false;
  }
  if (engineDepth !== undefined && element.attributes.get("data-engine-depth") !== engineDepth) {
    return false;
  }
  if (evalMode !== undefined && element.attributes.get("data-eval-mode") !== evalMode) {
    return false;
  }
  if (playMode !== undefined && element.attributes.get("data-play-mode") !== playMode) {
    return false;
  }
  if (reactionView !== undefined && element.attributes.get("data-reaction-view") !== reactionView) {
    return false;
  }
  if (
    reactionDepth !== undefined &&
    element.attributes.get("data-reaction-depth") !== reactionDepth
  ) {
    return false;
  }
  if (forcingKind !== undefined && element.attributes.get("data-forcing-kind") !== forcingKind) {
    return false;
  }
  if (resignActor !== undefined && element.attributes.get("data-resign-actor") !== resignActor) {
    return false;
  }
  return (
    uiName !== undefined ||
    square !== undefined ||
    ply !== undefined ||
    promotionPiece !== undefined ||
    playerSide !== undefined ||
    engineDepth !== undefined ||
    playMode !== undefined ||
    reactionView !== undefined ||
    reactionDepth !== undefined ||
    forcingKind !== undefined ||
    resignActor !== undefined
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

function boardSquare(root: FakeRoot, square: string): FakeElement {
  return element(root, `[data-play-ui="board-square"][data-square="${square}"]`);
}

function boardSquareOrder(root: FakeRoot): readonly (string | null)[] {
  return elements(root, `[data-play-ui="board-square"]`).map((square) =>
    square.getAttribute("data-square")
  );
}

function playerSideButton(root: FakeRoot, side: string): FakeElement {
  return element(root, `[data-play-ui="player-side-button"][data-player-side="${side}"]`);
}

function engineDepthButton(root: FakeRoot, depth: number): FakeElement {
  return element(root, `[data-play-ui="engine-depth-button"][data-engine-depth="${String(depth)}"]`);
}

function reactionViewButton(root: FakeRoot, view: string): FakeElement {
  return element(root, `[data-play-ui="reaction-view-button"][data-reaction-view="${view}"]`);
}

function reactionDepthButton(root: FakeRoot, depth: string): FakeElement {
  return element(root, `[data-play-ui="reaction-depth-button"][data-reaction-depth="${depth}"]`);
}

function expectPlayError(
  root: FakeRoot,
  source: string,
  title: string,
  operation: string,
  reason: string,
  recovery: string
): void {
  expectEqual(element(root, `[data-play-ui="error"]`).getAttribute("data-play-error-source"), source);
  expectEqual(element(root, `[data-play-ui="error-title"]`).textContent, title);
  expectEqual(element(root, `[data-play-ui="error-operation"]`).textContent, `Operation${operation}`);
  expectEqual(element(root, `[data-play-ui="error-reason"]`).textContent, `Reason${reason}`);
  expectEqual(element(root, `[data-play-ui="error-recovery"]`).textContent, `Recovery${recovery}`);
}

function expectNoPlayError(root: FakeRoot): void {
  expectEqual(element(root, `[data-play-ui="error"]`).getAttribute("hidden"), "");
}

function expectNoSelection(root: FakeRoot): void {
  expectEqual(element(root, `[data-play-ui="selection-assist"]`).textContent, "SelectionNo selection");
  expectEqual(elements(root, `[data-play-ui="selected-square"]`).length, 0);
  expectEqual(elements(root, `[data-play-ui="selection-legal-count"]`).length, 0);
  expectEqual(elements(root, `[data-play-ui="selection-legal-targets"]`).length, 0);
}

function expectStatus(root: FakeRoot, text: string, owner: string, side: string | null): void {
  const status = element(root, `[data-play-ui="status"]`);
  expectEqual(status.textContent, text);
  expectEqual(status.getAttribute("data-play-status-owner"), owner);
  expectEqual(status.getAttribute("data-play-status-side"), side);
}

function expectSelection(
  root: FakeRoot,
  square: string,
  countText: string,
  targetsText: string
): void {
  expectEqual(element(root, `[data-play-ui="selected-square"]`).textContent, square);
  expectEqual(element(root, `[data-play-ui="selection-legal-count"]`).textContent, countText);
  expectEqual(element(root, `[data-play-ui="selection-legal-targets"]`).textContent, targetsText);
}

function expectFailedNonTerminal(root: FakeRoot): void {
  expectEqual(element(root, `[data-play-ui="post-game-review-button"]`).disabled, true);
  expectEqual(elements(root, `[data-play-ui="resign-button"]`).length, 0);
  expectEqual(elements(root, `[data-play-ui="rematch-button"]`).length, 0);
  expectEqual(elements(root, `[data-play-ui="terminal-result"]`).length, 0);
}

function expectBefore(haystack: string, first: string, second: string): void {
  const firstIndex = haystack.indexOf(first);
  const secondIndex = haystack.indexOf(second);
  if (firstIndex === -1 || secondIndex === -1 || firstIndex >= secondIndex) {
    throw new Error(`expected ${first} to appear before ${second}`);
  }
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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error("condition did not become true");
}

const startState: EngineStateDto = {
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["e2e3", "e2e4"]
};

// Play evidence refutation memory annotation. -------------------------------
const refutationFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const refutationCases = [
  {
    positionKey: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -",
    move: "b8c6",
    advice: "do-not-prefer-without-new-tactical-proof"
  }
];
expectEqual(refutationMemoryHit(refutationFen, "b8c6", refutationCases)?.move, "b8c6");
expectEqual(refutationMemoryHit(refutationFen, "g8f6", refutationCases), null);
expectEqual(playRefutationMemoryCases.length > 0, true);
expectEqual(
  refutationMemoryHit(
    "2kr3r/ppp1npb1/1qn1b1p1/1N1p3p/1P1P2P1/2P1P2Q/P3BP1P/R1B1K1NR w KQ - 1 13",
    "c1b2"
  )?.advice,
  "do-not-prefer-without-new-tactical-proof"
);
const refutationAnnotationState = {
  status: "ready",
  fen: refutationFen,
  side: "black",
  source: "rich",
  error: null,
  result: {
    state: {
      fen: refutationFen,
      status: "ongoing",
      sideToMove: "black",
      legalMoves: ["b8c6", "g8f6"]
    },
    side: "black",
    onTurn: true,
    replyCandidates: [],
    candidates: [
      {
        move: "b8c6",
        kind: "defense",
        exactScoreCp: 12,
        sound: true,
        sacrifice: false,
        prospectiveBrilliant: false,
        mateIn: null,
        aftermath: null,
        continuation: null
      },
      {
        move: "g8f6",
        kind: "defense",
        exactScoreCp: 10,
        sound: true,
        sacrifice: false,
        prospectiveBrilliant: false,
        mateIn: null,
        aftermath: null,
        continuation: null
      }
    ],
    principalLine: ["b8c6"],
    mateDetected: false,
    depth: 1,
    nodes: 1,
    soundMarginCp: 50
  }
} as const;
const refutationAnnotation = renderRefutationMemoryAnnotations(refutationAnnotationState, refutationCases);
expectEqual(refutationAnnotation.includes(`data-play-refuted="oracle"`), true);
expectEqual(refutationAnnotation.includes("refutada por el oráculo; requiere una prueba nueva"), true);
expectEqual(refutationAnnotation.includes(`data-refuted-move="g8f6"`), false);
expectEqual(renderRefutationMemoryAnnotations(refutationAnnotationState, []), "");

const afterE4: MoveResultDto = {
  appliedMove: "e2e4",
  san: "e4",
  state: {
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    status: "ongoing",
    sideToMove: "black",
    legalMoves: ["b8c6"]
  }
};

const afterNc6: MoveResultDto = {
  appliedMove: "b8c6",
  san: "Nc6",
  state: {
    fen: "r1bqkbnr/pppppppp/2n5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2",
    status: "ongoing",
    sideToMove: "white",
    legalMoves: ["g1f3", "d2d4"]
  }
};

const afterNf3: MoveResultDto = {
  appliedMove: "g1f3",
  san: "Nf3",
  state: {
    fen: "r1bqkbnr/pppppppp/2n5/8/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 2 2",
    status: "ongoing",
    sideToMove: "black",
    legalMoves: ["g8f6"]
  }
};

const afterG8f6: MoveResultDto = {
  appliedMove: "g8f6",
  san: "Nf6",
  state: {
    fen: "r1bqkb1r/pppppppp/2n2n2/8/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 3 3",
    status: "ongoing",
    sideToMove: "white",
    legalMoves: ["b1c3", "d2d4"]
  }
};

const calls: string[] = [];
const engine: PlayEngine = {
  newGame: () => {
    calls.push("newGame");
    return Promise.resolve({ ok: true, value: startState });
  },
  makeMove: (_fen, mv) => {
    calls.push(`makeMove:${mv}`);
    return Promise.resolve(
      mv === "e2e4" ? { ok: true, value: afterE4 } : { ok: true, value: afterNc6 }
    );
  },
  bestMove: (_fen, depth) => {
    calls.push(`bestMove:${String(depth)}`);
    return Promise.resolve({
      ok: true,
      value: { bestMove: "b8c6", depth, scoreCp: -12, nodes: 20, ttHits: 0 }
    });
  },
  loadPosition: (fen) => {
    calls.push(`loadPosition:${fen}`);
    return Promise.resolve({ ok: true, value: startState });
  }
};

const loadingRoot = fakeRoot();
const loadingNewGame = deferred<EngineStateDto>();
const loadingEngine: PlayEngine = {
  newGame: () => loadingNewGame.promise,
  makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
  bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
};
const loadingHandle = mountPlayUi(loadingRoot, { engine: loadingEngine });
expectEqual(element(loadingRoot, `[data-play-ui="status"]`).textContent, "Loading");
expectNoSelection(loadingRoot);
expectEqual(elements(loadingRoot, `[data-play-ui="current-fen"]`).length, 0);
expectEqual(elements(loadingRoot, `[data-play-ui="current-fen-copy"]`).length, 0);
expectEqual(elements(loadingRoot, `[data-play-ui="last-move"]`).length, 0);
loadingNewGame.resolve({ ok: true, value: startState });
await loadingHandle.ready;
expectEqual(element(loadingRoot, `[data-play-ui="current-fen"]`).textContent, `FEN${startState.fen}`);
expectEqual(element(loadingRoot, `[data-play-ui="current-fen-copy-button"]`).textContent, "Copy FEN");

const root = fakeRoot();
const handle = mountPlayUi(root, { engine });
await handle.ready;

expectEqual(calls, ["newGame"]);
expectEqual(elements(root, `[data-play-ui="board-square"]`).length, 64);
expectEqual(elements(root, `[data-play-ui="analysis-lens"]`).length, 0);
expectEqual(elements(root, `[data-play-ui="reaction-lens"]`).length, 0);
expectEqual(elements(root, `[data-play-ui="reaction-arrows"]`).length, 0);
expectEqual(element(root, `[data-play-ui="mode-label"]`).textContent, "Engine: Owned local");
expectEqual(
  element(root, `[data-play-ui="aggressive-toggle-button"]`).textContent,
  "Aggressive: Off"
);
await element(root, `[data-play-ui="aggressive-toggle-button"]`).dispatch("click");
expectEqual(
  element(root, `[data-play-ui="aggressive-toggle-button"]`).textContent,
  "Aggressive: On"
);
expectStatus(root, "Your move as White", "player", "white");
expectEqual(element(root, `[data-play-ui="post-game-review-button"]`).disabled, true);
expectEqual(elements(root, `[data-play-ui="resign-button"]`).length, 2);
expectEqual(
  element(root, `[data-play-ui="resign-button"][data-resign-actor="user"]`).textContent,
  "Resign"
);
expectEqual(
  element(root, `[data-play-ui="resign-button"][data-resign-actor="user"]`).getAttribute("aria-label"),
  "User resigns (White)"
);
expectEqual(
  element(root, `[data-play-ui="resign-button"][data-resign-actor="rival"]`).textContent,
  "Rival resigns (Black)"
);
expectNoSelection(root);
expectEqual(element(root, `[data-play-ui="current-fen"]`).textContent, `FEN${startState.fen}`);
expectEqual(element(root, `[data-play-ui="current-fen-copy-button"]`).textContent, "Copy FEN");
expectEqual(element(root, `[data-play-ui="current-fen-copy-status"]`).textContent, "");
expectEqual(elements(root, `[data-play-ui="last-move"]`).length, 0);
expectEqual(elements(root, `[data-play-ui="terminal-pgn-copy"]`).length, 0);
expectEqual(elements(root, `[data-play-ui="terminal-copy-pgn-button"]`).length, 0);
expectEqual(playerSideButton(root, "white").getAttribute("aria-pressed"), "true");
expectEqual(engineDepthButton(root, 1).getAttribute("aria-pressed"), "true");
expectEqual(element(root, `[data-play-ui="board"]`).getAttribute("data-board-orientation"), "white");
expectEqual(boardSquareOrder(root).at(0), "a8");
expectEqual(boardSquareOrder(root).at(-1), "h1");
expectEqual(boardSquare(root, "e2").getAttribute("data-board-piece"), "P");
expectEqual(boardSquare(root, "e2").getAttribute("data-board-draggable"), "true");
expectEqual(boardSquare(root, "e2").getAttribute("draggable"), null);
expectEqual(boardSquare(root, "e4").getAttribute("data-board-draggable"), "false");
expectEqual(boardSquare(root, "e7").getAttribute("data-board-draggable"), "false");

const initialFenClipboard = installClipboardMock();
try {
  await element(root, `[data-play-ui="current-fen-copy-button"]`).dispatch("click");
  expectEqual(initialFenClipboard.writes(), [startState.fen]);
  expectEqual(element(root, `[data-play-ui="current-fen-copy-status"]`).textContent, "FEN copied");
} finally {
  initialFenClipboard.restore();
}
const unavailableFenClipboard = installClipboardMock({ reject: true });
try {
  await element(root, `[data-play-ui="current-fen-copy-button"]`).dispatch("click");
  expectEqual(unavailableFenClipboard.writes(), [startState.fen]);
  expectEqual(element(root, `[data-play-ui="current-fen-copy-status"]`).textContent, "FEN copy unavailable");
} finally {
  unavailableFenClipboard.restore();
}

await boardSquare(root, "e2").dispatch("click");
expectEqual(boardSquare(root, "e4").getAttribute("data-board-legal-target"), "true");
expectEqual(
  element(root, `[data-play-ui="selection-assist"]`).textContent,
  "Selectione2 -> 2 legal destinations: e3, e4"
);
expectSelection(root, "e2", "2 legal destinations", "e3, e4");
await boardSquare(root, "e2").dispatch("click");
expectNoSelection(root);
await boardSquare(root, "e2").dispatch("click");
expectSelection(root, "e2", "2 legal destinations", "e3, e4");
await boardSquare(root, "e5").dispatch("click");
expectStatus(root, "Your move as White", "player", "white");
expectNoSelection(root);
expectPlayError(
  root,
  "invalid-input",
  "Invalid move",
  "Move selection",
  "Invalid move",
  "Choose a legal move."
);
expectEqual(element(root, `[data-play-ui="post-game-review-button"]`).disabled, true);
expectEqual(elements(root, `[data-play-ui="terminal-result"]`).length, 0);

await boardSquare(root, "e2").dispatch("click");
await boardSquare(root, "e4").dispatch("click");
await waitFor(() => elements(root, `[data-play-ui="move-row"]`).length === 2);

expectEqual(calls, ["newGame", "makeMove:e2e4", "bestMove:1", "makeMove:b8c6"]);
expectStatus(root, "Your move as White", "player", "white");
expectEqual(element(root, `[data-play-ui="move-row"][data-play-ply="1"]`).getAttribute("data-play-turn"), "1");
expectEqual(element(root, `[data-play-ui="move-row"][data-play-ply="1"]`).getAttribute("data-play-side"), "white");
expectEqual(element(root, `[data-play-ui="move-row"][data-play-ply="1"]`).textContent, "1.UserWhitee4e2e4");
expectEqual(
  element(root, `[data-play-ui="move-row"][data-play-ply="2"]`).textContent,
  "1...RivalBlackNc6b8c6"
);
expectEqual(element(root, `[data-play-ui="current-fen"]`).textContent, `FEN${afterNc6.state.fen}`);
expectEqual(
  element(root, `[data-play-ui="last-move"]`).textContent,
  "Last moveBlack engine: Nc6 (b8c6)"
);
expectNoSelection(root);
expectEqual(boardSquare(root, "b8").getAttribute("data-board-last-move"), "true");
expectEqual(boardSquare(root, "c6").getAttribute("data-board-last-move"), "true");
expectNoPlayError(root);
const updatedFenClipboard = installClipboardMock();
try {
  await element(root, `[data-play-ui="current-fen-copy-button"]`).dispatch("click");
  expectEqual(updatedFenClipboard.writes(), [afterNc6.state.fen]);
  expectEqual(element(root, `[data-play-ui="current-fen-copy-status"]`).textContent, "FEN copied");
} finally {
  updatedFenClipboard.restore();
}

// Undo: a takeback reverts the engine's reply together with the player's own move, back to the
// player's turn, restoring the prior position through loadPosition.
await element(root, `[data-play-ui="undo-button"]`).dispatch("click");
await waitFor(() => elements(root, `[data-play-ui="move-row"]`).length === 0);
expectEqual(calls.at(-1), `loadPosition:${startState.fen}`);
expectStatus(root, "Your move as White", "player", "white");
expectEqual(element(root, `[data-play-ui="current-fen"]`).textContent, `FEN${startState.fen}`);
expectEqual(elements(root, `[data-play-ui="last-move"]`).length, 0);
expectEqual(elements(root, `[data-play-ui="undo-button"]`).length, 0);
expectNoPlayError(root);

const contextualRoot = fakeRoot();
const contextualBestMoveCalls: Array<{
  readonly fen: string;
  readonly depth: number;
  readonly legalMoves: readonly string[] | undefined;
  readonly aggressive: boolean | undefined;
  readonly context:
    | {
        readonly side: ColorDto;
        readonly userSide: ColorDto;
        readonly historyFens: readonly string[];
        readonly previousLine: readonly string[];
      }
    | undefined;
}> = [];
const contextualEngine: PlayEngine = {
  newGame: () => Promise.resolve({ ok: true, value: startState }),
  makeMove: (fen, mv) => {
    if (fen === startState.fen && mv === "e2e4") {
      return Promise.resolve({ ok: true, value: afterE4 });
    }
    if (fen === afterE4.state.fen && mv === "b8c6") {
      return Promise.resolve({ ok: true, value: afterNc6 });
    }
    if (fen === afterNc6.state.fen && mv === "g1f3") {
      return Promise.resolve({ ok: true, value: afterNf3 });
    }
    if (fen === afterNf3.state.fen && mv === "g8f6") {
      return Promise.resolve({ ok: true, value: afterG8f6 });
    }
    return Promise.resolve({ ok: false, error: "invalid-move" });
  },
  bestMove: (fen, depth, legalMoves, aggressive, context) => {
    contextualBestMoveCalls.push({ fen, depth, legalMoves, aggressive, context });
    return Promise.resolve({
      ok: true,
      value:
        contextualBestMoveCalls.length === 1
          ? {
              bestMove: "b8c6",
              depth,
              scoreCp: -12,
              nodes: 20,
              ttHits: 0,
              principalLine: ["b8c6", "g1f3", "g8f6"],
              followedPlan: false,
              plan: {
                version: 1,
                side: "black",
                status: "proposed",
                reason: "new-line",
                line: ["b8c6", "g1f3", "g8f6"],
                expectedReply: "g1f3",
                continuation: "g8f6",
                degraded: false,
                threatModel: {
                  version: 1,
                  side: "black",
                  ownThreat: { kind: "quiet", move: "b8c6", mateIn: null },
                  opponentDanger: { kind: "quiet", move: "g1f3", mateIn: null },
                  followUp: { kind: "king-pressure", move: "g8f6", mateIn: null },
                  risk: "bounded"
                }
              }
            }
          : {
              bestMove: "g8f6",
              depth,
              scoreCp: -8,
              nodes: 24,
              ttHits: 0,
              principalLine: ["g8f6", "b1c3"],
              followedPlan: true,
              plan: {
                version: 1,
                side: "black",
                status: "followed",
                reason: "matched-history-and-gate",
                line: ["g8f6", "b1c3"],
                expectedReply: "b1c3",
                continuation: null,
                degraded: false,
                threatModel: {
                  version: 1,
                  side: "black",
                  ownThreat: { kind: "king-pressure", move: "g8f6", mateIn: null },
                  opponentDanger: { kind: "quiet", move: "b1c3", mateIn: null },
                  followUp: { kind: "none", move: null, mateIn: null },
                  risk: "bounded"
                }
              }
            }
    });
  }
};
await mountPlayUi(contextualRoot, { engine: contextualEngine }).ready;
await element(contextualRoot, `[data-play-ui="aggressive-toggle-button"]`).dispatch("click");
await boardSquare(contextualRoot, "e2").dispatch("click");
await boardSquare(contextualRoot, "e4").dispatch("click");
await waitFor(() => contextualBestMoveCalls.length === 1);
await waitFor(() => elements(contextualRoot, `[data-play-ui="move-row"]`).length === 2);
await boardSquare(contextualRoot, "g1").dispatch("click");
await boardSquare(contextualRoot, "f3").dispatch("click");
await waitFor(() => contextualBestMoveCalls.length === 2);
expectEqual(contextualBestMoveCalls[0], {
  fen: afterE4.state.fen,
  depth: 1,
  legalMoves: afterE4.state.legalMoves,
  aggressive: true,
  context: {
    side: "black",
    userSide: "white",
    historyFens: [startState.fen],
    previousLine: []
  }
});
expectEqual(contextualBestMoveCalls[1], {
  fen: afterNf3.state.fen,
  depth: 1,
  legalMoves: afterNf3.state.legalMoves,
  aggressive: true,
  context: {
    side: "black",
    userSide: "white",
    historyFens: [startState.fen, afterE4.state.fen, afterNc6.state.fen],
    previousLine: ["b8c6", "g1f3", "g8f6"]
  }
});
expectEqual(elements(contextualRoot, `[data-play-ui="aggressive-plan-status"]`).length, 0);
expectEqual(elements(contextualRoot, `[data-play-ui="aggressive-threat-own"]`).length, 0);

const neutralContextRoot = fakeRoot();
const neutralContextCalls: Array<{
  readonly aggressive: boolean | undefined;
  readonly context: {
    readonly side: ColorDto;
    readonly userSide: ColorDto;
    readonly historyFens: readonly string[];
    readonly previousLine: readonly string[];
  } | undefined;
}> = [];
await mountPlayUi(neutralContextRoot, {
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: true, value: afterE4 }),
    bestMove: (_fen, _depth, _legalMoves, aggressive, context) => {
      neutralContextCalls.push({ aggressive, context });
      return Promise.resolve({
        ok: true,
        value: { bestMove: "b8c6", depth: 1, scoreCp: 0, nodes: 1, ttHits: 0 }
      });
    }
  }
}).ready;
await boardSquare(neutralContextRoot, "e2").dispatch("click");
await boardSquare(neutralContextRoot, "e4").dispatch("click");
await waitFor(() => neutralContextCalls.length === 1);
expectEqual(neutralContextCalls[0], {
  aggressive: false,
  context: {
    side: "black",
    userSide: "white",
    historyFens: [startState.fen],
    previousLine: []
  }
});

const spectatorRoot = fakeRoot();
const spectatorEngineCalls: string[] = [];
const spectatorAnalysisCalls: string[] = [];
await mountPlayUi(spectatorRoot, {
  spectatorLens: true,
  engine: {
    newGame: () => {
      spectatorEngineCalls.push("newGame");
      return Promise.resolve({ ok: true, value: startState });
    },
    makeMove: (_fen, mv) => {
      spectatorEngineCalls.push(`makeMove:${mv}`);
      return Promise.resolve(
        mv === "e2e4" ? { ok: true, value: afterE4 } : { ok: true, value: afterNc6 }
      );
    },
    bestMove: (_fen, depth) => {
      spectatorEngineCalls.push(`bestMove:${String(depth)}`);
      return Promise.resolve({ ok: false, error: "search-failed" });
    }
  },
  analysisEngine: {
    bestMove: (fen, depth, legalMoves) => {
      spectatorAnalysisCalls.push(
        `analysis:${fen}:${String(depth)}:${legalMoves?.join(",") ?? "none"}`
      );
      const bestMove =
        fen === startState.fen ? "e2e4" : fen === afterE4.state.fen ? "b8c6" : "g1f3";
      return Promise.resolve({
        ok: true,
        value: { bestMove, depth, scoreCp: bestMove === "b8c6" ? -12 : 16, nodes: 30, ttHits: 0 }
      });
    }
  }
}).ready;
expectEqual(element(spectatorRoot, `[data-play-ui="root"]`).getAttribute("data-play-mode"), "spectator-lens");
expectStatus(spectatorRoot, "White to move", "player", "white");
expectEqual(element(spectatorRoot, `[data-play-ui="player-side"]`).textContent, "Viewwhite");
expectEqual(elements(spectatorRoot, `[data-play-ui="analysis-lens"]`).length, 1);
expectEqual(element(spectatorRoot, `[data-play-ui="lens-mode"]`).textContent, "ModeSpectator");
expectEqual(element(spectatorRoot, `[data-play-ui="lens-input"]`).textContent, "InputBoth sides");
await waitFor(() => element(spectatorRoot, `[data-play-ui="lens-best-move"]`).textContent === "Best movee2e4");
expectEqual(element(spectatorRoot, `[data-play-ui="lens-score"]`).textContent, "Score+16 cp");
expectEqual(element(spectatorRoot, `[data-play-ui="lens-depth"]`).textContent, "Depth1");
expectEqual(element(spectatorRoot, `[data-play-ui="lens-nodes"]`).textContent, "Nodes30");
expectEqual(spectatorEngineCalls, ["newGame"]);
expectEqual(spectatorAnalysisCalls, [`analysis:${startState.fen}:1:e2e3,e2e4`]);
await boardSquare(spectatorRoot, "e2").dispatch("click");
expectSelection(spectatorRoot, "e2", "2 legal destinations", "e3, e4");
await boardSquare(spectatorRoot, "e4").dispatch("click");
await waitFor(() => element(spectatorRoot, `[data-play-ui="lens-best-move"]`).textContent === "Best moveb8c6");
expectStatus(spectatorRoot, "Black to move", "player", "black");
expectEqual(elements(spectatorRoot, `[data-play-ui="move-row"]`).length, 1);
expectEqual(boardSquare(spectatorRoot, "b8").getAttribute("data-board-draggable"), "true");
expectEqual(boardSquare(spectatorRoot, "g1").getAttribute("data-board-draggable"), "false");
await boardSquare(spectatorRoot, "b8").dispatch("click");
expectSelection(spectatorRoot, "b8", "1 legal destination", "c6");
await boardSquare(spectatorRoot, "c6").dispatch("click");
await waitFor(() => element(spectatorRoot, `[data-play-ui="lens-best-move"]`).textContent === "Best moveg1f3");
expectStatus(spectatorRoot, "White to move", "player", "white");
expectEqual(elements(spectatorRoot, `[data-play-ui="move-row"]`).length, 2);
expectEqual(spectatorEngineCalls, ["newGame", "makeMove:e2e4", "makeMove:b8c6"]);
expectEqual(spectatorAnalysisCalls, [
  `analysis:${startState.fen}:1:e2e3,e2e4`,
  `analysis:${afterE4.state.fen}:1:b8c6`,
  `analysis:${afterNc6.state.fen}:1:g1f3,d2d4`
]);

const blackArchiveStorage = evidenceMemoryStorage();
const blackArchiveRoot = fakeRoot();
const blackArchiveAutomaticEvents: unknown[] = [];
await mountPlayUi(blackArchiveRoot, {
  reactionLens: true,
  evidenceStorage: blackArchiveStorage,
  automaticEvidence: {
    buildSha: "archive-build-sha",
    sink: (event) => {
      blackArchiveAutomaticEvents.push(event);
      return Promise.resolve(true);
    }
  },
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: (_fen, mv) =>
      Promise.resolve(mv === "e2e4" ? { ok: true, value: afterE4 } : { ok: true, value: afterNc6 }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: (fen, depth) => {
      const bestMove =
        fen === startState.fen ? "e2e4" : fen === afterE4.state.fen ? "b8c6" : "g1f3";
      return Promise.resolve({
        ok: true,
        value: { bestMove, depth, scoreCp: 0, nodes: 1, ttHits: 0 }
      });
    },
    sideExplore: (fen, side) => {
      const state = fen === afterE4.state.fen ? afterE4.state : startState;
      const move = fen === afterE4.state.fen ? "b8c6" : side === "black" ? "g8f6" : "e2e4";
      return Promise.resolve({
        ok: true,
        value: {
          state,
          side,
          onTurn: state.fen.split(" ")[1] === (side === "white" ? "w" : "b"),
          replyCandidates: state.fen === startState.fen && side === "black"
            ? [{ move: "e2e4", kind: "defense", quality: "best", sound: true, sacrifice: false, mateIn: null }]
            : [],
          candidates: [
            {
              move,
              kind: "defense",
              exactScoreCp: 12,
              sound: true,
              sacrifice: false,
              prospectiveBrilliant: false,
              mateIn: null,
              aftermath: null,
              continuation: null
            }
          ],
          principalLine: [move],
          mateDetected: false,
          depth: 1,
          nodes: 1,
          soundMarginCp: 50
        }
      });
    }
  }
}).ready;
await playerSideButton(blackArchiveRoot, "black").dispatch("click");
await waitFor(() =>
  blackArchiveAutomaticEvents.some(
    (event) =>
      (event as { readonly type?: string; readonly fenBefore?: string }).type === "recommendation" &&
      (event as { readonly fenBefore?: string }).fenBefore === startState.fen
  )
);
await boardSquare(blackArchiveRoot, "e2").dispatch("click");
await boardSquare(blackArchiveRoot, "e4").dispatch("click");
await waitFor(() => elements(blackArchiveRoot, `[data-play-ui="move-row"]`).length === 1);
await element(blackArchiveRoot, `[data-play-ui="aggressive-toggle-button"]`).dispatch("click");
await engineDepthButton(blackArchiveRoot, 3).dispatch("click");
await boardSquare(blackArchiveRoot, "b8").dispatch("click");
await boardSquare(blackArchiveRoot, "c6").dispatch("click");
await waitFor(() => elements(blackArchiveRoot, `[data-play-ui="move-row"]`).length === 2);
await element(blackArchiveRoot, `[data-play-ui="archive-save-button"]`).dispatch("click");
const blackArchive = storedGameArchive(blackArchiveStorage)[0] as {
  readonly engineBuildSha?: string;
  readonly selectedSide?: string;
  readonly moves?: readonly {
    readonly coordinate?: string;
    readonly buildSha?: string;
    readonly engineDepth?: number;
    readonly aggressive?: boolean;
    readonly attribution?: {
      readonly buildSha?: string;
      readonly engineDepth?: number;
      readonly aggressive?: boolean;
    };
    readonly role?: string;
    readonly side?: string;
    readonly recommendationBeforeMove?: {
      readonly buildSha?: string;
      readonly primaryMove?: string | null;
      readonly candidates?: readonly { readonly move?: string; readonly exactScoreCp?: number }[];
      readonly principalLineFirst?: string | null;
      readonly replyCandidateFirst?: string | null;
    } | null;
  }[];
};
expectEqual(
  blackArchiveAutomaticEvents.some((event) => (event as { readonly type?: string }).type === "recommendation"),
  true
);
expectEqual(blackArchive.engineBuildSha, "archive-build-sha");
expectEqual(blackArchive.selectedSide, "black");
expectEqual(blackArchive.moves?.[0]?.coordinate, "e2e4");
expectEqual(blackArchive.moves?.[0]?.side, "white");
// Role is always the selected-side perspective. Actor remains separate because
// reaction-lens records player clicks for either side.
expectEqual(blackArchive.moves?.[0]?.role, "rival");
expectEqual(blackArchive.moves?.[0]?.buildSha, "archive-build-sha");
expectEqual(blackArchive.moves?.[0]?.engineDepth, 1);
expectEqual(blackArchive.moves?.[0]?.aggressive, false);
expectEqual(blackArchive.moves?.[0]?.attribution?.engineDepth, 1);
expectEqual(blackArchive.moves?.[0]?.attribution?.aggressive, false);
expectEqual(blackArchive.moves?.[0]?.recommendationBeforeMove?.buildSha, "archive-build-sha");
expectEqual(blackArchive.moves?.[0]?.recommendationBeforeMove?.primaryMove, "g8f6");
expectEqual(blackArchive.moves?.[0]?.recommendationBeforeMove?.replyCandidateFirst, "e2e4");
expectEqual(blackArchive.moves?.[1]?.coordinate, "b8c6");
expectEqual(blackArchive.moves?.[1]?.side, "black");
expectEqual(blackArchive.moves?.[1]?.role, "user");
expectEqual(blackArchive.moves?.[1]?.engineDepth, 3);
expectEqual(blackArchive.moves?.[1]?.aggressive, true);
expectEqual(blackArchive.moves?.[1]?.attribution?.engineDepth, 3);
expectEqual(blackArchive.moves?.[1]?.attribution?.aggressive, true);
expectEqual(
  element(blackArchiveRoot, `[data-play-ui="archive-status-text"]`).textContent,
  "Saved"
);

const diskArchiveStorage = evidenceMemoryStorage();
const diskArchiveRoot = fakeRoot();
await mountPlayUi(diskArchiveRoot, {
  evidenceStorage: diskArchiveStorage,
  engine,
  gameArchiveSink: () => Promise.resolve(true)
}).ready;
await boardSquare(diskArchiveRoot, "e2").dispatch("click");
await boardSquare(diskArchiveRoot, "e4").dispatch("click");
await waitFor(() => elements(diskArchiveRoot, `[data-play-ui="move-row"]`).length === 2);
await element(diskArchiveRoot, `[data-play-ui="archive-save-button"]`).dispatch("click");
await waitFor(
  () => element(diskArchiveRoot, `[data-play-ui="archive-status-text"]`).textContent === "Saved"
);

const staleLensRoot = fakeRoot();
const staleLensResults: DeferredResult<BestMoveDto>[] = [];
await mountPlayUi(staleLensRoot, {
  spectatorLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: true, value: afterE4 }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => {
      const next = deferred<BestMoveDto>();
      staleLensResults.push(next);
      return next.promise;
    }
  }
}).ready;
await waitFor(() => staleLensResults.length === 1);
await element(staleLensRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
await waitFor(() => staleLensResults.length === 2);
staleLensResults[0]?.resolve({
  ok: true,
  value: { bestMove: "a2a3", depth: 1, scoreCp: 99, nodes: 1, ttHits: 0 }
});
await new Promise((resolve) => {
  setTimeout(resolve, 0);
});
expectEqual(element(staleLensRoot, `[data-play-ui="lens-best-move"]`).textContent, "Best movesearching");
staleLensResults[1]?.resolve({
  ok: true,
  value: { bestMove: "e2e4", depth: 1, scoreCp: 1, nodes: 2, ttHits: 0 }
});
await waitFor(() => element(staleLensRoot, `[data-play-ui="lens-best-move"]`).textContent === "Best movee2e4");
expectStatus(staleLensRoot, "White to move", "player", "white");

// Reaction map (ADR-0143) ----------------------------------------------------
const reactionRoot = fakeRoot();
const reactionEngineCalls: string[] = [];
const sideExploreAnalysisCalls: string[] = [];
const sideExploreMaps: Record<string, SideExploreDto> = {
  [`${startState.fen}:white:false`]: {
    state: startState,
    side: "white",
    onTurn: true,
    replyCandidates: [],
    candidates: [
      { move: "e2e4", kind: "capture", exactScoreCp: 16, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null },
      { move: "e2e3", kind: "capture", exactScoreCp: 8, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }
    ],
    principalLine: ["e2e4", "b8c6"],
    mateDetected: false,
    depth: 1,
    nodes: 30,
    soundMarginCp: 50
  },
  [`${startState.fen}:white:true`]: {
    state: startState,
    side: "white",
    onTurn: true,
    replyCandidates: [],
    candidates: [
      {
        move: "g1f3",
        kind: "defense",
        exactScoreCp: 68,
        sound: true,
        sacrifice: false,
        prospectiveBrilliant: false,
        mateIn: null,
        aftermath: null,
        continuation: null,
        opening: { eco: "A05", name: "Zukertort Opening" }
      },
      { move: "h2h4", kind: "capture", exactScoreCp: -340, sound: false, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }
    ],
    openingStatus: { status: "available", eco: "A05", name: "Zukertort Opening", move: "g1f3" },
    principalLine: ["g1f3", "g8f6", "b1c3"],
    mateDetected: false,
    depth: 1,
    nodes: 36,
    soundMarginCp: 50
  },
  [`${startState.fen}:black:false`]: {
    state: startState,
    side: "black",
    onTurn: false,
    replyCandidates: [
      { move: "e2e4", kind: "defense", quality: "best", sound: true, sacrifice: false, mateIn: null },
      { move: "d2d4", kind: "defense", quality: "excellent", sound: true, sacrifice: false, mateIn: null },
      { move: "g1f3", kind: "defense", quality: "blunder", sound: false, sacrifice: false, mateIn: null }
    ],
    candidates: [
      { move: "g8f6", kind: "defense", exactScoreCp: 12, sound: true, sacrifice: true, prospectiveBrilliant: true, mateIn: null, aftermath: "defended", continuation: "b8c6" }
    ],
    principalLine: ["g8f6", "b1c3"],
    mateDetected: false,
    depth: 1,
    nodes: 30,
    soundMarginCp: 50
  },
  [`${afterE4.state.fen}:white:false`]: {
    state: afterE4.state,
    side: "white",
    onTurn: false,
    replyCandidates: [
      { move: "b8c6", kind: "defense", quality: "best", sound: true, sacrifice: false, mateIn: null }
    ],
    candidates: [{ move: "g1f3", kind: "defense", exactScoreCp: 18, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }],
    principalLine: ["g1f3"],
    mateDetected: false,
    depth: 1,
    nodes: 18,
    soundMarginCp: 50,
    planStatus: "replaced",
    planReason: "live-board-recomputed"
  }
};
const reactionProvider: { readonly calls: string[] } = { calls: [] };
await mountPlayUi(reactionRoot, {
  reactionLens: true,
  engine: {
    newGame: () => {
      reactionEngineCalls.push("newGame");
      return Promise.resolve({ ok: true, value: startState });
    },
    makeMove: (_fen, mv) => {
      reactionEngineCalls.push(`makeMove:${mv}`);
      return Promise.resolve(
        mv === "e2e4" ? { ok: true, value: afterE4 } : { ok: true, value: afterNc6 }
      );
    },
    bestMove: (_fen, depth) => {
      reactionEngineCalls.push(`bestMove:${String(depth)}`);
      return Promise.resolve({ ok: false, error: "search-failed" });
    }
  },
  analysisEngine: {
    bestMove: () => {
      reactionProvider.calls.push("analysis-bestMove");
      return Promise.resolve({ ok: false, error: "search-failed" });
    },
    sideExplore: (fen, side, aggressive) => {
      sideExploreAnalysisCalls.push(`sideExplore:${fen}:${side}:${String(aggressive)}`);
      const map = sideExploreMaps[`${fen}:${side}:${String(aggressive)}`];
      return Promise.resolve(
        map === undefined ? { ok: false, error: "search-failed" } : { ok: true, value: map }
      );
    }
  }
}).ready;
expectEqual(element(reactionRoot, `[data-play-ui="root"]`).getAttribute("data-play-mode"), "reaction-lens");
expectEqual(elements(reactionRoot, `[data-play-ui="analysis-lens"]`).length, 0);
expectEqual(elements(reactionRoot, `[data-play-ui="reaction-lens"]`).length, 1);
// Top bar: side and Aggressive stay visible; depth, modes and language live in the "⋯" menu.
expectEqual(elements(reactionRoot, `[data-play-ui="header-actions"] [data-play-ui="player-side-control"]`).length, 1);
expectEqual(elements(reactionRoot, `[data-play-ui="header-actions"] [data-play-ui="aggressive-toggle-button"]`).length, 1);
expectEqual(elements(reactionRoot, `[data-play-ui="more-menu"] [data-play-ui="engine-depth-control"]`).length, 1);
expectEqual(elements(reactionRoot, `[data-play-ui="more-menu"] [data-play-ui="play-mode-control"]`).length, 1);
expectEqual(reactionRoot.html().includes(`<details data-play-ui="more-menu"`), true);
expectEqual(elements(reactionRoot, `[data-play-ui="board-actions"] [data-play-ui="new-game-button"]`).length, 1);
expectEqual(elements(reactionRoot, `[data-play-ui="eval-bar"]`).length, 1);
// Explore opens in the responsive lane; Deep remains an explicit opt-in surface.
expectEqual(reactionDepthButton(reactionRoot, "fast").getAttribute("aria-pressed"), "true");
expectEqual(reactionDepthButton(reactionRoot, "deep").getAttribute("aria-pressed"), "false");
for (const signal of ["main", "alternative", "sacrifice", "mate", "caution", "hanging"] as const) {
  expectEqual(reactionRoot.html().includes(`data-path-signal="${signal}"`), true);
}
expectEqual(element(reactionRoot, `[data-play-ui="reaction-mode"]`).textContent, "ModeBest line for White");
expectEqual(element(reactionRoot, `[data-play-ui="reaction-input"]`).textContent, "SideWhite");
expectEqual(element(reactionRoot, `[data-play-ui="player-side"]`).textContent, "Viewwhite");
await waitFor(
  () => element(reactionRoot, `[data-play-ui="reaction-best"]`).textContent === "Best ideae2 → e4"
);
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-lens"]`).getAttribute("data-reaction-state"),
  "rich"
);
expectEqual(element(reactionRoot, `[data-play-ui="reaction-score"]`).textContent, "Exact score+16 cp");
expectEqual(elements(reactionRoot, `[data-play-ui="prospective-brilliant"]`).length, 0);
await playerSideButton(reactionRoot, "black").dispatch("click");
await waitFor(
  () =>
    element(reactionRoot, `[data-play-ui="reaction-mode"]`).textContent ===
    "ModeProjected line for Black after e2 → e4"
);
expectEqual(element(reactionRoot, `[data-play-ui="reaction-input"]`).textContent, "SideBlack");
expectEqual(element(reactionRoot, `[data-play-ui="reaction-score"]`).textContent, "Projected score+12 cp");
// Off-turn stays selected-side based: the opponent reply is separate, the selected-side plan is
// labeled as a projection after that reply, and no threat surface/data/text is emitted.
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-lens"]`).getAttribute("data-reaction-surface"),
  null
);
expectEqual(element(reactionRoot, `[data-play-ui="reaction-best"]`).textContent, "Projected ideaAfter e2 → e4: g8 → f6");
expectEqual(element(reactionRoot, `[data-play-ui="reaction-side-follow-up"]`).textContent, "Black · Projectedg8 → f6");
expectEqual(element(reactionRoot, `[data-play-ui="reaction-plan"]`).textContent, "Planlive board");
expectEqual(element(reactionRoot, `[data-play-ui="reaction-result-source"]`).textContent, "ResultRich result");
expectEqual(elements(reactionRoot, `[data-play-ui="prospective-brilliant"]`).length, 0);
expectEqual(elements(reactionRoot, `[data-play-ui="reaction-threat-note"]`).length, 0);
expectEqual(reactionRoot.html().includes(`data-path-signal="reply"`), true);
expectEqual(
  reactionRoot
    .html()
    .includes(`data-play-ui="reply-arrows" viewBox="0 0 8 8" preserveAspectRatio="none"`),
  true
);
// The top projected reply (e2e4) leads the reaction line as the classified rival primary; the
// remaining sound reply (d2d4) stays as a classified secondary reply arrow. The unsound g1f3 reply
// is present in the engine payload but not drawn.
expectEqual(reactionRoot.html().includes(`data-reply-from="e2" data-reply-to="e4"`), false);
expectEqual(
  reactionRoot.html().includes(`data-reaction-from="e2" data-reaction-to="e4"`) &&
    reactionRoot.html().includes(`data-reaction-rival="true"`) &&
    reactionRoot.html().includes(`data-reaction-safety="safe"`) &&
    reactionRoot.html().includes(`data-reaction-quality="best"`),
  true
);
expectEqual(reactionRoot.html().includes(`data-reply-from="d2" data-reply-to="d4"`), true);
expectEqual(reactionRoot.html().includes(`data-reply-safety="safe"`), true);
expectEqual(reactionRoot.html().includes(`data-reply-quality="excellent"`), true);
expectEqual(reactionRoot.html().includes(`data-reply-from="g1" data-reply-to="f3"`), false);
expectEqual(reactionRoot.html().includes(`data-path-role="reply"`), true);
const blackOffTurnRivalArrowCount =
  elements(reactionRoot, `[data-play-ui="reply-arrow"]`).length +
  (reactionRoot.html().match(/data-reaction-rival="true"/gu)?.length ?? 0);
expectEqual(blackOffTurnRivalArrowCount, 2);
expectEqual(reactionRoot.html().includes(`data-path-signal="threat"`), false);
expectEqual(reactionRoot.html().includes(`data-reaction-threat="true"`), false);
expectEqual(reactionRoot.html().includes(`data-candidate-threat="true"`), false);
expectEqual(element(reactionRoot, `[data-play-ui="reaction-lens"]`).textContent.includes("threat"), false);
await playerSideButton(reactionRoot, "white").dispatch("click");
await waitFor(
  () => element(reactionRoot, `[data-play-ui="reaction-mode"]`).textContent === "ModeBest line for White"
);
// Back on turn: reply-specific UI disappears.
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-lens"]`).getAttribute("data-reaction-surface"),
  null
);
expectEqual(elements(reactionRoot, `[data-play-ui="reaction-threat-note"]`).length, 0);
expectEqual(reactionRoot.html().includes(`data-path-signal="reply"`), false);
expectEqual(reactionRoot.html().includes(`data-play-ui="reply-arrow"`), false);
await waitFor(
  () => element(reactionRoot, `[data-play-ui="reaction-score"]`).textContent === "Exact score+16 cp"
);
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-candidate-count"]`).textContent,
  "Candidates2"
);
expectEqual(
  element(reactionRoot, `[data-play-ui="aggressive-toggle-button"]`).getAttribute("aria-pressed"),
  "false"
);
await element(reactionRoot, `[data-play-ui="aggressive-toggle-button"]`).dispatch("click");
await waitFor(
  () => element(reactionRoot, `[data-play-ui="reaction-best"]`).textContent === "Best ideag1 → f3"
);
expectEqual(
  element(reactionRoot, `[data-play-ui="aggressive-toggle-button"]`).getAttribute("aria-pressed"),
  "true"
);
expectEqual(element(reactionRoot, `[data-play-ui="reaction-score"]`).textContent, "Exact score+68 cp");
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-mode"]`).textContent,
  "ModeAggressive line for White"
);
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-objective"]`).textContent,
  "ObjectiveBest move first · aggressive tie-break"
);
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-rival-best"]`).textContent,
  "Rival variantIndependent · g8 → f6"
);
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-side-follow-up"]`).textContent,
  "White · Nextb1 → c3"
);
expectEqual(
  reactionRoot
    .html()
    .includes(
      `data-reaction-from="g1" data-reaction-to="f3" data-reaction-order="1" data-reaction-primary="true" data-reaction-hanging="false" data-reaction-mating="false" data-reaction-rival="false" data-path-role="main" data-path-risk="clear" data-reaction-sequence="lead" data-reaction-opening="true"`
    ),
  true
);
expectEqual(element(reactionRoot, `[data-play-ui="reaction-opening"]`).textContent, "OpeningZukertort Opening · g1 → f3");
expectEqual(element(reactionRoot, `[data-play-ui="opening-line"]`).textContent, "Zukertort Openingg1 → f3");
expectEqual(element(reactionRoot, `[data-play-ui="opening-line"]`).getAttribute("data-opening-move"), "g1f3");
expectEqual(reactionRoot.html().includes(`data-play-ui="opening-marker"`), true);
expectEqual(
  reactionRoot
    .html()
    .includes(
      `data-reaction-from="g8" data-reaction-to="f6" data-reaction-order="2" data-reaction-primary="false"`
    ) && reactionRoot.html().includes(`data-reaction-sequence="continuation"`),
  true
);
expectEqual(
  reactionRoot
    .html()
    .includes(
      `data-candidate-from="h2" data-candidate-to="h4" data-candidate-rank="2" data-candidate-safety="hanging" data-path-role="diagnostic" data-path-risk="hanging" data-candidate-risk-rank="2" data-candidate-risk-label="avoid"`
    ),
  true
);
await element(reactionRoot, `[data-play-ui="aggressive-toggle-button"]`).dispatch("click");
await waitFor(
  () => element(reactionRoot, `[data-play-ui="reaction-best"]`).textContent === "Best ideae2 → e4"
);
expectEqual(
  element(reactionRoot, `[data-play-ui="aggressive-toggle-button"]`).getAttribute("aria-pressed"),
  "false"
);
expectEqual(element(reactionRoot, `[data-play-ui="reaction-mate"]`).textContent, "MateNone");
expectEqual(element(reactionRoot, `[data-play-ui="reaction-opening"]`).textContent, "OpeningUnavailable");
expectEqual(elements(reactionRoot, `[data-play-ui="opening-line"]`).length, 0);
expectEqual(reactionRoot.html().includes(`data-reaction-opening="true"`), false);
expectEqual(elements(reactionRoot, `[data-play-ui="reaction-arrows"]`).length, 1);
expectEqual(
  reactionRoot
    .html()
    .includes(
      `data-reaction-from="e2" data-reaction-to="e4" data-reaction-order="1" data-reaction-primary="true" data-reaction-hanging="false" data-reaction-mating="false" data-reaction-rival="false" data-path-role="main" data-path-risk="clear" data-reaction-sequence="lead"`
    ),
  true
);
// sideExplore candidates carry exact scores — alternatives are drawn even in deep mode.
expectEqual(
  reactionRoot
    .html()
    .includes(
      `data-candidate-to="e3" data-candidate-rank="2" data-candidate-safety="safe" data-path-role="alternative" data-path-risk="safe"`
    ),
  true
);
// Alternative arrows have no move-quality badge (sideExplore does not carry quality).
expectEqual(reactionRoot.html().includes(`data-candidate-quality="best"`), false);
expectEqual(
  reactionRoot.html().includes(`<text data-play-ui="candidate-quality"`),
  false
);
expectEqual(reactionEngineCalls, ["newGame"]);
expectEqual(sideExploreAnalysisCalls, [
  `sideExplore:${startState.fen}:white:false`,
  `sideExplore:${startState.fen}:black:false`,
  `sideExplore:${startState.fen}:white:false`,
  `sideExplore:${startState.fen}:white:true`,
  `sideExplore:${startState.fen}:white:false`
]);
await boardSquare(reactionRoot, "e2").dispatch("click");
await boardSquare(reactionRoot, "e4").dispatch("click");
// After the host's own move it is Black's turn, so the board leads with Black's assumed reply as the
// strong (neutral) primary arrow and trails White's own plan as the faded continuation — White's move
// is never painted or labeled as if it were played immediately. The side panel names White's
// projected plan and reports that the live board replaced the old projection.
await waitFor(
  () => element(reactionRoot, `[data-play-ui="reaction-best"]`).textContent === "Projected ideaAfter b8 → c6: g1 → f3"
);
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-objective"]`).textContent,
  "ObjectiveRival reply first · White projected response"
);
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-rival-best"]`).textContent,
  "Rival bestIndependent · b8 → c6"
);
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-mode"]`).textContent,
  "ModeProjected line for White after b8 → c6"
);
expectEqual(element(reactionRoot, `[data-play-ui="reaction-score"]`).textContent, "Projected score+18 cp");
expectEqual(element(reactionRoot, `[data-play-ui="reaction-plan"]`).textContent, "PlanReplaced · live board recomputed");
expectEqual(element(reactionRoot, `[data-play-ui="reaction-result-source"]`).textContent, "ResultRich result");
expectEqual(
  element(reactionRoot, `[data-play-ui="reaction-lens"]`).getAttribute("data-reaction-surface"),
  null
);
expectEqual(elements(reactionRoot, `[data-play-ui="reaction-threat-note"]`).length, 0);
// The opponent reply now leads the reaction line as the classified rival primary, not a secondary
// reply arrow.
expectEqual(reactionRoot.html().includes(`data-reply-from="b8" data-reply-to="c6"`), false);
expectEqual(
  reactionRoot
    .html()
    .includes(`data-reaction-from="b8" data-reaction-to="c6"`) &&
    reactionRoot.html().includes(`data-reaction-rival="true"`) &&
    reactionRoot.html().includes(`data-reaction-safety="safe"`) &&
    reactionRoot.html().includes(`data-reaction-quality="best"`),
  true
);
// The single projected reply became the primary, so no secondary reply arrows remain.
expectEqual(elements(reactionRoot, `[data-play-ui="reply-arrow"]`).length, 0);
// White's own plan (g1f3) trails as a faded, non-primary continuation (order 2), never the primary.
expectEqual(
  reactionRoot
    .html()
    .includes(
      `data-reaction-from="g1" data-reaction-to="f3" data-reaction-order="2" data-reaction-primary="false"`
    ),
  true
);
expectEqual(reactionRoot.html().includes(`data-reaction-threat="true"`), false);
expectEqual(reactionRoot.html().includes(`data-candidate-threat="true"`), false);
expectStatus(reactionRoot, "Black to move", "player", "black");
expectEqual(reactionEngineCalls, ["newGame", "makeMove:e2e4"]);
expectEqual(sideExploreAnalysisCalls, [
  `sideExplore:${startState.fen}:white:false`,
  `sideExplore:${startState.fen}:black:false`,
  `sideExplore:${startState.fen}:white:false`,
  `sideExplore:${startState.fen}:white:true`,
  `sideExplore:${startState.fen}:white:false`,
  `sideExplore:${afterE4.state.fen}:white:false`
]);
expectEqual(reactionProvider.calls, [
  "analysis-bestMove",
  "analysis-bestMove",
  "analysis-bestMove",
  "analysis-bestMove"
]);

const reactionBlackInputRoot = fakeRoot();
const reactionBlackInputCalls: string[] = [];
const reactionBlackExploreCalls: string[] = [];
await mountPlayUi(reactionBlackInputRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: afterE4.state }),
    makeMove: (fen, mv) => {
      reactionBlackInputCalls.push(`makeMove:${fen}:${mv}`);
      return mv === "b8c6"
        ? Promise.resolve({ ok: true, value: afterNc6 })
        : Promise.resolve({ ok: false, error: "invalid-move" });
    },
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: (fen, side, aggressive) => {
      reactionBlackExploreCalls.push(`sideExplore:${fen}:${side}:${String(aggressive)}`);
      return Promise.resolve({
        ok: true,
        value: {
          state: afterE4.state,
          side: "black",
          onTurn: true,
          replyCandidates: [],
          candidates: [
            { move: "b8c6", kind: "defense", exactScoreCp: 12, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }
          ],
          principalLine: ["b8c6", "g1f3"],
          mateDetected: false,
          depth: 1,
          nodes: 21,
          soundMarginCp: 50
        }
      });
    }
  }
}).ready;
await playerSideButton(reactionBlackInputRoot, "black").dispatch("click");
await element(reactionBlackInputRoot, `[data-play-ui="aggressive-toggle-button"]`).dispatch("click");
await reactionDepthButton(reactionBlackInputRoot, "fast").dispatch("click");
await waitFor(
  () => element(reactionBlackInputRoot, `[data-play-ui="reaction-best"]`).textContent === "Best ideab8 → c6"
);
expectEqual(
  element(reactionBlackInputRoot, `[data-play-ui="board"]`).getAttribute("data-board-orientation"),
  "black"
);
expectEqual(boardSquareOrder(reactionBlackInputRoot).at(0), "h1");
expectEqual(boardSquareOrder(reactionBlackInputRoot).at(-1), "a8");
expectEqual(boardSquare(reactionBlackInputRoot, "b8").getAttribute("data-board-draggable"), "true");
expectEqual(boardSquare(reactionBlackInputRoot, "e2").getAttribute("data-board-draggable"), "false");
await boardSquare(reactionBlackInputRoot, "b8").dispatch("click");
expectSelection(reactionBlackInputRoot, "b8", "1 legal destination", "c6");
await boardSquare(reactionBlackInputRoot, "c6").dispatch("click");
await waitFor(() => elements(reactionBlackInputRoot, `[data-play-ui="move-row"]`).length === 1);
expectEqual(reactionBlackInputCalls, [`makeMove:${afterE4.state.fen}:b8c6`]);
expectEqual(
  reactionBlackExploreCalls.includes(`sideExplore:${afterE4.state.fen}:black:true`),
  true
);

const sideExploreBudgetRoot = fakeRoot();
const sideExploreBudgetCalls: readonly unknown[][] = [];
await mountPlayUi(sideExploreBudgetRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: true, value: afterE4 }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: (...args: unknown[]) => {
      (sideExploreBudgetCalls as unknown[][]).push(args);
      const map = sideExploreMaps[`${startState.fen}:white:false`];
      if (map === undefined) {
        throw new Error("missing sideExplore fixture");
      }
      return Promise.resolve({
        ok: true,
        value: { ...map, principalLine: ["e2e4", "b8c6", "g1f3"] }
      });
    }
  }
}).ready;
await waitFor(() => sideExploreBudgetCalls.length === 1);
await waitFor(
  () =>
    element(sideExploreBudgetRoot, `[data-play-ui="reaction-best"]`).textContent ===
    "Best ideae2 → e4"
);
expectEqual((sideExploreBudgetCalls[0]?.[4] as { readonly mode?: string } | undefined)?.mode, "fast");
await reactionDepthButton(sideExploreBudgetRoot, "deep").dispatch("click");
await waitFor(() => sideExploreBudgetCalls.length === 2);
expectEqual((sideExploreBudgetCalls[1]?.[4] as { readonly mode?: string } | undefined)?.mode, "deep");
expectEqual(
  (sideExploreBudgetCalls[1]?.[4] as { readonly previousLine?: readonly string[] } | undefined)
    ?.previousLine,
  ["e2e4", "b8c6", "g1f3"]
);

const sideExploreFallbackRoot = fakeRoot();
const sideExploreFallbackRich = deferred<SideExploreDto>();
const sideExploreFallbackEvidence: unknown[] = [];

await mountPlayUi(sideExploreFallbackRoot, {
  reactionLens: true,
  motion: { sideExploreFastDeadlineMs: 0 },
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: true, value: afterE4 }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: (fen, depth, legalMoves) => {
      expectEqual(fen, startState.fen);
      expectEqual(depth, 1);
      expectEqual(legalMoves, startState.legalMoves);
      return Promise.resolve({
        ok: true,
        value: {
          bestMove: "e2e4",
          depth: 1,
          scoreCp: 4,
          nodes: 3,
          ttHits: 0,
          principalLine: ["e2e4"]
        }
      });
    },
    sideExplore: () => sideExploreFallbackRich.promise
  },
  automaticEvidence: {
    buildSha: "play-ui-test",
    sessionId: "side-explore-fallback-test",
    sink: (event) => {
      sideExploreFallbackEvidence.push(event);
      return Promise.resolve(true);
    }
  }
}).ready;
await waitFor(
  () =>
    element(sideExploreFallbackRoot, `[data-play-ui="reaction-best"]`).textContent ===
    "Provisional movee2 → e4"
);
expectEqual(
  element(sideExploreFallbackRoot, `[data-play-ui="reaction-lens"]`).getAttribute("data-reaction-state"),
  "provisional"
);
expectEqual(
  element(sideExploreFallbackRoot, `[data-play-ui="reaction-plan"]`).textContent,
  "Planprovisional · uncertified"
);
expectEqual(
  element(sideExploreFallbackRoot, `[data-play-ui="reaction-result-source"]`).textContent,
  "Resultprovisional · uncertified"
);
expectEqual(
  element(sideExploreFallbackRoot, `[data-play-ui="reaction-stage"]`).textContent,
  "StageFallback depth 1 · rich search running"
);
expectEqual(
  element(sideExploreFallbackRoot, `[data-play-ui="reaction-depth"]`).textContent,
  "Completed depth1"
);
await waitFor(() => sideExploreFallbackEvidence.length === 1);
expectEqual(
  element(sideExploreFallbackRoot, `[data-play-ui="reaction-score"]`).textContent,
  "StatusProvisional"
);
const fallbackEvidence = sideExploreFallbackEvidence[0] as {
  readonly schema?: unknown;
  readonly type?: unknown;
  readonly exploreMode?: unknown;
  readonly nodeBudget?: unknown;
  readonly primaryRenderState?: unknown;
};
expectEqual(fallbackEvidence.schema, 2);
expectEqual(fallbackEvidence.type, "recommendation");
expectEqual(fallbackEvidence.exploreMode, "fallback");
expectEqual(fallbackEvidence.nodeBudget, 60_000);
expectEqual(fallbackEvidence.primaryRenderState, "alt-risk");
const sideExploreFallbackRichMap = sideExploreMaps[`${startState.fen}:white:true`];
if (sideExploreFallbackRichMap === undefined) {
  throw new Error("missing rich sideExplore fallback fixture");
}
sideExploreFallbackRich.resolve({
  ok: true,
  value: {
    ...sideExploreFallbackRichMap,
    candidates: [
      {
        move: "g1f3",
        kind: "defense",
        exactScoreCp: 68,
        sound: true,
        sacrifice: false,
        prospectiveBrilliant: false,
        mateIn: null,
        aftermath: null,
        continuation: null
      }
    ],
    principalLine: ["g1f3", "g8f6", "b1c3"]
  }
});
await waitFor(
  () =>
    element(sideExploreFallbackRoot, `[data-play-ui="reaction-best"]`).textContent ===
    "Best ideag1 → f3"
);
expectEqual(element(sideExploreFallbackRoot, `[data-play-ui="reaction-plan"]`).textContent, "Planlive board");
expectEqual(element(sideExploreFallbackRoot, `[data-play-ui="reaction-result-source"]`).textContent, "ResultRich result");
expectEqual(
  element(sideExploreFallbackRoot, `[data-play-ui="reaction-lens"]`).getAttribute("data-reaction-state"),
  "rich"
);
expectEqual(
  element(sideExploreFallbackRoot, `[data-play-ui="reaction-stage"]`).textContent,
  "StageRich result"
);
await waitFor(() => sideExploreFallbackEvidence.length === 2);
expectEqual(
  element(sideExploreFallbackRoot, `[data-play-ui="reaction-score"]`).textContent,
  "Exact score+68 cp"
);
const richEvidence = sideExploreFallbackEvidence[1] as {
  readonly schema?: unknown;
  readonly type?: unknown;
  readonly exploreMode?: unknown;
  readonly nodeBudget?: unknown;
  readonly primaryMove?: unknown;
  readonly primaryRenderState?: unknown;
};
expectEqual(richEvidence.schema, 2);
expectEqual(richEvidence.type, "recommendation");
expectEqual(richEvidence.exploreMode, "fast");
expectEqual(richEvidence.nodeBudget, 100_000);
expectEqual(richEvidence.primaryMove, "g1f3");
expectEqual(richEvidence.primaryRenderState, "recommended");

const sideExploreNoEarlyFallbackRoot = fakeRoot();
let sideExploreNoEarlyFallbackCalls = 0;
const sideExploreNoEarlyRich = deferred<SideExploreDto>();
await mountPlayUi(sideExploreNoEarlyFallbackRoot, {
  reactionLens: true,
  motion: { sideExploreFastDeadlineMs: 1000 },
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: true, value: afterE4 }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => {
      sideExploreNoEarlyFallbackCalls += 1;
      return Promise.resolve({
        ok: true,
        value: {
          bestMove: "e2e4",
          depth: 1,
          scoreCp: 4,
          nodes: 3,
          ttHits: 0,
          principalLine: ["e2e4"]
        }
      });
    },
    sideExplore: () => sideExploreNoEarlyRich.promise
  }
}).ready;
await waitFor(() => sideExploreNoEarlyFallbackCalls === 1);
await waitFor(
  () =>
    element(sideExploreNoEarlyFallbackRoot, `[data-play-ui="reaction-best"]`).textContent ===
    "Provisional movee2 → e4"
);
expectEqual(
  element(sideExploreNoEarlyFallbackRoot, `[data-play-ui="reaction-best"]`).textContent,
  "Provisional movee2 → e4"
);
expectEqual(sideExploreNoEarlyFallbackRoot.html().includes(`data-path-role=`), false);
expectEqual(sideExploreNoEarlyFallbackRoot.html().includes(`data-candidate-from=`), false);

const sideExploreDeadlineRoot = fakeRoot();
await mountPlayUi(sideExploreDeadlineRoot, {
  reactionLens: true,
  motion: { sideExploreFastDeadlineMs: 0 },
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: true, value: afterE4 }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () =>
      Promise.resolve({
        ok: true,
        value: {
          bestMove: "e2e4",
          depth: 1,
          scoreCp: 4,
          nodes: 3,
          ttHits: 0,
          principalLine: ["e2e4"]
        }
    }),
    sideExplore: () => new Promise(() => {}),
    cancelSearch: () => {}
  }
}).ready;
await waitFor(
  () =>
    element(sideExploreDeadlineRoot, `[data-play-ui="reaction-best"]`).textContent ===
    "Provisional movee2 → e4"
);
expectEqual(
  element(sideExploreDeadlineRoot, `[data-play-ui="reaction-score"]`).textContent,
  "StatusProvisional"
);
expectEqual(sideExploreDeadlineRoot.html().includes(`data-path-role=`), false);
expectEqual(sideExploreDeadlineRoot.html().includes(`data-candidate-from=`), false);

const newGameEvidenceStorage = evidenceMemoryStorage();
const newGameEvidenceRoot = fakeRoot();
await mountPlayUi(newGameEvidenceRoot, {
  evidenceStorage: newGameEvidenceStorage,
  engine
}).ready;
expectEqual(
  element(newGameEvidenceRoot, `[data-play-ui="archive-save-button"]`).disabled,
  true
);
await element(newGameEvidenceRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
expectEqual(storedEvidenceSessions(newGameEvidenceStorage).length, 0);
expectEqual(storedGameArchive(newGameEvidenceStorage).length, 0);
await boardSquare(newGameEvidenceRoot, "e2").dispatch("click");
await boardSquare(newGameEvidenceRoot, "e4").dispatch("click");
await waitFor(() => elements(newGameEvidenceRoot, `[data-play-ui="move-row"]`).length === 2);
await element(newGameEvidenceRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
await waitFor(() => elements(newGameEvidenceRoot, `[data-play-ui="move-row"]`).length === 0);
expectEqual(storedEvidenceSessions(newGameEvidenceStorage).length, 0);
expectEqual(element(newGameEvidenceRoot, `[data-play-ui="archive-count"]`).textContent, "1 saved");
const archivedNewGame = storedGameArchive(newGameEvidenceStorage)[0] as {
  readonly saveReason?: string;
  readonly selectedSide?: string;
  readonly moves?: readonly {
    readonly coordinate?: string;
    readonly role?: string;
    readonly selectedSide?: string;
    readonly side?: string;
  }[];
};
expectEqual(archivedNewGame.saveReason, "new-game");
expectEqual(archivedNewGame.selectedSide, "white");
expectEqual(archivedNewGame.moves?.length, 2);
expectEqual(archivedNewGame.moves?.[0]?.coordinate, "e2e4");
expectEqual(archivedNewGame.moves?.[0]?.role, "user");
expectEqual(archivedNewGame.moves?.[0]?.side, "white");
expectEqual(archivedNewGame.moves?.[1]?.role, "rival");
expectEqual(archivedNewGame.moves?.[1]?.selectedSide, "white");

// ADR-0241: saving a game pushes the record to the archive sink exactly once per save;
// the fingerprint-deduped New Game save does not re-send, and sink failures never break the UI.
const sinkArchiveStorage = evidenceMemoryStorage();
const sinkArchiveRoot = fakeRoot();
const sinkRecords: { readonly schema?: number; readonly source?: string; readonly moves?: readonly unknown[] }[] = [];
let resolveSink: (value: boolean) => void = () => {};
const sinkResult = new Promise<boolean>((resolve) => {
  resolveSink = resolve;
});
await mountPlayUi(sinkArchiveRoot, {
  evidenceStorage: sinkArchiveStorage,
  engine,
  gameArchiveSink: (record) => {
    sinkRecords.push(record);
    return sinkResult;
  }
}).ready;
await boardSquare(sinkArchiveRoot, "e2").dispatch("click");
await boardSquare(sinkArchiveRoot, "e4").dispatch("click");
await waitFor(() => elements(sinkArchiveRoot, `[data-play-ui="move-row"]`).length === 2);
await element(sinkArchiveRoot, `[data-play-ui="archive-save-button"]`).dispatch("click");
expectEqual(sinkRecords.length, 1);
expectEqual(sinkRecords[0]?.schema, 1);
expectEqual(sinkRecords[0]?.source, "play-game-archive");
expectEqual(sinkRecords[0]?.moves?.length, 2);
expectEqual(
  element(sinkArchiveRoot, `[data-play-ui="archive-status-text"]`).textContent,
  "Saved"
);
resolveSink(false);
await waitFor(
  () =>
    element(sinkArchiveRoot, `[data-play-ui="archive-status-text"]`).textContent ===
    "⚠ Export required"
);
await element(sinkArchiveRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
expectEqual(sinkRecords.length, 1);
expectEqual(storedGameArchive(sinkArchiveStorage).length, 1);

// Mate wording only appears with terminal mate evidence.
const mateState: EngineStateDto = {
  fen: "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1",
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["a1a8", "h1g1"]
};
const mateRoot = fakeRoot();
await mountPlayUi(mateRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: mateState }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: () =>
      Promise.resolve({
        ok: true,
        value: {
          state: mateState,
          side: "white",
          onTurn: true,
          replyCandidates: [],
          candidates: [{ move: "a1a8", kind: "capture", exactScoreCp: 30000, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }],
          principalLine: ["a1a8"],
          mateDetected: true,
          depth: 2,
          nodes: 5,
          soundMarginCp: 50
        }
      })
  }
}).ready;
await waitFor(
  () => element(mateRoot, `[data-play-ui="reaction-best"]`).textContent === "Best ideaa1 → a8"
);
expectEqual(element(mateRoot, `[data-play-ui="reaction-score"]`).textContent, "Exact scoreForced mate");
expectEqual(element(mateRoot, `[data-play-ui="reaction-mate"]`).textContent, "MateForced mate");

// A mate closing in AGAINST the selected side (off-turn: the opponent's projected reply mates, so
// candidates are empty) reads "Mated", never "Forced mate" — the label must not claim the mate for
// the side that is on the receiving end.
const matedState: EngineStateDto = {
  fen: "8/8/8/8/8/5q1k/8/7K b - - 0 1",
  status: "ongoing",
  sideToMove: "black",
  legalMoves: ["f3g2"]
};
const matedRoot = fakeRoot();
await mountPlayUi(matedRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: matedState }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: () =>
      Promise.resolve({
        ok: true,
        value: {
          state: matedState,
          side: "white",
          onTurn: false,
          replyCandidates: [
            { move: "f3g2", kind: "mate", quality: "best", sound: true, sacrifice: false, mateIn: 1 }
          ],
          candidates: [],
          principalLine: [],
          mateDetected: true,
          depth: 2,
          nodes: 5,
          soundMarginCp: 50
        }
      })
  }
}).ready;
await waitFor(
  () => element(matedRoot, `[data-play-ui="reaction-mate"]`).textContent === "MateMated"
);
expectEqual(element(matedRoot, `[data-play-ui="reaction-score"]`).textContent, "Projected scoreMated");

// sideExplore candidates are all sound — every alternative draws as safe regardless of score gap.
const safetyRoot = fakeRoot();
await mountPlayUi(safetyRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: () =>
      Promise.resolve({
        ok: true,
        value: {
          state: startState,
          side: "white",
          onTurn: true,
          replyCandidates: [],
          candidates: [
            { move: "e2e4", kind: "capture", exactScoreCp: 20, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null },
            { move: "g1f3", kind: "capture", exactScoreCp: 14, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null },
            { move: "b1c3", kind: "capture", exactScoreCp: 12, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }
          ],
          principalLine: ["e2e4"],
          mateDetected: false,
          depth: 1,
          nodes: 12,
          soundMarginCp: 50
        }
      })
  }
}).ready;
await waitFor(
  () => element(safetyRoot, `[data-play-ui="reaction-best"]`).textContent === "Best ideae2 → e4"
);
expectEqual(element(safetyRoot, `[data-play-ui="reaction-score"]`).textContent, "Exact score+20 cp");
expectEqual(elements(safetyRoot, `[data-play-ui="reaction-arrow"]`).length, 1);
expectEqual(elements(safetyRoot, `[data-play-ui="risk-hierarchy"]`).length, 0);
expectEqual(
  safetyRoot
    .html()
    .includes(`data-candidate-to="f3" data-candidate-rank="2" data-candidate-safety="safe"`),
  true
);
expectEqual(
  safetyRoot
    .html()
    .includes(`data-candidate-to="c3" data-candidate-rank="3" data-candidate-safety="safe"`),
  true
);

// sideExplore sound gate guarantees the primary arrow is never hanging; sacrifice candidates
// render with the sacrifice attribute for distinct purple styling.
const hangingPrimaryRoot = fakeRoot();
await mountPlayUi(hangingPrimaryRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: () =>
      Promise.resolve({
        ok: true,
        value: {
          state: startState,
          side: "white",
          onTurn: true,
          replyCandidates: [],
          candidates: [
            { move: "d1h5", kind: "capture", exactScoreCp: 40, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null },
            { move: "e2e4", kind: "capture", exactScoreCp: 16, sound: true, sacrifice: true, prospectiveBrilliant: true, mateIn: null, aftermath: "accepted", continuation: "g1f3" }
          ],
          principalLine: ["d1h5"],
          mateDetected: false,
          depth: 1,
          nodes: 9,
          soundMarginCp: 50
        }
      })
  }
}).ready;
await waitFor(
  () => element(hangingPrimaryRoot, `[data-play-ui="reaction-best"]`).textContent === "Best idead1 → h5"
);
expectEqual(
  element(hangingPrimaryRoot, `[data-play-ui="prospective-brilliant"]`).textContent,
  "Brilliant candidatee2 → e4Completed depth 1 · continuation g1 → f3"
);
// Primary is never hanging — sideExplore soundness gate prevents it.
expectEqual(
  hangingPrimaryRoot
    .html()
    .includes(
      `data-reaction-order="1" data-reaction-primary="true" data-reaction-hanging="false" data-reaction-mating="false"`
    ),
  true
);
// Verified sacrifice candidate carries data-candidate-sacrifice="true".
expectEqual(
  hangingPrimaryRoot
    .html()
    .includes(
      `data-candidate-to="e4" data-candidate-rank="2" data-candidate-safety="safe" data-path-role="alternative" data-path-risk="safe" data-candidate-sacrifice="true"`
    ),
  true
);
// ADR-0154 Packet C: an accepted-sacrifice aftermath rides the same arrow as a distinct attribute,
// so the board can tell a sacrifice that works when taken from one that merely stands.
expectEqual(
  hangingPrimaryRoot.html().includes(`data-candidate-sacrifice="true" data-candidate-aftermath="accepted"`),
  true
);

// ADR-0220/0228: an unsound on-turn primary is diagnostic data, not a recommendation. It still
// renders as a ranked Alt/risk board lane, and the recommendation panel names the least-bad risk
// without calling it Best.
const unsoundPrimaryRoot = fakeRoot();
await mountPlayUi(unsoundPrimaryRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: () =>
      Promise.resolve({
        ok: true,
        value: {
          state: startState,
          side: "white",
          onTurn: true,
          replyCandidates: [],
          candidates: [
            { move: "d1h5", kind: "capture", exactScoreCp: 40, sound: false, sacrifice: true, prospectiveBrilliant: true, mateIn: null, aftermath: "accepted", continuation: "g1f3" },
            { move: "f1b5", kind: "defense", exactScoreCp: 22, sound: false, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null },
            { move: "e2e4", kind: "defense", exactScoreCp: 16, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }
          ],
          principalLine: ["d1h5", "g8f6"],
          mateDetected: false,
          depth: 1,
          nodes: 9,
          soundMarginCp: 50
        }
      })
  }
}).ready;
await waitFor(
  () => element(unsoundPrimaryRoot, `[data-play-ui="reaction-best"]`).textContent === "Least bad riskd1 → h5"
);
expectEqual(element(unsoundPrimaryRoot, `[data-play-ui="reaction-score"]`).textContent, "Risknot recommended · exact +40 cp");
expectEqual(
  element(unsoundPrimaryRoot, `[data-play-ui="reaction-lens"]`).getAttribute("data-reaction-risk-state"),
  "not-recommended"
);
expectEqual(element(unsoundPrimaryRoot, `[data-play-ui="reaction-sacrifice"]`).textContent, "SacrificeNone");
expectEqual(elements(unsoundPrimaryRoot, `[data-play-ui="prospective-brilliant"]`).length, 0);
expectEqual(elements(unsoundPrimaryRoot, `[data-play-ui="reaction-arrow"]`).length, 0);
expectEqual(unsoundPrimaryRoot.html().match(/data-play-ui="candidate-arrow"/gu)?.length ?? 0, 3);
expectEqual(
  unsoundPrimaryRoot
    .html()
    .includes(
      `data-candidate-from="d1" data-candidate-to="h5" data-candidate-rank="1" data-candidate-safety="hanging" data-path-role="diagnostic" data-path-risk="hanging" data-candidate-risk-rank="1" data-candidate-risk-label="least-bad-risk"`
    ),
  true
);
expectEqual(
  unsoundPrimaryRoot
    .html()
    .includes(
      `data-candidate-from="f1" data-candidate-to="b5" data-candidate-rank="2" data-candidate-safety="caution" data-path-role="diagnostic" data-path-risk="caution" data-candidate-risk-rank="2" data-candidate-risk-label="risky-alternative"`
    ),
  true
);
expectEqual(unsoundPrimaryRoot.html().includes(`data-candidate-sacrifice="true"`), false);
expectEqual(unsoundPrimaryRoot.html().includes(`data-candidate-aftermath="accepted"`), false);
expectEqual(
  element(unsoundPrimaryRoot, `[data-play-ui="risk-hierarchy"]`).textContent,
  "Least bad riskd1 → h5HangingRisky alternativef1 → b5Caution"
);
expectEqual(unsoundPrimaryRoot.html().includes("Best idead1h5"), false);

// When every candidate is unsound, the UI preserves score order and relative fixed labels instead
// of rotating a risky move into Best.
const allUnsoundRoot = fakeRoot();
await mountPlayUi(allUnsoundRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: () =>
      Promise.resolve({
        ok: true,
        value: {
          state: startState,
          side: "white",
          onTurn: true,
          replyCandidates: [],
          candidates: [
            { move: "d1h5", kind: "capture", exactScoreCp: -80, sound: false, sacrifice: true, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null },
            { move: "f1b5", kind: "defense", exactScoreCp: -140, sound: false, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null },
            { move: "g1g5", kind: "check", exactScoreCp: -320, sound: false, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }
          ],
          principalLine: ["d1h5", "g8f6"],
          mateDetected: false,
          depth: 1,
          nodes: 11,
          soundMarginCp: 50
        }
      })
  }
}).ready;
await waitFor(
  () => element(allUnsoundRoot, `[data-play-ui="reaction-best"]`).textContent === "Least bad riskd1 → h5"
);
expectEqual(element(allUnsoundRoot, `[data-play-ui="reaction-score"]`).textContent, "Risknot recommended · exact -80 cp");
expectEqual(elements(allUnsoundRoot, `[data-play-ui="reaction-arrow"]`).length, 0);
expectEqual(allUnsoundRoot.html().match(/data-play-ui="candidate-arrow"/gu)?.length ?? 0, 3);
expectEqual(
  element(allUnsoundRoot, `[data-play-ui="risk-hierarchy"]`).textContent,
  "Least bad riskd1 → h5HangingRisky alternativef1 → b5CautionAvoidg1 → g5Hanging"
);
expectEqual(
  allUnsoundRoot
    .html()
    .includes(
      `data-candidate-from="d1" data-candidate-to="h5" data-candidate-rank="1" data-candidate-safety="hanging" data-path-role="diagnostic" data-path-risk="hanging" data-candidate-risk-rank="1" data-candidate-risk-label="least-bad-risk"`
    ),
  true
);
expectEqual(
  allUnsoundRoot
    .html()
    .includes(
      `data-candidate-from="f1" data-candidate-to="b5" data-candidate-rank="2" data-candidate-safety="caution" data-path-role="diagnostic" data-path-risk="caution" data-candidate-risk-rank="2" data-candidate-risk-label="risky-alternative"`
    ),
  true
);
expectEqual(
  allUnsoundRoot
    .html()
    .includes(
      `data-candidate-from="g1" data-candidate-to="g5" data-candidate-rank="3" data-candidate-safety="hanging" data-path-role="diagnostic" data-path-risk="hanging" data-candidate-risk-rank="3" data-candidate-risk-label="avoid"`
    ),
  true
);
expectEqual(allUnsoundRoot.html().includes("Best idead1h5"), false);

// A forced mate within reach (the last or penultimate move) is painted a distinct mating colour:
// the primary mating arrow turns green, and a mating alternative candidate does too. A longer mate
// (mate in three) stays an ordinary safe option, not the special colour.
const mateColorRoot = fakeRoot();
await mountPlayUi(mateColorRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: () =>
      Promise.resolve({
        ok: true,
        value: {
          state: startState,
          side: "white",
          onTurn: true,
          replyCandidates: [],
          candidates: [
            { move: "d1h5", kind: "capture", exactScoreCp: 29999, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: 1, aftermath: null, continuation: null },
            { move: "f1c4", kind: "capture", exactScoreCp: 29997, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: 2, aftermath: null, continuation: null },
            { move: "b1c3", kind: "capture", exactScoreCp: 29994, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: 3, aftermath: null, continuation: null }
          ],
          principalLine: ["d1h5"],
          mateDetected: true,
          depth: 5,
          nodes: 80,
          soundMarginCp: 50
        }
      })
  }
}).ready;
await waitFor(
  () => element(mateColorRoot, `[data-play-ui="reaction-best"]`).textContent === "Best idead1 → h5"
);
// Mate in one: the lead arrow turns green.
expectEqual(
  mateColorRoot
    .html()
    .includes(
      `data-reaction-order="1" data-reaction-primary="true" data-reaction-hanging="false" data-reaction-mating="true" data-reaction-rival="false" data-path-role="main" data-path-risk="mate"`
    ),
  true
);
// Mate in two alternative: a candidate arrow is painted mating.
expectEqual(
  mateColorRoot
    .html()
    .includes(`data-candidate-to="c4" data-candidate-rank="2" data-candidate-safety="mating"`),
  true
);
// Mate in three stays a sound, ordinary option — not the special mating colour.
expectEqual(
  mateColorRoot
    .html()
    .includes(`data-candidate-to="c3" data-candidate-rank="3" data-candidate-safety="mating"`),
  false
);

// Stale sideExplore results for a superseded game version are dropped.
const staleReactionRoot = fakeRoot();
const staleReactionResults: DeferredResult<SideExploreDto>[] = [];
await mountPlayUi(staleReactionRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: () => Promise.resolve({ ok: true, value: afterE4 }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: () => {
      const next = deferred<SideExploreDto>();
      staleReactionResults.push(next);
      return next.promise;
    }
  }
}).ready;
await waitFor(() => staleReactionResults.length === 1);
await element(staleReactionRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
await waitFor(() => staleReactionResults.length === 2);
staleReactionResults[0]?.resolve({
  ok: true,
  value: {
    state: startState,
    side: "white",
    onTurn: true,
    replyCandidates: [],
    candidates: [{ move: "a2a3", kind: "capture", exactScoreCp: 99, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }],
    principalLine: ["a2a3"],
    mateDetected: false,
    depth: 1,
    nodes: 1,
    soundMarginCp: 50
  }
});
await new Promise((resolve) => {
  setTimeout(resolve, 0);
});
expectEqual(
  element(staleReactionRoot, `[data-play-ui="reaction-best"]`).textContent,
  "Analyzing position—"
);
staleReactionResults[1]?.resolve({
  ok: true,
  value: {
    state: startState,
    side: "white",
    onTurn: true,
    replyCandidates: [],
    candidates: [{ move: "e2e4", kind: "capture", exactScoreCp: 12, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }],
    principalLine: ["e2e4"],
    mateDetected: false,
    depth: 1,
    nodes: 2,
    soundMarginCp: 50
  }
});
await waitFor(
  () => element(staleReactionRoot, `[data-play-ui="reaction-best"]`).textContent === "Best ideae2 → e4"
);

// Undo in Explore cancels the shared Classic worker once, restores the prior FEN, and starts a
// fresh analysis for that restored position instead of leaving the lens on the superseded search.
const undoReactionRoot = fakeRoot();
const undoReactionFens: string[] = [];
let undoReactionCancelCount = 0;
const undoReactionEngine: PlayEngine = {
  newGame: () => Promise.resolve({ ok: true, value: startState }),
  makeMove: () => Promise.resolve({ ok: true, value: afterE4 }),
  loadPosition: () => Promise.resolve({ ok: true, value: startState }),
  bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
  cancelSearch: () => {
    undoReactionCancelCount += 1;
  },
  sideExplore: (fen) => {
    undoReactionFens.push(fen);
    const result = sideExploreMaps[`${fen}:white:false`];
    return Promise.resolve(
      result === undefined ? { ok: false, error: "search-failed" } : { ok: true, value: result }
    );
  }
};
await mountPlayUi(undoReactionRoot, {
  reactionLens: true,
  engine: undoReactionEngine,
  analysisEngine: undoReactionEngine
}).ready;
await waitFor(() => undoReactionFens.length === 1);
await waitFor(
  () => element(undoReactionRoot, `[data-play-ui="reaction-lens"]`).getAttribute("data-reaction-status") === "ready"
);
await boardSquare(undoReactionRoot, "e2").dispatch("click");
await boardSquare(undoReactionRoot, "e4").dispatch("click");
await waitFor(() => undoReactionFens.length === 2);
await waitFor(
  () => element(undoReactionRoot, `[data-play-ui="reaction-lens"]`).getAttribute("data-reaction-status") === "ready"
);
const cancelCountBeforeUndo = undoReactionCancelCount;
await element(undoReactionRoot, `[data-play-ui="undo-button"]`).dispatch("click");
await waitFor(() => undoReactionFens.length === 3);
await waitFor(
  () =>
    element(undoReactionRoot, `[data-play-ui="status"]`).textContent === "White to move" &&
    element(undoReactionRoot, `[data-play-ui="reaction-lens"]`).getAttribute("data-reaction-status") === "ready"
);
expectEqual(undoReactionFens, [startState.fen, afterE4.state.fen, startState.fen]);
expectEqual(undoReactionCancelCount, cancelCountBeforeUndo + 1);

// Forcing lens surfaces the host's ordered checks/captures/mates. ------------
const forcingMateState: EngineStateDto = {
  fen: "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1",
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["a1a8", "h1g1", "h1g2", "h1h2"]
};
const forcingMaps: Record<string, ForcingMapDto> = {
  [forcingMateState.fen]: {
    state: forcingMateState,
    host: "white",
    onTurn: true,
    candidates: [
      { move: "a1a8", kind: "mate", scoreCp: 29999, sound: true, mateIn: 1 },
      { move: "h1g2", kind: "defense", scoreCp: 5, sound: true, mateIn: null },
      { move: "h1g1", kind: "defense", scoreCp: 4, sound: true, mateIn: null },
      { move: "a1a7", kind: "defense", scoreCp: 3, sound: true, mateIn: null },
      { move: "a1a6", kind: "defense", scoreCp: 2, sound: true, mateIn: null },
      { move: "a1a5", kind: "defense", scoreCp: 1, sound: true, mateIn: null },
      { move: "a1a4", kind: "defense", scoreCp: 0, sound: true, mateIn: null },
      { move: "a1a3", kind: "defense", scoreCp: -1, sound: true, mateIn: null },
      { move: "h1h2", kind: "check", scoreCp: -800, sound: false, mateIn: null }
    ],
    depth: 1,
    nodes: 11
  }
};
const forcingRoot = fakeRoot();
const forcingCalls: string[] = [];
await mountPlayUi(forcingRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: forcingMateState }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: () => Promise.resolve({ ok: false, error: "search-failed" }),
    forcingMap: (fen, depth, host, deep) => {
      forcingCalls.push(`forcing:${fen}:${String(depth)}:${host}:${String(deep)}`);
      const map = forcingMaps[fen];
      return Promise.resolve(
        map === undefined ? { ok: false, error: "search-failed" } : { ok: true, value: map }
      );
    }
  }
}).ready;
// Explore defaults to the broad Reaction lens; Forcing is a manual, narrower recommendation surface.
expectEqual(elements(forcingRoot, `[data-play-ui="reaction-lens"]`).length, 1);
expectEqual(reactionViewButton(forcingRoot, "reaction").getAttribute("aria-pressed"), "true");
expectEqual(reactionViewButton(forcingRoot, "forcing").getAttribute("aria-pressed"), "false");
await reactionViewButton(forcingRoot, "forcing").dispatch("click");
expectEqual(elements(forcingRoot, `[data-play-ui="forcing-lens"]`).length, 1);
expectEqual(reactionViewButton(forcingRoot, "forcing").getAttribute("aria-pressed"), "true");
await waitFor(
  () => element(forcingRoot, `[data-play-ui="forcing-count"]`).textContent === "Board ideas1"
);
expectEqual(forcingCalls, [`forcing:${forcingMateState.fen}:1:white:false`]);
expectEqual(element(forcingRoot, `[data-play-ui="forcing-host"]`).textContent, "FocusWhite");
expectEqual(element(forcingRoot, `[data-play-ui="forcing-turn"]`).textContent, "TurnHost to move");
expectEqual(
  element(forcingRoot, `[data-play-ui="forcing-mate"]`).textContent,
  "MateForced mate in 1"
);
const forcingCandidates = elements(forcingRoot, `[data-play-ui="forcing-candidate"]`);
expectEqual(forcingCandidates.length, 0);
expectEqual(forcingRoot.html().includes("h1h2 ?!"), false);
// Only the trusted forcing idea is drawn on the board; quiet defenses and speculative checks are not.
expectEqual(
  forcingRoot
    .html()
    .includes(
      `data-reaction-from="a1" data-reaction-to="a8" data-reaction-order="1" data-reaction-primary="true"`
    ),
  true
);
expectEqual(
  forcingRoot
    .html()
    .includes(
      `data-candidate-from="h1" data-candidate-to="g2" data-candidate-rank="1" data-candidate-safety="safe"`
    ),
  false
);
expectEqual(
  forcingRoot
    .html()
    .includes(
      `data-candidate-from="a1" data-candidate-to="a3" data-candidate-rank="7" data-candidate-safety="safe"`
    ),
  false
);
expectEqual(forcingRoot.html().includes(`data-reaction-from="h1" data-reaction-to="h2"`), false);
expectEqual(forcingRoot.html().includes(`data-candidate-from="h1" data-candidate-to="h2"`), false);

// Quiet defense candidates are not forcing board recommendations. -----------
const quietForcingState: EngineStateDto = {
  fen: "rnbqkbnr/pppp1ppp/8/4p3/8/2N5/PPPPPPPP/R1BQKBNR w KQkq - 0 2",
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["c3d5", "g1f3", "e2e4"]
};
const quietForcingRoot = fakeRoot();
await mountPlayUi(quietForcingRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: quietForcingState }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: () => Promise.resolve({ ok: false, error: "search-failed" }),
    forcingMap: () =>
      Promise.resolve({
        ok: true,
        value: {
          state: quietForcingState,
          host: "white",
          onTurn: true,
          candidates: [
            { move: "c3d5", kind: "defense", scoreCp: 34, sound: true, mateIn: null },
            { move: "g1f3", kind: "defense", scoreCp: 30, sound: true, mateIn: null },
            { move: "e2e4", kind: "defense", scoreCp: 24, sound: true, mateIn: null }
          ],
          depth: 1,
          nodes: 30
        }
      })
  }
}).ready;
await reactionViewButton(quietForcingRoot, "forcing").dispatch("click");
await waitFor(
  () => element(quietForcingRoot, `[data-play-ui="forcing-empty"]`).textContent === "No forcing idea"
);
expectEqual(element(quietForcingRoot, `[data-play-ui="forcing-count"]`).textContent, "Board ideas0");
expectEqual(quietForcingRoot.html().includes(`data-reaction-from="c3" data-reaction-to="d5"`), false);
expectEqual(quietForcingRoot.html().includes(`data-candidate-from="g1" data-candidate-to="f3"`), false);

// Forcing lens stays idle and waits when it is not the host's turn. -----------
const forcingBlackHostState: EngineStateDto = {
  fen: "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1",
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["a1a8", "h1g1"]
};
const forcingWaitRoot = fakeRoot();
const forcingWaitCalls: string[] = [];
await mountPlayUi(forcingWaitRoot, {
  reactionLens: true,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: forcingBlackHostState }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: () => Promise.resolve({ ok: false, error: "search-failed" }),
    forcingMap: (_fen, _depth, host) => {
      forcingWaitCalls.push(`forcing:${host}`);
      return Promise.resolve({ ok: false, error: "search-failed" });
    }
  }
}).ready;
await playerSideButton(forcingWaitRoot, "black").dispatch("click");
await reactionViewButton(forcingWaitRoot, "forcing").dispatch("click");
await waitFor(() => elements(forcingWaitRoot, `[data-play-ui="forcing-lens"]`).length === 1);
// Forcing is no longer auto-requested on mount. After switching the host to black while white is
// still on turn, no black forcing search runs and the lens waits.
expectEqual(forcingWaitCalls, []);
expectEqual(
  element(forcingWaitRoot, `[data-play-ui="forcing-empty"]`).textContent,
  "Waiting for Black to move"
);

// Setup board hands the composed position to Explore (reaction-lens). --------
const setupRoot = fakeRoot();
const setupLoadCalls: string[] = [];
const setupSideExploreCalls: string[] = [];
const setupComposedFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const setupStart: EngineStateDto = {
  fen: setupComposedFen,
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["e2e4", "d2d4"]
};
await mountPlayUi(setupRoot, {
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: setupStart }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    loadPosition: (fen) => {
      setupLoadCalls.push(fen);
      return Promise.resolve({ ok: true, value: { ...setupStart, fen } });
    }
  },
  analysisEngine: {
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" }),
    sideExplore: (fen, side, aggressive) => {
      setupSideExploreCalls.push(`sideExplore:${fen}:${side}:${String(aggressive)}`);
      return Promise.resolve({
        ok: true,
        value: {
          state: { ...setupStart, fen },
          side: "white",
          onTurn: true,
          replyCandidates: [],
          candidates: [{ move: "e2e4", kind: "capture", exactScoreCp: 20, sound: true, sacrifice: false, prospectiveBrilliant: false, mateIn: null, aftermath: null, continuation: null }],
          principalLine: ["e2e4"],
          mateDetected: false,
          depth: 1,
          nodes: 12,
          soundMarginCp: 50
        }
      });
    }
  }
}).ready;
// A fresh board starts in Play mode and never touches the analysis engine.
expectEqual(element(setupRoot, `[data-play-ui="root"]`).getAttribute("data-play-mode"), "opponent");
expectEqual(setupSideExploreCalls, []);
// Entering Setup shows the composer; committing with "Analyze →" must work.
await element(setupRoot, `[data-play-ui="play-mode-button"][data-play-mode="setup"]`).dispatch("click");
expectEqual(element(setupRoot, `[data-play-ui="root"]`).getAttribute("data-play-mode"), "setup");
expectEqual(elements(setupRoot, `[data-play-ui="setup-panel"]`).length, 1);
await element(setupRoot, `[data-play-ui="setup-analyze"]`).dispatch("click");
// Analyze must make the engine work on the composed position, not stall.
await waitFor(
  () => element(setupRoot, `[data-play-ui="reaction-best"]`).textContent === "Best ideae2 → e4"
);
expectEqual(setupSideExploreCalls, [`sideExplore:${setupComposedFen}:white:false`]);
// ...landing in Explore on the loaded FEN, with the composer dismissed.
expectEqual(setupLoadCalls, [setupComposedFen]);
expectEqual(element(setupRoot, `[data-play-ui="root"]`).getAttribute("data-play-mode"), "reaction-lens");
expectEqual(elements(setupRoot, `[data-play-ui="setup-panel"]`).length, 0);
expectEqual(elements(setupRoot, `[data-play-ui="reaction-lens"]`).length, 1);

const motionRoot = fakeRoot();
const motionCalls: string[] = [];
const motionDelays: number[] = [];
const motionDelayResolvers: Array<() => void> = [];
const motionEngine: PlayEngine = {
  newGame: () => Promise.resolve({ ok: true, value: startState }),
  makeMove: (_fen, mv) => {
    motionCalls.push(`makeMove:${mv}`);
    return Promise.resolve(
      mv === "e2e4" ? { ok: true, value: afterE4 } : { ok: true, value: afterNc6 }
    );
  },
  bestMove: (_fen, depth) => {
    motionCalls.push(`bestMove:${String(depth)}`);
    return Promise.resolve({
      ok: true,
      value: { bestMove: "b8c6", depth, scoreCp: -12, nodes: 20, ttHits: 0 }
    });
  }
};
const resolveMotionDelay = (): void => {
  const resolve = motionDelayResolvers.shift();
  if (resolve === undefined) {
    throw new Error("missing motion delay");
  }
  resolve();
};
await mountPlayUi(motionRoot, {
  engine: motionEngine,
  motion: {
    engineReplyMinDelayMs: 0,
    engineMoveAnimationMs: 220,
    now: () => 0,
    delay: (ms) =>
      new Promise<void>((resolve) => {
        motionDelays.push(ms);
        motionDelayResolvers.push(resolve);
      })
  }
}).ready;
await boardSquare(motionRoot, "e2").dispatch("click");
await boardSquare(motionRoot, "e4").dispatch("click");
await waitFor(
  () =>
    motionCalls.includes("makeMove:b8c6") &&
    motionDelays.length === 1 &&
    elements(motionRoot, `[data-play-ui="board-motion-piece"]`).length === 1
);
expectEqual(elements(motionRoot, `[data-play-ui="move-row"]`).length, 1);
const motionPiece = element(motionRoot, `[data-play-ui="board-motion-piece"]`);
expectEqual(motionPiece.getAttribute("data-board-motion-actor"), "engine");
expectEqual(motionPiece.getAttribute("data-board-motion-move"), "b8c6");
expectEqual(motionPiece.getAttribute("data-board-motion-from"), "b8");
expectEqual(motionPiece.getAttribute("data-board-motion-to"), "c6");
expectEqual(motionPiece.getAttribute("data-board-motion-duration-ms"), "220");
expectEqual(boardSquare(motionRoot, "b8").getAttribute("data-board-motion-from"), "true");
expectEqual(boardSquare(motionRoot, "c6").getAttribute("data-board-motion-to"), "true");
expectEqual(elements(motionRoot, `[data-play-ui="move-row"]`).length, 1);
expectEqual(motionDelays, [220]);
resolveMotionDelay();
await waitFor(() => elements(motionRoot, `[data-play-ui="move-row"]`).length === 2);
expectEqual(elements(motionRoot, `[data-play-ui="board-motion-piece"]`).length, 0);
expectEqual(boardSquare(motionRoot, "b8").getAttribute("data-board-last-move"), "true");
expectEqual(boardSquare(motionRoot, "c6").getAttribute("data-board-last-move"), "true");

const reselectRoot = fakeRoot();
const reselectState: EngineStateDto = { ...startState, legalMoves: ["e2e4", "g1f3"] };
await mountPlayUi(reselectRoot, {
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: reselectState }),
    makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  }
}).ready;
await boardSquare(reselectRoot, "e2").dispatch("click");
expectSelection(reselectRoot, "e2", "1 legal destination", "e4");
await boardSquare(reselectRoot, "g1").dispatch("click");
expectSelection(reselectRoot, "g1", "1 legal destination", "f3");
expectEqual(boardSquare(reselectRoot, "f3").getAttribute("data-board-legal-target"), "true");
expectPlayError(
  reselectRoot,
  "invalid-input",
  "Invalid move",
  "Move selection",
  "Invalid move",
  "Choose a legal move."
);
await playerSideButton(reselectRoot, "black").dispatch("click");
expectNoSelection(reselectRoot);
expectNoPlayError(reselectRoot);

const modeRoot = fakeRoot();
let engineMode: PlayEngineMode = "local-stockfish";
let cancelSearchCount = 0;
const modeEngine: PlayEngine = {
  mode: () => engineMode,
  cancelSearch: () => {
    cancelSearchCount += 1;
  },
  newGame: () => Promise.resolve({ ok: true, value: startState }),
  makeMove: () => Promise.resolve({ ok: true, value: afterE4 }),
  bestMove: () => {
    engineMode = "owned-local-stockfish-unavailable";
    return Promise.resolve({ ok: false, error: "search-failed" });
  }
};
await mountPlayUi(modeRoot, { engine: modeEngine }).ready;
expectEqual(element(modeRoot, `[data-play-ui="mode-label"]`).textContent, "Engine: Local Stockfish");
await boardSquare(modeRoot, "e2").dispatch("click");
await boardSquare(modeRoot, "e4").dispatch("click");
await waitFor(() => element(modeRoot, `[data-play-ui="status"]`).textContent === "Engine failed");
expectEqual(
  element(modeRoot, `[data-play-ui="mode-label"]`).textContent,
  "Engine: Owned local (Stockfish unavailable)"
);
await element(modeRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
expectEqual(cancelSearchCount, 1);

const whiteResignRoot = fakeRoot();
const whiteResignStorage = evidenceMemoryStorage();
const whiteResignBest = deferred<BestMoveDto>();
const whiteResignCalls: string[] = [];
let whiteResignResets = 0;
const whiteResignedGames: CompletedPlayGame[] = [];
const whiteResignEngine: PlayEngine = {
  newGame: () => {
    whiteResignCalls.push("newGame");
    return Promise.resolve({ ok: true, value: startState });
  },
  makeMove: (_fen, mv) => {
    whiteResignCalls.push(`makeMove:${mv}`);
    return Promise.resolve({ ok: true, value: afterE4 });
  },
  bestMove: (_fen, depth) => {
    whiteResignCalls.push(`bestMove:${String(depth)}`);
    return whiteResignBest.promise;
  }
};
await mountPlayUi(whiteResignRoot, {
  engine: whiteResignEngine,
  evidenceStorage: whiteResignStorage,
  onPlayReset: () => {
    whiteResignResets += 1;
  },
  onReviewGame: (game) => {
    whiteResignedGames.push(game);
  }
}).ready;
expectEqual(whiteResignResets, 0);
expectEqual(element(whiteResignRoot, `[data-play-ui="post-game-review-button"]`).disabled, true);
expectEqual(
  element(whiteResignRoot, `[data-play-ui="post-game-review-button"]`).getAttribute(
    "data-terminal-action"
  ),
  "secondary"
);
await boardSquare(whiteResignRoot, "e2").dispatch("click");
await boardSquare(whiteResignRoot, "e4").dispatch("click");
await waitFor(() => whiteResignCalls.includes("bestMove:1"));
await element(whiteResignRoot, `[data-play-ui="resign-button"][data-resign-actor="rival"]`).dispatch("click");
expectEqual(element(whiteResignRoot, `[data-play-ui="status"]`).textContent, "Black resigned");
expectEqual(element(whiteResignRoot, `[data-play-ui="game-status"]`).textContent, "Statusresigned");
expectEqual(element(whiteResignRoot, `[data-play-ui="post-game"]`).textContent.includes("Game complete"), true);
expectEqual(element(whiteResignRoot, `[data-play-ui="terminal-result-value"]`).textContent, "Result1-0");
expectEqual(element(whiteResignRoot, `[data-play-ui="terminal-result-winner"]`).textContent, "WinnerWhite won");
expectEqual(element(whiteResignRoot, `[data-play-ui="terminal-result-actor"]`).textContent, "Resigned byRival");
expectEqual(storedGameArchive(whiteResignStorage).length, 1);
expectEqual(
  (storedGameArchive(whiteResignStorage)[0] as { readonly saveReason?: string }).saveReason,
  "terminal"
);
expectEqual(
  element(whiteResignRoot, `[data-play-ui="terminal-result-reason"]`).textContent,
  "ReasonBlack resigned"
);
expectEqual(element(whiteResignRoot, `[data-play-ui="post-game-review-button"]`).disabled, false);
expectEqual(elements(whiteResignRoot, `[data-play-ui="rematch-button"]`).length, 1);
expectEqual(elements(whiteResignRoot, `[data-play-ui="new-game-button"]`).length, 1);
expectEqual(element(whiteResignRoot, `[data-play-ui="terminal-copy-pgn-button"]`).textContent, "Copy PGN");
expectEqual(element(whiteResignRoot, `[data-play-ui="terminal-copy-pgn-status"]`).textContent, "");
expectEqual(element(whiteResignRoot, `[data-play-ui="archive-save-button"]`).disabled, false);
expectEqual(
  element(whiteResignRoot, `[data-play-ui="rematch-button"]`).getAttribute("data-terminal-action"),
  "primary"
);
expectEqual(
  element(whiteResignRoot, `[data-play-ui="post-game-review-button"]`).getAttribute(
    "data-terminal-action"
  ),
  "secondary"
);
expectEqual(
  element(whiteResignRoot, `[data-play-ui="terminal-copy-pgn-button"]`).getAttribute(
    "data-terminal-action"
  ),
  "utility"
);
expectBefore(
  whiteResignRoot.html(),
  `data-play-ui="rematch-button"`,
  `data-play-ui="post-game-review-button"`
);
expectBefore(
  whiteResignRoot.html(),
  `data-play-ui="post-game-review-button"`,
  `data-play-ui="terminal-pgn-copy"`
);
expectEqual(elements(whiteResignRoot, `[data-play-ui="resign-button"]`).length, 0);
expectEqual(boardSquare(whiteResignRoot, "e2").disabled, true);
const terminalPgnClipboard = installClipboardMock();
try {
  await element(whiteResignRoot, `[data-play-ui="terminal-copy-pgn-button"]`).dispatch("click");
  expectEqual(terminalPgnClipboard.writes(), ["1. e4 1-0"]);
  expectEqual(element(whiteResignRoot, `[data-play-ui="terminal-copy-pgn-status"]`).textContent, "PGN copied");
} finally {
  terminalPgnClipboard.restore();
}
const unavailableTerminalPgnClipboard = installClipboardMock({ reject: true });
try {
  await element(whiteResignRoot, `[data-play-ui="terminal-copy-pgn-button"]`).dispatch("click");
  expectEqual(unavailableTerminalPgnClipboard.writes(), ["1. e4 1-0"]);
  expectEqual(
    element(whiteResignRoot, `[data-play-ui="terminal-copy-pgn-status"]`).textContent,
    "PGN copy unavailable"
  );
} finally {
  unavailableTerminalPgnClipboard.restore();
}
await element(whiteResignRoot, `[data-play-ui="archive-save-button"]`).dispatch("click");
const resignedArchive = storedGameArchive(whiteResignStorage)[0] as {
  readonly result?: string;
  readonly termination?: string;
  readonly resignedSide?: string;
  readonly resignedBy?: string;
};
expectEqual(resignedArchive.result, "1-0");
expectEqual(resignedArchive.termination, "resigned");
expectEqual(resignedArchive.resignedSide, "black");
expectEqual(resignedArchive.resignedBy, "rival");
expectEqual(elements(whiteResignRoot, `[data-play-ui="analyze-command-button"]`).length, 1);
await element(whiteResignRoot, `[data-play-ui="post-game-review-button"]`).dispatch("click");
expectEqual(whiteResignedGames[0]?.status, "resigned");
expectEqual(whiteResignedGames[0]?.result, "1-0");
expectEqual(whiteResignedGames[0]?.finalFen, afterE4.state.fen);
expectEqual(whiteResignedGames[0]?.pgn, "1. e4 1-0");
whiteResignBest.resolve({
  ok: true,
  value: { bestMove: "b8c6", depth: 1, scoreCp: -1, nodes: 12, ttHits: 0 }
});
await new Promise((resolve) => {
  setTimeout(resolve, 0);
});
expectEqual(whiteResignCalls, ["newGame", "makeMove:e2e4", "bestMove:1"]);
expectEqual(elements(whiteResignRoot, `[data-play-ui="move-row"]`).length, 1);
await element(whiteResignRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
await waitFor(() => element(whiteResignRoot, `[data-play-ui="status"]`).textContent === "Your move as White");
expectStatus(whiteResignRoot, "Your move as White", "player", "white");
expectEqual(whiteResignResets, 1);
expectEqual(element(whiteResignRoot, `[data-play-ui="post-game-review-button"]`).disabled, true);
expectEqual(elements(whiteResignRoot, `[data-play-ui="rematch-button"]`).length, 0);
expectEqual(elements(whiteResignRoot, `[data-play-ui="terminal-result"]`).length, 0);
expectEqual(elements(whiteResignRoot, `[data-play-ui="terminal-pgn-copy"]`).length, 0);
expectEqual(element(whiteResignRoot, `[data-play-ui="current-fen"]`).textContent, `FEN${startState.fen}`);
expectEqual(elements(whiteResignRoot, `[data-play-ui="last-move"]`).length, 0);
expectNoSelection(whiteResignRoot);
expectEqual(elements(whiteResignRoot, `[data-play-ui="move-row"]`).length, 0);
await element(whiteResignRoot, `[data-play-ui="resign-button"][data-resign-actor="user"]`).dispatch("click");
expectEqual(element(whiteResignRoot, `[data-play-ui="status"]`).textContent, "White resigned");
expectEqual(element(whiteResignRoot, `[data-play-ui="terminal-result-actor"]`).textContent, "Resigned byUser");
expectEqual(element(whiteResignRoot, `[data-play-ui="terminal-result-value"]`).textContent, "Result0-1");

const afterEngineC3: MoveResultDto = {
  appliedMove: "b1c3",
  san: "Nc3",
  state: {
    fen: "rnbqkbnr/pppppppp/8/8/8/2N5/PPPPPPPP/R1BQKBNR b KQkq - 1 1",
    status: "ongoing",
    sideToMove: "black",
    legalMoves: ["e7e5"]
  }
};
const afterBlackE5: MoveResultDto = {
  appliedMove: "e7e5",
  san: "e5",
  state: {
    fen: "rnbqkbnr/pppp1ppp/8/4p3/8/2N5/PPPPPPPP/R1BQKBNR w KQkq - 0 2",
    status: "ongoing",
    sideToMove: "white",
    legalMoves: ["g1f3"]
  }
};
const afterEngineF3: MoveResultDto = {
  appliedMove: "g1f3",
  san: "Nf3",
  state: {
    fen: "rnbqkbnr/pppp1ppp/8/4p3/8/2N2N2/PPPPPPPP/R1BQKB1R b KQkq - 1 2",
    status: "checkmate",
    sideToMove: "black",
    legalMoves: []
  }
};

const newGameFailureRoot = fakeRoot();
const newGameFailureCalls: string[] = [];
let newGameFailureAttempt = 0;
let newGameFailureResets = 0;
const newGameFailureEngine: PlayEngine = {
  newGame: () => {
    newGameFailureAttempt += 1;
    newGameFailureCalls.push("newGame");
    return Promise.resolve(
      newGameFailureAttempt === 1
        ? { ok: false, error: "search-failed" }
        : { ok: true, value: startState }
    );
  },
  makeMove: (_fen, mv) => {
    newGameFailureCalls.push(`makeMove:${mv}`);
    return Promise.resolve({ ok: true, value: afterEngineC3 });
  },
  bestMove: (fen, depth) => {
    newGameFailureCalls.push(`bestMove:${fen}:${String(depth)}`);
    return Promise.resolve({
      ok: true,
      value: { bestMove: "b1c3", depth, scoreCp: 11, nodes: 22, ttHits: 0 }
    });
  }
};
await mountPlayUi(newGameFailureRoot, {
  engine: newGameFailureEngine,
  onPlayReset: () => {
    newGameFailureResets += 1;
  }
}).ready;
expectEqual(newGameFailureResets, 0);
expectEqual(element(newGameFailureRoot, `[data-play-ui="status"]`).textContent, "New game failed");
expectEqual(element(newGameFailureRoot, `[data-play-ui="game-status"]`).textContent, "Statusfailed");
expectPlayError(
  newGameFailureRoot,
  "new-game",
  "New game failed",
  "New Game",
  "Search failed",
  "Use New Game to reset."
);
expectFailedNonTerminal(newGameFailureRoot);
await playerSideButton(newGameFailureRoot, "black").dispatch("click");
await engineDepthButton(newGameFailureRoot, 3).dispatch("click");
expectEqual(element(newGameFailureRoot, `[data-play-ui="error"]`).getAttribute("data-play-error-source"), "new-game");
await element(newGameFailureRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
await waitFor(() => elements(newGameFailureRoot, `[data-play-ui="move-row"]`).length === 1);
expectEqual(newGameFailureResets, 1);
expectNoPlayError(newGameFailureRoot);
expectEqual(playerSideButton(newGameFailureRoot, "black").getAttribute("aria-pressed"), "true");
expectEqual(engineDepthButton(newGameFailureRoot, 3).getAttribute("aria-pressed"), "true");
expectEqual(
  element(newGameFailureRoot, `[data-play-ui="board"]`).getAttribute("data-board-orientation"),
  "black"
);
expectStatus(newGameFailureRoot, "Your move as Black", "player", "black");
expectEqual(newGameFailureCalls, ["newGame", "newGame", `bestMove:${startState.fen}:3`, "makeMove:b1c3"]);

for (const scenario of [
  {
    source: "player-move",
    title: "Move failed",
    operation: "Player move",
    reason: "Invalid move",
    calls: ["makeMove:e2e4"],
    rows: 0,
    engine: (calls: string[]): PlayEngine => ({
      newGame: () => Promise.resolve({ ok: true, value: startState }),
      makeMove: (_fen, mv) => {
        calls.push(`makeMove:${mv}`);
        return Promise.resolve({ ok: false, error: "invalid-move" });
      },
      bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
    })
  },
  {
    source: "engine-search",
    title: "Engine failed",
    operation: "Engine search",
    reason: "Invalid depth",
    calls: ["makeMove:e2e4", "bestMove:1"],
    rows: 1,
    engine: (calls: string[]): PlayEngine => ({
      newGame: () => Promise.resolve({ ok: true, value: startState }),
      makeMove: (_fen, mv) => {
        calls.push(`makeMove:${mv}`);
        return Promise.resolve({ ok: true, value: afterE4 });
      },
      bestMove: (_fen, depth) => {
        calls.push(`bestMove:${String(depth)}`);
        return Promise.resolve({ ok: false, error: "invalid-depth" });
      }
    })
  },
  {
    source: "engine-move",
    title: "Engine failed",
    operation: "Engine move",
    reason: "Invalid position",
    calls: ["makeMove:e2e4", "bestMove:1", "makeMove:b8c6"],
    rows: 1,
    lastSearch: "Last search1",
    engine: (calls: string[]): PlayEngine => ({
      newGame: () => Promise.resolve({ ok: true, value: startState }),
      makeMove: (_fen, mv) => {
        calls.push(`makeMove:${mv}`);
        return Promise.resolve(
          mv === "e2e4"
            ? { ok: true, value: afterE4 }
            : { ok: false, error: "invalid-position" }
        );
      },
      bestMove: (_fen, depth) => {
        calls.push(`bestMove:${String(depth)}`);
        return Promise.resolve({
          ok: true,
          value: { bestMove: "b8c6", depth, scoreCp: -3, nodes: 15, ttHits: 0 }
        });
      }
    })
  }
] as const) {
  const scenarioRoot = fakeRoot();
  const scenarioCalls: string[] = [];
  await mountPlayUi(scenarioRoot, { engine: scenario.engine(scenarioCalls) }).ready;
  await boardSquare(scenarioRoot, "e2").dispatch("click");
  await boardSquare(scenarioRoot, "e4").dispatch("click");
  await waitFor(() => element(scenarioRoot, `[data-play-ui="status"]`).textContent === scenario.title);
  expectEqual(scenarioCalls, [...scenario.calls]);
  expectEqual(elements(scenarioRoot, `[data-play-ui="move-row"]`).length, scenario.rows);
  expectEqual(element(scenarioRoot, `[data-play-ui="game-status"]`).textContent, "Statusfailed");
  if ("lastSearch" in scenario) {
    expectEqual(element(scenarioRoot, `[data-play-ui="last-engine-depth"]`).textContent, scenario.lastSearch);
  }
  expectPlayError(
    scenarioRoot,
    scenario.source,
    scenario.title,
    scenario.operation,
    scenario.reason,
    "Use New Game to reset."
  );
  expectFailedNonTerminal(scenarioRoot);
}

const blackResignRoot = fakeRoot();
const blackResignCalls: string[] = [];
let blackResignResets = 0;
const blackResignedGames: CompletedPlayGame[] = [];
const blackResignEngine: PlayEngine = {
  newGame: () => {
    blackResignCalls.push("newGame");
    return Promise.resolve({ ok: true, value: startState });
  },
  makeMove: (fen, mv) => {
    blackResignCalls.push(`makeMove:${fen}:${mv}`);
    return Promise.resolve({ ok: true, value: afterEngineC3 });
  },
  bestMove: (fen, depth) => {
    blackResignCalls.push(`bestMove:${fen}:${String(depth)}`);
    return Promise.resolve({
      ok: true,
      value: { bestMove: "b1c3", depth, scoreCp: 11, nodes: 22, ttHits: 0 }
    });
  }
};
await mountPlayUi(blackResignRoot, {
  engine: blackResignEngine,
  onPlayReset: () => {
    blackResignResets += 1;
  },
  onReviewGame: (game) => {
    blackResignedGames.push(game);
  }
}).ready;
expectEqual(blackResignResets, 0);
await playerSideButton(blackResignRoot, "black").dispatch("click");
await engineDepthButton(blackResignRoot, 3).dispatch("click");
await element(blackResignRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
await waitFor(() => elements(blackResignRoot, `[data-play-ui="move-row"]`).length === 1);
expectEqual(blackResignResets, 1);
expectStatus(blackResignRoot, "Your move as Black", "player", "black");
expectEqual(
  element(blackResignRoot, `[data-play-ui="board"]`).getAttribute("data-board-orientation"),
  "black"
);
await element(blackResignRoot, `[data-play-ui="resign-button"][data-resign-actor="user"]`).dispatch("click");
expectEqual(element(blackResignRoot, `[data-play-ui="status"]`).textContent, "Black resigned");
expectEqual(element(blackResignRoot, `[data-play-ui="terminal-result-value"]`).textContent, "Result1-0");
expectEqual(element(blackResignRoot, `[data-play-ui="terminal-result-winner"]`).textContent, "WinnerWhite won");
expectEqual(
  element(blackResignRoot, `[data-play-ui="terminal-result-reason"]`).textContent,
  "ReasonBlack resigned"
);
expectEqual(element(blackResignRoot, `[data-play-ui="post-game-review-button"]`).disabled, false);
await element(blackResignRoot, `[data-play-ui="post-game-review-button"]`).dispatch("click");
expectEqual(blackResignedGames[0]?.status, "resigned");
expectEqual(blackResignedGames[0]?.result, "1-0");
expectEqual(blackResignedGames[0]?.finalFen, afterEngineC3.state.fen);
expectEqual(blackResignedGames[0]?.pgn, "1. Nc3 1-0");
await element(blackResignRoot, `[data-play-ui="rematch-button"]`).dispatch("click");
await waitFor(() => elements(blackResignRoot, `[data-play-ui="move-row"]`).length === 1);
expectEqual(blackResignResets, 2);
expectEqual(playerSideButton(blackResignRoot, "black").getAttribute("aria-pressed"), "true");
expectEqual(engineDepthButton(blackResignRoot, 3).getAttribute("aria-pressed"), "true");
expectEqual(
  blackResignCalls.filter((call) => call === `bestMove:${startState.fen}:3`).length,
  2
);
expectEqual(element(blackResignRoot, `[data-play-ui="post-game-review-button"]`).disabled, true);
expectEqual(elements(blackResignRoot, `[data-play-ui="rematch-button"]`).length, 0);
expectEqual(elements(blackResignRoot, `[data-play-ui="terminal-result"]`).length, 0);
expectEqual(elements(blackResignRoot, `[data-play-ui="terminal-pgn-copy"]`).length, 0);
expectStatus(blackResignRoot, "Your move as Black", "player", "black");
expectNoSelection(blackResignRoot);

const blackRoot = fakeRoot();
const blackOpening = deferred<BestMoveDto>();
const blackCalls: string[] = [];
const blackReviewedGames: CompletedPlayGame[] = [];
const blackEngine: PlayEngine = {
  newGame: () => {
    blackCalls.push("newGame");
    return Promise.resolve({ ok: true, value: startState });
  },
  makeMove: (fen, mv) => {
    blackCalls.push(`makeMove:${fen}:${mv}`);
    if (mv === "b1c3") {
      return Promise.resolve({ ok: true, value: afterEngineC3 });
    }
    if (mv === "e7e5") {
      return Promise.resolve({ ok: true, value: afterBlackE5 });
    }
    return Promise.resolve({ ok: true, value: afterEngineF3 });
  },
  bestMove: (fen, depth) => {
    blackCalls.push(`bestMove:${fen}:${String(depth)}`);
    if (blackCalls.filter((call) => call.startsWith("bestMove:")).length === 1) {
      return blackOpening.promise;
    }
    return Promise.resolve({
      ok: true,
      value: { bestMove: "g1f3", depth, scoreCp: 9, nodes: 31, ttHits: 1 }
    });
  }
};
await mountPlayUi(blackRoot, {
  engine: blackEngine,
  onReviewGame: (game) => {
    blackReviewedGames.push(game);
  }
}).ready;
await playerSideButton(blackRoot, "black").dispatch("click");
expectEqual(
  element(blackRoot, `[data-play-ui="board"]`).getAttribute("data-board-orientation"),
  "black"
);
expectEqual(boardSquareOrder(blackRoot).at(0), "h1");
expectEqual(boardSquareOrder(blackRoot).at(-1), "a8");
await engineDepthButton(blackRoot, 3).dispatch("click");
await element(blackRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
await waitFor(() => blackCalls.includes(`bestMove:${startState.fen}:3`));
expectEqual(element(blackRoot, `[data-play-ui="status"]`).textContent, "Engine thinking");
expectEqual(boardSquare(blackRoot, "e7").disabled, true);
await boardSquare(blackRoot, "e7").dispatch("click");
expectEqual(blackCalls.filter((call) => call.startsWith("makeMove:")).length, 0);
blackOpening.resolve({
  ok: true,
  value: { bestMove: "b1c3", depth: 3, scoreCp: 11, nodes: 22, ttHits: 0 }
});
await waitFor(() => elements(blackRoot, `[data-play-ui="move-row"]`).length === 1);
expectStatus(blackRoot, "Your move as Black", "player", "black");
expectEqual(playerSideButton(blackRoot, "black").disabled, true);
expectEqual(boardSquare(blackRoot, "e7").disabled, false);
expectEqual(
  element(blackRoot, `[data-play-ui="move-row"][data-play-ply="1"]`).textContent,
  "1.RivalWhiteNc3b1c3"
);
expectEqual(element(blackRoot, `[data-play-ui="last-engine-depth"]`).textContent, "Last search3");
expectEqual(element(blackRoot, `[data-play-ui="post-game-review-button"]`).disabled, true);
await boardSquare(blackRoot, "e7").dispatch("click");
expectEqual(boardSquare(blackRoot, "e5").getAttribute("data-board-legal-target"), "true");
expectSelection(blackRoot, "e7", "1 legal destination", "e5");
await boardSquare(blackRoot, "e5").dispatch("click");
await waitFor(() => elements(blackRoot, `[data-play-ui="move-row"]`).length === 3);
expectNoSelection(blackRoot);
expectEqual(blackCalls, [
  "newGame",
  "newGame",
  `bestMove:${startState.fen}:3`,
  `makeMove:${startState.fen}:b1c3`,
  `makeMove:${afterEngineC3.state.fen}:e7e5`,
  `bestMove:${afterBlackE5.state.fen}:3`,
  `makeMove:${afterBlackE5.state.fen}:g1f3`
]);
expectEqual(element(blackRoot, `[data-play-ui="move-row"][data-play-ply="2"]`).textContent, "1...UserBlacke5e7e5");
expectEqual(element(blackRoot, `[data-play-ui="move-row"][data-play-ply="3"]`).textContent, "2.RivalWhiteNf3g1f3");
expectEqual(element(blackRoot, `[data-play-ui="status"]`).textContent, "Checkmate");
expectEqual(element(blackRoot, `[data-play-ui="post-game-review-button"]`).disabled, false);
await element(blackRoot, `[data-play-ui="post-game-review-button"]`).dispatch("click");
expectEqual(blackReviewedGames[0]?.pgn, "1. Nc3 e5 2. Nf3 1-0");

const staleRoot = fakeRoot();
const staleBests: DeferredResult<BestMoveDto>[] = [];
const staleCalls: string[] = [];
const staleEngine: PlayEngine = {
  newGame: () => {
    staleCalls.push("newGame");
    return Promise.resolve({ ok: true, value: startState });
  },
  makeMove: (_fen, mv) => {
    staleCalls.push(`makeMove:${mv}`);
    return Promise.resolve({ ok: true, value: afterEngineC3 });
  },
  bestMove: (_fen, depth) => {
    staleCalls.push(`bestMove:${String(depth)}`);
    const nextBest = deferred<BestMoveDto>();
    staleBests.push(nextBest);
    return nextBest.promise;
  }
};
await mountPlayUi(staleRoot, { engine: staleEngine }).ready;
await playerSideButton(staleRoot, "black").dispatch("click");
await element(staleRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
await waitFor(() => staleBests.length === 1);
await element(staleRoot, `[data-play-ui="new-game-button"]`).dispatch("click");
await waitFor(() => staleBests.length === 2);
staleBests[0]?.resolve({
  ok: true,
  value: { bestMove: "b1c3", depth: 1, scoreCp: 1, nodes: 10, ttHits: 0 }
});
await new Promise((resolve) => {
  setTimeout(resolve, 0);
});
expectEqual(staleCalls.filter((call) => call.startsWith("makeMove:")).length, 0);
staleBests[1]?.resolve({
  ok: true,
  value: { bestMove: "b1c3", depth: 1, scoreCp: 1, nodes: 10, ttHits: 0 }
});
await waitFor(() => elements(staleRoot, `[data-play-ui="move-row"]`).length === 1);
expectEqual(staleCalls.filter((call) => call.startsWith("makeMove:")).length, 1);

const staleEngineMoveRoot = fakeRoot();
const staleEngineMove = deferredEngineResult<MoveResultDto>();
const staleEngineMoveCalls: string[] = [];
const staleEngineMoveReviewedGames: CompletedPlayGame[] = [];
const staleEngineMoveEngine: PlayEngine = {
  newGame: () => Promise.resolve({ ok: true, value: startState }),
  makeMove: (_fen, mv) => {
    staleEngineMoveCalls.push(`makeMove:${mv}`);
    if (mv === "b8c6") {
      return staleEngineMove.promise;
    }
    return Promise.resolve({ ok: true, value: afterE4 });
  },
  bestMove: (_fen, depth) => {
    staleEngineMoveCalls.push(`bestMove:${String(depth)}`);
    return Promise.resolve({
      ok: true,
      value: { bestMove: "b8c6", depth, scoreCp: 2, nodes: 18, ttHits: 0 }
    });
  }
};
await mountPlayUi(staleEngineMoveRoot, {
  engine: staleEngineMoveEngine,
  onReviewGame: (game) => {
    staleEngineMoveReviewedGames.push(game);
  }
}).ready;
await boardSquare(staleEngineMoveRoot, "e2").dispatch("click");
await boardSquare(staleEngineMoveRoot, "e4").dispatch("click");
await waitFor(() => staleEngineMoveCalls.includes("makeMove:b8c6"));
await element(staleEngineMoveRoot, `[data-play-ui="resign-button"][data-resign-actor="rival"]`).dispatch("click");
staleEngineMove.resolve({ ok: false, error: "invalid-position" });
await new Promise((resolve) => {
  setTimeout(resolve, 0);
});
expectEqual(elements(staleEngineMoveRoot, `[data-play-ui="move-row"]`).length, 1);
expectEqual(
  element(staleEngineMoveRoot, `[data-play-ui="terminal-result-reason"]`).textContent,
  "ReasonBlack resigned"
);
await element(staleEngineMoveRoot, `[data-play-ui="post-game-review-button"]`).dispatch("click");
expectEqual(staleEngineMoveReviewedGames[0]?.pgn, "1. e4 1-0");

const promotionState: EngineStateDto = {
  fen: "k7/4P3/8/8/8/8/8/4K3 w - - 0 1",
  status: "ongoing",
  sideToMove: "white",
  legalMoves: ["e7e8q", "e7e8r", "e7e8b", "e7e8n"]
};
const afterPromotion: MoveResultDto = {
  appliedMove: "e7e8r",
  san: "e8=R+",
  state: {
    fen: "k3R3/8/8/8/8/8/8/4K3 b - - 0 1",
    status: "checkmate",
    sideToMove: "black",
    legalMoves: []
  }
};
const promotionRoot = fakeRoot();
const promotionCalls: string[] = [];
const promotionEngine: PlayEngine = {
  newGame: () => {
    promotionCalls.push("newGame");
    return Promise.resolve({ ok: true, value: promotionState });
  },
  makeMove: (_fen, mv) => {
    promotionCalls.push(`makeMove:${mv}`);
    return Promise.resolve({ ok: true, value: afterPromotion });
  },
  bestMove: (_fen, depth) => {
    promotionCalls.push(`bestMove:${String(depth)}`);
    return Promise.resolve({
      ok: true,
      value: { bestMove: null, depth, scoreCp: 0, nodes: 4, ttHits: 0 }
    });
  }
};
await mountPlayUi(promotionRoot, { engine: promotionEngine }).ready;
expectEqual(boardSquare(promotionRoot, "e7").getAttribute("data-board-draggable"), "true");
expectEqual(boardSquare(promotionRoot, "e8").getAttribute("data-board-draggable"), "false");
await boardSquare(promotionRoot, "e7").dispatch("click");
expectSelection(promotionRoot, "e7", "1 legal destination", "e8");
await boardSquare(promotionRoot, "e8").dispatch("click");
expectEqual(elements(promotionRoot, `[data-play-ui="promotion-button"]`).length, 4);
expectEqual(
  element(promotionRoot, `[data-play-ui="promotion-button"][data-promotion-piece="queen"]`)
    .textContent,
  "queen"
);
expectEqual(promotionCalls, ["newGame"]);
await element(
  promotionRoot,
  `[data-play-ui="promotion-button"][data-promotion-piece="rook"]`
).dispatch("click");
await waitFor(() => elements(promotionRoot, `[data-play-ui="move-row"]`).length === 1);
expectEqual(promotionCalls, ["newGame", "makeMove:e7e8r"]);
expectEqual(elements(promotionRoot, `[data-play-ui="promotion-button"]`).length, 0);
expectNoSelection(promotionRoot);
expectEqual(
  element(promotionRoot, `[data-play-ui="move-row"][data-play-ply="1"]`).textContent,
  "1.UserWhitee8=R+e7e8r"
);

const completed = buildCompletedPlayGame(
  [
    playMove(1, "player", "white", "f2f3", "f3", startState.fen, "after f3"),
    playMove(2, "engine", "black", "e7e5", "e5", "after f3", "after e5"),
    playMove(3, "player", "white", "g2g4", "g4", "after e5", "after g4"),
    playMove(4, "engine", "black", "d8h4", "Qh4#", "after g4", "mate")
  ],
  { fen: "mate", status: "checkmate", sideToMove: "white", legalMoves: [] }
);
expectEqual(completed?.pgn, "1. f3 e5 2. g4 Qh4# 0-1");
expectEqual(completed?.moves[0]?.fenBefore, startState.fen);

const terminalRoot = fakeRoot();
const terminalCalls: string[] = [];
const reviewedGames: CompletedPlayGame[] = [];
const terminalFen = "rnbqkbnr/pppppppp/8/8/8/4P3/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const terminalEngine: PlayEngine = {
  newGame: () => Promise.resolve({ ok: true, value: { ...startState, legalMoves: ["e2e3"] } }),
  makeMove: (fen, mv) => {
    terminalCalls.push(`makeMove:${fen}:${mv}`);
    return Promise.resolve({
      ok: true,
      value: {
        appliedMove: "e2e3",
        san: "Qh5#",
        state: {
          fen: terminalFen,
          status: "checkmate",
          sideToMove: "black",
          legalMoves: []
        }
      }
    });
  },
  bestMove: () => {
    terminalCalls.push("bestMove");
    return Promise.resolve({ ok: false, error: "search-failed" });
  }
};
const terminalHandle = mountPlayUi(terminalRoot, {
  engine: terminalEngine,
  onReviewGame: (game) => {
    reviewedGames.push(game);
  }
});
await terminalHandle.ready;
expectEqual(element(terminalRoot, `[data-play-ui="post-game-review-button"]`).disabled, true);
await boardSquare(terminalRoot, "e2").dispatch("click");
await boardSquare(terminalRoot, "e3").dispatch("click");
await waitFor(() => element(terminalRoot, `[data-play-ui="status"]`).textContent === "Checkmate");
expectEqual(terminalCalls, [`makeMove:${startState.fen}:e2e3`]);
expectEqual(element(terminalRoot, `[data-play-ui="post-game-review-button"]`).disabled, false);
expectEqual(element(terminalRoot, `[data-play-ui="terminal-result-value"]`).textContent, "Result1-0");
expectEqual(element(terminalRoot, `[data-play-ui="terminal-result-winner"]`).textContent, "WinnerWhite won");
expectEqual(element(terminalRoot, `[data-play-ui="terminal-result-reason"]`).textContent, "ReasonCheckmate");
expectEqual(boardSquare(terminalRoot, "e2").disabled, true);
await element(terminalRoot, `[data-play-ui="post-game-review-button"]`).dispatch("click");
expectEqual(reviewedGames[0]?.pgn, "1. Qh5# 1-0");
expectEqual(reviewedGames[0]?.moves[0]?.fenBefore, startState.fen);
expectEqual(reviewedGames[0]?.moves[0]?.fenAfter, terminalFen);

const stalemateRoot = fakeRoot();
const stalemateEngine: PlayEngine = {
  newGame: () =>
    Promise.resolve({
      ok: true,
      value: { fen: "stalemate", status: "stalemate", sideToMove: "black", legalMoves: [] }
    }),
  makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
  bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
};
await mountPlayUi(stalemateRoot, { engine: stalemateEngine }).ready;
expectEqual(element(stalemateRoot, `[data-play-ui="status"]`).textContent, "Stalemate");
expectEqual(element(stalemateRoot, `[data-play-ui="terminal-result-value"]`).textContent, "Result1/2-1/2");
expectEqual(element(stalemateRoot, `[data-play-ui="terminal-result-winner"]`).textContent, "WinnerDraw");
expectEqual(element(stalemateRoot, `[data-play-ui="terminal-result-reason"]`).textContent, "ReasonStalemate");
expectEqual(element(stalemateRoot, `[data-play-ui="post-game-review-button"]`).disabled, false);

const drawRoot = fakeRoot();
const drawEngine: PlayEngine = {
  newGame: () =>
    Promise.resolve({
      ok: true,
      value: {
        fen: "draw",
        status: "draw",
        drawReason: "threefold-repetition",
        sideToMove: "white",
        legalMoves: []
      }
    }),
  makeMove: () => Promise.resolve({ ok: false, error: "invalid-move" }),
  bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
};
await mountPlayUi(drawRoot, { engine: drawEngine }).ready;
expectEqual(element(drawRoot, `[data-play-ui="status"]`).textContent, "Draw: threefold repetition");
expectEqual(element(drawRoot, `[data-play-ui="terminal-result-value"]`).textContent, "Result1/2-1/2");
expectEqual(element(drawRoot, `[data-play-ui="terminal-result-winner"]`).textContent, "WinnerDraw");
expectEqual(element(drawRoot, `[data-play-ui="terminal-result-reason"]`).textContent, "ReasonDraw: threefold repetition");
expectEqual(element(drawRoot, `[data-play-ui="post-game-review-button"]`).disabled, false);

const thinkingRoot = fakeRoot();
const thinkingMove = deferred<MoveResultDto>();
const thinkingCalls: string[] = [];
const thinkingEngine: PlayEngine = {
  newGame: () => Promise.resolve({ ok: true, value: startState }),
  makeMove: (_fen, mv) => {
    thinkingCalls.push(`makeMove:${mv}`);
    return thinkingMove.promise;
  },
  bestMove: () => {
    thinkingCalls.push("bestMove");
    return Promise.resolve({ ok: true, value: { bestMove: null, depth: 1, scoreCp: 0, nodes: 0, ttHits: 0 } });
  }
};
await mountPlayUi(thinkingRoot, { engine: thinkingEngine }).ready;
await boardSquare(thinkingRoot, "e2").dispatch("click");
await boardSquare(thinkingRoot, "e4").dispatch("click");
await waitFor(() => element(thinkingRoot, `[data-play-ui="status"]`).textContent === "Engine thinking");
expectEqual(boardSquare(thinkingRoot, "e2").disabled, true);
expectEqual(elements(thinkingRoot, `[data-play-ui="engine-thinking"]`).length, 0);
await boardSquare(thinkingRoot, "e2").dispatch("click");
await boardSquare(thinkingRoot, "e4").dispatch("click");
expectEqual(thinkingCalls, ["makeMove:e2e4"]);
thinkingMove.resolve({ ok: true, value: afterE4 });
await waitFor(() => thinkingCalls.includes("bestMove"));
await waitFor(() => element(thinkingRoot, `[data-play-ui="status"]`).textContent === "Engine failed");
expectPlayError(
  thinkingRoot,
  "engine-search",
  "Engine failed",
  "Engine search",
  "Search failed",
  "Use New Game to reset."
);
expectEqual(element(thinkingRoot, `[data-play-ui="post-game-review-button"]`).disabled, true);
expectEqual(elements(thinkingRoot, `[data-play-ui="terminal-result"]`).length, 0);

const engineThinkingRoot = fakeRoot();
const engineThinkingBest = deferred<BestMoveDto>();
const engineThinkingCalls: string[] = [];
const engineThinkingEngine: PlayEngine = {
  newGame: () => Promise.resolve({ ok: true, value: startState }),
  makeMove: (_fen, mv) => {
    engineThinkingCalls.push(`makeMove:${mv}`);
    if (mv === "e2e4") {
      return Promise.resolve({ ok: true, value: afterE4 });
    }
    return Promise.resolve({ ok: true, value: afterNc6 });
  },
  bestMove: (_fen, depth) => {
    engineThinkingCalls.push(`bestMove:${String(depth)}`);
    return engineThinkingBest.promise;
  }
};
await mountPlayUi(engineThinkingRoot, { engine: engineThinkingEngine }).ready;
await engineDepthButton(engineThinkingRoot, 5).dispatch("click");
await boardSquare(engineThinkingRoot, "e2").dispatch("click");
await boardSquare(engineThinkingRoot, "e4").dispatch("click");
await waitFor(() => engineThinkingCalls.includes("bestMove:5"));
expectEqual(
  element(engineThinkingRoot, `[data-play-ui="engine-thinking"]`).textContent,
  "Engine thinking… (level 5)"
);
engineThinkingBest.resolve({
  ok: true,
  value: { bestMove: "b8c6", depth: 5, scoreCp: -1, nodes: 12, ttHits: 0 }
});
await waitFor(() => elements(engineThinkingRoot, `[data-play-ui="move-row"]`).length === 2);
expectEqual(elements(engineThinkingRoot, `[data-play-ui="engine-thinking"]`).length, 0);

const engineThinkingRejectRoot = fakeRoot();
let rejectBestSearch: (reason?: unknown) => void = () => {};
const rejectingBestSearch = new Promise<PlayEngineResult<BestMoveDto>>((_resolve, reject) => {
  rejectBestSearch = reject;
});
const engineThinkingRejectCalls: string[] = [];
const engineThinkingRejectEngine: PlayEngine = {
  newGame: () => Promise.resolve({ ok: true, value: startState }),
  makeMove: (_fen, mv) => {
    engineThinkingRejectCalls.push(`makeMove:${mv}`);
    return Promise.resolve({ ok: true, value: afterE4 });
  },
  bestMove: (_fen, depth) => {
    engineThinkingRejectCalls.push(`bestMove:${String(depth)}`);
    return rejectingBestSearch;
  }
};
await mountPlayUi(engineThinkingRejectRoot, { engine: engineThinkingRejectEngine }).ready;
await engineDepthButton(engineThinkingRejectRoot, 3).dispatch("click");
await boardSquare(engineThinkingRejectRoot, "e2").dispatch("click");
await boardSquare(engineThinkingRejectRoot, "e4").dispatch("click");
await waitFor(() => engineThinkingRejectCalls.includes("bestMove:3"));
expectEqual(
  element(engineThinkingRejectRoot, `[data-play-ui="engine-thinking"]`).textContent,
  "Engine thinking… (level 3)"
);
rejectBestSearch(new Error("search rejected"));
await waitFor(() => element(engineThinkingRejectRoot, `[data-play-ui="status"]`).textContent === "Engine failed");
expectEqual(elements(engineThinkingRejectRoot, `[data-play-ui="engine-thinking"]`).length, 0);

function playMove(
  ply: number,
  actor: PlayMove["actor"],
  side: PlayMove["side"],
  coordinate: string,
  san: string,
  fenBefore: string,
  fenAfter: string
): PlayMove {
  return {
    ply,
    actor,
    side,
    coordinate,
    san,
    fenBefore,
    fenAfter,
    attribution: {
      buildSha: "test-build-sha",
      evaluatorBackend: "owned-local",
      engineDepth: 1,
      aggressive: false
    }
  };
}

function deferred<T>(): DeferredResult<T> {
  let resolvePromise: (value: { readonly ok: true; readonly value: T }) => void = () => {};
  const promise = new Promise<{ readonly ok: true; readonly value: T }>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function deferredEngineResult<T>(): DeferredEngineResult<T> {
  let resolvePromise: (value: PlayEngineResult<T>) => void = () => {};
  const promise = new Promise<PlayEngineResult<T>>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

// ADR-0244 recorder ground-truth regression: emitMoveEvidence must derive `actor`
// from the stored per-move `move.actor` ("player" | "engine"), never by recomputing
// `move.side === state.playerSide` at emit time. Spectator-lens mode is the reachable
// path: canAcceptBoardInput() accepts board clicks for either side there
// (isSpectatorMode short-circuits the side-to-move check), so a human can play both
// White's and Black's moves in the same session while `state.playerSide` stays fixed
// at its default "white". Both moves are appended with actor "player"
// (apps/web/src/play-ui.ts applyPlayerMove), so both are reported as `actor="user"`
// in this provenance event. That actor field is separate from archive `role`, which
// always uses the selected-side perspective.
const actorGroundTruthEvents: unknown[] = [];
const actorGroundTruthRoot = fakeRoot();
await mountPlayUi(actorGroundTruthRoot, {
  spectatorLens: true,
  automaticEvidence: {
    buildSha: "actor-ground-truth-build-sha",
    sink: (event) => {
      actorGroundTruthEvents.push(event);
      return Promise.resolve(true);
    }
  },
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: (_fen, mv) =>
      Promise.resolve(mv === "e2e4" ? { ok: true, value: afterE4 } : { ok: true, value: afterNc6 }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: (fen, depth) => {
      const bestMove =
        fen === startState.fen ? "e2e4" : fen === afterE4.state.fen ? "b8c6" : "g1f3";
      return Promise.resolve({
        ok: true,
        value: { bestMove, depth, scoreCp: 0, nodes: 1, ttHits: 0 }
      });
    }
  }
}).ready;
expectEqual(element(actorGroundTruthRoot, `[data-play-ui="player-side"]`).textContent, "Viewwhite");
await boardSquare(actorGroundTruthRoot, "e2").dispatch("click");
await boardSquare(actorGroundTruthRoot, "e4").dispatch("click");
await waitFor(() => elements(actorGroundTruthRoot, `[data-play-ui="move-row"]`).length === 1);
await boardSquare(actorGroundTruthRoot, "b8").dispatch("click");
await boardSquare(actorGroundTruthRoot, "c6").dispatch("click");
await waitFor(() => elements(actorGroundTruthRoot, `[data-play-ui="move-row"]`).length === 2);
const actorGroundTruthMoveEvents = actorGroundTruthEvents.filter(
  (event) => (event as { readonly type?: string }).type === "move"
) as readonly { readonly ply: number; readonly move: string; readonly actor: string }[];
expectEqual(actorGroundTruthMoveEvents.length, 2);
expectEqual(actorGroundTruthMoveEvents[0]?.move, "e2e4");
expectEqual(actorGroundTruthMoveEvents[0]?.actor, "user");
expectEqual(actorGroundTruthMoveEvents[1]?.move, "b8c6");
expectEqual(
  actorGroundTruthMoveEvents[1]?.actor,
  "user"
); // regression: recomputing from state.playerSide ("white") would wrongly report "rival"

// Archive role regression: buildPlayGameArchiveRecord must label each move by its
// side against the selected side at save time. A current side-selector change must
// make the opposite side Rival, even when the move was entered by a player click.
const archiveGroundTruthStorage = evidenceMemoryStorage();
const archiveGroundTruthRoot = fakeRoot();
await mountPlayUi(archiveGroundTruthRoot, {
  spectatorLens: true,
  evidenceStorage: archiveGroundTruthStorage,
  engine: {
    newGame: () => Promise.resolve({ ok: true, value: startState }),
    makeMove: (_fen, mv) =>
      Promise.resolve(mv === "e2e4" ? { ok: true, value: afterE4 } : { ok: true, value: afterNc6 }),
    bestMove: () => Promise.resolve({ ok: false, error: "search-failed" })
  },
  analysisEngine: {
    bestMove: (fen, depth) => {
      const bestMove =
        fen === startState.fen ? "e2e4" : fen === afterE4.state.fen ? "b8c6" : "g1f3";
      return Promise.resolve({
        ok: true,
        value: { bestMove, depth, scoreCp: 0, nodes: 1, ttHits: 0 }
      });
    }
  }
}).ready;
await boardSquare(archiveGroundTruthRoot, "e2").dispatch("click");
await boardSquare(archiveGroundTruthRoot, "e4").dispatch("click");
await waitFor(() => elements(archiveGroundTruthRoot, `[data-play-ui="move-row"]`).length === 1);
await boardSquare(archiveGroundTruthRoot, "b8").dispatch("click");
await boardSquare(archiveGroundTruthRoot, "c6").dispatch("click");
await waitFor(() => elements(archiveGroundTruthRoot, `[data-play-ui="move-row"]`).length === 2);
expectEqual(canChangePlayerSideProbe(archiveGroundTruthRoot), true);
await playerSideButton(archiveGroundTruthRoot, "black").dispatch("click");
expectEqual(element(archiveGroundTruthRoot, `[data-play-ui="player-side"]`).textContent, "Viewblack");
await element(archiveGroundTruthRoot, `[data-play-ui="archive-save-button"]`).dispatch("click");
const archiveGroundTruthRecord = storedGameArchive(archiveGroundTruthStorage)[0] as {
  readonly selectedSide?: string;
  readonly moves?: readonly { readonly coordinate?: string; readonly side?: string; readonly role?: string }[];
};
expectEqual(archiveGroundTruthRecord.selectedSide, "black");
expectEqual(archiveGroundTruthRecord.moves?.[0]?.coordinate, "e2e4");
expectEqual(archiveGroundTruthRecord.moves?.[0]?.side, "white");
expectEqual(
  archiveGroundTruthRecord.moves?.[0]?.role,
  "rival"
);
expectEqual(archiveGroundTruthRecord.moves?.[1]?.coordinate, "b8c6");
expectEqual(archiveGroundTruthRecord.moves?.[1]?.role, "user");

function canChangePlayerSideProbe(root: FakeRoot): boolean {
  return !playerSideButton(root, "black").disabled;
}
