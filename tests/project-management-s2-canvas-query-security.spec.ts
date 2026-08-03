import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  createActualSegment,
  createWorkSegment,
} from "../lib/project-management/application/segment-service";
import {
  toProjectManagementServiceError,
  type ProjectManagementErrorCode,
} from "../lib/project-management/application/errors";
import type {
  ProjectManagementActor,
  ProjectManagementSystemRoleRecord,
} from "../lib/project-management/identity";
import { getMyWorkDashboard } from "../lib/project-management/queries/dashboard-queries";
import { listTasks } from "../lib/project-management/queries/task-queries";
import {
  listTagOptions,
  resolvePeopleOptionsByIds,
  resolveTaskOptionsByIds,
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
    ]) {
      const readable = await context.request.post(endpoint, { data: payload });
      expect(await readable.json()).toMatchObject({ ok: true });
    }
  });

  test("Segment create action accepts creatable Tasks and returns a stable denial for terminal Tasks", async ({
    context,
    page,
    baseURL,
  }) => {
    const owner = await createAccountPerson("Create Action Owner");
    const activeTaskTitle = `Create Action Active ${randomUUID()}`;
    const activeTask = await createTask({
      ownerAccountId: owner.account.id,
      title: activeTaskTitle,
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
    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&people=${owner.person.id}`,
    );

    await page.getByRole("button", { name: "新增投入" }).click();
    const quickCreate = page.getByRole("form", { name: "投入快速创建" });
    await quickCreate.getByLabel("Task", { exact: true }).fill(activeTaskTitle);
    await page
      .getByRole("option", { name: activeTaskTitle, exact: true })
      .click();
    await quickCreate.locator("#quick-content").fill("真实 Action 允许 Active Task");
    await quickCreate.getByRole("button", { name: "创建" }).click();
    await expect(
      page.getByText("已创建投入记录", { exact: true }),
    ).toBeVisible();
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

    await page.getByRole("button", { name: "新增投入" }).click();
    const deniedQuickCreate = page.getByRole("form", { name: "投入快速创建" });
    await deniedQuickCreate.locator("#quick-content").fill("真实 Action 拒绝 Completed Task");
    const deniedActionResponse = page.waitForResponse((response) =>
      Boolean(response.request().headers()["next-action"]),
    );
    await deniedQuickCreate.evaluate((form, taskId) => {
      const hiddenTaskId = form.querySelector<HTMLInputElement>('input[name="taskId"]');
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (!hiddenTaskId || !submit) throw new Error("快速创建表单结构不完整");
      hiddenTaskId.remove();
      const injectedTaskId = document.createElement("input");
      injectedTaskId.type = "hidden";
      injectedTaskId.name = "taskId";
      injectedTaskId.value = taskId;
      form.prepend(injectedTaskId);
      (form as HTMLFormElement).requestSubmit(submit);
    }, terminalTask.taskId);
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
    const optionKey = randomUUID();
    const sameNamePerson = `同名成员 ${optionKey}`;
    const sameNameTask = `同名 Task ${optionKey}`;
    const owner = await createAccountPerson(`选项 Owner ${optionKey}`);
    const visibleMember = await createAccountPerson(sameNamePerson);
    const visibleSegmentPerson = await createAccountPerson(sameNamePerson);
    const outsider = await createAccountPerson(`非成员 ${optionKey}`);
    const inactive = await createAccountPerson(
      `停用成员 ${optionKey}`,
      "INACTIVE",
    );
    const hiddenOwner = await createAccountPerson(`其他 Task Owner ${optionKey}`);
    const ownerActor = actor(owner);
    const adminActor = actor(owner, [systemAdministratorRole()]);
    const visibleTask = await createTask({
      ownerAccountId: owner.account.id,
      title: sameNameTask,
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: visibleMember.person.id, role: "PARTICIPANT" },
      ],
    });
    const hiddenTask = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: sameNameTask,
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
      input: { purpose: "VISIBLE", query: optionKey, limit: 50 },
    });
    expect(people.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        owner.person.id,
        visibleMember.person.id,
        visibleSegmentPerson.person.id,
        outsider.person.id,
        hiddenOwner.person.id,
      ]),
    );
    expect(people.items.map((item) => item.id)).not.toContain(inactive.person.id);
    expect(
      people.items.every(
        (item) =>
          Object.keys(item).sort().join("|") ===
          [
            "accountBinding",
            "avatar",
            "displayName",
            "id",
            "status",
          ]
            .sort()
            .join("|"),
      ),
    ).toBe(true);

    const sameNamePage = await searchPeople({
      actor: ownerActor,
      input: { purpose: "VISIBLE", query: "同名成员", limit: 50 },
    });
    const sameNameIds = sameNamePage.items.map((item) => item.id);
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
      input: { purpose: "VISIBLE", limit: 1 },
    });
    await expectErrorCode(
      searchPeople({
        actor: adminActor,
        input: {
          purpose: "VISIBLE",
          query: `不同查询 ${optionKey}`,
          cursor: firstPeoplePage.nextCursor,
        },
      }),
      "VALIDATION_ERROR",
    );

    const activeTag = await createTag(owner.account.id, `活动 Tag ${optionKey}`);
    const ownArchivedTag = await createTag(
      owner.account.id,
      `本人归档 Tag ${optionKey}`,
      new Date(),
    );
    const otherArchivedTag = await createTag(
      hiddenOwner.account.id,
      `他人归档 Tag ${optionKey}`,
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
      input: { query: sameNameTask, tagIds: [activeTag.id] },
    });
    expect(taskOptions.items.map((item) => item.id).sort()).toEqual(
      [visibleTask.taskId, hiddenTask.taskId].sort(),
    );
    expect(taskOptions.items[0]?.permission).toEqual({ canView: true });
    const taskList = await listTasks({
      actor: ownerActor,
      input: { query: sameNameTask, limit: 50 },
    });
    expect(taskList.items.map((item) => item.id).sort()).toEqual(
      [visibleTask.taskId, hiddenTask.taskId].sort(),
    );
    expect(taskList.nextCursor).toBeNull();
    const resolvedTasks = await resolveTaskOptionsByIds({
      actor: ownerActor,
      input: { ids: [hiddenTask.taskId, visibleTask.taskId] },
    });
    expect(resolvedTasks.map((item) => item.id)).toEqual([
      hiddenTask.taskId,
      visibleTask.taskId,
    ]);
    const resolvedPeople = await resolvePeopleOptionsByIds({
      actor: ownerActor,
      input: {
        scope: { purpose: "VISIBLE" },
        ids: [hiddenOwner.person.id, visibleSegmentPerson.person.id, visibleMember.person.id],
      },
    });
    expect(resolvedPeople.map((item) => item.id)).toEqual([
      hiddenOwner.person.id,
      visibleSegmentPerson.person.id,
      visibleMember.person.id,
    ]);
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

  test("People purposes expose the active directory with safe account binding", async () => {
    const directoryKey = randomUUID();
    const directoryQuery = `成员目录 ${directoryKey}`;
    const owner = await createAccountPerson("成员目录 Owner");
    await prisma.systemRoleAssignment.create({
      data: {
        accountId: owner.account.id,
        role: "PROJECT_ADMINISTRATOR",
        team: "",
        techGroup: "",
      },
    });
    const teamAdmin = await createAccountPerson("成员目录 Team Admin");
    const ordinary = await createAccountPerson("成员目录普通成员");
    const hiddenOwner = await createAccountPerson("成员目录隐藏 Owner");
    const active = await createAccountPerson(`${directoryQuery} Active`);
    const bound = await createAccountPerson(`${directoryQuery} Bound`);
    const inactive = await createAccountPerson(
      `${directoryQuery} Inactive`,
      "INACTIVE",
    );
    const unbound = await prisma.person.create({
      data: { displayName: `${directoryQuery} Unbound`, status: "ACTIVE" },
    });
    const activeIdentityMarker = `active-identity-${randomUUID()}`;
    const boundIdentityMarker = `bound-identity-${randomUUID()}`;
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
          accountId: bound.account.id,
          provider: "FEISHU",
          providerSubject: boundIdentityMarker,
          tenantId: `tenant-${boundIdentityMarker}`,
          openId: `ou_${boundIdentityMarker}`,
          unionId: `on_${boundIdentityMarker}`,
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
        { personId: ordinary.person.id, role: "PARTICIPANT" },
        { personId: inactive.person.id, role: "PARTICIPANT" },
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
      scopedRole("GROUP_LEADER", "英雄", "电控"),
    ]);
    const ordinaryActor = actor(ordinary);
    const systemActor = actor(owner, [systemAdministratorRole()]);

    const ordinaryVisible = await searchPeople({
      actor: ordinaryActor,
      input: { purpose: "VISIBLE", query: directoryQuery },
    });
    expect(ordinaryVisible.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        active.person.id,
        bound.person.id,
        unbound.id,
      ]),
    );
    expect(ordinaryVisible.items.map((item) => item.id)).not.toContain(
      inactive.person.id,
    );

    const systemVisible = await searchPeople({
      actor: systemActor,
      input: { purpose: "VISIBLE", query: directoryQuery },
    });
    expect(systemVisible.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        active.person.id,
        bound.person.id,
        unbound.id,
      ]),
    );
    expect(systemVisible.items.map((item) => item.id)).not.toContain(
      inactive.person.id,
    );

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
          bound.person.id,
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
      ownerMembers.items.map((item) => [item.id, item.accountBinding]),
    ).toEqual(
      expect.arrayContaining([
        [active.person.id, "BOUND"],
        [bound.person.id, "BOUND"],
        [unbound.id, "UNBOUND"],
      ]),
    );
    expect(ownerMembers.items.map((item) => item.id)).not.toContain(
      inactive.person.id,
    );
    for (const item of ownerMembers.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "accountBinding",
          "avatar",
          "displayName",
          "id",
          "status",
        ].sort(),
      );
    }
    await expect(
      searchPeople({
        actor: ordinaryActor,
        input: {
          purpose: "TASK_SEGMENT_CREATE",
          taskId: task.taskId,
          limit: 50,
        },
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: ordinary.person.id })],
    });
    await expect(
      searchPeople({
        actor: ownerActor,
        input: {
          purpose: "TASK_SEGMENT_CREATE",
          taskId: task.taskId,
          limit: 50,
        },
      }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: owner.person.id }),
        expect.objectContaining({ id: ordinary.person.id }),
      ]),
    });
    await expect(
      searchPeople({
        actor: teamAdminActor,
        input: {
          purpose: "TASK_SEGMENT_CREATE",
          taskId: task.taskId,
          limit: 50,
        },
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      resolvePeopleOptionsByIds({
        actor: ordinaryActor,
        input: {
          scope: {
            purpose: "TASK_SEGMENT_CREATE",
            taskId: task.taskId,
          },
          ids: [owner.person.id, ordinary.person.id],
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: ordinary.person.id }),
    ]);
    await expect(
      resolvePeopleOptionsByIds({
        actor: ownerActor,
        input: {
          scope: {
            purpose: "TASK_SEGMENT_CREATE",
            taskId: task.taskId,
          },
          ids: [owner.person.id, ordinary.person.id, inactive.person.id],
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: owner.person.id }),
      expect.objectContaining({ id: ordinary.person.id }),
    ]);
    const serialized = JSON.stringify(ownerMembers);
    for (const sensitive of [
      active.account.id,
      bound.account.id,
      activeIdentityMarker,
      boundIdentityMarker,
      `tenant-${activeIdentityMarker}`,
      `tenant-${boundIdentityMarker}`,
    ]) {
      expect(serialized).not.toContain(sensitive);
    }

    for (const searchActor of [teamAdminActor, ordinaryActor]) {
      const page = await searchPeople({
        actor: searchActor,
        input: {
          purpose: "TASK_CREATE",
          team: "英雄",
          techGroup: "电控",
          query: directoryQuery,
        },
      });
      expect(page.items.map((item) => item.id)).toEqual(
        expect.arrayContaining([
          active.person.id,
          bound.person.id,
          unbound.id,
        ]),
      );
      expect(page.items.map((item) => item.id)).not.toContain(
        inactive.person.id,
      );
    }

    expect(
      (
        await searchPeople({
          actor: teamAdminActor,
          input: {
            purpose: "TASK_CREATE",
            team: "步兵",
            techGroup: "机械",
            query: directoryQuery,
          },
        })
      ).items.map((item) => item.id),
    ).toEqual(expect.arrayContaining([active.person.id, unbound.id]));
    await expectErrorCode(
      searchPeople({
        actor: teamAdminActor,
        input: {
          purpose: "TASK_MEMBERS",
          taskId: hiddenTask.taskId,
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
    await expect(
      resolvePeopleOptionsByIds({
        actor: ordinaryActor,
        input: {
          scope: { purpose: "TASK_CREATE", team: "英雄", techGroup: "电控" },
          ids: [active.person.id],
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: active.person.id, accountBinding: "BOUND" }),
    ]);
    await expectErrorCode(
      resolvePeopleOptionsByIds({
        actor: ordinaryActor,
        input: {
          scope: { purpose: "TASK_MEMBERS", taskId: task.taskId },
          ids: [active.person.id],
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
    expect(randomTaskError.code).toBe("NOT_FOUND");
    expect(hiddenTaskError.code).toBe("FORBIDDEN");

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

  test("People and Task cap fuzzy candidates at 501 while empty queries and Tags retain bound cursors", async () => {
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
      count: 502,
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
    const personIds = Array.from({ length: 502 }, () => randomUUID());
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
        role: "PARTICIPANT",
        createdByAccountId: owner.account.id,
      })),
    });

    const firstPeoplePage = await searchPeople({
      actor: adminActor,
      input: { purpose: "VISIBLE", query: peopleQuery, limit: 50 },
    });
    expect(firstPeoplePage.items).toHaveLength(50);
    expect(firstPeoplePage.nextCursor).toBeNull();
    expect(firstPeoplePage.hasMoreByQuery).toBe(true);
    expect(personIds).toEqual(expect.arrayContaining(firstPeoplePage.items.map((item) => item.id)));
    await prisma.person.update({
      where: { id: personIds[0]! },
      data: { status: "INACTIVE" },
    });
    const restoredPeople = await resolvePeopleOptionsByIds({
      actor: adminActor,
      input: {
        scope: { purpose: "VISIBLE" },
        ids: [personIds[1]!, personIds[0]!],
      },
    });
    expect(restoredPeople.map((item) => [item.id, item.status])).toEqual([
      [personIds[1], "ACTIVE"],
      [personIds[0], "INACTIVE"],
    ]);
    const peopleCursorPage = await searchPeople({
      actor: adminActor,
      input: { purpose: "VISIBLE", limit: 1 },
    });
    expect(peopleCursorPage.nextCursor).not.toBeNull();

    const firstTaskPage = await searchTaskOptions({
      actor: ownerActor,
      input: { query: taskQuery, limit: 50 },
    });
    expect(firstTaskPage.items).toHaveLength(50);
    expect(firstTaskPage.nextCursor).toBeNull();
    expect(firstTaskPage.hasMoreByQuery).toBe(true);
    expect(taskIds).toEqual(expect.arrayContaining(firstTaskPage.items.map((item) => item.id)));
    const taskCursorPage = await searchTaskOptions({
      actor: ownerActor,
      input: { limit: 1 },
    });
    expect(taskCursorPage.nextCursor).not.toBeNull();

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
          cursor: peopleCursorPage.nextCursor ?? undefined,
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
        limit: 1,
      },
    });
    expect(taskCreatePeoplePage.nextCursor).not.toBeNull();
    await expectErrorCode(
      searchPeople({
        actor: adminActor,
        input: {
          purpose: "VISIBLE",
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
          cursor: peopleCursorPage.nextCursor ?? undefined,
        },
      }),
      "VALIDATION_ERROR",
    );
    await expectErrorCode(
      listTagOptions({
        actor: adminActor,
        input: {
          query: tagQuery,
          cursor: peopleCursorPage.nextCursor ?? undefined,
        },
      }),
      "VALIDATION_ERROR",
    );

    await expectErrorCode(
      listTagOptions({
        actor: ownerActor,
        input: {
          query: tagQuery,
          cursor: taskCursorPage.nextCursor ?? undefined,
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
      resolvePeopleOptionsByIds({
        actor: adminActor,
        input: {
          scope: { purpose: "VISIBLE" },
          ids: personIds.slice(0, 51),
        },
      }),
      "QUERY_LIMIT_EXCEEDED",
    );
    await expectErrorCode(
      resolveTaskOptionsByIds({
        actor: ownerActor,
        input: { ids: taskIds.slice(0, 51) },
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
      scopedRole("GROUP_LEADER", "英雄", "电控"),
    ]);
    const tag = await createTag(teamAdmin.account.id, "Tag 并集筛选");
    const taskTagOnly = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Tag 并集 TaskTag-only",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: visibleOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "PARTICIPANT" },
      ],
    });
    const segmentTagOnly = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Tag 并集 SegmentTag-only",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: visibleOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "PARTICIPANT" },
      ],
    });
    const both = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Tag 并集 Both",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: visibleOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "PARTICIPANT" },
      ],
    });
    const taskTagWithoutSegment = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Tag 并集 TaskTag zero Segment",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: visibleOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "PARTICIPANT" },
      ],
    });
    const taskTagOutsideRange = await createTask({
      ownerAccountId: visibleOwner.account.id,
      title: "Tag 并集 TaskTag out of range",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: visibleOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "PARTICIPANT" },
      ],
    });
    const hidden = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "Tag 并集隐藏 Task",
      team: "步兵",
      techGroup: "机械",
      members: [
        { personId: hiddenOwner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "PARTICIPANT" },
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
      hiddenSegment.id,
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
        hidden.taskId,
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
    expect(JSON.stringify(personGrouped)).toContain(hiddenSegment.id);
    expect(JSON.stringify(taskGrouped)).toContain(hidden.taskId);
    expect(JSON.stringify(taskGrouped)).toContain(hiddenSegment.id);
  });

  test("PERSON row creation capabilities use eligible Task existence without granting retired leaders write access", async () => {
    const resourceManager = await createAccountPerson("Capability Resource Manager");
    const teamAdmin = await createAccountPerson("Capability Team Admin");
    const owner = await createAccountPerson("Capability Owner");
    const target = await createAccountPerson("Capability 目标人员");
    const viewer = await createAccountPerson("Capability Viewer");
    const inactiveMember = await createAccountPerson("Capability 停用成员");
    const outOfScopePerson = await createAccountPerson("Capability 越界人员");
    const unassignedPerson = await createAccountPerson("Capability 未加入 Task");
    const resourceManagerActor = actor(resourceManager, [systemAdministratorRole()]);
    const teamAdminActor = actor(teamAdmin, [
      scopedRole("GROUP_LEADER", "英雄", "电控"),
    ]);
    await Promise.all([
      prisma.systemRoleAssignment.create({
        data: {
          accountId: resourceManager.account.id,
          role: "PROJECT_ADMINISTRATOR",
        },
      }),
      grantScopedRole(teamAdmin.account.id, "GROUP_LEADER", "英雄", "电控"),
    ]);
    const activeTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "Capability Active",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "PARTICIPANT" },
        { personId: viewer.person.id, role: "PARTICIPANT" },
        { personId: inactiveMember.person.id, role: "PARTICIPANT" },
      ],
    });
    await prisma.person.update({
      where: { id: inactiveMember.person.id },
      data: { status: "INACTIVE" },
    });
    const draftTask = await createTask({
      ownerAccountId: owner.account.id,
      title: "Capability Draft",
      team: "英雄",
      techGroup: "电控",
      status: "DRAFT",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "PARTICIPANT" },
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
              { personId: target.person.id, role: "PARTICIPANT" },
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
        { personId: outOfScopePerson.person.id, role: "PARTICIPANT" },
      ],
    });

    const administratorCanvas = await getTimeCanvasData({
      actor: resourceManagerActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [target.person.id, unassignedPerson.person.id],
      }),
    });
    expect(rowCanCreate(administratorCanvas, target.person.id)).toBe(true);
    expect(rowCanCreate(administratorCanvas, unassignedPerson.person.id)).toBe(
      false,
    );
    const ownerCanvas = await getTimeCanvasData({
      actor: actor(owner),
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [target.person.id, unassignedPerson.person.id],
      }),
    });
    expect(rowCanCreate(ownerCanvas, target.person.id)).toBe(true);
    expect(rowCanCreate(ownerCanvas, unassignedPerson.person.id)).toBe(false);
    for (const createActor of [resourceManagerActor, actor(owner)]) {
      const singleTaskNonMemberCanvas = await getTimeCanvasData({
        actor: createActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [unassignedPerson.person.id],
          taskIds: [activeTask.taskId],
        }),
      });
      expect(
        rowCanCreate(singleTaskNonMemberCanvas, unassignedPerson.person.id),
      ).toBe(false);
    }
    const selfFilteredToNonMemberTask = await getTimeCanvasData({
      actor: actor(unassignedPerson),
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [unassignedPerson.person.id],
        taskIds: [activeTask.taskId],
      }),
    });
    expect(
      rowCanCreate(selfFilteredToNonMemberTask, unassignedPerson.person.id),
    ).toBe(false);
    const inactiveMemberTaskCanvas = await getTimeCanvasData({
      actor: actor(inactiveMember),
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "TASK",
        taskIds: [activeTask.taskId],
      }),
    });
    expect(rowCanCreate(inactiveMemberTaskCanvas, activeTask.taskId)).toBe(false);
    const retiredLeaderCanvas = await getTimeCanvasData({
      actor: teamAdminActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [target.person.id],
      }),
    });
    expect(rowCanCreate(retiredLeaderCanvas, target.person.id)).toBe(false);
    for (const canvas of [administratorCanvas, retiredLeaderCanvas]) {
      expect(canvas.rows.map((row) => row.id)).toContain(target.person.id);
    }

    const allPeopleCanvas = await getTimeCanvasData({
      actor: teamAdminActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [outOfScopePerson.person.id],
      }),
    });
    expect(allPeopleCanvas.rows.map((row) => row.id)).toContain(
      outOfScopePerson.person.id,
    );

    const singleTerminal = await getTimeCanvasData({
      actor: resourceManagerActor,
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
        createWorkSegment(resourceManagerActor, {
          personId: target.person.id,
          type: "PLANNED",
          startAt: atHour(14 + index * 0.1),
          endAt: atHour(14.05 + index * 0.1),
          content: `禁止关联终态 Task ${index}`,
          taskId: task.taskId,
          nodeId: task.milestoneNodeId,
        }),
        "ASSOCIATION_INVALID",
      );
      await expectErrorCode(
        createActualSegment(teamAdminActor, {
          personId: target.person.id,
          startAt: atHour(15 + index * 0.1),
          endAt: atHour(15.05 + index * 0.1),
          content: `禁止 Actual 关联终态 Task ${index}`,
          taskId: task.taskId,
          nodeId: task.milestoneNodeId,
        }),
        "FORBIDDEN",
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

    const activeCreated = await createWorkSegment(resourceManagerActor, {
      personId: target.person.id,
      type: "PLANNED",
      startAt: atHour(15),
      endAt: atHour(16),
      content: "允许关联 Active Task",
      taskId: activeTask.taskId,
      nodeId: activeTask.milestoneNodeId,
    });
    expect(activeCreated.segment.taskId).toBe(activeTask.taskId);
    const draftCreated = await createWorkSegment(resourceManagerActor, {
      personId: target.person.id,
      type: "PLANNED",
      startAt: atHour(16),
      endAt: atHour(17),
      content: "允许关联 Draft Task",
      taskId: draftTask.taskId,
      nodeId: draftTask.milestoneNodeId,
    });
    expect(draftCreated.segment.taskId).toBe(draftTask.taskId);
    const mixedTasks = await getTimeCanvasData({
      actor: resourceManagerActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [target.person.id],
        taskIds: [activeTask.taskId, terminalTasks[0]!.taskId],
      }),
    });
    expect(rowCanCreate(mixedTasks, target.person.id)).toBe(true);
    const terminalOnlyTasks = await getTimeCanvasData({
      actor: resourceManagerActor,
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

    const groupLeaderTaskFilter = await getTimeCanvasData({
      actor: resourceManagerActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        taskIds: [activeTask.taskId],
      }),
    });
    expect(groupLeaderTaskFilter.anchors.map((anchor) => anchor.id)).toContain(
      activeTask.taskId,
    );
    expect(
      (
        await getTimeCanvasData({
          actor: teamAdminActor,
          input: canvasInput({
            scope: { kind: "RESOURCE_PLANNER" },
            groupBy: "PERSON",
            taskIds: [outOfScopeTask.taskId],
          }),
        })
      ).anchors.map((anchor) => anchor.id),
    ).toContain(outOfScopeTask.taskId);
  });

  test("four canvas scopes enforce row domains, half-open filters, global Full visibility and Actual capabilities", async () => {
    const scopeKey = randomUUID();
    const scopedTeam = `英雄-${scopeKey}`;
    const scopedTechGroup = `电控-${scopeKey}`;
    const owner = await createAccountPerson("画布 Owner");
    const member = await createAccountPerson("画布 Member");
    const hiddenOwner = await createAccountPerson("隐藏 Owner");
    const inactive = await createAccountPerson("停用画布人员", "INACTIVE");
    const inactiveWithHistory = await createAccountPerson(
      "有历史投入的停用画布人员",
      "INACTIVE",
    );
    const ownerActor = actor(owner);
    const adminActor = actor(owner, [systemAdministratorRole()]);
    const taskA = await createTask({
      ownerAccountId: owner.account.id,
      title: "可见 Task A",
      team: scopedTeam,
      techGroup: scopedTechGroup,
      plannedStartAt: null,
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: member.person.id, role: "PARTICIPANT" },
      ],
    });
    const taskB = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "隐藏 Task B",
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
    await prisma.taskMember.create({
      data: {
        taskId: taskB.taskId,
        personId: inactiveWithHistory.person.id,
        role: "PARTICIPANT",
      },
    });
    const current = await createSegment({
      accountId: owner.account.id,
      personId: member.person.id,
      taskId: taskA.taskId,
      nodeId: taskA.milestoneNodeId,
      startAt: atHour(9),
      endAt: atHour(12),
      content: "可见 Task A 投入",
    });
    const hidden = await createSegment({
      accountId: hiddenOwner.account.id,
      personId: member.person.id,
      taskId: taskB.taskId,
      nodeId: taskB.milestoneNodeId,
      startAt: atHour(10),
      endAt: atHour(11),
      content: "绝密 Task B 投入",
    });
    const inactiveHistory = await createSegment({
      accountId: hiddenOwner.account.id,
      personId: inactiveWithHistory.person.id,
      taskId: taskB.taskId,
      nodeId: taskB.milestoneNodeId,
      startAt: atHour(15),
      endAt: atHour(16),
      content: "停用人员历史投入",
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
    const actual = await createSegment({
      accountId: owner.account.id,
      personId: owner.person.id,
      taskId: taskA.taskId,
      nodeId: taskA.milestoneNodeId,
      type: "ACTUAL",
      status: "CONFIRMED",
      startAt: atHour(13),
      endAt: atHour(14),
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
    const taskCanvas = await getTimeCanvasData({
      actor: ownerActor,
      input: canvasInput({
        scope: { kind: "TASK_SCOPED", taskId: taskA.taskId },
        groupBy: "PERSON",
        includeBusyBlocks: true,
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
    expect(taskCanvas.segments.some((segment) => segment.kind === "BUSY")).toBe(
      false,
    );
    expect(taskCanvas.segments).toContainEqual(
      expect.objectContaining({
        kind: "SEGMENT",
        visibility: "FULL",
        id: hidden.id,
        content: "绝密 Task B 投入",
        taskId: taskB.taskId,
        nodeId: taskB.milestoneNodeId,
        versionToken: hiddenVersionToken,
      }),
    );
    const serializedTaskCanvas = JSON.stringify(taskCanvas);
    for (const visible of [
      hidden.id,
      "绝密 Task B 投入",
      taskB.taskId,
      taskB.milestoneNodeId,
      hiddenTag.id,
      hiddenTag.name,
      hiddenVersionToken,
    ]) {
      expect(serializedTaskCanvas).toContain(visible);
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
        }),
      });
      expect(canvas.rows.map((row) => row.id)).toContain(taskA.taskId);
      expect(
        canvas.segments.every(
          (segment) => segment.personId === owner.person.id,
        ),
      ).toBe(true);
    }
    const ordinaryResource = await getTimeCanvasData({
      actor: ownerActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [owner.person.id, member.person.id, hiddenOwner.person.id],
      }),
    });
    expect(ordinaryResource.rows.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        owner.person.id,
        member.person.id,
        hiddenOwner.person.id,
      ]),
    );
    const globallyVisibleHidden = ordinaryResource.segments.find(
      (segment) => segment.kind === "SEGMENT" && segment.id === hidden.id,
    );
    expect(globallyVisibleHidden).toMatchObject({
      kind: "SEGMENT",
      visibility: "FULL",
      content: "绝密 Task B 投入",
      taskId: taskB.taskId,
      nodeId: taskB.milestoneNodeId,
      versionToken: hiddenVersionToken,
    });
    const taskGrouped = await getTimeCanvasData({
      actor: ownerActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "TASK",
        taskIds: [taskA.taskId, taskB.taskId],
      }),
    });
    expect(taskGrouped.rows.map((row) => row.id)).toContain(taskA.taskId);
    expect(taskGrouped.rows.map((row) => row.id)).toContain(taskB.taskId);
    expect(taskGrouped.segments.every((segment) => segment.kind === "SEGMENT"))
      .toBe(true);

    expect(
      (
        await getTimeCanvasData({
          actor: ownerActor,
          input: canvasInput({
            scope: { kind: "RESOURCE_PLANNER" },
            groupBy: "PERSON",
            personIds: [member.person.id],
          }),
        })
      ).rows.map((row) => row.id),
    ).toContain(member.person.id);
    expect(
      fullSegmentIds(
        await getTimeCanvasData({
          actor: ownerActor,
          input: canvasInput({
            scope: { kind: "RESOURCE_PLANNER" },
            groupBy: "PERSON",
            personIds: [member.person.id],
            taskIds: [taskB.taskId],
          }),
        }),
      ),
    ).toContain(hidden.id);
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
    const inactiveHistoryCanvas = await getTimeCanvasData({
      actor: adminActor,
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [inactiveWithHistory.person.id],
      }),
    });
    expect(inactiveHistoryCanvas.rows).toEqual([
      expect.objectContaining({
        id: inactiveWithHistory.person.id,
        label: "有历史投入的停用画布人员（已停用）",
        capabilities: { canCreateSegment: false },
      }),
    ]);
    expect(fullSegmentIds(inactiveHistoryCanvas)).toContain(
      inactiveHistory.id,
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

  test("globally visible Full segments exclude exact half-open boundaries and keep adjacent intersections", async () => {
    const owner = await createAccountPerson("半开边界 Owner");
    const target = await createAccountPerson("半开边界目标");
    const hiddenOwner = await createAccountPerson("半开边界隐藏 Owner");
    await createTask({
      ownerAccountId: owner.account.id,
      title: "半开边界可见 Task",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "PARTICIPANT" },
      ],
    });
    const hiddenTask = await createTask({
      ownerAccountId: hiddenOwner.account.id,
      title: "半开边界隐藏 Task",
      team: "步兵",
      techGroup: "机械",
      members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
    });
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
    const canvas = await getTimeCanvasData({
      actor: actor(owner),
      input: canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [target.person.id],
        includeBusyBlocks: true,
      }),
    });
    const visibleRanges = canvas.segments.flatMap((segment) =>
      segment.kind === "SEGMENT" && segment.taskId === hiddenTask.taskId
        ? [`${segment.startAt}|${segment.endAt}`]
        : [],
    );
    expect(visibleRanges).toEqual(
      expect.arrayContaining([
        `${busyFixtures[1]!.startAt.toISOString()}|${busyFixtures[1]!.endAt.toISOString()}`,
        `${busyFixtures[3]!.startAt.toISOString()}|${busyFixtures[3]!.endAt.toISOString()}`,
      ]),
    );
    expect(visibleRanges).not.toContain(
      `${busyFixtures[0]!.startAt.toISOString()}|${busyFixtures[0]!.endAt.toISOString()}`,
    );
    expect(visibleRanges).not.toContain(
      `${busyFixtures[2]!.startAt.toISOString()}|${busyFixtures[2]!.endAt.toISOString()}`,
    );
  });

  test("globally visible equal-time Full segments use stable IDs as a tie-breaker", async () => {
    const owner = await createAccountPerson("Busy 稳定排序 Owner");
    const target = await createAccountPerson("Busy 稳定排序目标");
    const hiddenOwner = await createAccountPerson("Busy 稳定排序隐藏 Owner");
    await createTask({
      ownerAccountId: owner.account.id,
      title: "Busy 稳定排序可见 Task",
      team: "英雄",
      techGroup: "电控",
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: target.person.id, role: "PARTICIPANT" },
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
          content: fixture.content,
          tagIds: [hiddenTag.id],
        }),
      );
    }

    const loadEqualKeyFullSegments = async () => {
      const canvas = await getTimeCanvasData({
        actor: actor(owner),
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [target.person.id],
          includeBusyBlocks: true,
        }),
      });
      return canvas.segments.filter(
        (segment) =>
          segment.kind === "SEGMENT" &&
          segment.taskId === hiddenTask.taskId &&
          segment.personId === target.person.id &&
          segment.startAt === atHour(9).toISOString() &&
          segment.endAt === atHour(10).toISOString(),
      );
    };
    const firstRead = await loadEqualKeyFullSegments();
    const secondRead = await loadEqualKeyFullSegments();
    expect(firstRead).toHaveLength(hiddenSegments.length);
    expect(secondRead).toEqual(firstRead);
    expect(
      firstRead.flatMap((segment) =>
        segment.kind === "SEGMENT" ? [segment.id] : [],
      ),
    ).toEqual(
      hiddenSegments.map((segment) => segment.id).sort(),
    );
    const serializedFull = JSON.stringify(firstRead);
    for (const visible of [
      ...hiddenSegments.flatMap((segment) => [segment.id, segment.content]),
      hiddenTask.taskId,
      hiddenTag.id,
      hiddenTag.name,
    ]) {
      expect(serializedFull).toContain(visible);
    }
  });

  test("time-object limit counts all globally visible Full records and rejects 5001", async () => {
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
        { personId: target.person.id, role: "PARTICIPANT" },
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
    const rows = Array.from({ length: 4_975 }, (_, index) => ({
      id: randomUUID(),
      personId: target.person.id,
      type: "PLANNED" as const,
      status: "PLANNED" as const,
      startAt,
      endAt,
      content: `批量可见 ${index}`,
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
    expect(JSON.stringify(atLimit)).toContain(hiddenRows[0]!.id);
    expect(JSON.stringify(atLimit)).toContain("批量隐藏");
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
        { personId: target.person.id, role: "PARTICIPANT" },
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
        { personId: target.person.id, role: "PARTICIPANT" },
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

  test("empty canvases retain safe rows without fabricating time objects", async () => {
    const person = await createAccountPerson("空画布人员");
    const personal = await getTimeCanvasData({
      actor: actor(person),
      input: canvasInput({
        scope: { kind: "PERSONAL" },
        groupBy: "PERSON",
      }),
    });
    expect(personal.rows.map((row) => row.id)).toEqual([person.person.id]);
    expect(personal.segments).toEqual([]);
    expect(personal.anchors).toEqual([]);
    expect(personal.nextCursor).toBeNull();

    const taskGrouped = await getTimeCanvasData({
      actor: actor(person),
      input: canvasInput({
        scope: { kind: "DASHBOARD" },
        groupBy: "TASK",
      }),
    });
    expect(taskGrouped.rows).toEqual([]);
    expect(taskGrouped.segments).toEqual([]);
    expect(taskGrouped.anchors).toEqual([]);
    expect(taskGrouped.nextCursor).toBeNull();
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
) {
  const openId = `ou_s2_canvas_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
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
          role: "PARTICIPANT" as const,
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
  return { role: "PROJECT_ADMINISTRATOR", team: "", techGroup: "" };
}

function scopedRole(
  role: "GROUP_LEADER",
  team: string,
  techGroup: string,
): ProjectManagementSystemRoleRecord {
  return { role, team, techGroup: team ? "" : techGroup };
}

async function grantScopedRole(
  accountId: string,
  role: "GROUP_LEADER",
  team: string,
  techGroup: string,
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team,
      techGroup: team ? "" : techGroup,
      grantedByAccountId: accountId,
      revokedAt: new Date(),
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

function fullSegmentIds(
  data: Awaited<ReturnType<typeof getTimeCanvasData>>,
): string[] {
  return data.segments.flatMap((segment) =>
    segment.kind === "SEGMENT" ? [segment.id] : [],
  );
}

function rowCanCreate(
  data: Awaited<ReturnType<typeof getTimeCanvasData>>,
  rowId: string,
): boolean | undefined {
  return data.rows.find((row) => row.id === rowId)?.capabilities.canCreateSegment;
}

type TaskMemberRoleInput = "OWNER" | "PARTICIPANT";

type TaskStatusInput =
  | "DRAFT"
  | "ACTIVE"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMEOUT"
  | "ARCHIVED";
