import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { AppHeader } from "@/components/app-header";
import { ProjectForm } from "@/components/progress/project-form";
import { ProgressBackLink } from "@/components/progress/progress-back-link";
import { ProgressPageLayout } from "@/components/progress/progress-page-layout";
import { PageShell } from "@/components/page-shell";
import { PageTitle } from "@/components/page-title";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createProjectSchema,
  type ParsedCreateProjectInput,
} from "@/lib/validations/progress";

type SourceProject = Prisma.ProjectGetPayload<{
  include: {
    owners: true;
    participants: true;
    stages: true;
  };
}>;

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function NewProjectPage({ searchParams }: Props) {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  if (!userOpenId) {
    notFound();
  }
  const params = searchParams ? await searchParams : {};
  const fromProjectParam = params.fromProject;
  const fromProject =
    typeof fromProjectParam === "string" ? fromProjectParam.trim() : "";

  const sourceProject = fromProject
    ? await prisma.project.findFirst({
        where: {
          id: fromProject,
          requesterOpenId: userOpenId,
          status: "ESTABLISHMENT_REJECTED",
        },
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          stages: { orderBy: { sortOrder: "asc" } },
        },
      })
    : null;
  if (fromProject && !sourceProject) {
    notFound();
  }
  const initialDraft = sourceProject
    ? projectToInitialDraft(sourceProject)
    : null;

  const [users, projectTemplates] = await Promise.all([
    prisma.user.findMany({
      orderBy: { name: "asc" },
      select: { openId: true, name: true, avatar: true },
    }),
    prisma.projectTemplate.findMany({
      where: { enabled: true },
      include: {
        stages: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      },
      orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }],
    }),
  ]);

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressPageLayout className="max-w-4xl">
          <ProgressBackLink />
          <PageTitle
            subtitle={sourceProject ? "修改后重新提交立项" : "提交立项"}
          />
          <ProjectForm
            users={users}
            initialDraft={initialDraft ?? undefined}
            sourceProjectId={sourceProject?.id}
            submitLabel={sourceProject ? "重新提交立项" : undefined}
            projectTemplates={projectTemplates.map((template) => ({
              id: template.id,
              name: template.name,
              description: template.description,
              isDefault: template.isDefault,
              stages: template.stages.map((stage) => ({
                name: stage.name,
                goal: stage.goal,
                durationDays: stage.dueOffsetDays,
              })),
            }))}
          />
        </ProgressPageLayout>
      </PageShell>
    </>
  );
}

function projectToInitialDraft(project: SourceProject): ParsedCreateProjectInput {
  return createProjectSchema.parse({
    name: project.name,
    description: project.description,
    team: project.team,
    techGroup: project.techGroup,
    ownerOpenId: project.ownerOpenId,
    ownerOpenIds: project.owners.map((owner) => owner.openId),
    participantOpenIds: project.participants.map((participant) => participant.openId),
    allowOwnerSelfApproval: project.allowOwnerSelfApproval,
    template: "custom",
    stages: project.stages.map((stage, index) => ({
      name: stage.name,
      goal: stage.goal,
      ownerOpenId: stage.ownerOpenId,
      durationDays: getStageDurationDays(
        project.submittedAt ?? project.createdAt,
        index > 0 ? project.stages[index - 1]?.dueAt : null,
        stage.dueAt,
      ),
    })),
  });
}

function getStageDurationDays(
  submittedAt: Date,
  previousDueAt: Date | null | undefined,
  dueAt: Date | null,
) {
  if (!dueAt) return 1;
  const base = previousDueAt ?? submittedAt;
  return Math.max(1, localDayNumber(dueAt) - localDayNumber(base));
}

function localDayNumber(date: Date): number {
  return Math.floor(
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() /
      86_400_000,
  );
}
