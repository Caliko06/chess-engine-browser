import type {
  BestMoveDto,
  ColorDto,
  EngineStateDto,
  ExplanationPieceDto,
  ForcingCandidateDto,
  ForcingKindDto,
  ForcingMapDto,
  MoveQualityDto,
  MoveResultDto,
  OpeningProvenanceDto,
  OpeningStatusDto,
  PlayAggressivePlanDto,
  PlayAggressiveThreatModelDto,
  ReactionCandidateDto,
  ReactionMapDto,
  SideExploreCandidateDto,
  SideExploreDto,
  SideExploreExplanationDto,
  SideExploreExplanationSquareDto,
  SideExplorePlanReasonDto,
  SideExplorePlanStatusDto,
  SideExploreReplyDto,
  WasmBridgeError
} from "./engine-dtos.js";
import { exactKeys, isRecord } from "./review-validators.js";

export type PlayWasmModule = {
  readonly new_game_json: () => string;
  readonly make_move_json: (fen: string, mv: string) => string;
  readonly make_move_context_json?: (fen: string, mv: string, historyFens: string) => string;
  readonly best_move_json: (
    fen: string,
    depth: number,
    aggressive: boolean,
    nodeBudget: number
  ) => string;
  readonly best_move_context_json?: (
    fen: string,
    depth: number,
    aggressive: boolean,
    side: ColorDto,
    historyFens: string,
    previousLine: string,
    nodeBudget: number
  ) => string;
  readonly engine_move_json?: (
    fen: string,
    historyFens: string,
    level: number,
    nodeBudget: number,
    seed: number
  ) => string;
  readonly reaction_map_json?: (fen: string, depth: number, deep: boolean) => string;
  readonly forcing_map_json?: (fen: string, depth: number, host: ColorDto, deep: boolean) => string;
  readonly position_json?: (fen: string) => string;
  readonly side_explore_json?: (fen: string, side: ColorDto, aggressive: boolean) => string;
  readonly side_explore_context_json?: (
    fen: string,
    side: ColorDto,
    aggressive: boolean,
    historyFens: string
  ) => string;
  readonly side_explore_context_v2_json?: (
    fen: string,
    side: ColorDto,
    aggressive: boolean,
    historyFens: string,
    nodeBudget: number,
    previousLine: string
  ) => string;
};

const reactionLineMaxPlies = 6;
const reactionCandidatesMax = 8;
const forcingCandidatesMax = 8;

/**
 * Maps the play UI's strength level (1 to 6) to the coach searches' envelope. The user's opponent
 * does not use these caps: it plays through `engine_move_json` at the same level.
 */
const strengthDepthCaps: ReadonlyMap<number, number> = new Map([
  [1, 1],
  [2, 8],
  [3, 12],
  [4, 14],
  [5, 16],
  [6, 16]
]);
const strengthNodeBudgets: ReadonlyMap<number, number> = new Map([
  [1, 60_000],
  [2, 120_000],
  [3, 240_000],
  [4, 480_000],
  [5, 960_000],
  [6, 960_000]
]);
/** Node cap for the full-strength opponent (level 6, about 1 to 2 s in WASM); weaker levels stop at their depth. */
const opponentFullNodeBudget = 1_000_000;
const sideExploreFastNodeBudget = 100_000;
const sideExploreDeepNodeBudget = 300_000;

function engineDepthCap(level: number): number {
  return strengthDepthCaps.get(level) ?? level;
}

function engineNodeBudget(level: number): number {
  return strengthNodeBudgets.get(level) ?? 60_000;
}

export type PlayWasmModuleLoader = () => Promise<PlayWasmModule>;

export type PlayEngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WasmBridgeError };

export type PlayEngineMode =
  | "owned-local"
  | "local-stockfish"
  | "owned-local-stockfish-unavailable";

export type PlayBestMoveContext = {
  readonly side: ColorDto;
  readonly userSide: ColorDto;
  readonly historyFens: readonly string[];
  readonly previousLine: readonly string[];
};

export type PlaySideExploreContext = {
  readonly mode: "fast" | "deep";
  readonly previousLine?: readonly string[] | undefined;
};

