import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { timeCanvasDataToModel } from "../components/project-management/time-canvas/adapter";
import {
  TIME_CANVAS_CACHE_LEAF_BLOCK_LIMIT,
  TIME_CANVAS_CACHE_OBJECT_LIMIT,
  mergeTimeCanvasVersionedSegments,
  pruneTimeCanvasBlockCache,
} from "../components/project-management/time-canvas/block-cache";
import {
  beginInFlightBlockRequest,
  settleInFlightBlockRequest,
} from "../components/project-management/resource-planner-state";
import {
  createEmptyTimeCanvasFixture,
  createTimeCanvasFixture,
} from "../components/project-management/time-canvas/fixtures";
import {
  layoutIntervalLanes,
  layoutPointLanes,
  rowHeightForLaneCount,
} from "../components/project-management/time-canvas/lane-layout";
import {
  buildPlanPhaseBands,
  findPhaseEndpointAnchor,
} from "../components/project-management/time-canvas/plan-phase-bands";
import {
  DAY_MS,
  HOUR_MS,
  axisTicks,
  addShanghaiCalendarMonths,
  addShanghaiCalendarYears,
  chooseAdaptiveScale,
  chooseFitZoom,
  contentTimeBounds,
  createTimeScale,
  fitTimeRange,
  padShanghaiCalendarRange,
  scrollLeftForCenter,
  intervalToRect,
  moveTimePoint,
  rangesIntersect,
  snapTime,
  snapTimeInRange,
  timeToX,
  visibleTimeWindow,
  xToTime,
} from "../components/project-management/time-canvas/time-math";
import { timeCanvasDataDtoSchema } from "../lib/project-management/types/time-canvas";
import { getAdaptiveTimeCanvasBlockInputSchema } from "../lib/project-management/validations/time-canvas";
import { prisma } from "../lib/prisma";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

const RANGE = {
  startMs: Date.parse("2026-08-01T00:00:00.000+08:00"),
  endMs: Date.parse("2026-08-31T00:00:00.000+08:00"),
};

