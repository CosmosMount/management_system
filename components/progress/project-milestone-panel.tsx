"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  advanceProjectMilestone,
  submitMilestoneDoc,
} from "@/app/actions/progress/advanceProjectMilestone";
import { updateProjectStatus } from "@/app/actions/progress/updateProjectStatus";
import { StatusStepper } from "@/components/progress/status-stepper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { MilestoneStatus, ProjectStatus } from "@prisma/client";
import {
  getNextProjectStatuses,
  getProjectStepperDisplay,
} from "@/lib/progress-flow";
import { milestoneStatusLabels } from "@/lib/progress-labels";

type Milestone = {
  id: string;
  name: string;
  sortOrder: number;
  status: MilestoneStatus;
  feishuDocUrl: string;
  submissionId: string | null;
};

type Props = {
  projectId: string;
  status: ProjectStatus;
  milestones: Milestone[];
  canManage: boolean;
  canApprove: boolean;
};

const destructiveStatuses = new Set<ProjectStatus>([
  "ABNORMAL",
  "OUTCOME_POOR",
]);

export function ProjectMilestonePanel({
  projectId,
  status,
  milestones,
  canManage,
  canApprove,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [docUrls, setDocUrls] = useState<Record<string, string>>({});

  const { steps, currentIndex, branchNote } = getProjectStepperDisplay(status);
  const nextActions = getNextProjectStatuses(status);

  const currentMilestoneIndex = milestones.findIndex(
    (m) => m.status !== "PASSED",
  );

  async function handleStatus(next: ProjectStatus) {
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

  async function handleSubmitMilestone(milestoneId: string) {
    const url = docUrls[milestoneId];
    if (!url) {
      toast.error("请填写飞书文档链接");
      return;
    }
    setLoading(true);
    try {
      await submitMilestoneDoc({ projectId, milestoneId, feishuDocUrl: url });
      toast.success("里程碑文档已提交");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败");
    } finally {
      setLoading(false);
    }
  }

  async function handleAdvance(milestoneId: string, pass: boolean) {
    setLoading(true);
    try {
      await advanceProjectMilestone({ projectId, milestoneId, pass });
      toast.success(pass ? "里程碑验收通过" : "里程碑验收驳回");
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
          <CardTitle>项目流程</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <StatusStepper steps={steps} currentIndex={currentIndex} />
          {branchNote && (
            <p className="rounded-md bg-muted/60 px-4 py-2 text-sm text-muted-foreground">
              {branchNote}
            </p>
          )}
          {canManage && status !== "ARCHIVED" && nextActions.length > 0 && (
            <div className="flex flex-wrap gap-3 border-t pt-4">
              {nextActions.map((a) => (
                <Button
                  key={a.status}
                  disabled={loading}
                  variant={
                    destructiveStatuses.has(a.status) ? "destructive" : "default"
                  }
                  onClick={() => handleStatus(a.status)}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>验收里程碑</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {milestones.map((m, index) => {
            const isCurrent = index === currentMilestoneIndex;
            const isLocked = index > currentMilestoneIndex;
            const isPassed = m.status === "PASSED";

            return (
              <div
                key={m.id}
                className={`rounded-lg border p-5 transition-colors ${
                  isCurrent
                    ? "border-primary/40 bg-primary/5"
                    : isLocked
                      ? "opacity-50"
                      : ""
                }`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-lg font-medium">
                    {m.sortOrder + 1}. {m.name}
                  </span>
                  <Badge
                    variant={
                      isPassed
                        ? "default"
                        : m.status === "FAILED"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {milestoneStatusLabels[m.status]}
                  </Badge>
                  {isLocked && (
                    <span className="text-sm text-muted-foreground">
                      需先完成前一里程碑
                    </span>
                  )}
                </div>

                {m.feishuDocUrl && (
                  <a
                    href={m.feishuDocUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-sm text-primary hover:underline"
                  >
                    查看已提交文档
                  </a>
                )}

                {canManage &&
                  isCurrent &&
                  m.status === "PENDING" &&
                  !m.submissionId && (
                    <div className="mt-4 flex gap-3">
                      <Input
                        className="max-w-xl flex-1"
                        placeholder="飞书文档链接"
                        value={docUrls[m.id] ?? ""}
                        onChange={(e) =>
                          setDocUrls((prev) => ({
                            ...prev,
                            [m.id]: e.target.value,
                          }))
                        }
                      />
                      <Button
                        disabled={loading}
                        onClick={() => handleSubmitMilestone(m.id)}
                      >
                        提交文档
                      </Button>
                    </div>
                  )}

                {canApprove &&
                  isCurrent &&
                  m.submissionId &&
                  m.status === "PENDING" && (
                    <div className="mt-4 flex flex-wrap gap-3">
                      <Button
                        disabled={loading}
                        onClick={() => handleAdvance(m.id, true)}
                      >
                        通过验收
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={loading}
                        onClick={() => handleAdvance(m.id, false)}
                      >
                        驳回
                      </Button>
                    </div>
                  )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