export type PlayEngine = {
  readonly newGame: () => Promise<PlayEngineResult<EngineStateDto>>;
  readonly makeMove: (
    fen: string,
    mv: string,
    historyFens?: readonly string[]
  ) => Promise<PlayEngineResult<MoveResultDto>>;
  readonly bestMove: (
    fen: string,
    depth: number,
    legalMoves?: readonly string[],
    aggressive?: boolean,
    context?: PlayBestMoveContext
  ) => Promise<PlayEngineResult<BestMoveDto>>;
  readonly reactionMap?: (
    fen: string,
    depth: number,
    deep: boolean
  ) => Promise<PlayEngineResult<ReactionMapDto>>;
  readonly forcingMap?: (
    fen: string,
    depth: number,
    host: ColorDto,
    deep: boolean
  ) => Promise<PlayEngineResult<ForcingMapDto>>;
  readonly sideExplore?: (
    fen: string,
    side: ColorDto,
    aggressive: boolean,
    historyFens?: readonly string[],
    context?: PlaySideExploreContext
  ) => Promise<PlayEngineResult<SideExploreDto>>;
  readonly loadPosition?: (fen: string) => Promise<PlayEngineResult<EngineStateDto>>;
  readonly mode?: () => PlayEngineMode;
  readonly cancelSearch?: () => void;
};

export function createPlayWasmExecutor(
  loadModule: PlayWasmModuleLoader
): PlayEngine {
  let modulePromise: Promise<PlayWasmModule> | null = null;
  const loadOnce = (): Promise<PlayWasmModule> => {
    modulePromise = modulePromise ?? loadModule();
    return modulePromise;
  };
  return {
    newGame: async () => {
      try {
        return parseStateEnvelope((await loadOnce()).new_game_json());
      } catch {
        return { ok: false, error: "search-failed" };
      }
    },
    makeMove: async (fen: string, mv: string, historyFens?: readonly string[]) => {
      try {
        const module = await loadOnce();
        const history = historyFens?.join("\n") ?? "";
        const serialized =
          history.length > 0 && module.make_move_context_json !== undefined
            ? module.make_move_context_json(fen, mv, history)
            : module.make_move_json(fen, mv);
        return parseMoveEnvelope(serialized);
      } catch {
        return { ok: false, error: "search-failed" };
      }
    },
    bestMove: async (
      fen: string,
      depth: number,
      _legalMoves?: readonly string[],
      aggressive = false,
      context?: PlayBestMoveContext
    ) => {
      try {
        const module = await loadOnce();
        const cappedDepth = engineDepthCap(depth);
        const userFavoring = context !== undefined && context.userSide !== context.side;
        const nodeBudget = engineNodeBudget(depth);
        const historyFens = context?.historyFens.join("\n") ?? "";
        const previousLine = context?.previousLine.join(",") ?? "";
        if (context !== undefined) {
          if (userFavoring && typeof module.engine_move_json === "function") {
            return parseBestMoveEnvelope(
              module.engine_move_json(
                fen,
                historyFens,
                depth,
                opponentFullNodeBudget,
                Math.floor(Math.random() * 0x1_0000_0000)
              )
            );
          }
          if (typeof module.best_move_context_json === "function") {
            return parseBestMoveEnvelope(
              module.best_move_context_json(
                fen,
                cappedDepth,
                aggressive,
                context.side,
                historyFens,
                previousLine,
                nodeBudget
              )
            );
          }
        }
        return parseBestMoveEnvelope(
          module.best_move_json(fen, cappedDepth, aggressive, nodeBudget)
        );
      } catch {
        return { ok: false, error: "search-failed" };
      }
    },
    reactionMap: async (fen: string, depth: number, deep: boolean) => {
      try {
        const module = await loadOnce();
        if (typeof module.reaction_map_json !== "function") {
          return { ok: false, error: "search-failed" };
        }
        return parseReactionMapEnvelope(module.reaction_map_json(fen, depth, deep));
      } catch {
        return { ok: false, error: "search-failed" };
      }
    },
    forcingMap: async (fen: string, depth: number, host: ColorDto, deep: boolean) => {
      try {
        const module = await loadOnce();
        if (typeof module.forcing_map_json !== "function") {
          return { ok: false, error: "search-failed" };
        }
        return parseForcingMapEnvelope(module.forcing_map_json(fen, depth, host, deep));
      } catch {
        return { ok: false, error: "search-failed" };
      }
    },
    sideExplore: async (
      fen: string,
      side: ColorDto,
      aggressive: boolean,
      historyFens: readonly string[] = [],
      _context: PlaySideExploreContext | undefined = undefined
    ) => {
      try {
        const module = await loadOnce();
        if (typeof module.side_explore_context_v2_json === "function") {
          const budget =
            _context?.mode === "fast" ? sideExploreFastNodeBudget : sideExploreDeepNodeBudget;
          return parseSideExploreEnvelope(
            module.side_explore_context_v2_json(
              fen,
              side,
              aggressive,
              historyFens.join("\n"),
              budget,
              _context?.previousLine?.join(",") ?? ""
            )
          );
        }
        if (typeof module.side_explore_context_json === "function") {
          return parseSideExploreEnvelope(
            module.side_explore_context_json(
              fen,
              side,
              aggressive,
              historyFens.join("\n")
            )
          );
        }
        if (typeof module.side_explore_json !== "function") {
          return { ok: false, error: "search-failed" };
        }
        return parseSideExploreEnvelope(module.side_explore_json(fen, side, aggressive));
      } catch {
        return { ok: false, error: "search-failed" };
      }
    },
    loadPosition: async (fen: string) => {
      try {
        const module = await loadOnce();
        if (typeof module.position_json !== "function") {
          return { ok: false, error: "search-failed" };
        }
        return parseStateEnvelope(module.position_json(fen));
      } catch {
        return { ok: false, error: "search-failed" };
      }
    }
  };
}

