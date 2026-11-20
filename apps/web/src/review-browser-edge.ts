import {
  storageOperationError,
  type StorageLike,
  type StorageOperationErrorReason
} from "./review-store.js";
import type { SaveWorkflowReviewMetadataResult } from "./review-workflow.js";

export type BrowserStorageHost = {
  readonly localStorage?: StorageLike | null;
};

export type BrowserCrypto = {
  readonly randomUUID?: () => string;
};

export type BrowserClock = {
  readonly nowIso: () => string;
};

export type BrowserMetadataHost = {
  readonly crypto: BrowserCrypto;
  readonly clock: BrowserClock;
};

export function createBrowserStorage(host: BrowserStorageHost = window): StorageLike {
  let localStorage: StorageLike;
  try {
    const candidate = host.localStorage;
    if (candidate === undefined || candidate === null) {
      return unavailableStorage();
    }
    localStorage = candidate;
  } catch {
    return unavailableStorage();
  }

  return {
    getItem: (key: string) => {
      try {
        return localStorage.getItem(key);
      } catch (error) {
        throw storageOperationError(classifyStorageFailure(error, "storage-read-failed"));
      }
    },
    setItem: (key: string, value: string) => {
      try {
        localStorage.setItem(key, value);
      } catch (error) {
        throw storageOperationError(classifyStorageFailure(error, "storage-write-failed"));
      }
    },
    removeItem: (key: string) => {
      try {
        localStorage.removeItem(key);
      } catch (error) {
        throw storageOperationError(classifyStorageFailure(error, "storage-remove-failed"));
      }
    }
  };
}

export function createBrowserSaveMetadataProvider(
  host: BrowserMetadataHost = {
    crypto: window.crypto,
    clock: { nowIso: () => new Date().toISOString() }
  }
): () => SaveWorkflowReviewMetadataResult {
  return () => {
    try {
      const randomUuid = host.crypto.randomUUID;
      if (typeof randomUuid !== "function") {
        return { ok: false, error: "metadata-unavailable" };
      }

      const id = randomUuid.call(host.crypto);
      const savedAtIso = host.clock.nowIso();
      if (!isUuid(id) || savedAtIso.length === 0) {
        return { ok: false, error: "metadata-unavailable" };
      }
      return { ok: true, metadata: { id, savedAtIso } };
    } catch {
      return { ok: false, error: "metadata-unavailable" };
    }
  };
}

function unavailableStorage(): StorageLike {
  return {
    getItem: () => {
      throw storageOperationError("storage-unavailable");
    },
    setItem: () => {
      throw storageOperationError("storage-unavailable");
    },
    removeItem: () => {
      throw storageOperationError("storage-unavailable");
    }
  };
}

function classifyStorageFailure(
  error: unknown,
  fallback: StorageOperationErrorReason
): StorageOperationErrorReason {
  if (isQuotaExceeded(error)) {
    return "storage-quota-exceeded";
  }
  return fallback;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value
  );
}
