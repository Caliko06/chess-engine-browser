import {
  appendManualAggressiveEvidenceSession,
  clearManualAggressiveEvidenceStore,
  importManualAggressiveEvidenceSessions,
  readManualAggressiveEvidenceStore,
  serializeManualAggressiveEvidenceStore,
  type ManualAggressiveEvidenceSession,
  type ManualAggressiveEvidenceStorageLike
} from "./play-evidence-store";

type MemoryStorage = ManualAggressiveEvidenceStorageLike & {
  readonly entries: () => ReadonlyMap<string, string>;
};

function memoryStorage(initial: ReadonlyMap<string, string> = new Map()): MemoryStorage {
  const values = new Map(initial);
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

function throwingStorage(
  operation: "getItem" | "setItem" | "removeItem",
  error: unknown
): ManualAggressiveEvidenceStorageLike {
  return {
    getItem: () => {
      if (operation === "getItem") {
        throw error;
      }
      return null;
    },
    setItem: () => {
      if (operation === "setItem") {
        throw error;
      }
    },
    removeItem: () => {
      if (operation === "removeItem") {
        throw error;
      }
    }
  };
}

function expectEqual<T>(actual: T, expected: T): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`expected ${expectedText}, got ${actualText}`);
  }
}

function session(id: string): ManualAggressiveEvidenceSession {
  return {
    id,
    savedAtIso: "2026-06-29T00:00:00.000Z",
    source: "manual-aggressive-explore",
    captureReason: "manual-save",
    playerSide: "white",
    playMode: "reaction-lens",
    aggressive: true,
    engineDepth: 3,
    startFen: "start-fen",
    currentFen: "current-fen",
    moves: [
      {
        ply: 1,
        actor: "player",
        side: "white",
        coordinate: "e2e4",
        san: "e4",
        fenBefore: "start-fen",
        fenAfter: "after-e4"
      }
    ],
    sideExplore: {
      fen: "current-fen",
      side: "white",
      aggressive: true,
      onTurn: true,
      candidates: [
        {
          move: "g1f3",
          kind: "defense",
          exactScoreCp: 42,
          sound: true,
          sacrifice: false,
          prospectiveBrilliant: false,
          mateIn: null,
          aftermath: null,
          continuation: null
        }
      ],
      principalLine: ["g1f3", "g8f6"],
      mateDetected: false,
      depth: 3,
      nodes: 123,
      soundMarginCp: 50
    },
    completedGame: null
  };
}

const empty = memoryStorage();
expectEqual(readManualAggressiveEvidenceStore(empty), { schemaVersion: 1, sessions: [] });

const storage = memoryStorage();
const firstWrite = appendManualAggressiveEvidenceSession(storage, session("manual-1"));
if (typeof firstWrite === "string") {
  throw new Error(`unexpected store error ${firstWrite}`);
}
expectEqual(firstWrite.sessions.length, 1);
expectEqual(readManualAggressiveEvidenceStore(storage), firstWrite);
expectEqual(JSON.parse(serializeManualAggressiveEvidenceStore(firstWrite)), firstWrite);

const corrupt = memoryStorage(
  new Map([["chess.play.aggressiveEvidenceStore.v1", "{not-json"]])
);
expectEqual(readManualAggressiveEvidenceStore(corrupt), "corrupt-store");

const unsupported = memoryStorage(
  new Map([
    ["chess.play.aggressiveEvidenceStore.v1", JSON.stringify({ schemaVersion: 2, sessions: [] })]
  ])
);
expectEqual(readManualAggressiveEvidenceStore(unsupported), "unsupported-schema");

const bounded = memoryStorage();
for (let index = 0; index < 101; index += 1) {
  const result = appendManualAggressiveEvidenceSession(bounded, session(`manual-${String(index)}`));
  if (typeof result === "string") {
    throw new Error(`unexpected bounded store error ${result}`);
  }
}
const boundedStore = readManualAggressiveEvidenceStore(bounded);
if (typeof boundedStore === "string") {
  throw new Error(`unexpected bounded read error ${boundedStore}`);
}
expectEqual(boundedStore.sessions.length, 100);
expectEqual(boundedStore.sessions[0]?.id, "manual-1");
expectEqual(boundedStore.sessions[99]?.id, "manual-100");

