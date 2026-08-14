import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Pencil } from "lucide-react";
import { ProjectActionsClient } from "@/components/project-management/project-actions-client";
import { ProjectAvatar } from "@/components/project-management/project-avatar";
import { ProjectTaskTimeline } from "@/components/project-management/project-task-timeline";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import type { TimeCanvasZoom } from "@/components/project-management/time-canvas/types";
import {
  CollaborationLeftSidebar,
  CollaborationRightSidebar,
  CreateRiskCard,
  type CollaborationInitialData,
} from "@/components/project-management/collaboration-panels";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import {
  getProjectDetail,
  locateProjectTimelineFocus,
} from "@/lib/project-management/queries/project-queries";
import { resolvePeopleOptionsByIds } from "@/lib/project-management/queries/option-queries";
import {
  getContentDrivenTimeCanvasData,
  resolveProjectTimelinePersonIds,
} from "@/lib/project-management/queries/time-canvas-queries";
import {
  getActivityVersion,
  getCollaborationCapabilities,
  getCommentPage,
  getRecentActivityPage,
  getRiskPage,
} from "@/lib/project-management/queries/collaboration-queries";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { getProgressActorOrRedirect } from "../../_auth";

const statusLabels = {
  DRAFT: "草稿",
  PENDING_APPROVAL: "立项审批中",
  ACTIVE: "进行中",
  COMPLETED: "已结束",
} as const;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const query = (await searchParams) ?? {};
  const canonicalQuery = withoutRetiredTimelineParams(query);
  if (canonicalSearch(searchParamsFromRecord(query)) !== canonicalSearch(canonicalQuery)) {
    redirect(`${routes.progress.projectDetail(id)}?${canonicalQuery.toString()}`);
  }
  const requestedFocus = first(query.focus);
  const focusLocator = requestedFocus
    ? await locateProjectTimelineFocus({ actor, projectId: id, focus: requestedFocus })
        .catch((error: unknown) => {
          if (toProjectManagementServiceError(error).code === "NOT_FOUND") notFound();
          throw error;
        })
    : null;
  if (requestedFocus && !focusLocator) {
    const normalized = searchParamsFromRecord(query);
    normalized.delete("focus");
    normalized.set("focusError", "1");
    redirect(`${routes.progress.projectDetail(id)}?${normalized.toString()}`);
  }
  if (focusLocator) {
    const normalized = searchParamsFromRecord(query);
    normalized.set("focus", focusLocator.focusId);
    normalized.set("center", new Date(focusLocator.centerMs).toISOString());
    normalized.delete("focusError");
    if (canonicalSearch(searchParamsFromRecord(query)) !== canonicalSearch(normalized)) {
      redirect(`${routes.progress.projectDetail(id)}?${normalized.toString()}`);
    }
  }
  const project = await getProjectDetail({
    actor,
    projectId: id,
  }).catch((error) => {
    if (toProjectManagementServiceError(error).code === "NOT_FOUND") notFound();
    throw error;
  });
  const [
    capabilities,
    directActiveRisks,
    directResolvedRisks,
    taskActiveRisks,
    taskResolvedRisks,
    comments,
    activity,
    activityVersion,
  ] = await Promise.all([
      getCollaborationCapabilities(actor, { targetType: "PROJECT", targetId: id }),
      getRiskPage(actor, { targetType: "PROJECT", targetId: id, source: "DIRECT", status: "ACTIVE", limit: 20 }),
      getRiskPage(actor, { targetType: "PROJECT", targetId: id, source: "DIRECT", status: "RESOLVED", limit: 20 }),
      getRiskPage(actor, { targetType: "PROJECT", targetId: id, source: "TASKS", status: "ACTIVE", limit: 20 }),
      getRiskPage(actor, { targetType: "PROJECT", targetId: id, source: "TASKS", status: "RESOLVED", limit: 20 }),
      getCommentPage(actor, { targetType: "PROJECT", targetId: id, limit: 20 }),
      getRecentActivityPage(actor, { targetType: "PROJECT", targetId: id, category: "ALL", limit: 20 }),
      getActivityVersion(actor, { targetType: "PROJECT", targetId: id }),
    ]).catch((error) => {
      if (toProjectManagementServiceError(error).code === "NOT_FOUND") notFound();
      throw error;
    });
  const collaboration: CollaborationInitialData = {
    targetType: "PROJECT",
    targetId: id,
    capabilities,
    directActiveRisks,
    directResolvedRisks,
    taskActiveRisks,
    taskResolvedRisks,
    comments,
    activity,
    activityVersion: activityVersion.token,
  };
  const defaultTimelineCenter = projectDefaultTimelineCenter(project.tasks);
  const timelineCenter = focusLocator?.centerMs ?? parseCenter(first(query.center))
    ?? defaultTimelineCenter;
  const timelineScale = parseScale(first(query.scale));
  const timelinePersonIds = await resolveProjectTimelinePersonIds({
    actor,
    personIds: [
      ...project.members.map((member) => member.personId),
      ...project.tasks.flatMap((task) => task.members.map((member) => member.personId)),
    ],
  });
  const [timelinePeople, resourceCanvasResult] = await Promise.all([
        resolvePeopleOptionsByIds({
          actor,
          input: { scope: { purpose: "VISIBLE" }, ids: timelinePersonIds },
        }),
        getContentDrivenTimeCanvasData({
          actor,
          preferredCenterMs: timelineCenter,
          load: { mode: "INITIAL" },
          anchorTaskIds: project.tasks.map((task) => task.id),
          input: {
            scope: { kind: "RESOURCE_PLANNER" },
            personIds: timelinePersonIds,
            taskIds: [],
            types: [],
            statuses: [],
            groupBy: "PERSON",
            includeTaskAnchors: true,
            includeActual: true,
            includeBusyBlocks: false,
          },
        }).then((data) => ({ ok: true as const, data })).catch((error: unknown) => ({
          ok: false as const,
          message: toProjectManagementServiceError(error).message,
        })),
      ]);
  const owners = project.members.filter((member) => member.role === "OWNER");
  const participants = project.members.filter(
    (member) => member.role === "PARTICIPANT",
  );

  return (
    <>
      <PageCommandBar
        title="Project 详情"
        description="查看 Project 基本信息、所属 Task 与计划时间线。"
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <section
          id="establishment"
          className="min-w-0 rounded-xl border border-border bg-card p-5"
          data-testid="project-overview"
        >
          <div className="flex min-w-0 flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={routes.progress.projects}
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />全部 Project
                </Link>
                <Badge variant="secondary">{statusLabels[project.status]}</Badge>
              </div>
              <div className="mt-4 flex min-w-0 items-start gap-4">
                <ProjectAvatar
                  name={project.name}
                  avatarPath={project.avatarPath}
                  className="size-16 shrink-0"
                />
                <div className="min-w-0">
                  <h1 className="break-words text-2xl font-semibold">
                    {project.name}
                  </h1>
                  <p className="mt-2 whitespace-pre-wrap break-words leading-7">
                    {project.description}
                  </p>
                </div>
              </div>
              <dl className="mt-5 grid min-w-0 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <OverviewItem
                  label="负责人"
                  value={memberNames(owners)}
                />
                <OverviewItem
                  label="参与人员"
                  value={memberNames(participants)}
                />
                <OverviewItem
                  label="Task 完成进度"
                  value={`${project.completedTaskTotalCount}/${project.taskTotalCount} 已完成`}
                />
              </dl>
            </div>

            <div className="min-w-0 shrink-0 lg:max-w-[38rem]">
              <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                {(project.permissions.canEdit || project.permissions.canResubmit) && (
                  <Link
                    href={routes.progress.projectEdit(project.id)}
                    className={cn(buttonVariants({ variant: "outline" }))}
                  >
                    <Pencil />
                    {project.status === "DRAFT" ? "修改并重新提交" : "编辑"}
                  </Link>
                )}
                <ProjectActionsClient
                  projectId={project.id}
                  lockVersion={project.lockVersion}
                  requestId={project.pendingRequestId}
                  canReview={project.permissions.canReview}
                  canComplete={project.permissions.canComplete}
                  canDelete={project.permissions.canDelete}
                  hasNoTasks={project.taskTotalCount === 0}
                  blockingTaskCount={project.taskTotalCount - project.completedTaskTotalCount}
                  blockingTasks={project.blockingTasks.map((task) => ({
                    id: task.id,
                    title: task.title,
                    statusLabel: taskLabels[task.status],
                  }))}
                />
              </div>
            </div>
          </div>
        </section>

        <div className="grid min-w-0 gap-5 xl:grid-cols-[300px_minmax(0,1fr)_300px]">
          <aside className="min-w-0 space-y-4 xl:col-start-1 xl:row-start-1">
            <CollaborationLeftSidebar data={collaboration} />
          </aside>

          <main className="min-w-0 space-y-4 xl:col-start-2 xl:row-start-1">
            <ProjectTaskTimeline
              projectId={project.id}
              projectStatus={project.status}
              tasks={project.tasks}
              timelineError={project.timelineError}
              taskTotalCount={project.taskTotalCount}
              completedTaskTotalCount={project.completedTaskTotalCount}
              resourceModel={
                resourceCanvasResult?.ok
                  ? {
                      ...timeCanvasDataToModel(resourceCanvasResult.data.data, "RESOURCE_PLANNER"),
                      contentRange: resourceCanvasResult.data.contentRange,
                      fullRange: resourceCanvasResult.data.fullRange,
                      rangeClipped: resourceCanvasResult.data.rangeClipped,
                      loadedRanges: [resourceCanvasResult.data.loadedRange],
                      loadedLeafBlockCounts: [resourceCanvasResult.data.leafBlockCount],
                      failedRanges: resourceCanvasResult.data.failedRanges,
                    }
                  : null
              }
              resourceTimelineError={
                (!resourceCanvasResult.ok
                  ? resourceCanvasResult.message
                  : null)
              }
              peopleOptions={timelinePeople}
              timelineWindow={{
                focusId: focusLocator?.focusId ?? null,
                centerMs: resourceCanvasResult?.ok
                  ? resourceCanvasResult.data.resolvedCenterMs
                  : timelineCenter,
                scale: timelineScale,
              }}
              timelineFocusError={first(query.focusError) === "1"
                ? "无法定位该时间对象，请确认链接仍然有效且你有权查看。"
                : null}
            />
            <CreateRiskCard
              targetType="PROJECT"
              targetId={project.id}
              canCreate={collaboration.capabilities.canCreateRisk}
            />
          </main>

          <aside className="min-w-0 xl:col-start-3 xl:row-start-1">
            <CollaborationRightSidebar data={collaboration} />
          </aside>
        </div>
      </div>
    </>
  );
}

