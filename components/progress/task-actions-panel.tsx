"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { StatusStepper } from "@/components/progress/status-stepper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { TaskStatus } from "@prisma/client";
import { getTaskStepperDisplay } from "@/lib/progress-flow";

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
    createdAt: string;
  }[];
};

type Props = {
  taskId: string;
  status: TaskStatus;
  isAssignee: boolean;
  canApprove: boolean;
  canManage: boolean;
  needsOfflineConfirmation: boolean;
  needsWeeklyReport: boolean;
  submissions: Submission[];
};

export function TaskActionsPanel({
  taskId,
  status,
  isAssignee,
  canApprove,
  canManage,
  needsOfflineConfirmation,
  needsWeeklyReport,
  submissions,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [docUrl, setDocUrl] = useState("");
  const [keyDataUrl, setKeyDataUrl] = useState("");
  const [note, setNote] = useState("");
  const [failureReason, setFailureReason] = useState("");
  const [progress, setProgress] = useState("");
  const [risks, setRisks] = useState("");
  const [nextPlan, setNextPlan] = useState("");
  const [riskNote, setRiskNote] = useState("");
  const [offlineConfirmed, setOfflineConfirmed] = useState(false);

  const { steps, currentIndex } = getTaskStepperDisplay(status);

  const pendingSubmission = submissions.find(
    (s) => !s.approvals.some((a) => a.decision === "APPROVED"),
  );

  async function handleStatus(next: TaskStatus) {
    setLoading(true);
    try {
      await updateTaskStatus(taskId, next);
      toast.success("状态已更新");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
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
      toast.error(err instanceof Error ? err.message : "提交失败");
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
      toast.error(err instanceof Error ? err.message : "同步失败");
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
        feishuDocUrl: docUrl,
      });
      toast.success("周报已提交");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败");
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
        });
        toast.success("验收通过");
      } else {
        await rejectTaskSubmission({
          submissionId: pendingSubmission.id,
          offlineConfirmed,
        });
        toast.success("已驳回");
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>任务流程</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <StatusStepper steps={steps} currentIndex={currentIndex} />
          <div className="flex flex-wrap gap-3 border-t pt-4">
            {isAssignee && status === "TODO" && (
              <Button disabled={loading} onClick={() => handleStatus("IN_PROGRESS")}>
                开始任务
              </Button>
            )}
            {canManage && status === "COMPLETED" && (
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
                    toast.error(err instanceof Error ? err.message : "操作失败");
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                归档任务
              </Button>
            )}
          </div>
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
              <Label>关键数据链接（必填）</Label>
              <Input
                value={keyDataUrl}
                onChange={(e) => setKeyDataUrl(e.target.value)}
                placeholder="视频、照片、曲线或归档材料链接"
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
            <div className="flex gap-3">
              <Button
                disabled={
                  loading || (needsOfflineConfirmation && !offlineConfirmed)
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

      {submissions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>交付历史</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {submissions.map((s) => (
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
                  <p key={a.id} className="mt-1 text-muted-foreground">
                    {a.approverName}：
                    {a.decision === "APPROVED" ? "通过" : "驳回"}
                  </p>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
