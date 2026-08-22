"use server";

import {
  FeishuContactSyncConfirmationRequiredError,
  syncFeishuContactUsers,
  type SyncFeishuUsersResult,
} from "@/lib/feishu-user-sync";
import { requireGlobalSuperAdministrator } from "@/lib/account-authorization";
import {
  toFeishuUserSyncActionFailure,
  type FeishuUserSyncActionFailure,
} from "@/lib/feishu-user-sync-action-result";
import { logger } from "@/lib/logger";
import { revalidateAdmin } from "@/lib/revalidate";
import { z } from "zod";

export type SyncFeishuUsersActionResult =
  | {
      status: "confirmation_required";
      confirmationToken: string;
      deactivateCount: number;
      activeAccountCount: number;
    }
  | {
      status: "synced";
      result: SyncFeishuUsersResult;
    }
  | {
      status: "failed";
      error: FeishuUserSyncActionFailure;
    };

const syncInputSchema = z
  .object({
    confirmationToken: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .optional();

export async function syncFeishuUsers(
  input?: unknown,
): Promise<SyncFeishuUsersActionResult> {
  const startedAt = Date.now();
  let actorAccountId: string | undefined;
  try {
    const { context } = await requireGlobalSuperAdministrator();
    actorAccountId = context.accountId;
    const parsed = syncInputSchema.parse(input);
    const result = await syncFeishuContactUsers({
      requestedByAccountId: context.accountId,
      snapshotDropConfirmationToken: parsed?.confirmationToken,
      confirmedByAccountId: parsed?.confirmationToken
        ? context.accountId
        : undefined,
    });
    revalidateAdmin();
    logger.audit("admin.feishu_contact_sync.completed", {
      module: "admin",
      action: "syncFeishuUsers",
      actorAccountId,
      durationMs: Date.now() - startedAt,
      result: "success",
      total: result.total,
      created: result.created,
      updated: result.updated,
      reactivated: result.reactivated,
      deactivated: result.deactivated,
    });
    return { status: "synced", result };
  } catch (error) {
    if (error instanceof FeishuContactSyncConfirmationRequiredError) {
      logger.warn("admin.feishu_contact_sync.confirmation_required", {
        module: "admin",
        action: "syncFeishuUsers",
        actorAccountId,
        durationMs: Date.now() - startedAt,
        result: "prepared",
        deactivateCount: error.deactivateCount,
        activeAccountCount: error.activeAccountCount,
      });
      return {
        status: "confirmation_required",
        confirmationToken: error.confirmationToken,
        deactivateCount: error.deactivateCount,
        activeAccountCount: error.activeAccountCount,
      };
    }
    const failure = toFeishuUserSyncActionFailure(error);
    logger[failure.code === "INTERNAL_ERROR" ? "error" : "warn"](
      "admin.feishu_contact_sync.failed",
      {
        module: "admin",
        action: "syncFeishuUsers",
        actorAccountId,
        durationMs: Date.now() - startedAt,
        result: "failure",
        syncFailureCode: failure.code,
        error,
      },
    );
    return { status: "failed", error: failure };
  }
}