function parseStateEnvelope(serialized: string): PlayEngineResult<EngineStateDto> {
  const parsed = parseEnvelope(serialized);
  if (!parsed.ok) {
    return parsed;
  }
  if (!exactKeys(parsed.value, ["ok", "state"])) {
    return { ok: false, error: "search-failed" };
  }
  const state = validateEngineStateDto(parsed.value.state);
  return state === null ? { ok: false, error: "search-failed" } : { ok: true, value: state };
}

function parseMoveEnvelope(serialized: string): PlayEngineResult<MoveResultDto> {
  const parsed = parseEnvelope(serialized);
  if (!parsed.ok) {
    return parsed;
  }
  if (!exactKeys(parsed.value, ["ok", "move"])) {
    return { ok: false, error: "search-failed" };
  }
  const move = validateMoveResultDto(parsed.value.move);
  return move === null ? { ok: false, error: "search-failed" } : { ok: true, value: move };
}

function parseBestMoveEnvelope(serialized: string): PlayEngineResult<BestMoveDto> {
  const parsed = parseEnvelope(serialized);
  if (!parsed.ok) {
    return parsed;
  }
  if (!exactKeys(parsed.value, ["ok", "bestMove"])) {
    return { ok: false, error: "search-failed" };
  }
  const bestMove = validateBestMoveDto(parsed.value.bestMove);
  return bestMove === null
    ? { ok: false, error: "search-failed" }
    : { ok: true, value: bestMove };
}

function parseReactionMapEnvelope(serialized: string): PlayEngineResult<ReactionMapDto> {
  const parsed = parseEnvelope(serialized);
  if (!parsed.ok) {
    return parsed;
  }
  if (!exactKeys(parsed.value, ["ok", "reactionMap"])) {
    return { ok: false, error: "search-failed" };
  }
  const reactionMap = validateReactionMapDto(parsed.value.reactionMap);
  return reactionMap === null
    ? { ok: false, error: "search-failed" }
    : { ok: true, value: reactionMap };
}

function parseForcingMapEnvelope(serialized: string): PlayEngineResult<ForcingMapDto> {
  const parsed = parseEnvelope(serialized);
  if (!parsed.ok) {
    return parsed;
  }
  if (!exactKeys(parsed.value, ["ok", "forcingMap"])) {
    return { ok: false, error: "search-failed" };
  }
  const forcingMap = validateForcingMapDto(parsed.value.forcingMap);
  return forcingMap === null
    ? { ok: false, error: "search-failed" }
    : { ok: true, value: forcingMap };
}

function parseEnvelope(
  serialized: string
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly error: WasmBridgeError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { ok: false, error: "search-failed" };
  }
  if (!isRecord(parsed) || !("ok" in parsed)) {
    return { ok: false, error: "search-failed" };
  }
  if (parsed.ok === false && isWasmBridgeError(parsed.error)) {
    return { ok: false, error: parsed.error };
  }
  if (parsed.ok === true) {
    return { ok: true, value: parsed };
  }
  return { ok: false, error: "search-failed" };
}

