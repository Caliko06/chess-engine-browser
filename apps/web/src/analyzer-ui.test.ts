import { mountAnalyzerUi, type AnalyzerEndpointRequest, type AnalyzerEndpointResult } from "./analyzer-ui";

type Listener = () => void | Promise<void>;

type StoredElement = {
  getAttribute: (name: string) => string | null;
  addEventListener: (type: string, listener: Listener) => void;
  readonly listeners: Map<string, Listener[]>;
  value: string;
  textContent: string;
};

type FakeRoot = {
  readonly innerHTML: string;
  querySelector: (selector: string) => StoredElement | null;
  readonly html: () => string;
};

function fakeRoot(): FakeRoot {
  let html = "";
  let elements = new Map<string, StoredElement>();
  const parseElements = (next: string): Map<string, StoredElement> => {
    const found = new Map<string, StoredElement>();
    const tokenPattern = /<(?<tag>[a-z][a-z0-9]*)(?<attributes>[^>]*)>/gu;
    for (const match of next.matchAll(tokenPattern)) {
      const attributes = new Map<string, string>();
      const attributePattern = /(?<name>[a-zA-Z-]+)(?:="(?<value>[^"]*)")?/gu;
      for (const attribute of (match.groups?.attributes ?? "").matchAll(attributePattern)) {
        attributes.set(attribute.groups?.name ?? "", attribute.groups?.value ?? "");
      }
      const uiName = attributes.get("data-analyzer-ui");
      if (uiName === undefined) {
        continue;
      }
      const selector = `[data-analyzer-ui="${uiName}"]`;
      if (found.has(selector)) {
        continue;
      }
      // Element body: from this tag to the matching close of the same tag
      // (depth-aware, void elements excluded). textContent strips tags so
      // nested markup reads like a real DOM's textContent.
      const bodyStart = match.index + match[0].length;
      const rest = next.slice(bodyStart);
      const tagName = match.groups?.tag ?? "";
      const voidTags = new Set(["input", "br", "hr", "img", "meta", "link"]);
      let bodyEnd: number | null = null;
      if (!voidTags.has(tagName)) {
        let depth = 1;
        for (const scan of rest.matchAll(/<(\/)?([a-z][a-z0-9]*)[^>]*>/gu)) {
          const isClose = scan[1] !== undefined;
          const scanName = scan[2];
          if (isClose) {
            if (scanName === tagName) {
              depth -= 1;
              if (depth === 0) {
                bodyEnd = bodyStart + scan.index;
                break;
              }
            }
          } else if (scanName === tagName && !voidTags.has(scanName)) {
            depth += 1;
          }
        }
      }
      const body =
        bodyEnd === null ? rest : next.slice(bodyStart, bodyEnd + `</${tagName}>`.length);
      const listeners = new Map<string, Listener[]>();
      found.set(selector, {
        getAttribute: (name: string) => attributes.get(name) ?? null,
        addEventListener: (type: string, listener: Listener) => {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        listeners,
        value: "",
        textContent: body.replace(/<[^>]*>/gu, "")
      });
    }
    return found;
  };
  let current: { html: string } = { html: "" };
  const root = {
    set innerHTML(next: string) {
      html = next;
      elements = parseElements(next);
      current = { html: next };
    },
    querySelector: (selector: string) => elements.get(selector) ?? null,
    html: () => current.html
  } as unknown as FakeRoot;
  // keep the outer `html` variable used for the closure contract
  void html;
  return root;
}

