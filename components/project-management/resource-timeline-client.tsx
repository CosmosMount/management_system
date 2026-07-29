"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Check,
  GitMerge,
  MoveRight,
  Plus,
  Scissors,
  Split,
  X,
} from "lucide-react";
import {
  cancelPlannedSegment,
  confirmPlannedSegment,
  createWorkSegment,
  mergePlannedSegments,
  movePlannedSegments,
  partiallyConfirmSegment,
  splitPlannedSegment,
} from "@/app/actions/project-management/segments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { ProjectManagementActionResult } from "@/lib/project-management/application/action-result";
import {
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "@/lib/project-management/date-time";
import {
  formatDateTime,
  taskPriorityLabels,
  workSegmentRoleLabels,
  workSegmentStatusLabels,
  workSegmentTypeLabels,
} from "@/lib/project-management/labels";
import type { WorkSegmentDetail } from "@/lib/project-management/queries/resource-queries";
import { cn } from "@/lib/utils";

type TaskOption = {
  id: string;
  title: string;
  activeNodeId: string | null;
};

type PersonOption = {
  id: string;
  displayName: string;
};

type ResourceTimelineClientProps = {
  segments: WorkSegmentDetail[];
  people: PersonOption[];
  tasks: TaskOption[];
  defaultPersonId: string;
  rangeStart: string;
  rangeEnd: string;
};

type MutationState = {
  kind: "idle" | "success" | "error";
  message: string;
};

export function ResourceTimelineClient({
  segments,
  people,
  tasks,
  defaultPersonId,
  rangeStart,
  rangeEnd,
}: ResourceTimelineClientProps) {
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<MutationState>({
    kind: "idle",
    message: "",
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const selectedSegments = segments.filter((segment) => selected.has(segment.id));

  function runMutation(
    action: () => Promise<ProjectManagementActionResult<unknown>>,
    successMessage: string,
  ) {
    setState({ kind: "idle", message: "" });
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setState({ kind: "success", message: successMessage });
        setSelected(new Set());
        return;
      }
      setState({ kind: "error", message: result.error.message });
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
      <form
        className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const taskId = String(form.get("taskId") ?? "");
          const task = taskId ? taskById.get(taskId) : null;
          const allocationText = String(form.get("allocation") ?? "").trim();
          runMutation(
            () =>
              createWorkSegment({
                personId: String(form.get("personId") ?? defaultPersonId),
                type: "PLANNED",
                startAt: localDateTimeToIso(String(form.get("startAt") ?? "")),
                endAt: localDateTimeToIso(String(form.get("endAt") ?? "")),
                content: String(form.get("content") ?? ""),
                allocation: allocationText ? Number(allocationText) : null,
                role: String(form.get("role") ?? "DEVELOPER"),
                priority: String(form.get("priority") ?? "MEDIUM"),
                taskId: taskId || null,
                nodeId: task?.activeNodeId ?? null,
                tagIds: [],
              }),
            "已创建 Planned Segment",
          );
        }}
      >
        <div>
          <h2 className="text-base font-medium">新增计划投入</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            计划与实际仍由服务端状态机校验。
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="segment-person">人员</Label>
          <select
            id="segment-person"
            name="personId"
            defaultValue={defaultPersonId}
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
          >
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="segment-task">关联 Task</Label>
          <select
            id="segment-task"
            name="taskId"
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
          >
            <option value="">不关联 Task</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <div className="grid gap-2">
            <Label htmlFor="segment-start">开始</Label>
            <Input
              id="segment-start"
              name="startAt"
              type="datetime-local"
              defaultValue={toDateTimeLocal(rangeStart)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="segment-end">结束</Label>
            <Input
              id="segment-end"
              name="endAt"
              type="datetime-local"
              defaultValue={toDateTimeLocal(rangeEnd)}
              required
            />
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="segment-content">工作内容</Label>
          <Textarea
            id="segment-content"
            name="content"
            defaultValue="计划投入"
            required
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2">
            <Label htmlFor="segment-allocation">投入比例</Label>
            <Input
              id="segment-allocation"
              name="allocation"
              type="number"
              min="1"
              max="100"
              step="0.01"
              defaultValue="50"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="segment-priority">优先级</Label>
            <select
              id="segment-priority"
              name="priority"
              defaultValue="MEDIUM"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            >
              {Object.entries(taskPriorityLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="segment-role">职责</Label>
          <select
            id="segment-role"
            name="role"
            defaultValue="DEVELOPER"
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
          >
            {Object.entries(workSegmentRoleLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={isPending}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          新增计划
        </Button>
      </form>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-muted-foreground">
            已选择 {selected.size} 条 Planned Segment
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={isPending || selectedSegments.length < 2}
            onClick={() =>
              runMutation(
                () =>
                  mergePlannedSegments({
                    segments: selectedSegments.map((segment) => ({
                      segmentId: segment.id,
                      expectedUpdatedAt: segment.updatedAt,
                    })),
                    reason: "资源时间轴合并计划",
                  }),
                "已合并所选计划",
              )
            }
          >
            <GitMerge className="h-4 w-4" aria-hidden="true" />
            合并所选
          </Button>
        </div>
        {state.kind !== "idle" && (
          <p
            className={cn(
              "rounded-lg px-3 py-2 text-sm",
              state.kind === "success"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-destructive/10 text-destructive",
            )}
            role={state.kind === "error" ? "alert" : "status"}
          >
            {state.message}
          </p>
        )}
        {segments.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            当前范围内没有可见的人员投入记录。
          </div>
        ) : (
          <div className="space-y-3">
            {segments.map((segment) => (
              <article
                key={segment.id}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {segment.type === "PLANNED" &&
                        segment.status !== "CONFIRMED" &&
                        segment.status !== "CANCELLED" && (
                          <input
                            type="checkbox"
                            aria-label={`选择 ${segment.content}`}
                            checked={selected.has(segment.id)}
                            onChange={(event) => {
                              const next = new Set(selected);
                              if (event.target.checked) next.add(segment.id);
                              else next.delete(segment.id);
                              setSelected(next);
                            }}
                            className="h-4 w-4"
                          />
                        )}
                      <h3 className="truncate text-base font-medium">
                        {segment.content}
                      </h3>
                      <Badge variant={segment.type === "ACTUAL" ? "default" : "outline"}>
                        {workSegmentTypeLabels[segment.type]}
                      </Badge>
                      <Badge variant="secondary">
                        {workSegmentStatusLabels[segment.status]}
                      </Badge>
                      {segment.associationNeedsReview && (
                        <Badge variant="destructive">关联待确认</Badge>
                      )}
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {segment.personName} · {formatDateTime(segment.startAt)} -{" "}
                      {formatDateTime(segment.endAt)} ·{" "}
                      {segment.allocation == null
                        ? "未填写投入比例"
                        : `${segment.allocation}%`}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {segment.task?.title ?? "未关联 Task"} ·{" "}
                      {workSegmentRoleLabels[segment.role]} ·{" "}
                      {taskPriorityLabels[segment.priority]}
                    </p>
                  </div>
                  <SegmentActions
                    segment={segment}
                    disabled={isPending}
                    onRun={runMutation}
                  />
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SegmentActions({
  segment,
  disabled,
  onRun,
}: {
  segment: WorkSegmentDetail;
  disabled: boolean;
  onRun: (
    action: () => Promise<ProjectManagementActionResult<unknown>>,
    successMessage: string,
  ) => void;
}) {
  if (
    segment.type !== "PLANNED" ||
    segment.status === "CONFIRMED" ||
    segment.status === "CANCELLED"
  ) {
    return null;
  }
  return (
    <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          onRun(
            () =>
              confirmPlannedSegment({
                segmentId: segment.id,
                expectedUpdatedAt: segment.updatedAt,
                reason: "资源时间轴确认计划",
              }),
            "已按计划生成 Actual",
          )
        }
      >
        <Check className="h-4 w-4" aria-hidden="true" />
        与计划一致
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          onRun(
            () =>
              partiallyConfirmSegment({
                segmentId: segment.id,
                expectedUpdatedAt: segment.updatedAt,
                coveredStartAt: segment.startAt,
                coveredEndAt: midpointIso(segment),
                reason: "资源时间轴部分确认",
              }),
            "已部分确认并保留剩余计划",
          )
        }
      >
        <Split className="h-4 w-4" aria-hidden="true" />
        部分确认
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          onRun(
            () =>
              splitPlannedSegment({
                segmentId: segment.id,
                expectedUpdatedAt: segment.updatedAt,
                reason: "资源时间轴拆分计划",
                parts: [
                  { startAt: segment.startAt, endAt: midpointIso(segment) },
                  { startAt: midpointIso(segment), endAt: segment.endAt },
                ],
              }),
            "已拆分计划",
          )
        }
      >
        <Scissors className="h-4 w-4" aria-hidden="true" />
        拆分
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          onRun(
            () =>
              movePlannedSegments({
                moves: [
                  {
                    segmentId: segment.id,
                    expectedUpdatedAt: segment.updatedAt,
                    startAt: shiftIso(segment.startAt, 60),
                    endAt: shiftIso(segment.endAt, 60),
                  },
                ],
                reason: "资源时间轴顺延计划",
              }),
            "已顺延计划",
          )
        }
      >
        <MoveRight className="h-4 w-4" aria-hidden="true" />
        顺延 1 小时
      </Button>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={disabled}
        onClick={() =>
          onRun(
            () =>
              cancelPlannedSegment({
                segmentId: segment.id,
                expectedUpdatedAt: segment.updatedAt,
                reason: "资源时间轴取消计划",
              }),
            "已取消计划",
          )
        }
      >
        <X className="h-4 w-4" aria-hidden="true" />
        取消
      </Button>
    </div>
  );
}

function localDateTimeToIso(value: string) {
  return shanghaiDateTimeLocalToIso(value);
}

function toDateTimeLocal(value: string) {
  return isoToShanghaiDateTimeLocal(value);
}

function midpointIso(segment: WorkSegmentDetail) {
  const start = new Date(segment.startAt).getTime();
  const end = new Date(segment.endAt).getTime();
  return new Date(start + Math.floor((end - start) / 2)).toISOString();
}

function shiftIso(value: string, minutes: number) {
  return new Date(new Date(value).getTime() + minutes * 60 * 1000).toISOString();
}
