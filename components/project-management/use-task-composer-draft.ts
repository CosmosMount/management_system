"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  canUseIndexedDraftStorage,
  parseIndexedDraftPointer,
  persistTaskComposerDraft,
  readIndexedDraft,
  removeTaskComposerDraft,
  withTaskComposerDraftLock,
} from "@/components/project-management/task-composer-draft-storage";
import {
  LOCAL_DRAFT_SCHEMA_VERSION,
  localDraftContextError,
  migrateLegacyLocalDraft,
  parseLocalDraft,
  type LocalDraftRecovery,
  type LocalTaskDraft,
} from "@/components/project-management/task-composer-local-draft";
import type { TaskComposerSeed } from "@/lib/project-management/composer-contract";

export function useTaskComposerDraft({
  actorPersonId,
  dirty,
  editContext,
  legacyStorageKeyV1,
  legacyStorageKeyV2,
  legacyStorageKeyV3,
  setError,
  state,
  storageBusy,
  storageKey,
  submitting,
}: {
  actorPersonId: string;
  dirty: boolean;
  editContext: LocalTaskDraft["editContext"];
  legacyStorageKeyV1: string | null;
  legacyStorageKeyV2: string | null;
  legacyStorageKeyV3: string | null;
  setError: Dispatch<SetStateAction<string>>;
  state: TaskComposerSeed;
  storageBusy: boolean;
  storageKey: string;
  submitting: boolean;
}) {
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<LocalDraftRecovery | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const draftWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const autoSaveTimerRef = useRef<number | null>(null);

  const queueDraftWrite = useCallback(
    (draft: LocalTaskDraft) => {
      const raw = JSON.stringify(draft);
      const write = draftWriteChainRef.current
        .catch(() => undefined)
        .then(() =>
          persistTaskComposerDraft({
            storageKey,
            raw,
            draftId: draft.draftId,
            savedAt: draft.savedAt,
          }),
        );
      draftWriteChainRef.current = write.catch(() => undefined);
      return write;
    },
    [storageKey],
  );

  const cancelPendingAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current === null) return;
    window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        let preservedRaw: string | null = null;
        let unavailableReason = "";
        try {
          await withTaskComposerDraftLock(storageKey, async () => {
            const currentRaw = window.localStorage.getItem(storageKey);
            const legacyRawV3 = currentRaw || !legacyStorageKeyV3
              ? null
              : window.localStorage.getItem(legacyStorageKeyV3);
            const legacyRawV2 = currentRaw || legacyRawV3 || !legacyStorageKeyV2
              ? null
              : window.localStorage.getItem(legacyStorageKeyV2);
            const legacyRawV1 =
              currentRaw || legacyRawV3 || legacyRawV2 || !legacyStorageKeyV1
                ? null
                : window.localStorage.getItem(legacyStorageKeyV1);
            preservedRaw = currentRaw ?? legacyRawV3 ?? legacyRawV2 ?? legacyRawV1;

            let parsed: LocalTaskDraft | null = null;
            if (currentRaw) {
              const pointer = parseIndexedDraftPointer(currentRaw);
              if (pointer) {
                const indexedRaw = await readIndexedDraft(storageKey);
                preservedRaw = indexedRaw ?? currentRaw;
                parsed =
                  pointer.schemaVersion === LOCAL_DRAFT_SCHEMA_VERSION && indexedRaw
                    ? parseLocalDraft(indexedRaw)
                    : null;
                if (
                  parsed &&
                  (parsed.draftId !== pointer.draftId ||
                    parsed.savedAt !== pointer.savedAt ||
                    indexedRaw?.length !== pointer.serializedChars)
                ) {
                  parsed = null;
                }
                if (!indexedRaw) {
                  unavailableReason =
                    "本地草稿索引存在，但大草稿内容缺失或不可读取。";
                }
              } else {
                parsed = parseLocalDraft(currentRaw);
              }
            } else if (legacyRawV3 && legacyStorageKeyV3) {
              const pointer = parseIndexedDraftPointer(legacyRawV3);
              if (pointer) {
                const indexedRaw = await readIndexedDraft(legacyStorageKeyV3);
                preservedRaw = indexedRaw ?? legacyRawV3;
                if (!indexedRaw) {
                  unavailableReason =
                    "旧版本地草稿索引存在，但大草稿内容缺失或不可读取。";
                }
              }
            } else if (legacyRawV2) {
              parsed = migrateLegacyLocalDraft(legacyRawV2, actorPersonId, 2);
            } else if (legacyRawV1) {
              parsed = migrateLegacyLocalDraft(legacyRawV1, actorPersonId, 1);
            } else if (canUseIndexedDraftStorage()) {
              const indexedRaw = await readIndexedDraft(storageKey);
              if (indexedRaw) {
                preservedRaw = indexedRaw;
                parsed = parseLocalDraft(indexedRaw);
              } else if (legacyStorageKeyV3) {
                const legacyIndexedRaw = await readIndexedDraft(legacyStorageKeyV3);
                if (legacyIndexedRaw) preservedRaw = legacyIndexedRaw;
              }
            }

            if (cancelled) return;
            const contextError = parsed
              ? localDraftContextError(parsed, editContext)
              : null;
            if (parsed && !contextError) {
              setRecovery({ kind: "VALID", draft: parsed });
              setSavedAt(parsed.savedAt);
            } else if (preservedRaw) {
              setRecovery({
                kind: "INCOMPATIBLE",
                raw: preservedRaw,
                reason:
                  unavailableReason ||
                  contextError ||
                  "草稿版本、结构或字段不兼容，未自动覆盖或删除原始内容。",
              });
            } else {
              setStorageReady(true);
            }
          });
        } catch {
          if (cancelled) return;
          if (preservedRaw) {
            setRecovery({
              kind: "INCOMPATIBLE",
              raw: preservedRaw,
              reason:
                "浏览器无法读取本地大草稿；原始索引仍保留，未自动覆盖或删除。",
            });
          } else {
            setStorageReady(true);
            setError(
              "浏览器本地草稿不可用；你仍可创建 Task，但刷新后内容可能丢失。",
            );
          }
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    actorPersonId,
    editContext,
    legacyStorageKeyV1,
    legacyStorageKeyV2,
    legacyStorageKeyV3,
    setError,
    storageKey,
  ]);

  useEffect(() => {
    if (!storageReady || recovery || !dirty || submitting || storageBusy) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      const saved = new Date().toISOString();
      const envelope: LocalTaskDraft = {
        schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
        draftId: state.draftId,
        savedAt: saved,
        task: state,
        inspectorDraft: null,
        inspectorDirty: false,
        ...(editContext ? { editContext } : {}),
      };
      void queueDraftWrite(envelope)
        .then(() => {
          if (!cancelled) setSavedAt(saved);
        })
        .catch(() => {
          if (!cancelled) {
            setError(
              "本地草稿保存失败，请不要刷新页面并尽快复制重要内容。",
            );
          }
        });
    }, 700);
    autoSaveTimerRef.current = timer;
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (autoSaveTimerRef.current === timer) {
        autoSaveTimerRef.current = null;
      }
    };
  }, [
    dirty,
    editContext,
    queueDraftWrite,
    recovery,
    setError,
    state,
    storageBusy,
    storageReady,
    submitting,
  ]);

  const persistLocalDraftNow = useCallback(async () => {
    cancelPendingAutoSave();
    const saved = new Date().toISOString();
    try {
      await queueDraftWrite({
        schemaVersion: LOCAL_DRAFT_SCHEMA_VERSION,
        draftId: state.draftId,
        savedAt: saved,
        task: state,
        inspectorDraft: null,
        inspectorDirty: false,
        ...(editContext ? { editContext } : {}),
      });
      setSavedAt(saved);
      return true;
    } catch {
      setError("本地草稿保存失败，页面仍停留在 Composer，请不要刷新。");
      return false;
    }
  }, [cancelPendingAutoSave, editContext, queueDraftWrite, setError, state]);

  const discardLocalDraft = useCallback(async () => {
    cancelPendingAutoSave();
    try {
      await draftWriteChainRef.current.catch(() => undefined);
      await removeTaskComposerDraft(
        storageKey,
        [legacyStorageKeyV1, legacyStorageKeyV2, legacyStorageKeyV3].filter(
          (key): key is string => Boolean(key),
        ),
      );
      return true;
    } catch {
      setError(
        "浏览器拒绝删除本地草稿；为避免旧草稿再次出现，当前不会离开页面。",
      );
      return false;
    }
  }, [
    cancelPendingAutoSave,
    legacyStorageKeyV1,
    legacyStorageKeyV2,
    legacyStorageKeyV3,
    setError,
    storageKey,
  ]);

  const cleanupCommittedDraft = useCallback(async () => {
    cancelPendingAutoSave();
    await draftWriteChainRef.current.catch(() => undefined);
    await removeTaskComposerDraft(
      storageKey,
      [legacyStorageKeyV1, legacyStorageKeyV2, legacyStorageKeyV3].filter(
        (key): key is string => Boolean(key),
      ),
    );
  }, [
    cancelPendingAutoSave,
    legacyStorageKeyV1,
    legacyStorageKeyV2,
    legacyStorageKeyV3,
    storageKey,
  ]);

  return {
    cancelPendingAutoSave,
    cleanupCommittedDraft,
    discardLocalDraft,
    persistLocalDraftNow,
    recovery,
    savedAt,
    setRecovery,
    setSavedAt,
    setStorageReady,
    storageReady,
  };
}
