import type { EngineStateDto, MoveQualityDto } from "./engine-dtos.js";

export type BoardFile = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";
export type BoardRank = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";
export type BoardSquare = `${BoardFile}${BoardRank}`;

type BoardColor = "white" | "black";
type BoardPieceKind = "king" | "queen" | "rook" | "bishop" | "knight" | "pawn";

type FenPiece = {
  readonly symbol: string;
  readonly color: BoardColor;
  readonly kind: BoardPieceKind;
};

type FenBoard = {
  readonly activeColor: BoardColor;
  readonly pieces: ReadonlyMap<BoardSquare, FenPiece>;
};

export type PlayBoardMotion = {
  readonly actor: "engine";
  readonly move: string;
  readonly from: BoardSquare;
  readonly to: BoardSquare;
  readonly durationMs: number;
};

type PlayBoardRenderState = {
  readonly engineState: EngineStateDto | null;
  readonly selectedSquare: BoardSquare | null;
  readonly lastMove: string | null;
  readonly acceptsInput: boolean;
  readonly playerSide: BoardColor;
  readonly inputSide: BoardColor;
  readonly activeMotion: PlayBoardMotion | null;
  readonly reactionLine?: readonly string[];
  readonly reactionPrimaryHanging?: boolean;
  readonly reactionPrimaryMating?: boolean;
  readonly reactionPrimaryOpening?: boolean;
  /// Off-turn: the lead reaction arrow is the opponent's assumed reply, not `side`'s move.
  readonly reactionPrimaryReply?: ReplyArrow | null;
  /// Off-turn: classified rival replies after the primary lead, capped with the lead to three total.
  readonly replyArrows?: readonly ReplyArrow[];
  readonly lensLine?: readonly string[];
  readonly candidateArrows?: readonly CandidateArrow[];
  readonly freeInput?: boolean;
  readonly labels: PlayBoardLabels;
};

export type PlayBoardLabels = {
  readonly board: string;
  readonly emptySquare: string;
  readonly colors: Readonly<Record<"white" | "black", string>>;
  readonly pieces: Readonly<Record<"king" | "queen" | "rook" | "bishop" | "knight" | "pawn", string>>;
};

/// A suggested alternative move plus how safe it is to play. `mating` forces checkmate within a
/// move or two (the strongest possible, painted a distinct colour), `safe` stays within a pawn of
/// the best idea, `caution` concedes roughly a pawn, and `hanging` drops material (the piece is
/// taken without an answering capture). The classification drives the arrow colour so a blunder no
/// longer looks identical to a real candidate, and a forced mate stands apart from both.
export type CandidateArrowSafety = "mating" | "safe" | "caution" | "hanging";

export type CandidateArrow = {
  readonly move: string;
  readonly safety: CandidateArrowSafety;
  readonly role?: "alternative" | "diagnostic";
  readonly displayRank?: number;
  readonly riskRank?: number;
  readonly riskLabel?: "least-bad-risk" | "risky-alternative" | "avoid";
  /// Engine move-quality verdict for this candidate, exposed as a `data-candidate-quality` attribute
  /// on the arrow for styling/inspection. Absent for the forcing lens (whose moves carry their own
  /// kind/soundness semantics instead).
  readonly quality?: MoveQualityDto;
  /// SEE-negative but sound: the piece goes to a square where it can be taken, yet the follow-up
  /// justifies the concession. Exposed as `data-candidate-sacrifice="true"` for distinct styling.
  readonly sacrifice?: boolean;
  /// Aftermath of a sound sacrifice: `accepted` (opponent recaptures yet the line holds) or
  /// `defended` (opponent declines the offer). Exposed as `data-candidate-aftermath` so the board can
  /// distinguish a sacrifice that works when taken from one that simply stands (ADR-0154 Packet C).
  readonly aftermath?: "accepted" | "defended";
  readonly opening?: boolean;
};

export type ReplyArrow = {
  readonly move: string;
  readonly safety: CandidateArrowSafety;
  readonly quality?: MoveQualityDto;
  readonly sacrifice?: boolean;
};

const reactionArrowMax = 4;
const candidateArrowMax = 7;
const rivalReplyArrowTotalMax = 3;
const replyArrowLayerMax = rivalReplyArrowTotalMax - 1;

const boardFiles = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const blackViewFiles = ["h", "g", "f", "e", "d", "c", "b", "a"] as const;
const whiteRanks = ["8", "7", "6", "5", "4", "3", "2", "1"] as const;
const boardRanks = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;