function element(root: FakeRoot, selector: string): StoredElement {
  const stored = root.querySelector(selector);
  if (stored === null) {
    throw new Error(`missing element ${selector}`);
  }
  return stored;
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

async function dispatch(stored: StoredElement, type: string): Promise<void> {
  for (const listener of stored.listeners.get(type) ?? []) {
    await listener();
  }
}

function typePgn(root: FakeRoot, next: string): void {
  const stored = element(root, `[data-analyzer-ui="pgn-input"]`);
  stored.value = next;
}

const analyzerReportPayload = {
  oracle: { status: "enabled", depth: 12 },
  understanding: {
    accepted: [{ id: "pgn-test", confidence: 0.9 }],
    quarantined: [],
    acceptedGames: 1,
    quarantinedGames: 0
  },
  games: [
    {
      id: "pgn-test",
      selectedSide: "white",
      aggressive: true,
      result: "0-1",
      plies: 4,
      userPlies: 2,
      rivalPlies: 2,
      moves: [
        { ply: 1, side: "white", san: "f3", coordinate: "f2f3", fenBefore: "x" },
        { ply: 2, side: "black", san: "e5", coordinate: "e7e5", fenBefore: "x" },
        { ply: 3, side: "white", san: "g4", coordinate: "g2g4", fenBefore: "x" },
        { ply: 4, side: "black", san: "Qh4#", coordinate: "d8h4", fenBefore: "x" }
      ],
      labels: [
        {
          ply: 1,
          side: "white",
          role: "user",
          kind: "oracle-move-delta",
          severity: "info",
          detail: { deltaCp: -10, qualityBand: "good", bestBefore: "e2e4", deltaClass: "centipawn" }
        },
        {
          ply: 2,
          side: "black",
          role: "rival",
          kind: "oracle-move-delta",
          severity: "info",
          detail: { deltaCp: -5, qualityBand: "good", bestBefore: "e7e5", deltaClass: "centipawn" }
        },
        {
          ply: 3,
          side: "white",
          role: "user",
          kind: "oracle-move-delta",
          severity: "fail",
          detail: { deltaCp: -450, qualityBand: "blunder", bestBefore: "e2e4", deltaClass: "centipawn" }
        },
        {
          ply: 4,
          side: "black",
          role: "rival",
          kind: "oracle-move-delta",
          severity: "info",
          detail: { deltaCp: -20, qualityBand: "good", bestBefore: "d8h4", deltaClass: "centipawn" }
        }
      ]
    }
  ]
};

const analyzerRequests: AnalyzerEndpointRequest[] = [];

const endpoint = (request: AnalyzerEndpointRequest): Promise<AnalyzerEndpointResult> => {
  analyzerRequests.push(request);
  return Promise.resolve({ ok: true, report: analyzerReportPayload as unknown });
};

const analyzerRoot = fakeRoot();
mountAnalyzerUi({ root: analyzerRoot as unknown as HTMLElement, locale: "es", endpoint });

// Idle by default, always visible, no toggle: first-class surface.
expectEqual(
  element(analyzerRoot, `[data-analyzer-ui="section"]`).getAttribute("data-phase"),
  "idle"
);
expectIncludes(analyzerRoot.html(), "Analizador");
expectIncludes(analyzerRoot.html(), 'data-analyzer-ui="run"');

// Empty PGN -> explicit invalid-pgn error, no request sent.
await dispatch(element(analyzerRoot, `[data-analyzer-ui="run"]`), "click");
expectIncludes(
  element(analyzerRoot, `[data-analyzer-ui="error"]`).textContent,
  "no es válido"
);
expectEqual(analyzerRequests.length, 0);

// Typed PGN flows into state via the input listener and reaches the endpoint.
const typed = "1. f3 e5 2. g4 Qh4# 0-1";
typePgn(analyzerRoot, typed);
await dispatch(element(analyzerRoot, `[data-analyzer-ui="pgn-input"]`), "input");
await dispatch(element(analyzerRoot, `[data-analyzer-ui="run"]`), "click");
expectEqual(analyzerRequests.length, 1);
expectEqual(analyzerRequests[0]?.pgn, typed);
expectEqual(analyzerRequests[0]?.side, "white");
expectEqual(analyzerRequests[0]?.depth, 12);

// Report: oracle line, verdict (pawns + worst move), band chips, attention list.
expectEqual(
  element(analyzerRoot, `[data-analyzer-ui="oracle"]`).getAttribute("data-oracle"),
  "enabled"
);
const verdict = element(analyzerRoot, `[data-analyzer-ui="verdict"]`);
expectEqual(verdict.getAttribute("data-verdict"), "damaging");
expectIncludes(verdict.textContent, "4.6");
expectIncludes(verdict.textContent, "g4");
expectIncludes(verdict.textContent, "4.5");

const analyzerHtml = analyzerRoot.html();
expectIncludes(analyzerHtml, 'data-band="blunder"');
expectIncludes(analyzerHtml, 'data-user="false"');
expectIncludes(analyzerHtml, "Qh4#");
expectIncludes(analyzerHtml, "e2e4");
expectEqual((analyzerHtml.match(/data-attention-ply=/gu) ?? []).length, 1);

// Invalid PGN from the endpoint maps to the honest invalid-pgn state.
const invalidRoot = fakeRoot();
mountAnalyzerUi({
  root: invalidRoot as unknown as HTMLElement,
  locale: "es",
  endpoint: () =>
    Promise.resolve({
      ok: false,
      report: null,
      error: "invalid PGN: PGN contains an illegal move"
    })
});
const invalidInput = element(invalidRoot, `[data-analyzer-ui="pgn-input"]`);
invalidInput.value = "not-a-pgn";
await dispatch(invalidInput, "input");
await dispatch(element(invalidRoot, `[data-analyzer-ui="run"]`), "click");
expectIncludes(
  element(invalidRoot, `[data-analyzer-ui="error"]`).textContent,
  "no es válido"
);
