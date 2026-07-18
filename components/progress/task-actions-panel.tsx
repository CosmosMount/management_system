"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  Ban,
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
  resolveTaskRisk,
  submitWeeklyReport,
  syncTaskRisk,
} from "@/app/actions/progress/submitWeeklyReport";
import { updateTaskStatus, archiveTask } from "@/app/actions/progress/updateTask";
import { Button } from "@/components/ui/button";
import { RequestApprovalReminderButton } from "@/components/progress/request-approval-reminder-button";
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
  submittedBy: string;
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

type RiskRecord = {
  id: string;
  content: string;
  source: "MANUAL" | "WEEKLY";
  status: "ACTIVE" | "RESOLVED";
  createdByName: string;
  resolvedByName: string;
  resolveNote: string;
  createdAt: string;
  resolvedAt: string | null;
};

type DeliveryErrors = {
  docUrl?: string;
  keyDataUrl?: string;
};

type WeeklyErrors = {
  weeklyDocUrl?: string;
  progress?: string;
};

type Props = {
  taskId: string;
  status: TaskStatus;
  isAssignee: boolean;
  canSubmitDelivery?: boolean;
  canSubmitWeeklyReport?: boolean;
  canSyncRisk?: boolean;
  canApprove: boolean;
  canManage: boolean;
  needsOfflineConfirmation: boolean;
  needsWeeklyReport: boolean;
  weeklyReportDueLabel?: string;
  acceptanceChecklistItems: AcceptanceChecklistItem[];
  submissions: Submission[];
  riskRecords?: RiskRecord[];
  className?: string;
  showFlowActions?: boolean;
  canRequestApprovalReminder: boolean;
  userOpenId?: string;
};