export function validateEngineStateDto(value: unknown): EngineStateDto | null {
  const hasDrawReason =
    isRecord(value) &&
    exactKeys(value, ["fen", "status", "drawReason", "sideToMove", "legalMoves"]);
  let drawReason: EngineStateDto["drawReason"];
  if (hasDrawReason) {
    if (!isDrawReason(value.drawReason)) {
      return null;
    }
    drawReason = value.drawReason;
  }
  if (
    !isRecord(value) ||
    !(exactKeys(value, ["fen", "status", "sideToMove", "legalMoves"]) || hasDrawReason) ||
    typeof value.fen !== "string" ||
    !isGameStatus(value.status) ||
    !isColor(value.sideToMove) ||
    !Array.isArray(value.legalMoves) ||
    value.legalMoves.length > 256 ||
    !value.legalMoves.every(isCoordinateMove)
  ) {
    return null;
  }
  return {
    fen: value.fen,
    status: value.status,
    ...(drawReason === undefined ? {} : { drawReason }),
    sideToMove: value.sideToMove,
    legalMoves: value.legalMoves
  };
}

function validateMoveResultDto(value: unknown): MoveResultDto | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["appliedMove", "san", "state"]) ||
    !isCoordinateMove(value.appliedMove) ||
    typeof value.san !== "string"
  ) {
    return null;
  }
  const state = validateEngineStateDto(value.state);
  return state === null ? null : { appliedMove: value.appliedMove, san: value.san, state };
}

function validateBestMoveDto(value: unknown): BestMoveDto | null {
  const hasContext =
    isRecord(value) &&
    exactKeys(value, [
      "bestMove",
      "depth",
      "scoreCp",
      "nodes",
      "ttHits",
      "principalLine",
      "followedPlan"
    ]);
  const hasPlan =
    isRecord(value) &&
    exactKeys(value, [
      "bestMove",
      "depth",
      "scoreCp",
      "nodes",
      "ttHits",
      "principalLine",
      "followedPlan",
      "plan"
    ]);
  const plan = hasPlan ? validatePlayAggressivePlanDto(value.plan) : null;
  if (
    !isRecord(value) ||
    !(
      exactKeys(value, ["bestMove", "depth", "scoreCp", "nodes", "ttHits"]) ||
      hasContext ||
      hasPlan
    ) ||
    !(value.bestMove === null || isCoordinateMove(value.bestMove)) ||
    !isPositiveCount(value.depth) ||
    !isInteger(value.scoreCp) ||
    !isCount(value.nodes) ||
    !isCount(value.ttHits) ||
    ((hasContext || hasPlan) &&
      (!Array.isArray(value.principalLine) ||
        !isCoordinateMoveList(value.principalLine, reactionLineMaxPlies) ||
        typeof value.followedPlan !== "boolean")) ||
    (hasPlan && plan === null)
  ) {
    return null;
  }
  return {
    bestMove: value.bestMove,
    depth: value.depth,
    scoreCp: value.scoreCp,
    nodes: value.nodes,
    ttHits: value.ttHits,
    ...(hasContext
      ? {
          principalLine: value.principalLine as readonly string[],
          followedPlan: value.followedPlan as boolean
        }
      : {}),
    ...(hasPlan && plan !== null
      ? {
          principalLine: value.principalLine as readonly string[],
          followedPlan: value.followedPlan as boolean,
          plan
        }
      : {})
  };
}

function validatePlayAggressivePlanDto(value: unknown): PlayAggressivePlanDto | null {
  const baseKeys = [
    "version",
    "side",
    "status",
    "reason",
    "line",
    "expectedReply",
    "continuation",
    "degraded"
  ];
  const hasThreatModel =
    isRecord(value) && exactKeys(value, [...baseKeys, "threatModel"]);
  const threatModel = hasThreatModel ? validatePlayAggressiveThreatModelDto(value.threatModel) : null;
  if (
    !isRecord(value) ||
    !(exactKeys(value, baseKeys) || hasThreatModel) ||
    value.version !== 1 ||
    !isColor(value.side) ||
    !isAggressivePlanStatus(value.status) ||
    !isAggressivePlanReason(value.reason) ||
    !isCoordinateMoveList(value.line, reactionLineMaxPlies) ||
    !(value.expectedReply === null || isCoordinateMove(value.expectedReply)) ||
    !(value.continuation === null || isCoordinateMove(value.continuation)) ||
    typeof value.degraded !== "boolean" ||
    (hasThreatModel && threatModel === null)
  ) {
    return null;
  }
  const plan: Omit<PlayAggressivePlanDto, "threatModel"> = {
    version: 1,
    side: value.side,
    status: value.status,
    reason: value.reason,
    line: value.line,
    expectedReply: value.expectedReply,
    continuation: value.continuation,
    degraded: value.degraded
  };
  if (hasThreatModel && threatModel !== null) {
    return { ...plan, threatModel };
  }
  return plan;
}

