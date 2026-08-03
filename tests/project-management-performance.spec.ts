import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { updateWorkSegment } from "../lib/project-management/application/segment-service";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import { getTimeCanvasData } from "../lib/project-management/queries/time-canvas-queries";
import {
  comparePlanVersions,
  getTaskWorkspace,
  listTasks,
} from "../lib/project-management/queries/task-queries";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

const runScaleTests = process.env.PM_RUN_SCALE_TESTS === "true";

test.describe("project management S9 scale and performance", () => {
  test.skip(!runScaleTests, "set PM_RUN_SCALE_TESTS=true to build the isolated 100k fixture");

  test("10k Task, 100k Segment, 50x100 nodes and 100k notifications meet gates", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "scale gate runs once on desktop");
    test.setTimeout(8 * 60_000);
    const fixture = await createScaleFixture();
    const actor = fixture.actor;
    const taskId = taskUuid(1);
    const currentPlanId = planUuid(1);
    const comparisonPlanId = "88000000-0000-4000-8000-000000000001";
    const rangeStart = new Date("2026-08-01T00:00:00.000Z");
    const rangeEnd = new Date(rangeStart.getTime() + 14 * 24 * 60 * 60_000);

    const taskListP95 = await measureP95(20, () =>
      listTasks({ actor, input: { limit: 50 } }),
    );
    const workspaceP95 = await measureP95(15, () =>
      getTaskWorkspace({ actor, taskId }),
    );
    let latestCanvas: Awaited<ReturnType<typeof getTimeCanvasData>> | null = null;
    const timelineP95 = await measureP95(10, async () => {
      latestCanvas = await getTimeCanvasData({
        actor,
        input: {
          scope: { kind: "RESOURCE_PLANNER" },
          rangeStart: rangeStart.toISOString(),
          rangeEnd: rangeEnd.toISOString(),
          personIds: fixture.personIds,
          taskIds: [],
          tagIds: [],
          nodeIds: [],
          types: [],
          statuses: [],
          groupBy: "PERSON",
          includeTaskAnchors: true,
          includeActual: true,
          includeBusyBlocks: true,
          rowLimit: 50,
        },
      });
      return latestCanvas;
    });
    const versionCompareP95 = await measureP95(15, () =>
      comparePlanVersions({
        actor,
        fromPlanVersionId: currentPlanId,
        toPlanVersionId: comparisonPlanId,
      }),
    );
    const actionSegment = await prisma.workSegment.create({
      data: {
        personId: actor.personId,
        type: "PLANNED",
        status: "PLANNED",
        startAt: new Date("2026-08-03T01:00:00.000Z"),
        endAt: new Date("2026-08-03T02:00:00.000Z"),
        content: "S9 real action performance fixture",
        createdByAccountId: actor.accountId,
      },
    });
    let actionVersion = actionSegment.updatedAt.toISOString();
    let actionSequence = 0;
    const actionTransactionP95 = await measureP95(20, async () => {
      actionSequence += 1;
      const result = await updateWorkSegment(actor, {
        segmentId: actionSegment.id,
        expectedUpdatedAt: actionVersion,
        content: `S9 real action ${actionSequence}`,
        reason: "S9 普通业务 action 性能门禁",
      });
      actionVersion = result.segment.updatedAt;
      return result;
    });
    expect(
      await prisma.workSegmentChange.count({
        where: { segmentId: actionSegment.id, action: "UPDATE" },
      }),
    ).toBe(22);
    expect(
      await prisma.domainAuditEvent.count({
        where: { entityType: "WorkSegment", entityId: actionSegment.id },
      }),
    ).toBe(22);

    const [taskPlan, segmentPlan] = await Promise.all([
      explainTaskList(),
      explainTimeline(fixture.personIds, rangeStart, rangeEnd),
    ]);
    const responseBytes = Buffer.byteLength(JSON.stringify(latestCanvas), "utf8");
    const metrics = {
      taskListP95,
      workspaceP95,
      timelineP95,
      versionCompareP95,
      actionTransactionP95,
      responseBytes,
      taskPlan,
      segmentPlan,
    };
    console.info(`S9_PERFORMANCE_EVIDENCE ${JSON.stringify(metrics)}`);

    expect(taskListP95).toBeLessThan(800);
    expect(workspaceP95).toBeLessThan(1_200);
    expect(timelineP95).toBeLessThan(1_500);
    expect(versionCompareP95).toBeLessThan(1_000);
    expect(actionTransactionP95).toBeLessThan(500);
    expect(responseBytes).toBeLessThan(5 * 1024 * 1024);
    expect(taskPlan.executionTimeMs).toBeLessThan(800);
    expect(segmentPlan.executionTimeMs).toBeLessThan(1_500);

    await loginAsTestUser(context, baseURL, {
      openId: fixture.openId,
      name: "S9 性能管理员",
    });
    const query = new URLSearchParams({
      from: "2026-08-01",
      to: "2026-08-15",
      people: fixture.personIds.join(","),
      group: "person",
      zoom: "day",
    });
    await page.goto(`/progress/resources?${query}`);
    await expect(page.getByRole("heading", { name: "人员计划" })).toBeVisible();
    await expect(page.getByTestId("time-canvas-root")).toBeVisible();
    const domCount = await page.locator("body *").count();
    const segmentDomCount = await page.locator('[data-testid^="segment-block-"]').count();
    console.info(
      `S9_DOM_EVIDENCE ${JSON.stringify({ domCount, segmentDomCount })}`,
    );
    expect(domCount).toBeLessThan(5_000);
    expect(segmentDomCount).toBeLessThan(1_000);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await expectHealthyPage(page);
  });
});

