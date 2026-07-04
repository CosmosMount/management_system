import { prisma } from "../lib/prisma";
import { logger, withScriptLogging } from "../lib/logger";

async function main() {
  return withScriptLogging("dedupe-weekly-reports", async () => {
  const reports = await prisma.weeklyReport.findMany({
    orderBy: [
      { taskId: "asc" },
      { weekStart: "asc" },
      { submittedAt: "desc" },
      { id: "asc" },
    ],
    select: { id: true, taskId: true, weekStart: true },
  });

  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const report of reports) {
    const key = `${report.taskId}:${report.weekStart.toISOString()}`;
    if (seen.has(key)) {
      duplicateIds.push(report.id);
      continue;
    }
    seen.add(key);
  }

  if (duplicateIds.length > 0) {
    await prisma.weeklyReport.deleteMany({
      where: { id: { in: duplicateIds } },
    });
  }

  logger.audit("script.dedupe_weekly_reports.completed", {
    module: "script",
    action: "dedupeWeeklyReports",
    keptCount: seen.size,
    deletedCount: duplicateIds.length,
  });
  });
}

main()
  .catch((err) => {
    logger.error("script.dedupe_weekly_reports.failed", {
      module: "script",
      action: "dedupeWeeklyReports",
      error: err,
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