export function renderPlayBoard(state: PlayBoardRenderState): string {
  const board = state.engineState === null ? null : parseFenBoard(state.engineState.fen);
  if (board === null) {
    return `<div data-play-ui="board" data-board-state="loading" aria-label="${escapeHtml(state.labels.board)}"></div>`;
  }
  const legalTargets = state.selectedSquare === null ? [] : legalTargetsFrom(board, state);
  const viewRanks = state.playerSide === "black" ? boardRanks : whiteRanks;
  const viewFiles = state.playerSide === "black" ? blackViewFiles : boardFiles;
  const activeMotion = renderableMotion(board, state.activeMotion, viewFiles, viewRanks);
  return [
    `<div data-play-ui="board" data-board-state="ready" data-board-active-side="${board.activeColor}" data-board-orientation="${state.playerSide}">`,
    `<div data-play-ui="rank-labels" aria-hidden="true">`,
    viewRanks
      .map((rank) => `<span data-play-ui="rank-label" data-board-rank="${rank}">${rank}</span>`)
      .join(""),
    `</div>`,
    `<div data-play-ui="board-grid" role="grid" aria-label="${escapeHtml(state.labels.board)}">`,
    viewRanks
      .flatMap((rank) =>
        viewFiles.map((file) =>
          renderBoardSquare(
            `${file}${rank}`,
            board.pieces.get(`${file}${rank}`) ?? null,
            state,
            legalTargets,
            activeMotion
          )
        )
      )
      .join(""),
    renderLensArrow(state.lensLine ?? [], viewFiles, viewRanks),
    renderCandidateArrows(state.candidateArrows ?? [], viewFiles, viewRanks),
    renderReplyArrows(state.replyArrows ?? [], viewFiles, viewRanks),
    renderReactionArrows(
      state.reactionLine ?? [],
      state.reactionPrimaryHanging ?? false,
      state.reactionPrimaryMating ?? false,
      state.reactionPrimaryOpening ?? false,
      state.reactionPrimaryReply ?? null,
      viewFiles,
      viewRanks
    ),
    `</div>`,
    `<div></div>`,
    `<div data-play-ui="file-labels" aria-hidden="true">`,
    viewFiles
      .map((file) => `<span data-play-ui="file-label" data-board-file="${file}">${file}</span>`)
      .join(""),
    `</div>`,
    `</div>`
  ].join("");
}

export function isBoardSquare(value: string): value is BoardSquare {
  if (value.length !== 2) {
    return false;
  }
  const [file, rank] = value;
  return isBoardFile(file) && isBoardRank(rank);
}

export function hasLegalMoveFrom(state: EngineStateDto, square: BoardSquare): boolean {
  return state.legalMoves.some((move) => move.startsWith(square));
}

// Maps king-to-rook notation (Chess.com style) to the engine's king-to-destination notation.
const castlingRookToDestination: ReadonlyMap<string, string> = new Map([
  ["e1h1", "e1g1"],
  ["e1a1", "e1c1"],
  ["e8h8", "e8g8"],
  ["e8a8", "e8c8"]
]);

export function legalMovesFromSelection(
  state: EngineStateDto,
  from: BoardSquare,
  to: BoardSquare
): readonly string[] {
  const prefix = `${from}${to}`;
  const direct = state.legalMoves.filter((move) => move === prefix || move.startsWith(prefix));
  if (direct.length > 0) return direct;
  // King-to-rook drag: translate to king-to-destination castling move.
  const castleMove = castlingRookToDestination.get(prefix);
  return castleMove !== undefined && state.legalMoves.includes(castleMove) ? [castleMove] : [];
}

export function legalTargetsFromSelection(
  state: EngineStateDto,
  from: BoardSquare,
  inputSide: EngineStateDto["sideToMove"]
): readonly BoardSquare[] {
  const board = parseFenBoard(state.fen);
  if (board === null) {
    return [];
  }
  return legalTargetsFrom(board, { engineState: state, selectedSquare: from, inputSide });
}

