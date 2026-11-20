import type { ColorDto, SideExploreCandidateDto } from "./engine-dtos.js";
import { exactKeys, isRecord } from "./review-validators.js";

const evidenceStoreKey = "chess.play.aggressiveEvidenceStore.v1";
const maxEvidenceSessions = 100;
const maxEvidenceMoves = 256;
const maxEvidenceCandidates = 4;
const maxEvidenceLineMoves = 12;

export type ManualAggressiveEvidenceStoreError =
  | "corrupt-store"
  | "unsupported-schema"
  | "record-limit-exceeded"
  | "move-limit-exceeded"
  | "storage-unavailable"
  | "storage-read-failed"
  | "storage-write-failed"
  | "storage-quota-exceeded"
  | "storage-remove-failed"
  | "import-invalid-json"
  | "import-invalid-schema";

export type ManualAggressiveEvidenceStorageLike = {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
};

export type ManualAggressiveEvidenceCaptureReason = "manual-save" | "new-game" | "terminal";
export type ManualAggressiveEvidencePlayMode =
  | "opponent"
  | "spectator-lens"
  | "reaction-lens"
  | "setup";

export type ManualAggressiveEvidenceMove = {
  readonly ply: number;
  readonly actor: "player" | "engine";
  readonly side: ColorDto;
  readonly coordinate: string;
  readonly san: string;
  readonly fenBefore: string;
  readonly fenAfter: string;
};

export type ManualAggressiveEvidenceSideExploreSnapshot = {
  readonly fen: string;
  readonly side: ColorDto;
  readonly aggressive: boolean;
  readonly onTurn: boolean;
  readonly candidates: readonly SideExploreCandidateDto[];
  readonly principalLine: readonly string[];
  readonly mateDetected: boolean;
  readonly depth: number;
  readonly nodes: number;
  readonly soundMarginCp: number;
};

export type ManualAggressiveEvidenceCompletedGame = {
  readonly status: "checkmate" | "stalemate" | "draw" | "resigned";
  readonly result: "1-0" | "0-1" | "1/2-1/2";
  readonly finalFen: string;
  readonly pgn: string;
};

export type ManualAggressiveEvidenceSession = {
  readonly id: string;
  readonly savedAtIso: string;
  readonly source: "manual-aggressive-explore";
  readonly captureReason: ManualAggressiveEvidenceCaptureReason;
  readonly playerSide: ColorDto;
  readonly playMode: ManualAggressiveEvidencePlayMode;
  readonly aggressive: boolean;
  readonly engineDepth: number;
  readonly startFen: string;
  readonly currentFen: string;
  readonly moves: readonly ManualAggressiveEvidenceMove[];
  readonly sideExplore: ManualAggressiveEvidenceSideExploreSnapshot | null;
  readonly completedGame: ManualAggressiveEvidenceCompletedGame | null;
};

export type ManualAggressiveEvidenceStoreV1 = {
  readonly schemaVersion: 1;
  readonly sessions: readonly ManualAggressiveEvidenceSession[];
};

type StorageReadResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly error: ManualAggressiveEvidenceStoreError };

export function readManualAggressiveEvidenceStore(
  storage: ManualAggressiveEvidenceStorageLike
): ManualAggressiveEvidenceStoreV1 | ManualAggressiveEvidenceStoreError {
  const stored = getStorageItem(storage, evidenceStoreKey);
  if (!stored.ok) {
    return stored.error;
  }
  if (stored.value === null) {
    return emptyEvidenceStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.value);
  } catch {
    return "corrupt-store";
  }
  if (isRecord(parsed) && parsed["schemaVersion"] !== 1) {
    return "unsupported-schema";
  }
  return validateEvidenceStore(parsed) ?? "corrupt-store";
}

export function appendManualAggressiveEvidenceSession(
  storage: ManualAggressiveEvidenceStorageLike,
  session: ManualAggressiveEvidenceSession
): ManualAggressiveEvidenceStoreV1 | ManualAggressiveEvidenceStoreError {
  if (session.moves.length > maxEvidenceMoves) {
    return "move-limit-exceeded";
  }

  const current = readManualAggressiveEvidenceStore(storage);
  if (typeof current === "string") {
    return current;
  }
  const sessions = [...current.sessions, session].slice(-maxEvidenceSessions);
  if (sessions.length > maxEvidenceSessions) {
    return "record-limit-exceeded";
  }

  const nextStore = { schemaVersion: 1, sessions } satisfies ManualAggressiveEvidenceStoreV1;
  const writeResult = setStorageItem(storage, evidenceStoreKey, JSON.stringify(nextStore));
  return writeResult ?? nextStore;
}

