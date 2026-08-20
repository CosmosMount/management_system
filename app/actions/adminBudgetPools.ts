"use server";

import { revalidatePath } from "next/cache";
import {
  parseBudgetPoolsFromBuffer,
} from "@/lib/import-procurement-budget";
import { currentBudgetPeriod } from "@/lib/procurement-budget-period";
import { requireGlobalSuperAdministrator } from "@/lib/account-authorization";
import { requireSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import { persistBudgetPoolImport } from "@/lib/procurement-budget-import-service";
import {
  resolveBudgetGroupLastAlertThreshold,
  selectEffectiveBudgetPools,
} from "@/lib/procurement-budget";
import { validateSpreadsheetFile } from "@/lib/spreadsheet-file";

export async function importBudgetPoolsFromExcel(formData: FormData) {
  const { session, context } = await requireGlobalSuperAdministrator();

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
  const upserted = await persistBudgetPoolImport(
    parsed.rows,
    mode,
    {
      accountId: context.accountId,
      openId: session.user.openId!,
    },
  );

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

  const poolsByGroup = new Map<string, typeof pools>();
  for (const pool of pools) {
    const key = JSON.stringify([pool.team, pool.period]);
    const groupPools = poolsByGroup.get(key) ?? [];
    groupPools.push(pool);
    poolsByGroup.set(key, groupPools);
  }

  return Promise.all([...poolsByGroup.entries()].map(async ([key, groupPools]) => {
    const sample = groupPools[0]!;
    const effectivePools = selectEffectiveBudgetPools(groupPools);
    return {
      id: key,
      team: sample.team,
      projects: [
        ...new Set(
          groupPools.flatMap((pool) => {
            const project = pool.description.trim();
            return project ? [project] : [];
          }),
        ),
      ],
      period: sample.period,
      budgetAmount: effectivePools.reduce(
        (sum, pool) => sum + pool.budgetAmount,
        0,
      ),
      sortOrder: Math.min(...groupPools.map((pool) => pool.sortOrder)),
      lastAlertThreshold: await resolveBudgetGroupLastAlertThreshold(
        sample.team,
        sample.period,
        groupPools,
      ),
      updatedAt: new Date(
        Math.max(...groupPools.map((pool) => pool.updatedAt.getTime())),
      ).toISOString(),
    };
  }));
}