function renderBoardSquare(
  square: BoardSquare,
  piece: FenPiece | null,
  state: PlayBoardRenderState,
  legalTargets: readonly BoardSquare[],
  activeMotion: RenderableBoardMotion | null
): string {
  const selected = state.selectedSquare === square;
  const legalTarget = legalTargets.some((target) => target === square);
  const motionFrom = activeMotion?.from === square;
  const motionTo = activeMotion?.to === square;
  const inLastMove =
    state.lastMove !== null &&
    (state.lastMove.startsWith(square) || state.lastMove.slice(2, 4) === square);
  const canMove =
    state.acceptsInput &&
    (state.freeInput === true || (state.engineState !== null && state.engineState.status === "ongoing"));
  const canDrag =
    canMove &&
    piece !== null &&
    (state.freeInput === true || (piece.color === state.inputSide && state.engineState !== null && hasLegalMoveFrom(state.engineState, square)));
  const label =
    piece === null
      ? `${square}, ${state.labels.emptySquare}`
      : `${square}, ${state.labels.pieces[piece.kind]} ${state.labels.colors[piece.color]}`;
  return [
    `<button type="button" data-play-ui="board-square" data-square="${square}"`,
    ` data-board-shade="${boardSquareShade(square)}" data-board-selected="${String(selected)}"`,
    ` data-board-legal-target="${String(legalTarget)}" data-board-last-move="${String(inLastMove)}"`,
    ` data-board-motion-from="${String(motionFrom)}" data-board-motion-to="${String(motionTo)}"`,
    ` data-board-draggable="${String(canDrag)}"`,
    piece === null
      ? ""
      : ` data-board-piece="${escapeHtml(piece.symbol)}" data-board-piece-color="${
          piece.color
        }" data-board-piece-kind="${piece.kind}"`,
    ` aria-label="${escapeHtml(label)}" aria-pressed="${String(selected)}" role="gridcell"${
      canMove ? "" : " disabled"
    }>`,
    piece === null ? "" : `<span data-play-ui="board-piece" aria-hidden="true">${boardPieceGlyphHtml(piece)}</span>`,
    legalTarget ? `<span data-play-ui="legal-dot" aria-hidden="true"></span>` : "",
    motionFrom ? renderBoardMotion(activeMotion) : "",
    `</button>`
  ].join("");
}

type RenderableBoardMotion = PlayBoardMotion & {
  readonly piece: FenPiece;
  readonly deltaColumn: number;
  readonly deltaRow: number;
};

function renderableMotion(
  board: FenBoard,
  motion: PlayBoardMotion | null,
  viewFiles: readonly BoardFile[],
  viewRanks: readonly BoardRank[]
): RenderableBoardMotion | null {
  if (motion === null) {
    return null;
  }
  const piece = board.pieces.get(motion.from);
  const fromColumn = viewFiles.indexOf(squareFile(motion.from));
  const fromRow = viewRanks.indexOf(squareRank(motion.from));
  const toColumn = viewFiles.indexOf(squareFile(motion.to));
  const toRow = viewRanks.indexOf(squareRank(motion.to));
  if (
    piece === undefined ||
    fromColumn < 0 ||
    fromRow < 0 ||
    toColumn < 0 ||
    toRow < 0 ||
    motion.durationMs <= 0
  ) {
    return null;
  }
  return { ...motion, piece, deltaColumn: toColumn - fromColumn, deltaRow: toRow - fromRow };
}

function renderBoardMotion(motion: RenderableBoardMotion | null): string {
  if (motion === null) {
    return "";
  }
  return [
    `<span data-play-ui="board-motion-piece" data-board-motion-actor="${motion.actor}"`,
    ` data-board-motion-move="${escapeHtml(motion.move)}" data-board-motion-from="${motion.from}"`,
    ` data-board-motion-to="${motion.to}" data-board-motion-duration-ms="${String(
      motion.durationMs
    )}" data-board-motion-delta-column="${String(
      motion.deltaColumn
    )}" data-board-motion-delta-row="${String(motion.deltaRow)}" data-board-piece-color="${
      motion.piece.color
    }" data-board-piece-kind="${motion.piece.kind}"`,
    ` aria-hidden="true">`,
    `<span data-play-ui="board-piece">${boardPieceGlyphHtml(motion.piece)}</span>`,
    `</span>`
  ].join("");
}