export function clearManualAggressiveEvidenceStore(
  storage: ManualAggressiveEvidenceStorageLike
): ManualAggressiveEvidenceStoreV1 | ManualAggressiveEvidenceStoreError {
  const removeResult = removeStorageItem(storage, evidenceStoreKey);
  return removeResult ?? emptyEvidenceStore();
}

export function serializeManualAggressiveEvidenceStore(
  store: ManualAggressiveEvidenceStoreV1
): string {
  return JSON.stringify(store, null, 2);
}

export function importManualAggressiveEvidenceSessions(
  storage: ManualAggressiveEvidenceStorageLike,
  json: string
): ManualAggressiveEvidenceStoreV1 | ManualAggressiveEvidenceStoreError {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return "import-invalid-json"; }
  const incoming = validateEvidenceStore(parsed);
  if (incoming === null) return "import-invalid-schema";
  const current = readManualAggressiveEvidenceStore(storage);
  if (typeof current === "string") return current;
  const byId = new Map<string, ManualAggressiveEvidenceSession>();
  for (const session of current.sessions) byId.set(session.id, session);
  for (const session of incoming.sessions) { if (!byId.has(session.id)) byId.set(session.id, session); }
  const merged = [...byId.values()]
    .sort((a, b) => (a.savedAtIso < b.savedAtIso ? -1 : a.savedAtIso > b.savedAtIso ? 1 : 0))
    .slice(-maxEvidenceSessions);
  const nextStore = { schemaVersion: 1, sessions: merged } satisfies ManualAggressiveEvidenceStoreV1;
  const writeResult = setStorageItem(storage, evidenceStoreKey, JSON.stringify(nextStore));
  return writeResult ?? nextStore;
}

function emptyEvidenceStore(): ManualAggressiveEvidenceStoreV1 {
  return { schemaVersion: 1, sessions: [] };
}

function validateEvidenceStore(value: unknown): ManualAggressiveEvidenceStoreV1 | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "sessions"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > maxEvidenceSessions
  ) {
    return null;
  }

  const sessions: ManualAggressiveEvidenceSession[] = [];
  for (const session of value.sessions) {
    const validated = validateEvidenceSession(session);
    if (validated === null) {
      return null;
    }
    sessions.push(validated);
  }
  return { schemaVersion: 1, sessions };
}

function validateEvidenceSession(value: unknown): ManualAggressiveEvidenceSession | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.savedAtIso !== "string" ||
    value.source !== "manual-aggressive-explore" ||
    !isCaptureReason(value.captureReason) ||
    !isColor(value.playerSide) ||
    !isPlayMode(value.playMode) ||
    typeof value.aggressive !== "boolean" ||
    !isCount(value.engineDepth) ||
    typeof value.startFen !== "string" ||
    typeof value.currentFen !== "string" ||
    !Array.isArray(value.moves) ||
    value.moves.length > maxEvidenceMoves
  ) {
    return null;
  }
  const moves = validateEvidenceMoves(value.moves);
  const sideExplore =
    value.sideExplore === null ? null : validateSideExploreSnapshot(value.sideExplore);
  const completedGame =
    value.completedGame === null ? null : validateCompletedGame(value.completedGame);
  if (
    moves === null ||
    (sideExplore === null && value.sideExplore !== null) ||
    (completedGame === null && value.completedGame !== null)
  ) {
    return null;
  }
  return {
    id: value.id,
    savedAtIso: value.savedAtIso,
    source: "manual-aggressive-explore",
    captureReason: value.captureReason,
    playerSide: value.playerSide,
    playMode: value.playMode,
    aggressive: value.aggressive,
    engineDepth: value.engineDepth,
    startFen: value.startFen,
    currentFen: value.currentFen,
    moves,
    sideExplore,
    completedGame
  };
}