const taskLabels = {
  DRAFT: "草稿",
  ACTIVE: "进行中",
  COMPLETED: "已完成",
  FAILED: "失败结束",
  CANCELLED: "已取消",
  TIMEOUT: "已超时",
  ARCHIVED: "已归档",
} as const;

function memberNames(
  members: Array<{ displayName: string; status: string }>,
) {
  return (
    members
      .map((member) => `${member.displayName}${member.status === "INACTIVE" ? "（已停用）" : ""}`)
      .join("、") || "未配置"
  );
}

function OverviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words">{value}</dd>
    </div>
  );
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function searchParamsFromRecord(params: SearchParams) {
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

function projectDefaultTimelineCenter(
  tasks: Awaited<ReturnType<typeof getProjectDetail>>["tasks"],
) {
  const activeAt = tasks.flatMap((task) =>
    task.currentPlan.nodes.flatMap((node) =>
      node.status === "ACTIVE" && !node.revision
        ? [node.milestone?.expectedCompletedAt ?? node.termination?.plannedAt]
        : [],
    ),
  ).find(Boolean);
  const center = Date.parse(activeAt ?? new Date().toISOString());
  return center;
}

function parseCenter(value: string) {
  const parsed = Date.parse(value);
  return value && Number.isFinite(parsed) ? parsed : null;
}

function parseScale(value: string): TimeCanvasZoom | undefined {
  const normalized = value.toUpperCase();
  return normalized === "WEEK" || normalized === "MONTH" || normalized === "QUARTER" || normalized === "YEAR"
    ? normalized
    : undefined;
}

function withoutRetiredTimelineParams(params: SearchParams) {
  const search = searchParamsFromRecord(params);
  for (const key of [
    "timelineDate",
    "timelineFocus",
    "start",
    "end",
    "zoom",
    "personId",
    "taskId",
    "taskCursor",
  ]) {
    search.delete(key);
  }
  return search;
}
