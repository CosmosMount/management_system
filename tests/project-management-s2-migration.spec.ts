import { expect, test } from "@playwright/test";
import {
  TaskMemberRole,
  TaskNodeStatus,
  TaskNodeType,
  TaskPriority,
  TaskStatus,
  TerminationOutcome,
  WorkSegmentRole,
  WorkSegmentStatus,
  WorkSegmentType,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  runProjectManagementAction,
} from "../lib/project-management/application/action-result";
import {
  PROJECT_MANAGEMENT_ERROR_CODES,
  ProjectManagementServiceError,
  staleSegmentAuthoritativeDtoSchema,
  staleSegmentError,
  staleTaskAuthoritativeDtoSchema,
  staleTaskError,
} from "../lib/project-management/application/errors";
import {
  standaloneTimeCanvasScopeKindValues,
  taskMemberRoleValues,
  taskNodeStatusValues,
  taskNodeTypeValues,
  taskPriorityValues,
  taskStatusValues,
  terminationOutcomeValues,
  timeCanvasGroupByValues,
  timeCanvasScopeKindValues,
  workSegmentRoleValues,
  workSegmentStatusValues,
  workSegmentTypeValues,
} from "../lib/project-management/types/contract-values";
import {
  BUSY_BLOCK_DTO_FIELDS,
  busyBlockDtoSchema,
  personAccountBindingValues,
  personOptionPageSchema,
  tagOptionPageSchema,
  taskOptionPageSchema,
  timeCanvasDataDtoSchema,
  timeSegmentDtoSchema,
} from "../lib/project-management/types/time-canvas";
import {
  absoluteDateTimeSchema,
  createTaskDraftInputSchema,
  revisionDraftInputSchema,
} from "../lib/project-management/validations/lifecycle";
import {
  batchCreatePlannedSegmentsInputSchema,
  confirmPlannedSegmentInputSchema,
  createActualSegmentInputSchema,
  createWorkSegmentInputSchema,
  partiallyConfirmSegmentInputSchema,
  splitPlannedSegmentInputSchema,
  updateWorkSegmentInputSchema,
  workSegmentTypeValues as segmentValidationWorkSegmentTypeValues,
} from "../lib/project-management/validations/segments";
import {
  replaceTaskDraftPlanInputSchema,
  replaceTaskDraftMembersInputSchema,
  replaceTaskMembersInputSchema,
} from "../lib/project-management/validations/task-mutations";
import { addStructuredProjectManagementIssue } from "../lib/project-management/validations/issues";
import {
  getTimeCanvasDataInputSchema,
  listTagOptionsInputSchema,
  MAX_TIME_CANVAS_VISIBLE_SEGMENTS,
  searchPeopleInputSchema,
  timeCanvasVisibleSegmentCountSchema,
} from "../lib/project-management/validations/time-canvas";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma/migrations");
const S2_MIGRATION_NAME =
  "20260730120000_add_task_plan_version_planned_start_at";

test("S2 migration adds nullable timestamptz(6) plannedStartAt and preserves legacy null plans", async () => {
  const columns = await prisma.$queryRaw<
    Array<{
      data_type: string;
      is_nullable: string;
      datetime_precision: number | null;
    }>
  >`
    SELECT data_type, is_nullable, datetime_precision
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'TaskPlanVersion'
      AND column_name = 'plannedStartAt'
  `;
  expect(columns).toEqual([
    {
      data_type: "timestamp with time zone",
      is_nullable: "YES",
      datetime_precision: 6,
    },
  ]);

  const account = await prisma.account.create({ data: {} });
  const taskId = randomUUID();
  const planVersionId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.create({
      data: {
        id: taskId,
        title: "S2 旧计划兼容验证",
        currentPlanVersionId: planVersionId,
        createdByAccountId: account.id,
      },
    });
    await tx.taskPlanVersion.create({
      data: {
        id: planVersionId,
        taskId,
        versionNo: 1,
        status: "CURRENT",
        reason: "迁移前兼容记录",
        createdByAccountId: account.id,
      },
    });
  });

  const legacyPlan = await prisma.taskPlanVersion.findUniqueOrThrow({
    where: { id: planVersionId },
    select: { plannedStartAt: true, status: true, activatedAt: true },
  });
  expect(legacyPlan).toEqual({
    plannedStartAt: null,
    status: "CURRENT",
    activatedAt: null,
  });
});

