import { notFound, redirect } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TaskWorkbench } from "@/components/project-management/task-workbench";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import { formatShanghaiDate } from "@/components/project-management/time-canvas/url-state";
import type { TimeCanvasZoom } from "@/components/project-management/time-canvas/types";
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
import { getContentDrivenTimeCanvasData } from "@/lib/project-management/queries/time-canvas-queries";
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
  const requestedTimelineFocus = firstParam(query.focus) || firstParam(query.timelineFocus);
  const focusedNode = requestedTimelineFocus === "task-detail-start"
    ? {
        id: requestedTimelineFocus,
        at: workspace.currentPlan.plannedStartAt ?? workspace.task.createdAt,
      }
    : workspace.currentPlan.nodes.flatMap((node) => {
        if (node.nodeId !== requestedTimelineFocus) return [];
        return [{
          id: node.nodeId,
          at: node.milestone?.expectedCompletedAt ??
            node.revision?.revisionAt ??
            node.termination?.plannedAt ??
            workspace.task.updatedAt,
        }];
      })[0] ?? null;
  if (requestedTimelineFocus && !focusedNode) {
    const normalized = searchParamsFromRecord(query);
    normalized.delete("focus");
    normalized.delete("timelineFocus");
    normalized.set("focusError", "1");
    redirect(`/progress/tasks/${id}?${normalized.toString()}`);
  }
  const defaultTimelineCenter = taskDefaultTimelineCenter(workspace);
  const legacyTimelineStart = parseShanghaiDate(firstParam(query.timelineDate));
  const requestedTimelineCenter = focusedNode
    ? Date.parse(focusedNode.at)
    : parseCenter(firstParam(query.center))
    ?? (legacyTimelineStart === null
      ? defaultTimelineCenter
      : legacyTimelineStart + 15.5 * 24 * 60 * 60 * 1_000);
  const requestedScale = parseScale(firstParam(query.scale));
  if (focusedNode || legacyTimelineStart !== null) {
    const normalized = searchParamsFromRecord(query);
    normalized.set("center", new Date(requestedTimelineCenter).toISOString());
    if (focusedNode) normalized.set("focus", focusedNode.id);
    normalized.delete("timelineFocus");
    normalized.delete("timelineDate");
    normalized.delete("focusError");
    if (canonicalSearch(searchParamsFromRecord(query)) !== canonicalSearch(normalized)) {
      redirect(`/progress/tasks/${id}?${normalized.toString()}`);
    }
  }
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
    timeCanvasResult,
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
      getContentDrivenTimeCanvasData({
        actor,
        preferredCenterMs: requestedTimelineCenter,
        load: { mode: "INITIAL" },
        input: {
          scope: { kind: "TASK_SCOPED", taskId: id },
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
        {firstParam(query.focusError) === "1" && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
            无法定位该时间对象，请确认链接仍然有效且你有权查看。
          </p>
        )}
        <TaskWorkbench
          workspace={workspace}
          lifecycle={lifecycle}
          people={mergeOptions(currentPeople, peoplePage.items)}
          taskOptions={mergeOptions(currentRelatedTaskOptions, taskPage.items)}
          tagOptions={tagPage.items}
          projectOptions={projectOptions}
          collaboration={collaboration}
          timeCanvasModel={{
            ...timeCanvasDataToModel(timeCanvasResult.data, "TASK_WORKBENCH"),
            contentRange: timeCanvasResult.contentRange,
            fullRange: timeCanvasResult.fullRange,
            rangeClipped: timeCanvasResult.rangeClipped,
            loadedRanges: [timeCanvasResult.loadedRange],
            loadedLeafBlockCounts: [timeCanvasResult.leafBlockCount],
            failedRanges: timeCanvasResult.failedRanges,
          }}
          timelineWindow={{
            focusId: focusedNode?.id ?? null,
            centerMs: timeCanvasResult.resolvedCenterMs,
            scale: requestedScale,
          }}
        />
      </div>
    </>
  );
}

function taskDefaultTimelineCenter(
  workspace: Awaited<ReturnType<typeof getTaskWorkspace>>,
) {
  const activeNode = workspace.currentPlan.nodes.find(
    (entry) => entry.status === "ACTIVE" && !entry.revision,
  );
  const activeAt = activeNode?.milestone?.expectedCompletedAt
    ?? activeNode?.termination?.plannedAt;
  const center = activeAt ? Date.parse(activeAt) : Date.now();
  return center;
}

function parseCenter(value: string) {
  const parsed = Date.parse(value);
  return value && Number.isFinite(parsed) ? parsed : null;
}

function parseShanghaiDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000+08:00`);
  return Number.isFinite(parsed) && formatShanghaiDate(parsed) === value ? parsed : null;
}

function parseScale(value: string): TimeCanvasZoom | undefined {
  const normalized = value.toUpperCase();
  return normalized === "WEEK" || normalized === "MONTH" || normalized === "QUARTER" || normalized === "YEAR"
    ? normalized
    : undefined;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function searchParamsFromRecord(params: Record<string, string | string[] | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((item) => search.append(key, item));
    else if (value !== undefined) search.set(key, value);
  }
  return search;
}

function canonicalSearch(params: URLSearchParams) {
  return [...params.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    )
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
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
