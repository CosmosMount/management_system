import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  previewSegmentPlacement,
} from "../lib/project-management/application/segment-placement-preview";
import {
  scanConflictsForPerson,
} from "../lib/project-management/application/conflict-service";
import {
  createWorkSegment,
  updateWorkSegment,
} from "../lib/project-management/application/segment-service";
import {
  ACTIVE_PLANNED_CONFLICT_STATUSES,
  detectResourceConflictsForSegments,
  type ConflictDetectionSegment,
} from "../lib/project-management/domain/conflict-detection";
import {
  toProjectManagementServiceError,
  type ProjectManagementErrorCode,
} from "../lib/project-management/application/errors";
import type {
  ProjectManagementActor,
  ProjectManagementSystemRoleRecord,
} from "../lib/project-management/identity";
import { getMyWorkDashboard } from "../lib/project-management/queries/dashboard-queries";
import {
  listTagOptions,
  searchPeople,
  searchTaskOptions,
} from "../lib/project-management/queries/option-queries";
import { getTimeCanvasData } from "../lib/project-management/queries/time-canvas-queries";
import { loginAsTestUser } from "./helpers/functional-fixtures";

const RANGE_START = "2026-08-10T00:00:00.000Z";
const RANGE_END = "2026-08-12T00:00:00.000Z";

