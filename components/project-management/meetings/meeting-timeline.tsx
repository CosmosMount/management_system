"use client";

import { useEffect, useState } from "react";
import { getMeetingTimelineAction } from "@/app/actions/project-management/meetings";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import type { TimeCanvasModel } from "@/components/project-management/time-canvas/types";
import { Button } from "@/components/ui/button";
import type { MeetingTimelineInput } from "@/lib/project-management/meetings/validation";

export function MeetingTimeline({ source }: { source: MeetingTimelineInput }) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ model?: TimeCanvasModel; error?: string; key: string } | null>(null);
  const queryKey = JSON.stringify(source);
  const loadKey = `${queryKey}:${revision}`;
  const current = result?.key === loadKey ? result : null;

  useEffect(() => {
    let canceled = false;
    getMeetingTimelineAction(JSON.parse(queryKey)).then((response) => {
      if (canceled) return;
      setResult(response.ok
        ? { key: loadKey, model: timeCanvasDataToModel(response.data, "PERSONAL_TIMELINE") }
        : { key: loadKey, error: response.error.message });
    }).catch(() => {
      if (!canceled) setResult({ key: loadKey, error: "时间线加载失败，请检查网络后重试" });
    });
    return () => { canceled = true; };
  }, [queryKey, loadKey]);

  return <section className="min-w-0 space-y-3" aria-label="会议工作时间线">
    <p className="text-sm text-muted-foreground">时间线展示当前工作记录，非会议保存时快照。所有人看到相同内容，不能在此修改工作记录。</p>
    <Button type="button" variant="outline" disabled={!current} onClick={() => setRevision((value) => value + 1)}>刷新时间线</Button>
    {!current && <p role="status">正在加载工作时间线…</p>}
    {current?.error && <p role="alert" className="break-words text-sm text-destructive">{current.error}</p>}
    {current?.model && <div className="min-w-0 overflow-hidden rounded-lg border" data-testid="meeting-timeline">
      <TimeCanvas key={loadKey} mode="PERSONAL_TIMELINE" model={current.model}
        initialCenterMs={(current.model.range.startMs + current.model.range.endMs) / 2}
        initialZoom="MONTH" navigationRange={current.model.range}
        emptyMessage="所选参与人在此区间暂无工作记录" />
    </div>}
  </section>;
}
