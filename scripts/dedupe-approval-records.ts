import "dotenv/config";
import { prisma } from "../lib/prisma";
import { logger, withScriptLogging } from "../lib/logger";

async function main() {
  return withScriptLogging("dedupe-approval-records", async () => {
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

  logger.audit("script.dedupe_approval_records.completed", {
    module: "script",
    action: "dedupeApprovalRecords",
    keptCount: seen.size,
    deletedCount: duplicateIds.length,
  });
  });
}

main()
  .catch((error) => {
    logger.error("script.dedupe_approval_records.failed", {
      module: "script",
      action: "dedupeApprovalRecords",
      error,
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
