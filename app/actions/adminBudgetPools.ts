"use server";

import { revalidatePath } from "next/cache";
import {
  currentBudgetPeriod,
  parseBudgetPoolsFromBuffer,
} from "@/lib/import-procurement-budget";
import { requireSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";

export async function importBudgetPoolsFromExcel(formData: FormData) {
  await requireSuperAdmin();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("请选择 Excel 文件");
  }

  const mode = formData.get("mode");
  if (mode !== "append" && mode !== "replace") {
    throw new Error("请选择追加或覆盖");
  }

  const buffer = await file.arrayBuffer();
  const parsed = parseBudgetPoolsFromBuffer(buffer);
  if (parsed.rows.length === 0) {
    const detail =
      parsed.errors[0]?.message ?? "未解析到有效预算池数据";
    throw new Error(detail);
  }

  if (mode === "replace") {
    const periods = [...new Set(parsed.rows.map((row) => row.period))];
    await prisma.procurementBudgetPool.deleteMany({
      where: { period: { in: periods } },
    });
  }

  let upserted = 0;
  for (const row of parsed.rows) {
    await prisma.procurementBudgetPool.upsert({
      where: {
        team_techGroup_period: {
          team: row.team,
          techGroup: row.techGroup,
          period: row.period,
        },
      },
      create: {
        description: row.description,
        team: row.team,
        techGroup: row.techGroup,
        period: row.period,
        budgetAmount: row.budgetAmount,
        lastAlertThreshold: 0,
      },
      update: {
        description: row.description,
        budgetAmount: row.budgetAmount,
        lastAlertThreshold: 0,
      },
    });
    upserted++;
  }

  revalidatePath("/admin");
  revalidatePath(routes.procurement.dashboard);

  return {
    upserted,
    errors: parsed.errors,
    mode,
  };
}

export async function listAdminBudgetPools() {
  await requireSuperAdmin();

  const period = currentBudgetPeriod();
  const pools = await prisma.procurementBudgetPool.findMany({
    where: { period },
    orderBy: [{ team: "asc" }, { techGroup: "asc" }],
  });

  return pools.map((pool) => ({
    id: pool.id,
    description: pool.description,
    team: pool.team,
    techGroup: pool.techGroup,
    period: pool.period,
    budgetAmount: pool.budgetAmount,
    lastAlertThreshold: pool.lastAlertThreshold,
    updatedAt: pool.updatedAt.toISOString(),
  }));
}
