import { notFound, redirect } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TaskComposerClient } from "@/components/project-management/task-composer-client";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { getOpenRevisionCandidate } from "@/lib/project-management/queries/task-lifecycle-queries";
import { getTaskWorkspace } from "@/lib/project-management/queries/task-queries";
import { buildCreateRevisionComposerSeed } from "@/lib/project-management/revision-composer";
import { routes } from "@/lib/routes";
import { getProgressActorOrRedirect } from "../../../../_auth";

export default async function ProgressTaskRevisionNewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const workspace = await getTaskWorkspace({ actor, taskId: id }).catch(
    (error) => {
      if (toProjectManagementServiceError(error).code === "NOT_FOUND") notFound();
      throw error;
    },
  );
  if (!workspace.permissions.canCreateRevision) notFound();
  if (workspace.task.status !== "ACTIVE") {
    redirect(routes.progress.taskDetail(id));
  }
  if (workspace.pendingApprovalConflict) {
    redirect(routes.progress.taskReviews(id));
  }
  if (workspace.pendingApproval) {
    redirect(
      workspace.pendingApproval.kind === "REVISION"
        ? routes.progress.taskRevisions(id)
        : routes.progress.taskReviews(id),
    );
  }
  const activeCandidate = await getOpenRevisionCandidate({ actor, taskId: id });
  if (activeCandidate) redirect(routes.progress.taskRevisions(id));
  const seed = buildCreateRevisionComposerSeed(workspace);
  if (!seed) redirect(routes.progress.taskRevisions(id));
  const deploymentEnvironment =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.NODE_ENV || "unknown";

  return (
    <>
      <PageCommandBar
        title="发起 Revision"
        description="在通用 Composer 中调整 Revision 时间、后续 Milestone 与 Terminal；创建后直接进入待审批。"
      />
      <TaskComposerClient
        accountId={actor.accountId}
        deploymentEnvironment={deploymentEnvironment}
        initialSeed={seed}
        initialPeople={[]}
        initialTasks={[]}
        initialTags={[]}
        actorPersonId={actor.personId}
        mode={{
          kind: "CREATE_REVISION",
          taskId: id,
          basePlanVersionId: workspace.currentPlan.id,
          baseVersionNo: workspace.currentPlan.versionNo,
          baseTaskLockVersion: workspace.task.lockVersion,
        }}
      />
    </>
  );
}
