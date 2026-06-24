import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ACCEPTANCE_CHECKLIST_TEMPLATES } from "@/lib/progress-acceptance-checklists";

async function main() {
  for (const [index, content] of DEFAULT_ACCEPTANCE_CHECKLIST_TEMPLATES.entries()) {
    await prisma.acceptanceChecklistTemplate.upsert({
      where: { content },
      update: {},
      create: {
        content,
        sortOrder: index,
      },
    });
  }

  console.log(
    `验收条例模板 seed 完成，共 ${DEFAULT_ACCEPTANCE_CHECKLIST_TEMPLATES.length} 条`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