function validatePlayAggressiveThreatModelDto(
  value: unknown
): PlayAggressiveThreatModelDto | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["version", "side", "ownThreat", "opponentDanger", "followUp", "risk"]) ||
    value.version !== 1 ||
    !isColor(value.side) ||
    !isAggressiveThreatRisk(value.risk)
  ) {
    return null;
  }
  const ownThreat = validatePlayAggressiveThreatSignalDto(value.ownThreat);
  const opponentDanger = validatePlayAggressiveThreatSignalDto(value.opponentDanger);
  const followUp = validatePlayAggressiveThreatSignalDto(value.followUp);
  if (ownThreat === null || opponentDanger === null || followUp === null) {
    return null;
  }
  return {
    version: 1,
    side: value.side,
    ownThreat,
    opponentDanger,
    followUp,
    risk: value.risk
  };
}

function validatePlayAggressiveThreatSignalDto(
  value: unknown
): PlayAggressiveThreatModelDto["ownThreat"] | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["kind", "move", "mateIn"]) ||
    !isAggressiveThreatKind(value.kind) ||
    !(value.move === null || isCoordinateMove(value.move)) ||
    !(value.mateIn === null || isPositiveCount(value.mateIn))
  ) {
    return null;
  }
  return {
    kind: value.kind,
    move: value.move,
    mateIn: value.mateIn
  };
}


export function validateReactionMapDto(value: unknown): ReactionMapDto | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "state",
      "rootCandidates",
      "principalLine",
      "projectedLine",
      "mateDetected",
      "depth",
      "nodes"
    ]) ||
    typeof value.mateDetected !== "boolean" ||
    !isPositiveCount(value.depth) ||
    !isCount(value.nodes) ||
    !isCoordinateMoveList(value.principalLine, reactionLineMaxPlies) ||
    !isCoordinateMoveList(value.projectedLine, reactionLineMaxPlies) ||
    !Array.isArray(value.rootCandidates) ||
    value.rootCandidates.length > reactionCandidatesMax
  ) {
    return null;
  }
  const state = validateEngineStateDto(value.state);
  if (state === null) {
    return null;
  }
  const rootCandidates: ReactionCandidateDto[] = [];
  for (const candidate of value.rootCandidates) {
    const validated = validateReactionCandidateDto(candidate);
    if (validated === null) {
      return null;
    }
    rootCandidates.push(validated);
  }
  return {
    state,
    rootCandidates,
    principalLine: value.principalLine,
    projectedLine: value.projectedLine,
    mateDetected: value.mateDetected,
    depth: value.depth,
    nodes: value.nodes
  };
}

function validateReactionCandidateDto(value: unknown): ReactionCandidateDto | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["move", "scoreCp", "hangs", "mateIn", "quality"]) ||
    !isCoordinateMove(value.move) ||
    !isInteger(value.scoreCp) ||
    typeof value.hangs !== "boolean" ||
    !(value.mateIn === null || isPositiveCount(value.mateIn)) ||
    !isMoveQuality(value.quality)
  ) {
    return null;
  }
  return {
    move: value.move,
    scoreCp: value.scoreCp,
    hangs: value.hangs,
    mateIn: value.mateIn,
    quality: value.quality
  };
}

function isMoveQuality(value: unknown): value is MoveQualityDto {
  return (
    value === "brilliant" ||
    value === "great" ||
    value === "best" ||
    value === "excellent" ||
    value === "good" ||
    value === "inaccuracy" ||
    value === "mistake" ||
    value === "blunder"
  );
}

export function validateForcingMapDto(value: unknown): ForcingMapDto | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["state", "host", "onTurn", "candidates", "depth", "nodes"]) ||
    !isColor(value.host) ||
    typeof value.onTurn !== "boolean" ||
    !isPositiveCount(value.depth) ||
    !isCount(value.nodes) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > forcingCandidatesMax
  ) {
    return null;
  }
  const state = validateEngineStateDto(value.state);
  if (state === null) {
    return null;
  }
  const candidates: ForcingCandidateDto[] = [];
  for (const candidate of value.candidates) {
    const validated = validateForcingCandidateDto(candidate);
    if (validated === null) {
      return null;
    }
    candidates.push(validated);
  }
  return {
    state,
    host: value.host,
    onTurn: value.onTurn,
    candidates,
    depth: value.depth,
    nodes: value.nodes
  };
}

