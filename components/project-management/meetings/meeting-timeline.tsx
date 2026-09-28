"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getMeetingTimelineAction } from "@/app/actions/project-management/meetings";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import { contentTimeBounds } from "@/components/project-management/time-canvas/time-math";
import { resolveContentNavigationWindow } from "@/lib/project-management/time-canvas/content-window";
import type { TimeCanvasModel } from "@/components/project-management/time-canvas/types";
import { Button } from "@/components/ui/button";
import type { MeetingTimelineInput } from "@/lib/project-management/meetings/validation";

export function MeetingTimeline({ source }: { source: MeetingTimelineInput }) {
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState("");
  const pendingMutation = useRef<{ message: string; segmentId: string | null; deleted: boolean } | null>(null);
  const [result, setResult] = useState<{ model?: TimeCanvasModel; display?: { projects: { id: string; name: string }[]; tasks: { id: string; title: string }[]; unavailableProjectCount: number; unavailableTaskCount: number }; error?: string; key: string } | null>(null);
  const queryKey = JSON.stringify(source);
  const loadKey = `${queryKey}:${revision}`;
  const current = result?.key === loadKey ? result : null;

  useEffect(() => {
    let canceled = false;
    getMeetingTimelineAction(JSON.parse(queryKey)).then((response) => {
      if (canceled) return;
      if (!response.ok) {
        setResult({ key: loadKey, error: response.error.message });
        return;
      }
      const model = timeCanvasDataToModel(response.data, "RESOURCE_PLANNER");
      const businessContentRange = contentTimeBounds([
        model.range.startMs, model.range.endMs - 1,
        ...model.anchors.map((anchor) => anchor.atMs),
      ]) ?? model.range;
      const contentRange = contentTimeBounds([
        businessContentRange.startMs, businessContentRange.endMs - 1,
        ...(model.globalMarkers ?? []).map((marker) => marker.atMs),
      ]);
      const navigation = resolveContentNavigationWindow({ contentRange, businessContentRange,
        preferredCenterMs: (model.range.startMs + model.range.endMs) / 2 });
      Object.assign(model, { range: navigation.range, fullRange: navigation.fullRange,
        contentRange, rangeClipped: navigation.rangeClipped, loadedRanges: [navigation.fullRange] });
      const mutation = pendingMutation.current;
      if (mutation) {
        pendingMutation.current = null;
        const noLongerVisible = mutation.segmentId && !mutation.deleted &&
          !model.segments.some((segment) => segment.id === mutation.segmentId);
        setStatus(noLongerVisible
          ? `${mutation.message}；记录已保存，但不在此会议时间线内。`
          : mutation.message);
      }
      setResult({ key: loadKey, model, display: response.data.display });
    }).catch(() => {
      if (!canceled) setResult({ key: loadKey, error: "时间线加载失败，请检查网络后重试" });
    });
    return () => { canceled = true; };
  }, [queryKey, loadKey]);
  useEffect(() => {
    if (editing) return;
    const timer = window.setInterval(() => setRevision((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [editing]);

  const refresh = useCallback(() => {
    if (editing && !window.confirm("当前投入可能有未保存修改，确认放弃并刷新时间线？")) return;
    setEditing(false);
    setRevision((value) => value + 1);
  }, [editing]);
  const onMutationSuccess = useCallback((message: string, result: unknown) => {
    const segment = result && typeof result === "object" && "segment" in result
      ? result.segment : null;
    const segmentId = segment && typeof segment === "object" && "id" in segment &&
      typeof segment.id === "string" ? segment.id : null;
    const deleted = Boolean(segment && typeof segment === "object" && "deletedAt" in segment && segment.deletedAt);
    pendingMutation.current = { message, segmentId, deleted };
    setEditing(false);
    setRevision((value) => value + 1);
  }, []);
  const ownRow = current?.model?.rows.find((row) => row.kind === "PERSON" && row.editable);
  const canManage = source.kind === "SAVED";

  return <section className="min-w-0 space-y-3" aria-label="会议工作时间线">
    {current?.display && <div className="space-y-1 break-words text-sm" data-testid="meeting-display-summary">
      {current.display.projects.length > 0 && <p>展示项目：{current.display.projects.map((project) => project.name).join("、")}</p>}
      {current.display.tasks.length > 0 && <p>展示任务：{current.display.tasks.map((task) => task.title).join("、")}</p>}
      {(current.display.unavailableProjectCount > 0 || current.display.unavailableTaskCount > 0) && <p role="status">有 {current.display.unavailableProjectCount} 个项目、{current.display.unavailableTaskCount} 个任务已不可用，管理员可在编辑会议时移除；其他时间线正常展示。</p>}
    </div>}
    <p className="text-sm text-muted-foreground">时间线展示当前工作记录，非会议保存时快照。{canManage ? "在职人员可修改和删除本人显示的投入；参会者还可新增本人投入。" : "预览中的工作记录只读。"}</p>
    {status && <p role="status" className="text-sm">{status}</p>}
    {!current && <p role="status">正在加载工作时间线…</p>}
    {current?.error && <div className="space-y-2">
      <p role="alert" className="break-words text-sm text-destructive">{current.error}</p>
      <Button type="button" variant="outline" onClick={refresh}>刷新时间线</Button>
    </div>}
    {current?.model && <div className="min-w-0 overflow-hidden" data-testid="meeting-timeline">
      <ResourcePlannerCanvasClient key={loadKey} mode="PERSONAL_TIMELINE" initialModel={current.model}
        peopleOptions={[]} taskOptions={[]} defaultPersonId={ownRow?.sourceId ?? ""}
        allowCreate={canManage && Boolean(ownRow)} allowIndependent={canManage} readOnly={!canManage}
        fixedCreatePerson={ownRow ? { id: ownRow.sourceId, displayName: ownRow.label } : undefined}
        keepCanvasRangeOnCreate showAnchorInspector onEditingStateChange={setEditing}
        onMutationSuccess={canManage ? onMutationSuccess : undefined}
        initialCenterMs={(Date.parse(source.rangeStart) + Date.parse(source.rangeEnd)) / 2}
        highlightedRange={{ startMs: Date.parse(source.rangeStart), endMs: Date.parse(source.rangeEnd) }}
        toolbarAction={<Button type="button" variant="outline" disabled={!current} onClick={refresh}>刷新时间线</Button>} />
    </div>}
  </section>;
}
