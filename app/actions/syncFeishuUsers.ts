"use server";

import { revalidatePath } from "next/cache";
import {
  syncFeishuContactUsers,
  type SyncFeishuUsersResult,
} from "@/lib/feishu-user-sync";
import { requireSuperAdmin } from "@/lib/permissions";

export async function syncFeishuUsers(): Promise<SyncFeishuUsersResult> {
  await requireSuperAdmin();

  const result = await syncFeishuContactUsers();
  revalidatePath("/admin");
  return result;
}