function validateForcingCandidateDto(value: unknown): ForcingCandidateDto | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["move", "kind", "scoreCp", "sound", "mateIn"]) ||
    !isCoordinateMove(value.move) ||
    !isForcingKind(value.kind) ||
    !isInteger(value.scoreCp) ||
    typeof value.sound !== "boolean" ||
    !(value.mateIn === null || isPositiveCount(value.mateIn))
  ) {
    return null;
  }
  return {
    move: value.move,
    kind: value.kind,
    scoreCp: value.scoreCp,
    sound: value.sound,
    mateIn: value.mateIn
  };
}

function isForcingKind(value: unknown): value is ForcingKindDto {
  return value === "mate" || value === "check" || value === "capture" || value === "defense";
}

const sideExploreCandidatesMax = 4;

function parseSideExploreEnvelope(serialized: string): PlayEngineResult<SideExploreDto> {
  const parsed = parseEnvelope(serialized);
  if (!parsed.ok) {
    return parsed;
  }
  if (!exactKeys(parsed.value, ["ok", "sideExplore"])) {
    return { ok: false, error: "search-failed" };
  }
  const result = validateSideExploreDto(parsed.value.sideExplore);
  return result === null ? { ok: false, error: "search-failed" } : { ok: true, value: result };
}

export function validateSideExploreDto(value: unknown): SideExploreDto | null {
  const baseKeys = [
    "state",
    "side",
    "onTurn",
    "replyCandidates",
    "candidates",
    "principalLine",
    "mateDetected",
    "depth",
    "nodes",
    "soundMarginCp"
  ];
  if (
    !isRecord(value) ||
    !hasSideExploreKeys(value, baseKeys) ||
    !isColor(value.side) ||
    typeof value.onTurn !== "boolean" ||
    !Array.isArray(value.replyCandidates) ||
    value.replyCandidates.length > sideExploreCandidatesMax ||
    typeof value.mateDetected !== "boolean" ||
    !isPositiveCount(value.depth) ||
    !isCount(value.nodes) ||
    !isPositiveCount(value.soundMarginCp) ||
    !isCoordinateMoveList(value.principalLine, reactionLineMaxPlies) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > sideExploreCandidatesMax ||
    ("planStatus" in value && !isSideExplorePlanStatus(value.planStatus)) ||
    ("planReason" in value && !isSideExplorePlanReason(value.planReason))
  ) {
    return null;
  }
  const state = validateEngineStateDto(value.state);
  if (state === null) {
    return null;
  }
  const replyCandidates: SideExploreReplyDto[] = [];
  for (const reply of value.replyCandidates) {
    const validated = validateSideExploreReplyDto(reply);
    if (validated === null) {
      return null;
    }
    replyCandidates.push(validated);
  }
  const candidates: SideExploreCandidateDto[] = [];
  for (const candidate of value.candidates) {
    const validated = validateSideExploreCandidateDto(candidate);
    if (validated === null) {
      return null;
    }
    candidates.push(validated);
  }
  const resultBase: SideExploreDto = {
    state,
    side: value.side,
    onTurn: value.onTurn,
    replyCandidates,
    candidates,
    principalLine: value.principalLine,
    mateDetected: value.mateDetected,
    depth: value.depth,
    nodes: value.nodes,
    soundMarginCp: value.soundMarginCp
  };
  let result: SideExploreDto =
    "openingStatus" in value
      ? { ...resultBase, openingStatus: validateOpeningStatusDto(value.openingStatus) }
      : resultBase;
  if ("explanation" in value) {
    const explanation = validateSideExploreExplanationDto(value.explanation);
    if (explanation === null) {
      return null;
    }
    result = { ...result, explanation };
  }
  if ("planStatus" in value && "planReason" in value) {
    const planStatus = value.planStatus;
    const planReason = value.planReason;
    if (!isSideExplorePlanStatus(planStatus) || !isSideExplorePlanReason(planReason)) {
      return null;
    }
    return { ...result, planStatus, planReason };
  }
  return result;
}

/// Accepts the base keys plus any combination of the optional groups the bridge may emit.
function hasSideExploreKeys(value: Record<string, unknown>, baseKeys: readonly string[]): boolean {
  const optionalGroups = [["openingStatus"], ["planStatus", "planReason"], ["explanation"]];
  for (let mask = 0; mask < 1 << optionalGroups.length; mask += 1) {
    const extra = optionalGroups.filter((_, index) => (mask & (1 << index)) !== 0).flat();
    if (exactKeys(value, [...baseKeys, ...extra])) {
      return true;
    }
  }
  return false;
}

