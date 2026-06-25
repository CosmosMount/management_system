import "dotenv/config";
import { prisma } from "../lib/prisma";

async function main() {
  const rows = await prisma.approvalRecord.findMany({
    orderBy: [{ submissionId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, submissionId: true },
  });

  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const row of rows) {
    if (seen.has(row.submissionId)) {
      duplicateIds.push(row.id);
    } else {
      seen.add(row.submissionId);
    }
  }

  if (duplicateIds.length > 0) {
    await prisma.approvalRecord.deleteMany({
      where: { id: { in: duplicateIds } },
    });
  }

  console.log(
    `[dedupe-approval-records] 保留 ${seen.size} 条审批记录，删除 ${duplicateIds.length} 条重复记录`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