test.describe("S3 TimeCanvas pure core", () => {
  test("global marker DTOs adapt to a separate read-only canvas layer", () => {
    const markerId = randomUUID();
    const data = timeCanvasDataDtoSchema.parse({
      scope: { kind: "PERSONAL" },
      timezone: "Asia/Shanghai",
      range: {
        startAt: "2026-08-01T00:00:00.000+08:00",
        endAt: "2026-09-01T00:00:00.000+08:00",
      },
      rowPageKey: "global-marker-fixture",
      groupBy: "PERSON",
      rows: [],
      anchors: [],
      globalMarkers: [{
        id: markerId,
        name: "报名截止",
        markedAt: "2026-08-18T10:30:00.000+08:00",
        updatedAt: "2026-08-16T10:00:00.000+08:00",
        versionToken: "2026-08-16T10:00:00.000+08:00",
      }],
      segments: [],
      generatedAt: "2026-08-16T10:00:00.000+08:00",
    });
    const model = timeCanvasDataToModel(data, "PERSONAL_TIMELINE");
    expect(model.globalMarkers).toEqual([{
      id: markerId,
      label: "报名截止",
      atMs: Date.parse("2026-08-18T10:30:00.000+08:00"),
      editable: false,
      versionToken: "2026-08-16T10:00:00.000+08:00",
    }]);
    expect(model.anchors).toEqual([]);
  });

  test("Revision markers remain visible anchors without splitting plan phases", () => {
    const rowId = "plan:revision-marker";
    const anchor = (
      id: string,
      kind: "PLAN_START" | "MILESTONE" | "REVISION" | "TERMINATION",
      atMs: number,
      sequence: number,
    ) => ({
      id,
      rowId,
      taskId: "task:revision-marker",
      kind,
      status: "ACTIVE",
      label: id,
      atMs,
      sequence,
      editable: false,
      versionToken: "v1",
    });
    const anchors = [
      anchor("start", "PLAN_START", 1, -1),
      anchor("revision-before", "REVISION", 2, 1),
      anchor("revision-same-time", "REVISION", 3, 2),
      anchor("milestone", "MILESTONE", 3, 3),
      anchor("terminal", "TERMINATION", 5, 4),
    ];

    expect(buildPlanPhaseBands(anchors, rowId)).toMatchObject([
      { id: "start:milestone", startMs: 1, endMs: 3 },
      { id: "milestone:terminal", startMs: 3, endMs: 5 },
    ]);
    expect(findPhaseEndpointAnchor(anchors, 3)?.id).toBe("milestone");
  });

  test("time scale round-trips, clips, snaps, fits and preserves half-open boundaries", () => {
    const scale = createTimeScale({
      range: RANGE,
      viewportWidthPx: 400,
      zoom: "WEEK",
    });
    const point = RANGE.startMs + 12.5 * DAY_MS;
    expect(xToTime(timeToX(point, scale), scale)).toBeCloseTo(point, 5);
    expect(snapTime(point + 5 * HOUR_MS, DAY_MS, "floor")).toBe(point - 0.5 * DAY_MS);
    expect(snapTime(point + 5 * HOUR_MS, DAY_MS, "ceil")).toBe(point + 0.5 * DAY_MS);
    expect(
      moveTimePoint({
        atMs: RANGE.startMs + DAY_MS,
        rawDeltaMs: 0.51 * DAY_MS,
        snapMs: DAY_MS,
        range: RANGE,
      }),
    ).toEqual({
      atMs: RANGE.startMs + 2 * DAY_MS,
      deltaMs: DAY_MS,
    });
    expect(
      moveTimePoint({
        atMs: RANGE.startMs,
        rawDeltaMs: -10 * DAY_MS,
        snapMs: DAY_MS,
        range: RANGE,
      }),
    ).toEqual({ atMs: RANGE.startMs, deltaMs: 0 });
    expect(
      moveTimePoint({
        atMs: RANGE.endMs - DAY_MS,
        rawDeltaMs: 10 * DAY_MS,
        snapMs: DAY_MS,
        range: RANGE,
      }),
    ).toEqual({
      atMs: RANGE.endMs - DAY_MS,
      deltaMs: 0,
    });
    expect(
      snapTimeInRange(RANGE.endMs - HOUR_MS, DAY_MS, RANGE),
    ).toBe(RANGE.endMs - DAY_MS);
    expect(
      snapTimeInRange(0, DAY_MS, { startMs: 1, endMs: 2 }),
    ).toBeNull();
    expect(
      intervalToRect(RANGE.startMs - DAY_MS, RANGE.startMs + DAY_MS, scale),
    ).toEqual({ left: 0, width: 40 });
    expect(
      rangesIntersect(
        { startMs: RANGE.startMs, endMs: RANGE.startMs + DAY_MS },
        { startMs: RANGE.startMs + DAY_MS, endMs: RANGE.startMs + 2 * DAY_MS },
      ),
    ).toBe(false);
    expect(
      fitTimeRange([RANGE.startMs + DAY_MS], RANGE, {
        minimumDurationMs: 2 * DAY_MS,
        paddingRatio: 0,
      }),
    ).toEqual({
      startMs: RANGE.startMs - HOUR_MS,
      endMs: RANGE.startMs + 2 * DAY_MS + HOUR_MS,
    });
    expect(chooseFitZoom({ startMs: RANGE.startMs, endMs: RANGE.startMs + 3 * DAY_MS })).toBe("WEEK");
    expect(chooseFitZoom(RANGE)).toBe("WEEK");
    const window = visibleTimeWindow({
      scale,
      scrollLeftPx: 400,
      viewportWidthPx: 400,
      overscanPx: 0,
    });
    expect(window.startMs).toBe(RANGE.startMs + 10 * DAY_MS);
    expect(window.endMs).toBe(RANGE.startMs + 20 * DAY_MS);
    const clampedWindow = visibleTimeWindow({
      scale,
      scrollLeftPx: 999_999,
      viewportWidthPx: 400,
      overscanPx: 0,
    });
    expect(clampedWindow.startMs).toBe(RANGE.startMs + 20 * DAY_MS);
    expect(clampedWindow.endMs).toBe(RANGE.endMs);
    const weekTicks = axisTicks({ window: RANGE, zoom: "WEEK" });
    expect(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Shanghai",
        weekday: "short",
      }).format(new Date(weekTicks.find((tick) =>
        new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).format(new Date(tick)) === "Mon",
      ) ?? weekTicks[0])),
    ).toBe("Mon");
  });

  test("adaptive calendar ranges use Shanghai month boundaries and preserve viewport centers", () => {
    const content = {
      startMs: Date.parse("2026-08-20T10:00:00.000+08:00"),
      endMs: Date.parse("2026-09-10T18:00:00.000+08:00"),
    };
    expect(padShanghaiCalendarRange(content, 2)).toEqual({
      startMs: Date.parse("2026-06-01T00:00:00.000+08:00"),
      endMs: Date.parse("2026-12-01T00:00:00.000+08:00"),
    });
    const exactMonth = contentTimeBounds([
      Date.parse("2026-08-20T10:00:00.000+08:00"),
      Date.parse("2026-10-01T00:00:00.000+08:00") - 1,
    ]);
    expect(padShanghaiCalendarRange(exactMonth, 2)).toEqual({
      startMs: Date.parse("2026-06-01T00:00:00.000+08:00"),
      endMs: Date.parse("2026-12-01T00:00:00.000+08:00"),
    });
    const maximumRange = padShanghaiCalendarRange({
      startMs: Date.parse("9999-12-31T15:59:00.000Z"),
      endMs: Date.parse("9999-12-31T15:59:00.001Z"),
    }, 2);
    expect(new Date(maximumRange.endMs).toISOString()).toBe(
      "9999-12-31T23:59:59.999Z",
    );
    const minimumRange = padShanghaiCalendarRange({
      startMs: Date.parse("0001-01-01T00:00:00.000Z"),
      endMs: Date.parse("0001-01-01T00:00:00.001Z"),
    }, 2);
    expect(new Date(minimumRange.startMs).toISOString()).toBe(
      "0000-10-31T16:00:00.000Z",
    );
    const leapDay = Date.parse("2024-02-29T12:00:00.000+08:00");
    expect(new Date(addShanghaiCalendarYears(leapDay, 1)).toISOString()).toBe(
      "2025-02-28T04:00:00.000Z",
    );
    expect(addShanghaiCalendarMonths(Date.parse("2026-01-01T00:00:00.000+08:00"), 2)).toBe(
      Date.parse("2026-03-01T00:00:00.000+08:00"),
    );
    expect(chooseAdaptiveScale(RANGE, 400)).toBe("WEEK");
    const scale = createTimeScale({ range: RANGE, viewportWidthPx: 400, zoom: "WEEK" });
    const center = RANGE.startMs + 15 * DAY_MS;
    const left = scrollLeftForCenter(scale, center, 400);
    expect(xToTime(left + 200, scale)).toBe(center);
    expect(scale.segmentSnapMs).toBe(30 * 60 * 1_000);
    expect(scale.anchorSnapMs).toBe(DAY_MS);
  });

  test("adaptive block input keeps semantic scopes strict and caps blocks at 366 days", () => {
    const blockStart = "2026-01-01T00:00:00.000+08:00";
    const validMyTimeline = {
      kind: "MY_TIMELINE" as const,
      rowPageKey: "row-page-key",
      preferredCenter: "2026-06-01T00:00:00.000+08:00",
      blockStart,
      blockEnd: "2026-06-30T00:00:00.000+08:00",
      showAll: false,
    };
    expect(getAdaptiveTimeCanvasBlockInputSchema.safeParse(validMyTimeline).success).toBe(true);
    expect(getAdaptiveTimeCanvasBlockInputSchema.safeParse({
      ...validMyTimeline,
      personIds: [uuid(1)],
    }).success).toBe(false);
    expect(getAdaptiveTimeCanvasBlockInputSchema.safeParse({
      ...validMyTimeline,
      blockEnd: "2027-01-03T00:00:00.000+08:00",
    }).success).toBe(false);

    const project = getAdaptiveTimeCanvasBlockInputSchema.parse({
      kind: "PROJECT",
      rowPageKey: "project-row-page-key",
      preferredCenter: "2026-06-01T00:00:00.000+08:00",
      blockStart,
      blockEnd: "2026-06-30T00:00:00.000+08:00",
      projectId: uuid(2),
    });
    expect(project).toMatchObject({
      kind: "PROJECT",
      projectId: uuid(2),
    });
  });

  test("adaptive block cache enforces hard dual budgets and bounded priorities", () => {
    const block = (
      key: string,
      startMs: number,
      endMs: number,
      objectCount: number,
      leafBlockCount = 1,
      pinnedId?: string,
    ) => ({
      key,
      range: { startMs, endMs },
      segments: Array.from({ length: objectCount }, (_, index) => ({
        id: index === 0 && pinnedId ? pinnedId : `${key}-${index}`,
      })),
      touchedAt: startMs,
      leafBlockCount,
    });

    const objectLimited = pruneTimeCanvasBlockCache({
      blocks: [
        block("visible", 0, 180, 15_000),
        block("candidate", 180, 360, 6_000),
      ],
      viewport: { startMs: 100, endMs: 200 },
      pinnedIds: [],
      candidateKey: "candidate",
    });
    expect(objectLimited.objectCount).toBeLessThanOrEqual(
      TIME_CANVAS_CACHE_OBJECT_LIMIT,
    );
    expect(objectLimited.leafBlockCount).toBeLessThanOrEqual(
      TIME_CANVAS_CACHE_LEAF_BLOCK_LIMIT,
    );
    expect(objectLimited.candidateAccepted).toBe(false);
    expect(objectLimited.blocks.map((item) => item.key)).toEqual(["visible"]);

    const candidateBecomesVisible = pruneTimeCanvasBlockCache({
      blocks: [
        block("old", 0, 180, 15_000),
        block("candidate", 180, 360, 6_000),
      ],
      viewport: { startMs: 200, endMs: 300 },
      pinnedIds: [],
      candidateKey: "candidate",
    });
    expect(candidateBecomesVisible.candidateAccepted).toBe(true);
    expect(candidateBecomesVisible.blocks.map((item) => item.key)).toEqual([
      "candidate",
    ]);

    const leafLimited = pruneTimeCanvasBlockCache({
      blocks: [
        block("visible", 0, 180, 1, 16),
        block("candidate", 180, 360, 1, 1),
      ],
      viewport: { startMs: 100, endMs: 200 },
      pinnedIds: [],
      candidateKey: "candidate",
    });
    expect(leafLimited.leafBlockCount).toBe(16);
    expect(leafLimited.candidateAccepted).toBe(false);

    const prioritized = pruneTimeCanvasBlockCache({
      blocks: [
        block("visible", 100, 200, 12_000),
        block("before", 0, 100, 3_000),
        block("after", 200, 300, 3_000),
        block("unrelated", 400, 500, 1_000),
        block("pinned", 500, 600, 2_000, 1, "selected-segment"),
      ],
      viewport: { startMs: 100, endMs: 200 },
      pinnedIds: ["selected-segment"],
      candidateKey: "pinned",
    });
    expect(prioritized.objectCount).toBe(20_000);
    expect(prioritized.candidateAccepted).toBe(true);
    expect(prioritized.blocks.map((item) => item.key)).toEqual([
      "visible",
      "before",
      "after",
      "pinned",
    ]);

    const merge = mergeTimeCanvasVersionedSegments([
      {
        ...block("first", 0, 100, 0),
        segments: [{ id: "shared", versionToken: "v1", title: "旧内容" }],
      },
      {
        ...block("second", 100, 200, 0),
        segments: [{ id: "shared", versionToken: "v1", title: "冲突内容" }],
      },
      {
        ...block("latest", 200, 300, 0),
        segments: [{ id: "newer", versionToken: "v2", title: "最新内容" }],
      },
      {
        ...block("older", 300, 400, 0),
        segments: [{ id: "newer", versionToken: "v1", title: "过期内容" }],
      },
    ]);
    expect(merge.conflictBlockKeys).toEqual(["first", "second"]);
    expect(merge.segments.find((item) => item.id === "newer")?.title).toBe(
      "最新内容",
    );
  });

  test("stale adaptive block completion cannot release a replacement request", () => {
    const registry = new Map<string, symbol>();
    const range = { startMs: 1_000, endMs: 2_000 };
    const stale = beginInFlightBlockRequest(registry, "rows-v1", range);
    expect(stale).not.toBeNull();

    registry.clear();
    const current = beginInFlightBlockRequest(registry, "rows-v2", range);
    expect(current).not.toBeNull();
    expect(settleInFlightBlockRequest(registry, stale!)).toBe(false);
    expect(beginInFlightBlockRequest(registry, "rows-v2", range)).toBeNull();
    expect(settleInFlightBlockRequest(registry, current!)).toBe(true);
    expect(beginInFlightBlockRequest(registry, "rows-v2", range)).not.toBeNull();

    registry.clear();
    const replaced = beginInFlightBlockRequest(registry, "rows-v2", range);
    expect(replaced).not.toBeNull();
    registry.clear();
    const replacement = beginInFlightBlockRequest(registry, "rows-v2", range);
    expect(replacement).not.toBeNull();
    expect(settleInFlightBlockRequest(registry, replaced!)).toBe(false);
    expect(beginInFlightBlockRequest(registry, "rows-v2", range)).toBeNull();
  });

  test("lane layout is deterministic, reuses adjacent half-open lanes and aggregates dense overlap", () => {
    const adjacent = layoutIntervalLanes([
      { id: "b", startMs: 10, endMs: 20 },
      { id: "a", startMs: 0, endMs: 10 },
    ]);
    expect(adjacent.placements.map((item) => [item.id, item.lane])).toEqual([
      ["a", 0],
      ["b", 0],
    ]);

    const dense = layoutIntervalLanes(
      Array.from({ length: 10 }, (_, index) => ({
        id: `dense-${index}`,
        startMs: 0,
        endMs: 100,
      })),
      4,
    );
    expect(dense.laneCount).toBe(4);
    expect(dense.placements.filter((item) => !item.aggregated)).toHaveLength(3);
    expect(dense.placements.filter((item) => item.aggregated)).toHaveLength(1);
    expect(dense.overflowIds).toHaveLength(7);
    expect(rowHeightForLaneCount(10)).toBe(120);

    const separatedDenseClusters = layoutIntervalLanes(
      [0, 100].flatMap((clusterStart) =>
        Array.from({ length: 5 }, (_, index) => ({
          id: `cluster-${clusterStart}-${index}`,
          startMs: clusterStart,
          endMs: clusterStart + 10,
        })),
      ),
      4,
    );
    const overflowClusters = separatedDenseClusters.placements.filter(
      (item) => item.aggregated,
    );
    expect(overflowClusters).toHaveLength(2);
    expect(overflowClusters.map((item) => [item.startMs, item.endMs])).toEqual([
      [0, 10],
      [100, 110],
    ]);
    expect(overflowClusters.map((item) => item.aggregatedIds.length)).toEqual([
      2,
      2,
    ]);

    const adjacentDenseClusters = layoutIntervalLanes(
      [
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `left-${index}`,
          startMs: 0,
          endMs: 10,
        })),
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `right-${index}`,
          startMs: 10,
          endMs: 20,
        })),
      ],
      4,
    );
    expect(
      adjacentDenseClusters.placements.filter((item) => item.aggregated),
    ).toHaveLength(2);

    const pointLanes = layoutPointLanes(
      Array.from({ length: 10 }, (_, index) => ({
        id: `point-${index}`,
        atMs: 1_000,
        sequence: index,
      })),
      HOUR_MS,
      4,
    );
    expect([...pointLanes.values()]).toEqual([0, 1, 2, 3, 3, 3, 3, 3, 3, 3]);
  });

  test("four-mode fixtures cover 200 anchors, 50 rows, dense overlap, long text and empty data", () => {
    const composer = createTimeCanvasFixture("TASK_COMPOSER");
    expect(composer.anchors).toHaveLength(200);
    expect(composer.phaseBands).toHaveLength(19);
    expect(new Set(composer.anchors.slice(0, 10).map((item) => item.atMs)).size).toBe(1);

    const workbench = createTimeCanvasFixture("TASK_WORKBENCH");
    expect(workbench.rows.some((row) => row.kind === "PLAN")).toBe(true);
    expect(workbench.segments.filter((item) => item.rowId === "person:fixture-person-0")).toHaveLength(10);

    const resource = createTimeCanvasFixture("RESOURCE_PLANNER");
    expect(resource.rows).toHaveLength(50);
    expect(resource.segments.length).toBeGreaterThan(200);
    expect(resource.rows[0]?.label.length).toBeGreaterThan(50);

    const personal = createTimeCanvasFixture("PERSONAL_TIMELINE");
    expect(personal.rows).toHaveLength(1);
    expect(personal.segments).toHaveLength(8);

    expect(createEmptyTimeCanvasFixture()).toMatchObject({
      rows: [],
      anchors: [],
      segments: [],
    });
  });

  test("DTO adapter preserves Busy response-level privacy", () => {
    const personId = uuid(1);
    const data = timeCanvasDataDtoSchema.parse({
      scope: { kind: "RESOURCE_PLANNER" },
      timezone: "Asia/Shanghai",
      range: {
        startAt: new Date(RANGE.startMs).toISOString(),
        endAt: new Date(RANGE.endMs).toISOString(),
      },
      groupBy: "PERSON",
      rows: [
        {
          id: personId,
          kind: "PERSON",
          label: "安全 Busy 行",
          sublabel: null,
          capabilities: { canCreateSegment: false },
        },
      ],
      anchors: [],
      segments: [
        {
          kind: "BUSY",
          visibility: "BUSY_ONLY",
          personId,
          startAt: new Date(RANGE.startMs + DAY_MS).toISOString(),
          endAt: new Date(RANGE.startMs + 2 * DAY_MS).toISOString(),
        },
      ],
      generatedAt: new Date(RANGE.startMs).toISOString(),
    });
    const model = timeCanvasDataToModel(data, "RESOURCE_PLANNER");
    expect(model.segments[0]).toMatchObject({
      title: "其他占用",
      taskId: null,
      versionToken: null,
      visibility: "BUSY_ONLY",
      permissions: { canViewDetails: false, canEdit: false },
    });
    expect(model.segments[0]).not.toHaveProperty("content");
    expect(model.segments[0]).not.toHaveProperty("tags");
  });

  test("Active plan rails remain read-only even when metadata is editable", () => {
    const taskId = uuid(30);
    const versionToken = new Date(RANGE.startMs).toISOString();
    const data = timeCanvasDataDtoSchema.parse({
      scope: { kind: "TASK_SCOPED", taskId },
      timezone: "Asia/Shanghai",
      range: {
        startAt: versionToken,
        endAt: new Date(RANGE.endMs).toISOString(),
      },
      groupBy: "PERSON",
      rows: [],
      anchors: [
        {
          id: taskId,
          title: "Active 计划",
          status: "ACTIVE",
          priority: "MEDIUM",
          createdAt: versionToken,
          plannedStartAt: new Date(RANGE.startMs + DAY_MS).toISOString(),
          capabilities: {
            canView: true,
            canUpdateMetadata: true,
            canManageMembers: true,
            canActivate: false,
            canArchive: false,
            canCreateRevision: true,
          },
          nodes: [],
          updatedAt: versionToken,
          versionToken,
        },
      ],
      segments: [],
      generatedAt: versionToken,
    });
    const model = timeCanvasDataToModel(data, "TASK_WORKBENCH");
    expect(model.rows[0]?.editable).toBe(false);
    expect(model.anchors[0]?.editable).toBe(false);
    const compatibilityModel = timeCanvasDataToModel(
      {
        ...data,
        anchors: data.anchors.map((anchor) => ({
          ...anchor,
          plannedStartAt: null,
        })),
      },
      "TASK_WORKBENCH",
    );
    expect(compatibilityModel.anchors[0]).toMatchObject({
      id: `plan-start:${taskId}`,
      atMs: Date.parse(versionToken),
      editable: false,
    });
  });
});