async function createScaleFixture() {
  const openId = `ou_s9_perf_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: { create: { displayName: "S9 性能管理员", status: "ACTIVE" } },
      systemRoles: { create: { role: "PROJECT_ADMINISTRATOR" } },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("performance account missing person");
  const person = account.person;
  const accountId = account.id;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.$executeRaw`
      INSERT INTO "Task" (
        id, title, description, team, "techGroup", status, priority,
        "currentPlanVersionId", "createdByAccountId", "createdAt", "updatedAt"
      )
      SELECT
        '81000000-0000-4000-8000-' || lpad(g::text, 12, '0'),
        'S9 Scale Task ' || g,
        '10k Task performance fixture',
        '英雄', '电控', 'ACTIVE'::"TaskStatus", 'MEDIUM'::"TaskPriority",
        '82000000-0000-4000-8000-' || lpad(g::text, 12, '0'),
        ${accountId}, now(), now()
      FROM generate_series(1, 10000) AS g
    `;
    await tx.$executeRaw`
      INSERT INTO "TaskPlanVersion" (
        id, "taskId", "versionNo", status, reason, "plannedStartAt",
        "createdByAccountId", "activatedAt", "snapshotHash", "createdAt", "updatedAt"
      )
      SELECT
        '82000000-0000-4000-8000-' || lpad(g::text, 12, '0'),
        '81000000-0000-4000-8000-' || lpad(g::text, 12, '0'),
        1, 'CURRENT'::"PlanVersionStatus", 'S9 scale current',
        '2026-08-01T00:00:00Z'::timestamptz,
        ${accountId}, now(), '', now(), now()
      FROM generate_series(1, 10000) AS g
    `;
    await tx.$executeRaw`
      INSERT INTO "TaskMember" (id, "taskId", "personId", role, "createdByAccountId", "createdAt")
      SELECT
        md5('member-' || g),
        '81000000-0000-4000-8000-' || lpad(g::text, 12, '0'),
        ${person.id}, 'OWNER'::"TaskMemberRole", ${accountId}, now()
      FROM generate_series(1, 10000) AS g
    `;
  }, { timeout: 120_000 });

  await prisma.$executeRaw`
    INSERT INTO "Person" (id, "displayName", status, "createdAt", "updatedAt")
    SELECT
      '83000000-0000-4000-8000-' || lpad(g::text, 12, '0'),
      'S9 Scale Person ' || lpad(g::text, 2, '0'),
      'ACTIVE'::"PersonStatus", now(), now()
    FROM generate_series(1, 50) AS g
  `;
  await prisma.$executeRaw`
    INSERT INTO "WorkSegment" (
      id, "personId", type, status, "startAt", "endAt", content,
      role, priority, "taskId", "createdByAccountId", "createdAt", "updatedAt"
    )
    SELECT
      '84000000-0000-4000-8000-' || lpad(g::text, 12, '0'),
      '83000000-0000-4000-8000-' || lpad((((g - 1) % 50) + 1)::text, 12, '0'),
      'PLANNED'::"WorkSegmentType", 'CONFIRMED'::"WorkSegmentStatus",
      '2026-08-01T00:00:00Z'::timestamptz + (floor((g - 1) / 50) * interval '5 hours'),
      '2026-08-01T00:00:00Z'::timestamptz + (floor((g - 1) / 50) * interval '5 hours') + interval '90 minutes',
      'S9 Scale Segment ' || g,
      'DEVELOPER'::"WorkSegmentRole", 'MEDIUM'::"TaskPriority",
      '81000000-0000-4000-8000-' || lpad((((g - 1) % 50) + 1)::text, 12, '0'),
      ${accountId}, now(), now()
    FROM generate_series(1, 100000) AS g
  `;
  await prisma.$executeRaw`
    INSERT INTO "InAppNotification" (
      id, "recipientAccountId", category, title, summary,
      "entityType", "entityId", "createdAt"
    )
    SELECT
      '85000000-0000-4000-8000-' || lpad(g::text, 12, '0'),
      ${accountId}, 'TASK'::"ProjectManagementNotificationCategory",
      'S9 Scale Notification ' || g, '100k notification fixture',
      'Task', '81000000-0000-4000-8000-' || lpad((((g - 1) % 10000) + 1)::text, 12, '0'),
      now() - (g * interval '1 second')
    FROM generate_series(1, 100000) AS g
  `;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      WITH source AS (
        SELECT t, n, md5('node-' || t || '-' || n) AS hash
        FROM generate_series(1, 50) AS t
        CROSS JOIN generate_series(1, 100) AS n
      ), nodes AS (
        SELECT t, n,
          substring(hash,1,8)||'-'||substring(hash,9,4)||'-4'||substring(hash,14,3)||'-8'||substring(hash,18,3)||'-'||substring(hash,21,12) AS id
        FROM source
      )
      INSERT INTO "TaskNode" (
        id, "taskId", type, status, "businessDescription",
        "createdByAccountId", "createdAt", "updatedAt"
      )
      SELECT id,
        '81000000-0000-4000-8000-' || lpad(t::text, 12, '0'),
        'MILESTONE'::"TaskNodeType", 'PENDING'::"TaskNodeStatus",
        'S9 node ' || n, ${accountId}, now(), now()
      FROM nodes
    `;
    await tx.$executeRaw`
      WITH source AS (
        SELECT t, n, md5('node-' || t || '-' || n) AS node_hash,
          md5('milestone-' || t || '-' || n) AS milestone_hash
        FROM generate_series(1, 50) AS t
        CROSS JOIN generate_series(1, 100) AS n
      ), ids AS (
        SELECT t, n,
          substring(node_hash,1,8)||'-'||substring(node_hash,9,4)||'-4'||substring(node_hash,14,3)||'-8'||substring(node_hash,18,3)||'-'||substring(node_hash,21,12) AS node_id,
          substring(milestone_hash,1,8)||'-'||substring(milestone_hash,9,4)||'-4'||substring(milestone_hash,14,3)||'-8'||substring(milestone_hash,18,3)||'-'||substring(milestone_hash,21,12) AS milestone_id
        FROM source
      )
      INSERT INTO "MilestoneNode" (
        id, "nodeId", goal, "completionCriteria", "expectedCompletedAt", "reviewRequirements"
      )
      SELECT milestone_id, node_id, 'S9 Milestone ' || n,
        'Performance criterion',
        '2026-08-01T00:00:00Z'::timestamptz + (n * interval '1 day'),
        'Performance review'
      FROM ids
    `;
    await tx.$executeRaw`
      WITH source AS (
        SELECT t, n, md5('node-' || t || '-' || n) AS node_hash,
          md5('entry-' || t || '-' || n) AS entry_hash
        FROM generate_series(1, 50) AS t
        CROSS JOIN generate_series(1, 100) AS n
      ), ids AS (
        SELECT t, n,
          substring(node_hash,1,8)||'-'||substring(node_hash,9,4)||'-4'||substring(node_hash,14,3)||'-8'||substring(node_hash,18,3)||'-'||substring(node_hash,21,12) AS node_id,
          substring(entry_hash,1,8)||'-'||substring(entry_hash,9,4)||'-4'||substring(entry_hash,14,3)||'-8'||substring(entry_hash,18,3)||'-'||substring(entry_hash,21,12) AS entry_id
        FROM source
      )
      INSERT INTO "PlanVersionNode" (id, "planVersionId", "nodeId", sequence)
      SELECT entry_id,
        '82000000-0000-4000-8000-' || lpad(t::text, 12, '0'),
        node_id, n
      FROM ids
    `;
    await tx.taskPlanVersion.create({
      data: {
        id: "88000000-0000-4000-8000-000000000001",
        taskId: taskUuid(1),
        versionNo: 2,
        status: "HISTORICAL",
        baseVersionId: planUuid(1),
        reason: "S9 compare fixture",
        plannedStartAt: new Date("2026-08-02T00:00:00.000Z"),
        createdByAccountId: accountId,
      },
    });
    await tx.$executeRaw`
      WITH source AS (
        SELECT n, md5('node-1-' || n) AS node_hash,
          md5('compare-entry-' || n) AS entry_hash
        FROM generate_series(1, 100) AS n
      ), ids AS (
        SELECT n,
          substring(node_hash,1,8)||'-'||substring(node_hash,9,4)||'-4'||substring(node_hash,14,3)||'-8'||substring(node_hash,18,3)||'-'||substring(node_hash,21,12) AS node_id,
          substring(entry_hash,1,8)||'-'||substring(entry_hash,9,4)||'-4'||substring(entry_hash,14,3)||'-8'||substring(entry_hash,18,3)||'-'||substring(entry_hash,21,12) AS entry_id
        FROM source
      )
      INSERT INTO "PlanVersionNode" (id, "planVersionId", "nodeId", sequence)
      SELECT entry_id, '88000000-0000-4000-8000-000000000001', node_id, 101 - n
      FROM ids
    `;
  }, { timeout: 120_000 });
  await prisma.$executeRaw`ANALYZE "Task"`;
  await prisma.$executeRaw`ANALYZE "TaskPlanVersion"`;
  await prisma.$executeRaw`ANALYZE "PlanVersionNode"`;
  await prisma.$executeRaw`ANALYZE "WorkSegment"`;
  await prisma.$executeRaw`ANALYZE "InAppNotification"`;

  const counts = await Promise.all([
    prisma.task.count(),
    prisma.workSegment.count(),
    prisma.taskNode.count(),
    prisma.inAppNotification.count(),
  ]);
  expect(counts).toEqual([10_000, 100_000, 5_000, 100_000]);
  return {
    actor: {
      accountId,
      personId: person.id,
      openId,
      unionId: null,
      systemRoles: [{ role: "PROJECT_ADMINISTRATOR" as const, team: "", techGroup: "" }],
    } satisfies ProjectManagementActor,
    openId,
    personIds: Array.from({ length: 50 }, (_, index) => personUuid(index + 1)),
  };
}

