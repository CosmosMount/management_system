import { notFound } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TaskWorkbench } from "@/components/project-management/task-workbench";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import {
  listTagOptions,
  resolvePeopleOptionsByIds,
  resolveTaskOptionsByIds,
  searchPeople,
  searchTaskOptions,
} from "@/lib/project-management/queries/option-queries";
import { getTaskLifecycleViews } from "@/lib/project-management/queries/task-lifecycle-queries";
import {
  getTaskWorkspace,
  listTaskPlanVersions,
} from "@/lib/project-management/queries/task-queries";
import { getTimeCanvasData } from "@/lib/project-management/queries/time-canvas-queries";
import { getProgressActorOrRedirect } from "../../_auth";

export default async function ProgressTaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const initialTab = normalizeTaskTab((await searchParams).tab);
  const workspace = await getTaskWorkspace({ actor, taskId: id }).catch((error) => {
    const mapped = toProjectManagementServiceError(error);
    if (mapped.code === "NOT_FOUND") notFound();
    throw error;
  });
  const range = taskCanvasRange(workspace);
  const [
    lifecycle,
    planVersions,
    peoplePage,
    currentPeople,
    taskPage,
    currentTaskOptions,
    tagPage,
    canvasResult,
  ] =
    await Promise.all([
      getTaskLifecycleViews({ actor, taskId: id, reviewLimit: 50, auditLimit: 50 }),
      listTaskPlanVersions({ actor, taskId: id }),
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
      resolveTaskOptionsByIds({ actor, input: { ids: [id] } }),
      listTagOptions({ actor, input: { limit: 50 } }),
      getTimeCanvasData({
        actor,
        input: {
          scope: { kind: "TASK_SCOPED", taskId: id },
          rangeStart: range.startAt,
          rangeEnd: range.endAt,
          personIds: [],
          taskIds: [id],
          tagIds: [],
          types: [],
          statuses: [],
          groupBy: "PERSON",
          includeTaskAnchors: true,
          includeActual: true,
          includeBusyBlocks: true,
          rowLimit: 50,
        },
      })
        .then((data) => ({ ok: true as const, data }))
        .catch((error: unknown) => ({
          ok: false as const,
          message: toProjectManagementServiceError(error).message,
        })),
    ]);
  const canvasModel = canvasResult.ok
    ? timeCanvasDataToModel(canvasResult.data, "TASK_WORKBENCH")
    : null;

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
          planVersions={planVersions}
          canvasModel={canvasModel}
          canvasError={canvasResult.ok ? null : canvasResult.message}
          people={mergeOptions(currentPeople, peoplePage.items)}
          taskOptions={mergeOptions(currentTaskOptions, taskPage.items)}
          tagOptions={tagPage.items}
          initialTab={initialTab}
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

function normalizeTaskTab(value: string | string[] | undefined) {
  const tab = Array.isArray(value) ? value[0] : value;
  if (tab === "review" || tab === "reviews" || tab === "termination") {
    return "reviews" as const;
  }
  if (tab === "revision" || tab === "revisions") return "revisions" as const;
  if (tab === "overview" || tab === "audit") return tab;
  return "plan" as const;
}

function taskCanvasRange(
  workspace: Awaited<ReturnType<typeof getTaskWorkspace>>,
) {
  const planStart = workspace.currentPlan.plannedStartAt
    ? new Date(workspace.currentPlan.plannedStartAt).getTime()
    : Date.now();
  const milestoneTimes = workspace.currentPlan.nodes.flatMap((entry) =>
    entry.milestone ? [new Date(entry.milestone.expectedCompletedAt).getTime()] : [],
  );
  const terminationTime = workspace.currentPlan.nodes.find(
    (entry) => entry.termination,
  )?.termination?.plannedAt;
  const planEnd = terminationTime
    ? new Date(terminationTime).getTime()
    : milestoneTimes.at(-1) ?? planStart + 14 * 86_400_000;
  const activeIndex = workspace.currentPlan.nodes.findIndex(
    (entry) => entry.nodeId === workspace.task.activeMilestoneNodeId,
  );
  const activeAt = activeIndex >= 0
    ? workspace.currentPlan.nodes[activeIndex]?.milestone?.expectedCompletedAt
    : null;
  const center = activeAt ? new Date(activeAt).getTime() : planStart;
  const paddedStart = planStart - 3 * 86_400_000;
  const paddedEnd = planEnd + 7 * 86_400_000;
  const maxRange = 90 * 86_400_000;
  const startAt = paddedEnd - paddedStart <= maxRange
    ? paddedStart
    : center - 21 * 86_400_000;
  const endAt = paddedEnd - paddedStart <= maxRange
    ? paddedEnd
    : center + 45 * 86_400_000;
  return {
    startAt: new Date(startAt).toISOString(),
    endAt: new Date(Math.max(endAt, startAt + 86_400_000)).toISOString(),
  };
}
