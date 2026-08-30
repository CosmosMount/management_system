import {
  DAY_MS,
  createTimeScale,
  intervalToRect,
  rangesIntersect,
  timeToX,
} from "@/components/project-management/time-canvas/time-math";
import {
  buildPlanPhaseBands,
  findPhaseEndpointAnchor,
} from "@/components/project-management/time-canvas/plan-phase-bands";
import type {
  TimeCanvasAnchor,
  TimeCanvasPhaseBand,
} from "@/components/project-management/time-canvas/types";
import {
  formatCanvasRange as formatRange,
  isShanghaiWeekend,
} from "@/components/project-management/time-canvas/time-format";
import { PLAN_RAIL_TOP } from "@/components/project-management/time-canvas/time-canvas-layout";
import { cn } from "@/lib/utils";

export function TimeGrid({
  dayStripes,
  scale,
}: {
  dayStripes: number[];
  scale: ReturnType<typeof createTimeScale>;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
      data-testid="time-canvas-time-grid"
    >
      {dayStripes.map((day) => {
        const next = day + DAY_MS;
        const rect = intervalToRect(day, next, scale);
        const weekend = isShanghaiWeekend(day);
        return (
          <span
            key={day}
            className={cn(
              "absolute inset-y-0 border-l border-border/50",
              weekend && "bg-muted/35",
            )}
            style={{ left: rect.left, width: rect.width }}
          />
        );
      })}
    </div>
  );
}

export function PlanRail({
  anchors,
  phaseBands,
  viewportWindow,
  scale,
  rowId,
  selectedAnchorId,
  onSelectAnchor,
}: {
  anchors: TimeCanvasAnchor[];
  phaseBands: TimeCanvasPhaseBand[];
  viewportWindow: { startMs: number; endMs: number };
  scale: ReturnType<typeof createTimeScale>;
  rowId: string;
  selectedAnchorId: string | null;
  onSelectAnchor: (anchorId: string) => void;
}) {
  if (phaseBands.length > 0) {
    return (
      <PhaseBands
        bands={phaseBands}
        viewportWindow={viewportWindow}
        scale={scale}
        rowId={rowId}
        anchors={anchors}
        selectedAnchorId={selectedAnchorId}
        onSelectAnchor={onSelectAnchor}
      />
    );
  }
  const sorted = [...anchors].sort(
    (left, right) =>
      left.atMs - right.atMs ||
      left.sequence - right.sequence ||
      left.id.localeCompare(right.id),
  );
  const generatedBands = buildPlanPhaseBands(sorted, rowId);
  return (
    <PhaseBands
      bands={generatedBands}
      viewportWindow={viewportWindow}
      scale={scale}
      rowId={rowId}
      anchors={sorted}
      selectedAnchorId={selectedAnchorId}
      onSelectAnchor={onSelectAnchor}
    />
  );
}

function PhaseBands({
  bands,
  viewportWindow,
  scale,
  rowId,
  anchors,
  selectedAnchorId,
  onSelectAnchor,
}: {
  bands: TimeCanvasPhaseBand[];
  viewportWindow: { startMs: number; endMs: number };
  scale: ReturnType<typeof createTimeScale>;
  rowId: string;
  anchors: TimeCanvasAnchor[];
  selectedAnchorId: string | null;
  onSelectAnchor: (anchorId: string) => void;
}) {
  const visibleBands = bands.filter(
    (band) =>
      band.endMs > band.startMs && rangesIntersect(band, viewportWindow),
  );
  if (visibleBands.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5]"
      data-testid={`phase-bands-${rowId}`}
    >
      {visibleBands.map((band) => {
        const rect = intervalToRect(
          Math.max(band.startMs, viewportWindow.startMs),
          Math.min(band.endMs, viewportWindow.endMs),
          scale,
        );
        const endpointAnchor = findPhaseEndpointAnchor(anchors, band.endMs);
        const selected = endpointAnchor?.id === selectedAnchorId;
        return (
          <button
            type="button"
            key={band.id}
            className={cn(
              "pointer-events-auto absolute flex h-5 min-w-px items-center justify-center overflow-hidden rounded border px-1.5 text-center text-[10px] font-medium",
              phaseBandToneClassName(band.tone),
              band.visualState === "TEMPORARY" &&
                "border-dashed border-amber-500 bg-amber-100/80 text-amber-950 dark:bg-amber-950/50 dark:text-amber-100",
              selected && "ring-2 ring-inset ring-primary shadow-sm",
            )}
            style={{ left: rect.left, width: rect.width, top: PLAN_RAIL_TOP }}
            aria-label={`阶段 ${band.label}，${formatRange(band.startMs, band.endMs)}`}
            aria-pressed={selected}
            title={`${band.label} · ${formatRange(band.startMs, band.endMs)}`}
            data-testid={`phase-band-${band.id}`}
            data-phase-selected={selected ? "true" : "false"}
            disabled={!endpointAnchor}
            onClick={(event) => {
              event.stopPropagation();
              if (endpointAnchor) onSelectAnchor(endpointAnchor.id);
            }}
          >
            <span className="truncate">
              {band.visualState === "TEMPORARY" ? `临时 · ${band.label}` : band.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function TodayLine({
  scale,
  nowMs,
  axis = false,
  overContent = false,
}: {
  scale: ReturnType<typeof createTimeScale>;
  nowMs: number;
  axis?: boolean;
  overContent?: boolean;
}) {
  if (!Number.isFinite(nowMs) || nowMs < scale.startMs || nowMs >= scale.endMs) return null;
  return (
    <span
      className={cn(
        "pointer-events-none absolute inset-y-0 w-px bg-rose-500",
        axis ? "z-20" : overContent ? "z-[25]" : "z-[5]",
      )}
      style={{ left: timeToX(nowMs, scale) }}
      aria-hidden="true"
      data-testid={axis ? "time-canvas-today-axis" : "time-canvas-today-line"}
    />
  );
}

function phaseBandToneClassName(tone: TimeCanvasPhaseBand["tone"]) {
  if (tone === "BLUE") {
    return "border-blue-500/60 bg-blue-500/15 text-blue-950 dark:text-blue-100";
  }
  if (tone === "VIOLET") {
    return "border-violet-500/60 bg-violet-500/15 text-violet-950 dark:text-violet-100";
  }
  if (tone === "AMBER") {
    return "border-amber-500/60 bg-amber-500/15 text-amber-950 dark:text-amber-100";
  }
  if (tone === "EMERALD") {
    return "border-emerald-500/60 bg-emerald-500/15 text-emerald-950 dark:text-emerald-100";
  }
  if (tone === "ROSE") {
    return "border-rose-500/60 bg-rose-500/15 text-rose-950 dark:text-rose-100";
  }
  return "border-slate-500/60 bg-slate-500/15 text-slate-950 dark:text-slate-100";
}