test.describe("S3 TimeCanvas controlled browser fixtures", () => {
  test("initial year layout reports the viewport even when scrollLeft remains zero", async ({
    context,
    page,
    baseURL,
  }) => {
    const identity = await createCanvasBrowserIdentity();
    await loginAsTestUser(context, baseURL, identity);
    await page.goto(
      "/progress/time-canvas-fixtures?mode=RESOURCE_PLANNER&long=1&scale=year",
    );

    const scroll = page.getByTestId("time-canvas-scroll");
    await expect(scroll).toBeVisible();
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBe(0);
    const viewport = page.getByTestId("time-canvas-observed-viewport");
    await expect(viewport).not.toHaveText("pending");
    await expect(viewport).toHaveAttribute("data-start-ms", String(RANGE.startMs));
    const endMs = Number(await viewport.getAttribute("data-end-ms"));
    expect(endMs).toBeGreaterThan(RANGE.startMs);
    await expectHealthyPage(page);
  });

  test("Today immediately centers a distant date without creeping", async ({
    context,
    page,
    baseURL,
  }) => {
    const identity = await createCanvasBrowserIdentity();
    await loginAsTestUser(context, baseURL, identity);
    const today = new Date("2029-07-01T08:00:00.000+08:00");
    await page.clock.setFixedTime(today);
    await page.goto(
      "/progress/time-canvas-fixtures?mode=RESOURCE_PLANNER&long=1&scale=week",
    );

    const scroll = page.getByTestId("time-canvas-scroll");
    await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBe(0);
    await page.getByRole("button", { name: "今天", exact: true }).click();
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    const viewport = page.getByTestId("time-canvas-observed-viewport");
    const startMs = Number(await viewport.getAttribute("data-start-ms"));
    const endMs = Number(await viewport.getAttribute("data-end-ms"));
    expect(startMs).toBeLessThanOrEqual(today.getTime());
    expect(endMs).toBeGreaterThan(today.getTime());
    const settledLeft = await scroll.evaluate((element) => element.scrollLeft);
    expect(settledLeft).toBeGreaterThan(0);
    await page.waitForTimeout(200);
    expect(await scroll.evaluate((element) => element.scrollLeft)).toBeCloseTo(
      settledLeft,
      0,
    );
    await expectHealthyPage(page);
  });

  test("current-time line follows the live browser clock and stays below sticky headers", async ({
    context,
    page,
    baseURL,
  }) => {
    const identity = await createCanvasBrowserIdentity();
    await loginAsTestUser(context, baseURL, identity);
    await page.clock.setFixedTime(new Date("2026-08-05T08:00:00.000+08:00"));
    await page.goto("/progress/time-canvas-fixtures?mode=RESOURCE_PLANNER");

    const axisLine = page.getByTestId("time-canvas-today-axis");
    await expect(axisLine).toBeVisible();
    const initialLeft = (await axisLine.boundingBox())?.x;
    if (initialLeft === undefined) throw new Error("当前时间线缺少布局信息");

    await page.clock.setFixedTime(new Date("2026-08-06T08:00:00.000+08:00"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect
      .poll(async () => (await axisLine.boundingBox())?.x ?? initialLeft)
      .toBeGreaterThan(initialLeft);

    const header = page.getByTestId(
      "time-canvas-row-header-person:fixture-person-0",
    );
    const headerZIndex = await header.evaluate((element) =>
      Number.parseInt(getComputedStyle(element).zIndex, 10),
    );
    const rowLineZIndex = await page
      .getByLabel("超长人员名称".repeat(12) + " 时间行", { exact: true })
      .getByTestId("time-canvas-today-line")
      .evaluate((element) => Number.parseInt(getComputedStyle(element).zIndex, 10));
    expect(headerZIndex).toBeGreaterThan(rowLineZIndex);
    await expectHealthyPage(page);
  });

  test("four modes render real dense, long, empty and virtualized states accessibly", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    const identity = await createCanvasBrowserIdentity();
    await loginAsTestUser(context, baseURL, identity);
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });

    for (const mode of [
      "TASK_COMPOSER",
      "TASK_WORKBENCH",
      "RESOURCE_PLANNER",
      "PERSONAL_TIMELINE",
    ]) {
      await page.goto(`/progress/time-canvas-fixtures?mode=${mode}`);
      await expect(page.getByTestId("time-canvas-root")).toHaveAttribute(
        "data-mode",
        mode,
      );
      await expect(page.getByTestId("time-canvas-root")).toHaveAttribute(
        "data-zoom",
        "WEEK",
      );
      await expect(page.getByRole("button", { name: /^今天/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "向前浏览时间" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "向后浏览时间" })).toHaveCount(0);
      await expect(page.getByTestId("time-canvas-scroll")).toBeVisible();
      await expectHealthyPage(page);
    }

    await page.goto(
      `/progress/time-canvas-fixtures?mode=TASK_COMPOSER${
        testInfo.project.name === "mobile" ? "&scale=week" : ""
      }`,
    );
    {
      await expect(
        page.getByTestId("phase-bands-plan:fixture-composer"),
      ).toBeVisible();
      if (testInfo.project.name === "desktop") {
        await expect(page.locator("[data-canvas-object]")).toHaveCount(200);
      } else {
        await expect.poll(() => page.locator("[data-canvas-object]").count()).toBeGreaterThan(0);
        expect(await page.locator("[data-canvas-object]").count()).toBeLessThan(200);
      }
      expect(
        await page.getByTestId("timeline-row-plan:fixture-composer").evaluate((row) => {
          const rowBottom = row.getBoundingClientRect().bottom;
          return [...row.querySelectorAll("[data-anchor-label-lane]")].every(
            (anchor) => anchor.getBoundingClientRect().bottom <= rowBottom + 1,
          );
        }),
      ).toBe(true);
      const headerZIndex = await page
        .getByTestId("time-canvas-row-header-plan:fixture-composer")
        .evaluate((header) => Number.parseInt(getComputedStyle(header).zIndex, 10));
      const anchorZIndex = await page
        .getByTestId("milestone-marker-composer-node-0")
        .evaluate((anchor) => Number.parseInt(getComputedStyle(anchor).zIndex, 10));
      expect(headerZIndex).toBeGreaterThan(anchorZIndex);
      await expect(
        page.getByTestId("milestone-marker-composer-node-0"),
      ).toHaveAttribute("data-anchor-icon", "DIAMOND");
      const composerSymbol = await page.getByTestId("anchor-symbol-composer-node-0").boundingBox();
      const composerBand = await page.getByTestId("phase-band-composer-phase-0").boundingBox();
      if (!composerSymbol || !composerBand) throw new Error("Composer 计划连接元素缺少布局信息");
      expect(Math.abs(
        composerSymbol.y + composerSymbol.height / 2 -
        (composerBand.y + composerBand.height / 2),
      )).toBeLessThanOrEqual(1);
    }
    await expectHealthyPage(page);

    await page.goto(
      "/progress/time-canvas-fixtures?mode=TASK_WORKBENCH",
    );
    if (testInfo.project.name === "desktop") {
      await expect(
        page.getByTestId("milestone-marker-workbench-node-0"),
      ).toHaveAttribute("data-anchor-icon", "CHECK");
      await expect(
        page.getByTestId("milestone-marker-workbench-node-0"),
      ).toHaveAttribute("data-anchor-completed", "true");
      await expect(
        page.getByTestId("milestone-marker-workbench-node-1"),
      ).toHaveAttribute("data-anchor-icon", "CIRCLE");
      await expect(
        page.getByTestId("milestone-marker-workbench-node-1"),
      ).toHaveAttribute("data-anchor-completed", "false");
      await expect(
        page.getByTestId("phase-band-workbench-node-0:workbench-node-1"),
      ).toContainText("里程碑 2");
      const workbenchSymbol = await page.getByTestId("anchor-symbol-workbench-node-0").boundingBox();
      const workbenchBand = await page
        .getByTestId("phase-band-workbench-node-0:workbench-node-1")
        .boundingBox();
      if (!workbenchSymbol || !workbenchBand) throw new Error("Workbench 计划连接元素缺少布局信息");
      expect(Math.abs(
        workbenchSymbol.y + workbenchSymbol.height / 2 -
        (workbenchBand.y + workbenchBand.height / 2),
      )).toBeLessThanOrEqual(1);
      const firstReadonlyAnchor = page.getByTestId(
        "milestone-marker-workbench-node-0",
      );
      await firstReadonlyAnchor.focus();
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(() => activeCanvasObjectKey(page))
        .toBe("anchor:workbench-node-1");
    }
    await expectHealthyPage(page);

    await page.goto(
      "/progress/time-canvas-fixtures?mode=RESOURCE_PLANNER",
    );
    {
      const mountedRows = page.locator("[data-testid^='timeline-row-']");
      expect(await mountedRows.count()).toBeLessThan(50);
      const busyBlock = page.getByTestId("segment-block-resource-segment-0-3");
      await expect(busyBlock).toBeVisible();
      await busyBlock.hover();
      const busyTitle = await busyBlock.getAttribute("title");
      const busyAriaLabel = await busyBlock.getAttribute("aria-label");
      expect(busyTitle).toContain("其他占用");
      expect(busyTitle).not.toContain("Task");
      expect(busyAriaLabel).toContain("其他占用");
      expect(busyAriaLabel).not.toContain("Task");
      const initialTarget = page.locator(
        '[data-canvas-object][tabindex="0"]',
      );
      await expect(initialTarget).toBeVisible();
      await initialTarget.focus();
      let previousKey = await activeCanvasObjectKey(page);
      for (let index = 0; index < 12; index += 1) {
        await page.keyboard.press("ArrowDown");
        await expect
          .poll(() => activeCanvasObjectKey(page))
          .not.toBe(previousKey);
        previousKey = await activeCanvasObjectKey(page);
      }
      expect(
        await page.evaluate(
          () =>
            document.activeElement
              ?.closest("[data-testid^='timeline-row-']")
              ?.getAttribute("data-testid") ?? null,
        ),
      ).toContain("fixture-person-12");
      expect(await mountedRows.count()).toBeLessThan(50);
    }
    await expectHealthyPage(page);

    await page.goto(
      "/progress/time-canvas-fixtures?mode=RESOURCE_PLANNER&empty=1",
    );
    await expect(
      page.getByTestId("time-canvas-empty"),
    ).toContainText("受控空数据验收状态");
    await expectHealthyPage(page);
    expect(browserErrors).toEqual([]);
  });
});

function uuid(value: number) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

async function createCanvasBrowserIdentity() {
  const openId = `ou_pm_s3_canvas_${randomUUID()}`;
  const name = "S3 TimeCanvas 验收用户";
  await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: {
        create: {
          displayName: name,
          status: "ACTIVE",
        },
      },
    },
  });
  return { openId, name };
}

async function activeCanvasObjectKey(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      document.activeElement instanceof HTMLElement
        ? (document.activeElement.dataset.canvasObjectKey ?? null)
        : null,
  );
}
