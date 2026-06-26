"use server";

import { requireSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { revalidateAdmin } from "@/lib/revalidate";
import { MAX_ACCEPTANCE_CHECKLIST_ITEM_LENGTH } from "@/lib/validations/progress";

export async function createAcceptanceChecklistTemplate(content: string) {
  await requireSuperAdmin();
  const normalized = content.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("请输入验收条例");
  }
  if (normalized.length > MAX_ACCEPTANCE_CHECKLIST_ITEM_LENGTH) {
    throw new Error(
      `验收条例不能超过 ${MAX_ACCEPTANCE_CHECKLIST_ITEM_LENGTH} 个字符`,
    );
  }

  const maxSort = await prisma.acceptanceChecklistTemplate.aggregate({
    _max: { sortOrder: true },
  });

  await prisma.acceptanceChecklistTemplate.upsert({
    where: { content: normalized },
    update: {},
    create: {
      content: normalized,
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    },
  });

  revalidateAdmin();
}

export async function deleteAcceptanceChecklistTemplate(id: string) {
  await requireSuperAdmin();
  await prisma.acceptanceChecklistTemplate.delete({ where: { id } });
  revalidateAdmin();
}
