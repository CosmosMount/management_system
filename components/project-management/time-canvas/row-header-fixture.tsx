"use client";

import { useState } from "react";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import type {
  TimeCanvasModel,
  TimeCanvasRange,
} from "@/components/project-management/time-canvas/types";

export function RowHeaderTimeCanvasFixture({ model }: { model: TimeCanvasModel }) {
  const [viewport, setViewport] = useState<TimeCanvasRange | null>(null);
  const [navigation, setNavigation] = useState({ count: 0, rowId: "", href: "" });

  return (
    <>
      <output
        className="sr-only"
        data-testid="time-canvas-row-header-fixture-state"
        data-ready={viewport !== null}
        data-navigation-count={navigation.count}
        data-row-id={navigation.rowId}
        data-href={navigation.href}
      >
        {navigation.count ? "已取消表头导航" : "等待表头导航"}
      </output>
      <TimeCanvas
        mode="RESOURCE_PLANNER"
        model={model}
        initialCenterMs={model.range.startMs}
        onViewportChange={setViewport}
        interaction={{
          onRowNavigation: (row) => {
            setNavigation((previous) => ({
              count: previous.count + 1,
              rowId: row.id,
              href: row.href ?? "",
            }));
            return false;
          },
        }}
      />
    </>
  );
}