function validateSideExploreExplanationDto(value: unknown): SideExploreExplanationDto | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["inCheck", "threatened", "best", "lineMaterialCp"]) ||
    typeof value.inCheck !== "boolean" ||
    !isInteger(value.lineMaterialCp) ||
    !Array.isArray(value.threatened) ||
    value.threatened.length > 3 ||
    !isRecord(value.best) ||
    !exactKeys(value.best, [
      "move",
      "piece",
      "captured",
      "promotion",
      "castle",
      "check",
      "mate",
      "threats",
      "savesThreatened",
      "hangs"
    ])
  ) {
    return null;
  }
  const best = value.best;
  if (
    !isCoordinateMove(best.move) ||
    !isExplanationPiece(best.piece) ||
    !(best.captured === null || isExplanationPiece(best.captured)) ||
    !(best.promotion === null || isExplanationPiece(best.promotion)) ||
    !(best.castle === null || best.castle === "king" || best.castle === "queen") ||
    typeof best.check !== "boolean" ||
    typeof best.mate !== "boolean" ||
    !Array.isArray(best.threats) ||
    best.threats.length > 2 ||
    typeof best.savesThreatened !== "boolean" ||
    typeof best.hangs !== "boolean"
  ) {
    return null;
  }
  const threatened = validateExplanationSquares(value.threatened);
  const threats = validateExplanationSquares(best.threats);
  if (threatened === null || threats === null) {
    return null;
  }
  return {
    inCheck: value.inCheck,
    threatened,
    best: {
      move: best.move,
      piece: best.piece,
      captured: best.captured,
      promotion: best.promotion,
      castle: best.castle,
      check: best.check,
      mate: best.mate,
      threats,
      savesThreatened: best.savesThreatened,
      hangs: best.hangs
    },
    lineMaterialCp: value.lineMaterialCp
  };
}

function validateExplanationSquares(
  values: readonly unknown[]
): SideExploreExplanationSquareDto[] | null {
  const squares: SideExploreExplanationSquareDto[] = [];
  for (const entry of values) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["square", "piece"]) ||
      typeof entry.square !== "string" ||
      !/^[a-h][1-8]$/u.test(entry.square) ||
      !isExplanationPiece(entry.piece)
    ) {
      return null;
    }
    squares.push({ square: entry.square, piece: entry.piece });
  }
  return squares;
}

function isExplanationPiece(value: unknown): value is ExplanationPieceDto {
  return (
    value === "pawn" ||
    value === "knight" ||
    value === "bishop" ||
    value === "rook" ||
    value === "queen" ||
    value === "king"
  );
}

function isSideExplorePlanStatus(value: unknown): value is SideExplorePlanStatusDto {
  return value === "none" || value === "followed" || value === "replaced";
}

function isSideExplorePlanReason(value: unknown): value is SideExplorePlanReasonDto {
  return (
    value === "no-previous-line" ||
    value === "matched-history-and-gate" ||
    value === "illegal-continuation" ||
    value === "live-board-recomputed"
  );
}

function validateSideExploreReplyDto(value: unknown): SideExploreReplyDto | null {
  const hasRole =
    isRecord(value) &&
    exactKeys(value, ["move", "role", "kind", "quality", "sound", "sacrifice", "mateIn"]);
  if (
    !isRecord(value) ||
    !(exactKeys(value, ["move", "kind", "quality", "sound", "sacrifice", "mateIn"]) || hasRole) ||
    (hasRole && value.role !== "objective-primary" && value.role !== "alternative") ||
    !isCoordinateMove(value.move) ||
    !isForcingKind(value.kind) ||
    !isMoveQuality(value.quality) ||
    typeof value.sound !== "boolean" ||
    typeof value.sacrifice !== "boolean" ||
    !(value.mateIn === null || isPositiveCount(value.mateIn))
  ) {
    return null;
  }
  return {
    move: value.move,
    ...(hasRole ? { role: value.role as "objective-primary" | "alternative" } : {}),
    kind: value.kind,
    quality: value.quality,
    sound: value.sound,
    sacrifice: value.sacrifice,
    mateIn: value.mateIn
  };
}

