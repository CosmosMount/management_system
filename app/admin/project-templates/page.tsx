import { ProjectTemplatesPanel } from "@/components/admin/project-templates-panel";
import { prisma } from "@/lib/prisma";

export default async function AdminProjectTemplatesPage() {
  const templates = await prisma.projectTemplate.findMany({
    include: {
      stages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
    orderBy: [{ isDefault: "desc" }, { enabled: "desc" }, { sortOrder: "asc" }],
  });

  return (
    <ProjectTemplatesPanel
      templates={templates.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        isDefault: template.isDefault,
        enabled: template.enabled,
        sortOrder: template.sortOrder,
        createdAt: template.createdAt.toISOString(),
        updatedAt: template.updatedAt.toISOString(),
        stages: template.stages.map((stage) => ({
          id: stage.id,
          name: stage.name,
          goal: stage.goal,
          durationDays: stage.dueOffsetDays,
          sortOrder: stage.sortOrder,
        })),
      }))}
    />
  );
}
