"use client";

import { useEffect, useState } from "react";
import { getMeetingTimelineAction } from "@/app/actions/project-management/meetings";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import { chooseFitZoom, DAY_MS, fitTimeRange } from "@/components/project-management/time-canvas/time-math";
import type { TimeCanvasModel } from "@/components/project-management/time-canvas/types";
import { Button } from "@/components/ui/button";
import type { MeetingTimelineInput } from "@/lib/project-management/meetings/validation";

export function MeetingTimeline({ source }: { source: MeetingTimelineInput }) {
  const [revision, setRevision] = useState(0);
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
      model.range = fitTimeRange([
        model.range.startMs, model.range.endMs,
        ...model.anchors.map((anchor) => anchor.atMs),
      ], model.range, { minimumDurationMs: 7 * DAY_MS });
      setResult({ key: loadKey, model, display: response.data.display });
    }).catch(() => {
      if (!canceled) setResult({ key: loadKey, error: "时间线加载失败，请检查网络后重试" });
    });
    return () => { canceled = true; };
  }, [queryKey, loadKey]);

  return <section className="min-w-0 space-y-3" aria-label="会议工作时间线">
    {current?.display && <div className="space-y-1 break-words text-sm" data-testid="meeting-display-summary">
      {current.display.projects.length > 0 && <p>展示项目：{current.display.projects.map((project) => project.name).join("、")}</p>}
      {current.display.tasks.length > 0 && <p>展示任务：{current.display.tasks.map((task) => task.title).join("、")}</p>}
      {(current.display.unavailableProjectCount > 0 || current.display.unavailableTaskCount > 0) && <p role="status">有 {current.display.unavailableProjectCount} 个项目、{current.display.unavailableTaskCount} 个任务已不可用，管理员可在编辑会议时移除；其他时间线正常展示。</p>}
    </div>}
    <p className="text-sm text-muted-foreground">时间线展示当前工作记录，非会议保存时快照。所有人看到相同内容，不能在此修改工作记录。</p>
    <Button type="button" variant="outline" disabled={!current} onClick={() => setRevision((value) => value + 1)}>刷新时间线</Button>
    {!current && <p role="status">正在加载工作时间线…</p>}
    {current?.error && <p role="alert" className="break-words text-sm text-destructive">{current.error}</p>}
    {current?.model && <div className="min-w-0 overflow-hidden rounded-lg border" data-testid="meeting-timeline">
      <TimeCanvas key={loadKey} mode="PERSONAL_TIMELINE" model={current.model}
        initialCenterMs={(current.model.range.startMs + current.model.range.endMs) / 2}
        initialZoom={chooseFitZoom(current.model.range)} navigationRange={current.model.range}
        emptyMessage="所选参与人在此区间暂无工作记录" />
    </div>}
  </section>;
}
