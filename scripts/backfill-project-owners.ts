import { prisma } from "@/lib/prisma";
import { logger, withScriptLogging } from "@/lib/logger";

async function main() {
  return withScriptLogging("backfill-project-owners", async () => {
  const projects = await prisma.project.findMany({
    select: {
      id: true,
      ownerOpenId: true,
      ownerName: true,
      owners: { select: { id: true } },
    },
  });

  let created = 0;
  for (const project of projects) {
    if (project.owners.length > 0 || !project.ownerOpenId) continue;
    await prisma.projectOwner.create({
      data: {
        projectId: project.id,
        openId: project.ownerOpenId,
        name: project.ownerName,
        sortOrder: 0,
      },
    });
    created += 1;
  }

  logger.audit("script.backfill_project_owners.completed", {
    module: "script",
    action: "backfillProjectOwners",
    createdCount: created,
  });
  });
}

main()
  .catch((err) => {
    logger.error("script.backfill_project_owners.failed", {
      module: "script",
      action: "backfillProjectOwners",
      error: err,
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
