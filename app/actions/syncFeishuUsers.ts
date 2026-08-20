"use server";

import {
  FeishuContactSyncConfirmationRequiredError,
  syncFeishuContactUsers,
  type SyncFeishuUsersResult,
} from "@/lib/feishu-user-sync";
import { requireGlobalSuperAdministrator } from "@/lib/account-authorization";
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
    };

const syncInputSchema = z
  .object({
    confirmationToken: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .optional();

export async function syncFeishuUsers(
  input?: unknown,
): Promise<SyncFeishuUsersActionResult> {
  const { context } = await requireGlobalSuperAdministrator();
  const parsed = syncInputSchema.parse(input);

  try {
    const result = await syncFeishuContactUsers({
      requestedByAccountId: context.accountId,
      snapshotDropConfirmationToken: parsed?.confirmationToken,
      confirmedByAccountId: parsed?.confirmationToken
        ? context.accountId
        : undefined,
    });
    revalidateAdmin();
    return { status: "synced", result };
  } catch (error) {
    if (error instanceof FeishuContactSyncConfirmationRequiredError) {
      return {
        status: "confirmation_required",
        confirmationToken: error.confirmationToken,
        deactivateCount: error.deactivateCount,
        activeAccountCount: error.activeAccountCount,
      };
    }
    throw error;
  }
}