function renderCandidateArrows(
  candidates: readonly CandidateArrow[],
  viewFiles: readonly BoardFile[],
  viewRanks: readonly BoardRank[]
): string {
  const segments: string[] = [];
  for (const [index, candidate] of candidates.slice(0, candidateArrowMax).entries()) {
    const move = candidate.move;
    const from = move.slice(0, 2);
    const to = move.slice(2, 4);
    if (!isBoardSquare(from) || !isBoardSquare(to)) {
      continue;
    }
    const fromColumn = viewFiles.indexOf(squareFile(from));
    const fromRow = viewRanks.indexOf(squareRank(from));
    const toColumn = viewFiles.indexOf(squareFile(to));
    const toRow = viewRanks.indexOf(squareRank(to));
    if (fromColumn < 0 || fromRow < 0 || toColumn < 0 || toRow < 0) {
      continue;
    }
    const segment = reactionArrowSegment(
      { x: fromColumn + 0.5, y: fromRow + 0.5 },
      { x: toColumn + 0.5, y: toRow + 0.5 }
    );
    if (segment === null) {
      continue;
    }
    const qualityAttribute =
      candidate.quality === undefined ? "" : ` data-candidate-quality="${candidate.quality}"`;
    const sacrificeAttribute =
      candidate.sacrifice === true ? ` data-candidate-sacrifice="true"` : "";
    const aftermathAttribute =
      candidate.aftermath === undefined ? "" : ` data-candidate-aftermath="${candidate.aftermath}"`;
    const openingAttribute =
      candidate.opening === true ? ` data-candidate-opening="true"` : "";
    const displayRank = candidate.displayRank ?? index + 1;
    const riskRankAttribute =
      candidate.riskRank === undefined ? "" : ` data-candidate-risk-rank="${String(candidate.riskRank)}"`;
    const riskLabelAttribute =
      candidate.riskLabel === undefined ? "" : ` data-candidate-risk-label="${candidate.riskLabel}"`;
    segments.push(
      [
        `<g data-play-ui="candidate-arrow" data-candidate-from="${from}" data-candidate-to="${to}"`,
        ` data-candidate-rank="${String(displayRank)}" data-candidate-safety="${candidate.safety}"`,
        ` data-path-role="${candidate.role ?? "alternative"}" data-path-risk="${candidate.safety}"${riskRankAttribute}${riskLabelAttribute}${qualityAttribute}${sacrificeAttribute}${aftermathAttribute}${openingAttribute}>`,
        `<line x1="${segment.startX}" y1="${segment.startY}" x2="${segment.baseX}" y2="${segment.baseY}"></line>`,
        `<polygon points="${segment.tipX},${segment.tipY} ${segment.leftX},${segment.leftY} ${segment.rightX},${segment.rightY}"></polygon>`,
        renderArrowRankMarker(segment, displayRank, candidate.safety, "candidate"),
        candidate.opening === true
          ? `<circle data-play-ui="opening-marker" cx="${segment.tipX}" cy="${segment.tipY}" r="0.12"></circle>`
          : "",
        `</g>`
      ].join("")
    );
  }
  if (segments.length === 0) {
    return "";
  }
  return [
    `<svg data-play-ui="candidate-arrows" viewBox="0 0 8 8" preserveAspectRatio="none" aria-hidden="true">`,
    segments.join(""),
    `</svg>`
  ].join("");
}

function renderReplyArrows(
  replies: readonly ReplyArrow[],
  viewFiles: readonly BoardFile[],
  viewRanks: readonly BoardRank[]
): string {
  const segments: string[] = [];
  for (const [index, reply] of replies.slice(0, replyArrowLayerMax).entries()) {
    const move = reply.move;
    const from = move.slice(0, 2);
    const to = move.slice(2, 4);
    if (!isBoardSquare(from) || !isBoardSquare(to)) {
      continue;
    }
    const fromColumn = viewFiles.indexOf(squareFile(from));
    const fromRow = viewRanks.indexOf(squareRank(from));
    const toColumn = viewFiles.indexOf(squareFile(to));
    const toRow = viewRanks.indexOf(squareRank(to));
    if (fromColumn < 0 || fromRow < 0 || toColumn < 0 || toRow < 0) {
      continue;
    }
    const segment = reactionArrowSegment(
      { x: fromColumn + 0.5, y: fromRow + 0.5 },
      { x: toColumn + 0.5, y: toRow + 0.5 }
    );
    if (segment === null) {
      continue;
    }
    const qualityAttribute =
      reply.quality === undefined ? "" : ` data-reply-quality="${reply.quality}"`;
    const sacrificeAttribute = reply.sacrifice === true ? ` data-reply-sacrifice="true"` : "";
    segments.push(
      [
        `<g data-play-ui="reply-arrow" data-reply-from="${from}" data-reply-to="${to}"`,
        ` data-reply-rank="${String(index + 2)}" data-reply-primary="false"`,
        ` data-reply-safety="${reply.safety}" data-path-role="reply" data-path-risk="${reply.safety}"`,
        `${qualityAttribute}${sacrificeAttribute}>`,
        `<line x1="${segment.startX}" y1="${segment.startY}" x2="${segment.baseX}" y2="${segment.baseY}"></line>`,
        `<polygon points="${segment.tipX},${segment.tipY} ${segment.leftX},${segment.leftY} ${segment.rightX},${segment.rightY}"></polygon>`,
        renderArrowRankMarker(segment, index + 2, reply.safety, "reply"),
        `</g>`
      ].join("")
    );
  }
  if (segments.length === 0) {
    return "";
  }
  return [
    `<svg data-play-ui="reply-arrows" viewBox="0 0 8 8" preserveAspectRatio="none" aria-hidden="true">`,
    segments.join(""),
    `</svg>`
  ].join("");
}

