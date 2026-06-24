"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  CheckCircle2,
  Circle,
  Clock3,
  Play,
} from "lucide-react";
import { toast } from "sonner";
import {
  approveTaskSubmission,
  rejectTaskSubmission,
} from "@/app/actions/progress/approveTaskSubmission";
import { submitTaskDelivery } from "@/app/actions/progress/submitTaskDelivery";
import {
  submitWeeklyReport,
  syncTaskRisk,
} from "@/app/actions/progress/submitWeeklyReport";
import { updateTaskStatus, archiveTask } from "@/app/actions/progress/updateTask";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { getActionErrorMessage } from "@/lib/action-error-message";
import { cn } from "@/lib/utils";
import type { TaskStatus } from "@prisma/client";
import { taskFlowSteps } from "@/lib/progress-flow";
import { taskStatusLabels } from "@/lib/progress-labels";

type Submission = {
  id: string;
  feishuDocUrl: string;
  keyDataUrl: string;
  note: string;
  failureReason: string;
  submittedAt: string;
  submitterName: string;
  approvals: {
    id: string;
    approverName: string;
    decision: string;
    comment: string;
    createdAt: string;
    checklistConfirmations: {
      id: string;
      content: string;
      sortOrder: number;
    }[];
  }[];
};

type AcceptanceChecklistItem = {
  id: string;
  content: string;
  sortOrder: number;
};

type Props = {
  taskId: string;
  status: TaskStatus;
  isAssignee: boolean;
  canApprove: boolean;
  canManage: boolean;
  needsOfflineConfirmation: boolean;
  needsWeeklyReport: boolean;
  acceptanceChecklistItems: AcceptanceChecklistItem[];
  submissions: Submission[];
  className?: string;
  showFlowActions?: boolean;
};

