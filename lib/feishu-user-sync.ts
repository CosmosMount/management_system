import { fetchAllFeishuContactUsers } from "@/lib/feishu-contact";
import { resolveFeishuIdentityForUser } from "@/lib/project-management/identity";

export type SyncFeishuUsersResult = {
  total: number;
  created: number;
  updated: number;
};

export async function syncFeishuContactUsers(): Promise<SyncFeishuUsersResult> {
  const contacts = await fetchAllFeishuContactUsers();
  if (contacts.length === 0) {
    throw new Error("飞书通讯录未返回任何用户，请检查应用通讯录权限范围");
  }

  let created = 0;
  let updated = 0;

  for (const contact of contacts) {
    const identity = await resolveFeishuIdentityForUser({
      openId: contact.openId,
      unionId: contact.unionId,
      name: contact.name,
      avatar: contact.avatar,
    });
    if (identity.reimbursementUserCreated) created++;
    else updated++;
  }

  return { total: contacts.length, created, updated };
}
