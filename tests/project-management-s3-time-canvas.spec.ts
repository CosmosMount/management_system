import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { timeCanvasDataToModel } from "../components/project-management/time-canvas/adapter";
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
  DAY_MS,
  HOUR_MS,
  axisTicks,
  chooseFitZoom,
  createTimeScale,
  fitTimeRange,
  intervalToRect,
  rangesIntersect,
  snapTime,
  timeToX,
  visibleTimeWindow,
  xToTime,
} from "../components/project-management/time-canvas/time-math";
import {
  parseTimeCanvasUrlState,
  serializeTimeCanvasUrlState,
} from "../components/project-management/time-canvas/url-state";
import { timeCanvasDataDtoSchema } from "../lib/project-management/types/time-canvas";
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
  test("time scale round-trips, clips, snaps, fits and preserves half-open boundaries", () => {
    const scale = createTimeScale({
      range: RANGE,
      viewportWidthPx: 960,
      zoom: "DAY",
    });
    const point = RANGE.startMs + 12.5 * DAY_MS;
    expect(xToTime(timeToX(point, scale), scale)).toBeCloseTo(point, 5);
    expect(snapTime(point + 5 * HOUR_MS, DAY_MS, "floor")).toBe(point - 0.5 * DAY_MS);
    expect(snapTime(point + 5 * HOUR_MS, DAY_MS, "ceil")).toBe(point + 0.5 * DAY_MS);
    expect(
      intervalToRect(RANGE.startMs - DAY_MS, RANGE.startMs + DAY_MS, scale),
    ).toEqual({ left: 0, width: 96 });
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
    expect(chooseFitZoom({ startMs: RANGE.startMs, endMs: RANGE.startMs + 3 * DAY_MS })).toBe("HOUR");
    expect(chooseFitZoom(RANGE)).toBe("WEEK");
    const window = visibleTimeWindow({
      scale,
      scrollLeftPx: 960,
      viewportWidthPx: 960,
      overscanPx: 0,
    });
    expect(window.startMs).toBe(RANGE.startMs + 10 * DAY_MS);
    expect(window.endMs).toBe(RANGE.startMs + 20 * DAY_MS);
    const weekTicks = axisTicks({ window: RANGE, zoom: "WEEK" });
    expect(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Shanghai",
        weekday: "short",
      }).format(new Date(weekTicks[1] ?? weekTicks[0])),
    ).toBe("Mon");
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

  test("URL adapter bounds range and IDs, restores stable shareable state and rejects malformed input", () => {
    const ids = Array.from({ length: 52 }, (_, index) => uuid(index + 1));
    const parsed = parseTimeCanvasUrlState(
      new URLSearchParams({
        from: "2026-08-01",
        to: "2026-08-31",
        zoom: "day",
        group: "task",
        people: ids.join(","),
        types: "planned,actual",
        focus: uuid(99),
      }),
      RANGE,
    );
    expect(parsed.range).toEqual(RANGE);
    expect(parsed.zoom).toBe("DAY");
    expect(parsed.groupBy).toBe("TASK");
    expect(parsed.personIds).toHaveLength(50);
    expect(parsed.types).toEqual(["PLANNED", "ACTUAL"]);
    expect(parsed.issues).toContain("人员筛选最多保留 50 个");

    const { issues: parsedIssues, ...serializable } = parsed;
    expect(parsedIssues.length).toBeGreaterThan(0);
    const serialized = serializeTimeCanvasUrlState(serializable);
    expect(serialized.get("from")).toBe("2026-08-01");
    expect(serialized.get("to")).toBe("2026-08-31");
    expect(serialized.get("group")).toBe("task");
    expect(serialized.get("people")?.split(",")).toHaveLength(50);

    const fallback = parseTimeCanvasUrlState(
      new URLSearchParams({ from: "2026-08-31", to: "2026-08-01", zoom: "forever" }),
      RANGE,
    );
    expect(fallback.range).toEqual(RANGE);
    expect(fallback.issues).toEqual(
      expect.arrayContaining([
        "日期范围无效，已恢复默认范围",
        "缩放档位无效，已自动适配",
      ]),
    );

    const impossibleDate = parseTimeCanvasUrlState(
      new URLSearchParams({ from: "2026-02-31", to: "2026-03-10" }),
      RANGE,
    );
    expect(impossibleDate.range).toEqual(RANGE);
    expect(impossibleDate.issues).toContain("日期范围无效，已恢复默认范围");
  });

  test("four-mode fixtures cover 200 anchors, 50 rows, dense overlap, long text and empty data", () => {
    const composer = createTimeCanvasFixture("TASK_COMPOSER");
    expect(composer.anchors).toHaveLength(200);
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
      nextCursor: null,
      generatedAt: new Date(RANGE.startMs).toISOString(),
    });
    const model = timeCanvasDataToModel(data, "RESOURCE_PLANNER");
    expect(model.segments[0]).toMatchObject({
      title: "其他占用",
      taskId: null,
      nodeId: null,
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
          plannedStartAt: new Date(RANGE.startMs + DAY_MS).toISOString(),
          capabilities: {
            canView: true,
            canUpdateMetadata: true,
            canManageMembers: true,
            canManageTags: true,
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
      nextCursor: null,
      generatedAt: versionToken,
    });
    const model = timeCanvasDataToModel(data, "TASK_WORKBENCH");
    expect(model.rows[0]?.editable).toBe(false);
    expect(model.anchors[0]?.editable).toBe(false);
  });
});

test.describe("S3 TimeCanvas controlled browser fixtures", () => {
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
      if (testInfo.project.name === "desktop") {
        await expect(page.getByTestId("time-canvas-scroll")).toBeVisible();
      } else {
        await expect(page.getByTestId("time-agenda")).toBeVisible();
      }
      await expectHealthyPage(page);
    }

    await page.goto(
      "/progress/time-canvas-fixtures?mode=TASK_COMPOSER",
    );
    if (testInfo.project.name === "desktop") {
      await expect(
        page.getByTestId("plan-rail-plan:fixture-composer"),
      ).toBeVisible();
      await expect(page.locator("[data-canvas-object]")).toHaveCount(200);
    } else {
      await expect(
        page.locator("[data-testid^='agenda-item-']"),
      ).toHaveCount(200);
    }
    await expectHealthyPage(page);

    await page.goto(
      "/progress/time-canvas-fixtures?mode=RESOURCE_PLANNER",
    );
    if (testInfo.project.name === "desktop") {
      const mountedRows = page.locator("[data-testid^='timeline-row-']");
      expect(await mountedRows.count()).toBeLessThan(50);
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
    } else {
      await expect
        .poll(() =>
          page.getByTestId("time-agenda").getByRole("listitem").count(),
        )
        .toBeGreaterThan(200);
    }
    await expectHealthyPage(page);

    await page.goto(
      "/progress/time-canvas-fixtures?mode=RESOURCE_PLANNER&empty=1",
    );
    await expect(
      page.getByTestId(
        testInfo.project.name === "desktop"
          ? "time-canvas-empty"
          : "time-agenda-empty",
      ),
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