export function TaskActionsPanel({
  taskId,
  status,
  isAssignee,
  canApprove,
  canManage,
  needsOfflineConfirmation,
  needsWeeklyReport,
  acceptanceChecklistItems,
  submissions,
  className,
  showFlowActions = true,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [docUrl, setDocUrl] = useState("");
  const [weeklyDocUrl, setWeeklyDocUrl] = useState("");
  const [keyDataUrl, setKeyDataUrl] = useState("");
  const [note, setNote] = useState("");
  const [failureReason, setFailureReason] = useState("");
  const [rejectComment, setRejectComment] = useState("");
  const [progress, setProgress] = useState("");
  const [risks, setRisks] = useState("");
  const [nextPlan, setNextPlan] = useState("");
  const [riskNote, setRiskNote] = useState("");
  const [offlineConfirmed, setOfflineConfirmed] = useState(false);
  const [checkedChecklistItemIds, setCheckedChecklistItemIds] = useState<string[]>([]);

  const pendingSubmission = submissions.find(
    (s) => !s.approvals.some((a) => a.decision === "APPROVED"),
  );
  const canStartTask = (isAssignee || canManage) && status === "TODO";
  const canArchiveTask = canManage && status === "COMPLETED";
  const allChecklistItemsChecked =
    acceptanceChecklistItems.length === 0 ||
    acceptanceChecklistItems.every((item) =>
      checkedChecklistItemIds.includes(item.id),
    );

  async function handleStatus(next: TaskStatus) {
    setLoading(true);
    try {
      await updateTaskStatus(taskId, next);
      toast.success("状态已更新");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "操作失败"));
    } finally {
      setLoading(false);
    }
  }

  async function handleDelivery() {
    setLoading(true);
    try {
      await submitTaskDelivery({
        taskId,
        feishuDocUrl: docUrl,
        keyDataUrl,
        note,
        failureReason,
      });
      toast.success("交付已提交，等待验收");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "提交失败"));
    } finally {
      setLoading(false);
    }
  }

  async function handleRiskSync() {
    setLoading(true);
    try {
      await syncTaskRisk({ taskId, riskNote });
      toast.success("风险已同步");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "同步失败"));
    } finally {
      setLoading(false);
    }
  }

  async function handleWeekly() {
    setLoading(true);
    try {
      await submitWeeklyReport({
        taskId,
        progress,
        risks,
        nextPlan,
        feishuDocUrl: weeklyDocUrl,
      });
      toast.success("周报已提交");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "提交失败"));
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove(approve: boolean) {
    if (!pendingSubmission) return;
    setLoading(true);
    try {
      if (approve) {
        await approveTaskSubmission({
          submissionId: pendingSubmission.id,
          offlineConfirmed,
          checkedChecklistItemIds,
        });
        toast.success("验收通过");
      } else {
        await rejectTaskSubmission({
          submissionId: pendingSubmission.id,
          offlineConfirmed,
          comment: rejectComment,
        });
        toast.success("已驳回");
      }
      setRejectComment("");
      setCheckedChecklistItemIds([]);
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "操作失败"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={cn("space-y-5", className)}>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>任务流程</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <TaskFlowTimeline status={status} />
          {showFlowActions && (canStartTask || canArchiveTask) && (
            <div className="flex flex-wrap gap-3 border-t pt-4">
            {canStartTask && (
              <Button disabled={loading} onClick={() => handleStatus("IN_PROGRESS")}>
                开始任务
              </Button>
            )}
            {canArchiveTask && (
              <Button
                variant="outline"
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  try {
                    await archiveTask(taskId);
                    toast.success("已归档");
                    router.refresh();
                  } catch (err) {
                    toast.error(getActionErrorMessage(err, "操作失败"));
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                归档任务
              </Button>
            )}
            </div>
          )}
        </CardContent>
      </Card>

      {isAssignee && status === "IN_PROGRESS" && (
        <Card>
          <CardHeader>
            <CardTitle>提交交付</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label>飞书文档链接（必填）</Label>
              <Input
                value={docUrl}
                onChange={(e) => setDocUrl(e.target.value)}
                placeholder="https://xxx.feishu.cn/docx/..."
              />
            </div>
            <div className="space-y-2">
              <Label>关键数据/材料链接（必填）</Label>
              <Input
                value={keyDataUrl}
                onChange={(e) => setKeyDataUrl(e.target.value)}
                placeholder="视频、照片、曲线或归档材料链接，需为 URL"
              />
            </div>
            <div className="space-y-2">
              <Label>说明</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>未达标原因（如有）</Label>
              <Input
                value={failureReason}
                onChange={(e) => setFailureReason(e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <Button disabled={loading} onClick={handleDelivery}>
                提交验收
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isAssignee && status !== "ARCHIVED" && status !== "COMPLETED" && (
        <Card>
          <CardHeader>
            <CardTitle>
              本周进度周报{needsWeeklyReport ? "（必填）" : "（可选）"}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <Input
              className="md:col-span-3"
              placeholder="周报飞书文档链接（可选）"
              value={weeklyDocUrl}
              onChange={(e) => setWeeklyDocUrl(e.target.value)}
            />
            <Input
              placeholder="本周完成情况"
              value={progress}
              onChange={(e) => setProgress(e.target.value)}
            />
            <Input
              placeholder="风险同步"
              value={risks}
              onChange={(e) => setRisks(e.target.value)}
            />
            <Input
              placeholder="下周计划"
              value={nextPlan}
              onChange={(e) => setNextPlan(e.target.value)}
            />
            <div className="md:col-span-3">
              <Button variant="secondary" disabled={loading} onClick={handleWeekly}>
                提交周报
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isAssignee && status !== "ARCHIVED" && status !== "COMPLETED" && (
        <Card>
          <CardHeader>
            <CardTitle>风险同步</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Input
              placeholder="说明风险、阻塞或需要组长/项管介入的问题"
              value={riskNote}
              onChange={(e) => setRiskNote(e.target.value)}
            />
            <Button
              className="w-fit"
              variant="destructive"
              disabled={loading}
              onClick={handleRiskSync}
            >
              同步风险
            </Button>
          </CardContent>
        </Card>
      )}

      {canApprove && pendingSubmission && status === "PENDING_ACCEPTANCE" && (
        <Card>
          <CardHeader>
            <CardTitle>验收审批</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm">
              文档：
              <a
                href={pendingSubmission.feishuDocUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-1 text-primary hover:underline"
              >
                在飞书中打开
              </a>
            </p>
            {pendingSubmission.keyDataUrl && (
              <p className="text-sm">
                关键数据：
                <a
                  href={pendingSubmission.keyDataUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-1 text-primary hover:underline"
                >
                  打开材料
                </a>
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              提交人：{pendingSubmission.submitterName} ·{" "}
              {new Date(pendingSubmission.submittedAt).toLocaleString("zh-CN")}
            </p>
            {needsOfflineConfirmation && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={offlineConfirmed}
                  onChange={(e) => setOfflineConfirmed(e.target.checked)}
                />
                已完成线下确认
              </label>
            )}
            {acceptanceChecklistItems.length > 0 && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-sm font-medium">验收清单</p>
                <div className="space-y-2">
                  {acceptanceChecklistItems.map((item) => (
                    <label
                      key={item.id}
                      className="flex items-start gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={checkedChecklistItemIds.includes(item.id)}
                        onChange={(event) => {
                          setCheckedChecklistItemIds((current) =>
                            event.target.checked
                              ? [...new Set([...current, item.id])]
                              : current.filter((id) => id !== item.id),
                          );
                        }}
                      />
                      <span>{item.content}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <Textarea
              placeholder="驳回理由（驳回时会通知任务负责人）"
              value={rejectComment}
              onChange={(e) => setRejectComment(e.target.value)}
            />
            <div className="flex gap-3">
              <Button
                disabled={
                  loading ||
                  (needsOfflineConfirmation && !offlineConfirmed) ||
                  !allChecklistItemsChecked
                }
                onClick={() => handleApprove(true)}
              >
                通过验收
              </Button>
              <Button
                variant="destructive"
                disabled={loading}
                onClick={() => handleApprove(false)}
              >
                驳回
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>交付历史</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {submissions.length === 0 ? (
            <p className="rounded-md border border-dashed px-4 py-8 text-center text-muted-foreground">
              暂无交付记录。
            </p>
          ) : (
            submissions.map((s) => (
              <div key={s.id} className="rounded-lg border p-4">
                <a
                  href={s.feishuDocUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  飞书文档
                </a>
                <span className="ml-2 text-muted-foreground">
                  {s.submitterName} ·{" "}
                  {new Date(s.submittedAt).toLocaleString("zh-CN")}
                </span>
                {s.keyDataUrl && (
                  <a
                    href={s.keyDataUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 text-primary hover:underline"
                  >
                    关键数据
                  </a>
                )}
                {s.approvals.map((a) => (
                  <div key={a.id} className="mt-2 text-muted-foreground">
                    <p>
                      {a.approverName}：
                      {a.decision === "APPROVED" ? "通过" : "驳回"}
                      {a.comment ? ` · ${a.comment}` : ""}
                    </p>
                    {a.checklistConfirmations.length > 0 && (
                      <ul className="mt-1 space-y-1 rounded-md bg-muted/50 px-3 py-2 text-xs">
                        {a.checklistConfirmations.map((item) => (
                          <li key={item.id}>已确认：{item.content}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TaskFlowTimeline({ status }: { status: TaskStatus }) {
  const currentIndex = Math.max(taskFlowSteps.indexOf(status), 0);

  return (
    <div className="w-full overflow-x-auto pb-2">
      <ol className="flex min-w-max items-start gap-0">
        {taskFlowSteps.map((step, index) => {
          const isDone = index < currentIndex;
          const isCurrent = index === currentIndex;
          const isLast = index === taskFlowSteps.length - 1;

          return (
            <li key={step} className="flex items-start">
              <div className="group flex w-28 flex-col items-center gap-2 rounded-md px-2 py-1 text-center">
                <span
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-full border-2 bg-background text-sm font-semibold",
                    isDone && "border-green-600 bg-green-50 text-green-700",
                    isCurrent &&
                      "border-primary bg-primary/10 text-primary ring-4 ring-primary/15",
                    !isDone &&
                      !isCurrent &&
                      "border-muted-foreground/30 text-muted-foreground",
                  )}
                >
                  <TaskFlowStepIcon step={step} index={index} isDone={isDone} />
                </span>
                <span className="max-w-full truncate text-sm font-medium">
                  {taskStatusLabels[step]}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {isCurrent && <Circle className="h-2 w-2 fill-primary text-primary" />}
                  {isCurrent ? "当前状态" : isDone ? "已完成" : "未开始"}
                </span>
              </div>
              {!isLast && (
                <div
                  className={cn(
                    "mt-5 h-0.5 w-12 shrink-0",
                    isDone ? "bg-green-600" : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TaskFlowStepIcon({
  step,
  index,
  isDone,
}: {
  step: TaskStatus;
  index: number;
  isDone: boolean;
}) {
  if (isDone) return <CheckCircle2 className="h-5 w-5" />;
  if (step === "IN_PROGRESS") return <Play className="h-4 w-4" />;
  if (step === "PENDING_ACCEPTANCE") return <Clock3 className="h-5 w-5" />;
  if (step === "ARCHIVED") return <Archive className="h-5 w-5" />;
  return <>{index + 1}</>;
}
