import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil } from "lucide-react";
import { ProjectActionsClient } from "@/components/project-management/project-actions-client";
import { ProjectAvatar } from "@/components/project-management/project-avatar";
import { ProjectTaskTimeline } from "@/components/project-management/project-task-timeline";
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
import { getProjectDetail } from "@/lib/project-management/queries/project-queries";
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
  const projectPromise = getProjectDetail({
    actor,
    projectId: id,
    pagination: {
      taskCursor: first(query.taskCursor) || undefined,
      pageSize: 25,
    },
  });
  const [
    project,
    capabilities,
    directActiveRisks,
    directResolvedRisks,
    taskActiveRisks,
    taskResolvedRisks,
    comments,
    activity,
    activityVersion,
  ] = await Promise.all([
      projectPromise,
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
              nextPageHref={
                project.taskNextCursor
                  ? detailPageHref(project.id, project.taskNextCursor)
                  : null
              }
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

function detailPageHref(projectId: string, taskCursor: string) {
  const search = new URLSearchParams({ taskCursor });
  return `${routes.progress.projectDetail(projectId)}?${search.toString()}`;
}