export function TaskActionsPanel({
  taskId,
  status,
  isAssignee,
  canSubmitDelivery,
  canSubmitWeeklyReport,
  canSyncRisk,
  canApprove,
  canManage,
  needsOfflineConfirmation,
  needsWeeklyReport,
  weeklyReportDueLabel,
  acceptanceChecklistItems,
  submissions,
  riskRecords = [],
  className,
  showFlowActions = true,
  canRequestApprovalReminder,
  userOpenId,
}: Props) {
  const router = useRouter();
  const docUrlInputRef = useRef<HTMLInputElement>(null);
  const keyDataUrlInputRef = useRef<HTMLInputElement>(null);
  const weeklyDocUrlInputRef = useRef<HTMLInputElement>(null);
  const weeklyProgressInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [docUrl, setDocUrl] = useState("");
  const [weeklyDocUrl, setWeeklyDocUrl] = useState("");
  const [keyDataUrl, setKeyDataUrl] = useState("");
  const [note, setNote] = useState("");
  const [failureReason, setFailureReason] = useState("");
  const [rejectComment, setRejectComment] = useState("");
  const [progress, setProgress] = useState("");
  const [nextPlan, setNextPlan] = useState("");
  const [riskNote, setRiskNote] = useState("");
  const [riskResolveNotes, setRiskResolveNotes] = useState<Record<string, string>>({});
  const [offlineConfirmed, setOfflineConfirmed] = useState(false);
  const [checkedChecklistItemIds, setCheckedChecklistItemIds] = useState<string[]>([]);
  const [deliveryErrors, setDeliveryErrors] = useState<DeliveryErrors>({});
  const [weeklyErrors, setWeeklyErrors] = useState<WeeklyErrors>({});

  const pendingSubmission = submissions.find(
    (s) => !s.approvals.some((a) => a.decision === "APPROVED"),
  );
  const canStartTask = (isAssignee || canManage) && status === "TODO";
  const canArchiveTask = canManage && status === "COMPLETED";
  const canSubmitTaskDelivery = canSubmitDelivery ?? isAssignee;
  const canSubmitTaskWeeklyReport =
    needsWeeklyReport && (canSubmitWeeklyReport ?? isAssignee);
  const canSyncTaskRisk = canSyncRisk ?? isAssignee;
  const isTerminalTask = isTerminalTaskStatus(status);
  const isWeeklyReportActive =
    status === "IN_PROGRESS" || status === "PENDING_ACCEPTANCE";
  const canShowWeeklyReport =
    canSubmitTaskWeeklyReport && isWeeklyReportActive && !isTerminalTask;
  const canMutateRisk = canSyncTaskRisk && !isTerminalTask;
  const activeRisks = riskRecords.filter((risk) => risk.status === "ACTIVE");
  const resolvedRisks = riskRecords.filter((risk) => risk.status === "RESOLVED");
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
    const nextErrors: DeliveryErrors = {};
    const docUrlError = validateRequiredUrl(
      docUrl,
      "请填写飞书文档链接",
      "请输入有效的飞书文档链接",
    );
    const keyDataUrlError = validateRequiredUrl(
      keyDataUrl,
      "请填写关键数据/材料链接",
      "请输入有效的关键数据/材料链接",
    );

    if (docUrlError) nextErrors.docUrl = docUrlError;
    if (keyDataUrlError) nextErrors.keyDataUrl = keyDataUrlError;

    if (nextErrors.docUrl || nextErrors.keyDataUrl) {
      setDeliveryErrors(nextErrors);
      toast.error("请先补全交付表单中的必填链接");
      focusInput(nextErrors.docUrl ? docUrlInputRef.current : keyDataUrlInputRef.current);
      return;
    }

    setDeliveryErrors({});
    setLoading(true);
    try {
      await submitTaskDelivery({
        taskId,
        feishuDocUrl: docUrl.trim(),
        keyDataUrl: keyDataUrl.trim(),
        note: note.trim(),
        failureReason: failureReason.trim(),
      });
      toast.success("交付已提交，等待验收");
      setDocUrl("");
      setKeyDataUrl("");
      setNote("");
      setFailureReason("");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "提交失败"));
    } finally {
      setLoading(false);
    }
  }

  async function handleRiskSync() {
    if (!riskNote.trim()) {
      toast.error("请填写风险说明");
      return;
    }
    setLoading(true);
    try {
      await syncTaskRisk({ taskId, content: riskNote.trim() });
      toast.success("风险已同步");
      setRiskNote("");
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "同步失败"));
    } finally {
      setLoading(false);
    }
  }

  async function handleRiskResolve(riskId: string) {
    const resolveNote = riskResolveNotes[riskId]?.trim();
    if (!resolveNote) {
      toast.error("请填写风险解除说明");
      return;
    }
    setLoading(true);
    try {
      await resolveTaskRisk({ riskId, resolveNote });
      toast.success("风险已解除");
      setRiskResolveNotes((current) => ({ ...current, [riskId]: "" }));
      router.refresh();
    } catch (err) {
      toast.error(getActionErrorMessage(err, "解除失败"));
    } finally {
      setLoading(false);
    }
  }

  async function handleWeekly() {
    const nextErrors: WeeklyErrors = {};
    const weeklyDocUrlError = validateOptionalUrl(
      weeklyDocUrl,
      "请输入有效的周报飞书文档链接",
    );

    if (weeklyDocUrlError) nextErrors.weeklyDocUrl = weeklyDocUrlError;
    if (!progress.trim()) nextErrors.progress = "请填写本周完成情况";

    if (nextErrors.weeklyDocUrl || nextErrors.progress) {
      setWeeklyErrors(nextErrors);
      toast.error("请先补全周报表单中的必填项");
      focusInput(
        nextErrors.weeklyDocUrl
          ? weeklyDocUrlInputRef.current
          : weeklyProgressInputRef.current,
      );
      return;
    }

    setWeeklyErrors({});
    setLoading(true);
    try {
      await submitWeeklyReport({
        taskId,
        progress: progress.trim(),
        nextPlan: nextPlan.trim(),
        feishuDocUrl: weeklyDocUrl.trim(),
      });
      toast.success("周报已提交");
      setWeeklyDocUrl("");
      setProgress("");
      setNextPlan("");
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

      {canSubmitTaskDelivery && status === "IN_PROGRESS" && (
        <Card>
          <CardHeader>
            <CardTitle>提交交付</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label>飞书文档链接（必填）</Label>
              <Input
                ref={docUrlInputRef}
                value={docUrl}
                onChange={(e) => {
                  setDocUrl(e.target.value);
                  clearDeliveryError("docUrl", setDeliveryErrors);
                }}
                placeholder="https://xxx.feishu.cn/docx/..."
                inputMode="url"
                aria-invalid={!!deliveryErrors.docUrl}
                aria-describedby={
                  deliveryErrors.docUrl ? "task-delivery-doc-url-error" : undefined
                }
              />
              {deliveryErrors.docUrl && (
                <p
                  id="task-delivery-doc-url-error"
                  className="text-sm text-destructive"
                >
                  {deliveryErrors.docUrl}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>关键数据/材料链接（必填）</Label>
              <Input
                ref={keyDataUrlInputRef}
                value={keyDataUrl}
                onChange={(e) => {
                  setKeyDataUrl(e.target.value);
                  clearDeliveryError("keyDataUrl", setDeliveryErrors);
                }}
                placeholder="视频、照片、曲线或归档材料链接，需为 URL"
                inputMode="url"
                aria-invalid={!!deliveryErrors.keyDataUrl}
                aria-describedby={
                  deliveryErrors.keyDataUrl
                    ? "task-delivery-key-data-url-error"
                    : undefined
                }
              />
              {deliveryErrors.keyDataUrl && (
                <p
                  id="task-delivery-key-data-url-error"
                  className="text-sm text-destructive"
                >
                  {deliveryErrors.keyDataUrl}
                </p>
              )}
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
              <Button type="button" disabled={loading} onClick={handleDelivery}>
                提交验收
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {canShowWeeklyReport && (
        <Card>
          <CardHeader>
            <CardTitle>
              本周进度周报（必填）
            </CardTitle>
            {weeklyReportDueLabel && (
              <p className="text-sm text-muted-foreground">
                {weeklyReportDueLabel}
              </p>
            )}
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Input
                ref={weeklyDocUrlInputRef}
                placeholder="周报飞书文档链接（可选）"
                value={weeklyDocUrl}
                onChange={(e) => {
                  setWeeklyDocUrl(e.target.value);
                  clearWeeklyError("weeklyDocUrl", setWeeklyErrors);
                }}
                inputMode="url"
                aria-invalid={!!weeklyErrors.weeklyDocUrl}
                aria-describedby={
                  weeklyErrors.weeklyDocUrl
                    ? "task-weekly-doc-url-error"
                    : undefined
                }
              />
              {weeklyErrors.weeklyDocUrl && (
                <p
                  id="task-weekly-doc-url-error"
                  className="text-sm text-destructive"
                >
                  {weeklyErrors.weeklyDocUrl}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Input
                ref={weeklyProgressInputRef}
                placeholder="本周完成情况"
                value={progress}
                onChange={(e) => {
                  setProgress(e.target.value);
                  clearWeeklyError("progress", setWeeklyErrors);
                }}
                aria-invalid={!!weeklyErrors.progress}
                aria-describedby={
                  weeklyErrors.progress ? "task-weekly-progress-error" : undefined
                }
              />
              {weeklyErrors.progress && (
                <p
                  id="task-weekly-progress-error"
                  className="text-sm text-destructive"
                >
                  {weeklyErrors.progress}
                </p>
              )}
            </div>
            <Input
              placeholder="下周计划"
              value={nextPlan}
              onChange={(e) => setNextPlan(e.target.value)}
            />
            <div className="md:col-span-2">
              <Button
                type="button"
                variant="secondary"
                disabled={loading}
                onClick={handleWeekly}
              >
                提交周报
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {(canMutateRisk || activeRisks.length > 0 || resolvedRisks.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>风险同步</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeRisks.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium">当前未解决风险</p>
                {activeRisks.map((risk) => (
                  <div
                    key={risk.id}
                    className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
                  >
                    <p className="whitespace-pre-wrap text-destructive">
                      {risk.content}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatRiskSource(risk.source)} · {risk.createdByName} ·{" "}
                      {new Date(risk.createdAt).toLocaleString("zh-CN")}
                    </p>
                    {canMutateRisk && (
                      <div className="space-y-2 border-t pt-2">
                        <Input
                          placeholder="风险解除说明"
                          value={riskResolveNotes[risk.id] ?? ""}
                          onChange={(event) =>
                            setRiskResolveNotes((current) => ({
                              ...current,
                              [risk.id]: event.target.value,
                            }))
                          }
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={loading}
                          onClick={() => handleRiskResolve(risk.id)}
                        >
                          解除风险
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {canMutateRisk && (
              <div className="grid gap-3">
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
              </div>
            )}

            {resolvedRisks.length > 0 && (
              <div className="space-y-2 border-t pt-3">
                <p className="text-sm font-medium">已解除风险</p>
                {resolvedRisks.map((risk) => (
                  <div key={risk.id} className="rounded-lg border p-3 text-sm">
                    <p className="whitespace-pre-wrap">{risk.content}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {risk.resolvedByName || "未知"} ·{" "}
                      {risk.resolvedAt
                        ? new Date(risk.resolvedAt).toLocaleString("zh-CN")
                        : "未记录时间"}
                      {risk.resolveNote ? ` · ${risk.resolveNote}` : ""}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {canApprove && pendingSubmission && status === "PENDING_ACCEPTANCE" && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <CardTitle>验收审批</CardTitle>
            {(canRequestApprovalReminder ||
              pendingSubmission.submittedBy === userOpenId) && (
              <RequestApprovalReminderButton
                reference={{ kind: "TASK_ACCEPTANCE", id: pendingSubmission.id }}
                compact
                subject="任务验收"
              />
            )}
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

      {!canApprove && pendingSubmission && status === "PENDING_ACCEPTANCE" &&
        (canRequestApprovalReminder || pendingSubmission.submittedBy === userOpenId) && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle>验收审批</CardTitle>
              <RequestApprovalReminderButton
                reference={{ kind: "TASK_ACCEPTANCE", id: pendingSubmission.id }}
                compact
                subject="任务验收"
              />
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              当前交付已提交，正在等待验收。
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

function validateRequiredUrl(
  value: string,
  emptyMessage: string,
  invalidMessage: string,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return emptyMessage;
  return isValidAbsoluteUrl(trimmed) ? null : invalidMessage;
}

function validateOptionalUrl(
  value: string,
  invalidMessage: string,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isValidAbsoluteUrl(trimmed) ? null : invalidMessage;
}

function isValidAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function focusInput(input: HTMLInputElement | null) {
  input?.scrollIntoView({ behavior: "smooth", block: "center" });
  input?.focus();
}

function clearDeliveryError(
  field: keyof DeliveryErrors,
  setErrors: Dispatch<SetStateAction<DeliveryErrors>>,
) {
  setErrors((current) => {
    if (!current[field]) return current;
    return { ...current, [field]: undefined };
  });
}

function clearWeeklyError(
  field: keyof WeeklyErrors,
  setErrors: Dispatch<SetStateAction<WeeklyErrors>>,
) {
  setErrors((current) => {
    if (!current[field]) return current;
    return { ...current, [field]: undefined };
  });
}

function TaskFlowTimeline({ status }: { status: TaskStatus }) {
  const steps =
    status === "PROJECT_CANCELED" ? (["PROJECT_CANCELED"] as TaskStatus[]) : taskFlowSteps;
  const currentIndex = Math.max(steps.indexOf(status), 0);

  return (
    <div className="w-full overflow-x-auto pb-2">
      <ol className="flex min-w-max items-start gap-0">
        {steps.map((step, index) => {
          const isDone = index < currentIndex;
          const isCurrent = index === currentIndex;
          const isLast = index === steps.length - 1;

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
  if (step === "PROJECT_CANCELED") return <Ban className="h-5 w-5" />;
  if (step === "IN_PROGRESS") return <Play className="h-4 w-4" />;
  if (step === "PENDING_ACCEPTANCE") return <Clock3 className="h-5 w-5" />;
  if (step === "ARCHIVED") return <Archive className="h-5 w-5" />;
  return <>{index + 1}</>;
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "ARCHIVED" ||
    status === "PROJECT_CANCELED"
  );
}

function formatRiskSource(source: "MANUAL" | "WEEKLY"): string {
  return source === "WEEKLY" ? "周报同步" : "手动同步";
}