test.describe("S2 canvas query security", () => {
  test("authenticated Canvas route binds every public query to the session actor", async ({
    context,
    request,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("Canvas route 测试缺少 baseURL");
    const owner = await createAccountPerson("Action 边界 Owner");
    const outsider = await createAccountPerson("Action 边界 Outsider");
    const task = await createTask({
      ownerAccountId: owner.account.id,
      title: "Action 边界可见 Task",
      team: "英雄",
      techGroup: "电控",
      members: [{ personId: owner.person.id, role: "OWNER" }],
    });
    const segment = await createSegment({
      accountId: owner.account.id,
      personId: owner.person.id,
      taskId: task.taskId,
      nodeId: task.milestoneNodeId,
      startAt: atHour(9),
      endAt: atHour(10),
    });
    const endpoint = new URL("/api/project-management/canvas", baseURL).toString();

    const unauthenticated = await request.post(endpoint, {
      data: { operation: "listTagOptions", input: {} },
    });
    expect(unauthenticated.status()).toBe(401);
    expect(unauthenticated.headers()["cache-control"]).toContain("no-store");
    expect(await unauthenticated.json()).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });

    await loginAsTestUser(context, baseURL, {
      openId: owner.openId,
      name: owner.person.displayName,
    });
    const allowedInputs: Array<{ operation: string; input: unknown }> = [
      {
        operation: "getTimeCanvasData",
        input: canvasInput({ scope: { kind: "PERSONAL" }, groupBy: "PERSON" }),
      },
      {
        operation: "getTimeCanvasData",
        input: canvasInput({
          scope: { kind: "TASK_SCOPED", taskId: task.taskId },
          groupBy: "TASK",
        }),
      },
      { operation: "searchPeople", input: { purpose: "VISIBLE" } },
      { operation: "searchTaskOptions", input: { query: "Action 边界" } },
      { operation: "listTagOptions", input: {} },
      {
        operation: "previewSegmentPlacement",
        input: {
          segmentId: segment.id,
          personId: owner.person.id,
          startAt: atHour(9),
          endAt: atHour(10.5),
          associationIntent: "KEEP",
        },
      },
      {
        operation: "getMyWorkDashboard",
        input: { rangeStart: RANGE_START, rangeEnd: RANGE_END },
      },
    ];
    for (const payload of allowedInputs) {
      const response = await context.request.post(endpoint, { data: payload });
      expect(await response.json(), payload.operation).toMatchObject({ ok: true });
      expect(response.headers()["cache-control"]).toContain("no-store");
    }

    const spoofedActor = await context.request.post(endpoint, {
      data: {
        operation: "getMyWorkDashboard",
        input: {},
        actor: actor(outsider, [systemAdministratorRole()]),
      },
    });
    expect(await spoofedActor.json()).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    const spoofedPersonalIdentity = await context.request.post(endpoint, {
      data: {
        operation: "getTimeCanvasData",
        input: canvasInput({
          scope: { kind: "PERSONAL" },
          groupBy: "PERSON",
          personIds: [outsider.person.id],
        }),
      },
    });
    expect(await spoofedPersonalIdentity.json()).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });

    const malformedInput = await context.request.post(endpoint, {
      data: {
        operation: "getTimeCanvasData",
        input: { scope: { kind: "PERSONAL" }, rangeStart: "invalid" },
      },
    });
    expect(await malformedInput.json()).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    const stableLimitError = await context.request.post(endpoint, {
      data: {
        operation: "searchPeople",
        input: { purpose: "VISIBLE", limit: 51 },
      },
    });
    expect(await stableLimitError.json()).toMatchObject({
      ok: false,
      error: { code: "QUERY_LIMIT_EXCEEDED" },
    });
    const malformedJson = await context.request.post(endpoint, {
      data: "{",
      headers: { "Content-Type": "application/json" },
    });
    expect(await malformedJson.json()).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });

    await loginAsTestUser(context, baseURL, {
      openId: outsider.openId,
      name: outsider.person.displayName,
    });
    for (const payload of [
      {
        operation: "getTimeCanvasData",
        input: canvasInput({
          scope: { kind: "TASK_SCOPED", taskId: task.taskId },
          groupBy: "TASK",
        }),
      },
      {
        operation: "previewSegmentPlacement",
        input: {
          segmentId: segment.id,
          personId: owner.person.id,
          startAt: atHour(9),
          endAt: atHour(10),
          associationIntent: "KEEP",
        },
      },
    ]) {
      const denied = await context.request.post(endpoint, { data: payload });
      expect(await denied.json()).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
    }
  });

  test("Segment create action accepts creatable Tasks and returns a stable denial for terminal Tasks", async ({
    context,
    page,
    baseURL,
  }) => {
    const owner = await createAccountPerson("Create Action Owner");
    const activeTask = await createTask({
      ownerAccountId: owner.account.id,
      title: `Create Action Active ${randomUUID()}`,
      team: "英雄",
      techGroup: "电控",
      members: [{ personId: owner.person.id, role: "OWNER" }],
    });
    const terminalTask = await createTask({
      ownerAccountId: owner.account.id,
      title: `Create Action Completed ${randomUUID()}`,
      team: "英雄",
      techGroup: "电控",
      status: "COMPLETED",
      members: [{ personId: owner.person.id, role: "OWNER" }],
    });
    await loginAsTestUser(context, baseURL, {
      openId: owner.openId,
      name: owner.person.displayName,
    });
    await page.goto("/progress/resources?start=2026-08-10&end=2026-08-12");

    await page.locator("#segment-task").selectOption(activeTask.taskId);
    await page.locator("#segment-content").fill("真实 Action 允许 Active Task");
    await page.getByRole("button", { name: "新增计划" }).click();
    await expect(page.getByRole("status")).toHaveText("已创建 Planned Segment");
    await expect
      .poll(() =>
        prisma.workSegment.count({
          where: {
            personId: owner.person.id,
            taskId: activeTask.taskId,
            content: "真实 Action 允许 Active Task",
          },
        }),
      )
      .toBe(1);

    await page.locator("#segment-task").evaluate(
      (element, taskId) => {
        const select = element as HTMLSelectElement;
        const option = document.createElement("option");
        option.value = taskId;
        option.textContent = "终态 Task（注入值仅用于验证服务端授权）";
        select.append(option);
        select.value = taskId;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      },
      terminalTask.taskId,
    );
    await page.locator("#segment-content").fill("真实 Action 拒绝 Completed Task");
    const deniedActionResponse = page.waitForResponse((response) =>
      Boolean(response.request().headers()["next-action"]),
    );
    await page.getByRole("button", { name: "新增计划" }).click();
    expect(await (await deniedActionResponse).text()).toContain(
      "ASSOCIATION_INVALID",
    );
    await expect(
      page.getByText("当前 Task 状态不允许创建或重关联 Segment", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await prisma.workSegment.count({
        where: { taskId: terminalTask.taskId },
      }),
    ).toBe(0);
  });

  test("People, Task and Tag options use minimal permission-filtered stable cursor pages", async () => {
    const owner = await createAccountPerson("选项-Owner");
    const visibleMember = await createAccountPerson("同名成员");
    const visibleSegmentPerson = await createAccountPerson("同名成员");
    const outsider = await createAccountPerson("不可见成员");
    const inactive = await createAccountPerson("停用成员", "INACTIVE");
    const hiddenOwner = await createAccountPerson("隐藏 Task Owner");
    const ownerActor = actor(owner);
    const adminActor = actor(owner, [systemAdministratorRole()]);
    const visibleTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "同名 Task",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: visibleMember.person.id, role: "MEMBER" },
      ],
    });
    const hiddenTask = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "同名 Task",
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
    await createSegment({
      accountId: owner.account.id,
      personId: visibleSegmentPerson.person.id,
      taskId: visibleTask.taskId,
      startAt: atHour(9),
      endAt: atHour(10),
    });

    const people = await searchPeople({
      actor: ownerActor,
      input: { purpose: "VISIBLE" },
    });
    expect(people.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        owner.person.id,
        visibleMember.person.id,
        visibleSegmentPerson.person.id,
      ]),
    );
    expect(people.items.map((item) => item.id)).not.toContain(outsider.person.id);
    expect(people.items.map((item) => item.id)).not.toContain(inactive.person.id);
    expect(
      people.items.every(
        (item) =>
          Object.keys(item).sort().join("|") ===
          [
            "accountAvailability",
            "avatar",
            "displayName",
            "id",
            "status",
          ]
            .sort()
            .join("|"),
      ),
    ).toBe(true);

    const sameNameIds: string[] = [];
    let peopleCursor: string | undefined;
    do {
      const page = await searchPeople({
        actor: adminActor,
        input: {
          purpose: "VISIBLE",
          query: "同名成员",
          limit: 1,
          cursor: peopleCursor,
        },
      });
      sameNameIds.push(...page.items.map((item) => item.id));
      peopleCursor = page.nextCursor ?? undefined;
    } while (peopleCursor);
    expect(new Set(sameNameIds).size).toBe(sameNameIds.length);
    expect(sameNameIds).toEqual(
      expect.arrayContaining([
        visibleMember.person.id,
        visibleSegmentPerson.person.id,
      ]),
    );
    await expectErrorCode(
      searchPeople({
        actor: adminActor,
        input: { purpose: "VISIBLE", cursor: "not-a-cursor" },
      }),
      "VALIDATION_ERROR",
    );
    const firstPeoplePage = await searchPeople({
      actor: adminActor,
      input: { purpose: "VISIBLE", query: "同名成员", limit: 1 },
    });
    await expectErrorCode(
      searchPeople({
        actor: adminActor,
        input: {
          purpose: "VISIBLE",
          query: "不同查询",
          cursor: firstPeoplePage.nextCursor,
        },
      }),
      "VALIDATION_ERROR",
    );

    const activeTag = await createTag(owner.account.id, "活动 Tag");
    const ownArchivedTag = await createTag(
      owner.account.id,
      "本人归档 Tag",
      new Date(),
    );
    const otherArchivedTag = await createTag(
      hiddenOwner.account.id,
      "他人归档 Tag",
      new Date(),
    );
    await prisma.taskTag.create({
      data: { taskId: visibleTask.taskId, tagId: activeTag.id },
    });
    await prisma.taskTag.create({
      data: { taskId: hiddenTask.taskId, tagId: activeTag.id },
    });
    const taskOptions = await searchTaskOptions({
      actor: ownerActor,
      input: { query: "同名 Task", tagIds: [activeTag.id] },
    });
    expect(taskOptions.items.map((item) => item.id)).toEqual([
      visibleTask.taskId,
    ]);
    expect(taskOptions.items[0]?.permission).toEqual({ canView: true });
    const visibleTagIds: string[] = [];
    let tagCursor: string | undefined;
    do {
      const tagPage = await listTagOptions({
        actor: ownerActor,
        input: { includeArchived: true, limit: 50, cursor: tagCursor },
      });
      visibleTagIds.push(...tagPage.items.map((tag) => tag.id));
      tagCursor = tagPage.nextCursor ?? undefined;
    } while (tagCursor);
    expect(visibleTagIds).toEqual(
      expect.arrayContaining([activeTag.id, ownArchivedTag.id]),
    );
    expect(visibleTagIds).not.toContain(otherArchivedTag.id);

    const adminTagIds: string[] = [];
    let adminTagCursor: string | undefined;
    do {
      const tagPage = await listTagOptions({
        actor: adminActor,
        input: {
          includeArchived: true,
          limit: 50,
          cursor: adminTagCursor,
        },
      });
      adminTagIds.push(...tagPage.items.map((tag) => tag.id));
      adminTagCursor = tagPage.nextCursor ?? undefined;
    } while (adminTagCursor);
    expect(adminTagIds).toContain(otherArchivedTag.id);
  });

  test("People purposes enforce directory authorization, anti-enumeration and safe account availability", async () => {
    const directoryKey = randomUUID();
    const directoryQuery = `成员目录 ${directoryKey}`;
    const owner = await createAccountPerson("成员目录 Owner");
    const teamAdmin = await createAccountPerson("成员目录 Team Admin");
    const ordinary = await createAccountPerson("成员目录普通成员");
    const hiddenOwner = await createAccountPerson("成员目录隐藏 Owner");
    const active = await createAccountPerson(`${directoryQuery} Active`);
    const disabled = await createAccountPerson(
      `${directoryQuery} Disabled`,
      "ACTIVE",
      "DISABLED",
    );
    const inactive = await createAccountPerson(
      `${directoryQuery} Inactive`,
      "INACTIVE",
    );
    const unbound = await prisma.person.create({
      data: { displayName: `${directoryQuery} Unbound`, status: "ACTIVE" },
    });
    const activeIdentityMarker = `active-identity-${randomUUID()}`;
    const disabledIdentityMarker = `disabled-identity-${randomUUID()}`;
    await prisma.accountIdentity.createMany({
      data: [
        {
          accountId: active.account.id,
          provider: "FEISHU",
          providerSubject: activeIdentityMarker,
          tenantId: `tenant-${activeIdentityMarker}`,
          openId: `ou_${activeIdentityMarker}`,
          unionId: `on_${activeIdentityMarker}`,
        },
        {
          accountId: disabled.account.id,
          provider: "FEISHU",
          providerSubject: disabledIdentityMarker,
          tenantId: `tenant-${disabledIdentityMarker}`,
          openId: `ou_${disabledIdentityMarker}`,
          unionId: `on_${disabledIdentityMarker}`,
        },
      ],
    });
    const task = await createTask({
      ownerAccountId: owner.account.id,
      title: "成员目录可管理 Task",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: ordinary.person.id, role: "MEMBER" },
      ],
    });
    const hiddenTask = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "成员目录隐藏 Task",
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
    const ownerActor = actor(owner);
    const teamAdminActor = actor(teamAdmin, [
      scopedRole("TEAM_ADMINISTRATOR", "英雄", "电控"),
    ]);
    const ordinaryActor = actor(ordinary);
    const systemActor = actor(owner, [systemAdministratorRole()]);

    const ordinaryVisible = await searchPeople({
      actor: ordinaryActor,
      input: { purpose: "VISIBLE", query: directoryQuery },
    });
    expect(ordinaryVisible.items).toEqual([]);

    const systemVisible = await searchPeople({
      actor: systemActor,
      input: { purpose: "VISIBLE", query: directoryQuery },
    });
    expect(systemVisible.items).toEqual([]);

    for (const input of [
      {
        purpose: "TASK_CREATE" as const,
        team: "英雄" as const,
        techGroup: "电控" as const,
        query: directoryQuery,
      },
      {
        purpose: "TASK_MEMBERS" as const,
        taskId: task.taskId,
        query: directoryQuery,
      },
    ]) {
      const page = await searchPeople({ actor: systemActor, input });
      expect(page.items.map((item) => item.id)).toEqual(
        expect.arrayContaining([
          active.person.id,
          disabled.person.id,
          unbound.id,
        ]),
      );
      expect(page.items.map((item) => item.id)).not.toContain(
        inactive.person.id,
      );
    }

    const ownerMembers = await searchPeople({
      actor: ownerActor,
      input: {
        purpose: "TASK_MEMBERS",
        taskId: task.taskId,
        query: directoryQuery,
      },
    });
    expect(
      ownerMembers.items.map((item) => [item.id, item.accountAvailability]),
    ).toEqual(
      expect.arrayContaining([
        [active.person.id, "ACTIVE"],
        [disabled.person.id, "DISABLED"],
        [unbound.id, "UNBOUND"],
      ]),
    );
    expect(ownerMembers.items.map((item) => item.id)).not.toContain(
      inactive.person.id,
    );
    for (const item of ownerMembers.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "accountAvailability",
          "avatar",
          "displayName",
          "id",
          "status",
        ].sort(),
      );
    }
    const serialized = JSON.stringify(ownerMembers);
    for (const sensitive of [
      active.account.id,
      disabled.account.id,
      activeIdentityMarker,
      disabledIdentityMarker,
      `tenant-${activeIdentityMarker}`,
      `tenant-${disabledIdentityMarker}`,
    ]) {
      expect(serialized).not.toContain(sensitive);
    }

    for (const input of [
      {
        purpose: "TASK_CREATE" as const,
        team: "英雄" as const,
        techGroup: "电控" as const,
        query: directoryQuery,
      },
      {
        purpose: "TASK_MEMBERS" as const,
        taskId: task.taskId,
        query: directoryQuery,
      },
    ]) {
      const page = await searchPeople({ actor: teamAdminActor, input });
      expect(page.items.map((item) => item.id)).toEqual(
        expect.arrayContaining([
          active.person.id,
          disabled.person.id,
          unbound.id,
        ]),
      );
      expect(page.items.map((item) => item.id)).not.toContain(
        inactive.person.id,
      );
    }

    await expectErrorCode(
      searchPeople({
        actor: teamAdminActor,
        input: {
          purpose: "TASK_CREATE",
          team: "步兵",
          techGroup: "机械",
          query: directoryQuery,
        },
      }),
      "FORBIDDEN",
    );
    await expectErrorCode(
      searchPeople({
        actor: teamAdminActor,
        input: {
          purpose: "TASK_MEMBERS",
          taskId: hiddenTask.taskId,
          query: directoryQuery,
        },
      }),
      "NOT_FOUND",
    );
    await expectErrorCode(
      searchPeople({
        actor: ordinaryActor,
        input: {
          purpose: "TASK_CREATE",
          team: "英雄",
          techGroup: "电控",
          query: directoryQuery,
        },
      }),
      "FORBIDDEN",
    );
    await expectErrorCode(
      searchPeople({
        actor: ordinaryActor,
        input: {
          purpose: "TASK_MEMBERS",
          taskId: task.taskId,
          query: directoryQuery,
        },
      }),
      "FORBIDDEN",
    );

    const randomTaskError = await serviceErrorOf(
      searchPeople({
        actor: ordinaryActor,
        input: { purpose: "TASK_MEMBERS", taskId: randomUUID() },
      }),
    );
    const hiddenTaskError = await serviceErrorOf(
      searchPeople({
        actor: ordinaryActor,
        input: { purpose: "TASK_MEMBERS", taskId: hiddenTask.taskId },
      }),
    );
    expect({ code: randomTaskError.code, message: randomTaskError.message }).toEqual(
      { code: hiddenTaskError.code, message: hiddenTaskError.message },
    );
    expect(randomTaskError.code).toBe("NOT_FOUND");

    await expectErrorCode(
      searchPeople({ actor: systemActor, input: { query: directoryQuery } }),
      "VALIDATION_ERROR",
    );
    await expectErrorCode(
      searchPeople({
        actor: systemActor,
        input: {
          purpose: "VISIBLE",
          team: "英雄",
          query: directoryQuery,
        },
      }),
      "VALIDATION_ERROR",
    );
    await expectErrorCode(
      searchPeople({
        actor: systemActor,
        input: { purpose: "TASK_CREATE", query: directoryQuery },
      }),
      "VALIDATION_ERROR",
    );
    await expectErrorCode(
      searchPeople({
        actor: systemActor,
        input: {
          purpose: "TASK_CREATE",
          team: "不存在车组",
          techGroup: "电控",
          query: directoryQuery,
        },
      }),
      "VALIDATION_ERROR",
    );
    await expectErrorCode(
      searchPeople({
        actor: systemActor,
        input: {
          purpose: "TASK_CREATE",
          team: "英雄",
          techGroup: "不存在技术组",
          query: directoryQuery,
        },
      }),
      "VALIDATION_ERROR",
    );
    await expectErrorCode(
      searchPeople({
        actor: systemActor,
        input: { purpose: "TASK_MEMBERS", query: directoryQuery },
      }),
      "VALIDATION_ERROR",
    );
  });

  test("People, Task and Tag options page at the 50-item boundary and reject bound cursors", async () => {
    const owner = await createAccountPerson("选项游标 Owner");
    const ownerActor = actor(owner);
    const adminActor = actor(owner, [systemAdministratorRole()]);
    const queryKey = randomUUID();
    const peopleQuery = `游标边界 Person ${queryKey}`;
    const taskQuery = `游标边界 Task ${queryKey}`;
    const tagQuery = `游标边界 Tag ${queryKey}`;
    const taskIds = await createTaskOptionFixtures({
      ownerAccountId: owner.account.id,
      ownerPersonId: owner.person.id,
      titlePrefix: taskQuery,
      count: 51,
    });
    const tagIds = Array.from({ length: 51 }, () => randomUUID());
    await prisma.tag.createMany({
      data: tagIds.map((id, index) => ({
        id,
        name: `${tagQuery} ${String(index).padStart(2, "0")}`,
        color: "#446688",
        createdByAccountId: owner.account.id,
      })),
    });
    const personIds = Array.from({ length: 51 }, () => randomUUID());
    await prisma.person.createMany({
      data: personIds.map((id) => ({
        id,
        displayName: peopleQuery,
        status: "ACTIVE",
      })),
    });
    await prisma.taskMember.createMany({
      data: personIds.map((personId) => ({
        taskId: taskIds[0]!,
        personId,
        role: "MEMBER",
        createdByAccountId: owner.account.id,
      })),
    });

    const firstPeoplePage = await searchPeople({
      actor: adminActor,
      input: { purpose: "VISIBLE", query: peopleQuery, limit: 50 },
    });
    expect(firstPeoplePage.items).toHaveLength(50);
    expect(firstPeoplePage.nextCursor).not.toBeNull();
    const secondPeoplePage = await searchPeople({
      actor: adminActor,
      input: {
        purpose: "VISIBLE",
        query: peopleQuery,
        limit: 50,
        cursor: firstPeoplePage.nextCursor ?? undefined,
      },
    });
    expect(secondPeoplePage.items).toHaveLength(1);
    expect(
      new Set(
        [...firstPeoplePage.items, ...secondPeoplePage.items].map(
          (item) => item.id,
        ),
      ),
    ).toEqual(new Set(personIds));

    const firstTaskPage = await searchTaskOptions({
      actor: ownerActor,
      input: { query: taskQuery, limit: 50 },
    });
    expect(firstTaskPage.items).toHaveLength(50);
    expect(firstTaskPage.nextCursor).not.toBeNull();
    const secondTaskPage = await searchTaskOptions({
      actor: ownerActor,
      input: {
        query: taskQuery,
        limit: 50,
        cursor: firstTaskPage.nextCursor ?? undefined,
      },
    });
    expect(secondTaskPage.items).toHaveLength(1);
    expect(
      new Set(
        [...firstTaskPage.items, ...secondTaskPage.items].map((item) => item.id),
      ),
    ).toEqual(new Set(taskIds));

    const firstTagPage = await listTagOptions({
      actor: ownerActor,
      input: { query: tagQuery, limit: 50 },
    });
    expect(firstTagPage.items).toHaveLength(50);
    expect(firstTagPage.nextCursor).not.toBeNull();
    const secondTagPage = await listTagOptions({
      actor: ownerActor,
      input: {
        query: tagQuery,
        limit: 50,
        cursor: firstTagPage.nextCursor ?? undefined,
      },
    });
    expect(secondTagPage.items).toHaveLength(1);
    expect(
      new Set(
        [...firstTagPage.items, ...secondTagPage.items].map((item) => item.id),
      ),
    ).toEqual(new Set(tagIds));

    await expectErrorCode(
      searchPeople({
        actor: adminActor,
        input: {
          purpose: "VISIBLE",
          query: `${peopleQuery} changed`,
          cursor: firstPeoplePage.nextCursor ?? undefined,
        },
      }),
      "VALIDATION_ERROR",
    );
    const taskCreatePeoplePage = await searchPeople({
      actor: adminActor,
      input: {
        purpose: "TASK_CREATE",
        team: "英雄",
        techGroup: "电控",
        query: peopleQuery,
        limit: 1,
      },
    });
    expect(taskCreatePeoplePage.nextCursor).not.toBeNull();
    await expectErrorCode(
      searchPeople({
        actor: adminActor,
        input: {
          purpose: "VISIBLE",
          query: peopleQuery,
          cursor: taskCreatePeoplePage.nextCursor ?? undefined,
        },
      }),
      "VALIDATION_ERROR",
    );
    await expectErrorCode(
      searchPeople({
        actor: adminActor,
        input: {
          purpose: "TASK_CREATE",
          team: "步兵",
          techGroup: "机械",
          query: peopleQuery,
          cursor: taskCreatePeoplePage.nextCursor ?? undefined,
        },
      }),
      "VALIDATION_ERROR",
    );
    const taskMembersPeoplePage = await searchPeople({
      actor: adminActor,
      input: {
        purpose: "TASK_MEMBERS",
        taskId: taskIds[0]!,
        query: peopleQuery,
        limit: 1,
      },
    });
    expect(taskMembersPeoplePage.nextCursor).not.toBeNull();
    await expectErrorCode(
      searchPeople({
        actor: adminActor,
        input: {
          purpose: "TASK_MEMBERS",
          taskId: taskIds[1]!,
          query: peopleQuery,
          cursor: taskMembersPeoplePage.nextCursor ?? undefined,
        },
      }),
      "VALIDATION_ERROR",
    );
    await expectErrorCode(
      searchTaskOptions({
        actor: adminActor,
        input: {
          query: taskQuery,
          cursor: firstPeoplePage.nextCursor ?? undefined,
        },
      }),
      "VALIDATION_ERROR",
    );
    await expectErrorCode(
      listTagOptions({
        actor: adminActor,
        input: {
          query: tagQuery,
          cursor: firstPeoplePage.nextCursor ?? undefined,
        },
      }),
      "VALIDATION_ERROR",
    );

    await expectErrorCode(
      listTagOptions({
        actor: ownerActor,
        input: {
          query: tagQuery,
          cursor: firstTaskPage.nextCursor ?? undefined,
        },
      }),
      "VALIDATION_ERROR",
    );
    await expectErrorCode(
      searchTaskOptions({
        actor: ownerActor,
        input: {
          query: taskQuery,
          cursor: firstTagPage.nextCursor ?? undefined,
        },
      }),
      "VALIDATION_ERROR",
    );
    await expectErrorCode(
      searchTaskOptions({
        actor: ownerActor,
        input: { query: taskQuery, limit: 51 },
      }),
      "QUERY_LIMIT_EXCEEDED",
    );
    await expectErrorCode(
      searchPeople({
        actor: adminActor,
        input: { purpose: "VISIBLE", query: peopleQuery, limit: 51 },
      }),
      "QUERY_LIMIT_EXCEEDED",
    );
    await expectErrorCode(
      listTagOptions({
        actor: ownerActor,
        input: { query: tagQuery, limit: 51 },
      }),
      "QUERY_LIMIT_EXCEEDED",
    );
  });

  test("Tag filters use the authorized TaskTag-or-SegmentTag union for PERSON and TASK rows", async () => {
    const teamAdmin = await createAccountPerson("Tag 并集 Team Admin");
    const target = await createAccountPerson("Tag 并集目标人员");
    const visibleOwner = await createAccountPerson("Tag 并集可见 Owner");
    const hiddenOwner = await createAccountPerson("Tag 并集隐藏 Owner");
    const teamAdminActor = actor(teamAdmin, [
      scopedRole("TEAM_ADMINISTRATOR", "英雄", "电控"),
    ]);
    const tag = await createTag(teamAdmin.account.id, "Tag 并集筛选");
    const taskTagOnly = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Tag 并集 TaskTag-only",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: visibleOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    const segmentTagOnly = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Tag 并集 SegmentTag-only",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: visibleOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    const both = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Tag 并集 Both",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: visibleOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    const taskTagWithoutSegment = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Tag 并集 TaskTag zero Segment",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: visibleOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    const taskTagOutsideRange = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Tag 并集 TaskTag out of range",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: visibleOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    const hidden = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "Tag 并集隐藏 Task",
      team: "步兵",
      techGroup: "机械",
      members: [
        { personId: hiddenOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    await prisma.taskTag.createMany({
      data: [
        taskTagOnly.taskId,
        both.taskId,
        taskTagWithoutSegment.taskId,
        taskTagOutsideRange.taskId,
        hidden.taskId,
      ].map((taskId) => ({ taskId, tagId: tag.id })),
    });
    const taskTagOnlySegment = await createSegment({
      accountId: visibleOwner.account.id,
      personId: target.person.id,
      taskId: taskTagOnly.taskId,
      startAt: atHour(9),
      endAt: atHour(10),
      content: "仅 TaskTag 命中",
    });
    const segmentTagOnlySegment = await createSegment({
      accountId: visibleOwner.account.id,
      personId: target.person.id,
      taskId: segmentTagOnly.taskId,
      startAt: atHour(10),
      endAt: atHour(11),
      content: "仅 SegmentTag 命中",
      tagIds: [tag.id],
    });
    const bothSegment = await createSegment({
      accountId: visibleOwner.account.id,
      personId: target.person.id,
      taskId: both.taskId,
      startAt: atHour(11),
      endAt: atHour(12),
      content: "TaskTag 与 SegmentTag 同时命中",
      tagIds: [tag.id],
    });
    const hiddenSegment = await createSegment({
      accountId: hiddenOwner.account.id,
      personId: target.person.id,
      taskId: hidden.taskId,
      startAt: atHour(12),
      endAt: atHour(13),
      content: "隐藏 Task 同 Tag",
      tagIds: [tag.id],
    });
    await createSegment({
      accountId: visibleOwner.account.id,
      personId: target.person.id,
      taskId: taskTagOutsideRange.taskId,
      startAt: new Date("2027-08-10T09:00:00.000Z"),
      endAt: new Date("2027-08-10T10:00:00.000Z"),
      content: "TaskTag 范围外 Segment",
    });

    const expectedSegmentIds = [
      taskTagOnlySegment.id,
      segmentTagOnlySegment.id,
      bothSegment.id,
    ].sort();
    const personGrouped = await getTimeCanvasData({
      actor: teamAdminActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [target.person.id],
        tagIds: [tag.id],
      }),
    });
    expect(personGrouped.rows.map((row) => row.id)).toEqual([target.person.id]);
    expect(fullSegmentIds(personGrouped).sort()).toEqual(expectedSegmentIds);

    const taskGrouped = await getTimeCanvasData({
      actor: teamAdminActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "TASK",
        personIds: [target.person.id],
        tagIds: [tag.id],
      }),
    });
    expect(taskGrouped.rows.map((row) => row.id).sort()).toEqual(
      [
        taskTagOnly.taskId,
        segmentTagOnly.taskId,
        both.taskId,
        taskTagWithoutSegment.taskId,
        taskTagOutsideRange.taskId,
      ].sort(),
    );
    expect(fullSegmentIds(taskGrouped).sort()).toEqual(expectedSegmentIds);
    expect(taskGrouped.anchors.map((anchor) => anchor.id).sort()).toEqual(
      taskGrouped.rows.map((row) => row.id).sort(),
    );
    const pagedTaskIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getTimeCanvasData({
        actor: teamAdminActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "TASK",
          personIds: [target.person.id],
          tagIds: [tag.id],
          rowLimit: 1,
          cursor,
        }),
      });
      pagedTaskIds.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pagedTaskIds.sort()).toEqual(
      taskGrouped.rows.map((row) => row.id).sort(),
    );
    expect(new Set(pagedTaskIds).size).toBe(pagedTaskIds.length);
    expect(JSON.stringify(personGrouped)).not.toContain(hiddenSegment.id);
    expect(JSON.stringify(taskGrouped)).not.toContain(hidden.taskId);
    expect(JSON.stringify(taskGrouped)).not.toContain(hiddenSegment.id);
  });

  test("PERSON row creation capabilities use eligible Task existence without widening task visibility", async () => {
    const resourceManager = await createAccountPerson("Capability Resource Manager");
    const teamAdmin = await createAccountPerson("Capability Team Admin");
    const owner = await createAccountPerson("Capability Owner");
    const target = await createAccountPerson("Capability 目标人员");
    const viewer = await createAccountPerson("Capability Viewer");
    const outOfScopePerson = await createAccountPerson("Capability 越界人员");
    const resourceManagerActor = actor(resourceManager, [
      scopedRole("RESOURCE_MANAGER", "英雄", "电控"),
    ]);
    const teamAdminActor = actor(teamAdmin, [
      scopedRole("TEAM_ADMINISTRATOR", "英雄", "电控"),
    ]);
    await Promise.all([
      grantScopedRole(resourceManager.account.id, "RESOURCE_MANAGER", "英雄", "电控"),
      grantScopedRole(teamAdmin.account.id, "TEAM_ADMINISTRATOR", "英雄", "电控"),
    ]);
    const activeTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "Capability Active",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
        { personId: viewer.person.id, role: "VIEWER" },
      ],
    });
    const draftTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "Capability Draft",
      team: "英雄",
      techGroup: "电控",
      status: "DRAFT",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    const terminalTasks = await Promise.all(
      (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ARCHIVED"] as const).map(
        (status) =>
          createTask({
            ownerAccountId: owner.account.id,
            title: `Capability ${status}`,
            team: "英雄",
            techGroup: "电控",
            status,
            members: [
              { personId: owner.person.id, role: "OWNER" },
              { personId: target.person.id, role: "MEMBER" },
            ],
          }),
      ),
    );
    const outOfScopeTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "Capability 越界 Task",
      team: "步兵",
      techGroup: "机械",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: outOfScopePerson.person.id, role: "MEMBER" },
      ],
    });

    for (const managerActor of [resourceManagerActor, teamAdminActor]) {
      const canvas = await getTimeCanvasData({
        actor: managerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [target.person.id],
        }),
      });
      expect(rowCanCreate(canvas, target.person.id)).toBe(true);
      expect(canvas.rows.map((row) => row.id)).not.toContain(
        outOfScopePerson.person.id,
      );
    }

    const singleTerminal = await getTimeCanvasData({
      actor: teamAdminActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [target.person.id],
        taskIds: [terminalTasks[0]!.taskId],
      }),
    });
    expect(rowCanCreate(singleTerminal, target.person.id)).toBe(false);
    const deniedWriteCounts = {
      segments: await prisma.workSegment.count({
        where: { personId: target.person.id },
      }),
      changes: await prisma.workSegmentChange.count(),
      audits: await prisma.domainAuditEvent.count(),
      outbox: await prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    };
    for (const [index, task] of terminalTasks.entries()) {
      await expectErrorCode(
        createWorkSegment(teamAdminActor, {
          personId: target.person.id,
          type: "PLANNED",
          startAt: atHour(14 + index * 0.1),
          endAt: atHour(14.05 + index * 0.1),
          content: `禁止关联终态 Task ${index}`,
          allocation: 10,
          taskId: task.taskId,
          nodeId: task.milestoneNodeId,
        }),
        "ASSOCIATION_INVALID",
      );
    }
    expect({
      segments: await prisma.workSegment.count({
        where: { personId: target.person.id },
      }),
      changes: await prisma.workSegmentChange.count(),
      audits: await prisma.domainAuditEvent.count(),
      outbox: await prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    }).toEqual(deniedWriteCounts);

    const activeCreated = await createWorkSegment(teamAdminActor, {
      personId: target.person.id,
      type: "PLANNED",
      startAt: atHour(15),
      endAt: atHour(16),
      content: "允许关联 Active Task",
      allocation: 10,
      taskId: activeTask.taskId,
      nodeId: activeTask.milestoneNodeId,
    });
    expect(activeCreated.segment.taskId).toBe(activeTask.taskId);
    const draftCreated = await createWorkSegment(teamAdminActor, {
      personId: target.person.id,
      type: "PLANNED",
      startAt: atHour(16),
      endAt: atHour(17),
      content: "允许关联 Draft Task",
      allocation: 10,
      taskId: draftTask.taskId,
      nodeId: draftTask.milestoneNodeId,
    });
    expect(draftCreated.segment.taskId).toBe(draftTask.taskId);
    const mixedTasks = await getTimeCanvasData({
      actor: teamAdminActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [target.person.id],
        taskIds: [activeTask.taskId, terminalTasks[0]!.taskId],
      }),
    });
    expect(rowCanCreate(mixedTasks, target.person.id)).toBe(true);
    const terminalOnlyTasks = await getTimeCanvasData({
      actor: teamAdminActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [target.person.id],
        taskIds: [terminalTasks[0]!.taskId, terminalTasks[1]!.taskId],
      }),
    });
    expect(rowCanCreate(terminalOnlyTasks, target.person.id)).toBe(false);

    for (const [index, status] of [
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
      "ARCHIVED",
    ].entries()) {
      const terminalCanvas = await getTimeCanvasData({
        actor: actor(owner),
        input: canvasInput({
          scope: {
            kind: "TASK_SCOPED",
            taskId: terminalTasks[index]!.taskId,
          },
          groupBy: "PERSON",
          personIds: [owner.person.id],
        }),
      });
      expect(rowCanCreate(terminalCanvas, owner.person.id), status).toBe(false);
    }

    const viewerCanvas = await getTimeCanvasData({
      actor: actor(viewer),
      input: canvasInput({
        scope: { kind: "TASK_SCOPED", taskId: activeTask.taskId },
        groupBy: "PERSON",
      }),
    });
    expect(rowCanCreate(viewerCanvas, viewer.person.id)).toBe(true);
    expect(rowCanCreate(viewerCanvas, target.person.id)).toBe(false);

    const independent = await createAccountPerson("Capability 独立 Segment 本人");
    const personalCanvas = await getTimeCanvasData({
      actor: actor(independent),
      input: canvasInput({
        scope: { kind: "PERSONAL" },
        groupBy: "PERSON",
      }),
    });
    expect(rowCanCreate(personalCanvas, independent.person.id)).toBe(true);

    await expectErrorCode(
      getTimeCanvasData({
        actor: resourceManagerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          taskIds: [activeTask.taskId],
        }),
      }),
      "NOT_FOUND",
    );
    await expectErrorCode(
      getTimeCanvasData({
        actor: teamAdminActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          taskIds: [outOfScopeTask.taskId],
        }),
      }),
      "NOT_FOUND",
    );
    await expectErrorCode(
      getTimeCanvasData({
        actor: resourceManagerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [outOfScopePerson.person.id],
        }),
      }),
      "NOT_FOUND",
    );
  });

  test("four canvas scopes enforce row domains, half-open filters, Full/Busy privacy and Actual capabilities", async () => {
    const scopeKey = randomUUID();
    const scopedTeam = `英雄-${scopeKey}`;
    const scopedTechGroup = `电控-${scopeKey}`;
    const owner = await createAccountPerson("画布 Owner");
    const member = await createAccountPerson("画布 Member");
    const hiddenOwner = await createAccountPerson("隐藏 Owner");
    const thirdOwner = await createAccountPerson("第三 Owner");
    const resourceManager = await createAccountPerson("资源经理");
    const inactive = await createAccountPerson("停用画布人员", "INACTIVE");
    const ownerActor = actor(owner);
    const adminActor = actor(owner, [systemAdministratorRole()]);
    const managerActor = actor(resourceManager, [
      scopedRole("RESOURCE_MANAGER", scopedTeam, scopedTechGroup),
    ]);
    const taskA = await createTask({
      ownerAccountId: owner.account.id,
      title: "可见 Task A",
      team: scopedTeam,
      techGroup: scopedTechGroup,
      plannedStartAt: null,
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: member.person.id, role: "MEMBER" },
      ],
    });
    const taskB = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "隐藏 Task B",
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
    const taskC = await createTask({
      ownerAccountId: thirdOwner.account.id,
      title: "隐藏 Task C",
      team: "无人机",
      techGroup: "视觉",
      members: [{ personId: thirdOwner.person.id, role: "OWNER" }],
    });
    const current = await createSegment({
      accountId: owner.account.id,
      personId: member.person.id,
      taskId: taskA.taskId,
      nodeId: taskA.milestoneNodeId,
      startAt: atHour(9),
      endAt: atHour(12),
      allocation: 60,
      content: "可见 Task A 投入",
    });
    const hidden = await createSegment({
      accountId: hiddenOwner.account.id,
      personId: member.person.id,
      taskId: taskB.taskId,
      nodeId: taskB.milestoneNodeId,
      startAt: atHour(10),
      endAt: atHour(11),
      allocation: 60,
      content: "绝密 Task B 投入",
    });
    const hiddenTag = await createTag(hiddenOwner.account.id, "绝密 Segment Tag");
    await prisma.segmentTag.create({
      data: { segmentId: hidden.id, tagId: hiddenTag.id },
    });
    const hiddenVersionToken = "2026-07-01T01:02:03.456Z";
    await prisma.workSegment.update({
      where: { id: hidden.id },
      data: { updatedAt: new Date(hiddenVersionToken) },
    });
    const hiddenC = await createSegment({
      accountId: thirdOwner.account.id,
      personId: member.person.id,
      taskId: taskC.taskId,
      nodeId: taskC.milestoneNodeId,
      startAt: atHour(10),
      endAt: atHour(11),
      allocation: 60,
      content: "绝密 Task C 投入",
    });
    const actual = await createSegment({
      accountId: owner.account.id,
      personId: owner.person.id,
      taskId: taskA.taskId,
      nodeId: taskA.milestoneNodeId,
      type: "ACTUAL",
      status: "CONFIRMED",
      startAt: atHour(13),
      endAt: atHour(14),
      allocation: 50,
      content: "本人 Actual",
    });
    const endingAtRangeStart = await createSegment({
      accountId: owner.account.id,
      personId: member.person.id,
      taskId: taskA.taskId,
      startAt: new Date("2026-08-09T23:00:00.000Z"),
      endAt: new Date(RANGE_START),
      content: "恰好结束于范围起点",
    });
    const startingAtRangeEnd = await createSegment({
      accountId: owner.account.id,
      personId: member.person.id,
      taskId: taskA.taskId,
      startAt: new Date(RANGE_END),
      endAt: new Date("2026-08-12T01:00:00.000Z"),
      content: "恰好开始于范围终点",
    });
    const crossingRangeStart = await createSegment({
      accountId: owner.account.id,
      personId: member.person.id,
      taskId: taskA.taskId,
      startAt: new Date("2026-08-09T23:00:00.000Z"),
      endAt: new Date("2026-08-10T01:00:00.000Z"),
      content: "跨过范围起点",
    });
    const mixedConflict = await createConflict({
      personId: member.person.id,
      segmentIds: [current.id, hidden.id],
      severity: "HIGH",
      fingerprint: `mixed-${randomUUID()}`,
    });
    const allHiddenConflict = await createConflict({
      personId: member.person.id,
      segmentIds: [hidden.id, hiddenC.id],
      severity: "CRITICAL",
      fingerprint: `hidden-${randomUUID()}`,
    });
    const manageableSecond = await createSegment({
      accountId: owner.account.id,
      personId: member.person.id,
      taskId: taskA.taskId,
      startAt: atHour(9.5),
      endAt: atHour(10.5),
      allocation: 55,
      content: "可处理 Task A 投入",
    });
    const manageableConflict = await createConflict({
      personId: member.person.id,
      segmentIds: [current.id, manageableSecond.id],
      severity: "HIGH",
      fingerprint: `manageable-${randomUUID()}`,
    });

    const taskCanvas = await getTimeCanvasData({
      actor: ownerActor,
      input: canvasInput({
        scope: { kind: "TASK_SCOPED", taskId: taskA.taskId },
        groupBy: "PERSON",
        includeBusyBlocks: true,
        includeConflicts: true,
      }),
    });
    expect(taskCanvas.rows.map((row) => row.id)).toEqual(
      expect.arrayContaining([owner.person.id, member.person.id]),
    );
    const fullCurrent = taskCanvas.segments.find(
      (segment) => segment.kind === "SEGMENT" && segment.id === current.id,
    );
    expect(fullCurrent).toMatchObject({
      kind: "SEGMENT",
      visibility: "FULL",
      versionToken: current.updatedAt.toISOString(),
    });
    const busy = taskCanvas.segments.find(
      (segment) =>
        segment.kind === "BUSY" &&
        segment.startAt === hidden.startAt.toISOString(),
    );
    expect(busy).toBeTruthy();
    expect(Object.keys(busy ?? {}).sort()).toEqual(
      [
        "allocation",
        "conflictSummary",
        "endAt",
        "kind",
        "personId",
        "startAt",
        "visibility",
      ].sort(),
    );
    expect(JSON.stringify(busy)).not.toContain("绝密 Task B 投入");
    const serializedTaskCanvas = JSON.stringify(taskCanvas);
    for (const forbidden of [
      hidden.id,
      "绝密 Task B 投入",
      taskB.taskId,
      taskB.milestoneNodeId,
      hiddenTag.id,
      hiddenTag.name,
      hiddenVersionToken,
    ]) {
      expect(serializedTaskCanvas).not.toContain(forbidden);
    }
    expect(fullSegmentIds(taskCanvas)).toContain(crossingRangeStart.id);
    expect(fullSegmentIds(taskCanvas)).not.toContain(endingAtRangeStart.id);
    expect(fullSegmentIds(taskCanvas)).not.toContain(startingAtRangeEnd.id);
    expect(taskCanvas.anchors[0]?.plannedStartAt).toBeNull();
    const actualDto = taskCanvas.segments.find(
      (segment) => segment.kind === "SEGMENT" && segment.id === actual.id,
    );
    expect(actualDto?.kind).toBe("SEGMENT");
    if (actualDto?.kind !== "SEGMENT") throw new Error("Actual DTO 缺失");
    expect(actualDto.permissions).toMatchObject({
      canEdit: true,
      canMove: false,
      canResize: false,
      canSplit: false,
      canMerge: false,
      canCancel: false,
      canConfirm: false,
      canRelink: false,
      canSoftDelete: true,
    });
    const mixed = taskCanvas.conflicts.find(
      (conflict) =>
        conflict.visibility === "VISIBLE" && conflict.id === mixedConflict.id,
    );
    expect(mixed).toMatchObject({
      visibility: "VISIBLE",
      hiddenSegmentCount: 1,
      capabilities: {
        canResolve: false,
        canPreviewSuggestion: false,
        canApplySuggestion: false,
      },
    });
    expect(JSON.stringify(mixed)).not.toContain("explanation");

    const managerCanvas = await getTimeCanvasData({
      actor: managerActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        includeBusyBlocks: true,
        includeConflicts: true,
      }),
    });
    const fullyHidden = managerCanvas.conflicts.find(
      (conflict) =>
        conflict.visibility === "HIDDEN" &&
        conflict.severity === allHiddenConflict.severity,
    );
    expect(fullyHidden).toMatchObject({
      visibility: "HIDDEN",
      hiddenSegmentCount: 2,
      capabilities: {
        canAcknowledge: false,
        canResolve: false,
        canIgnore: false,
        canPreviewSuggestion: false,
        canApplySuggestion: false,
      },
    });
    expect(Object.keys(fullyHidden ?? {}).sort()).toEqual(
      [
        "capabilities",
        "hiddenSegmentCount",
        "kind",
        "severity",
        "visibility",
      ].sort(),
    );
    const manageable = managerCanvas.conflicts.find(
      (conflict) =>
        conflict.visibility === "VISIBLE" &&
        conflict.id === manageableConflict.id,
    );
    expect(manageable?.capabilities.canResolve).toBe(true);

    for (const scope of ["PERSONAL", "DASHBOARD"] as const) {
      const canvas = await getTimeCanvasData({
        actor: ownerActor,
        input: canvasInput({ scope: { kind: scope }, groupBy: "PERSON" }),
      });
      expect(canvas.rows.map((row) => row.id)).toEqual([owner.person.id]);
      expect(
        canvas.segments.every((segment) => segment.personId === owner.person.id),
      ).toBe(true);
    }
    for (const scope of ["PERSONAL", "DASHBOARD"] as const) {
      const canvas = await getTimeCanvasData({
        actor: ownerActor,
        input: canvasInput({
          scope: { kind: scope },
          groupBy: "TASK",
          includeConflicts: true,
        }),
      });
      expect(canvas.rows.map((row) => row.id)).toContain(taskA.taskId);
      expect(
        canvas.segments.every(
          (segment) => segment.personId === owner.person.id,
        ),
      ).toBe(true);
      expect(canvas.conflicts).toEqual([]);
    }
    const ordinaryResource = await getTimeCanvasData({
      actor: ownerActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
      }),
    });
    expect(ordinaryResource.rows.map((row) => row.id)).toEqual([
      owner.person.id,
    ]);
    const taskGrouped = await getTimeCanvasData({
      actor: ownerActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "TASK",
      }),
    });
    expect(taskGrouped.rows.map((row) => row.id)).toContain(taskA.taskId);
    expect(taskGrouped.segments.every((segment) => segment.kind === "SEGMENT"))
      .toBe(true);

    await expectErrorCode(
      getTimeCanvasData({
        actor: ownerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [member.person.id],
        }),
      }),
      "NOT_FOUND",
    );
    await expectErrorCode(
      getTimeCanvasData({
        actor: ownerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          taskIds: [taskB.taskId],
        }),
      }),
      "NOT_FOUND",
    );
    await expectErrorCode(
      getTimeCanvasData({
        actor: ownerActor,
        input: canvasInput({
          scope: { kind: "PERSONAL" },
          groupBy: "PERSON",
          personIds: Array.from({ length: 51 }, () => randomUUID()),
        }),
      }),
      "QUERY_LIMIT_EXCEEDED",
    );
    await expectErrorCode(
      getTimeCanvasData({
        actor: adminActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [inactive.person.id],
        }),
      }),
      "NOT_FOUND",
    );

    const firstRowPage = await getTimeCanvasData({
      actor: ownerActor,
      input: canvasInput({
        scope: { kind: "TASK_SCOPED", taskId: taskA.taskId },
        groupBy: "PERSON",
        rowLimit: 1,
      }),
    });
    const secondRowPage = await getTimeCanvasData({
      actor: ownerActor,
      input: canvasInput({
        scope: { kind: "TASK_SCOPED", taskId: taskA.taskId },
        groupBy: "PERSON",
        rowLimit: 1,
        cursor: firstRowPage.nextCursor ?? undefined,
      }),
    });
    expect(secondRowPage.rows[0]?.id).not.toBe(firstRowPage.rows[0]?.id);
    await expectErrorCode(
      getTimeCanvasData({
        actor: ownerActor,
        input: canvasInput({
          scope: { kind: "TASK_SCOPED", taskId: taskA.taskId },
          groupBy: "PERSON",
          rowLimit: 1,
          includeActual: false,
          cursor: firstRowPage.nextCursor ?? undefined,
        }),
      }),
      "VALIDATION_ERROR",
    );
  });

  test("PERSONAL and DASHBOARD TASK pages scope conflicts to the actor and current rowIds", async () => {
    const owner = await createAccountPerson("Conflict 分页 Owner");
    const taskA = await createTask({
      ownerAccountId: owner.account.id,
      title: "Conflict 分页 A",
      team: "英雄",
      techGroup: "电控",
      members: [{ personId: owner.person.id, role: "OWNER" }],
    });
    const taskB = await createTask({
      ownerAccountId: owner.account.id,
      title: "Conflict 分页 B",
      team: "英雄",
      techGroup: "电控",
      members: [{ personId: owner.person.id, role: "OWNER" }],
    });
    const taskASegments = await Promise.all([
      createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        taskId: taskA.taskId,
        startAt: atHour(9),
        endAt: atHour(11),
        content: "Conflict A1",
      }),
      createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        taskId: taskA.taskId,
        startAt: atHour(9.5),
        endAt: atHour(10.5),
        content: "Conflict A2",
      }),
    ]);
    const taskBSegments = await Promise.all([
      createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        taskId: taskB.taskId,
        startAt: atHour(9),
        endAt: atHour(11),
        content: "Conflict B1",
      }),
      createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        taskId: taskB.taskId,
        startAt: atHour(9.5),
        endAt: atHour(10.5),
        content: "Conflict B2",
      }),
    ]);
    const independentSegments = await Promise.all([
      createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        startAt: atHour(9),
        endAt: atHour(11),
        content: "Independent Conflict 1",
      }),
      createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        startAt: atHour(9.5),
        endAt: atHour(10.5),
        content: "Independent Conflict 2",
      }),
    ]);
    const conflictA = await createConflict({
      personId: owner.person.id,
      segmentIds: taskASegments.map((segment) => segment.id),
      severity: "HIGH",
      fingerprint: `page-a-${randomUUID()}`,
    });
    const conflictB = await createConflict({
      personId: owner.person.id,
      segmentIds: taskBSegments.map((segment) => segment.id),
      severity: "MEDIUM",
      fingerprint: `page-b-${randomUUID()}`,
    });
    const independentConflict = await createConflict({
      personId: owner.person.id,
      segmentIds: independentSegments.map((segment) => segment.id),
      severity: "LOW",
      fingerprint: `page-independent-${randomUUID()}`,
    });

    for (const scope of ["PERSONAL", "DASHBOARD"] as const) {
      const firstPage = await getTimeCanvasData({
        actor: actor(owner),
        input: canvasInput({
          scope: { kind: scope },
          groupBy: "TASK",
          includeConflicts: true,
          rowLimit: 1,
        }),
      });
      const secondPage = await getTimeCanvasData({
        actor: actor(owner),
        input: canvasInput({
          scope: { kind: scope },
          groupBy: "TASK",
          includeConflicts: true,
          rowLimit: 1,
          cursor: firstPage.nextCursor ?? undefined,
        }),
      });
      expect(firstPage.rows.map((row) => row.id)).toEqual([taskA.taskId]);
      expect(secondPage.rows.map((row) => row.id)).toEqual([taskB.taskId]);
      expect(visibleConflictIds(firstPage)).toEqual([conflictA.id]);
      expect(visibleConflictIds(secondPage)).toEqual([conflictB.id]);
      expect(JSON.stringify([firstPage, secondPage])).not.toContain(
        independentConflict.id,
      );
    }
  });

  test("Busy and Conflict queries exclude exact half-open boundaries and keep adjacent intersections", async () => {
    const owner = await createAccountPerson("半开边界 Owner");
    const target = await createAccountPerson("半开边界目标");
    const hiddenOwner = await createAccountPerson("半开边界隐藏 Owner");
    const visibleTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "半开边界可见 Task",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    const hiddenTask = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "半开边界隐藏 Task",
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
    const conflictEvidence = await Promise.all([
      createSegment({
        accountId: owner.account.id,
        personId: target.person.id,
        taskId: visibleTask.taskId,
        startAt: atHour(9),
        endAt: atHour(11),
        content: "半开边界 Conflict Evidence A",
      }),
      createSegment({
        accountId: owner.account.id,
        personId: target.person.id,
        taskId: visibleTask.taskId,
        startAt: atHour(9.5),
        endAt: atHour(10.5),
        content: "半开边界 Conflict Evidence B",
      }),
    ]);
    const rangeStart = new Date(RANGE_START);
    const rangeEnd = new Date(RANGE_END);
    const justAfterRangeStart = new Date(rangeStart.getTime() + 1);
    const justBeforeRangeEnd = new Date(rangeEnd.getTime() - 1);
    const beforeRangeStart = new Date(rangeStart.getTime() - 60 * 60 * 1_000);
    const afterRangeEnd = new Date(rangeEnd.getTime() + 60 * 60 * 1_000);
    const busyFixtures = await Promise.all([
      createSegment({
        accountId: hiddenOwner.account.id,
        personId: target.person.id,
        taskId: hiddenTask.taskId,
        startAt: beforeRangeStart,
        endAt: rangeStart,
        content: "Busy 恰好结束于 rangeStart",
      }),
      createSegment({
        accountId: hiddenOwner.account.id,
        personId: target.person.id,
        taskId: hiddenTask.taskId,
        startAt: beforeRangeStart,
        endAt: justAfterRangeStart,
        content: "Busy 刚跨过 rangeStart",
      }),
      createSegment({
        accountId: hiddenOwner.account.id,
        personId: target.person.id,
        taskId: hiddenTask.taskId,
        startAt: rangeEnd,
        endAt: afterRangeEnd,
        content: "Busy 恰好开始于 rangeEnd",
      }),
      createSegment({
        accountId: hiddenOwner.account.id,
        personId: target.person.id,
        taskId: hiddenTask.taskId,
        startAt: justBeforeRangeEnd,
        endAt: afterRangeEnd,
        content: "Busy 刚跨入 rangeEnd",
      }),
    ]);
    const conflictFixtures = await Promise.all([
      createConflict({
        personId: target.person.id,
        segmentIds: conflictEvidence.map((segment) => segment.id),
        severity: "LOW",
        fingerprint: `half-open-conflict-end-exact-${randomUUID()}`,
        startAt: beforeRangeStart,
        endAt: rangeStart,
      }),
      createConflict({
        personId: target.person.id,
        segmentIds: conflictEvidence.map((segment) => segment.id),
        severity: "MEDIUM",
        fingerprint: `half-open-conflict-end-adjacent-${randomUUID()}`,
        startAt: beforeRangeStart,
        endAt: justAfterRangeStart,
      }),
      createConflict({
        personId: target.person.id,
        segmentIds: conflictEvidence.map((segment) => segment.id),
        severity: "HIGH",
        fingerprint: `half-open-conflict-start-exact-${randomUUID()}`,
        startAt: rangeEnd,
        endAt: afterRangeEnd,
      }),
      createConflict({
        personId: target.person.id,
        segmentIds: conflictEvidence.map((segment) => segment.id),
        severity: "CRITICAL",
        fingerprint: `half-open-conflict-start-adjacent-${randomUUID()}`,
        startAt: justBeforeRangeEnd,
        endAt: afterRangeEnd,
      }),
    ]);

    const canvas = await getTimeCanvasData({
      actor: actor(owner),
      input: canvasInput({
        scope: { kind: "TASK_SCOPED", taskId: visibleTask.taskId },
        groupBy: "PERSON",
        personIds: [target.person.id],
        includeBusyBlocks: true,
        includeConflicts: true,
      }),
    });
    const busyRanges = canvas.segments.flatMap((segment) =>
      segment.kind === "BUSY"
        ? [`${segment.startAt}|${segment.endAt}`]
        : [],
    );
    expect(busyRanges).toEqual(
      expect.arrayContaining([
        `${busyFixtures[1]!.startAt.toISOString()}|${busyFixtures[1]!.endAt.toISOString()}`,
        `${busyFixtures[3]!.startAt.toISOString()}|${busyFixtures[3]!.endAt.toISOString()}`,
      ]),
    );
    expect(busyRanges).not.toContain(
      `${busyFixtures[0]!.startAt.toISOString()}|${busyFixtures[0]!.endAt.toISOString()}`,
    );
    expect(busyRanges).not.toContain(
      `${busyFixtures[2]!.startAt.toISOString()}|${busyFixtures[2]!.endAt.toISOString()}`,
    );
    const returnedConflictIds = visibleConflictIds(canvas);
    expect(returnedConflictIds).toEqual([
      conflictFixtures[1]!.id,
      conflictFixtures[3]!.id,
    ]);
    expect(returnedConflictIds).not.toContain(conflictFixtures[0]!.id);
    expect(returnedConflictIds).not.toContain(conflictFixtures[2]!.id);
  });

  test("Busy blocks use hidden source IDs only as a stable tie-breaker", async () => {
    const owner = await createAccountPerson("Busy 稳定排序 Owner");
    const target = await createAccountPerson("Busy 稳定排序目标");
    const hiddenOwner = await createAccountPerson("Busy 稳定排序隐藏 Owner");
    const visibleTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "Busy 稳定排序可见 Task",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    const hiddenTaskTitle = `Busy 稳定排序绝密 Task ${randomUUID()}`;
    const hiddenTask = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: hiddenTaskTitle,
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
    const hiddenTag = await createTag(
      hiddenOwner.account.id,
      "Busy 稳定排序绝密 Tag",
    );
    const hiddenIdPrefix = randomUUID().slice(0, -1);
    const hiddenSegmentFixtures = Array.from({ length: 8 }, (_, index) => ({
      id: `${hiddenIdPrefix}${index.toString(16)}`,
      allocation: 31 + index,
      content: `Busy 稳定排序绝密投入 ${index}`,
    }));
    const hiddenSegments = [];
    for (const fixture of [...hiddenSegmentFixtures].reverse()) {
      hiddenSegments.push(
        await createSegment({
          id: fixture.id,
          accountId: hiddenOwner.account.id,
          personId: target.person.id,
          taskId: hiddenTask.taskId,
          nodeId: hiddenTask.milestoneNodeId,
          startAt: atHour(9),
          endAt: atHour(10),
          allocation: fixture.allocation,
          content: fixture.content,
          tagIds: [hiddenTag.id],
        }),
      );
    }

    const loadEqualKeyBusyBlocks = async () => {
      const canvas = await getTimeCanvasData({
        actor: actor(owner),
        input: canvasInput({
          scope: { kind: "TASK_SCOPED", taskId: visibleTask.taskId },
          groupBy: "PERSON",
          personIds: [target.person.id],
          includeBusyBlocks: true,
        }),
      });
      return canvas.segments.filter(
        (segment) =>
          segment.kind === "BUSY" &&
          segment.personId === target.person.id &&
          segment.startAt === atHour(9).toISOString() &&
          segment.endAt === atHour(10).toISOString(),
      );
    };
    const expectedAllocations = [...hiddenSegments]
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      )
      .map((segment) => Number(segment.allocation?.toString()));
    const firstRead = await loadEqualKeyBusyBlocks();
    const secondRead = await loadEqualKeyBusyBlocks();
    expect(firstRead.map((segment) => segment.allocation)).toEqual(
      expectedAllocations,
    );
    expect(secondRead).toEqual(firstRead);
    for (const busy of firstRead) {
      expect(Object.keys(busy).sort()).toEqual(
        [
          "allocation",
          "conflictSummary",
          "endAt",
          "kind",
          "personId",
          "startAt",
          "visibility",
        ].sort(),
      );
    }

    const serializedBusy = JSON.stringify(firstRead);
    for (const forbidden of [
      ...hiddenSegments.flatMap((segment) => [
        segment.id,
        segment.content,
        segment.updatedAt.toISOString(),
      ]),
      hiddenTask.taskId,
      hiddenTask.milestoneNodeId,
      hiddenTaskTitle,
      hiddenTag.id,
      hiddenTag.name,
      '"id"',
      '"taskId"',
      '"nodeId"',
      '"tagIds"',
      '"title"',
      '"versionToken"',
    ]) {
      expect(serializedBusy).not.toContain(forbidden);
    }
  });

  test("time-object limit accepts 5000 authorized Full records despite hidden data and rejects 5001 Full", async () => {
    test.setTimeout(120_000);
    const owner = await createAccountPerson("5000 Full 上限 Owner");
    const target = await createAccountPerson("5000 Full 上限目标");
    const hiddenOwner = await createAccountPerson("5000 Full 隐藏 Owner");
    const visibleTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "5000 Full 可见 Task",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    const hiddenTask = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "5000 Full 隐藏 Task",
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
    const startAt = atHour(9);
    const endAt = atHour(10);
    const rows = Array.from({ length: 5_000 }, (_, index) => ({
      id: randomUUID(),
      personId: target.person.id,
      type: "PLANNED" as const,
      status: "PLANNED" as const,
      startAt,
      endAt,
      content: `批量可见 ${index}`,
      allocation: new Prisma.Decimal(1),
      role: "DEVELOPER" as const,
      priority: "LOW" as const,
      taskId: visibleTask.taskId,
      createdByAccountId: owner.account.id,
    }));
    await createSegmentsInChunks(rows);
    const hiddenRows = Array.from({ length: 25 }, (_, index) => ({
      id: randomUUID(),
      personId: target.person.id,
      type: "PLANNED" as const,
      status: "PLANNED" as const,
      startAt,
      endAt,
      content: `批量隐藏 ${index}`,
      allocation: new Prisma.Decimal(1),
      role: "DEVELOPER" as const,
      priority: "LOW" as const,
      taskId: hiddenTask.taskId,
      createdByAccountId: hiddenOwner.account.id,
    }));
    await createSegmentsInChunks(hiddenRows);
    const input = canvasInput({
      scope: { kind: "TASK_SCOPED", taskId: visibleTask.taskId },
      groupBy: "PERSON",
      personIds: [target.person.id],
      includeBusyBlocks: false,
    });
    const atLimit = await getTimeCanvasData({ actor: actor(owner), input });
    expect(atLimit.segments).toHaveLength(5_000);
    expect(JSON.stringify(atLimit)).not.toContain(hiddenRows[0]!.id);
    expect(JSON.stringify(atLimit)).not.toContain("批量隐藏");
    await createSegment({
      accountId: owner.account.id,
      personId: target.person.id,
      taskId: visibleTask.taskId,
      startAt,
      endAt,
      content: "第 5001 条",
    });
    await expectErrorCode(
      getTimeCanvasData({ actor: actor(owner), input }),
      "QUERY_LIMIT_EXCEEDED",
    );
  });

  test("time-object limit rejects 5001 Busy-only records without an unbounded response", async () => {
    test.setTimeout(120_000);
    const owner = await createAccountPerson("5001 Busy Owner");
    const target = await createAccountPerson("5001 Busy 目标");
    const hiddenOwner = await createAccountPerson("5001 Busy 隐藏 Owner");
    const visibleTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "5001 Busy 画布 Task",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    const hiddenTask = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "5001 Busy 隐藏 Task",
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
    await createSegmentsInChunks(
      Array.from({ length: 5_001 }, (_, index) => ({
        id: randomUUID(),
        personId: target.person.id,
        type: "PLANNED" as const,
        status: "PLANNED" as const,
        startAt: atHour(9),
        endAt: atHour(10),
        content: `Busy-only 隐藏 ${index}`,
        allocation: new Prisma.Decimal(1),
        role: "DEVELOPER" as const,
        priority: "LOW" as const,
        taskId: hiddenTask.taskId,
        createdByAccountId: hiddenOwner.account.id,
      })),
    );
    await expectErrorCode(
      getTimeCanvasData({
        actor: actor(owner),
        input: canvasInput({
          scope: { kind: "TASK_SCOPED", taskId: visibleTask.taskId },
          groupBy: "PERSON",
          personIds: [target.person.id],
          includeBusyBlocks: true,
        }),
      }),
      "QUERY_LIMIT_EXCEEDED",
    );
  });

  test("time-object limit rejects 4999 Full plus 2 Busy as one 5001-object response", async () => {
    test.setTimeout(120_000);
    const owner = await createAccountPerson("4999 Full + 2 Busy Owner");
    const target = await createAccountPerson("4999 Full + 2 Busy 目标");
    const hiddenOwner = await createAccountPerson("4999 Full + 2 Busy 隐藏 Owner");
    const visibleTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "4999 Full + 2 Busy 可见 Task",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
      ],
    });
    const hiddenTask = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "4999 Full + 2 Busy 隐藏 Task",
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
    await createSegmentsInChunks([
      ...Array.from({ length: 4_999 }, (_, index) => ({
        id: randomUUID(),
        personId: target.person.id,
        type: "PLANNED" as const,
        status: "PLANNED" as const,
        startAt: atHour(9),
        endAt: atHour(10),
        content: `Full+Busy 可见 ${index}`,
        allocation: new Prisma.Decimal(1),
        role: "DEVELOPER" as const,
        priority: "LOW" as const,
        taskId: visibleTask.taskId,
        createdByAccountId: owner.account.id,
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        id: randomUUID(),
        personId: target.person.id,
        type: "PLANNED" as const,
        status: "PLANNED" as const,
        startAt: atHour(9),
        endAt: atHour(10),
        content: `Full+Busy 隐藏 ${index}`,
        allocation: new Prisma.Decimal(1),
        role: "DEVELOPER" as const,
        priority: "LOW" as const,
        taskId: hiddenTask.taskId,
        createdByAccountId: hiddenOwner.account.id,
      })),
    ]);
    await expectErrorCode(
      getTimeCanvasData({
        actor: actor(owner),
        input: canvasInput({
          scope: { kind: "TASK_SCOPED", taskId: visibleTask.taskId },
          groupBy: "PERSON",
          personIds: [target.person.id],
          includeBusyBlocks: true,
        }),
      }),
      "QUERY_LIMIT_EXCEEDED",
    );
  });

  test("placement preview accepts 5000 dense candidates and rejects candidate 5001", async () => {
    test.setTimeout(120_000);
    const owner = await createAccountPerson("Preview 5000 边界 Owner");
    await createSegmentsInChunks(
      Array.from({ length: 5_000 }, (_, index) => ({
        id: randomUUID(),
        personId: owner.person.id,
        type: "PLANNED" as const,
        status: "PLANNED" as const,
        startAt: atHour(9),
        endAt: atHour(10),
        content: `Preview dense ${index}`,
        allocation: new Prisma.Decimal("0.01"),
        role: "DEVELOPER" as const,
        priority: "LOW" as const,
        createdByAccountId: owner.account.id,
      })),
    );
    const exact = await previewSegmentPlacement({
      actor: actor(owner),
      input: {
        personId: owner.person.id,
        startAt: atHour(9).toISOString(),
        endAt: atHour(10).toISOString(),
        allocation: 0.01,
        associationIntent: "KEEP",
      },
    });
    expect(exact.personId).toBe(owner.person.id);

    await createSegment({
      accountId: owner.account.id,
      personId: owner.person.id,
      startAt: atHour(9),
      endAt: atHour(10),
      allocation: 0.01,
      content: "Preview dense overflow",
    });
    await expectErrorCode(
      previewSegmentPlacement({
        actor: actor(owner),
        input: {
          personId: owner.person.id,
          startAt: atHour(9).toISOString(),
          endAt: atHour(10).toISOString(),
          allocation: 0.01,
          associationIntent: "KEEP",
        },
      }),
      "QUERY_LIMIT_EXCEEDED",
    );
  });

  test("Conflict DTO budget accepts 5000 and rejects 5001 independently of time objects", async () => {
    test.setTimeout(120_000);
    const owner = await createAccountPerson("Conflict 5000 边界 Owner");
    await createSegment({
      accountId: owner.account.id,
      personId: owner.person.id,
      startAt: atHour(9),
      endAt: atHour(10),
      allocation: 10,
    });
    const conflicts = Array.from({ length: 5_001 }, (_, index) => ({
      id: randomUUID(),
      personId: owner.person.id,
      kind: "ALLOCATION_OVER_LIMIT" as const,
      startAt: atHour(9),
      endAt: atHour(10),
      severity: "MEDIUM" as const,
      status: "OPEN" as const,
      fingerprint: `s2-conflict-budget-${randomUUID()}-${index}`,
      explanation: {},
    }));
    await prisma.resourceConflict.createMany({ data: conflicts.slice(0, 5_000) });
    const input = canvasInput({
      scope: { kind: "PERSONAL" },
      groupBy: "PERSON",
      includeConflicts: true,
      includeTaskAnchors: false,
    });
    const exact = await getTimeCanvasData({ actor: actor(owner), input });
    expect(exact.conflicts).toHaveLength(5_000);
    expect(
      exact.conflicts.every(
        (conflict) =>
          conflict.visibility === "HIDDEN" &&
          Object.keys(conflict).sort().join("|") ===
            [
              "capabilities",
              "hiddenSegmentCount",
              "kind",
              "severity",
              "visibility",
            ]
              .sort()
              .join("|"),
      ),
    ).toBe(true);
    await prisma.resourceConflict.create({ data: conflicts[5_000]! });
    await expectErrorCode(
      getTimeCanvasData({ actor: actor(owner), input }),
      "QUERY_LIMIT_EXCEEDED",
    );
  });

  test("anchor Task and total current-plan Node budgets enforce exact boundaries", async () => {
    test.setTimeout(180_000);
    const owner = await createAccountPerson("Anchor budget Owner");
    const target = await createAccountPerson("Anchor budget Target");
    await createAnchorTaskBatch({
      ownerAccountId: owner.account.id,
      ownerPersonId: owner.person.id,
      targetPersonId: target.person.id,
      titlePrefix: "Anchor Task boundary",
      taskCount: 50,
      nodesPerTask: 1,
    });
    const taskBudgetInput = canvasInput({
      scope: { kind: "RESOURCE_PLANNER" },
      groupBy: "PERSON",
      personIds: [target.person.id],
      includeTaskAnchors: true,
    });
    const exactTasks = await getTimeCanvasData({
      actor: actor(owner, [systemAdministratorRole()]),
      input: taskBudgetInput,
    });
    expect(exactTasks.anchors).toHaveLength(50);
    await createAnchorTaskBatch({
      ownerAccountId: owner.account.id,
      ownerPersonId: owner.person.id,
      targetPersonId: target.person.id,
      titlePrefix: "Anchor Task overflow",
      taskCount: 1,
      nodesPerTask: 1,
    });
    await expectErrorCode(
      getTimeCanvasData({
        actor: actor(owner, [systemAdministratorRole()]),
        input: taskBudgetInput,
      }),
      "QUERY_LIMIT_EXCEEDED",
    );

    const nodeOwner = await createAccountPerson("Anchor node budget Owner");
    const nodeTarget = await createAccountPerson("Anchor node budget Target");
    await createAnchorTaskBatch({
      ownerAccountId: nodeOwner.account.id,
      ownerPersonId: nodeOwner.person.id,
      targetPersonId: nodeTarget.person.id,
      titlePrefix: "Anchor 200-node exact",
      taskCount: 25,
      nodesPerTask: 200,
    });
    const nodeBudgetInput = canvasInput({
      scope: { kind: "RESOURCE_PLANNER" },
      groupBy: "PERSON",
      personIds: [nodeTarget.person.id],
      includeTaskAnchors: true,
    });
    const exactNodes = await getTimeCanvasData({
      actor: actor(nodeOwner, [systemAdministratorRole()]),
      input: nodeBudgetInput,
    });
    expect(exactNodes.anchors).toHaveLength(25);
    expect(
      exactNodes.anchors.reduce((count, anchor) => count + anchor.nodes.length, 0),
    ).toBe(5_000);
    expect(exactNodes.anchors.every((anchor) => anchor.nodes.length === 200)).toBe(
      true,
    );
    await createAnchorTaskBatch({
      ownerAccountId: nodeOwner.account.id,
      ownerPersonId: nodeOwner.person.id,
      targetPersonId: nodeTarget.person.id,
      titlePrefix: "Anchor 200-node overflow",
      taskCount: 1,
      nodesPerTask: 200,
    });
    await expectErrorCode(
      getTimeCanvasData({
        actor: actor(nodeOwner, [systemAdministratorRole()]),
        input: nodeBudgetInput,
      }),
      "QUERY_LIMIT_EXCEEDED",
    );
  });

  test("placement preview enforces management and association privacy, shares scanner rules and writes nothing", async () => {
    const manager = await createAccountPerson("Preview 资源经理");
    const target = await createAccountPerson("Preview 目标人员");
    const visibleOwner = await createAccountPerson("Preview 可见 Owner");
    const hiddenOwner = await createAccountPerson("Preview 隐藏 Owner");
    const viewer = await createAccountPerson("Preview Viewer");
    const outsider = await createAccountPerson("Preview Outsider");
    const managerActor = actor(manager, [
      scopedRole("RESOURCE_MANAGER", "英雄", "电控"),
    ]);
    await grantScopedRole(
      manager.account.id,
      "RESOURCE_MANAGER",
      "英雄",
      "电控",
    );
    const taskA = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Preview 可见 Task",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: visibleOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "MEMBER" },
        { personId: viewer.person.id, role: "VIEWER" },
      ],
    });
    const taskB = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "Preview 隐藏 Task",
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
    const taskC = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Preview 重关联目标 Task",
      team: "英雄",
      techGroup: "电控",
      members: [{ personId: visibleOwner.person.id, role: "OWNER" }],
    });
    const editable = await createSegment({
      accountId: visibleOwner.account.id,
      personId: target.person.id,
      taskId: taskA.taskId,
      nodeId: taskA.milestoneNodeId,
      startAt: atHour(9),
      endAt: atHour(10),
      allocation: 60,
      content: "Preview 候选",
      associationNeedsReview: true,
    });
    await createSegment({
      accountId: hiddenOwner.account.id,
      personId: target.person.id,
      taskId: taskB.taskId,
      nodeId: taskB.milestoneNodeId,
      startAt: atHour(9.5),
      endAt: atHour(10.5),
      allocation: 60,
      content: "Preview 隐藏命中",
    });
    const before = await previewWriteState(target.person.id);
    const hiddenPreview = await previewSegmentPlacement({
      actor: managerActor,
      input: {
        segmentId: editable.id,
        personId: target.person.id,
        startAt: atHour(9).toISOString(),
        endAt: atHour(10).toISOString(),
      },
    });
    expect(hiddenPreview.conflicts).toContainEqual({
      kind: "PLACEMENT_CONFLICT",
      visibility: "HIDDEN",
      blocked: true,
    });
    expect(
      hiddenPreview.conflicts.filter(
        (conflict) => conflict.visibility === "HIDDEN",
      ),
    ).toHaveLength(1);
    expect(Object.keys(hiddenPreview.conflicts.at(-1) ?? {}).sort()).toEqual(
      ["blocked", "kind", "visibility"].sort(),
    );
    expect(await previewWriteState(target.person.id)).toEqual(before);

    await expectErrorCode(
      previewSegmentPlacement({
        actor: actor(viewer),
        input: {
          segmentId: editable.id,
          personId: target.person.id,
          startAt: atHour(9).toISOString(),
          endAt: atHour(10).toISOString(),
        },
      }),
      "FORBIDDEN",
    );
    await expectErrorCode(
      previewSegmentPlacement({
        actor: actor(outsider),
        input: {
          segmentId: editable.id,
          personId: target.person.id,
          startAt: atHour(9).toISOString(),
          endAt: atHour(10).toISOString(),
        },
      }),
      "NOT_FOUND",
    );
    await expectErrorCode(
      previewSegmentPlacement({
        actor: managerActor,
        input: {
          segmentId: editable.id,
          personId: manager.person.id,
          startAt: atHour(9).toISOString(),
          endAt: atHour(10).toISOString(),
        },
      }),
      "ASSOCIATION_INVALID",
    );
    await expectErrorCode(
      previewSegmentPlacement({
        actor: managerActor,
        input: {
          personId: target.person.id,
          taskId: taskB.taskId,
          nodeId: taskB.milestoneNodeId,
          associationIntent: "RELINK",
          startAt: atHour(9).toISOString(),
          endAt: atHour(10).toISOString(),
        },
      }),
      "NOT_FOUND",
    );

    const consistencyTarget = await createAccountPerson("Preview 一致性人员");
    await prisma.taskMember.create({
      data: {
        taskId: taskA.taskId,
        personId: consistencyTarget.person.id,
        role: "MEMBER",
        createdByAccountId: visibleOwner.account.id,
      },
    });
    await prisma.taskMember.create({
      data: {
        taskId: taskC.taskId,
        personId: consistencyTarget.person.id,
        role: "MEMBER",
        createdByAccountId: visibleOwner.account.id,
      },
    });
    await createSegment({
      accountId: visibleOwner.account.id,
      personId: consistencyTarget.person.id,
      taskId: taskA.taskId,
      nodeId: taskA.milestoneNodeId,
      startAt: atHour(9),
      endAt: atHour(10),
      allocation: 60,
      content: "一致性已有安排",
    });
    const reviewCandidate = await createSegment({
      accountId: visibleOwner.account.id,
      personId: consistencyTarget.person.id,
      taskId: taskA.taskId,
      nodeId: taskA.milestoneNodeId,
      startAt: atHour(9),
      endAt: atHour(10),
      allocation: 20,
      content: "待重关联 Preview 候选",
      associationNeedsReview: true,
    });
    const beforeRelinkPreviews = await previewWriteState(
      consistencyTarget.person.id,
    );
    const pureMovePreview = await previewSegmentPlacement({
      actor: managerActor,
      input: {
        segmentId: reviewCandidate.id,
        personId: consistencyTarget.person.id,
        startAt: atHour(9.1).toISOString(),
        endAt: atHour(10.1).toISOString(),
      },
    });
    expect(visibleConflictReasons(pureMovePreview)).toContain("REVISION_OVERLAP");
    await expectErrorCode(
      previewSegmentPlacement({
        actor: managerActor,
        input: {
          segmentId: reviewCandidate.id,
          personId: consistencyTarget.person.id,
          startAt: atHour(9.1).toISOString(),
          endAt: atHour(10.1).toISOString(),
          role: "LEAD",
        },
      }),
      "ASSOCIATION_INVALID",
    );
    const explicitSameAssociationPreview = await previewSegmentPlacement({
      actor: managerActor,
      input: {
        segmentId: reviewCandidate.id,
        personId: consistencyTarget.person.id,
        taskId: taskA.taskId,
        nodeId: taskA.milestoneNodeId,
        associationIntent: "RELINK",
        startAt: atHour(9.1).toISOString(),
        endAt: atHour(10.1).toISOString(),
      },
    });
    expect(visibleConflictReasons(explicitSameAssociationPreview)).not.toContain(
      "REVISION_OVERLAP",
    );
    const changedAssociationPreview = await previewSegmentPlacement({
      actor: managerActor,
      input: {
        segmentId: reviewCandidate.id,
        personId: consistencyTarget.person.id,
        taskId: taskC.taskId,
        nodeId: taskC.milestoneNodeId,
        associationIntent: "RELINK",
        startAt: atHour(9.1).toISOString(),
        endAt: atHour(10.1).toISOString(),
      },
    });
    expect(visibleConflictReasons(changedAssociationPreview)).not.toContain(
      "REVISION_OVERLAP",
    );
    expect(await previewWriteState(consistencyTarget.person.id)).toEqual(
      beforeRelinkPreviews,
    );
    const keepResult = await updateWorkSegment(managerActor, {
      segmentId: reviewCandidate.id,
      expectedUpdatedAt: reviewCandidate.updatedAt,
      associationIntent: "KEEP",
      startAt: atHour(9.1),
      endAt: atHour(10.1),
      reason: "KEEP 保留 Revision 待复核关联",
    });
    expect(keepResult.segment.associationNeedsReview).toBe(true);
    expect(keepResult.segment.taskId).toBe(taskA.taskId);
    expect(keepResult.segment.nodeId).toBe(taskA.milestoneNodeId);
    await expectErrorCode(
      updateWorkSegment(managerActor, {
        segmentId: reviewCandidate.id,
        expectedUpdatedAt: keepResult.segment.updatedAt,
        associationIntent: "KEEP",
        taskId: taskC.taskId,
        nodeId: taskC.milestoneNodeId,
      }),
      "ASSOCIATION_INVALID",
    );
    await expectErrorCode(
      updateWorkSegment(managerActor, {
        segmentId: reviewCandidate.id,
        expectedUpdatedAt: keepResult.segment.updatedAt,
        associationIntent: "RELINK",
        reason: "验证错误 Node 不得重关联",
        taskId: taskA.taskId,
        nodeId: taskC.milestoneNodeId,
      }),
      "ASSOCIATION_INVALID",
    );
    await expectErrorCode(
      updateWorkSegment(managerActor, {
        segmentId: reviewCandidate.id,
        expectedUpdatedAt: keepResult.segment.updatedAt,
        associationIntent: "RELINK",
        reason: "验证隐藏目标不得重关联",
        taskId: taskB.taskId,
        nodeId: taskB.milestoneNodeId,
      }),
      "NOT_FOUND",
    );
    await expectErrorCode(
      updateWorkSegment(managerActor, {
        segmentId: reviewCandidate.id,
        expectedUpdatedAt: keepResult.segment.updatedAt,
        associationIntent: "RELINK",
        taskId: taskC.taskId,
        nodeId: taskC.milestoneNodeId,
      }),
      "VALIDATION_ERROR",
    );
    const relinkResult = await updateWorkSegment(managerActor, {
      segmentId: reviewCandidate.id,
      expectedUpdatedAt: keepResult.segment.updatedAt,
      associationIntent: "RELINK",
      taskId: taskC.taskId,
      nodeId: taskC.milestoneNodeId,
      reason: "RELINK 明确确认新关联",
    });
    expect(relinkResult.segment.associationNeedsReview).toBe(false);
    expect(relinkResult.segment.taskId).toBe(taskC.taskId);
    expect(relinkResult.segment.nodeId).toBe(taskC.milestoneNodeId);
    expect(
      await prisma.resourceConflict.count({
        where: {
          personId: consistencyTarget.person.id,
          kind: "REVISION_OVERLAP",
          status: { not: "RESOLVED" },
        },
      }),
    ).toBe(0);
    await createSegment({
      accountId: visibleOwner.account.id,
      personId: consistencyTarget.person.id,
      taskId: taskC.taskId,
      nodeId: taskC.milestoneNodeId,
      startAt: atHour(9.5),
      endAt: atHour(10.5),
      allocation: 10,
      role: "OWNER",
      content: "Preview role 一致性已有安排",
    });
    const visiblePreview = await previewSegmentPlacement({
      actor: managerActor,
      input: {
        personId: consistencyTarget.person.id,
        taskId: taskA.taskId,
        nodeId: taskA.milestoneNodeId,
        associationIntent: "RELINK",
        startAt: atHour(9.5).toISOString(),
        endAt: atHour(10.5).toISOString(),
        allocation: 60,
        priority: "MEDIUM",
        role: "LEAD",
      },
    });
    expect(
      visiblePreview.conflicts.some(
        (conflict) =>
          conflict.visibility === "VISIBLE" &&
          conflict.reason === "ALLOCATION_OVER_LIMIT",
      ),
    ).toBe(true);
    expect(visibleConflictReasons(visiblePreview)).toContain(
      "LEAD_ROLE_OVERLAP",
    );
    const defaultRolePreview = await previewSegmentPlacement({
      actor: managerActor,
      input: {
        personId: consistencyTarget.person.id,
        taskId: taskA.taskId,
        nodeId: taskA.milestoneNodeId,
        associationIntent: "RELINK",
        startAt: atHour(9.5).toISOString(),
        endAt: atHour(10.5).toISOString(),
        allocation: 60,
        priority: "MEDIUM",
      },
    });
    expect(visibleConflictReasons(defaultRolePreview)).not.toContain(
      "LEAD_ROLE_OVERLAP",
    );
    await createSegment({
      accountId: visibleOwner.account.id,
      personId: consistencyTarget.person.id,
      taskId: taskA.taskId,
      nodeId: taskA.milestoneNodeId,
      startAt: atHour(9.5),
      endAt: atHour(10.5),
      allocation: 60,
      content: "一致性最终安排",
    });
    await scanConflictsForPerson({
      personId: consistencyTarget.person.id,
      startAt: atHour(8),
      endAt: atHour(12),
    });
    const scannerKinds = await prisma.resourceConflict.findMany({
      where: { personId: consistencyTarget.person.id },
      select: { kind: true },
    });
    expect(scannerKinds.map((conflict) => conflict.kind)).toContain(
      "ALLOCATION_OVER_LIMIT",
    );
  });

  test("empty canvases retain safe rows without fabricating time objects", async () => {
    const person = await createAccountPerson("空画布人员");
    const personal = await getTimeCanvasData({
      actor: actor(person),
      input: canvasInput({
        scope: { kind: "PERSONAL" },
        groupBy: "PERSON",
        includeConflicts: true,
      }),
    });
    expect(personal.rows.map((row) => row.id)).toEqual([person.person.id]);
    expect(personal.segments).toEqual([]);
    expect(personal.conflicts).toEqual([]);
    expect(personal.anchors).toEqual([]);
    expect(personal.nextCursor).toBeNull();

    const taskGrouped = await getTimeCanvasData({
      actor: actor(person),
      input: canvasInput({
        scope: { kind: "DASHBOARD" },
        groupBy: "TASK",
        includeConflicts: true,
      }),
    });
    expect(taskGrouped.rows).toEqual([]);
    expect(taskGrouped.segments).toEqual([]);
    expect(taskGrouped.conflicts).toEqual([]);
    expect(taskGrouped.anchors).toEqual([]);
    expect(taskGrouped.nextCursor).toBeNull();
  });

  test("extracted conflict detection preserves P5 statuses, rules, severity, evidence, merge keys, fingerprint and explanation", async () => {
    expect(ACTIVE_PLANNED_CONFLICT_STATUSES).toEqual([
      "PLANNED",
      "IN_PROGRESS",
      "PENDING_CONFIRMATION",
    ]);
    const personId = "detector-person";
    const segments: ConflictDetectionSegment[] = [
      detectionSegment("allocation-z", 9, 10, {
        status: "PLANNED",
        allocation: 60,
      }),
      detectionSegment("allocation-a", 9, 10, {
        status: "IN_PROGRESS",
        allocation: 60,
      }),
      detectionSegment("allocation-m", 9, 10, {
        status: "PENDING_CONFIRMATION",
        allocation: 60,
      }),
      detectionSegment("planned-confirmed-excluded", 9, 10, {
        status: "CONFIRMED",
        allocation: 100,
      }),
      detectionSegment("planned-cancelled-excluded", 9, 10, {
        status: "CANCELLED",
        allocation: 100,
      }),
      detectionSegment("allocation-high-b", 8, 8.5, { allocation: 60 }),
      detectionSegment("allocation-high-a", 8, 8.5, { allocation: 60 }),
      detectionSegment("missing-b", 10, 11, { allocation: null }),
      detectionSegment("missing-a", 10, 11, { allocation: 40 }),
      detectionSegment("priority-b", 11, 12, { priority: "HIGH" }),
      detectionSegment("priority-a", 11, 12, { priority: "CRITICAL" }),
      detectionSegment("lead-b", 12, 13, {
        role: "OWNER",
        taskId: "task-b",
      }),
      detectionSegment("lead-a", 12, 13, {
        role: "LEAD",
        taskId: "task-a",
      }),
      detectionSegment("revision-b", 13, 14, {
        associationNeedsReview: true,
      }),
      detectionSegment("revision-a", 13, 14),
      detectionSegment("actual-b", 14, 15, {
        type: "ACTUAL",
        status: "CONFIRMED",
        allocation: 80,
      }),
      detectionSegment("actual-a", 14, 15, {
        type: "ACTUAL",
        status: "CONFIRMED",
        allocation: 70,
      }),
      detectionSegment("actual-unconfirmed-excluded", 14, 15, {
        type: "ACTUAL",
        status: "PLANNED",
        allocation: 100,
      }),
      detectionSegment("merge-b", 16, 19, { priority: "HIGH" }),
      detectionSegment("merge-a", 16, 19, { priority: "CRITICAL" }),
      detectionSegment("merge-low-boundary", 16.5, 18.5),
      detectionSegment("merge-key-change", 17, 18, { priority: "HIGH" }),
    ];
    const detected = detectResourceConflictsForSegments(
      personId,
      { startAt: atHour(7), endAt: atHour(20) },
      segments,
    );
    const allocationCritical = findDetectedConflict(
      detected,
      "ALLOCATION_OVER_LIMIT",
      9,
    );
    expect(allocationCritical.severity).toBe("CRITICAL");
    expect(allocationCritical.segmentIds).toEqual([
      "allocation-a",
      "allocation-m",
      "allocation-z",
    ]);
    expect(allocationCritical.evidenceSegmentIds).toEqual([
      "allocation-z",
      "allocation-a",
      "allocation-m",
    ]);
    expect(allocationCritical.allocationTotal).toBe(180);
    expect(
      findDetectedConflict(detected, "ALLOCATION_OVER_LIMIT", 8).severity,
    ).toBe("HIGH");

    const missing = findDetectedConflict(detected, "MISSING_ALLOCATION", 10);
    expect(missing.severity).toBe("MEDIUM");
    expect(missing.segmentIds).toEqual(["missing-a", "missing-b"]);
    expect(missing.evidenceSegmentIds).toEqual(["missing-b", "missing-a"]);
    expect(missing.missingAllocationSegmentIds).toEqual(["missing-b"]);
    expect(
      findDetectedConflict(detected, "HIGH_PRIORITY_OVERLAP", 11).severity,
    ).toBe("CRITICAL");
    expect(findDetectedConflict(detected, "LEAD_ROLE_OVERLAP", 12).severity).toBe(
      "HIGH",
    );
    expect(findDetectedConflict(detected, "REVISION_OVERLAP", 13).severity).toBe(
      "MEDIUM",
    );
    expect(findDetectedConflict(detected, "ACTUAL_OVERLOAD", 14).severity).toBe(
      "HIGH",
    );
    const mergeConflicts = detected.filter(
      (conflict) =>
        conflict.kind === "HIGH_PRIORITY_OVERLAP" &&
        conflict.startAt >= atHour(16),
    );
    expect(
      mergeConflicts.map((conflict) => ({
        startAt: conflict.startAt.toISOString(),
        endAt: conflict.endAt.toISOString(),
        segmentIds: conflict.segmentIds,
      })),
    ).toEqual([
      {
        startAt: atHour(16).toISOString(),
        endAt: atHour(17).toISOString(),
        segmentIds: ["merge-a", "merge-b"],
      },
      {
        startAt: atHour(17).toISOString(),
        endAt: atHour(18).toISOString(),
        segmentIds: ["merge-a", "merge-b", "merge-key-change"],
      },
      {
        startAt: atHour(18).toISOString(),
        endAt: atHour(19).toISOString(),
        segmentIds: ["merge-a", "merge-b"],
      },
    ]);

    const persistedPerson = await createAccountPerson("P5 抽取持久化人员");
    const first = await createSegment({
      accountId: persistedPerson.account.id,
      personId: persistedPerson.person.id,
      startAt: atHour(9),
      endAt: atHour(10),
      allocation: 70,
      content: "P5 证据 first",
    });
    const second = await createSegment({
      accountId: persistedPerson.account.id,
      personId: persistedPerson.person.id,
      startAt: atHour(9.5),
      endAt: atHour(10.5),
      allocation: 60,
      content: "P5 证据 second",
    });
    await scanConflictsForPerson({
      personId: persistedPerson.person.id,
      startAt: atHour(8),
      endAt: atHour(12),
    });
    const persisted = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: persistedPerson.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
      },
      select: {
        kind: true,
        severity: true,
        startAt: true,
        endAt: true,
        fingerprint: true,
        explanation: true,
        segments: { select: { segmentId: true } },
      },
    });
    const sortedIds = [first.id, second.id].sort();
    expect(persisted.severity).toBe("HIGH");
    expect(persisted.segments.map((entry) => entry.segmentId).sort()).toEqual(
      sortedIds,
    );
    expect(persisted.fingerprint).toBe(
      expectedConflictFingerprint({
        kind: persisted.kind,
        personId: persistedPerson.person.id,
        startAt: persisted.startAt,
        endAt: persisted.endAt,
        segmentIds: sortedIds,
      }),
    );
    expect(persisted.explanation).toEqual({
      kind: "ALLOCATION_OVER_LIMIT",
      reason: "Planned Allocation 合计 130% 超过 100%",
      startAt: atHour(9.5).toISOString(),
      endAt: atHour(10).toISOString(),
      segmentIds: sortedIds,
      segments: [
        {
          id: first.id,
          content: "P5 证据 first",
          type: "PLANNED",
          status: "PLANNED",
          allocation: 70,
          priority: "MEDIUM",
          role: "DEVELOPER",
          taskId: null,
        },
        {
          id: second.id,
          content: "P5 证据 second",
          type: "PLANNED",
          status: "PLANNED",
          allocation: 60,
          priority: "MEDIUM",
          role: "DEVELOPER",
          taskId: null,
        },
      ],
      allocationTotal: 130,
    });
  });

  test("dashboard basis contains only the actor's visible active work and own unread notifications", async () => {
    const owner = await createAccountPerson("Dashboard Owner");
    const hiddenOwner = await createAccountPerson("Dashboard Hidden Owner");
    const visibleTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "Dashboard 可见 Active",
      team: "英雄",
      techGroup: "电控",
      members: [{ personId: owner.person.id, role: "OWNER" }],
    });
    const hiddenTask = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "Dashboard 隐藏 Active",
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
    const pending = await createSegment({
      accountId: owner.account.id,
      personId: owner.person.id,
      taskId: visibleTask.taskId,
      status: "PENDING_CONFIRMATION",
      startAt: atHour(9),
      endAt: atHour(10),
      content: "Dashboard 待确认",
    });
    await createSegment({
      accountId: hiddenOwner.account.id,
      personId: hiddenOwner.person.id,
      taskId: hiddenTask.taskId,
      startAt: atHour(9),
      endAt: atHour(10),
      content: "Dashboard 他人安排",
    });
    await prisma.inAppNotification.createMany({
      data: [
        {
          recipientAccountId: owner.account.id,
          category: "TASK",
          title: "本人未读",
          entityType: "Task",
          entityId: visibleTask.taskId,
          taskId: visibleTask.taskId,
        },
        {
          recipientAccountId: hiddenOwner.account.id,
          category: "TASK",
          title: "他人未读",
          entityType: "Task",
          entityId: hiddenTask.taskId,
          taskId: hiddenTask.taskId,
        },
      ],
    });
    const dashboard = await getMyWorkDashboard({
      actor: actor(owner),
      input: { rangeStart: RANGE_START, rangeEnd: RANGE_END },
    });
    expect(dashboard.activeTasks.map((task) => task.id)).toContain(
      visibleTask.taskId,
    );
    expect(dashboard.activeTasks.map((task) => task.id)).not.toContain(
      hiddenTask.taskId,
    );
    expect(dashboard.personalTime.rows.map((row) => row.id)).toEqual([
      owner.person.id,
    ]);
    expect(dashboard.pendingConfirmations.map((segment) => segment.id)).toEqual([
      pending.id,
    ]);
    expect(dashboard.unreadNotificationCount).toBe(1);
  });
});

