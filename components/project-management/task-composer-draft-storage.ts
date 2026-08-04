const TASK_COMPOSER_DRAFT_DATABASE = "management-system-task-composer";
const TASK_COMPOSER_DRAFT_DATABASE_VERSION = 1;
const TASK_COMPOSER_DRAFT_STORE = "drafts";
const TASK_COMPOSER_DRAFT_LOCK_PREFIX = "management-system:task-composer-draft:";
const INLINE_DRAFT_MAX_CHARS = 500_000;

export const MAX_TASK_COMPOSER_DRAFT_CHARS = 16_000_000;

export type IndexedDraftPointer = {
  schemaVersion: 3;
  storage: "INDEXED_DB";
  draftId: string;
  savedAt: string;
  serializedChars: number;
};

export function parseIndexedDraftPointer(raw: string): IndexedDraftPointer | null {
  if (raw.length > 2_048) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const pointer = value as Record<string, unknown>;
    if (
      pointer.schemaVersion !== 3 ||
      pointer.storage !== "INDEXED_DB" ||
      typeof pointer.draftId !== "string" ||
      typeof pointer.savedAt !== "string" ||
      typeof pointer.serializedChars !== "number" ||
      !Number.isInteger(pointer.serializedChars) ||
      pointer.serializedChars <= 0 ||
      pointer.serializedChars > MAX_TASK_COMPOSER_DRAFT_CHARS
    ) {
      return null;
    }
    return value as IndexedDraftPointer;
  } catch {
    return null;
  }
}

export function canUseIndexedDraftStorage() {
  return typeof indexedDB !== "undefined";
}

export async function withTaskComposerDraftLock<T>(
  storageKey: string,
  action: () => Promise<T>,
) {
  if (!("locks" in navigator)) return action();
  return navigator.locks.request(
    `${TASK_COMPOSER_DRAFT_LOCK_PREFIX}${storageKey}`,
    { mode: "exclusive" },
    action,
  );
}

export async function readIndexedDraft(storageKey: string) {
  const database = await openDraftDatabase();
  return new Promise<string | null>((resolve, reject) => {
    const transaction = database.transaction(TASK_COMPOSER_DRAFT_STORE, "readonly");
    const request = transaction.objectStore(TASK_COMPOSER_DRAFT_STORE).get(storageKey);
    let result: string | null = null;
    request.onsuccess = () => {
      result = typeof request.result === "string" ? request.result : null;
    };
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("读取 IndexedDB 草稿失败"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("读取 IndexedDB 草稿已中止"));
    };
  });
}

export async function persistTaskComposerDraft(input: {
  storageKey: string;
  raw: string;
  draftId: string;
  savedAt: string;
}) {
  return withTaskComposerDraftLock(input.storageKey, async () => {
    if (input.raw.length > MAX_TASK_COMPOSER_DRAFT_CHARS) {
      throw new Error("Task Composer 草稿超过安全存储上限");
    }

    if (input.raw.length <= INLINE_DRAFT_MAX_CHARS) {
      try {
        window.localStorage.setItem(input.storageKey, input.raw);
        await deleteIndexedDraft(input.storageKey).catch(() => undefined);
        return;
      } catch {
        // A full localStorage can reject even a small draft. IndexedDB remains a
        // safe fallback while the scoped localStorage entry is reduced to a pointer.
      }
    }

    await writeIndexedDraft(input.storageKey, input.raw);
    const pointer: IndexedDraftPointer = {
      schemaVersion: 3,
      storage: "INDEXED_DB",
      draftId: input.draftId,
      savedAt: input.savedAt,
      serializedChars: input.raw.length,
    };
    window.localStorage.setItem(input.storageKey, JSON.stringify(pointer));
  });
}

export async function removeTaskComposerDraft(
  storageKey: string,
  legacyStorageKeys: string[],
) {
  return withTaskComposerDraftLock(storageKey, async () => {
    window.localStorage.removeItem(storageKey);
    for (const legacyStorageKey of legacyStorageKeys) {
      window.localStorage.removeItem(legacyStorageKey);
    }
    await deleteIndexedDraft(storageKey);
  });
}

async function writeIndexedDraft(storageKey: string, raw: string) {
  const database = await openDraftDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(TASK_COMPOSER_DRAFT_STORE, "readwrite");
    transaction.objectStore(TASK_COMPOSER_DRAFT_STORE).put(raw, storageKey);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("写入 IndexedDB 草稿失败"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("写入 IndexedDB 草稿已中止"));
    };
  });
}

async function deleteIndexedDraft(storageKey: string) {
  if (!canUseIndexedDraftStorage()) return;
  const database = await openDraftDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(TASK_COMPOSER_DRAFT_STORE, "readwrite");
    transaction.objectStore(TASK_COMPOSER_DRAFT_STORE).delete(storageKey);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("删除 IndexedDB 草稿失败"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("删除 IndexedDB 草稿已中止"));
    };
  });
}

function openDraftDatabase() {
  if (!canUseIndexedDraftStorage()) {
    return Promise.reject(new Error("当前浏览器不支持 IndexedDB"));
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(
      TASK_COMPOSER_DRAFT_DATABASE,
      TASK_COMPOSER_DRAFT_DATABASE_VERSION,
    );
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(TASK_COMPOSER_DRAFT_STORE)) {
        request.result.createObjectStore(TASK_COMPOSER_DRAFT_STORE);
      }
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("打开 IndexedDB 失败"));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("IndexedDB 升级被其他页面阻塞"));
    };
  });
}
