"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Clock3, FileText, PencilLine, XCircle } from "lucide-react";
import { reviewProjectEstablishment } from "@/app/actions/progress/createProject";
import { RejectedProjectEstablishmentDeleteButton } from "@/components/progress/rejected-project-establishment-delete-button";
import { RequestApprovalReminderButton } from "@/components/progress/request-approval-reminder-button";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { getActionErrorMessage } from "@/lib/action-error-message";
import { projectStatusLabels } from "@/lib/progress-labels";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

export type ProjectEstablishmentView = {
  id: string;
  status: "ESTABLISHING" | "ESTABLISHMENT_REJECTED";
  requesterName: string;
  projectName: string;
  team: string;
  techGroup: string;
  ownerNames: string;
  participantNames: string;
  stageCount: number;
  stages: Array<{
    name: string;
    goal: string;
    ownerNames: string;
    durationDays: number;
    duePreview: string;
  }>;
  submittedAt: string;
  reviewerName: string;
  reviewComment: string;
  reviewedAt: string | null;
  canResubmit: boolean;
  canReview: boolean;
  canDelete: boolean;
  canRequestApprovalReminder: boolean;
};

type Props = {
  projects: ProjectEstablishmentView[];
};

const establishmentActionButtonClassName = "h-8 min-w-24 gap-1.5 px-3 text-sm";

export function ProjectEstablishmentPanel({ projects }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<ProjectEstablishmentView | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  if (projects.length === 0) return null;

  async function handleReview(
    project: ProjectEstablishmentView,
    decision: "APPROVED" | "REJECTED",
  ) {
    const comment = comments[project.id]?.trim() ?? "";
    if (decision === "REJECTED" && !comment) {
      toast.error("驳回立项时请填写审核意见");
      return;
    }
    setLoadingId(`${project.id}:${decision}`);
    try {
      await reviewProjectEstablishment({
        projectId: project.id,
        decision,
        comment,
      });
      toast.success(decision === "APPROVED" ? "立项已通过" : "立项已驳回");
      setSelected(null);
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "审核立项失败"));
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <Card className="mb-10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          立项审批
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {projects.map((project) => (
            <li
              key={project.id}
              className={cn(
                "rounded-lg border p-4",
                project.status === "ESTABLISHING" && "border-amber-200 bg-amber-50/50",
                project.status === "ESTABLISHMENT_REJECTED" &&
                  "border-red-200 bg-red-50/40",
              )}
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{project.projectName}</p>
                    <Badge
                      variant={
                        project.status === "ESTABLISHING" ? "secondary" : "outline"
                      }
                    >
                      {projectStatusLabels[project.status]}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    申请人：{project.requesterName || "未知"} ·{" "}
                    {formatDateTime(project.submittedAt)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatScope(project.team, project.techGroup)} · 负责人{" "}
                    {project.ownerNames || "未设置"} · 阶段 {project.stageCount} 个
                  </p>
                  {project.reviewComment && (
                    <p className="text-sm text-muted-foreground">
                      审核意见：{project.reviewComment}
                    </p>
                  )}
                  <Link
                    href={routes.progress.project(project.id)}
                    className="text-sm text-primary hover:underline"
                  >
                    打开项目详情
                  </Link>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    className={establishmentActionButtonClassName}
                    onClick={() => setSelected(project)}
                  >
                    查看详情
                  </Button>
                  {project.canResubmit && (
                    <Link
                      href={`${routes.progress.new}?fromProject=${encodeURIComponent(
                        project.id,
                      )}`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "default",
                        className: establishmentActionButtonClassName,
                      })}
                    >
                      <PencilLine className="h-4 w-4" />
                      修改后重新提交
                    </Link>
                  )}
                  {project.status === "ESTABLISHMENT_REJECTED" && (
                    <RejectedProjectEstablishmentDeleteButton
                      projectId={project.id}
                      canDelete={project.canDelete}
                      className={establishmentActionButtonClassName}
                    />
                  )}
                  {project.canReview && project.status === "ESTABLISHING" && (
                    <>
                      <Button
                        type="button"
                        size="default"
                        className={establishmentActionButtonClassName}
                        onClick={() => handleReview(project, "APPROVED")}
                        disabled={loadingId !== null}
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        通过立项
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="default"
                        className={establishmentActionButtonClassName}
                        onClick={() => handleReview(project, "REJECTED")}
                        disabled={loadingId !== null}
                      >
                        <XCircle className="h-4 w-4" />
                        驳回立项
                      </Button>
                    </>
                  )}
                  {project.canRequestApprovalReminder &&
                    project.status === "ESTABLISHING" && (
                      <RequestApprovalReminderButton
                        reference={{ kind: "PROJECT_ESTABLISHMENT", id: project.id }}
                        className={establishmentActionButtonClassName}
                        subject={project.projectName}
                      />
                    )}
                </div>
              </div>
              {project.canReview && project.status === "ESTABLISHING" && (
                <div className="mt-3">
                  <Textarea
                    value={comments[project.id] ?? ""}
                    onChange={(event) =>
                      setComments((current) => ({
                        ...current,
                        [project.id]: event.target.value,
                      }))
                    }
                    placeholder="审核意见；驳回时必填"
                    rows={2}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <ProjectEstablishmentDetailDialog
        project={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </Card>
  );
}

function ProjectEstablishmentDetailDialog({
  project,
  onOpenChange,
}: {
  project: ProjectEstablishmentView | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!project} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>立项详情</DialogTitle>
          <DialogDescription>
            通过立项后项目进入未开始状态，之后才能启动项目。
          </DialogDescription>
        </DialogHeader>
        {project ? (
          <div className="space-y-5">
            <section className="grid gap-2 text-sm sm:grid-cols-2">
              <p>项目：{project.projectName}</p>
              <p>状态：{projectStatusLabels[project.status]}</p>
              <p>申请人：{project.requesterName || "未知"}</p>
              <p>提交时间：{formatDateTime(project.submittedAt)}</p>
              <p>车组/技术组：{formatScope(project.team, project.techGroup)}</p>
              <p>负责人：{project.ownerNames || "未设置"}</p>
              <p className="sm:col-span-2">
                参与人：{project.participantNames || "无"}
              </p>
              {project.reviewerName && <p>审核人：{project.reviewerName}</p>}
              {project.reviewedAt && (
                <p>审核时间：{formatDateTime(project.reviewedAt)}</p>
              )}
              {project.reviewComment && (
                <p className="sm:col-span-2">审核意见：{project.reviewComment}</p>
              )}
            </section>
            <section>
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <Clock3 className="h-4 w-4" />
                阶段计划
              </div>
              <ol className="space-y-2">
                {project.stages.map((stage, index) => (
                  <li key={`${stage.name}-${index}`} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {index + 1}. {stage.name}
                      </span>
                      <Badge variant="outline">{stage.durationDays} 天</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      负责人：{stage.ownerNames || "未设置"} · 预计 {stage.duePreview} 截止
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {stage.goal}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function formatScope(team: string, techGroup: string) {
  const left = team || "未指定车组";
  const right = techGroup || "未指定技术组";
  return `${left} / ${right}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
