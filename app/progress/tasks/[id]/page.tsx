import { notFound } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TaskWorkbench } from "@/components/project-management/task-workbench";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import {
  listTagOptions,
  resolvePeopleOptionsByIds,
  resolveTaskOptionsByIds,
  searchPeople,
  searchTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import { getTaskLifecycleViews } from "@/lib/project-management/queries/task-lifecycle-queries";
import { getTaskWorkspace } from "@/lib/project-management/queries/task-queries";
import { listActiveProjectOptions } from "@/lib/project-management/queries/project-queries";
import { getProgressActorOrRedirect } from "../../_auth";

export default async function ProgressTaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const workspace = await getTaskWorkspace({ actor, taskId: id }).catch((error) => {
    const mapped = toProjectManagementServiceError(error);
    if (mapped.code === "NOT_FOUND") notFound();
    throw error;
  });
  const [
    lifecycle,
    peoplePage,
    currentPeople,
    taskPage,
    currentRelatedTaskOptions,
    tagPage,
    projectOptions,
  ] =
    await Promise.all([
      getTaskLifecycleViews({
        actor,
        taskId: id,
        reviewLimit: 2,
        revisionLimit: 2,
        auditLimit: 1,
        currentOnly: true,
      }),
      workspace.permissions.canManageMembers
        ? searchPeople({
            actor,
            input: { purpose: "TASK_MEMBERS", taskId: id, limit: 50 },
          })
        : Promise.resolve({
            items: [],
            nextCursor: null,
            hasMoreByQuery: false,
          }),
      resolveWorkspacePeople(actor, workspace.members.map((member) => member.personId)),
      searchTaskOptions({ actor, input: { limit: 50 } }),
      resolveTaskOptionsByIds({
        actor,
        input: { ids: workspace.task.relatedTaskId ? [workspace.task.relatedTaskId] : [] },
      }),
      listTagOptions({ actor, input: { limit: 50 } }),
      listActiveProjectOptions(workspace.task.projectId),
    ]);

  return (
    <>
      <PageCommandBar
        title={workspace.task.title}
        description="Task 执行工作台：统一计划、人员投入、Revision、验收与审计。"
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <TaskWorkbench
          workspace={workspace}
          lifecycle={lifecycle}
          people={mergeOptions(currentPeople, peoplePage.items)}
          taskOptions={mergeOptions(currentRelatedTaskOptions, taskPage.items)}
          tagOptions={tagPage.items}
          projectOptions={projectOptions}
        />
      </div>
    </>
  );
}

async function resolveWorkspacePeople(
  actor: Awaited<ReturnType<typeof getProgressActorOrRedirect>>,
  memberIds: string[],
) {
  const ids = [...new Set(memberIds)];
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

function mergeOptions<T extends { id: string }>(...groups: T[][]) {
  const merged = new Map<string, T>();
  for (const group of groups) {
    for (const option of group) {
      if (!merged.has(option.id)) merged.set(option.id, option);
    }
  }
  return [...merged.values()];
}
