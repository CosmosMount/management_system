import { AcceptanceTemplatesPanel } from "@/components/admin/acceptance-templates-panel";
import { prisma } from "@/lib/prisma";

export default async function AdminAcceptancePage() {
  const templates = await prisma.acceptanceChecklistTemplate.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return (
    <AcceptanceTemplatesPanel
      templates={templates.map((template) => ({
        ...template,
        createdAt: template.createdAt.toISOString(),
        updatedAt: template.updatedAt.toISOString(),
      }))}
    />
  );
}