function renderLensArrow(
  lensLine: readonly string[],
  viewFiles: readonly BoardFile[],
  viewRanks: readonly BoardRank[]
): string {
  const move = lensLine[0];
  if (move === undefined) {
    return "";
  }
  const from = move.slice(0, 2);
  const to = move.slice(2, 4);
  if (!isBoardSquare(from) || !isBoardSquare(to)) {
    return "";
  }
  const fromColumn = viewFiles.indexOf(squareFile(from));
  const fromRow = viewRanks.indexOf(squareRank(from));
  const toColumn = viewFiles.indexOf(squareFile(to));
  const toRow = viewRanks.indexOf(squareRank(to));
  if (fromColumn < 0 || fromRow < 0 || toColumn < 0 || toRow < 0) {
    return "";
  }
  const segment = reactionArrowSegment(
    { x: fromColumn + 0.5, y: fromRow + 0.5 },
    { x: toColumn + 0.5, y: toRow + 0.5 }
  );
  if (segment === null) {
    return "";
  }
  return [
    `<svg data-play-ui="lens-arrow" viewBox="0 0 8 8" preserveAspectRatio="none" aria-hidden="true">`,
    `<g data-lens-from="${from}" data-lens-to="${to}">`,
    `<line x1="${segment.startX}" y1="${segment.startY}" x2="${segment.baseX}" y2="${segment.baseY}"></line>`,
    `<polygon points="${segment.tipX},${segment.tipY} ${segment.leftX},${segment.leftY} ${segment.rightX},${segment.rightY}"></polygon>`,
    `</g>`,
    `</svg>`
  ].join("");
}