const quotaError = { name: "QuotaExceededError" };
expectEqual(
  appendManualAggressiveEvidenceSession(throwingStorage("setItem", quotaError), session("quota")),
  "storage-quota-exceeded"
);
expectEqual(
  readManualAggressiveEvidenceStore(throwingStorage("getItem", new Error("blocked"))),
  "storage-read-failed"
);
expectEqual(
  clearManualAggressiveEvidenceStore(throwingStorage("removeItem", new Error("blocked"))),
  "storage-remove-failed"
);
expectEqual(clearManualAggressiveEvidenceStore(storage), { schemaVersion: 1, sessions: [] });

// importManualAggressiveEvidenceSessions

const importEmpty = memoryStorage();
const importIntoEmpty = importManualAggressiveEvidenceSessions(
  importEmpty,
  JSON.stringify({ schemaVersion: 1, sessions: [session("imp-1"), session("imp-2")] })
);
if (typeof importIntoEmpty === "string") {
  throw new Error(`unexpected import error ${importIntoEmpty}`);
}
expectEqual(importIntoEmpty.sessions.length, 2);
expectEqual(importIntoEmpty.sessions[0]?.id, "imp-1");
expectEqual(importIntoEmpty.sessions[1]?.id, "imp-2");

const importMergeStorage = memoryStorage();
const preExisting = appendManualAggressiveEvidenceSession(importMergeStorage, session("pre-1"));
if (typeof preExisting === "string") throw new Error(`unexpected error ${preExisting}`);
const importMerge = importManualAggressiveEvidenceSessions(
  importMergeStorage,
  JSON.stringify({ schemaVersion: 1, sessions: [session("pre-1"), session("new-1")] })
);
if (typeof importMerge === "string") throw new Error(`unexpected import merge error ${importMerge}`);
expectEqual(importMerge.sessions.length, 2);

expectEqual(
  importManualAggressiveEvidenceSessions(memoryStorage(), "not json"),
  "import-invalid-json"
);

expectEqual(
  importManualAggressiveEvidenceSessions(
    memoryStorage(),
    JSON.stringify({ schemaVersion: 2, sessions: [] })
  ),
  "import-invalid-schema"
);

function sessionAt(id: string, savedAtIso: string): ManualAggressiveEvidenceSession {
  return { ...session(id), savedAtIso };
}
// Cap test: fill storage with 60 early sessions, then import 60 later sessions;
// combined 120 > 100, result must keep the newest 100.
const capImportStorage = memoryStorage();
// Write 60 sessions with early timestamps (2026-01 through 2026-03) directly into storage.
const earlyStore = {
  schemaVersion: 1,
  sessions: Array.from({ length: 60 }, (_, i) =>
    sessionAt(
      `early-${String(i)}`,
      `2026-0${String(Math.floor(i / 30) + 1)}-${String((i % 30) + 1).padStart(2, "0")}T00:00:00.000Z`
    )
  )
};
const capPreloadResult = importManualAggressiveEvidenceSessions(capImportStorage, JSON.stringify(earlyStore));
if (typeof capPreloadResult === "string") throw new Error(`unexpected preload error ${capPreloadResult}`);
// Now import 60 later sessions (2026-04 through 2026-06).
const lateStore = {
  schemaVersion: 1,
  sessions: Array.from({ length: 60 }, (_, i) =>
    sessionAt(
      `late-${String(i)}`,
      `2026-0${String(Math.floor(i / 30) + 4)}-${String((i % 30) + 1).padStart(2, "0")}T00:00:00.000Z`
    )
  )
};
const capResult = importManualAggressiveEvidenceSessions(capImportStorage, JSON.stringify(lateStore));
if (typeof capResult === "string") throw new Error(`unexpected cap error ${capResult}`);
expectEqual(capResult.sessions.length, 100);
