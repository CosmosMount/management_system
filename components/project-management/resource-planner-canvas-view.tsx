"use client";

import type { ComponentProps } from "react";
import { RefreshCw } from "lucide-react";
import {
  formatPlannerRange,
  QuickCreatePanel,
  SegmentInspector,
} from "@/components/project-management/resource-planner-panels";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import type { TimeCanvasModel } from "@/components/project-management/time-canvas/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FailedBlock } from "@/components/project-management/resource-planner-state";
import { cn } from "@/lib/utils";

export type ResourcePlannerNotice =
  | { kind: "success" | "error" | "info"; message: string }
  | null;

type ResourcePlannerCanvasViewProps = {
  readOnly?: boolean;
  canCreateSegment: boolean;
  createDraftOpen: boolean;
  isPending: boolean;
  canvasModel: TimeCanvasModel;
  failedBlocks: FailedBlock[];
  notice: ResourcePlannerNotice;
  onCreate: () => void;
  onRequestContentCenter: (centerMs: number) => void;
  onRetryFailedBlock: (block: FailedBlock) => void;
  timeCanvasProps: ComponentProps<typeof TimeCanvas>;
  segmentDialog: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    inspectorKey: string;
    inspectorProps: ComponentProps<typeof SegmentInspector>;
  };
  quickCreateProps: ComponentProps<typeof QuickCreatePanel> | null;
};

export function ResourcePlannerCanvasView({
  readOnly = false,
  canCreateSegment,
  createDraftOpen,
  isPending,
  canvasModel,
  failedBlocks,
  notice,
  onCreate,
  onRequestContentCenter,
  onRetryFailedBlock,
  timeCanvasProps,
  segmentDialog,
  quickCreateProps,
}: ResourcePlannerCanvasViewProps) {
  return (
    <div className="space-y-4" data-testid="resource-planner-workbench">
      <div className="flex flex-wrap items-center gap-3 px-1">
        {canCreateSegment && (
          <Button
            type="button"
            size="sm"
            disabled={isPending || createDraftOpen}
            onClick={onCreate}
          >
            新增投入
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {readOnly
            ? "双击投入打开只读详情；此页面不能修改既有投入。"
            : "双击投入打开详情；总览不会直接修改既有投入。"}
        </span>
      </div>

      {canvasModel.rangeClipped && canvasModel.fullRange && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="status"
        >
          <span className="min-w-0 flex-1">
            可导航时间范围超过三个上海日历年，当前显示一个三年窗口。
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => onRequestContentCenter(
              canvasModel.contentRange?.startMs ?? canvasModel.fullRange!.startMs,
            )}
          >
            最早内容
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => onRequestContentCenter(
              (canvasModel.contentRange?.endMs ?? canvasModel.fullRange!.endMs) - 1,
            )}
          >
            最新内容
          </Button>
        </div>
      )}

      {failedBlocks.map((block) => (
        <div
          key={block.key}
          className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          <span className="min-w-0 flex-1 break-words">
            {formatPlannerRange(block.range.startMs, block.range.endMs)}：{block.message}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onRetryFailedBlock(block)}
          >
            <RefreshCw aria-hidden="true" />
            重试
          </Button>
        </div>
      ))}

      {notice && (
        <p
          className={cn(
            "break-words rounded-lg px-3 py-2 text-sm",
            notice.kind === "error" && "bg-destructive/10 text-destructive",
            notice.kind === "success" && "bg-emerald-50 text-emerald-800",
            notice.kind === "info" && "bg-muted text-muted-foreground",
          )}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}

      <div className="min-w-0">
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-background">
          <TimeCanvas {...timeCanvasProps} />
        </div>
      </div>

      <Dialog
        open={segmentDialog.open}
        onOpenChange={segmentDialog.onOpenChange}
      >
        <DialogContent className="max-h-[94dvh] overflow-y-auto sm:max-w-[min(96vw,88rem)]">
          <DialogHeader>
            <DialogTitle>投入详情</DialogTitle>
            <DialogDescription>
              {readOnly
                ? "复用打开前的完整时间线上下文；当前投入与其他对象均为只读。"
                : "复用打开前的完整时间线上下文；仅当前打开的投入可修改，其他对象只读。"}
            </DialogDescription>
          </DialogHeader>
          <SegmentInspector
            key={segmentDialog.inspectorKey}
            {...segmentDialog.inspectorProps}
          />
        </DialogContent>
      </Dialog>

      {quickCreateProps && <QuickCreatePanel {...quickCreateProps} />}
    </div>
  );
}
