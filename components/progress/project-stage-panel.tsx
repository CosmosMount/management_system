"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  approveStageSubmission,
  rejectStageSubmission,
  submitStageEvidence,
} from "@/app/actions/progress/projectStages";
import { updateProjectStatus } from "@/app/actions/progress/updateProjectStatus";
import { StatusStepper } from "@/components/progress/status-stepper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProjectStatus, StageStatus } from "@prisma/client";
import { getProjectStepperDisplay } from "@/lib/progress-flow";
import { stageStatusLabels } from "@/lib/progress-labels";

type StageSubmission = {
  id: string;
  feishuDocUrl: string;
  note: string;
  submittedBy: string;
  submitterName: string;
  submittedAt: string;
  canApprove: boolean;
  approvals: {
    id: string;
    decision: string;
    approverName: string;
    comment: string;
    createdAt: string;
  }[];
};

type Stage = {
  id: string;
  name: string;
  goal: string;
  sortOrder: number;
  status: StageStatus;
  evidenceUrl: string;
  ownerOpenId: string;
  ownerName: string;
  dueAt: string | null;
  currentSubmissionId: string | null;
  canSubmit: boolean;
  submissions: StageSubmission[];
};

type Props = {
  projectId: string;
  status: ProjectStatus;
  stages: Stage[];
  canUpdateLifecycle: boolean;
};

