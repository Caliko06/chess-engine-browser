import {
  createBrowserSaveMetadataProvider,
  createBrowserStorage,
  type BrowserClock,
  type BrowserCrypto,
  type BrowserStorageHost
} from "./review-browser-edge";
import {
  clearReviewStore,
  readReviewStore,
  upsertStoredReview,
  type StorageLike
} from "./review-store";
import type { StoredReviewV3 } from "./review-store";

function expectEqual<T>(actual: T, expected: T): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`expected ${expectedText}, got ${actualText}`);
  }
}

function memoryStorage(): StorageLike & {
  readonly entries: () => ReadonlyMap<string, string>;
} {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    entries: () => values
  };
}

function storedReview(id: string): StoredReviewV3 {
  return {
    id,
    savedAtIso: "2026-05-17T12:00:00.000Z",
    source: "review-pgn",
    sourcePgn: null,
    review: {
      summary: { totalMoves: 0, best: 0, good: 0, inaccuracies: 0, mistakes: 0, blunders: 0 },
      entries: []
    },
    artifacts: null
  };
}

const hostStorage = memoryStorage();
const browserStorage = createBrowserStorage({ localStorage: hostStorage });
expectEqual(upsertStoredReview(browserStorage, storedReview("legacy id / not uuid")), {
  schemaVersion: 3,
  reviews: [storedReview("legacy id / not uuid")]
});

const unavailableHost = Object.create(null) as BrowserStorageHost;
Object.defineProperty(unavailableHost, "localStorage", {
  get: () => {
    throw new Error("blocked");
  }
});
expectEqual(readReviewStore(createBrowserStorage(unavailableHost)), "storage-unavailable");
expectEqual(readReviewStore(createBrowserStorage({})), "storage-unavailable");
expectEqual(readReviewStore(createBrowserStorage({ localStorage: null })), "storage-unavailable");

const genericReadFailure: StorageLike = {
  getItem: () => {
    throw new Error("read blocked");
  },
  setItem: () => undefined,
  removeItem: () => undefined
};
expectEqual(
  readReviewStore(createBrowserStorage({ localStorage: genericReadFailure })),
  "storage-read-failed"
);

const genericWriteFailure: StorageLike = {
  getItem: () => null,
  setItem: () => {
    throw new Error("write blocked");
  },
  removeItem: () => undefined
};
expectEqual(
  upsertStoredReview(
    createBrowserStorage({ localStorage: genericWriteFailure }),
    storedReview("w")
  ),
  "storage-write-failed"
);

const genericRemoveFailure: StorageLike = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => {
    throw new Error("remove blocked");
  }
};
expectEqual(
  clearReviewStore(createBrowserStorage({ localStorage: genericRemoveFailure })),
  "storage-remove-failed"
);

const quotaStorage: StorageLike = {
  getItem: () => null,
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
  removeItem: () => undefined
};
expectEqual(
  upsertStoredReview(createBrowserStorage({ localStorage: quotaStorage }), storedReview("q")),
  "storage-quota-exceeded"
);

const rawQuotaStorage: StorageLike = {
  getItem: () => null,
  setItem: () => {
    const error = new Error("full");
    error.name = "NS_ERROR_DOM_QUOTA_REACHED";
    throw error;
  },
  removeItem: () => undefined
};
expectEqual(
  upsertStoredReview(createBrowserStorage({ localStorage: rawQuotaStorage }), storedReview("rq")),
  "storage-quota-exceeded"
);

const crypto = {
  randomUUID: () => "550e8400-e29b-41d4-a716-446655440000"
} satisfies BrowserCrypto;
const clock = {
  nowIso: () => "2026-05-17T12:34:56.000Z"
} satisfies BrowserClock;
expectEqual(createBrowserSaveMetadataProvider({ crypto, clock })(), {
  ok: true,
  metadata: {
    id: "550e8400-e29b-41d4-a716-446655440000",
    savedAtIso: "2026-05-17T12:34:56.000Z"
  }
});
expectEqual(createBrowserSaveMetadataProvider({ crypto: {}, clock })(), {
  ok: false,
  error: "metadata-unavailable"
});
expectEqual(
  createBrowserSaveMetadataProvider({
    crypto: { randomUUID: () => "" },
    clock
  })(),
  { ok: false, error: "metadata-unavailable" }
);
expectEqual(
  createBrowserSaveMetadataProvider({
    crypto: { randomUUID: () => "not-a-uuid" },
    clock
  })(),
  { ok: false, error: "metadata-unavailable" }
);
expectEqual(
  createBrowserSaveMetadataProvider({
    crypto: {
      randomUUID: () => {
        throw new Error("crypto blocked");
      }
    },
    clock
  })(),
  { ok: false, error: "metadata-unavailable" }
);
const throwingCrypto = Object.create(null) as BrowserCrypto;
Object.defineProperty(throwingCrypto, "randomUUID", {
  get: () => {
    throw new Error("crypto getter blocked");
  }
});
expectEqual(createBrowserSaveMetadataProvider({ crypto: throwingCrypto, clock })(), {
  ok: false,
  error: "metadata-unavailable"
});
expectEqual(
  createBrowserSaveMetadataProvider({
    crypto,
    clock: {
      nowIso: () => {
        throw new Error("clock blocked");
      }
    }
  })(),
  { ok: false, error: "metadata-unavailable" }
);
