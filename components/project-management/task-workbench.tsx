import Link from "next/link";
import { CalendarCheck, GitBranch, ShieldCheck, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  formatDateTime,
  taskMemberRoleLabels,
  taskNodeStatusLabels,
  taskNodeTypeLabels,
  taskPriorityLabels,
  taskStatusLabels,
  workSegmentStatusLabels,
  workSegmentTypeLabels,
} from "@/lib/project-management/labels";
import type { WorkSegmentDetail } from "@/lib/project-management/queries/resource-queries";
import type { TaskWorkspace } from "@/lib/project-management/queries/task-queries";
import { routes } from "@/lib/routes";

type TaskWorkbenchProps = {
  workspace: TaskWorkspace;
  segments: WorkSegmentDetail[];
};

export function TaskWorkbench({ workspace, segments }: TaskWorkbenchProps) {
  const { task, currentPlan } = workspace;
  return (
    <div className="space-y-5">
      <section className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{taskStatusLabels[task.status]}</Badge>
            <Badge variant="secondary">{taskPriorityLabels[task.priority]}</Badge>
            <Badge variant="outline">计划 v{currentPlan.versionNo}</Badge>
          </div>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            {task.description || "暂无描述"}
          </p>
          <div className="mt-4 grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
            <p>组织范围：{task.team || "未设置"} / {task.techGroup || "未设置"}</p>
            <p>锁版本：{task.lockVersion}</p>
            <p>创建：{formatDateTime(task.createdAt)}</p>
            <p>更新：{formatDateTime(task.updatedAt)}</p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {workspace.tags.length === 0 ? (
              <Badge variant="outline">无 Tag</Badge>
            ) : (
              workspace.tags.map((tag) => (
                <Badge key={tag.id} variant="outline">
                  {tag.name}
                </Badge>
              ))
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="flex items-center gap-2 font-medium">
            <Users className="h-4 w-4" aria-hidden="true" />
            成员与权限
          </h2>
          <div className="mt-3 space-y-2">
            {workspace.members.map((member) => (
              <div
                key={`${member.personId}-${member.role}`}
                className="flex items-center justify-between gap-3 rounded-lg bg-background px-3 py-2 text-sm"
              >
                <span className="truncate">{member.displayName}</span>
                <Badge variant="secondary">
                  {taskMemberRoleLabels[member.role]}
                </Badge>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-2 text-sm text-muted-foreground">
            <PermissionLine
              enabled={workspace.permissions.canCreateRevision}
              label="可创建 Revision"
            />
            <PermissionLine
              enabled={workspace.permissions.canReviewMilestone}
              label="可处理验收"
            />
            <PermissionLine
              enabled={workspace.permissions.canTerminate}
              label="可确认结束"
            />
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="flex items-center gap-2 font-medium">
            <GitBranch className="h-4 w-4" aria-hidden="true" />
            当前计划
          </h2>
          <span className="text-sm text-muted-foreground">
            {currentPlan.status} · {currentPlan.nodes.length} 个节点
          </span>
        </div>
        <ol className="mt-4 space-y-3">
          {currentPlan.nodes.map((entry) => (
            <li
              key={entry.planVersionNodeId}
              className="grid gap-3 rounded-lg border border-border bg-background p-3 sm:grid-cols-[64px_1fr]"
            >
              <div className="text-sm font-medium text-muted-foreground">
                #{entry.sequence}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={entry.status === "ACTIVE" ? "default" : "outline"}>
                    {taskNodeStatusLabels[entry.status]}
                  </Badge>
                  <Badge variant="secondary">
                    {taskNodeTypeLabels[entry.type]}
                  </Badge>
                  {entry.isCarryForward && <Badge variant="outline">延续节点</Badge>}
                </div>
                <h3 className="mt-2 font-medium">
                  {entry.milestone?.goal ??
                    entry.revision?.reason ??
                    entry.termination?.plannedOutcomeCriteria}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {entry.businessDescription || "暂无业务描述"}
                </p>
                {entry.milestone && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    截止：{formatDateTime(entry.milestone.expectedCompletedAt)} ·
                    验收要求：{entry.milestone.reviewRequirements}
                  </p>
                )}
                {entry.termination && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    计划结束：{formatDateTime(entry.termination.plannedAt)}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="flex items-center gap-2 font-medium">
            <CalendarCheck className="h-4 w-4" aria-hidden="true" />
            人员投入
          </h2>
          <Link
            href={`${routes.progress.resources}?taskId=${task.id}`}
            className="text-sm text-primary hover:underline"
          >
            打开资源时间轴
          </Link>
        </div>
        {segments.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            当前 Task 没有关联人员投入记录。
          </div>
        ) : (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {segments.map((segment) => (
              <div
                key={segment.id}
                className="rounded-lg border border-border bg-background p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate font-medium">{segment.content}</h3>
                  <Badge variant={segment.type === "ACTUAL" ? "default" : "outline"}>
                    {workSegmentTypeLabels[segment.type]}
                  </Badge>
                  <Badge variant="secondary">
                    {workSegmentStatusLabels[segment.status]}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {segment.personName} · {formatDateTime(segment.startAt)} -{" "}
                  {formatDateTime(segment.endAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PermissionLine({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <p className="flex items-center gap-2">
      <ShieldCheck
        className={enabled ? "h-4 w-4 text-emerald-600" : "h-4 w-4 text-muted-foreground"}
        aria-hidden="true"
      />
      {label}：{enabled ? "是" : "否"}
    </p>
  );
}