async function createAccountPerson(
  displayName: string,
  status: "ACTIVE" | "INACTIVE" = "ACTIVE",
  accountStatus: "ACTIVE" | "DISABLED" = "ACTIVE",
) {
  const openId = `ou_s2_canvas_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      status: accountStatus,
      person: { create: { displayName, status } },
      identities: {
        create: {
          provider: "FEISHU",
          providerSubject: openId,
          tenantId: "default",
          openId,
        },
      },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { account, person: account.person, openId };
}

async function createTask({
  ownerAccountId,
  title,
  team,
  techGroup,
  members,
  plannedStartAt = atHour(8),
  status = "ACTIVE",
}: {
  ownerAccountId: string;
  title: string;
  team: string;
  techGroup: string;
  members: Array<{ personId: string; role: TaskMemberRoleInput }>;
  plannedStartAt?: Date | null;
  status?: TaskStatusInput;
}) {
  const taskId = randomUUID();
  const planVersionId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.create({
      data: {
        id: taskId,
        title,
        team,
        techGroup,
        status,
        currentPlanVersionId: planVersionId,
        createdByAccountId: ownerAccountId,
        startedAt: atHour(8),
        archivedAt: status === "ARCHIVED" ? atHour(19) : null,
      },
    });
    await tx.taskPlanVersion.create({
      data: {
        id: planVersionId,
        taskId,
        versionNo: 1,
        status: "CURRENT",
        plannedStartAt,
        reason: "S2 canvas query fixture",
        createdByAccountId: ownerAccountId,
        activatedAt: atHour(8),
      },
    });
    await tx.taskMember.createMany({
      data: members.map((member) => ({
        taskId,
        personId: member.personId,
        role: member.role,
        createdByAccountId: ownerAccountId,
      })),
    });
  });
  const milestone = await prisma.taskNode.create({
    data: {
      taskId,
      type: "MILESTONE",
      status: "ACTIVE",
      businessDescription: "S2 查询 Milestone",
      createdByAccountId: ownerAccountId,
      milestone: {
        create: {
          goal: `${title} 当前节点`,
          completionCriteria: "查询测试通过",
          expectedCompletedAt: atHour(18),
          reviewRequirements: "提交自动化证据",
        },
      },
    },
  });
  await prisma.planVersionNode.create({
    data: { planVersionId, nodeId: milestone.id, sequence: 1 },
  });
  await prisma.task.update({
    where: { id: taskId },
    data: { activeMilestoneNodeId: milestone.id },
  });
  return { taskId, planVersionId, milestoneNodeId: milestone.id };
}

async function createSegment({
  id,
  accountId,
  personId,
  taskId = null,
  nodeId = null,
  type = "PLANNED",
  status = type === "ACTUAL" ? "CONFIRMED" : "PLANNED",
  startAt,
  endAt,
  allocation = 50,
  content = "S2 查询 Segment",
  role = "DEVELOPER",
  priority = "MEDIUM",
  associationNeedsReview = false,
  tagIds = [],
}: {
  id?: string;
  accountId: string;
  personId: string;
  taskId?: string | null;
  nodeId?: string | null;
  type?: "PLANNED" | "ACTUAL";
  status?:
    | "PLANNED"
    | "IN_PROGRESS"
    | "PENDING_CONFIRMATION"
    | "CONFIRMED"
    | "CANCELLED";
  startAt: Date;
  endAt: Date;
  allocation?: number | null;
  content?: string;
  role?: "OWNER" | "LEAD" | "DEVELOPER";
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  associationNeedsReview?: boolean;
  tagIds?: string[];
}) {
  return prisma.workSegment.create({
    data: {
      ...(id ? { id } : {}),
      personId,
      type,
      status,
      startAt,
      endAt,
      content,
      allocation: allocation === null ? null : new Prisma.Decimal(allocation),
      role,
      priority,
      taskId,
      nodeId,
      associationNeedsReview,
      createdByAccountId: accountId,
      updatedByAccountId: accountId,
      ...(tagIds.length > 0
        ? { tags: { create: tagIds.map((tagId) => ({ tagId })) } }
        : {}),
    },
  });
}

async function createTaskOptionFixtures({
  ownerAccountId,
  ownerPersonId,
  titlePrefix,
  count,
}: {
  ownerAccountId: string;
  ownerPersonId: string;
  titlePrefix: string;
  count: number;
}): Promise<string[]> {
  const records = Array.from({ length: count }, (_, index) => ({
    taskId: randomUUID(),
    planVersionId: randomUUID(),
    title: `${titlePrefix} ${String(index).padStart(2, "0")}`,
  }));
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.createMany({
      data: records.map((record) => ({
        id: record.taskId,
        title: record.title,
        team: "英雄",
        techGroup: "电控",
        status: "ACTIVE",
        currentPlanVersionId: record.planVersionId,
        createdByAccountId: ownerAccountId,
        startedAt: atHour(8),
      })),
    });
    await tx.taskPlanVersion.createMany({
      data: records.map((record) => ({
        id: record.planVersionId,
        taskId: record.taskId,
        versionNo: 1,
        status: "CURRENT",
        plannedStartAt: atHour(8),
        reason: "S2 option cursor fixture",
        createdByAccountId: ownerAccountId,
        activatedAt: atHour(8),
      })),
    });
    await tx.taskMember.createMany({
      data: records.map((record) => ({
        taskId: record.taskId,
        personId: ownerPersonId,
        role: "OWNER" as const,
        createdByAccountId: ownerAccountId,
      })),
    });
  });
  return records.map((record) => record.taskId);
}

async function createAnchorTaskBatch({
  ownerAccountId,
  ownerPersonId,
  targetPersonId,
  titlePrefix,
  taskCount,
  nodesPerTask,
}: {
  ownerAccountId: string;
  ownerPersonId: string;
  targetPersonId: string;
  titlePrefix: string;
  taskCount: number;
  nodesPerTask: number;
}) {
  const tasks = Array.from({ length: taskCount }, (_, taskIndex) => ({
    id: randomUUID(),
    planVersionId: randomUUID(),
    title: `${titlePrefix} ${String(taskIndex).padStart(3, "0")} ${randomUUID()}`,
  }));
  const nodes = tasks.flatMap((task) =>
    Array.from({ length: nodesPerTask }, (_, nodeIndex) => ({
      id: randomUUID(),
      taskId: task.id,
      planVersionId: task.planVersionId,
      sequence: nodeIndex + 1,
      businessDescription: `${task.title} Node ${nodeIndex + 1}`,
    })),
  );
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.createMany({
      data: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        team: "英雄",
        techGroup: "电控",
        status: "ACTIVE" as const,
        currentPlanVersionId: task.planVersionId,
        createdByAccountId: ownerAccountId,
        startedAt: atHour(8),
      })),
    });
    await tx.taskPlanVersion.createMany({
      data: tasks.map((task) => ({
        id: task.planVersionId,
        taskId: task.id,
        versionNo: 1,
        status: "CURRENT" as const,
        reason: "S2 anchor complexity fixture",
        createdByAccountId: ownerAccountId,
        activatedAt: atHour(8),
      })),
    });
    await tx.taskMember.createMany({
      data: tasks.flatMap((task) => [
        {
          taskId: task.id,
          personId: ownerPersonId,
          role: "OWNER" as const,
          createdByAccountId: ownerAccountId,
        },
        {
          taskId: task.id,
          personId: targetPersonId,
          role: "MEMBER" as const,
          createdByAccountId: ownerAccountId,
        },
      ]),
    });
    await tx.workSegment.createMany({
      data: tasks.map((task) => ({
        id: randomUUID(),
        personId: targetPersonId,
        type: "PLANNED" as const,
        status: "PLANNED" as const,
        startAt: atHour(9),
        endAt: atHour(10),
        content: `${task.title} anchor candidate`,
        allocation: new Prisma.Decimal(1),
        role: "DEVELOPER" as const,
        priority: "LOW" as const,
        taskId: task.id,
        createdByAccountId: ownerAccountId,
      })),
    });
    for (let offset = 0; offset < nodes.length; offset += 1_000) {
      const chunk = nodes.slice(offset, offset + 1_000);
      await tx.taskNode.createMany({
        data: chunk.map((node) => ({
          id: node.id,
          taskId: node.taskId,
          type: "MILESTONE" as const,
          status: "PENDING" as const,
          businessDescription: node.businessDescription,
          createdByAccountId: ownerAccountId,
        })),
      });
      await tx.planVersionNode.createMany({
        data: chunk.map((node) => ({
          planVersionId: node.planVersionId,
          nodeId: node.id,
          sequence: node.sequence,
        })),
      });
    }
  });
}

async function createSegmentsInChunks(
  rows: Prisma.WorkSegmentCreateManyInput[],
) {
  for (let offset = 0; offset < rows.length; offset += 1_000) {
    await prisma.workSegment.createMany({
      data: rows.slice(offset, offset + 1_000),
    });
  }
}

async function createConflict({
  personId,
  segmentIds,
  severity,
  fingerprint,
  startAt = atHour(9.5),
  endAt = atHour(10.5),
}: {
  personId: string;
  segmentIds: string[];
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  fingerprint: string;
  startAt?: Date;
  endAt?: Date;
}) {
  return prisma.resourceConflict.create({
    data: {
      personId,
      kind: "ALLOCATION_OVER_LIMIT",
      startAt,
      endAt,
      severity,
      status: "OPEN",
      fingerprint,
      explanation: { forbidden: "raw explanation must not reach canvas" },
      segments: { create: segmentIds.map((segmentId) => ({ segmentId })) },
    },
  });
}

async function createTag(
  accountId: string,
  name: string,
  archivedAt: Date | null = null,
) {
  return prisma.tag.create({
    data: {
      name: `${name}-${randomUUID()}`,
      color: "#334455",
      createdByAccountId: accountId,
      archivedAt,
    },
  });
}

function actor(
  input: Awaited<ReturnType<typeof createAccountPerson>>,
  systemRoles: ProjectManagementSystemRoleRecord[] = [],
): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles,
  };
}

function systemAdministratorRole(): ProjectManagementSystemRoleRecord {
  return { role: "SYSTEM_ADMINISTRATOR", team: "", techGroup: "" };
}

function scopedRole(
  role: "TEAM_ADMINISTRATOR" | "RESOURCE_MANAGER",
  team: string,
  techGroup: string,
): ProjectManagementSystemRoleRecord {
  return { role, team, techGroup };
}

async function grantScopedRole(
  accountId: string,
  role: "TEAM_ADMINISTRATOR" | "RESOURCE_MANAGER",
  team: string,
  techGroup: string,
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team,
      techGroup,
      grantedByAccountId: accountId,
    },
  });
}

function canvasInput(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    rangeStart: RANGE_START,
    rangeEnd: RANGE_END,
    includeTaskAnchors: true,
    includeActual: true,
    includeBusyBlocks: false,
    includeConflicts: false,
    ...overrides,
  };
}

function atHour(hour: number): Date {
  const integerHour = Math.trunc(hour);
  const minute = Math.round((hour - integerHour) * 60);
  return new Date(Date.UTC(2026, 7, 10, integerHour, minute));
}

async function expectErrorCode(
  promise: Promise<unknown>,
  code: ProjectManagementErrorCode,
) {
  await expect(
    promise.catch((error) => toProjectManagementServiceError(error).code),
  ).resolves.toBe(code);
}

async function serviceErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return toProjectManagementServiceError(error);
  }
  throw new Error("预期服务调用失败，但调用成功");
}

async function previewWriteState(personId: string) {
  const [
    conflicts,
    conflictSegments,
    changes,
    audits,
    notifications,
    outbox,
    segments,
  ] = await Promise.all([
    prisma.resourceConflict.count(),
    prisma.conflictSegment.count(),
    prisma.workSegmentChange.count(),
    prisma.domainAuditEvent.count(),
    prisma.inAppNotification.count(),
    prisma.notificationOutbox.count(),
    prisma.workSegment.findMany({
      where: { personId },
      select: { id: true, updatedAt: true, startAt: true, endAt: true },
      orderBy: { id: "asc" },
    }),
  ]);
  return {
    conflicts,
    conflictSegments,
    changes,
    audits,
    notifications,
    outbox,
    segments: segments.map((segment) => ({
      id: segment.id,
      updatedAt: segment.updatedAt.toISOString(),
      startAt: segment.startAt.toISOString(),
      endAt: segment.endAt.toISOString(),
    })),
  };
}

function fullSegmentIds(
  data: Awaited<ReturnType<typeof getTimeCanvasData>>,
): string[] {
  return data.segments.flatMap((segment) =>
    segment.kind === "SEGMENT" ? [segment.id] : [],
  );
}

function visibleConflictIds(
  data: Awaited<ReturnType<typeof getTimeCanvasData>>,
): string[] {
  return data.conflicts.flatMap((conflict) =>
    conflict.visibility === "VISIBLE" ? [conflict.id] : [],
  );
}

function rowCanCreate(
  data: Awaited<ReturnType<typeof getTimeCanvasData>>,
  rowId: string,
): boolean | undefined {
  return data.rows.find((row) => row.id === rowId)?.capabilities.canCreateSegment;
}

function visibleConflictReasons(
  preview: Awaited<ReturnType<typeof previewSegmentPlacement>>,
): string[] {
  return preview.conflicts.flatMap((conflict) =>
    conflict.visibility === "VISIBLE" ? [conflict.reason] : [],
  );
}

function detectionSegment(
  id: string,
  startHour: number,
  endHour: number,
  overrides: Partial<
    Omit<ConflictDetectionSegment, "id" | "startAt" | "endAt">
  > = {},
): ConflictDetectionSegment {
  return {
    id,
    type: "PLANNED",
    status: "PLANNED",
    startAt: atHour(startHour),
    endAt: atHour(endHour),
    allocation: 20,
    priority: "LOW",
    role: "DEVELOPER",
    taskId: null,
    associationNeedsReview: false,
    deleted: false,
    ...overrides,
  };
}

function findDetectedConflict(
  conflicts: ReturnType<typeof detectResourceConflictsForSegments>,
  kind: ReturnType<typeof detectResourceConflictsForSegments>[number]["kind"],
  startHour: number,
) {
  const conflict = conflicts.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.startAt.getTime() === atHour(startHour).getTime(),
  );
  if (!conflict) throw new Error(`未找到 ${kind} @ ${startHour}`);
  return conflict;
}

function expectedConflictFingerprint(input: {
  kind: string;
  personId: string;
  startAt: Date;
  endAt: Date;
  segmentIds: string[];
}): string {
  return createHash("sha256")
    .update(
      [
        "v1",
        input.kind,
        input.personId,
        input.startAt.toISOString(),
        input.endAt.toISOString(),
        [...input.segmentIds].sort().join(","),
      ].join("|"),
    )
    .digest("hex");
}

type TaskMemberRoleInput =
  | "OWNER"
  | "LEAD"
  | "MEMBER"
  | "REVIEWER"
  | "VIEWER";

type TaskStatusInput =
  | "DRAFT"
  | "ACTIVE"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMEOUT"
  | "ARCHIVED";
