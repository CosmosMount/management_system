import type {
  TimeCanvasAnchor,
  TimeCanvasPhaseBand,
  TimeCanvasTone,
} from "@/components/project-management/time-canvas/types";

const planPhaseTones: TimeCanvasTone[] = [
  "BLUE",
  "VIOLET",
  "AMBER",
  "EMERALD",
  "ROSE",
  "SLATE",
];

export function buildPlanPhaseBands(
  anchors: TimeCanvasAnchor[],
  rowId: string,
): TimeCanvasPhaseBand[] {
  const boundaries = [...anchors]
    .filter((anchor) => anchor.kind !== "REVISION")
    .sort(
      (left, right) =>
        left.atMs - right.atMs ||
        left.sequence - right.sequence ||
        left.id.localeCompare(right.id),
    );

  return boundaries.slice(0, -1).flatMap((anchor, index) => {
    const next = boundaries[index + 1];
    if (!next || next.atMs <= anchor.atMs) return [];
    return [{
      id: `${anchor.id}:${next.id}`,
      rowId,
      startMs: anchor.atMs,
      endMs: next.atMs,
      label: next.label,
      tone: planPhaseTones[index % planPhaseTones.length] ?? "BLUE",
      visualState:
        anchor.visualState === "TEMPORARY" || next.visualState === "TEMPORARY"
          ? ("TEMPORARY" as const)
          : undefined,
    }];
  });
}

export function findPhaseEndpointAnchor(
  anchors: TimeCanvasAnchor[],
  endMs: number,
): TimeCanvasAnchor | undefined {
  return anchors.find(
    (anchor) => anchor.atMs === endMs && anchor.kind !== "REVISION",
  );
}
