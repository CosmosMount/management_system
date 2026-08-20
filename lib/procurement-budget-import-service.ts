import type { BudgetPoolImportRow } from "@/lib/import-procurement-budget";
import {
  assertActiveGlobalSuperAdministratorTx,
} from "@/lib/account-authorization";
import {
  lockActiveProcurementUserTx,
  lockFeishuContactSyncTx,
} from "@/lib/active-account";
import { prisma } from "@/lib/prisma";
import { lockGlobalApprovalAdministratorSetTx } from "@/lib/project-management/approval-administrators";

export async function persistBudgetPoolImport(
  rows: BudgetPoolImportRow[],
  mode: "append" | "replace",
  actor?: { accountId: string; openId: string },
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    if (actor) {
      await lockFeishuContactSyncTx(tx);
      await lockGlobalApprovalAdministratorSetTx(tx);
      await lockActiveProcurementUserTx(tx, actor.openId);
      await assertActiveGlobalSuperAdministratorTx(tx, actor.accountId);
    }
    const periods = [...new Set(rows.map((row) => row.period))].sort();
    for (const period of periods) {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${`procurement-budget-import:${period}`})
        )
      `;
    }

    if (mode === "replace") {
      await tx.procurementBudgetPool.deleteMany({
        where: { period: { in: periods } },
      });
    }

    for (const [index, inputRow] of rows.entries()) {
      // 持久化统一使用兵种组业务键；历史技术方向行保留，并在读取时由
      // 同“项目+兵种组+周期”的规范行覆盖，避免破坏历史配置。
      const row = { ...inputRow, techGroup: "" };
      await tx.procurementBudgetPool.upsert({
        where: {
          description_team_techGroup_period: {
            description: row.description,
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
          sortOrder: index,
          lastAlertThreshold: 0,
        },
        update: {
          budgetAmount: row.budgetAmount,
          sortOrder: index,
          lastAlertThreshold: 0,
        },
      });
    }
    return rows.length;
  });
}