test("S2 migration preserves a plan created before the nullable column existed", async () => {
  test.setTimeout(120_000);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sourceUrl = new URL(databaseUrl);
  const sourceDatabaseName = sourceUrl.pathname.replace(/^\//, "");
  if (
    !["127.0.0.1", "localhost", "::1"].includes(sourceUrl.hostname) ||
    !sourceDatabaseName.endsWith("_test") ||
    /prod(?:uction)?/i.test(sourceDatabaseName)
  ) {
    throw new Error("拒绝在非本机测试数据库执行 S2 migration 回归");
  }

  const randomPart = randomUUID().replaceAll("-", "").slice(0, 12);
  const temporaryDatabaseName = `${sourceDatabaseName.slice(0, 20)}_${randomPart}_s2_foundation_test`;
  if (!/^[a-zA-Z0-9_]+_s2_foundation_test$/.test(temporaryDatabaseName)) {
    throw new Error("S2 临时数据库名称安全校验失败");
  }
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const temporaryDatabaseUrl = new URL(sourceUrl);
  temporaryDatabaseUrl.pathname = `/${temporaryDatabaseName}`;
  const adminClient = new Client({ connectionString: adminUrl.toString() });
  let migrationClient: Client | null = null;
  await adminClient.connect();
  try {
    const existing = await adminClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [temporaryDatabaseName],
    );
    if (existing.rowCount !== 0) {
      throw new Error("随机 S2 临时数据库已存在，拒绝复用");
    }
    await adminClient.query(`CREATE DATABASE "${temporaryDatabaseName}"`);
    migrationClient = new Client({
      connectionString: temporaryDatabaseUrl.toString(),
    });
    await migrationClient.connect();
    const migrationNames = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter(
        (entry) => entry.isDirectory() && entry.name < S2_MIGRATION_NAME,
      )
      .map((entry) => entry.name)
      .sort();
    expect(migrationNames.length).toBeGreaterThan(0);
    for (const migrationName of migrationNames) {
      await executeMigrationSql(
        migrationClient,
        await readFile(
          path.join(MIGRATIONS_DIR, migrationName, "migration.sql"),
          "utf8",
        ),
      );
    }

    const beforeColumn = await migrationClient.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'TaskPlanVersion'
        AND column_name = 'plannedStartAt'
    `);
    expect(beforeColumn.rowCount).toBe(0);
    const accountId = randomUUID();
    const taskId = randomUUID();
    const planVersionId = randomUUID();
    await migrationClient.query("BEGIN");
    await migrationClient.query("SET CONSTRAINTS ALL DEFERRED");
    await migrationClient.query(
      'INSERT INTO "Account" ("id", "updatedAt") VALUES ($1, CURRENT_TIMESTAMP)',
      [accountId],
    );
    await migrationClient.query(
      'INSERT INTO "Task" ("id", "title", "currentPlanVersionId", "createdByAccountId", "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
      [taskId, "S2 pre-migration plan", planVersionId, accountId],
    );
    await migrationClient.query(
      'INSERT INTO "TaskPlanVersion" ("id", "taskId", "versionNo", "status", "reason", "createdByAccountId", "updatedAt") VALUES ($1, $2, 1, \'CURRENT\', $3, $4, CURRENT_TIMESTAMP)',
      [planVersionId, taskId, "pre-migration legacy row", accountId],
    );
    await migrationClient.query("COMMIT");

    await executeMigrationSql(
      migrationClient,
      await readFile(
        path.join(MIGRATIONS_DIR, S2_MIGRATION_NAME, "migration.sql"),
        "utf8",
      ),
    );
    const migratedPlan = await migrationClient.query<{
      plannedStartAt: Date | null;
      activatedAt: Date | null;
      status: string;
    }>(
      'SELECT "plannedStartAt", "activatedAt", "status"::text AS status FROM "TaskPlanVersion" WHERE "id" = $1',
      [planVersionId],
    );
    expect(migratedPlan.rows).toEqual([
      {
        plannedStartAt: null,
        activatedAt: null,
        status: "CURRENT",
      },
    ]);
  } finally {
    await migrationClient?.end().catch(() => undefined);
    await adminClient.query(`DROP DATABASE IF EXISTS "${temporaryDatabaseName}"`);
    const remains = await adminClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [temporaryDatabaseName],
    );
    expect(remains.rowCount).toBe(0);
    await adminClient.end();
  }
});

test("S2 contract values are a browser-safe leaf aligned with Prisma enums", async () => {
  const source = await readFile(
    path.join(
      process.cwd(),
      "lib/project-management/types/contract-values.ts",
    ),
    "utf8",
  );
  expect(source).not.toMatch(/\bfrom\s+["']/);
  expect(source).not.toContain("zod");
  expect(source).not.toContain("@prisma/client");
  expect(source).not.toContain("validations/");

  expect(taskStatusValues).toEqual(Object.values(TaskStatus));
  expect(taskPriorityValues).toEqual(Object.values(TaskPriority));
  expect(taskNodeTypeValues).toEqual(Object.values(TaskNodeType));
  expect(taskNodeStatusValues).toEqual(Object.values(TaskNodeStatus));
  expect(taskMemberRoleValues).toEqual([
    TaskMemberRole.OWNER,
    TaskMemberRole.PARTICIPANT,
  ]);
  expect(terminationOutcomeValues).toEqual(Object.values(TerminationOutcome));
  expect(workSegmentTypeValues).toEqual(Object.values(WorkSegmentType));
  expect(workSegmentStatusValues).toEqual(Object.values(WorkSegmentStatus));
  expect(workSegmentRoleValues).toEqual(Object.values(WorkSegmentRole));
  expect(timeCanvasScopeKindValues).toEqual([
    "TASK_SCOPED",
    "PERSONAL",
    "DASHBOARD",
    "RESOURCE_PLANNER",
  ]);
  expect(standaloneTimeCanvasScopeKindValues).toEqual([
    "PERSONAL",
    "DASHBOARD",
    "RESOURCE_PLANNER",
  ]);
  expect(timeCanvasGroupByValues).toEqual(["PERSON", "TASK"]);
  expect(segmentValidationWorkSegmentTypeValues).toBe(workSegmentTypeValues);
});

test("S2 Task mutations expose session-bound Server Actions and anchor loads recheck authorization", async () => {
  const taskActionsSource = await readFile(
    path.join(process.cwd(), "app/actions/project-management/tasks.ts"),
    "utf8",
  );
  for (const actionName of [
    "updateTaskDraftMetadata",
    "replaceTaskDraftMembers",
    "replaceTaskDraftPlan",
    "updateTaskMetadata",
    "replaceTaskMembers",
    "replaceTaskTags",
  ]) {
    expect(taskActionsSource).toMatch(
      new RegExp(`export async function ${actionName}\\(\\s*input: unknown`),
    );
  }
  expect(taskActionsSource).toContain("getCurrentProjectManagementActor()");
  expect(taskActionsSource).toContain("runProjectManagementAction({");
  expect(taskActionsSource).toContain("revalidateProjectManagement(taskId)");

  const canvasQuerySource = await readFile(
    path.join(
      process.cwd(),
      "lib/project-management/queries/time-canvas-queries.ts",
    ),
    "utf8",
  );
  const anchorLoaderSource = canvasQuerySource.slice(
    canvasQuerySource.indexOf("async function loadTaskAnchors"),
    canvasQuerySource.indexOf("function toTaskAnchorDto"),
  );
  expect(anchorLoaderSource).not.toBe("");
  expect(anchorLoaderSource.match(/taskReadableWhere\(actor\)/g)).toHaveLength(2);
});

test("S2 plan and canvas validations enforce absolute chronology, identities and limits", () => {
  const ownerPersonId = randomUUID();
  const baseDraft = {
    title: "S2 validation Task",
    description: "契约验证",
    team: "英雄",
    techGroup: "电控",
    priority: "HIGH",
    members: [{ personId: ownerPersonId, role: "OWNER" }],
    milestones: [
      milestone("同日节点 A", "2026-08-01T10:00:00.000Z"),
      milestone("同日节点 B", "2026-08-01T10:00:00.000Z"),
    ],
    termination: termination("2026-08-01T10:00:00.000Z"),
    plannedStartAt: "2026-08-01T09:00:00.000Z",
    idempotencyKey: randomUUID(),
  };
  const parsedDraft = createTaskDraftInputSchema.parse(baseDraft);
  expect(parsedDraft.relatedTaskId).toBeNull();

  const absoluteDateTime = absoluteDateTimeSchema("时间必须包含时区");
  for (const invalidDateTime of ["2026-08-01", "2026-08-01T10:00:00"]) {
    expect(absoluteDateTime.safeParse(invalidDateTime).success).toBe(false);
    expect(
      createTaskDraftInputSchema.safeParse({
        ...baseDraft,
        plannedStartAt: invalidDateTime,
      }).success,
    ).toBe(false);
  }
  expect(
    createTaskDraftInputSchema.safeParse({
      ...baseDraft,
      milestones: [milestone("本地时间节点", "2026-08-01T10:00:00")],
    }).success,
  ).toBe(false);
  expect(
    createTaskDraftInputSchema.safeParse({
      ...baseDraft,
      termination: termination("2026-08-01"),
    }).success,
  ).toBe(false);
  expect(
    absoluteDateTime.parse("2026-08-01T10:00:00+08:00").toISOString(),
  ).toBe("2026-08-01T02:00:00.000Z");
  const crossDayDraft = createTaskDraftInputSchema.parse({
    ...baseDraft,
    plannedStartAt: "2026-08-01T23:30:00+08:00",
    milestones: [
      milestone("跨日节点", "2026-08-02T00:00:00+08:00"),
    ],
    termination: termination("2026-08-02T00:00:00+08:00"),
  });
  expect(crossDayDraft.milestones[0]?.expectedCompletedAt.toISOString()).toBe(
    "2026-08-01T16:00:00.000Z",
  );
  const revision = revisionDraftInputSchema.parse({
    taskId: randomUUID(),
    basePlanVersionId: randomUUID(),
    baseTaskLockVersion: 0,
    revisedFromNodeId: randomUUID(),
    reason: "跨日调整计划",
    plannedStartAt: "2026-08-03T23:00:00+08:00",
    replacementMilestones: [
      milestone("Revision 跨日节点", "2026-08-04T00:00:00+08:00"),
    ],
    termination: termination("2026-08-04T01:00:00+08:00"),
    idempotencyKey: randomUUID(),
  });
  expect(revision.plannedStartAt.toISOString()).toBe(
    "2026-08-03T15:00:00.000Z",
  );

  expect(
    createTaskDraftInputSchema.safeParse({
      ...baseDraft,
      members: [
        { personId: ownerPersonId, role: "OWNER" },
        { personId: randomUUID(), role: "OWNER" },
      ],
    }).success,
  ).toBe(true);
  expect(
    createTaskDraftInputSchema.safeParse({
      ...baseDraft,
      milestones: [milestone("过早节点", "2026-08-01T08:00:00.000Z")],
    }).success,
  ).toBe(false);
  expect(
    createTaskDraftInputSchema.safeParse({
      ...baseDraft,
      milestones: [
        milestone("较晚节点", "2026-08-02T10:00:00.000Z"),
        milestone("倒序节点", "2026-08-01T10:00:00.000Z"),
      ],
    }).success,
  ).toBe(false);
  expect(
    createTaskDraftInputSchema.safeParse({
      ...baseDraft,
      termination: termination("2026-08-01T09:59:59.999Z"),
    }).success,
  ).toBe(false);
  expect(
    revisionDraftInputSchema.safeParse({
      taskId: randomUUID(),
      basePlanVersionId: randomUUID(),
      baseTaskLockVersion: 0,
      revisedFromNodeId: randomUUID(),
      reason: "调整计划",
      replacementMilestones: [
        milestone("Revision 节点", "2026-08-03T10:00:00.000Z"),
      ],
      termination: termination("2026-08-04T10:00:00.000Z"),
      idempotencyKey: randomUUID(),
    }).success,
  ).toBe(false);

  const retainedNodeId = randomUUID();
  const draftPlanInput = {
    taskId: randomUUID(),
    planVersionId: randomUUID(),
    expectedLockVersion: 3,
    plannedStartAt: "2026-08-01T09:00:00.000Z",
    milestones: [
      {
        ...milestone("保留节点", "2026-08-02T10:00:00.000Z"),
        nodeId: retainedNodeId,
      },
      {
        ...milestone("新增节点", "2026-08-03T10:00:00.000Z"),
        clientKey: "new-milestone-1",
      },
    ],
    termination: {
      ...termination("2026-08-04T10:00:00.000Z"),
      clientKey: "new-termination",
    },
  };
  const draftPlan = replaceTaskDraftPlanInputSchema.parse(draftPlanInput);
  expect(draftPlan.milestones[0]?.nodeId).toBe(retainedNodeId);
  expect(draftPlan.milestones[1]?.clientKey).toBe("new-milestone-1");
  expect(
    replaceTaskDraftPlanInputSchema.safeParse({
      ...draftPlanInput,
      plannedStartAt: "2026-08-01T09:00:00",
    }).success,
  ).toBe(false);
  expect(
    replaceTaskDraftPlanInputSchema.safeParse({
      ...draftPlanInput,
      milestones: [
        {
          ...milestone("无时区节点", "2026-08-02T10:00:00"),
          nodeId: retainedNodeId,
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    replaceTaskDraftPlanInputSchema.safeParse({
      ...draftPlanInput,
      termination: {
        ...termination("2026-08-04"),
        clientKey: "new-termination",
      },
    }).success,
  ).toBe(false);
  for (const forbiddenField of [
    { title: "计划 replace 不接受 metadata" },
    { idempotencyKey: randomUUID() },
  ]) {
    expect(
      replaceTaskDraftPlanInputSchema.safeParse({
        ...draftPlanInput,
        ...forbiddenField,
      }).success,
    ).toBe(false);
  }
  expect(
    replaceTaskDraftPlanInputSchema.safeParse({
      ...draftPlanInput,
      milestones: [
        {
          ...milestone("身份冲突节点", "2026-08-02T10:00:00.000Z"),
          nodeId: randomUUID(),
          clientKey: "must-not-have-both",
        },
      ],
    }).success,
  ).toBe(false);

  const samePersonId = randomUUID();
  const memberMutationInput = {
    taskId: randomUUID(),
    expectedLockVersion: 1,
    members: [{ personId: samePersonId, role: "OWNER" as const }],
  };
  for (const schema of [
    replaceTaskDraftMembersInputSchema,
    replaceTaskMembersInputSchema,
  ]) {
    for (const forbiddenField of [
      { id: randomUUID() },
      { accountId: randomUUID() },
      { removedAt: "2026-08-01T10:00:00.000Z" },
      { createdAt: "2026-08-01T10:00:00.000Z" },
      { updatedAt: "2026-08-01T10:00:00.000Z" },
    ]) {
      const result = schema.safeParse({
        ...memberMutationInput,
        members: [
          {
            ...memberMutationInput.members[0],
            ...forbiddenField,
          },
        ],
      });
      expect(
        result.success,
        `member mutation accepted ${Object.keys(forbiddenField)[0]}`,
      ).toBe(false);
    }
  }
  const compatibleCreateDraft = createTaskDraftInputSchema.parse({
    ...baseDraft,
    members: [
      {
        personId: ownerPersonId,
        role: "OWNER",
        accountId: randomUUID(),
      },
    ],
  });
  expect(compatibleCreateDraft.members[0]).toEqual({
    personId: ownerPersonId,
    role: "OWNER",
  });
  expect(
    replaceTaskMembersInputSchema.safeParse({
      taskId: randomUUID(),
      expectedLockVersion: 1,
      members: [
        { personId: samePersonId, role: "OWNER" },
        { personId: samePersonId, role: "PARTICIPANT" },
      ],
    }).success,
  ).toBe(false);
  expect(
    replaceTaskMembersInputSchema.safeParse({
      taskId: randomUUID(),
      expectedLockVersion: 1,
      members: [
        { personId: samePersonId, role: "OWNER" },
        { personId: samePersonId, role: "OWNER" },
      ],
    }).success,
  ).toBe(false);
  expect(
    replaceTaskMembersInputSchema.safeParse({
      taskId: randomUUID(),
      expectedLockVersion: 1,
      members: [
        { personId: randomUUID(), role: "OWNER" },
        ...Array.from({ length: 50 }, () => ({
          personId: randomUUID(),
          role: "PARTICIPANT" as const,
        })),
      ],
    }).success,
  ).toBe(true);

  const rangeStart = "2026-01-01T00:00:00.000Z";
  const rangeEnd = "2027-01-02T00:00:00.000Z";
  const canvas = getTimeCanvasDataInputSchema.parse({
    scope: { kind: "PERSONAL" },
    rangeStart,
    rangeEnd,
    groupBy: "PERSON",
  });
  expect(canvas.rowLimit).toBe(25);
  expect(canvas.rangeEnd.getTime() - canvas.rangeStart.getTime()).toBe(
    366 * 24 * 60 * 60 * 1_000,
  );
  const resourcePlannerCanvas = getTimeCanvasDataInputSchema.parse({
    scope: { kind: "RESOURCE_PLANNER" },
    rangeStart,
    rangeEnd,
    groupBy: "TASK",
    cursor: "resource-task-row-next",
    rowLimit: 50,
  });
  expect(resourcePlannerCanvas).toMatchObject({
    scope: { kind: "RESOURCE_PLANNER" },
    groupBy: "TASK",
    cursor: "resource-task-row-next",
    rowLimit: 50,
  });
  expect(
    getTimeCanvasDataInputSchema.safeParse({
      scope: { kind: "RESOURCE_PLANNER" },
      rangeStart,
      rangeEnd,
      groupBy: "PERSON",
      personLimit: 25,
    }).success,
  ).toBe(false);
  expect(
    getTimeCanvasDataInputSchema.safeParse({
      scope: { kind: "RESOURCE_PLANNER" },
      rangeStart,
      rangeEnd,
      groupBy: "PERSON",
      rowLimit: 51,
    }).success,
  ).toBe(false);
  expect(
    getTimeCanvasDataInputSchema.safeParse({
      scope: { kind: "RESOURCE_PLANNER" },
      rangeStart,
      rangeEnd,
      groupBy: "TASK",
      includeBusyBlocks: true,
    }).success,
  ).toBe(false);
  const crossDayCanvas = getTimeCanvasDataInputSchema.parse({
    scope: { kind: "DASHBOARD" },
    rangeStart: "2026-08-01T23:00:00+08:00",
    rangeEnd: "2026-08-02T01:00:00+08:00",
    groupBy: "PERSON",
  });
  expect(
    crossDayCanvas.rangeEnd.getTime() - crossDayCanvas.rangeStart.getTime(),
  ).toBe(2 * 60 * 60 * 1_000);
  for (const invalidRangeStart of [
    "2026-08-01",
    "2026-08-01T23:00:00",
  ]) {
    expect(
      getTimeCanvasDataInputSchema.safeParse({
        scope: { kind: "DASHBOARD" },
        rangeStart: invalidRangeStart,
        rangeEnd: "2026-08-02T01:00:00+08:00",
        groupBy: "PERSON",
      }).success,
    ).toBe(false);
  }
  expect(
    getTimeCanvasDataInputSchema.safeParse({
      scope: { kind: "DASHBOARD" },
      rangeStart,
      rangeEnd: "2027-01-02T00:00:00.001Z",
      groupBy: "TASK",
    }).success,
  ).toBe(false);
  expect(
    getTimeCanvasDataInputSchema.safeParse({
      scope: { kind: "DASHBOARD" },
      rangeStart,
      rangeEnd,
      groupBy: "PERSON",
      personIds: Array.from({ length: 51 }, () => randomUUID()),
    }).success,
  ).toBe(false);
  for (const field of ["taskIds", "tagIds"] as const) {
    expect(
      getTimeCanvasDataInputSchema.safeParse({
        scope: { kind: "DASHBOARD" },
        rangeStart,
        rangeEnd,
        groupBy: "PERSON",
        [field]: Array.from({ length: 51 }, () => randomUUID()),
      }).success,
    ).toBe(false);
  }
  expect(
    getTimeCanvasDataInputSchema.safeParse({
      scope: { kind: "DASHBOARD" },
      rangeStart,
      rangeEnd,
      groupBy: "PERSON",
      nodeIds: Array.from({ length: 51 }, () => randomUUID()),
    }).success,
  ).toBe(true);
  expect(
    searchPeopleInputSchema.parse({ purpose: "VISIBLE" }).limit,
  ).toBe(25);
  expect(searchPeopleInputSchema.safeParse({}).success).toBe(false);
  for (const disallowedInput of [
    { purpose: "VISIBLE", team: "英雄" },
    { purpose: "VISIBLE", techGroup: "电控" },
    { purpose: "VISIBLE", activeOnly: false },
    { purpose: "VISIBLE", limit: 51 },
  ]) {
    expect(searchPeopleInputSchema.safeParse(disallowedInput).success).toBe(false);
  }
  expect(listTagOptionsInputSchema.parse({}).includeArchived).toBe(false);
  expect(MAX_TIME_CANVAS_VISIBLE_SEGMENTS).toBe(5_000);
  expect(timeCanvasVisibleSegmentCountSchema.parse(5_000)).toBe(5_000);
  expect(timeCanvasVisibleSegmentCountSchema.safeParse(5_001).success).toBe(
    false,
  );
});

test("S2 canvas output schemas retain pagination, grouping and privacy invariants", () => {
  const updatedAt = "2026-08-01T08:30:00.000Z";
  const segmentPersonId = randomUUID();
  const segmentTaskId = randomUUID();
  const segment = timeSegmentDtoSchema.parse({
    kind: "SEGMENT",
    visibility: "FULL",
    id: randomUUID(),
    personId: segmentPersonId,
    type: "PLANNED",
    status: "PLANNED",
    startAt: "2026-08-01T09:00:00.000Z",
    endAt: "2026-08-01T10:00:00.000Z",
    content: "可见投入",
    role: "OWNER",
    customRole: null,
    priority: "HIGH",
    expectedOutput: "",
    actualOutput: "",
    completionPercent: null,
    taskId: segmentTaskId,
    nodeId: randomUUID(),
    associationNeedsReview: false,
    tags: [],
    permissions: segmentPermissions(),
    updatedAt,
    versionToken: updatedAt,
  });
  expect(segment).toMatchObject({
    content: "可见投入",
    versionToken: updatedAt,
    permissions: segmentPermissions(),
  });
  for (const forbiddenField of [
    { allocation: 50 },
    { conflictIds: [] },
    { capabilities: segment.permissions },
  ]) {
    expect(
      timeSegmentDtoSchema.safeParse({ ...segment, ...forbiddenField }).success,
    ).toBe(false);
  }
  expect(
    timeSegmentDtoSchema.safeParse({
      ...segment,
      versionToken: "2026-08-01T08:30:00.001Z",
    }).success,
  ).toBe(false);
  expect(
    timeSegmentDtoSchema.safeParse({
      ...segment,
      permissions: { ...segment.permissions, canResolveConflict: true },
    }).success,
  ).toBe(false);

  const busyPersonId = randomUUID();
  const busy = busyBlockDtoSchema.parse({
    kind: "BUSY",
    visibility: "BUSY_ONLY",
    personId: busyPersonId,
    startAt: "2026-08-01T09:00:00.000Z",
    endAt: "2026-08-01T10:00:00.000Z",
  });
  expect(Object.keys(busy).sort()).toEqual([...BUSY_BLOCK_DTO_FIELDS].sort());
  const busyForbiddenFields: Array<Record<string, unknown>> = [
    { id: randomUUID() },
    { title: "不得泄露" },
    { content: "不得泄露" },
    { taskId: randomUUID() },
    { nodeId: randomUUID() },
    { tags: [{ id: randomUUID(), name: "不得泄露" }] },
    { creator: { id: randomUUID() } },
    { createdByAccountId: randomUUID() },
    { createdAt: updatedAt },
    { updatedAt },
    { versionToken: updatedAt },
    { proposal: { startAt: updatedAt } },
    { allocation: 50 },
    { conflictSummary: { count: 1, severity: "HIGH" } },
  ];
  for (const forbiddenField of busyForbiddenFields) {
    const result = busyBlockDtoSchema.safeParse({ ...busy, ...forbiddenField });
    expect(
      result.success,
      `Busy accepted ${Object.keys(forbiddenField)[0]}`,
    ).toBe(false);
  }

  const canvasResponseFields = {
    scope: { kind: "RESOURCE_PLANNER" },
    timezone: "Asia/Shanghai",
    range: {
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-08-02T00:00:00.000Z",
    },
    anchors: [],
    nextCursor: "resource-row-next",
    generatedAt: updatedAt,
  } as const;
  const personGroupedCanvas = timeCanvasDataDtoSchema.parse({
    ...canvasResponseFields,
    groupBy: "PERSON",
    rows: [
      canvasRow("PERSON", segmentPersonId, "完整可见人员行"),
      canvasRow("PERSON", busyPersonId, "脱敏人员行"),
    ],
    segments: [segment, busy],
  });
  expect(personGroupedCanvas.nextCursor).toBe("resource-row-next");
  expect(
    timeCanvasDataDtoSchema.safeParse({
      ...personGroupedCanvas,
      conflicts: [],
    }).success,
  ).toBe(false);
  expect(
    timeCanvasDataDtoSchema.safeParse({
      ...personGroupedCanvas,
      cursor: "legacy-row-cursor",
    }).success,
  ).toBe(false);
  expect(
    timeCanvasDataDtoSchema.safeParse({
      ...canvasResponseFields,
      groupBy: "PERSON",
      rows: [
        canvasRow("PERSON", segmentPersonId, "重复人员行 A"),
        canvasRow("PERSON", segmentPersonId, "重复人员行 B"),
      ],
      segments: [],
    }).success,
  ).toBe(false);

  const offPagePersonId = randomUUID();
  for (const offPageObject of [
    { ...segment, personId: offPagePersonId },
    { ...busy, personId: offPagePersonId },
  ]) {
    expect(
      timeCanvasDataDtoSchema.safeParse({
        ...canvasResponseFields,
        groupBy: "PERSON",
        rows: [canvasRow("PERSON", segmentPersonId, "当前 Person 页")],
        segments: [offPageObject],
      }).success,
      `${offPageObject.kind} 不得跨 Person 行分页返回`,
    ).toBe(false);
  }

  const boundedResponseFields = {
    ...canvasResponseFields,
    range: {
      startAt: "2026-08-01T09:00:00.000Z",
      endAt: "2026-08-01T11:00:00.000Z",
    },
    nextCursor: null,
  } as const;
  const currentPersonRows = [
    canvasRow("PERSON", segmentPersonId, "完整可见人员行"),
    canvasRow("PERSON", busyPersonId, "脱敏人员行"),
  ];
  const invalidIntervals = [
    {
      startAt: "2026-08-01T08:00:00.000Z",
      endAt: "2026-08-01T09:00:00.000Z",
    },
    {
      startAt: "2026-08-01T11:00:00.000Z",
      endAt: "2026-08-01T12:00:00.000Z",
    },
  ];
  const validIntervals = [
    {
      startAt: "2026-08-01T08:30:00.000Z",
      endAt: "2026-08-01T09:30:00.000Z",
    },
    {
      startAt: "2026-08-01T10:30:00.000Z",
      endAt: "2026-08-01T11:30:00.000Z",
    },
  ];
  for (const canvasObject of [segment, busy]) {
    for (const interval of invalidIntervals) {
      expect(
        timeCanvasDataDtoSchema.safeParse({
          ...boundedResponseFields,
          groupBy: "PERSON",
          rows: currentPersonRows,
          segments: [{ ...canvasObject, ...interval }],
        }).success,
        `${canvasObject.kind} 不得返回不与半开区间相交的对象`,
      ).toBe(false);
    }
    for (const interval of validIntervals) {
      expect(
        timeCanvasDataDtoSchema.safeParse({
          ...boundedResponseFields,
          groupBy: "PERSON",
          rows: currentPersonRows,
          segments: [{ ...canvasObject, ...interval }],
        }).success,
        `${canvasObject.kind} 应接受跨边界的对象`,
      ).toBe(true);
    }
  }

  expect(
    timeCanvasDataDtoSchema.safeParse({
      ...canvasResponseFields,
      groupBy: "TASK",
      rows: [canvasRow("TASK", segmentTaskId, "可见 Task 行")],
      segments: [busy],
    }).success,
  ).toBe(false);
  const secondTaskId = randomUUID();
  const secondTaskSegment = {
    ...segment,
    id: randomUUID(),
    taskId: secondTaskId,
  };
  expect(
    timeCanvasDataDtoSchema.safeParse({
      ...canvasResponseFields,
      groupBy: "TASK",
      rows: [
        canvasRow("TASK", segmentTaskId, "可见 Task 行一"),
        canvasRow("TASK", secondTaskId, "可见 Task 行二"),
      ],
      anchors: [
        canvasTaskAnchor(segmentTaskId),
        canvasTaskAnchor(secondTaskId),
      ],
      segments: [segment, secondTaskSegment],
    }).success,
  ).toBe(true);
  expect(
    timeCanvasDataDtoSchema.safeParse({
      ...canvasResponseFields,
      groupBy: "TASK",
      rows: [
        canvasRow("TASK", segmentTaskId, "可见 Task 行一"),
        canvasRow("TASK", secondTaskId, "可见 Task 行二"),
      ],
      anchors: [
        canvasTaskAnchor(segmentTaskId),
        canvasTaskAnchor(segmentTaskId),
      ],
      segments: [],
    }).success,
  ).toBe(false);
  expect(
    timeCanvasDataDtoSchema.safeParse({
      ...canvasResponseFields,
      groupBy: "TASK",
      rows: [canvasRow("TASK", segmentTaskId, "当前 Task 页")],
      segments: [secondTaskSegment],
    }).success,
  ).toBe(false);
  expect(
    timeCanvasDataDtoSchema.safeParse({
      ...canvasResponseFields,
      groupBy: "TASK",
      rows: [canvasRow("TASK", segmentTaskId, "当前 Task 页")],
      anchors: [canvasTaskAnchor(segmentTaskId, secondTaskId)],
      segments: [],
    }).success,
  ).toBe(false);
  expect(
    timeCanvasDataDtoSchema.safeParse({
      ...canvasResponseFields,
      groupBy: "TASK",
      rows: [canvasRow("TASK", segmentTaskId, "当前 Task 页")],
      anchors: [canvasTaskAnchor(secondTaskId)],
      segments: [],
    }).success,
  ).toBe(false);
  expect(
    timeCanvasDataDtoSchema.safeParse({
      ...canvasResponseFields,
      groupBy: "TASK",
      rows: [canvasRow("PERSON", segmentPersonId, "错误分组行")],
      segments: [segment],
    }).success,
  ).toBe(false);
});

test("removed allocation and includeConflicts inputs fail strict validation", () => {
  const segmentId = randomUUID();
  const personId = randomUUID();
  const startAt = "2026-08-01T09:00:00.000Z";
  const endAt = "2026-08-01T10:00:00.000Z";
  const plannedCreate = {
    personId,
    type: "PLANNED" as const,
    startAt,
    endAt,
    content: "旧客户端创建",
  };
  expect(createWorkSegmentInputSchema.safeParse(plannedCreate).success).toBe(true);
  expect(
    createWorkSegmentInputSchema.safeParse({ ...plannedCreate, allocation: 50 })
      .success,
  ).toBe(false);

  const actualCreate = {
    personId,
    startAt,
    endAt,
    content: "旧客户端 Actual 创建",
    actualOutput: "完成",
    completionPercent: 100,
    sources: [],
  };
  expect(createActualSegmentInputSchema.safeParse(actualCreate).success).toBe(true);
  expect(
    createActualSegmentInputSchema.safeParse({ ...actualCreate, allocation: 50 })
      .success,
  ).toBe(false);

  const batchCreate = { segments: [plannedCreate] };
  expect(batchCreatePlannedSegmentsInputSchema.safeParse(batchCreate).success).toBe(
    true,
  );
  expect(
    batchCreatePlannedSegmentsInputSchema.safeParse({
      segments: [{ ...plannedCreate, allocation: 50 }],
    }).success,
  ).toBe(false);

  const update = {
    segmentId,
    expectedUpdatedAt: startAt,
    content: "旧客户端更新",
  };
  expect(updateWorkSegmentInputSchema.safeParse(update).success).toBe(true);
  expect(
    updateWorkSegmentInputSchema.safeParse({ ...update, allocation: 50 }).success,
  ).toBe(false);

  const split = {
    segmentId,
    expectedUpdatedAt: startAt,
    reason: "拆分验证",
    parts: [
      { startAt, endAt: "2026-08-01T09:30:00.000Z" },
      { startAt: "2026-08-01T09:30:00.000Z", endAt },
    ],
  };
  expect(splitPlannedSegmentInputSchema.safeParse(split).success).toBe(true);
  expect(
    splitPlannedSegmentInputSchema.safeParse({
      ...split,
      parts: [{ ...split.parts[0], allocation: 50 }, split.parts[1]],
    }).success,
  ).toBe(false);

  const fullConfirmation = {
    segmentId,
    expectedUpdatedAt: startAt,
    actual: { actualOutput: "完整确认" },
  };
  expect(confirmPlannedSegmentInputSchema.safeParse(fullConfirmation).success).toBe(
    true,
  );
  expect(
    confirmPlannedSegmentInputSchema.safeParse({
      ...fullConfirmation,
      actual: { ...fullConfirmation.actual, allocation: 50 },
    }).success,
  ).toBe(false);

  const partialConfirmation = {
    segmentId,
    expectedUpdatedAt: startAt,
    coveredStartAt: startAt,
    coveredEndAt: endAt,
    actual: { actualOutput: "部分确认" },
  };
  expect(
    partiallyConfirmSegmentInputSchema.safeParse(partialConfirmation).success,
  ).toBe(true);
  expect(
    partiallyConfirmSegmentInputSchema.safeParse({
      ...partialConfirmation,
      actual: { ...partialConfirmation.actual, allocation: 50 },
    }).success,
  ).toBe(false);

  const canvasInput = {
    scope: { kind: "PERSONAL" as const },
    rangeStart: startAt,
    rangeEnd: endAt,
    groupBy: "PERSON" as const,
  };
  expect(getTimeCanvasDataInputSchema.safeParse(canvasInput).success).toBe(true);
  expect(
    getTimeCanvasDataInputSchema.safeParse({
      ...canvasInput,
      includeConflicts: true,
    }).success,
  ).toBe(false);
});

test("S2 option page schemas expose only minimal public fields", () => {
  expect(personAccountBindingValues).toEqual(["UNBOUND", "BOUND"]);
  const personIds = Array.from({ length: 2 }, () => randomUUID());
  const personPage = personOptionPageSchema.parse({
    items: personAccountBindingValues.map((accountBinding, index) => ({
      id: personIds[index],
      displayName: `测试成员 ${accountBinding}`,
      avatar: null,
      status: "ACTIVE",
      accountBinding,
    })),
    nextCursor: "person-next",
  });
  expect(personPage).toEqual({
    items: personAccountBindingValues.map((accountBinding, index) => ({
      id: personIds[index],
      displayName: `测试成员 ${accountBinding}`,
      avatar: null,
      status: "ACTIVE",
      accountBinding,
    })),
    nextCursor: "person-next",
    hasMoreByQuery: false,
  });
  for (const forbiddenField of [
    { accountId: randomUUID() },
    { identity: { provider: "FEISHU" } },
    { openId: `ou_${randomUUID()}` },
    { unionId: `on_${randomUUID()}` },
    { team: "英雄" },
    { techGroup: "电控" },
    { createdAt: "2026-08-01T08:00:00.000Z" },
    { updatedAt: "2026-08-01T08:00:00.000Z" },
  ]) {
    const result = personOptionPageSchema.safeParse({
      items: [{ ...personPage.items[0], ...forbiddenField }],
      nextCursor: null,
    });
    expect(
      result.success,
      `Person option accepted ${Object.keys(forbiddenField)[0]}`,
    ).toBe(false);
  }
  expect(
    personOptionPageSchema.safeParse({
      items: [
        {
          id: randomUUID(),
          displayName: "停用成员",
          avatar: null,
          status: "INACTIVE",
          accountBinding: "BOUND",
        },
      ],
      nextCursor: null,
    }).success,
  ).toBe(true);
  for (const accountBinding of ["INACTIVE", "UNKNOWN", null]) {
    expect(
      personOptionPageSchema.safeParse({
        items: [{ ...personPage.items[0], accountBinding }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  }
  expect(
    personOptionPageSchema.safeParse({
      ...personPage,
      cursor: "legacy-cursor",
    }).success,
  ).toBe(false);

  const taskPage = taskOptionPageSchema.parse({
    items: [
      {
        id: randomUUID(),
        title: "可关联 Task",
        status: "ACTIVE",
        priority: "MEDIUM",
        team: "英雄",
        techGroup: "电控",
        activeMilestone: {
          nodeId: randomUUID(),
          goal: "当前节点",
          expectedCompletedAt: "2026-08-03T10:00:00.000Z",
        },
        permission: { canView: true },
      },
    ],
    nextCursor: "task-next",
  });
  expect(taskPage.nextCursor).toBe("task-next");
  for (const forbiddenField of [
    { createdByAccountId: randomUUID() },
    { members: [{ personId: personIds[0] }] },
    { createdAt: "2026-08-01T08:00:00.000Z" },
  ]) {
    const result = taskOptionPageSchema.safeParse({
      items: [{ ...taskPage.items[0], ...forbiddenField }],
      nextCursor: null,
    });
    expect(
      result.success,
      `Task option accepted ${Object.keys(forbiddenField)[0]}`,
    ).toBe(false);
  }
  expect(
    taskOptionPageSchema.safeParse({
      ...taskPage,
      cursor: "legacy-cursor",
    }).success,
  ).toBe(false);

  const tagPage = tagOptionPageSchema.parse({
    items: [
      {
        id: randomUUID(),
        name: "机械",
        color: "#334455",
        isArchived: false,
      },
    ],
    nextCursor: "tag-next",
  });
  expect(tagPage.nextCursor).toBe("tag-next");
  for (const forbiddenField of [
    { createdByAccountId: randomUUID() },
    { createdAt: "2026-08-01T08:00:00.000Z" },
    { updatedAt: "2026-08-01T08:00:00.000Z" },
  ]) {
    const result = tagOptionPageSchema.safeParse({
      items: [{ ...tagPage.items[0], ...forbiddenField }],
      nextCursor: null,
    });
    expect(
      result.success,
      `Tag option accepted ${Object.keys(forbiddenField)[0]}`,
    ).toBe(false);
  }
  expect(
    tagOptionPageSchema.safeParse({
      ...tagPage,
      cursor: "legacy-cursor",
    }).success,
  ).toBe(false);
});

test("S2 structured errors and stale authoritative DTOs are stable and safe", async () => {
  expect(PROJECT_MANAGEMENT_ERROR_CODES).toEqual(
    expect.arrayContaining([
      "PLAN_CHRONOLOGY_INVALID",
      "STALE_TASK",
      "STALE_SEGMENT",
      "ASSOCIATION_INVALID",
      "QUERY_LIMIT_EXCEEDED",
    ]),
  );
  expect(
    await mappedActionErrorCode(() =>
      createTaskDraftInputSchema.parse({
        title: "非法时间顺序",
        team: "英雄",
        techGroup: "电控",
        members: [{ personId: randomUUID(), role: "OWNER" }],
        plannedStartAt: "2026-08-02T10:00:00.000Z",
        milestones: [
          milestone("过早节点", "2026-08-01T10:00:00.000Z"),
        ],
        termination: termination("2026-08-03T10:00:00.000Z"),
        idempotencyKey: randomUUID(),
      }),
    ),
  ).toBe("PLAN_CHRONOLOGY_INVALID");
  expect(
    await mappedActionErrorCode(() =>
      getTimeCanvasDataInputSchema.parse({
        scope: { kind: "DASHBOARD" },
        rangeStart: "2026-01-01T00:00:00.000Z",
        rangeEnd: "2027-01-03T00:00:00.000Z",
        groupBy: "PERSON",
      }),
    ),
  ).toBe("QUERY_LIMIT_EXCEEDED");
  expect(
    await mappedActionErrorCode(() =>
      timeCanvasVisibleSegmentCountSchema.parse(5_001),
    ),
  ).toBe("QUERY_LIMIT_EXCEEDED");
  expect(
    await mappedActionErrorCode(() =>
      getTimeCanvasDataInputSchema.parse({
        scope: { kind: "DASHBOARD" },
        rangeStart: "2026-01-01T00:00:00.000Z",
        rangeEnd: "2027-01-03T00:00:00.000Z",
        groupBy: "PERSON",
        personIds: [
          "8df48bca-c341-4c41-bd44-77ad0df149be",
          "8df48bca-c341-4c41-bd44-77ad0df149be",
        ],
      }),
    ),
  ).toBe("VALIDATION_ERROR");
  expect(
    await mappedActionErrorCode(() =>
      z
        .string()
        .superRefine((_value, ctx) => {
          ctx.addIssue({
            code: "custom",
            message: "伪造的稳定业务码",
            params: {
              projectManagementErrorCode: "QUERY_LIMIT_EXCEEDED",
              projectManagementStructuredIssueIdentity:
                "project-management-structured-validation-issue",
            },
          });
        })
        .parse("forged"),
    ),
  ).toBe("VALIDATION_ERROR");
  expect(
    await mappedActionErrorCode(() =>
      z
        .string()
        .superRefine((_value, ctx) => {
          addStructuredProjectManagementIssue({
            ctx,
            code: "PLAN_CHRONOLOGY_INVALID",
            message: "计划时间错误",
          });
          addStructuredProjectManagementIssue({
            ctx,
            code: "QUERY_LIMIT_EXCEEDED",
            message: "查询超过上限",
          });
        })
        .parse("different-structured-codes"),
    ),
  ).toBe("VALIDATION_ERROR");

  const taskUpdatedAt = new Date("2026-08-01T08:00:00.000Z");
  const taskUpdatedAtIso = taskUpdatedAt.toISOString();
  const rawTask = {
    id: randomUUID(),
    lockVersion: 4,
    updatedAt: taskUpdatedAt,
    title: "不得越过 action boundary",
    members: [{ personId: randomUUID(), accountId: randomUUID() }],
    createdAt: new Date("2026-08-01T07:00:00.000Z"),
    decimalLike: { toJSON: () => "99.99" },
  };
  expect(
    staleTaskAuthoritativeDtoSchema.safeParse({
      kind: "TASK",
      ...rawTask,
    }).success,
  ).toBe(false);
  expect(
    staleTaskAuthoritativeDtoSchema.safeParse({
      kind: "TASK",
      id: rawTask.id,
      lockVersion: rawTask.lockVersion,
      updatedAt: taskUpdatedAt,
    }).success,
  ).toBe(false);
  const taskResult = await runProjectManagementAction({
    event: "test.pm.s2.stale_task",
    action: "testS2StaleTask",
    callback: async () => {
      throw staleTaskError(rawTask, "此 message 可变化但 code 稳定");
    },
  });
  expect(taskResult).toEqual({
    ok: false,
    error: {
      code: "STALE_TASK",
      message: "此 message 可变化但 code 稳定",
      current: {
        kind: "TASK",
        id: rawTask.id,
        lockVersion: 4,
        updatedAt: taskUpdatedAtIso,
      },
    },
  });
  expect(JSON.stringify(taskResult)).not.toContain("99.99");
  expect(JSON.stringify(taskResult)).not.toContain("不得越过");
  const structurallyExtendedCurrent = {
    kind: "TASK" as const,
    id: rawTask.id,
    lockVersion: 5,
    updatedAt: taskUpdatedAtIso,
    sensitiveRelation: { title: "action-result 必须再次过滤" },
  };
  const directErrorResult = await runProjectManagementAction({
    event: "test.pm.s2.direct_stale_task",
    action: "testS2DirectStaleTask",
    callback: async () => {
      throw new ProjectManagementServiceError(
        "STALE_TASK",
        "直接构造错误",
        undefined,
        structurallyExtendedCurrent,
      );
    },
  });
  expect(directErrorResult).toEqual({
    ok: false,
    error: {
      code: "STALE_TASK",
      message: "直接构造错误",
      current: {
        kind: "TASK",
        id: rawTask.id,
        lockVersion: 5,
        updatedAt: taskUpdatedAtIso,
      },
    },
  });
  expect(JSON.stringify(directErrorResult)).not.toContain("再次过滤");

  const invalidStaleTaskResult = await runProjectManagementAction({
    event: "test.pm.s2.invalid_stale_task_current",
    action: "testS2InvalidStaleTaskCurrent",
    callback: async () => {
      throw staleTaskError({
        id: rawTask.id,
        lockVersion: 6,
        updatedAt: new Date(Number.NaN),
      });
    },
  });
  expect(invalidStaleTaskResult).toEqual({
    ok: false,
    error: {
      code: "STALE_TASK",
      message: "Task 已被他人修改，请刷新后重试",
    },
  });
  const invalidDirectCurrent = {
    kind: "TASK" as const,
    id: "invalid-task-id",
    lockVersion: -1,
    updatedAt: "invalid-date",
  };
  const invalidDirectCurrentResult = await runProjectManagementAction({
    event: "test.pm.s2.invalid_direct_current",
    action: "testS2InvalidDirectCurrent",
    callback: async () => {
      throw new ProjectManagementServiceError(
        "STALE_TASK",
        "权威对象无效但错误码必须保留",
        undefined,
        invalidDirectCurrent,
      );
    },
  });
  expect(invalidDirectCurrentResult).toEqual({
    ok: false,
    error: {
      code: "STALE_TASK",
      message: "权威对象无效但错误码必须保留",
    },
  });
  const throwingCurrent = new Proxy(structurallyExtendedCurrent, {
    get() {
      throw new Error("读取 current 时发生异常");
    },
  });
  const throwingCurrentResult = await runProjectManagementAction({
    event: "test.pm.s2.throwing_authoritative_current",
    action: "testS2ThrowingAuthoritativeCurrent",
    callback: async () => {
      throw new ProjectManagementServiceError(
        "STALE_TASK",
        "current 序列化失败不得覆盖稳定错误",
        undefined,
        throwingCurrent,
      );
    },
  });
  expect(throwingCurrentResult).toEqual({
    ok: false,
    error: {
      code: "STALE_TASK",
      message: "current 序列化失败不得覆盖稳定错误",
    },
  });
  const errorWithThrowingCurrentGetter = new ProjectManagementServiceError(
    "STALE_TASK",
    "current getter 失败不得覆盖稳定错误",
  );
  Object.defineProperty(errorWithThrowingCurrentGetter, "current", {
    configurable: true,
    get() {
      throw new Error("ProjectManagementServiceError.current getter 异常");
    },
  });
  const throwingCurrentGetterResult = await runProjectManagementAction({
    event: "test.pm.s2.throwing_authoritative_current_getter",
    action: "testS2ThrowingAuthoritativeCurrentGetter",
    callback: async () => {
      throw errorWithThrowingCurrentGetter;
    },
  });
  expect(throwingCurrentGetterResult).toEqual({
    ok: false,
    error: {
      code: "STALE_TASK",
      message: "current getter 失败不得覆盖稳定错误",
    },
  });

  const segmentUpdatedAt = new Date("2026-08-01T09:00:00.000Z");
  const segmentUpdatedAtIso = segmentUpdatedAt.toISOString();
  const rawSegment = {
    id: randomUUID(),
    updatedAt: segmentUpdatedAt,
    versionToken: "caller-controlled-token",
    content: "不得越过 action boundary",
    taskId: randomUUID(),
    nodeId: randomUUID(),
    tags: [{ id: randomUUID(), name: "内部 Tag" }],
    createdByAccountId: randomUUID(),
    relation: { task: { title: "敏感关系" } },
    decimalLike: { toJSON: () => "88.88" },
  };
  expect(
    staleSegmentAuthoritativeDtoSchema.safeParse({
      kind: "SEGMENT",
      ...rawSegment,
    }).success,
  ).toBe(false);
  expect(
    staleSegmentAuthoritativeDtoSchema.safeParse({
      kind: "SEGMENT",
      id: rawSegment.id,
      updatedAt: segmentUpdatedAt,
      versionToken: segmentUpdatedAtIso,
    }).success,
  ).toBe(false);
  const segmentResult = await runProjectManagementAction({
    event: "test.pm.s2.stale_segment",
    action: "testS2StaleSegment",
    callback: async () => {
      throw staleSegmentError(rawSegment);
    },
  });
  expect(segmentResult).toEqual({
    ok: false,
    error: {
      code: "STALE_SEGMENT",
      message: "投入记录已被他人修改，请刷新后重试",
      current: {
        kind: "SEGMENT",
        id: rawSegment.id,
        updatedAt: segmentUpdatedAtIso,
        versionToken: segmentUpdatedAtIso,
      },
    },
  });
  expect(JSON.stringify(segmentResult)).not.toContain("caller-controlled-token");
  expect(JSON.stringify(segmentResult)).not.toContain("敏感关系");
  const structurallyExtendedSegmentCurrent = {
    kind: "SEGMENT" as const,
    id: rawSegment.id,
    updatedAt: segmentUpdatedAtIso,
    versionToken: segmentUpdatedAtIso,
    sensitiveRelation: { task: { title: "Segment action boundary 脱敏" } },
  };
  const directSegmentResult = await runProjectManagementAction({
    event: "test.pm.s2.direct_stale_segment",
    action: "testS2DirectStaleSegment",
    callback: async () => {
      throw new ProjectManagementServiceError(
        "STALE_SEGMENT",
        "直接构造 Segment stale 错误",
        undefined,
        structurallyExtendedSegmentCurrent,
      );
    },
  });
  expect(directSegmentResult).toEqual({
    ok: false,
    error: {
      code: "STALE_SEGMENT",
      message: "直接构造 Segment stale 错误",
      current: {
        kind: "SEGMENT",
        id: rawSegment.id,
        updatedAt: segmentUpdatedAtIso,
        versionToken: segmentUpdatedAtIso,
      },
    },
  });
  expect(JSON.stringify(directSegmentResult)).not.toContain(
    "Segment action boundary 脱敏",
  );

  const incompatibleCurrentCases = [
    {
      code: "STALE_TASK",
      current: structurallyExtendedSegmentCurrent,
      message: "STALE_TASK 不接受 Segment current",
    },
    {
      code: "STALE_SEGMENT",
      current: structurallyExtendedCurrent,
      message: "STALE_SEGMENT 不接受 Task current",
    },
    {
      code: "FORBIDDEN",
      current: structurallyExtendedCurrent,
      message: "FORBIDDEN 不返回 current",
    },
    {
      code: "NOT_FOUND",
      current: structurallyExtendedSegmentCurrent,
      message: "NOT_FOUND 不返回 current",
    },
    {
      code: "VALIDATION_ERROR",
      current: structurallyExtendedCurrent,
      message: "其他错误码不返回 current",
    },
  ] as const;
  for (const currentCase of incompatibleCurrentCases) {
    const result = await runProjectManagementAction({
      event: "test.pm.s2.incompatible_authoritative_current",
      action: "testS2IncompatibleAuthoritativeCurrent",
      callback: async () => {
        throw new ProjectManagementServiceError(
          currentCase.code,
          currentCase.message,
          undefined,
          currentCase.current,
        );
      },
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: currentCase.code,
        message: currentCase.message,
      },
    });
    expect(JSON.stringify(result)).not.toContain("sensitiveRelation");
  }

  const invalidStaleSegmentResult = await runProjectManagementAction({
    event: "test.pm.s2.invalid_stale_segment_current",
    action: "testS2InvalidStaleSegmentCurrent",
    callback: async () => {
      throw staleSegmentError({
        id: rawSegment.id,
        updatedAt: new Date(Number.NaN),
      });
    },
  });
  expect(invalidStaleSegmentResult).toEqual({
    ok: false,
    error: {
      code: "STALE_SEGMENT",
      message: "投入记录已被他人修改，请刷新后重试",
    },
  });
});

function milestone(goal: string, expectedCompletedAt: string) {
  return {
    goal,
    completionCriteria: `${goal} 完成条件`,
    expectedCompletedAt,
    reviewRequirements: `${goal} 验收要求`,
    businessDescription: "",
  };
}

function termination(plannedAt: string) {
  return {
    plannedOutcomeCriteria: "全部节点完成",
    plannedAt,
    businessDescription: "",
  };
}

function segmentPermissions() {
  return {
    canViewDetails: true,
    canEdit: true,
    canMove: true,
    canResize: true,
    canSplit: true,
    canMerge: true,
    canCancel: true,
    canConfirm: true,
    canRelink: true,
    canSoftDelete: true,
  };
}

function canvasRow(kind: "PERSON" | "TASK", id: string, label: string) {
  return {
    id,
    kind,
    label,
    sublabel: null,
    capabilities: { canCreateSegment: false },
  };
}

function canvasTaskAnchor(taskId: string, nodeTaskId = taskId) {
  const updatedAt = "2026-08-01T08:30:00.000Z";
  return {
    id: taskId,
    title: "画布 Task anchor",
    status: "ACTIVE",
    priority: "HIGH",
    plannedStartAt: "2026-08-01T08:00:00.000Z",
    capabilities: {
      canView: true,
      canUpdateMetadata: false,
      canManageMembers: false,
      canManageTags: false,
      canActivate: false,
      canArchive: false,
      canCreateRevision: false,
    },
    nodes: [
      {
        id: randomUUID(),
        taskId: nodeTaskId,
        type: "MILESTONE",
        status: "ACTIVE",
        sequence: 1,
        label: "当前 Milestone",
        plannedAt: "2026-08-01T10:00:00.000Z",
        capabilities: {
          canView: true,
          canEditDraft: false,
          canCreateSegment: false,
          canSubmitReview: false,
          canReview: false,
          canConfirmTermination: false,
        },
        updatedAt,
        versionToken: updatedAt,
      },
    ],
    updatedAt,
    versionToken: updatedAt,
  };
}

async function mappedActionErrorCode(callback: () => unknown) {
  const result = await runProjectManagementAction({
    event: "test.pm.s2.structured_validation",
    action: "testS2StructuredValidation",
    callback: async () => callback(),
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("预期结构化 validation 失败");
  return result.error.code;
}

async function executeMigrationSql(client: Client, sql: string) {
  for (const statement of splitPostgresStatements(sql)) {
    await client.query(statement);
  }
}

function splitPostgresStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarQuoteTag: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    current += char;

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === "/" && next === "*") {
        current += next;
        index += 1;
        blockCommentDepth += 1;
      } else if (char === "*" && next === "/") {
        current += next;
        index += 1;
        blockCommentDepth -= 1;
      }
      continue;
    }
    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, index)) {
        current += dollarQuoteTag.slice(1);
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }
    if (singleQuoted) {
      if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (doubleQuoted) {
      if (char === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (char === '"') {
        doubleQuoted = false;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      current += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      current += next;
      index += 1;
      blockCommentDepth = 1;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      continue;
    }
    if (char === '"') {
      doubleQuoted = true;
      continue;
    }
    if (char === "$") {
      const tag = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        current += tag.slice(1);
        index += tag.length - 1;
        dollarQuoteTag = tag;
        continue;
      }
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    }
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}
