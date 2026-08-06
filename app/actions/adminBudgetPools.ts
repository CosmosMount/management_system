"use server";

import { revalidatePath } from "next/cache";
import {
  parseBudgetPoolsFromBuffer,
} from "@/lib/import-procurement-budget";
import { currentBudgetPeriod } from "@/lib/procurement-budget-period";
import { requireSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import { persistBudgetPoolImport } from "@/lib/procurement-budget-import-service";
import { validateSpreadsheetFile } from "@/lib/spreadsheet-file";

export async function importBudgetPoolsFromExcel(formData: FormData) {
  await requireSuperAdmin();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("请选择 Excel 文件");
  }
  validateSpreadsheetFile(file);

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
  const upserted = await persistBudgetPoolImport(parsed.rows, mode);

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
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return pools.map((pool) => ({
    id: pool.id,
    description: pool.description,
    team: pool.team,
    techGroup: pool.techGroup,
    period: pool.period,
    budgetAmount: pool.budgetAmount,
    sortOrder: pool.sortOrder,
    lastAlertThreshold: pool.lastAlertThreshold,
    updatedAt: pool.updatedAt.toISOString(),
  }));
}
