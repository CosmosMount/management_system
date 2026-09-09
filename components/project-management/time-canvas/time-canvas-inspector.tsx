"use client";

import { X } from "lucide-react";
import { NodeDeadline } from "@/components/project-management/node-deadline";
import type {
  TimeCanvasAnchor,
  TimeCanvasProps,
  TimeCanvasSegment,
  TimeCanvasSelection,
} from "@/components/project-management/time-canvas/types";
import { Button } from "@/components/ui/button";
import { taskNodeStatusLabels, taskNodeTypeLabels, taskStatusLabels } from "@/lib/project-management/labels";
import {
  formatCanvasDateTime as formatDateTime,
  formatCanvasRange as formatRange,
} from "@/components/project-management/time-canvas/time-format";

export type SelectedEntity =
  | { kind: "ANCHOR"; value: TimeCanvasAnchor }
  | { kind: "SEGMENT"; value: TimeCanvasSegment };

function entityTitle(entity: SelectedEntity) {
  return entity.kind === "ANCHOR" ? entity.value.label : entity.value.title;
}

export function TimeCanvasInspector({
  entity,
  onClose,
  nowMs,
}: {
  entity: SelectedEntity;
  onClose: () => void;
  nowMs?: number;
}) {
  return (
    <aside className="border-t border-border bg-card p-4 md:border-l md:border-t-0" aria-label="时间对象详情" data-testid="time-canvas-inspector">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">只读详情</p>
          <h2 className="mt-1 break-words text-base font-semibold">{entityTitle(entity)}</h2>
        </div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="关闭时间对象详情" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <InspectorBody entity={entity} nowMs={nowMs} />
    </aside>
  );
}

function InspectorBody({ entity, nowMs }: { entity: SelectedEntity; nowMs?: number }) {
  if (entity.kind === "ANCHOR") {
    const statusLabels: Record<string, string> = entity.value.kind === "PLAN_START" ? taskStatusLabels : taskNodeStatusLabels;
    return (
      <dl className="mt-4 grid gap-3 text-sm">
        <Detail label="类型" value={entity.value.kind === "PLAN_START" ? "开始节点" : taskNodeTypeLabels[entity.value.kind]} />
        <Detail label="状态" value={statusLabels[entity.value.status] ?? "未知状态"} />
        <Detail label="计划时间" value={formatDateTime(entity.value.atMs)} />
        {entity.value.currentNodeDeadline && <div><dt className="text-xs text-muted-foreground">节点到期</dt><dd className="mt-1"><NodeDeadline target={entity.value.currentNodeDeadline} nowMs={nowMs} /></dd></div>}
        <Detail label="权限" value={entity.value.editable ? "可编辑" : "只读；修改需按任务生命周期进行"} />
      </dl>
    );
  }
  const segment = entity.value;
  return (
    <dl className="mt-4 grid gap-3 text-sm">
      <Detail label="投入" value={segment.type === "BUSY" ? "其他占用（详情受限）" : "投入记录"} />
      <Detail label="区间" value={formatRange(segment.startMs, segment.endMs)} />
      {segment.visibility === "FULL" && (
        <>
          <Detail label="权限" value={segment.permissions.canEdit ? "可编辑" : "只读"} />
        </>
      )}
    </dl>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words">{value}</dd>
    </div>
  );
}

export function resolveSelection(
  model: TimeCanvasProps["model"],
  selection: TimeCanvasSelection,
): SelectedEntity | null {
  if (!selection) return null;
  if (selection.kind === "ANCHOR") {
    const value = model.anchors.find((anchor) => anchor.id === selection.id);
    return value ? { kind: "ANCHOR", value } : null;
  }
  if (selection.kind === "SEGMENT") {
    const value = model.segments.find((segment) => segment.id === selection.id);
    return value ? { kind: "SEGMENT", value } : null;
  }
  return null;
}