async function measureP95(iterations: number, operation: () => Promise<unknown>) {
  await operation();
  await operation();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return Number(samples[Math.ceil(samples.length * 0.95) - 1]?.toFixed(2));
}

async function explainTaskList() {
  const rows = await prisma.$queryRaw<Array<{ "QUERY PLAN": unknown }>>`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id FROM "Task"
    WHERE "deletedAt" IS NULL
    ORDER BY "updatedAt" DESC, id DESC
    LIMIT 50
  `;
  return summarizePlan(rows[0]?.["QUERY PLAN"]);
}

async function explainTimeline(personIds: string[], startAt: Date, endAt: Date) {
  const rows = await prisma.$queryRaw<Array<{ "QUERY PLAN": unknown }>>(
    Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id FROM "WorkSegment"
      WHERE "deletedAt" IS NULL
        AND "personId" IN (${Prisma.join(personIds)})
        AND "startAt" < ${endAt}
        AND "endAt" > ${startAt}
      ORDER BY "startAt" ASC, id ASC
    `,
  );
  return summarizePlan(rows[0]?.["QUERY PLAN"]);
}

function summarizePlan(value: unknown) {
  const root = Array.isArray(value) ? value[0] : null;
  if (!root || typeof root !== "object") return { executionTimeMs: Number.POSITIVE_INFINITY, plan: "unknown" };
  const record = root as { "Execution Time"?: unknown; Plan?: { "Node Type"?: unknown } };
  return {
    executionTimeMs: Number(record["Execution Time"] ?? Number.POSITIVE_INFINITY),
    plan: String(record.Plan?.["Node Type"] ?? "unknown"),
  };
}

function taskUuid(index: number) {
  return `81000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function planUuid(index: number) {
  return `82000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function personUuid(index: number) {
  return `83000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
