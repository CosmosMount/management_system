import { notFound, redirect } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TaskComposerClient } from "@/components/project-management/task-composer-client";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { getRevisionComposerRecord } from "@/lib/project-management/queries/task-lifecycle-queries";
import {
  getPlanVersion,
  getTaskWorkspace,
} from "@/lib/project-management/queries/task-queries";
import { buildResubmitRevisionComposerSeed } from "@/lib/project-management/revision-composer";
import { routes } from "@/lib/routes";
import { getProgressActorOrRedirect } from "../../../../../_auth";

export default async function ProgressTaskRevisionEditPage({
  params,
}: {
  params: Promise<{ id: string; revisionId: string }>;
}) {
  const actor = await getProgressActorOrRedirect();
  const { id, revisionId } = await params;
  const [workspace, revision] = await Promise.all([
    getTaskWorkspace({ actor, taskId: id }),
    getRevisionComposerRecord({ actor, taskId: id, revisionNodeId: revisionId }),
  ]).catch((error) => {
    if (toProjectManagementServiceError(error).code === "NOT_FOUND") notFound();
    throw error;
  });
  if (!revision.canEdit) {
    if (revision.status !== "REJECTED") {
      redirect(routes.progress.taskRevisions(id));
    }
    notFound();
  }
  if (
    workspace.task.status !== "ACTIVE" ||
    revision.basePlanVersionId !== workspace.currentPlan.id ||
    revision.baseTaskLockVersion !== workspace.task.lockVersion
  ) {
    redirect(routes.progress.taskRevisions(id));
  }
  if (!revision.targetPlanVersionId || revision.targetVersionNo === null) {
    redirect(routes.progress.taskRevisions(id));
  }
  const targetPlan = await getPlanVersion({
    actor,
    planVersionId: revision.targetPlanVersionId,
  });
  if (targetPlan.status !== "DRAFT") {
    redirect(routes.progress.taskRevisions(id));
  }
  const seed = buildResubmitRevisionComposerSeed({
    workspace,
    targetPlan,
    revision,
  });
  if (!seed) redirect(routes.progress.taskRevisions(id));
  const deploymentEnvironment =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.NODE_ENV || "unknown";

  return (
    <>
      <PageCommandBar
        title="修改 Revision"
        description="修改被驳回的候选计划并直接重新送审；已承接节点保持只读。"
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
          kind: "RESUBMIT_REVISION",
          taskId: id,
          revisionNodeId: revision.id,
          basePlanVersionId: revision.basePlanVersionId,
          baseVersionNo: workspace.currentPlan.versionNo,
          baseTaskLockVersion: revision.baseTaskLockVersion,
          targetVersionNo: revision.targetVersionNo,
          expectedTargetPlanUpdatedAt: targetPlan.updatedAt,
        }}
      />
    </>
  );
}
