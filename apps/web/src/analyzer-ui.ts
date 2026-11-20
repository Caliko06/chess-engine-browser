// Analyzer UI (ADR-0242): the HTML surface of the exact CLI analysis pipeline
// (just analyze pgn) with the local Stockfish oracle. First-class section owned here,
// mounted by the app shell below the Explore board. Presentational state only; the
// engine pipeline lives server-side in scripts/preview-analyzer-endpoint.mjs.
import { copyFor, type UiLocale } from "./ui-localization.js";

export type AnalyzerEndpointRequest = {
  readonly mode: "pgn";
  readonly pgn: string;
  readonly side: "white" | "black";
  readonly depth: number;
};

export type AnalyzerEndpointResult = {
  readonly ok: boolean;
  readonly report: unknown;
  readonly error?: string | undefined;
};

export type AnalyzerEndpoint = (request: AnalyzerEndpointRequest) => Promise<AnalyzerEndpointResult>;

export type AnalyzerUiDependencies = {
  readonly root: HTMLElement;
  readonly locale?: UiLocale | undefined;
  readonly endpoint?: AnalyzerEndpoint | undefined;
};

export type AnalyzerUiHandle = {
  readonly destroy: () => void;
};

type AnalyzerBand =
  | "best"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "mate-transition";

type AnalyzerOracleStatus = "enabled" | "degraded" | "unavailable" | "unknown";

type AnalyzerLoss =
  | { readonly kind: "pawns"; readonly value: number }
  | { readonly kind: "king-loss" }
  | { readonly kind: "missed-mate" };

type AnalyzerStripMove = {
  readonly ply: number;
  readonly san: string;
  readonly userMove: boolean;
  readonly band: AnalyzerBand | null;
  readonly deltaPawns: number | null;
};

type AnalyzerAttentionItem = {
  readonly ply: number;
  readonly movePrefix: string;
  readonly san: string;
  readonly band: AnalyzerBand | null;
  readonly kind: string | null;
  readonly loss: AnalyzerLoss;
  readonly bestBefore: string | null;
};

type AnalyzerVerdict = {
  readonly lossPawns: number;
  readonly worstSan: string | null;
  readonly worstLossPawns: number | null;
};

type AnalyzerGameView = {
  readonly id: string;
  readonly verdict: AnalyzerVerdict | null;
  readonly strip: readonly AnalyzerStripMove[];
  readonly attention: readonly AnalyzerAttentionItem[];
  readonly ownedComparison: boolean;
};

type AnalyzerQuarantinedGame = {
  readonly id: string;
  readonly plies: number;
};

type AnalyzerReportView = {
  readonly oracle: { readonly status: AnalyzerOracleStatus; readonly depth: number | null };
  readonly quarantined: readonly AnalyzerQuarantinedGame[];
  readonly game: AnalyzerGameView | null;
};

type AnalyzerErrorReason = "endpoint-unavailable" | "invalid-pgn" | "failed" | "invalid-report";

type AnalyzerSurfaceState = {
  readonly pgn: string;
  readonly side: "white" | "black";
  readonly depth: number;
  readonly phase: "idle" | "running" | "done" | "error";
  readonly progressSeconds: number;
  readonly fileName: string;
  readonly report: AnalyzerReportView | null;
  readonly error: AnalyzerErrorReason | null;
};

type RawAnalyzerLabel = {
  readonly ply?: unknown;
  readonly side?: unknown;
  readonly kind?: unknown;
  readonly severity?: unknown;
  readonly detail?: Record<string, unknown> | null;
};
type RawAnalyzerMove = {
  readonly ply?: unknown;
  readonly side?: unknown;
  readonly san?: unknown;
};
type RawAnalyzerGame = {
  readonly id?: unknown;
  readonly selectedSide?: unknown;
  readonly moves?: readonly RawAnalyzerMove[];
  readonly labels?: readonly RawAnalyzerLabel[];
};
type RawAnalyzerReport = {
  readonly oracle?: { readonly status?: unknown; readonly depth?: unknown };
  readonly understanding?: {
    readonly quarantined?: readonly {
      readonly id?: unknown;
      readonly plies?: unknown;
    }[];
  };
  readonly games?: readonly RawAnalyzerGame[];
};

