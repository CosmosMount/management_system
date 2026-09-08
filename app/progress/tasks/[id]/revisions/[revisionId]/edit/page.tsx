import { notFound, redirect } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TaskComposerClient } from "@/components/project-management/task-composer-client";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { getRevisionComposerRecord } from "@/lib/project-management/queries/task-lifecycle-queries";
import {
  resolvePeopleOptionsByIds,
  resolveTaskOptionsByIds,
} from "@/lib/project-management/queries/option-queries";
import {
  getPlanVersion,
  getTaskWorkspace,
} from "@/lib/project-management/queries/task-queries";
import { buildResubmitRevisionComposerSeed } from "@/lib/project-management/revision-composer";
import { routes } from "@/lib/routes";
import { getProgressActorOrRedirect } from "../../../../../_auth";
import { listGlobalTimeMarkers } from "@/lib/project-management/global-time-markers";

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
  const [people, relatedTasks, globalMarkers] = await Promise.all([
    resolveRevisionPeople(actor, workspace.members.map((member) => member.personId)),
    resolveTaskOptionsByIds({
      actor,
      input: {
        ids: workspace.task.relatedTaskId ? [workspace.task.relatedTaskId] : [],
      },
    }),
    listGlobalTimeMarkers(),
  ]);
  const deploymentEnvironment =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.NODE_ENV || "unknown";

  return (
    <>
      <PageCommandBar
        title="修改计划修订"
        description="核对任务资料，修改被驳回的候选计划，检查后重新送审；已承接节点保持只读。"
      />
      <TaskComposerClient
        accountId={actor.accountId}
        deploymentEnvironment={deploymentEnvironment}
        initialSeed={seed}
        initialPeople={people}
        initialTasks={relatedTasks}
        initialProjects={workspace.task.project ? [workspace.task.project] : []}
        initialGlobalMarkers={globalMarkers}
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

async function resolveRevisionPeople(
  actor: Awaited<ReturnType<typeof getProgressActorOrRedirect>>,
  personIds: string[],
) {
  const ids = [...new Set(personIds)];
  const people = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    people.push(
      ...(await resolvePeopleOptionsByIds({
        actor,
        input: {
          scope: { purpose: "VISIBLE" },
          ids: ids.slice(offset, offset + 50),
        },
      })),
    );
  }
  return people;
}
