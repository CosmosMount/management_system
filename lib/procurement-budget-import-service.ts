import type { BudgetPoolImportRow } from "@/lib/import-procurement-budget";
import { prisma } from "@/lib/prisma";

export async function persistBudgetPoolImport(
  rows: BudgetPoolImportRow[],
  mode: "append" | "replace",
): Promise<number> {
  return prisma.$transaction(async (tx) => {
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

    for (const [index, row] of rows.entries()) {
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