function renderReactionArrows(
  reactionLine: readonly string[],
  primaryHanging: boolean,
  primaryMating: boolean,
  primaryOpening: boolean,
  primaryReply: ReplyArrow | null,
  viewFiles: readonly BoardFile[],
  viewRanks: readonly BoardRank[]
): string {
  const segments: string[] = [];
  for (const [index, move] of reactionLine.slice(0, reactionArrowMax).entries()) {
    const from = move.slice(0, 2);
    const to = move.slice(2, 4);
    if (!isBoardSquare(from) || !isBoardSquare(to)) {
      continue;
    }
    const fromColumn = viewFiles.indexOf(squareFile(from));
    const fromRow = viewRanks.indexOf(squareRank(from));
    const toColumn = viewFiles.indexOf(squareFile(to));
    const toRow = viewRanks.indexOf(squareRank(to));
    if (fromColumn < 0 || fromRow < 0 || toColumn < 0 || toRow < 0) {
      continue;
    }
    const segment = reactionArrowSegment(
      { x: fromColumn + 0.5, y: fromRow + 0.5 },
      { x: toColumn + 0.5, y: toRow + 0.5 }
    );
    if (segment === null) {
      continue;
    }
    const order = index + 1;
    // A forced mate takes precedence over the hanging warning on the lead arrow: ending the game
    // outranks any material on the board.
    const mating = order === 1 && primaryMating;
    const hanging = order === 1 && primaryHanging && !mating;
    const rivalReply = order === 1 ? primaryReply : null;
    const rival = rivalReply !== null;
    const opening = order === 1 && primaryOpening && !rival;
    const pathRisk = rivalReply?.safety ?? (mating ? "mate" : hanging ? "hanging" : "clear");
    const qualityAttribute =
      rivalReply?.quality === undefined ? "" : ` data-reaction-quality="${rivalReply.quality}"`;
    const sacrificeAttribute =
      rivalReply?.sacrifice === true ? ` data-reaction-sacrifice="true"` : "";
    const safetyAttribute =
      rivalReply === null ? "" : ` data-reaction-safety="${rivalReply.safety}"`;
    const openingAttribute = opening ? ` data-reaction-opening="true"` : "";
    segments.push(
      [
        `<g data-play-ui="reaction-arrow" data-reaction-from="${from}" data-reaction-to="${to}"`,
        ` data-reaction-order="${String(order)}" data-reaction-primary="${String(order === 1)}"`,
        ` data-reaction-hanging="${String(hanging)}" data-reaction-mating="${String(mating)}"`,
        ` data-reaction-rival="${String(rival)}"`,
        ` data-path-role="${order === 1 ? "main" : "continuation"}" data-path-risk="${pathRisk}"`,
        ` data-reaction-sequence="${order === 1 ? "lead" : "continuation"}"`,
        `${safetyAttribute}${qualityAttribute}${sacrificeAttribute}${openingAttribute}>`,
        `<line x1="${segment.startX}" y1="${segment.startY}" x2="${segment.baseX}" y2="${segment.baseY}"></line>`,
        `<polygon points="${segment.tipX},${segment.tipY} ${segment.leftX},${segment.leftY} ${segment.rightX},${segment.rightY}"></polygon>`,
        opening
          ? `<circle data-play-ui="opening-marker" cx="${segment.tipX}" cy="${segment.tipY}" r="0.12"></circle>`
          : "",
        `</g>`
      ].join("")
    );
  }
  if (segments.length === 0) {
    return "";
  }
  return [
    `<svg data-play-ui="reaction-arrows" viewBox="0 0 8 8" preserveAspectRatio="none" aria-hidden="true">`,
    segments.join(""),
    `</svg>`
  ].join("");
}

function renderArrowRankMarker(
  segment: ReactionArrowSegment,
  rank: number,
  safety: CandidateArrowSafety,
  kind: "candidate" | "reply"
): string {
  return [
    `<g data-play-ui="${kind}-arrow-marker" data-marker-safety="${safety}" aria-hidden="true">`,
    `<circle cx="${segment.tipX}" cy="${segment.tipY}" r="0.16"></circle>`,
    `<text x="${segment.tipX}" y="${segment.tipY}" font-size="0.28">${String(rank)}</text>`,
    `</g>`
  ].join("");
}

type ReactionArrowSegment = {
  readonly startX: string;
  readonly startY: string;
  readonly baseX: string;
  readonly baseY: string;
  readonly tipX: string;
  readonly tipY: string;
  readonly leftX: string;
  readonly leftY: string;
  readonly rightX: string;
  readonly rightY: string;
};

function reactionArrowSegment(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number }
): ReactionArrowSegment | null {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length === 0) {
    return null;
  }
  const unitX = deltaX / length;
  const unitY = deltaY / length;
  const headLength = 0.34;
  const headHalfWidth = 0.2;
  const tailGap = 0.18;
  const tipGap = 0.12;
  const tipX = to.x - unitX * tipGap;
  const tipY = to.y - unitY * tipGap;
  const baseX = tipX - unitX * headLength;
  const baseY = tipY - unitY * headLength;
  const startX = from.x + unitX * tailGap;
  const startY = from.y + unitY * tailGap;
  const perpX = -unitY;
  const perpY = unitX;
  return {
    startX: round(startX),
    startY: round(startY),
    baseX: round(baseX),
    baseY: round(baseY),
    tipX: round(tipX),
    tipY: round(tipY),
    leftX: round(baseX + perpX * headHalfWidth),
    leftY: round(baseY + perpY * headHalfWidth),
    rightX: round(baseX - perpX * headHalfWidth),
    rightY: round(baseY - perpY * headHalfWidth)
  };
}

function round(value: number): string {
  return (Math.round(value * 1000) / 1000).toString();
}

function squareFile(square: BoardSquare): BoardFile {
  return square.slice(0, 1) as BoardFile;
}

function squareRank(square: BoardSquare): BoardRank {
  return square.slice(1, 2) as BoardRank;
}