export function ProjectStagePanel({
  projectId,
  status,
  stages,
  canUpdateLifecycle,
}: Props) {
  const router = useRouter();
  const evidenceInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [loading, setLoading] = useState(false);
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});
  const [evidenceUrlErrors, setEvidenceUrlErrors] = useState<
    Record<string, string>
  >({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});

  const { steps, currentIndex, branchNote } = getProjectStepperDisplay(status);
  const allStagesCompleted =
    stages.length > 0 && stages.every((s) => s.status === "COMPLETED");
  const currentStage =
    stages.find((s) => s.status === "PENDING_ACCEPTANCE") ??
    stages.find((s) => s.status === "IN_PROGRESS") ??
    stages.find((s) => s.status === "NOT_STARTED") ??
    stages.at(-1);
  const currentStageIndex = currentStage ? stages.indexOf(currentStage) : 0;
  const stageSteps = stages.map((stage) => ({
    key: stage.id,
    label: stage.name,
  }));

  async function handleProjectStatus(next: ProjectStatus) {
    setLoading(true);
    try {
      await updateProjectStatus(projectId, next);
      toast.success("项目状态已更新");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setLoading(false);
    }
  }

  async function handleStageSubmit(stageId: string) {
    const evidenceUrl = evidenceUrls[stageId] ?? "";
    const error = validateRequiredUrl(
      evidenceUrl,
      "请填写文档或归档链接",
      "请输入有效的文档或归档链接",
    );
    if (error) {
      setEvidenceUrlErrors((prev) => ({ ...prev, [stageId]: error }));
      toast.error(error);
      const input = evidenceInputRefs.current[stageId];
      input?.scrollIntoView({ behavior: "smooth", block: "center" });
      input?.focus();
      return;
    }

    setEvidenceUrlErrors((prev) => ({ ...prev, [stageId]: "" }));
    setLoading(true);
    try {
      await submitStageEvidence({
        projectId,
        stageId,
        evidenceUrl: evidenceUrl.trim(),
        note: (notes[stageId] ?? "").trim(),
      });
      toast.success("阶段材料已提交");
      setEvidenceUrls((prev) => ({ ...prev, [stageId]: "" }));
      setEvidenceUrlErrors((prev) => ({ ...prev, [stageId]: "" }));
      setNotes((prev) => ({ ...prev, [stageId]: "" }));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败");
    } finally {
      setLoading(false);
    }
  }

  async function handleReview(submissionId: string, pass: boolean) {
    setLoading(true);
    try {
      if (pass) {
        await approveStageSubmission({
          submissionId,
          comment: comments[submissionId] ?? "",
        });
      } else {
        await rejectStageSubmission({
          submissionId,
          comment: comments[submissionId] ?? "",
        });
      }
      toast.success(pass ? "阶段已通过" : "阶段已驳回");
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
          <CardTitle>项目生命周期</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <StatusStepper steps={steps} currentIndex={currentIndex} />
          {branchNote && (
            <p className="rounded-md bg-muted/60 px-4 py-2 text-sm text-muted-foreground">
              {branchNote}
            </p>
          )}
          {canUpdateLifecycle && (
            <div className="flex flex-wrap gap-3 border-t pt-4">
              {status === "NOT_STARTED" && (
                <Button
                  disabled={loading}
                  onClick={() => handleProjectStatus("IN_PROGRESS")}
                >
                  启动项目
                </Button>
              )}
              {status === "IN_PROGRESS" && (
                <>
                  <Button
                    disabled={loading || !allStagesCompleted}
                    onClick={() => handleProjectStatus("COMPLETED")}
                  >
                    完成项目
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={loading}
                    onClick={() => handleProjectStatus("CANCELED")}
                  >
                    取消项目
                  </Button>
                </>
              )}
              {status === "NOT_STARTED" && (
                <Button
                  variant="destructive"
                  disabled={loading}
                  onClick={() => handleProjectStatus("CANCELED")}
                >
                  取消项目
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>项目阶段</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {stageSteps.length > 0 && (
            <StatusStepper
              steps={stageSteps}
              currentIndex={currentStageIndex}
            />
          )}

          {currentStage ? (
            <CurrentStageCard
              stage={currentStage}
              status={status}
              loading={loading}
              evidenceUrl={evidenceUrls[currentStage.id] ?? ""}
              evidenceUrlError={evidenceUrlErrors[currentStage.id] ?? ""}
              evidenceInputRef={(element) => {
                evidenceInputRefs.current[currentStage.id] = element;
              }}
              note={notes[currentStage.id] ?? ""}
              comments={comments}
              onEvidenceChange={(value) => {
                setEvidenceUrls((prev) => ({
                  ...prev,
                  [currentStage.id]: value,
                }));
                if (evidenceUrlErrors[currentStage.id]) {
                  setEvidenceUrlErrors((prev) => ({
                    ...prev,
                    [currentStage.id]: "",
                  }));
                }
              }}
              onNoteChange={(value) =>
                setNotes((prev) => ({
                  ...prev,
                  [currentStage.id]: value,
                }))
              }
              onCommentChange={(submissionId, value) =>
                setComments((prev) => ({
                  ...prev,
                  [submissionId]: value,
                }))
              }
              onStageSubmit={handleStageSubmit}
              onReview={handleReview}
            />
          ) : (
            <p className="text-sm text-muted-foreground">暂无项目阶段</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CurrentStageCard({
  stage,
  status,
  loading,
  evidenceUrl,
  evidenceUrlError,
  evidenceInputRef,
  note,
  comments,
  onEvidenceChange,
  onNoteChange,
  onCommentChange,
  onStageSubmit,
  onReview,
}: {
  stage: Stage;
  status: ProjectStatus;
  loading: boolean;
  evidenceUrl: string;
  evidenceUrlError: string;
  evidenceInputRef: (element: HTMLInputElement | null) => void;
  note: string;
  comments: Record<string, string>;
  onEvidenceChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onCommentChange: (submissionId: string, value: string) => void;
  onStageSubmit: (stageId: string) => void;
  onReview: (submissionId: string, pass: boolean) => void;
}) {
  const pendingSubmission = stage.submissions.find(
    (s) => s.id === stage.currentSubmissionId,
  );
  const canApprove = pendingSubmission?.canApprove;
  const canSubmit =
    stage.canSubmit &&
    status === "IN_PROGRESS" &&
    stage.status === "IN_PROGRESS";

  return (
    <div className="rounded-lg border p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-lg font-medium">
          当前阶段：{stage.sortOrder + 1}. {stage.name}
        </span>
        <Badge>{stageStatusLabels[stage.status]}</Badge>
        <Badge variant="outline">负责人 {stage.ownerName}</Badge>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{stage.goal}</p>
      {stage.dueAt && (
        <p className="mt-1 text-sm text-muted-foreground">
          DDL：{new Date(stage.dueAt).toLocaleString("zh-CN")}
        </p>
      )}
      {stage.evidenceUrl && (
        <a
          href={stage.evidenceUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-sm text-primary hover:underline"
        >
          查看当前归档材料
        </a>
      )}

      {canSubmit && (
        <div className="mt-4 grid gap-3">
          <Input
            ref={evidenceInputRef}
            placeholder="文档或文件归档链接"
            value={evidenceUrl}
            onChange={(e) => onEvidenceChange(e.target.value)}
            inputMode="url"
            aria-invalid={!!evidenceUrlError}
            aria-describedby={
              evidenceUrlError ? "legacy-stage-evidence-url-error" : undefined
            }
          />
          {evidenceUrlError && (
            <p
              id="legacy-stage-evidence-url-error"
              className="text-sm text-destructive"
            >
              {evidenceUrlError}
            </p>
          )}
          <Textarea
            placeholder="提交说明（可选）"
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
          />
          <Button
            className="w-fit"
            disabled={loading}
            onClick={() => onStageSubmit(stage.id)}
          >
            提交阶段审批
          </Button>
        </div>
      )}

      {pendingSubmission && stage.status === "PENDING_ACCEPTANCE" && (
        <div className="mt-4 rounded-md border bg-muted/30 p-4">
          <p className="text-sm">
            提交人：{pendingSubmission.submitterName} ·{" "}
            {new Date(pendingSubmission.submittedAt).toLocaleString("zh-CN")}
          </p>
          <a
            href={pendingSubmission.feishuDocUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-sm text-primary hover:underline"
          >
            打开提交材料
          </a>
          {canApprove && (
            <div className="mt-3 grid gap-3">
              <Textarea
                placeholder="审批意见（可选）"
                value={comments[pendingSubmission.id] ?? ""}
                onChange={(e) =>
                  onCommentChange(pendingSubmission.id, e.target.value)
                }
              />
              <div className="flex gap-3">
                <Button
                  disabled={loading}
                  onClick={() => onReview(pendingSubmission.id, true)}
                >
                  通过
                </Button>
                <Button
                  variant="destructive"
                  disabled={loading}
                  onClick={() => onReview(pendingSubmission.id, false)}
                >
                  驳回
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {stage.submissions.length > 0 && (
        <div className="mt-4 space-y-2 text-sm">
          <p className="font-medium">提交历史</p>
          {stage.submissions.map((submission) => (
            <div key={submission.id} className="rounded border p-3">
              <a
                href={submission.feishuDocUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                归档材料
              </a>
              <span className="ml-2 text-muted-foreground">
                {submission.submitterName} ·{" "}
                {new Date(submission.submittedAt).toLocaleString("zh-CN")}
              </span>
              {submission.approvals.map((approval) => (
                <p key={approval.id} className="text-muted-foreground">
                  {approval.approverName}：
                  {approval.decision === "APPROVED" ? "通过" : "驳回"}
                  {approval.comment ? ` · ${approval.comment}` : ""}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
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

  try {
    new URL(trimmed);
    return null;
  } catch {
    return invalidMessage;
  }
}
