import { prisma } from "../lib/prisma";

async function main() {
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

  console.log(
    `[dedupe-weekly-reports] 保留 ${seen.size} 条周报，删除 ${duplicateIds.length} 条重复记录`,
  );
}

main()
  .catch((err) => {
    console.error("[dedupe-weekly-reports] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
