"use client";

import { removeTaskComposerDraftKeys } from "@/components/project-management/task-composer-draft-storage";

// Release tombstone: keep for at least 30 days after the first production
// deployment of the v4-only draft baseline, then remove this module and its
// call site. It deletes retired data without ever reading or parsing it.
export function taskComposerLegacyDraftKeys(input: {
  accountId: string;
  deploymentEnvironment: string;
  isCreateMode: boolean;
}) {
  if (!input.isCreateMode) return [];
  const prefix = `task-draft:${encodeURIComponent(input.deploymentEnvironment)}:${encodeURIComponent(input.accountId)}`;
  return [`${prefix}:v1`, `${prefix}:v2`, `${prefix}:v3`];
}

export function removeLegacyTaskComposerDrafts(storageKeys: string[]) {
  return retryLegacyDraftCleanup(() => removeTaskComposerDraftKeys(storageKeys));
}

const LEGACY_DRAFT_CLEANUP_RETRY_DELAYS_MS = [0, 250, 1_000] as const;

export async function retryLegacyDraftCleanup(
  cleanup: () => Promise<void>,
  wait: (delayMs: number) => Promise<void> = waitForCleanupRetry,
) {
  let lastError: unknown;
  for (const delayMs of LEGACY_DRAFT_CLEANUP_RETRY_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs);
    try {
      await cleanup();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function waitForCleanupRetry(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}
