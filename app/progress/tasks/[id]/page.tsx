import { notFound } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TaskWorkbench } from "@/components/project-management/task-workbench";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import { formatShanghaiDate } from "@/components/project-management/time-canvas/url-state";
import type { CollaborationInitialData } from "@/components/project-management/collaboration-panels";
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
import {
  getActivityVersion,
  getCollaborationCapabilities,
  getCommentPage,
  getRecentActivityPage,
  getRiskPage,
} from "@/lib/project-management/queries/collaboration-queries";
import { listActiveProjectOptions } from "@/lib/project-management/queries/project-queries";
import { getTimeCanvasData } from "@/lib/project-management/queries/time-canvas-queries";
import { getProgressActorOrRedirect } from "../../_auth";

export default async function ProgressTaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const workspace = await getTaskWorkspace({ actor, taskId: id }).catch((error) => {
    const mapped = toProjectManagementServiceError(error);
    if (mapped.code === "NOT_FOUND") notFound();
    throw error;
  });
  const query = (await searchParams) ?? {};
  const requestedTimelineDate = firstParam(query.timelineDate);
  const requestedTimelineFocus = firstParam(query.timelineFocus);
  const defaultTimelineDate = taskDefaultTimelineDate(workspace);
  const timelineDate = validDate(requestedTimelineDate)
    ? requestedTimelineDate
    : defaultTimelineDate;
  const timelineStartMs = Date.parse(`${timelineDate}T00:00:00.000+08:00`);
  const timelineEndMs = timelineStartMs + 31 * 24 * 60 * 60 * 1_000;
  const [
    lifecycle,
    peoplePage,
    currentPeople,
    taskPage,
    currentRelatedTaskOptions,
    tagPage,
    projectOptions,
    capabilities,
    directActiveRisks,
    directResolvedRisks,
    comments,
    activity,
    activityVersion,
    timeCanvasData,
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
      getCollaborationCapabilities(actor, { targetType: "TASK", targetId: id }),
      getRiskPage(actor, { targetType: "TASK", targetId: id, source: "DIRECT", status: "ACTIVE", limit: 20 }),
      getRiskPage(actor, { targetType: "TASK", targetId: id, source: "DIRECT", status: "RESOLVED", limit: 20 }),
      getCommentPage(actor, { targetType: "TASK", targetId: id, limit: 20 }),
      getRecentActivityPage(actor, { targetType: "TASK", targetId: id, category: "ALL", limit: 20 }),
      getActivityVersion(actor, { targetType: "TASK", targetId: id }),
      getTimeCanvasData({
        actor,
        input: {
          scope: { kind: "TASK_SCOPED", taskId: id },
          rangeStart: new Date(timelineStartMs).toISOString(),
          rangeEnd: new Date(timelineEndMs).toISOString(),
          personIds: [],
          taskIds: [],
          tagIds: [],
          types: [],
          statuses: [],
          groupBy: "PERSON",
          includeTaskAnchors: true,
          includeActual: true,
          includeBusyBlocks: false,
          rowLimit: 50,
        },
      }),
    ]);
  const collaboration: CollaborationInitialData = {
    targetType: "TASK",
    targetId: id,
    capabilities,
    directActiveRisks,
    directResolvedRisks,
    comments,
    activity,
    activityVersion: activityVersion.token,
  };

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
          collaboration={collaboration}
          timeCanvasModel={timeCanvasDataToModel(timeCanvasData, "TASK_WORKBENCH")}
          timelineWindow={{
            date: timelineDate,
            focusId: requestedTimelineFocus || null,
            previousHref: taskTimelineHref(id, shiftDate(timelineDate, -31)),
            nextHref: taskTimelineHref(id, shiftDate(timelineDate, 31)),
            defaultHref: taskTimelineHref(id, defaultTimelineDate),
          }}
        />
      </div>
    </>
  );
}

function taskDefaultTimelineDate(
  workspace: Awaited<ReturnType<typeof getTaskWorkspace>>,
) {
  const activeNode = workspace.currentPlan.nodes.find(
    (entry) => entry.status === "ACTIVE" && !entry.revision,
  );
  const activeAt = activeNode?.milestone?.expectedCompletedAt
    ?? activeNode?.termination?.plannedAt;
  const center = activeAt ? Date.parse(activeAt) : Date.now();
  return formatShanghaiDate(center - 15 * 24 * 60 * 60 * 1_000);
}

function taskTimelineHref(taskId: string, date: string) {
  return `/progress/tasks/${taskId}?timelineDate=${encodeURIComponent(date)}`;
}

function shiftDate(date: string, days: number) {
  return formatShanghaiDate(Date.parse(`${date}T00:00:00.000+08:00`) + days * 24 * 60 * 60 * 1_000);
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000+08:00`);
  return Number.isFinite(parsed) && formatShanghaiDate(parsed) === value;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
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