function validateSideExploreSnapshot(
  value: unknown
): ManualAggressiveEvidenceSideExploreSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value.fen !== "string" ||
    !isColor(value.side) ||
    typeof value.aggressive !== "boolean" ||
    typeof value.onTurn !== "boolean" ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > maxEvidenceCandidates ||
    !Array.isArray(value.principalLine) ||
    value.principalLine.length > maxEvidenceLineMoves ||
    typeof value.mateDetected !== "boolean" ||
    !isCount(value.depth) ||
    !isCount(value.nodes) ||
    !isInteger(value.soundMarginCp)
  ) {
    return null;
  }
  const candidates = validateSideExploreCandidates(value.candidates);
  const principalLine = validateStringArray(value.principalLine, maxEvidenceLineMoves);
  if (candidates === null || principalLine === null) {
    return null;
  }
  return {
    fen: value.fen,
    side: value.side,
    aggressive: value.aggressive,
    onTurn: value.onTurn,
    candidates,
    principalLine,
    mateDetected: value.mateDetected,
    depth: value.depth,
    nodes: value.nodes,
    soundMarginCp: value.soundMarginCp
  };
}

function validateEvidenceMoves(value: unknown): readonly ManualAggressiveEvidenceMove[] | null {
  if (!Array.isArray(value) || value.length > maxEvidenceMoves) {
    return null;
  }
  for (const move of value) {
    if (
      !isRecord(move) ||
      !isCount(move["ply"]) ||
      !(move["actor"] === "player" || move["actor"] === "engine") ||
      !isColor(move["side"]) ||
      typeof move["coordinate"] !== "string" ||
      typeof move["san"] !== "string" ||
      typeof move["fenBefore"] !== "string" ||
      typeof move["fenAfter"] !== "string"
    ) {
      return null;
    }
  }
  return value as readonly ManualAggressiveEvidenceMove[];
}

function validateSideExploreCandidates(value: unknown): readonly SideExploreCandidateDto[] | null {
  if (!Array.isArray(value) || value.length > maxEvidenceCandidates) {
    return null;
  }
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate["move"] !== "string" ||
      typeof candidate["kind"] !== "string" ||
      !isInteger(candidate["exactScoreCp"]) ||
      typeof candidate["sound"] !== "boolean" ||
      typeof candidate["sacrifice"] !== "boolean"
    ) {
      return null;
    }
  }
  return value as readonly SideExploreCandidateDto[];
}

function validateCompletedGame(value: unknown): ManualAggressiveEvidenceCompletedGame | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["status", "result", "finalFen", "pgn"]) ||
    !(
      value.status === "checkmate" ||
      value.status === "stalemate" ||
      value.status === "draw" ||
      value.status === "resigned"
    ) ||
    !(value.result === "1-0" || value.result === "0-1" || value.result === "1/2-1/2") ||
    typeof value.finalFen !== "string" ||
    typeof value.pgn !== "string"
  ) {
    return null;
  }
  return { status: value.status, result: value.result, finalFen: value.finalFen, pgn: value.pgn };
}

function validateStringArray(value: unknown, maxLength: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maxLength) {
    return null;
  }
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
  }
  return value as readonly string[];
}

function getStorageItem(
  storage: ManualAggressiveEvidenceStorageLike,
  key: string
): StorageReadResult {
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch {
    return { ok: false, error: "storage-read-failed" };
  }
}

function setStorageItem(
  storage: ManualAggressiveEvidenceStorageLike,
  key: string,
  value: string
): ManualAggressiveEvidenceStoreError | null {
  try {
    storage.setItem(key, value);
    return null;
  } catch (error) {
    return isQuotaExceeded(error) ? "storage-quota-exceeded" : "storage-write-failed";
  }
}

function removeStorageItem(
  storage: ManualAggressiveEvidenceStorageLike,
  key: string
): ManualAggressiveEvidenceStoreError | null {
  try {
    storage.removeItem(key);
    return null;
  } catch {
    return "storage-remove-failed";
  }
}

function isCaptureReason(value: unknown): value is ManualAggressiveEvidenceCaptureReason {
  return value === "manual-save" || value === "new-game" || value === "terminal";
}

function isPlayMode(value: unknown): value is ManualAggressiveEvidencePlayMode {
  return value === "opponent" || value === "spectator-lens" || value === "reaction-lens" || value === "setup";
}

function isColor(value: unknown): value is ColorDto {
  return value === "white" || value === "black";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isQuotaExceeded(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const name = error["name"];
  const code = error["code"];
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  );
}