function validateSideExploreCandidateDto(value: unknown): SideExploreCandidateDto | null {
  const baseKeys = [
    "move",
    "kind",
    "exactScoreCp",
    "sound",
    "sacrifice",
    "prospectiveBrilliant",
    "mateIn",
    "aftermath",
    "continuation"
  ];
  if (
    !isRecord(value) ||
    !(exactKeys(value, baseKeys) || exactKeys(value, [...baseKeys, "quality", "opening"])) ||
    !isCoordinateMove(value.move) ||
    !isForcingKind(value.kind) ||
    !isInteger(value.exactScoreCp) ||
    ("quality" in value && !isMoveQuality(value.quality)) ||
    typeof value.sound !== "boolean" ||
    typeof value.sacrifice !== "boolean" ||
    typeof value.prospectiveBrilliant !== "boolean" ||
    !(value.mateIn === null || isPositiveCount(value.mateIn)) ||
    !(value.aftermath === null || value.aftermath === "accepted" || value.aftermath === "defended") ||
    !(value.continuation === null || isCoordinateMove(value.continuation)) ||
    ("opening" in value && !(value.opening === null || validateOpeningProvenanceDto(value.opening) !== null))
  ) {
    return null;
  }
  const candidate: SideExploreCandidateDto = {
    move: value.move,
    kind: value.kind,
    exactScoreCp: value.exactScoreCp,
    sound: value.sound,
    sacrifice: value.sacrifice,
    prospectiveBrilliant: value.prospectiveBrilliant,
    mateIn: value.mateIn,
    aftermath: value.aftermath,
    continuation: value.continuation
  };
  const quality = value.quality;
  if ("quality" in value && "opening" in value && isMoveQuality(quality)) {
    return {
      ...candidate,
      quality,
      opening: validateOpeningProvenanceDto(value.opening)
    };
  }
  return candidate;
}

function validateOpeningProvenanceDto(value: unknown): OpeningProvenanceDto | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["eco", "name"]) ||
    typeof value.eco !== "string" ||
    typeof value.name !== "string" ||
    value.eco.length === 0 ||
    value.name.length === 0
  ) {
    return null;
  }
  return { eco: value.eco, name: value.name };
}

function validateOpeningStatusDto(value: unknown): OpeningStatusDto {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["status", "eco", "name", "move"]) ||
    !(value.status === "available" || value.status === "unavailable") ||
    !(value.eco === null || typeof value.eco === "string") ||
    !(value.name === null || typeof value.name === "string") ||
    !(value.move === null || isCoordinateMove(value.move))
  ) {
    return { status: "unavailable", eco: null, name: null, move: null };
  }
  return {
    status: value.status,
    eco: value.eco,
    name: value.name,
    move: value.move
  };
}

function isCoordinateMoveList(value: unknown, maxLength: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= maxLength && value.every(isCoordinateMove);
}

function isColor(value: unknown): value is EngineStateDto["sideToMove"] {
  return value === "white" || value === "black";
}

function isAggressivePlanStatus(value: unknown): value is PlayAggressivePlanDto["status"] {
  return (
    value === "followed" ||
    value === "proposed" ||
    value === "ignored" ||
    value === "unavailable"
  );
}

function isAggressivePlanReason(value: unknown): value is PlayAggressivePlanDto["reason"] {
  return (
    value === "matched-history-and-gate" ||
    value === "new-line" ||
    value === "no-previous-line" ||
    value === "illegal-continuation" ||
    value === "failed-objective-gate" ||
    value === "no-projected-line" ||
    value === "not-aggressive"
  );
}

function isAggressiveThreatKind(
  value: unknown
): value is PlayAggressiveThreatModelDto["ownThreat"]["kind"] {
  return (
    value === "mate" ||
    value === "check" ||
    value === "capture" ||
    value === "king-pressure" ||
    value === "quiet" ||
    value === "none"
  );
}

function isAggressiveThreatRisk(
  value: unknown
): value is PlayAggressiveThreatModelDto["risk"] {
  return value === "bounded" || value === "caution" || value === "critical";
}

function isGameStatus(value: unknown): value is EngineStateDto["status"] {
  return value === "ongoing" || value === "checkmate" || value === "stalemate" || value === "draw";
}

function isDrawReason(
  value: unknown
): value is NonNullable<EngineStateDto["drawReason"]> | null {
  return (
    value === null ||
    value === "fifty-move" ||
    value === "insufficient-material" ||
    value === "threefold-repetition"
  );
}

function isCoordinateMove(value: unknown): value is string {
  return typeof value === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(value);
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
