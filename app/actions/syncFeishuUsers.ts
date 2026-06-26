"use server";

import {
  syncFeishuContactUsers,
  type SyncFeishuUsersResult,
} from "@/lib/feishu-user-sync";
import { requireSuperAdmin } from "@/lib/permissions";
import { revalidateAdmin } from "@/lib/revalidate";

export async function syncFeishuUsers(): Promise<SyncFeishuUsersResult> {
  await requireSuperAdmin();

  const result = await syncFeishuContactUsers();
  revalidateAdmin();
  return result;
}