const analyzerBands: readonly AnalyzerBand[] = [
  "best",
  "good",
  "inaccuracy",
  "mistake",
  "blunder",
  "mate-transition"
];

// Table language mirrors the CLI reading output (analyze-game.mjs BAND_STYLE /
// ATTENTION_KIND_LABELS): the report language is the CLI contract, not UI copy.
const analyzerAttentionKindCopy: Readonly<Record<string, string>> = {
  "early-queen-activity": "Actividad temprana de dama",
  "repeated-early-piece-origin": "Repetición temprana de pieza",
  "shallow-recommendation-failure": "La recomendación superficial falló",
  "oracle-refuted-candidate": "Candidato refutado por el Oracle"
};

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? value : ([] as unknown as readonly T[]);
}

function reportView(payload: unknown): AnalyzerReportView | null {
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const report = payload as RawAnalyzerReport;
  if (
    report.oracle === undefined &&
    report.understanding === undefined &&
    report.games === undefined
  ) {
    return null;
  }
  const games = asArray(report.games);
  const oracle = report.oracle ?? null;
  const rawStatus = oracle === null ? null : oracle.status;
  const oracleStatus: AnalyzerOracleStatus =
    rawStatus === "enabled" || rawStatus === "degraded" || rawStatus === "unavailable"
      ? rawStatus
      : "unknown";
  const quarantined = asArray(report.understanding?.quarantined).map((entry) => ({
    id: asString(entry.id) ?? "unknown",
    plies: asNumber(entry.plies) ?? 0
  }));
  let game: AnalyzerGameView | null = null;
  for (const candidate of games) {
    game = gameView(candidate);
    if (game !== null) {
      break;
    }
  }
  return {
    oracle: {
      status: oracleStatus,
      depth: oracle === null ? null : asNumber(oracle.depth)
    },
    quarantined,
    game
  };
}

function lossOf(entry: { readonly detail?: Record<string, unknown> | null }): AnalyzerLoss | null {
  const detail = entry.detail ?? {};
  const delta = asNumber(detail.deltaCp);
  if (delta === null || delta >= 0) {
    return null;
  }
  if (detail.deltaClass === "mate-transition") {
    const after = asNumber(detail.moverCpAfter);
    return after !== null && after <= -99_000 ? { kind: "king-loss" } : { kind: "missed-mate" };
  }
  return { kind: "pawns", value: Math.round((-delta / 100) * 10) / 10 };
}

function lossRank(loss: AnalyzerLoss): number {
  if (loss.kind === "king-loss") {
    return 1_000_000_000;
  }
  if (loss.kind === "missed-mate") {
    return 100_000;
  }
  return Math.round(loss.value * 100);
}

function bandOf(entry: RawAnalyzerLabel): AnalyzerBand | null {
  const band = entry.detail?.qualityBand;
  return typeof band === "string" && analyzerBands.includes(band as AnalyzerBand)
    ? band as AnalyzerBand
    : null;
}

