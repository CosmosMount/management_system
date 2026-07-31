"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Eye, Lightbulb, PauseCircle } from "lucide-react";
import {
  acknowledgeConflict,
  applyConflictSuggestion,
  ignoreConflict,
  previewConflictSuggestion,
  resolveConflict,
} from "@/app/actions/project-management/conflicts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { formatShanghaiDate } from "@/components/project-management/time-canvas/url-state";
import type { ProjectManagementActionResult } from "@/lib/project-management/application/action-result";
import type { ConflictSuggestionPreview } from "@/lib/project-management/application/conflict-service";
import {
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "@/lib/project-management/date-time";
import {
  conflictKindLabels,
  conflictSeverityLabels,
  conflictStatusLabels,
  formatDateTime,
  workSegmentStatusLabels,
} from "@/lib/project-management/labels";
import type { ResourceConflictDetail } from "@/lib/project-management/queries/resource-queries";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type ConflictCenterClientProps = {
  conflicts: ResourceConflictDetail[];
  selectedConflict: ResourceConflictDetail | null;
  status: string;
};

type MutationState = {
  kind: "idle" | "success" | "error";
  message: string;
};

export function ConflictCenterClient({
  conflicts,
  selectedConflict,
  status,
}: ConflictCenterClientProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<MutationState>({
    kind: "idle",
    message: "",
  });
  const [preview, setPreview] = useState<ConflictSuggestionPreview | null>(null);
  const [confirmedProposalId, setConfirmedProposalId] = useState<string | null>(null);

  function runMutation(
    action: () => Promise<ProjectManagementActionResult<unknown>>,
    successMessage: string,
  ) {
    setState({ kind: "idle", message: "" });
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          setState({ kind: "success", message: successMessage });
          setPreview(null);
          setConfirmedProposalId(null);
          router.refresh();
          return;
        }
        setState({ kind: "error", message: result.error.message });
      } catch {
        setState({ kind: "error", message: "网络异常，操作未完成，请刷新后重试。" });
      }
    });
  }

  function runPreview(conflictId: string) {
    setState({ kind: "idle", message: "" });
    startTransition(async () => {
      try {
        const result = await previewConflictSuggestion({ conflictId });
        if (result.ok) {
          setPreview(result.data);
          setConfirmedProposalId(null);
          setState({
            kind: "success",
            message:
              result.data.suggestions.length > 0
                ? "已生成只读处理建议；尚未写入任何变更"
                : "当前冲突没有可自动生成的建议",
          });
          return;
        }
        setState({ kind: "error", message: result.error.message });
      } catch {
        setState({ kind: "error", message: "建议预览加载失败，请稍后重试。" });
      }
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(280px,380px)_1fr]">
      <div className="space-y-3">
        {conflicts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            当前筛选条件下没有资源冲突。
          </div>
        ) : (
          conflicts.map((conflict) => (
            <Link
              key={conflict.id}
              href={`${routes.progress.conflicts}?status=${encodeURIComponent(status)}&conflictId=${conflict.id}`}
              className={cn(
                "block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40",
                selectedConflict?.id === conflict.id && "border-primary/60",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-medium">
                    {conflictKindLabels[conflict.kind]}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {conflict.personName} · {formatDateTime(conflict.startAt)} -{" "}
                    {formatDateTime(conflict.endAt)}
                  </p>
                </div>
                <Badge variant={conflict.status === "RESOLVED" ? "secondary" : "outline"}>
                  {conflictStatusLabels[conflict.status]}
                </Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge variant="secondary">
                  {conflictSeverityLabels[conflict.severity]}
                </Badge>
                <Badge variant="outline">{conflict.segments.length} 条可见记录</Badge>
                {conflict.hiddenSegmentCount > 0 && (
                  <Badge variant="outline">另有 {conflict.hiddenSegmentCount} 条受限记录</Badge>
                )}
              </div>
            </Link>
          ))
        )}
      </div>

      <section className="min-w-0 rounded-lg border border-border bg-card p-4">
        {!selectedConflict ? (
          <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            选择左侧冲突查看详情。
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">
                  {conflictKindLabels[selectedConflict.kind]}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedConflict.personName} ·{" "}
                  {formatDateTime(selectedConflict.startAt)} -{" "}
                  {formatDateTime(selectedConflict.endAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge>{conflictSeverityLabels[selectedConflict.severity]}</Badge>
                <Badge variant="outline">
                  {conflictStatusLabels[selectedConflict.status]}
                </Badge>
                <Link
                  className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-muted"
                  href={resourcePlannerLink(selectedConflict)}
                >
                  在资源计划中定位
                </Link>
              </div>
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

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {selectedConflict.segments.map((segment) => (
                <div
                  key={segment.id}
                  className="rounded-lg border border-border bg-background p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium">{segment.content}</p>
                    <Badge variant="secondary">
                      {workSegmentStatusLabels[segment.status]}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {segment.task?.title ?? "未关联 Task"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatDateTime(segment.startAt)} -{" "}
                    {formatDateTime(segment.endAt)}
                  </p>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-border bg-background p-3">
              <h3 className="font-medium">解释</h3>
              <StructuredExplanation value={selectedConflict.explanation} />
            </div>

            <div className="grid gap-3 xl:grid-cols-2">
              {selectedConflict.capabilities.canAcknowledge && <form
                className="rounded-lg border border-border bg-background p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  runMutation(
                    () =>
                      acknowledgeConflict({
                        conflictId: selectedConflict.id,
                        note: String(form.get("note") ?? ""),
                      }),
                    "已确认知晓该冲突",
                  );
                }}
              >
                <label className="text-sm font-medium" htmlFor="ack-note">
                  确认说明
                </label>
                <Input id="ack-note" name="note" className="mt-2" />
                <Button className="mt-3" type="submit" variant="outline" disabled={isPending}>
                  <Eye className="h-4 w-4" aria-hidden="true" />
                  确认已知
                </Button>
              </form>}

              {selectedConflict.capabilities.canResolve && <form
                className="rounded-lg border border-border bg-background p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  runMutation(
                    () =>
                      resolveConflict({
                        conflictId: selectedConflict.id,
                        resolutionNote: String(form.get("resolutionNote") ?? ""),
                        changedSegmentIds: selectedConflict.segments.map(
                          (segment) => segment.id,
                        ),
                      }),
                    "已标记冲突解决",
                  );
                }}
              >
                <label className="text-sm font-medium" htmlFor="resolution-note">
                  解决说明
                </label>
                <Textarea
                  id="resolution-note"
                  name="resolutionNote"
                  className="mt-2"
                  defaultValue="已人工调整并确认冲突解除"
                  required
                />
                <Button className="mt-3" type="submit" disabled={isPending}>
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  标记解决
                </Button>
              </form>}

              {selectedConflict.capabilities.canIgnore && <form
                className="rounded-lg border border-border bg-background p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  runMutation(
                    () =>
                      ignoreConflict({
                        conflictId: selectedConflict.id,
                        reason: String(form.get("reason") ?? ""),
                        ignoredUntil: localDateTimeToIso(
                          String(form.get("ignoredUntil") ?? ""),
                        ),
                      }),
                    "已忽略该冲突",
                  );
                }}
              >
                <label className="text-sm font-medium" htmlFor="ignore-reason">
                  忽略原因
                </label>
                <Input
                  id="ignore-reason"
                  name="reason"
                  className="mt-2"
                  defaultValue="短期接受资源风险"
                  required
                />
                <label
                  className="mt-3 block text-sm font-medium"
                  htmlFor="ignored-until"
                >
                  忽略至
                </label>
                <Input
                  id="ignored-until"
                  name="ignoredUntil"
                  type="datetime-local"
                  className="mt-2"
                  defaultValue={toDateTimeLocal(defaultIgnoreUntil())}
                  required
                />
                <Button className="mt-3" type="submit" variant="outline" disabled={isPending}>
                  <PauseCircle className="h-4 w-4" aria-hidden="true" />
                  忽略
                </Button>
              </form>}

              {selectedConflict.capabilities.canPreviewSuggestion && <div className="rounded-lg border border-border bg-background p-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => runPreview(selectedConflict.id)}
                >
                  <Lightbulb className="h-4 w-4" aria-hidden="true" />
                  生成建议
                </Button>
                {preview?.suggestions.map((suggestion) => (
                  <div key={suggestion.proposalId} className="mt-3 space-y-2">
                    <p className="font-medium">{suggestion.title}</p>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {suggestion.moves.map((move) => (
                        <li key={move.segmentId}>
                          {move.segmentId.slice(0, 8)} ·{" "}
                          {formatDateTime(move.startAt)} -{" "}
                          {formatDateTime(move.endAt)}
                        </li>
                      ))}
                    </ul>
                    <label className="flex items-start gap-2 rounded-lg border border-border p-2 text-sm">
                      <input
                        type="checkbox"
                        checked={confirmedProposalId === suggestion.proposalId}
                        onChange={(event) => setConfirmedProposalId(event.target.checked ? suggestion.proposalId : null)}
                      />
                      我确认按以上最新版本令牌应用建议；如 Segment 已变化，服务端必须拒绝。
                    </label>
                    <Button
                      type="button"
                      disabled={
                        isPending ||
                        suggestion.moves.length === 0 ||
                        !selectedConflict.capabilities.canApplySuggestion ||
                        confirmedProposalId !== suggestion.proposalId
                      }
                      onClick={() =>
                        runMutation(
                          () =>
                            applyConflictSuggestion({
                              conflictId: selectedConflict.id,
                              confirmApply: true,
                              proposal: suggestion,
                            }),
                          "已应用处理建议",
                        )
                      }
                    >
                      应用建议
                    </Button>
                  </div>
                ))}
              </div>}
            </div>
            {!Object.values(selectedConflict.capabilities).some(Boolean) && (
              <p className="rounded-lg border border-border bg-muted p-3 text-sm text-muted-foreground">
                当前账号只能查看该冲突，不能确认、解决、忽略或生成建议。
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function resourcePlannerLink(conflict: ResourceConflictDetail) {
  const params = new URLSearchParams({
    from: formatShanghaiDate(Date.parse(conflict.startAt)),
    to: formatShanghaiDate(Date.parse(conflict.endAt) + 24 * 60 * 60 * 1_000),
    people: conflict.personId,
    group: "person",
    zoom: "hour",
    conflict: "open",
    focus: conflict.id,
  });
  return `${routes.progress.resources}?${params.toString()}`;
}

function StructuredExplanation({ value }: { value: unknown }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return <p className="mt-2 text-sm text-muted-foreground">{formatExplanationValue(value)}</p>;
  }
  return (
    <dl className="mt-2 grid gap-2 rounded-lg bg-muted p-3 text-sm sm:grid-cols-2">
      {Object.entries(value as Record<string, unknown>).slice(0, 50).map(([key, child]) => (
        <div key={key} className="min-w-0 rounded bg-background/70 p-2">
          <dt className="font-medium">{explanationLabel(key)}</dt>
          <dd className="mt-1 break-words text-muted-foreground">{formatExplanationValue(child, key)}</dd>
        </div>
      ))}
    </dl>
  );
}

function explanationLabel(key: string) {
  const labels: Record<string, string> = {
    message: "规则说明",
    reason: "原因",
    totalAllocation: "总投入比例",
    segmentIds: "相关记录",
    changedSegmentIds: "已调整记录",
    missingAllocationSegmentIds: "未填写投入比例的记录",
    hiddenSegmentCount: "受限记录数量",
    ignoredReason: "忽略原因",
    ignoredUntil: "忽略至",
    resolutionNote: "解决说明",
  };
  return labels[key] ?? key.replaceAll(/([A-Z])/g, " $1").trim();
}

function formatExplanationValue(value: unknown, key = ""): string {
  if (value === null || value === undefined || value === "") return "未提供";
  if (Array.isArray(value)) {
    if (key.toLowerCase().includes("id")) return `${value.length} 条记录`;
    return value.slice(0, 20).map((item) => formatExplanationValue(item)).join("；") || "无";
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 20)
      .map(([childKey, child]) => `${explanationLabel(childKey)}：${formatExplanationValue(child, childKey)}`)
      .join("；");
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function localDateTimeToIso(value: string) {
  return shanghaiDateTimeLocalToIso(value);
}

function toDateTimeLocal(value: string | Date) {
  return isoToShanghaiDateTimeLocal(value);
}

function defaultIgnoreUntil() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000);
}
