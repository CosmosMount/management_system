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
  removeTaskComposerDraftKeys,
  withTaskComposerDraftLock,
} from "@/components/project-management/task-composer-draft-storage";
import { removeLegacyTaskComposerDrafts } from "@/components/project-management/task-composer-legacy-draft-tombstone";
import {
  LOCAL_DRAFT_SCHEMA_VERSION,
  localDraftContextError,
  parseLocalDraft,
  type LocalDraftRecovery,
  type LocalTaskDraft,
} from "@/components/project-management/task-composer-local-draft";
import type { TaskComposerSeed } from "@/lib/project-management/composer-contract";

export function useTaskComposerDraft({
  dirty,
  editContext,
  retiredStorageKeys,
  setError,
  state,
  storageBusy,
  storageKey,
  submitting,
}: {
  dirty: boolean;
  editContext: LocalTaskDraft["editContext"];
  retiredStorageKeys: string[];
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
          try {
            await removeLegacyTaskComposerDrafts(retiredStorageKeys);
          } catch {
            if (!cancelled) {
              setError(
                "旧版本地草稿清理未完成；当前 v4 草稿仍可使用，下次打开页面时会再次清理。",
              );
            }
          }
          await withTaskComposerDraftLock(storageKey, async () => {
            const currentRaw = window.localStorage.getItem(storageKey);
            if (currentRaw && isRetiredDraftMarker(currentRaw)) {
              await removeTaskComposerDraftKeys([storageKey]);
              if (!cancelled) setStorageReady(true);
              return;
            }
            preservedRaw = currentRaw;

            let parsed: LocalTaskDraft | null = null;
            if (currentRaw) {
              const pointer = parseIndexedDraftPointer(currentRaw);
              if (pointer) {
                const indexedRaw = await readIndexedDraft(storageKey);
                preservedRaw = indexedRaw ?? currentRaw;
                parsed = indexedRaw ? parseLocalDraft(indexedRaw) : null;
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
            } else if (canUseIndexedDraftStorage()) {
              const indexedRaw = await readIndexedDraft(storageKey);
              if (indexedRaw) {
                preservedRaw = indexedRaw;
                parsed = parseLocalDraft(indexedRaw);
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
              "浏览器本地草稿不可用；你仍可创建任务，但刷新后内容可能丢失。",
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
    editContext,
    retiredStorageKeys,
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
      setError("本地草稿保存失败，页面仍停留在编辑器，请不要刷新。");
      return false;
    }
  }, [cancelPendingAutoSave, editContext, queueDraftWrite, setError, state]);

  const discardLocalDraft = useCallback(async () => {
    cancelPendingAutoSave();
    try {
      await draftWriteChainRef.current.catch(() => undefined);
      await removeTaskComposerDraft(storageKey);
      return true;
    } catch {
      setError(
        "浏览器拒绝删除本地草稿；为避免旧草稿再次出现，当前不会离开页面。",
      );
      return false;
    }
  }, [
    cancelPendingAutoSave,
    setError,
    storageKey,
  ]);

  const cleanupCommittedDraft = useCallback(async () => {
    cancelPendingAutoSave();
    await draftWriteChainRef.current.catch(() => undefined);
    await removeTaskComposerDraft(storageKey);
  }, [
    cancelPendingAutoSave,
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

function isRetiredDraftMarker(raw: string) {
  if (raw.length > 2_048) return false;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const schemaVersion = (value as Record<string, unknown>).schemaVersion;
    return schemaVersion === 1 || schemaVersion === 2 || schemaVersion === 3;
  } catch {
    return false;
  }
}