function gameView(game: RawAnalyzerGame): AnalyzerGameView | null {
  const moves = asArray(game.moves);
  const labels = asArray(game.labels);
  if (moves.length === 0) {
    return null;
  }
  const id = asString(game.id) ?? "unknown";
  const selectedSide = asString(game.selectedSide) === "black" ? "black" : "white";
  const sanByPly = new Map<number, string>();
  const prefixByPly = new Map<number, string>();
  for (const move of moves) {
    const ply = asNumber(move.ply);
    if (ply === null) {
      continue;
    }
    sanByPly.set(ply, asString(move.san) ?? "—");
    prefixByPly.set(
      ply,
      move.side === "black"
        ? `${String(Math.ceil(ply / 2))}…`
        : `${String(Math.ceil(ply / 2))}.`
    );
  }
  const oracleByPly = new Map<number, RawAnalyzerLabel>();
  const userSeverityLabels: RawAnalyzerLabel[] = [];
  let ownedComparison = false;
  for (const entry of labels) {
    if (entry.kind === "owned-engine-move-comparison") {
      ownedComparison = true;
      continue;
    }
    const ply = asNumber(entry.ply);
    if (entry.kind === "oracle-move-delta" && ply !== null) {
      oracleByPly.set(ply, entry);
    }
    if (
      ply !== null &&
      asString(entry.side) === selectedSide &&
      (entry.severity === "fail" || entry.severity === "watch")
    ) {
      userSeverityLabels.push(entry);
    }
  }
  const strip: AnalyzerStripMove[] = moves
    .filter((move) => asNumber(move.ply) !== null)
    .map((move) => {
      const ply = asNumber(move.ply) as number;
      const oracle = oracleByPly.get(ply);
      const loss = oracle === undefined ? null : lossOf(oracle);
      return {
        ply,
        san: sanByPly.get(ply) ?? "—",
        userMove: asString(move.side) === selectedSide,
        band: oracle === undefined ? null : bandOf(oracle),
        deltaPawns: loss !== null && loss.kind === "pawns" ? -loss.value : null
      };
    });
  const userOracle = [...oracleByPly.values()].filter(
    (entry) => asString(entry.side) === selectedSide
  );
  const lossCpTotal = userOracle.reduce((total, entry) => {
    const delta = asNumber(entry.detail?.deltaCp);
    return delta !== null && delta < 0 ? total - delta : total;
  }, 0);
  const worstEntry = userOracle
    .map((entry) => ({ entry, loss: lossOf(entry) }))
    .filter((item): item is { entry: RawAnalyzerLabel; loss: AnalyzerLoss } => item.loss !== null)
    .sort((left, right) => lossRank(right.loss) - lossRank(left.loss))[0] ?? null;
  const verdict: AnalyzerVerdict | null =
    lossCpTotal > 0
      ? {
          lossPawns: Math.round(lossCpTotal) / 100,
          worstSan:
            worstEntry === null
              ? null
              : sanByPly.get(asNumber(worstEntry.entry.ply) ?? -1) ?? null,
          worstLossPawns:
            worstEntry !== null && worstEntry.loss.kind === "pawns" ? worstEntry.loss.value : null
        }
      : null;
  const seenPlies = new Set<number>();
  const attention: AnalyzerAttentionItem[] = [];
  for (const entry of [...userSeverityLabels].sort((left, right) => {
    const rankLeft = left.severity === "fail" ? 0 : 1;
    const rankRight = right.severity === "fail" ? 0 : 1;
    const lossLeft = asNumber(left.detail?.deltaCp) ?? 0;
    const lossRight = asNumber(right.detail?.deltaCp) ?? 0;
    const plyLeft = asNumber(left.ply) ?? 0;
    const plyRight = asNumber(right.ply) ?? 0;
    return rankLeft - rankRight || lossLeft - lossRight || plyLeft - plyRight;
  })) {
    const ply = asNumber(entry.ply);
    if (ply === null || seenPlies.has(ply)) {
      continue;
    }
    seenPlies.add(ply);
    const oracle = oracleByPly.get(ply);
    const loss = entry.kind === "oracle-move-delta" ? lossOf(entry) : null;
    if (loss === null && entry.kind === "oracle-move-delta") {
      continue;
    }
    attention.push({
      ply,
      movePrefix: prefixByPly.get(ply) ?? "",
      san: sanByPly.get(ply) ?? "—",
      band: oracle === undefined ? null : bandOf(oracle),
      kind: asString(entry.kind),
      loss: loss ?? lossOf({ detail: oracle?.detail ?? null }) ?? { kind: "pawns", value: 0 },
      bestBefore: oracle === undefined ? null : asString(oracle.detail?.bestBefore)
    });
  }
  return { id, verdict, strip, attention, ownedComparison };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function errorLabel(error: AnalyzerErrorReason, copy: ReturnType<typeof copyFor>): string {
  if (error === "endpoint-unavailable") {
    return copy.analyzerSurface.endpointUnavailable;
  }
  if (error === "invalid-pgn") {
    return copy.analyzerSurface.invalidPgn;
  }
  if (error === "invalid-report") {
    return copy.analyzerSurface.invalidReport;
  }
  return copy.analyzerSurface.analysisFailed;
}

function renderOracleStatus(status: AnalyzerOracleStatus, copy: ReturnType<typeof copyFor>): string {
  const label =
    status === "enabled"
      ? copy.analyzerSurface.oracleEnabled
      : status === "degraded"
        ? copy.analyzerSurface.oracleDegraded
        : status === "unavailable"
          ? copy.analyzerSurface.oracleUnavailable
          : "—";
  return [
    `<p data-analyzer-ui="oracle" data-oracle="${status}">`,
    `<span>${escapeHtml(copy.analyzerSurface.oracleLabel)}</span>`,
    `<strong>${escapeHtml(label)}</strong>`,
    `</p>`
  ].join("");
}

function renderBand(band: AnalyzerBand | null, copy: ReturnType<typeof copyFor>): string {
  if (band === null) {
    return "";
  }
  const label =
    band === "best"
      ? copy.analyzerSurface.bandBest
      : band === "good"
        ? copy.analyzerSurface.bandGood
        : band === "inaccuracy"
          ? copy.analyzerSurface.bandInaccuracy
          : band === "mistake"
            ? copy.analyzerSurface.bandMistake
            : band === "blunder"
              ? copy.analyzerSurface.bandBlunder
              : copy.analyzerSurface.bandMateTransition;
  return `<span data-analyzer-ui="band" data-band="${band}">${escapeHtml(label)}</span>`;
}

function renderDelta(deltaPawns: number | null): string {
  if (deltaPawns === null || deltaPawns >= 0) {
    return "";
  }
  return `<span data-analyzer-ui="delta">−${escapeHtml(Math.abs(deltaPawns).toFixed(1))}</span>`;
}

function renderVerdict(verdict: AnalyzerVerdict | null, copy: ReturnType<typeof copyFor>): string {
  if (verdict === null) {
    return `<p data-analyzer-ui="verdict" data-verdict="clean">${escapeHtml(
      copy.analyzerSurface.verdictNone
    )}</p>`;
  }
  const a = copy.analyzerSurface;
  const pawns = verdict.lossPawns.toFixed(1);
  const worstDetail =
    verdict.worstSan !== null && verdict.worstLossPawns !== null
      ? `${a.verdictWorst}: ${escapeHtml(verdict.worstSan)} (−${verdict.worstLossPawns.toFixed(
          1
        )}).`
      : "";
  return [
    `<div data-analyzer-ui="verdict" data-verdict="damaging">`,
    `<p data-analyzer-ui="verdict-hero">`,
    `<span data-analyzer-ui="verdict-label">${escapeHtml(a.verdictLosses)}</span>`,
    `<strong data-analyzer-ui="verdict-total">~${pawns}<small> ${escapeHtml(
      a.verdictPawns
    )}</small></strong>`,
    `</p>`,
    worstDetail === "" ? "" : `<p data-analyzer-ui="verdict-detail">${worstDetail}</p>`,
    `</div>`
  ].join("");
}

function renderStripDisclosure(
  strip: readonly AnalyzerStripMove[],
  copy: ReturnType<typeof copyFor>
): string {
  return [
    `<details data-analyzer-ui="strip-disclosure">`,
    `<summary><span>${escapeHtml(copy.analyzerSurface.stripTitle)}</span><small>${String(
      strip.length
    )}</small></summary>`,
    renderStrip(strip, copy),
    `</details>`
  ].join("");
}

function renderStrip(strip: readonly AnalyzerStripMove[], copy: ReturnType<typeof copyFor>): string {
  return [
    `<div data-analyzer-ui="strip" role="list" aria-label="${escapeHtml(
      copy.analyzerSurface.stripTitle
    )}">`,
    strip
      .map((item) => {
        const role = item.userMove ? copy.analyzerSurface.userTag : copy.analyzerSurface.rivalTag;
        return [
          `<span role="listitem" data-analyzer-ui="move" data-user="${
            item.userMove ? "true" : "false"
          }"${item.band === null ? "" : ` data-band="${item.band}"`}>`,
          `<span data-analyzer-ui="san">${escapeHtml(item.san)}</span>`,
          renderBand(item.band, copy),
          renderDelta(item.deltaPawns),
          `<small>${escapeHtml(role)}</small>`,
          `</span>`
        ].join("");
      })
      .join(""),
    `</div>`
  ].join("");
}

function renderAttention(
  attention: readonly AnalyzerAttentionItem[],
  copy: ReturnType<typeof copyFor>
): string {
  return [
    `<section data-analyzer-ui="attention" aria-labelledby="analyzer-attention-title">`,
    `<h4 id="analyzer-attention-title">${escapeHtml(copy.analyzerSurface.attentionTitle)}</h4>`,
    attention.length === 0 ? `<p>${escapeHtml(copy.analyzerSurface.attentionNone)}</p>` : `<ol>`,
    attention
      .map((item) => {
        const bandChip =
          item.band !== null
            ? [
                item.band === "good" ? "" : renderBand(item.band, copy),
                item.loss.kind === "pawns" ? renderDelta(-item.loss.value) : ""
              ].join("")
            : "";
        const kindLabel =
          item.kind === null
            ? ""
              : `<span data-analyzer-ui="attention-kind">${escapeHtml(
                analyzerAttentionKindCopy[item.kind] ?? ""
              )}</span>`;
        const lossLabel =
          item.loss.kind === "king-loss"
            ? `<span data-analyzer-ui="attention-loss" data-loss="king">${escapeHtml(
                copy.analyzerSurface.lostKing
              )}</span>`
            : item.loss.kind === "missed-mate"
              ? `<span data-analyzer-ui="attention-loss" data-loss="mate">${escapeHtml(
                  copy.analyzerSurface.missedMate
                )}</span>`
              : "";
        const best =
          item.bestBefore === null
            ? ""
            : `<span data-analyzer-ui="attention-best">${escapeHtml(
                copy.analyzerSurface.bestLabel
              )} ${escapeHtml(item.bestBefore)}</span>`;
        return `<li data-attention-ply="${String(item.ply)}"><span>${escapeHtml(
          item.movePrefix + item.san
        )}</span>${bandChip}${lossLabel}${best}${kindLabel}</li>`;
      })
      .join(""),
    attention.length === 0 ? "" : `</ol>`,
    `</section>`
  ].join("");
}

function renderReport(state: AnalyzerSurfaceState, copy: ReturnType<typeof copyFor>): string {
  const report = state.report;
  if (report === null) {
    return "";
  }
  const a = copy.analyzerSurface;
  const quarantined =
    report.quarantined.length === 0
      ? ""
      : [
          `<section data-analyzer-ui="quarantine" aria-labelledby="analyzer-quarantine-title">`,
          `<h4 id="analyzer-quarantine-title">${escapeHtml(a.quarantineTitle)}</h4>`,
          report.quarantined
            .map((entry) => `<p>${escapeHtml(entry.id)} · ${String(entry.plies)} plies</p>`)
            .join(""),
          `</section>`
        ].join("");
  if (report.game === null) {
    return [
      `<div data-analyzer-ui="report">`,
      renderOracleStatus(report.oracle.status, copy),
      quarantined,
      `<p data-analyzer-ui="no-games">${escapeHtml(a.noGames)}</p>`,
      `</div>`
    ].join("");
  }
  return [
    `<div data-analyzer-ui="report">`,
    renderOracleStatus(report.oracle.status, copy),
    quarantined,
    renderVerdict(report.game.verdict, copy),
    renderStripDisclosure(report.game.strip, copy),
    renderAttention(report.game.attention, copy),
    report.game.ownedComparison
      ? `<p data-analyzer-ui="owned-note">${escapeHtml(a.ownedNote)}</p>`
      : "",
    `</div>`
  ].join("");
}

function render(state: AnalyzerSurfaceState, copy: ReturnType<typeof copyFor>): string {
  const a = copy.analyzerSurface;
  const running = state.phase === "running";
  const body = [
    `<div data-analyzer-ui="body">`,
    `<label data-analyzer-ui="pgn-label" for="analyzer-pgn-input">${escapeHtml(a.pgnLabel)}</label>`,
    `<textarea id="analyzer-pgn-input" data-analyzer-ui="pgn-input" placeholder="${escapeHtml(
      a.pgnPlaceholder
    )}"${running ? " disabled" : ""}>${escapeHtml(state.pgn)}</textarea>`,
    `<div data-analyzer-ui="input-row">`,
    `<div data-analyzer-ui="side" role="group" aria-label="${escapeHtml(a.sideLabel)}">`,
    `<span data-analyzer-ui="side-name">${escapeHtml(a.sideLabel)}</span>`,
    `<button type="button" data-analyzer-ui="side-white" aria-pressed="${
      state.side === "white" ? "true" : "false"
    }"${running ? " disabled" : ""}>${escapeHtml(copy.white)}</button>`,
    `<button type="button" data-analyzer-ui="side-black" aria-pressed="${
      state.side === "black" ? "true" : "false"
    }"${running ? " disabled" : ""}>${escapeHtml(copy.black)}</button>`,
    `</div>`,
    `<div data-analyzer-ui="depth" role="group" aria-label="${escapeHtml(a.depthLabel)}">`,
    `<span data-analyzer-ui="depth-name">${escapeHtml(a.depthLabel)}</span>`,
    `<button type="button" data-analyzer-ui="depth-12" aria-pressed="${
      state.depth === 12 ? "true" : "false"
    }"${running ? " disabled" : ""}>12</button>`,
    `<button type="button" data-analyzer-ui="depth-16" aria-pressed="${
      state.depth === 16 ? "true" : "false"
    }"${running ? " disabled" : ""}>16</button>`,
    `</div>`,
    `<button type="button" data-analyzer-ui="file-button"${running ? " disabled" : ""}>${escapeHtml(
      a.fileButton
    )}</button>`,
    `<input id="analyzer-file-input" type="file" accept=".pgn,text/plain" data-analyzer-ui="file-input" tabindex="-1" aria-label="${escapeHtml(
      a.fileLabel
    )}"${running ? " disabled" : ""}>`,
    `<span data-analyzer-ui="file-name">${escapeHtml(
      state.fileName === "" ? a.fileNone : state.fileName
    )}</span>`,
    `</div>`,
    `<button type="button" data-analyzer-ui="run"${running ? " disabled" : ""}>${escapeHtml(
      a.analyzeButton
    )}</button>`,
    running
      ? `<p data-analyzer-ui="progress" aria-live="polite">${escapeHtml(a.analyzing)} <span data-analyzer-ui="progress-seconds">${String(
          state.progressSeconds
        )}s</span></p>`
      : "",
    state.error === null
      ? ""
      : `<p data-analyzer-ui="error" role="alert">${escapeHtml(errorLabel(state.error, copy))}</p>`,
    state.phase === "done" && state.error === null ? renderReport(state, copy) : "",
    `</div>`
  ].join("");
  return [
    `<section data-analyzer-ui="section" data-phase="${state.phase}" aria-labelledby="analyzer-title">`,
    `<header data-analyzer-ui="header">`,
    `<h2 id="analyzer-title">${escapeHtml(a.section)}</h2>`,
    `<small>${escapeHtml(a.hint)}</small>`,
    `</header>`,
    body,
    `</section>`
  ].join("");
}

export function mountAnalyzerUi(dependencies: AnalyzerUiDependencies): AnalyzerUiHandle {
  const root = dependencies.root;
  let destroyed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let state: AnalyzerSurfaceState = {
    pgn: "",
    side: "white",
    depth: 12,
    phase: "idle",
    progressSeconds: 0,
    fileName: "",
    report: null,
    error: null
  };

  const isDestroyed = (): boolean => destroyed;

  const renderNow = (): void => {
    if (isDestroyed()) {
      return;
    }
    root.innerHTML = render(state, copyFor(dependencies.locale ?? "en"));
    bind();
  };

  const patch = (next: Partial<AnalyzerSurfaceState>): void => {
    state = { ...state, ...next };
    renderNow();
  };

  const stopTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const run = async (): Promise<void> => {
    if (destroyed || state.phase === "running") {
      return;
    }
    if (state.pgn.trim() === "") {
      patch({ phase: "error", error: "invalid-pgn" });
      return;
    }
    stopTimer();
    state = { ...state, phase: "running", progressSeconds: 0, error: null, report: null };
    renderNow();
    timer = setInterval(() => {
      if (!destroyed && state.phase === "running") {
        state = { ...state, progressSeconds: state.progressSeconds + 1 };
        renderNow();
      }
    }, 1000);
    try {
      const depth = state.depth;
      const side = state.side;
      const pgn = state.pgn;
      let response: AnalyzerEndpointResult;
      if (dependencies.endpoint) {
        response = await dependencies.endpoint({ mode: "pgn", pgn, side, depth });
      } else {
        // eslint-disable-next-line no-restricted-globals -- ADR-0242 allows this same-origin analyzer endpoint only.
        const raw = await fetch("/analyzer/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "pgn", pgn, side, depth })
        });
        response = raw.ok
          ? { ok: true, report: ((await raw.json()) as { readonly report: unknown }).report }
          : { ok: false, report: null, error: "request failed" };
      }
      if (isDestroyed()) {
        return;
      }
      if (!response.ok) {
        const reason = response.error;
        patch({
          phase: "error",
          error: typeof reason === "string" && /pgn/iu.test(reason) ? "invalid-pgn" : "failed"
        });
        return;
      }
      const view = reportView(response.report);
      if (view === null) {
        patch({ phase: "error", error: "invalid-report" });
        return;
      }
      patch({ phase: "done", report: view });
    } catch {
      if (!isDestroyed()) {
        patch({ phase: "error", error: "endpoint-unavailable" });
      }
    } finally {
      stopTimer();
    }
  };

  const bind = (): void => {
    const pgnInput = root.querySelector('[data-analyzer-ui="pgn-input"]');
    pgnInput?.addEventListener("input", () => {
      const value = (pgnInput as { readonly value?: unknown }).value;
      if (!isDestroyed() && typeof value === "string") {
        state = { ...state, pgn: value };
      }
    });
    const click = (name: string, listener: () => void): void => {
      root.querySelector(`[data-analyzer-ui="${name}"]`)?.addEventListener("click", () => {
        if (!destroyed) {
          listener();
        }
      });
    };
    click("side-white", () => {
      patch({ side: "white" });
    });
    click("side-black", () => {
      patch({ side: "black" });
    });
    click("depth-12", () => {
      patch({ depth: 12 });
    });
    click("depth-16", () => {
      patch({ depth: 16 });
    });
    click("run", () => {
      void run();
    });
    click("file-button", () => {
      const input = root.querySelector('[data-analyzer-ui="file-input"]') as
        | { click(): void }
        | null;
      input?.click();
    });
    const fileInput = root.querySelector('[data-analyzer-ui="file-input"]');
    fileInput?.addEventListener("change", () => {
      const files = (fileInput as { readonly files?: { readonly [index: number]: { text(): Promise<string>; readonly name: string } } | null }).files;
      const file = files?.[0];
      if (file === undefined) {
        return;
      }
      void file.text().then((text) => {
        if (!destroyed) {
          patch({ pgn: text, fileName: file.name });
        }
      });
    });
  };

  renderNow();

  return {
    destroy: () => {
      destroyed = true;
      stopTimer();
    }
  };
}
