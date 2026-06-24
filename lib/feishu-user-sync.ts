import { fetchAllFeishuContactUsers } from "@/lib/feishu-contact";
import { prisma } from "@/lib/prisma";

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
    const existing = await prisma.user.findUnique({
      where: { openId: contact.openId },
    });

    await prisma.user.upsert({
      where: { openId: contact.openId },
      update: {
        name: contact.name,
        avatar: contact.avatar,
      },
      create: {
        openId: contact.openId,
        name: contact.name,
        avatar: contact.avatar,
      },
    });

    if (existing) updated++;
    else created++;
  }

  return { total: contacts.length, created, updated };
}
