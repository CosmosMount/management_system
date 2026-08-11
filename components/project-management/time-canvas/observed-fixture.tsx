"use client";

import { useState } from "react";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import type {
  TimeCanvasMode,
  TimeCanvasModel,
  TimeCanvasRange,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";

export function ObservedTimeCanvasFixture({
  mode,
  model,
  initialZoom,
}: {
  mode: TimeCanvasMode;
  model: TimeCanvasModel;
  initialZoom?: TimeCanvasZoom;
}) {
  const [viewport, setViewport] = useState<TimeCanvasRange | null>(null);
  return (
    <>
      <output
        className="sr-only"
        data-testid="time-canvas-observed-viewport"
        data-start-ms={viewport?.startMs}
        data-end-ms={viewport?.endMs}
      >
        {viewport ? `${viewport.startMs}:${viewport.endMs}` : "pending"}
      </output>
      <TimeCanvas
        mode={mode}
        model={model}
        initialZoom={initialZoom}
        initialCenterMs={model.range.startMs}
        display={{
          showActual: true,
          showBusy: true,
          showInspector: true,
        }}
        emptyMessage="受控空数据验收状态"
        onViewportChange={setViewport}
      />
    </>
  );
}