function legalTargetsFrom(
  board: FenBoard,
  state: Pick<PlayBoardRenderState, "engineState" | "selectedSquare" | "inputSide">
): readonly BoardSquare[] {
  if (state.engineState === null || state.selectedSquare === null) {
    return [];
  }
  const from = state.selectedSquare;
  const destinations = new Set(
    state.engineState.legalMoves
      .filter((move) => move.startsWith(from))
      .map((move) => move.slice(2, 4))
      .filter(isBoardSquare)
  );
  // Also expose rook squares as targets for king-to-rook castling UX.
  for (const [rookKey, castleMove] of castlingRookToDestination) {
    if (rookKey.startsWith(from) && state.engineState.legalMoves.includes(castleMove)) {
      const rookSquare = rookKey.slice(2, 4);
      if (isBoardSquare(rookSquare)) destinations.add(rookSquare);
    }
  }
  const targets: BoardSquare[] = [];
  for (const square of destinations) {
    const piece = board.pieces.get(square);
    // Exclude same-color captures except the own rook for castling.
    const isCastlingRook =
      piece?.color === state.inputSide &&
      piece.kind === "rook" &&
      castlingRookToDestination.has(`${from}${square}`) &&
      state.engineState.legalMoves.includes(castlingRookToDestination.get(`${from}${square}`) ?? "");
    if (piece?.color !== state.inputSide || isCastlingRook) {
      targets.push(square);
    }
  }
  return targets;
}

function parseFenBoard(fen: string): FenBoard | null {
  const [placement, activeSide] = fen.trim().split(/\s+/u);
  if (placement === undefined || activeSide === undefined) {
    return null;
  }
  const activeColor = activeSide === "w" ? "white" : activeSide === "b" ? "black" : null;
  if (activeColor === null) {
    return null;
  }
  const rows = placement.split("/");
  if (rows.length !== 8) {
    return null;
  }
  const pieces = new Map<BoardSquare, FenPiece>();
  for (const [rankOffset, row] of rows.entries()) {
    const rank = whiteRanks[rankOffset];
    if (rank === undefined) {
      return null;
    }
    let fileOffset = 0;
    for (const symbol of row) {
      if (/^[1-8]$/u.test(symbol)) {
        fileOffset += Number.parseInt(symbol, 10);
        if (fileOffset > boardFiles.length) {
          return null;
        }
        continue;
      }
      const file = boardFiles[fileOffset];
      const piece = parseFenPiece(symbol);
      if (file === undefined || piece === null) {
        return null;
      }
      pieces.set(`${file}${rank}`, piece);
      fileOffset += 1;
    }
    if (fileOffset !== boardFiles.length) {
      return null;
    }
  }
  return { activeColor, pieces };
}

function parseFenPiece(symbol: string): FenPiece | null {
  const kind = fenPieceKind(symbol);
  if (kind === null) {
    return null;
  }
  return {
    symbol,
    color: symbol === symbol.toUpperCase() ? "white" : "black",
    kind
  };
}

function fenPieceKind(symbol: string): BoardPieceKind | null {
  switch (symbol.toLowerCase()) {
    case "k":
      return "king";
    case "q":
      return "queen";
    case "r":
      return "rook";
    case "b":
      return "bishop";
    case "n":
      return "knight";
    case "p":
      return "pawn";
    default:
      return null;
  }
}

function isBoardFile(value: string | undefined): value is BoardFile {
  return value !== undefined && boardFiles.some((file) => file === value);
}

function isBoardRank(value: string | undefined): value is BoardRank {
  return value !== undefined && boardRanks.some((rank) => rank === value);
}

function boardSquareShade(square: BoardSquare): "light" | "dark" {
  const file = square.slice(0, 1);
  const rank = square.slice(1, 2);
  const fileOffset = boardFiles.findIndex((candidate) => candidate === file);
  const rankNumber = Number.parseInt(rank, 10);
  return (fileOffset + rankNumber) % 2 === 1 ? "dark" : "light";
}

function boardPieceGlyphHtml(piece: FenPiece): string {
  switch (piece.symbol) {
    case "K":
      return "&#9812;";
    case "Q":
      return "&#9813;";
    case "R":
      return "&#9814;";
    case "B":
      return "&#9815;";
    case "N":
      return "&#9816;";
    case "P":
      return "&#9817;";
    case "k":
      return "&#9818;";
    case "q":
      return "&#9819;";
    case "r":
      return "&#9820;";
    case "b":
      return "&#9821;";
    case "n":
      return "&#9822;";
    case "p":
      return "&#9823;";
    default:
      return "";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
