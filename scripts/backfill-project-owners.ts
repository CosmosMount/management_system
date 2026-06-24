import { prisma } from "@/lib/prisma";

async function main() {
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

  console.log(`Backfilled ${created} project owner records.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
