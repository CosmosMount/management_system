import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  createTaskDraft,
} from "../lib/project-management/application/lifecycle-service";
import {
  createWorkSegment,
} from "../lib/project-management/application/segment-service";
import {
  markInAppNotificationRead as markInAppNotificationReadService,
} from "../lib/project-management/application/notification-service";
import {
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "../lib/project-management/date-time";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

test.describe("project management P4/P6 UI integration", () => {
  test("datetime-local helpers preserve Shanghai business wall-clock", () => {
    expect(shanghaiDateTimeLocalToIso("2026-08-10T00:00")).toBe(
      "2026-08-09T16:00:00.000Z",
    );
    expect(shanghaiDateTimeLocalToIso("2026-08-10T00:00:30.123")).toBe(
      "2026-08-09T16:00:30.123Z",
    );
    expect(isoToShanghaiDateTimeLocal("2026-08-09T16:00:00.000Z")).toBe(
      "2026-08-10T00:00",
    );
  });

  test("Task Composer restores a scoped local draft and creates exactly one Task on desktop and mobile", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(90_000);
    const creator = await createAccountPerson(
      `S5 Composer Creator ${testInfo.project.name} ${randomUUID()}`,
    );
    const coOwner = await createAccountPerson(
      `S5 Composer Co-Owner ${testInfo.project.name} ${randomUUID()}`,
    );
    await loginAsTestUser(context, baseURL, {
      openId: creator.openId,
      name: creator.person.displayName,
    });
    const title = `S5 Composer ${randomUUID()}`;

    await page.goto("/progress/tasks/new?start=2026-09-01");
    await expect(page.getByRole("heading", { name: "新建 Task" })).toBeVisible();
    await expect(page.getByTestId("task-composer")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await expect(page.getByRole("checkbox", { name: /允许自审/ })).toHaveCount(0);
    await page.getByLabel("Task 名称").fill(title);
    await page.waitForTimeout(900);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(window.localStorage).some((key) => key.startsWith("task-draft:")),
        ),
      )
      .toBe(true);

    await page.reload();
    await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toBeVisible();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByLabel("Task 名称")).toHaveValue(title);

    const lastOwnerButton = page.getByRole("button", {
      name: `移除 ${creator.person.displayName} 负责人`,
    });
    await expect(lastOwnerButton).toBeDisabled();
    await page.getByLabel("成员人员", { exact: true }).fill(coOwner.person.displayName);
    await expect(
      page.getByRole("option", { name: new RegExp(coOwner.person.displayName) }),
    ).toBeVisible();
    await page
      .getByRole("option", { name: new RegExp(coOwner.person.displayName) })
      .click();
    await page.getByLabel("成员角色").selectOption("OWNER");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect(lastOwnerButton).toBeEnabled();

    if (testInfo.project.name === "desktop") {
      await page.getByRole("application", { name: "Task 计划时间轴" }).press("m");
      await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("2/200");
      await page.getByLabel("预期完成时间").fill("2026-09-08T09:00");
      await page.getByRole("button", { name: "同时间前移" }).click();
      await expect(page.getByRole("heading", { name: "Milestone #1" })).toBeVisible();
      await page.getByLabel("预期完成时间").fill("2026-09-08T10:00");
      await expect(page.getByRole("button", { name: "同时间前移" })).toBeDisabled();
      await page.getByRole("button", { name: "删除", exact: true }).click();
      await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("1/200");
    }

    await page.getByLabel("目标").fill("完成 S5 Composer 主流程");
    await page
      .getByLabel("完成条件")
      .fill("创建页、权限、幂等和数据库断言均通过");
    await page
      .getByLabel("验收要求")
      .fill("由 Playwright 同时验证 Desktop 与 Pixel 5");
    await page.getByRole("button", { name: /^Termination/ }).click();
    await page
      .getByLabel("Task 整体预期结果")
      .fill("Task 草稿创建完成且不包含初始 Segment");
    await page.getByLabel("计划结束时间").fill("2026-09-07T18:00");
    await page.getByRole("button", { name: /^校验/ }).click();
    await expect(
      page.getByText("Termination 不得早于最后一个 Milestone。"),
    ).toBeVisible();
    await page.getByLabel("计划结束时间").fill("2026-09-16T18:00");
    await page.getByRole("button", { name: /^校验/ }).click();
    await expect(page.getByText("计划校验通过，可以创建 Task 草稿。")).toBeVisible();

    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((candidate) =>
        candidate.startsWith("task-draft:"),
      );
      if (!key) throw new Error("未找到 S5 本地草稿 key");
      const envelope = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
        task: {
          milestones: Array<Record<string, unknown>>;
          selectedEntityId: string | null;
        };
      };
      const first = envelope.task.milestones[0];
      if (!first) throw new Error("本地草稿缺少 Milestone");
      envelope.task.milestones = Array.from({ length: 200 }, (_, index) => ({
        ...first,
        id: `draft-node-${crypto.randomUUID()}`,
        goal: `S5 批量 Milestone ${index + 1}`,
      }));
      envelope.task.selectedEntityId = String(envelope.task.milestones[0]?.id ?? "");
      window.localStorage.setItem(key, JSON.stringify(envelope));
    });
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("200/200");
    await page.getByRole("button", { name: /^校验/ }).click();
    await expect(page.getByText("计划校验通过，可以创建 Task 草稿。")).toBeVisible();

    let aborted = false;
    await page.route("**/progress/tasks/new?*", async (route) => {
      if (route.request().method() === "POST" && !aborted) {
        aborted = true;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "创建 Task 草稿" }).click();
    await expect(page.getByText(/网络或服务暂时不可用/)).toBeVisible();
    expect(await prisma.task.count({ where: { title } })).toBe(1);
    await page.unroute("**/progress/tasks/new?*");
    await page.getByRole("button", { name: "创建 Task 草稿" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expectHealthyPage(page);
    const task = await prisma.task.findFirstOrThrow({
      where: { title },
      include: {
        members: { where: { removedAt: null } },
        currentPlanVersion: { include: { nodes: true } },
        workSegments: { where: { deletedAt: null } },
      },
    });
    expect(task.status).toBe("DRAFT");
    expect(task.members).toHaveLength(2);
    expect(task.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ personId: creator.person.id, role: "OWNER" }),
        expect.objectContaining({ personId: coOwner.person.id, role: "OWNER" }),
      ]),
    );
    expect(task.currentPlanVersion.plannedStartAt).not.toBeNull();
    expect(task.currentPlanVersion.nodes).toHaveLength(201);
    expect(task.workSegments).toHaveLength(0);
    expect(await prisma.task.count({ where: { title } })).toBe(1);
    expect(
      await page.evaluate(() =>
        Object.keys(window.localStorage).some((key) => key.startsWith("task-draft:")),
      ),
    ).toBe(false);
  });

  test("ordinary unified accounts can open the Task Composer without an organization role", async ({
    context,
    page,
    baseURL,
  }) => {
    const outsider = await createAccountPerson("S5 Composer Outsider");
    await loginAsTestUser(context, baseURL, {
      openId: outsider.openId,
      name: outsider.person.displayName,
    });
    await page.goto("/progress/tasks/new");
    await expect(page.getByTestId("task-composer")).toBeVisible();
    await expect(page.getByLabel("成员角色").locator("option")).toHaveText([
      "负责人",
      "参与人",
    ]);
    await expect(page.getByText("流程策略")).toHaveCount(0);
    await expectHealthyPage(page);
  });

  test("an inactive Person account can open global read pages and the Task Composer", async ({
    context,
    page,
    baseURL,
  }) => {
    const guardAdmin = await createAccountPerson("S5 Inactive Owner Guard Admin");
    await grantRole(guardAdmin.account.id, "PROJECT_ADMINISTRATOR");
    const user = await createAccountPerson("S5 Inactive Unified Account");
    await prisma.person.update({
      where: { id: user.person.id },
      data: { status: "INACTIVE" },
    });
    const draftTitle = `S5 Inactive Owner Draft ${randomUUID()}`;
    const draft = await createTaskDraft(actor(user), {
      title: draftTitle,
      description: "停用创建者仍可创建 Task，但不能新增投入",
      team: "英雄",
      techGroup: "电控",
      priority: "MEDIUM",
      tagIds: [],
      members: [{ personId: user.person.id, role: "OWNER" }],
      milestones: [milestoneInput("停用负责人阶段", "完成阶段目标", 1)],
      plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
      termination: terminationInput(5),
      idempotencyKey: `inactive-owner-draft-${randomUUID()}`,
    });
    await loginAsTestUser(context, baseURL, {
      openId: user.openId,
      name: user.person.displayName,
    });

    await page.goto("/progress/resources");
    await expect(page.getByRole("heading", { name: "人员计划" })).toBeVisible();
    await expectHealthyPage(page);
    await page.goto("/progress/my-timeline");
    await expect(page.getByRole("heading", { name: "我的时间" })).toBeVisible();
    await expectHealthyPage(page);
    await page.goto("/progress/tasks/new");
    await expect(page.getByTestId("task-composer")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `移除 ${user.person.displayName} 负责人`,
      }),
    ).toBeDisabled();
    await expectHealthyPage(page);
    await page.goto(`/progress/tasks/${draft.taskId}`);
    await expect(page.getByRole("heading", { name: draftTitle })).toBeVisible();
    await expect(page.getByRole("button", { name: "新增投入" })).toHaveCount(0);
    await expectHealthyPage(page);
  });

  test("Task Composer isolates local drafts, preserves incompatible data and guards browser history", async ({
    context,
    page,
    baseURL,
  }) => {
    const creatorA = await createAccountPerson("S5 Draft Scope A");
    const creatorB = await createAccountPerson("S5 Draft Scope B");
    const hiddenCreator = await createAccountPerson("S5 Hidden Task Creator");
    const hiddenTitle = `S5 Hidden Related ${randomUUID()}`;
    const hiddenTask = await createTaskDraft(actor(hiddenCreator), {
      title: hiddenTitle,
      description: "不可枚举的关联 Task",
      team: "工程",
      techGroup: "机械",
      members: [{ personId: hiddenCreator.person.id, role: "OWNER" }],
      plannedStartAt: "2026-09-01T01:00:00.000Z",
      milestones: [
        {
          goal: "隐藏阶段",
          completionCriteria: "隐藏完成条件",
          expectedCompletedAt: "2026-09-02T10:00:00.000Z",
          reviewRequirements: "隐藏验收要求",
          businessDescription: "",
        },
      ],
      termination: {
        plannedOutcomeCriteria: "隐藏结束条件",
        plannedAt: "2026-09-04T10:00:00.000Z",
        businessDescription: "",
      },
      idempotencyKey: `s5-hidden-${randomUUID()}`,
    });
    await prisma.task.update({
      where: { id: hiddenTask.taskId },
      data: { deletedAt: new Date() },
    });
    await loginAsTestUser(context, baseURL, {
      openId: creatorA.openId,
      name: creatorA.person.displayName,
    });

    await page.goto("/progress/tasks");
    await page.getByRole("link", { name: "新建 Task" }).click();
    await page.getByLabel("关联 Task", { exact: true }).fill(hiddenTitle);
    await expect(page.getByText("没有匹配项。")).toBeVisible();
    await expect(
      page.getByRole("option", { name: new RegExp(hiddenTitle) }),
    ).toHaveCount(0);
    const forgedTitle = `S5 forged related ${randomUUID()}`;
    await page.getByLabel("Task 名称").fill(forgedTitle);
    await page.getByLabel("目标").fill("伪造关联目标");
    await page.getByLabel("完成条件").fill("服务端拒绝隐藏关联");
    await page.getByLabel("验收要求").fill("不得通过本地草稿绕过可见性");
    await page.getByRole("button", { name: /^Termination/ }).click();
    await page.getByLabel("Task 整体预期结果").fill("隐藏关联写入被拒绝");
    await page.waitForTimeout(900);
    await page.evaluate(({ taskId, title }) => {
      const key = Object.keys(window.localStorage).find((candidate) =>
        candidate.startsWith("task-draft:"),
      );
      if (!key) throw new Error("未找到待伪造的本地草稿");
      const envelope = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
        task: { title: string; relatedTaskId: string | null };
      };
      envelope.task.title = title;
      envelope.task.relatedTaskId = taskId;
      window.localStorage.setItem(key, JSON.stringify(envelope));
    }, { taskId: hiddenTask.taskId, title: forgedTitle });
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await page.getByRole("button", { name: "创建 Task 草稿" }).click();
    await expect(page.getByText(/对象不存在|无权/)).toBeVisible();
    expect(await prisma.task.count({ where: { title: forgedTitle } })).toBe(0);
    await page.getByRole("button", { name: "清空关联 Task" }).click();
    await page.getByLabel("Task 名称").fill("S5 Account A local draft");
    await page.waitForTimeout(900);
    const localKey = await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((candidate) =>
        candidate.startsWith("task-draft:"),
      );
      if (!key) throw new Error("未找到本地草稿 key");
      window.localStorage.setItem(
        "task-draft:other-deployment:other-account:v1",
        window.localStorage.getItem(key) ?? "",
      );
      return key;
    });

    await page.goBack();
    await expect(page.getByRole("dialog", { name: "离开 Task Composer？" })).toBeVisible();
    await page.getByRole("button", { name: "继续编辑" }).click();
    await expect(page.getByTestId("task-composer")).toBeVisible();

    await page.evaluate((key) => {
      const envelope = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
        task: { milestones: Array<{ id: string }> };
      };
      envelope.task.milestones[1] = {
        ...envelope.task.milestones[0]!,
      };
      window.localStorage.setItem(key, JSON.stringify(envelope));
    }, localKey);
    await page.reload();
    await expect(page.getByText(/草稿版本、结构或字段不兼容/)).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出原始草稿" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^task-composer-unreadable-.*\.json$/);
    await page.getByRole("button", { name: "安全放弃" }).click();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), localKey)).toBeNull();

    await page.getByLabel("Task 名称").fill("S5 Account A isolated draft");
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "全部 Task", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "离开 Task Composer？" })).toBeVisible();
    await page.getByRole("button", { name: "保存本地草稿并离开" }).click();
    await expect(page.getByRole("heading", { name: "全部 Task" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "全部 Task" })).toBeVisible();
    await expect(page.getByTestId("task-composer")).toHaveCount(0);
    await context.clearCookies();
    await loginAsTestUser(context, baseURL, {
      openId: creatorB.openId,
      name: creatorB.person.displayName,
    });
    await page.goto("/progress/tasks/new");
    await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toHaveCount(0);
    await expect(page.getByText(/草稿版本、结构或字段不兼容/)).toHaveCount(0);
    await expect(page.getByLabel("Task 名称")).toHaveValue("");
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("task-draft:other-deployment:other-account:v1"),
      ),
    ).not.toBeNull();
    await expectHealthyPage(page);
  });

  test("Task Composer keeps the current actor as Owner beyond the first people page and removes workflow policy controls", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "服务端分页归属路径只需在桌面重复一次");
    await prisma.person.createMany({
      data: Array.from({ length: 55 }, (_, index) => ({
        displayName: `000 S5 owner pagination ${String(index).padStart(2, "0")}`,
        status: "ACTIVE" as const,
      })),
    });
    const administrator = await createAccountPerson("ZZZ S5 System Administrator");
    await grantRole(administrator.account.id, "PROJECT_ADMINISTRATOR");
    await loginAsTestUser(context, baseURL, {
      openId: administrator.openId,
      name: administrator.person.displayName,
    });
    const title = `S5 system admin ${randomUUID()}`;

    await page.goto("/progress/tasks/new?start=2026-10-01");
    await expect(
      page.getByRole("button", {
        name: `移除 ${administrator.person.displayName} 负责人`,
      }),
    ).toBeVisible();
    await page.getByLabel("Task 名称").fill(title);
    await page.getByLabel("目标").fill("管理员自审目标");
    await page.getByLabel("完成条件").fill("Owner 为当前 actor");
    await page.getByLabel("验收要求").fill("全局管理员审批");
    await expect(page.getByText("流程策略")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: /允许自审/ })).toHaveCount(0);
    await page.getByRole("button", { name: /^Termination/ }).click();
    await page.getByLabel("Task 整体预期结果").fill("管理员 Task 创建完成");
    await page.getByRole("button", { name: "创建 Task 草稿" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    const task = await prisma.task.findFirstOrThrow({
      where: { title },
      include: { members: { where: { removedAt: null } } },
    });
    expect(task.members).toEqual([
      expect.objectContaining({ personId: administrator.person.id, role: "OWNER" }),
    ]);
  });

  test("Task Composer restores an inactive template owner with the real status", async ({
    context,
    page,
    baseURL,
  }) => {
    const creator = await createAccountPerson("S5 Template Copy Creator");
    const inactiveOwner = await createAccountPerson("S5 Template Inactive Owner");
    const template = await createTaskDraft(actor(creator), {
      title: `S5 Inactive Template ${randomUUID()}`,
      description: "复制时必须恢复模板成员的真实人员状态",
      team: "英雄",
      techGroup: "电控",
      priority: "MEDIUM",
      tagIds: [],
      members: [
        { personId: inactiveOwner.person.id, role: "OWNER" },
        { personId: creator.person.id, role: "PARTICIPANT" },
      ],
      milestones: [milestoneInput("模板阶段", "模板完成条件", 1)],
      plannedStartAt: new Date(Date.UTC(2026, 7, 1, 1, 0, 0)).toISOString(),
      termination: terminationInput(5),
      idempotencyKey: `s5-inactive-template-${randomUUID()}`,
    });
    await prisma.person.update({
      where: { id: inactiveOwner.person.id },
      data: { status: "INACTIVE" },
    });
    await loginAsTestUser(context, baseURL, {
      openId: creator.openId,
      name: creator.person.displayName,
    });

    await page.goto(`/progress/tasks/new?templateTaskId=${template.taskId}`);
    await expect(
      page.getByRole("button", {
        name: `移除 ${inactiveOwner.person.displayName} 负责人`,
      }),
    ).toBeVisible();
    const memberPicker = page.getByLabel("成员人员", { exact: true });
    await memberPicker.click();
    const inactiveOption = page.getByRole("option", {
      name: new RegExp(inactiveOwner.person.displayName),
    });
    await expect(inactiveOption).toContainText("人员已停用");
    await expect(inactiveOption).toHaveAttribute("aria-disabled", "true");
    await memberPicker.press("Escape");
    await expect(memberPicker).not.toHaveValue(inactiveOwner.person.displayName);
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: `移除 ${inactiveOwner.person.displayName} 成员`,
      }),
    ).toHaveCount(0);
    await expectHealthyPage(page);
  });

  test("dashboard, Task workbench, resource timeline and notifications work", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(90_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    const fixture = await createUiFixture();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.member.openId,
      name: fixture.member.person.displayName,
    });

    await page.goto("/progress");
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: fixture.taskTitle, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("未读通知")).toBeVisible();
    await expect(page.getByRole("link", { name: "资源冲突" })).toHaveCount(0);
    await expectHealthyPage(page);

    await page.goto("/progress/tasks?mine=1");
    await expect(page.getByRole("heading", { name: "全部 Task" })).toBeVisible();
    await expect(page.getByText(fixture.taskTitle)).toBeVisible();
    await expectHealthyPage(page);

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(page.getByRole("heading", { name: fixture.taskTitle })).toBeVisible();
    await expect(page.getByRole("heading", { name: "当前计划" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "人员投入" })).toBeVisible();
    await expectHealthyPage(page);

    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
    );
    await expect(page.getByRole("heading", { name: "人员计划" })).toBeVisible();
    await expect(page.getByTestId("time-canvas-root")).toBeVisible();
    await expect(page.getByText("只看冲突")).toHaveCount(0);
    await expect(page.getByText("投入比例")).toHaveCount(0);
    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.inactiveHistory.person.id}&zoom=hour`,
    );
    await expect(
      page.getByText(
        `${fixture.inactiveHistory.person.displayName}（已停用）`,
        { exact: true },
      ).first(),
    ).toBeVisible();
    if (testInfo.project.name === "desktop") {
      await page.getByTestId("time-canvas-scroll").evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
    }
    await expect(
      page.getByTestId(
        testInfo.project.name === "mobile"
          ? `agenda-item-${fixture.inactiveHistorySegmentId}`
          : `segment-block-${fixture.inactiveHistorySegmentId}`,
      ),
    ).toBeVisible();
    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
    );
    await expect(
      page.getByRole("button", { name: `移除${fixture.member.person.displayName}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `移除${fixture.owner.person.displayName}` }),
    ).toBeVisible();
    const peoplePicker = page.getByLabel("筛选人员", { exact: true });
    await peoplePicker.click();
    await peoplePicker.press("Backspace");
    await expect(
      page.getByRole("button", { name: `移除${fixture.owner.person.displayName}` }),
    ).toHaveCount(0);
    await peoplePicker.fill(fixture.owner.person.displayName);
    const ownerOption = page.getByRole("option", {
      name: fixture.owner.person.displayName,
      exact: true,
    });
    await expect(ownerOption.locator(".sr-only")).toHaveText("已绑定账号");
    const ownerLabelBox = await ownerOption
      .getByText(fixture.owner.person.displayName, { exact: true })
      .boundingBox();
    expect(ownerLabelBox?.width ?? 0).toBeGreaterThan(80);
    await ownerOption.click();
    const taskPicker = page.getByLabel("筛选 Task", { exact: true });
    await taskPicker.fill(fixture.taskTitle);
    const taskOption = page.getByRole("option", {
      name: fixture.taskTitle,
      exact: true,
    });
    await expect(taskOption.locator(".sr-only")).toContainText("进行中 · 高");
    await expect(taskOption.locator(".sr-only")).toContainText("英雄 / 电控");
    const taskTitleBox = await taskOption
      .getByText(fixture.taskTitle, { exact: true })
      .boundingBox();
    expect(taskTitleBox?.width ?? 0).toBeGreaterThan(120);
    await taskOption.click();
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(page).toHaveURL(new RegExp(`tasks=${fixture.taskId}`));
    await page.reload();
    await expect(
      page.getByRole("button", { name: `移除${fixture.owner.person.displayName}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `移除${fixture.taskTitle}` }),
    ).toBeVisible();
    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&tasks=${fixture.taskId}&group=task&zoom=hour`,
    );
    await expect(page.getByText(fixture.taskTitle, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "新增投入" })).toBeVisible();
    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
    );
    if (testInfo.project.name === "desktop") {
      await page.goto(
        `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id}&zoom=hour`,
      );
      const emptyCanvasScroll = page.getByTestId("time-canvas-scroll");
      await emptyCanvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const emptyRow = page.getByLabel(`${fixture.member.person.displayName} 时间行`, { exact: true });
      const emptyScrollBox = await emptyCanvasScroll.boundingBox();
      const emptyRowBox = await emptyRow.boundingBox();
      if (!emptyScrollBox || !emptyRowBox) throw new Error("未找到空人员行拖选坐标");
      const brushStartX = emptyScrollBox.x + Math.min(emptyScrollBox.width - 140, 760);
      const brushY = emptyRowBox.y + emptyRowBox.height - 8;
      await page.mouse.move(brushStartX, brushY);
      await page.mouse.down();
      await page.mouse.move(brushStartX + 72, brushY, { steps: 4 });
      await page.mouse.up();
      const brushCreate = page.getByRole("form", { name: "投入快速创建" });
      await expect(brushCreate).toBeVisible();
      await expect(brushCreate.getByLabel("投入比例")).toHaveCount(0);
      await brushCreate.getByLabel("Task", { exact: true }).fill(fixture.taskTitle);
      await page
        .getByRole("option", { name: fixture.taskTitle, exact: true })
        .click();
      await brushCreate.getByLabel("内容").fill(fixture.brushCreateContent);
      await brushCreate.getByRole("button", { name: "创建", exact: true }).click();
      await expect(page.getByText("已创建投入记录")).toBeVisible();
      await expect.poll(() => prisma.workSegment.findFirst({
        where: {
          personId: fixture.member.person.id,
          content: fixture.brushCreateContent,
        },
        select: { taskId: true, nodeId: true },
      })).toEqual({ taskId: fixture.taskId, nodeId: fixture.activeNodeId });
      await page.goto(
        `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
      );
      const canvasScroll = page.getByTestId("time-canvas-scroll");
      await expect(canvasScroll).toBeVisible();
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const beforeKeyboardMove = await prisma.workSegment.findUniqueOrThrow({
        where: { id: fixture.movableSegmentId },
        select: { startAt: true },
      });
      const movable = page.getByTestId(`segment-block-${fixture.movableSegmentId}`);
      await prisma.workSegment.update({
        where: { id: fixture.movableSegmentId },
        data: { content: "P6 UI 制造 stale 后仍可重试" },
      });
      await movable.focus();
      await movable.press("Shift+ArrowRight");
      await expect(page.getByText(/投入记录已被他人修改/)).toBeVisible();
      expect(
        await prisma.workSegment.findUniqueOrThrow({
          where: { id: fixture.movableSegmentId },
          select: { startAt: true },
        }),
      ).toMatchObject({ startAt: beforeKeyboardMove.startAt });
      await page.waitForTimeout(500);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      await movable.focus();
      await movable.press("Shift+ArrowRight");
      await expect(page.getByText("已移动计划投入")).toBeVisible();
      await expect
        .poll(async () => {
          const row = await prisma.workSegment.findUniqueOrThrow({
            where: { id: fixture.movableSegmentId },
            select: { startAt: true },
          });
          return row.startAt.getTime();
        })
        .toBe(beforeKeyboardMove.startAt.getTime() + 30 * 60 * 1_000);
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const beforeInvalidDrop = await prisma.workSegment.findUniqueOrThrow({
        where: { id: fixture.movableSegmentId },
        select: { startAt: true, endAt: true },
      });
      const movableBox = await page
        .getByTestId(`segment-block-${fixture.movableSegmentId}`)
        .boundingBox();
      const otherRowBox = await page
        .getByLabel(`${fixture.owner.person.displayName} 时间行`, { exact: true })
        .boundingBox();
      if (!movableBox || !otherRowBox) throw new Error("未找到跨行拖动测试坐标");
      await page.mouse.move(movableBox.x + movableBox.width / 2, movableBox.y + movableBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(movableBox.x + movableBox.width / 2 + 36, otherRowBox.y + otherRowBox.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByText("不支持跨人员行拖放，投入仍保留在原位置。")).toBeVisible();
      expect(
        await prisma.workSegment.findUniqueOrThrow({
          where: { id: fixture.movableSegmentId },
          select: { startAt: true, endAt: true },
        }),
      ).toMatchObject(beforeInvalidDrop);

      await page.mouse.move(movableBox.x + movableBox.width / 2, movableBox.y + movableBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(movableBox.x + movableBox.width / 2 + 36, movableBox.y + movableBox.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByText("已移动计划投入")).toBeVisible();
      await expect
        .poll(async () => (await prisma.workSegment.findUniqueOrThrow({ where: { id: fixture.movableSegmentId }, select: { startAt: true } })).startAt.getTime())
        .toBe(beforeInvalidDrop.startAt.getTime() + 30 * 60 * 1_000);
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const beforeStartResize = await prisma.workSegment.findUniqueOrThrow({
        where: { id: fixture.movableSegmentId },
        select: { startAt: true },
      });
      const startResizeHandle = page
        .getByTestId(`segment-block-${fixture.movableSegmentId}`)
        .locator('[data-resize-handle="start"]');
      const startResizeBox = await startResizeHandle.boundingBox();
      if (!startResizeBox) throw new Error("未找到可见的 Segment 开始时间调整柄");
      await page.mouse.move(startResizeBox.x + startResizeBox.width / 2, startResizeBox.y + startResizeBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(startResizeBox.x + startResizeBox.width / 2 - 36, startResizeBox.y + startResizeBox.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByText("已调整计划投入区间")).toBeVisible();
      await expect
        .poll(async () => (await prisma.workSegment.findUniqueOrThrow({ where: { id: fixture.movableSegmentId }, select: { startAt: true } })).startAt.getTime())
        .toBe(beforeStartResize.startAt.getTime() - 30 * 60 * 1_000);
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const beforeResize = await prisma.workSegment.findUniqueOrThrow({
        where: { id: fixture.movableSegmentId },
        select: { endAt: true },
      });
      const resizeHandle = page
        .getByTestId(`segment-block-${fixture.movableSegmentId}`)
        .locator('[data-resize-handle="end"]');
      const resizeBox = await resizeHandle.boundingBox();
      if (!resizeBox) throw new Error("未找到可见的 Segment 结束时间调整柄");
      await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 36, resizeBox.y + resizeBox.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByText("已调整计划投入区间")).toBeVisible();
      await expect
        .poll(async () => {
          const row = await prisma.workSegment.findUniqueOrThrow({
            where: { id: fixture.movableSegmentId },
            select: { endAt: true },
          });
          return row.endAt.getTime();
        })
        .toBe(beforeResize.endAt.getTime() + 30 * 60 * 1_000);
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const expectedRangeAfterTransforms = await prisma.workSegment.findUniqueOrThrow({
        where: { id: fixture.movableSegmentId },
        select: { startAt: true, endAt: true },
      });
      await page.getByTestId(`segment-block-${fixture.movableSegmentId}`).click();
      const movedInspector = page.getByTestId("segment-inspector");
      await expect(movedInspector.getByRole("heading", { name: "P6 UI 制造 stale 后仍可重试" })).toBeVisible();
      await expect(movedInspector.getByLabel("投入比例")).toHaveCount(0);
      await movedInspector.getByLabel("职责", { exact: true }).selectOption("CUSTOM");
      await movedInspector.getByLabel("自定义职责").fill("跨域协调");
      await movedInspector.getByLabel("内容").fill("P6 UI Inspector 更新不覆盖画布时间");
      await movedInspector.getByRole("button", { name: "保存精确修改" }).click();
      await expect(page.getByText("已更新投入详情")).toBeVisible();
      await expect.poll(async () => {
        const row = await prisma.workSegment.findUniqueOrThrow({
          where: { id: fixture.movableSegmentId },
          select: { startAt: true, endAt: true, role: true, customRole: true },
        });
        return {
          startAt: row.startAt.toISOString(),
          endAt: row.endAt.toISOString(),
          role: row.role,
          customRole: row.customRole,
        };
      }).toEqual({
        startAt: expectedRangeAfterTransforms.startAt.toISOString(),
        endAt: expectedRangeAfterTransforms.endAt.toISOString(),
        role: "CUSTOM",
        customRole: "跨域协调",
      });
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      await page
        .getByTestId(`segment-block-${fixture.batchCancelableSegmentIds[0]}`)
        .click({ modifiers: ["Shift"] });
      await page
        .getByTestId(`segment-block-${fixture.batchCancelableSegmentIds[1]}`)
        .click({ modifiers: ["Shift"] });
      await expect(page.getByText("已选 2 条")).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "批量取消", exact: true }).click();
      await expect(page.getByText("已原子取消所选计划")).toBeVisible();
      await expect.poll(() => prisma.workSegment.count({
        where: {
          id: { in: [...fixture.batchCancelableSegmentIds] },
          status: "CANCELLED",
        },
      })).toBe(2);
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      await page
        .getByTestId(`segment-block-${fixture.confirmableSegmentId}`)
        .click();
    } else {
      await expect(page.getByTestId("time-agenda")).toBeVisible();
      await page.getByRole("button", { name: "新增投入" }).click();
      const quickCreate = page.getByRole("form", { name: "投入快速创建" });
      await expect(quickCreate.getByLabel("投入比例")).toHaveCount(0);
      await quickCreate.getByLabel("内容").fill(fixture.mobileCreateContent);
      const actionUrl = "**/progress/resources**";
      let actionAborted = false;
      const abortFirstAction = async (route: import("@playwright/test").Route) => {
        if (!actionAborted && route.request().method() === "POST") {
          actionAborted = true;
          await route.abort();
          return;
        }
        await route.continue();
      };
      await page.route(actionUrl, abortFirstAction);
      await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
      await expect(page.getByText("网络异常，未能保存；输入仍保留，可直接重试。")).toBeVisible();
      await expect(quickCreate.getByLabel("内容")).toHaveValue(fixture.mobileCreateContent);
      await page.unroute(actionUrl, abortFirstAction);
      await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
      await expect(page.getByText("已创建投入记录")).toBeVisible();
      await expect
        .poll(() => prisma.workSegment.count({ where: { content: fixture.mobileCreateContent } }))
        .toBe(1);
      await page.waitForTimeout(800);
      await page
        .getByTestId(`agenda-item-${fixture.confirmableSegmentId}`)
        .click();
    }
    await expect(page.getByTestId("segment-inspector")).toBeVisible();
    await expect(
      page
        .getByTestId("segment-inspector")
        .getByRole("heading", { name: "P6 UI 可确认计划" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "完整确认", exact: true }).click();
    await expect(page.getByText("已完整确认并生成 Actual")).toBeVisible();
    await expect
      .poll(async () => {
        const row = await prisma.workSegment.findUniqueOrThrow({
          where: { id: fixture.confirmableSegmentId },
          select: { status: true },
        });
        return row.status;
      })
      .toBe("CONFIRMED");
    await expectHealthyPage(page);
    expect(pageErrors).toEqual([]);

    await page.goto("/progress/notifications");
    await expect(page.getByRole("heading", { name: "站内通知" })).toBeVisible();
    await expect(page.getByText("P6 UI 通知")).toBeVisible();
    await page
      .locator("article")
      .filter({ hasText: "P6 UI 通知" })
      .getByRole("button", { name: "标记已读" })
      .click();
    await expect(page.getByText("已标记通知为已读")).toBeVisible();
    await expect
      .poll(async () => {
        const row = await prisma.inAppNotification.findUniqueOrThrow({
          where: { id: fixture.notificationId },
          select: { readAt: true },
        });
        return row.readAt !== null;
      })
      .toBe(true);
    await expectHealthyPage(page);
  });

  test("non-member can view the full Task workbench but cannot mutate it", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createUiFixture();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.outsider.openId,
      name: fixture.outsider.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(page.getByRole("heading", { name: fixture.taskTitle })).toBeVisible();
    await expect(page.getByRole("button", { name: "新增投入" })).toHaveCount(0);
    await page.getByRole("tab", { name: "概览" }).click();
    await expect(page.getByRole("button", { name: "保存元数据" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存成员" })).toHaveCount(0);
    await expect(page.getByText("可创建 Revision：否")).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/progress/notifications");
    await expect(page.getByRole("heading", { name: "站内通知" })).toBeVisible();
    await expect(page.getByText("P6 UI 通知")).toHaveCount(0);
    await expect(
      markInAppNotificationReadService(actor(fixture.outsider), {
        notificationId: fixture.notificationId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("S8 dashboard, action inbox, Tag and notification preferences work on desktop and mobile", async ({
    context,
    page,
    baseURL,
  }) => {
    const user = await createAccountPerson("S8 驾驶舱用户");
    await loginAsTestUser(context, baseURL, {
      openId: user.openId,
      name: user.person.displayName,
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/progress");
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
    await expect(page.getByLabel("工作指标")).toBeVisible();
    await expect(page.getByTestId("action-inbox")).toHaveCount(0);
    await expectHealthyPage(page);

    await page.goto("/progress/approvals");
    await expect(page.getByRole("heading", { name: "待办与审批" })).toBeVisible();
    await expect(page.getByText("当前没有需要你处理的事项。")).toBeVisible();

    const tagName = `S8 Tag ${randomUUID().slice(0, 12)}`;
    await page.goto("/progress/tags");
    await expect(page.getByRole("heading", { name: "Tag 管理" })).toBeVisible();
    await page.getByLabel("Tag 名称").fill(tagName);
    await page.getByLabel("说明").fill("S8 双端 Tag 管理验证");
    await page.getByRole("button", { name: "创建 Tag" }).click();
    await expect(page.getByText("Tag 已创建。")).toBeVisible();
    await expect(page.getByRole("heading", { name: tagName })).toBeVisible();
    await expect.poll(() => prisma.tag.count({ where: { name: tagName } })).toBe(1);

    await page.goto("/progress/notifications");
    await expect(page.getByRole("heading", { name: "通知偏好" })).toBeVisible();
    const taskFeishu = page.getByRole("checkbox", { name: "Task飞书通知" });
    await expect(taskFeishu).toBeChecked();
    await taskFeishu.uncheck();
    await expect(page.getByText(/通知偏好已保存/)).toBeVisible();
    await expect
      .poll(async () => {
        return prisma.notificationPreference.findUnique({
          where: {
            accountId_category_channel: {
              accountId: user.account.id,
              category: "TASK",
              channel: "FEISHU",
            },
          },
          select: { enabled: true },
        });
      })
      .toEqual({ enabled: false });
    await expectHealthyPage(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test("Task workbench persists a Draft plan and locks direct plan editing after activation", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createDraftWorkbenchFixture();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(page.getByRole("heading", { name: fixture.taskTitle })).toBeVisible();
    await expect(page.getByRole("tab", { name: "计划与资源" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const draftEditor = page.locator("section").filter({
      has: page.getByRole("heading", { name: "编辑 Draft 计划" }),
    });
    await expect(draftEditor).toBeVisible();
    await draftEditor.getByLabel("目标").first().fill("S6 Draft 持久化目标");
    await draftEditor.getByRole("button", { name: "添加 Milestone" }).click();
    await expect(page.getByRole("heading", { name: "Milestone #3" })).toBeVisible();
    await draftEditor.getByLabel("目标").nth(2).fill("S6 新增 Milestone");
    await draftEditor.getByLabel("完成条件").nth(2).fill("新增节点保存到数据库");
    await draftEditor.getByLabel("验收要求").nth(2).fill("提交文本证据");
    await draftEditor.getByLabel("预期完成").nth(2).fill("2026-08-04T18:00");
    await draftEditor.getByRole("button", { name: "保存 Draft 计划" }).click();
    await expect(page.getByText("Draft 计划已保存。")).toBeVisible();
    await expect
      .poll(async () => {
        const task = await prisma.task.findUniqueOrThrow({
          where: { id: fixture.taskId },
          include: {
            currentPlanVersion: {
              include: {
                nodes: {
                  include: { node: { include: { milestone: true } } },
                },
              },
            },
          },
        });
        return {
          lockVersion: task.lockVersion,
          milestones: task.currentPlanVersion.nodes
            .flatMap((entry) => entry.node.milestone?.goal ?? [])
            .sort(),
        };
      })
      .toEqual({
        lockVersion: 1,
        milestones: [
          "S6 Draft 持久化目标",
          "S6 Draft 第二阶段",
          "S6 新增 Milestone",
        ].sort(),
      });

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "激活 Task" }).click();
    await expect(page.getByText("Task 已激活。")).toBeVisible();
    await expect(page.getByText(/Current Plan 只读/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "编辑 Draft 计划" })).toHaveCount(0);
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { status: true, lockVersion: true },
        }),
      )
      .toEqual({ status: "ACTIVE", lockVersion: 2 });
    await expectHealthyPage(page);
  });

  test("Task workbench quick create skips an inactive first member", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createDraftWorkbenchFixture();
    await prisma.person.update({
      where: { id: fixture.owner.person.id },
      data: { status: "INACTIVE" },
    });
    await prisma.person.update({
      where: { id: fixture.admin.person.id },
      data: { status: "INACTIVE" },
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.reviewer.openId,
      name: fixture.reviewer.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("button", { name: "新增投入", exact: true }).click();
    const quickCreate = page.getByRole("form", { name: "投入快速创建" });
    await expect(quickCreate.locator('input[name="personId"]')).toHaveValue(
      fixture.reviewer.person.id,
    );
    await expect(
      quickCreate.getByLabel("人员", { exact: true }),
    ).toHaveValue(fixture.reviewer.person.displayName);
    await quickCreate
      .getByLabel("人员", { exact: true })
      .fill(fixture.owner.person.displayName);
    await expect(page.getByText("没有匹配项。")).toBeVisible();
    await expect(
      page.getByRole("option", {
        name: new RegExp(fixture.owner.person.displayName),
      }),
    ).toHaveCount(0);
    await quickCreate.getByLabel("人员", { exact: true }).press("Escape");
    await expect(quickCreate.getByLabel("Task", { exact: true })).toHaveValue(
      fixture.taskTitle,
    );
    await expect(quickCreate.getByLabel("Task", { exact: true })).toHaveAttribute(
      "readonly",
      "",
    );
    await expect(quickCreate.locator('input[name="taskId"]')).toHaveValue(
      fixture.taskId,
    );
    await expectHealthyPage(page);
  });

  test("Task workbench keeps saved related Task and members across authoritative refreshes", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createDraftWorkbenchFixture();
    const addedMember = await createAccountPerson(
      `S6 Workbench Persisted Member ${randomUUID()}`,
    );
    const relatedTitle = `S6 Workbench Related ${randomUUID()}`;
    const related = await createTaskDraft(actor(fixture.admin), {
      title: relatedTitle,
      description: "验证 Workbench 保存后的 authoritative refresh",
      team: "英雄",
      techGroup: "电控",
      priority: "MEDIUM",
      tagIds: [],
      members: [{ personId: fixture.owner.person.id, role: "OWNER" }],
      milestones: [milestoneInput("关联 Task 阶段", "关联 Task 完成条件", 1)],
      plannedStartAt: new Date(Date.UTC(2026, 7, 1, 1, 0, 0)).toISOString(),
      termination: terminationInput(5),
      idempotencyKey: `s6-workbench-related-${randomUUID()}`,
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("button", { name: "新增投入", exact: true }).click();
    const quickCreate = page.getByRole("form", { name: "投入快速创建" });
    const segmentPersonPicker = quickCreate.getByLabel("人员", { exact: true });
    await segmentPersonPicker.click();
    await expect(
      page.getByRole("option", {
        name: fixture.admin.person.displayName,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("option", {
        name: fixture.reviewer.person.displayName,
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("option", {
        name: fixture.reviewer.person.displayName,
        exact: true,
      })
      .click();
    await expect(quickCreate.locator('input[name="personId"]')).toHaveValue(
      fixture.reviewer.person.id,
    );
    await quickCreate.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("tab", { name: "概览" }).click();

    const relatedPicker = page.getByLabel("关联 Task", { exact: true });
    await relatedPicker.fill(relatedTitle);
    await page
      .getByRole("option", { name: relatedTitle, exact: true })
      .click();
    await page.getByRole("button", { name: "保存元数据" }).click();
    await expect(page.getByText("Task 元数据已保存。")).toBeVisible();
    await expect(relatedPicker).toHaveValue(relatedTitle);
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { relatedTaskId: true, lockVersion: true },
        }),
      )
      .toEqual({ relatedTaskId: related.taskId, lockVersion: 1 });
    await expect(page.getByTestId("task-workbench-v1")).toHaveAttribute(
      "data-server-lock-version",
      "1",
    );

    await page.getByRole("button", { name: "保存元数据" }).click();
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { relatedTaskId: true, lockVersion: true },
        }),
      )
      .toEqual({ relatedTaskId: related.taskId, lockVersion: 2 });
    await expect(page.getByTestId("task-workbench-v1")).toHaveAttribute(
      "data-server-lock-version",
      "2",
    );

    const memberPicker = page.getByLabel("新增成员人员", { exact: true });
    await memberPicker.fill(addedMember.person.displayName);
    await page
      .getByRole("option", {
        name: addedMember.person.displayName,
        exact: true,
      })
      .click();
    await page.getByLabel("新增成员角色").selectOption("PARTICIPANT");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await page.getByRole("button", { name: "保存成员" }).click();
    await expect(page.getByText("Task 成员已保存。")).toBeVisible();
    await expect(page.getByText(addedMember.person.displayName)).toBeVisible();
    await expect
      .poll(() =>
        prisma.taskMember.count({
          where: {
            taskId: fixture.taskId,
            personId: addedMember.person.id,
            role: "PARTICIPANT",
            removedAt: null,
          },
        }),
      )
      .toBe(1);
    await expect(page.getByTestId("task-workbench-v1")).toHaveAttribute(
      "data-server-lock-version",
      "3",
    );

    await page.getByRole("button", { name: "保存成员" }).click();
    await expect
      .poll(() =>
        prisma.taskMember.count({
          where: {
            taskId: fixture.taskId,
            personId: addedMember.person.id,
            role: "PARTICIPANT",
            removedAt: null,
          },
        }),
      )
      .toBe(1);
    await expect(page.getByTestId("task-workbench-v1")).toHaveAttribute(
      "data-server-lock-version",
      "4",
    );
    await expect(relatedPicker).toHaveValue(relatedTitle);
    await expectHealthyPage(page);
  });

  test("Task workbench completes metadata, Review, Revision, audit and Termination UI flows", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const fixture = await createUiFixture();
    const viewer = await createAccountPerson("S6 UI Viewer");

    await loginAsTestUser(context, baseURL, {
      openId: viewer.openId,
      name: viewer.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("tab", { name: "概览" }).click();
    await expect(page.getByRole("button", { name: "保存元数据" })).toHaveCount(0);
    await expect(page.getByText("可创建 Revision：否")).toBeVisible();
    await expectHealthyPage(page);

    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}?tab=review`);
    await expect(page.getByRole("tab", { name: /验收/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.goto(`/progress/tasks/${fixture.taskId}?tab=revision`);
    await expect(page.getByRole("tab", { name: "修订与历史" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.goto(`/progress/tasks/${fixture.taskId}?tab=termination`);
    await expect(page.getByRole("tab", { name: /验收/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("tab", { name: "概览" }).click();
    await expect(page).toHaveURL(/tab=overview/);
    const renamedTitle = `${fixture.taskTitle} · S6 已编辑`;
    await page.getByRole("form", { name: "Task 元数据" }).getByLabel("标题").fill(renamedTitle);
    await page.getByRole("button", { name: "保存元数据" }).click();
    await expect(page.getByText("Task 元数据已保存。")).toBeVisible();
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { title: true },
        }),
      )
      .toEqual({ title: renamedTitle });

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("tab", { name: "验收" }).click();
    await expect(page.getByText("FILE 暂未启用")).toBeVisible();
    await page.getByRole("textbox", { name: "文本证据" }).fill("S6 Review 文本证据");
    await page.getByRole("button", { name: "提交验收" }).click();
    await expect(page.getByText("Milestone 已提交验收。")).toBeVisible();
    await expect
      .poll(() =>
        prisma.milestoneReview.findFirst({
          where: { milestoneNode: { node: { taskId: fixture.taskId } } },
          orderBy: { createdAt: "desc" },
          select: { id: true, result: true },
        }),
      )
      .toMatchObject({ result: "PENDING" });

    await page.getByLabel("审批说明").fill("S6 管理员通过");
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await expect(page.getByText("验收已通过。")).toBeVisible();
    await expect
      .poll(() =>
        prisma.milestoneReview.findFirst({
          where: { milestoneNode: { node: { taskId: fixture.taskId } } },
          orderBy: { createdAt: "desc" },
          select: { result: true },
        }),
      )
      .toEqual({ result: "APPROVED" });

    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("tab", { name: "修订与历史" }).click();
    const revisionEditor = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Revision 候选计划" }),
    });
    await revisionEditor.getByLabel("修订原因").fill("S6 调整后续目标");
    await revisionEditor.getByLabel("替换 Milestone #1 目标").fill("S6 Revision 新目标");
    await revisionEditor.getByLabel("替换 Milestone #1 业务说明").fill("S6 Revision 业务说明 A");
    await revisionEditor.getByRole("button", { name: "添加替换 Milestone" }).click();
    await revisionEditor.getByLabel("替换 Milestone #2 目标").fill("S6 Revision 新目标 B");
    await revisionEditor.getByLabel("替换 Milestone #2 完成条件").fill("S6 Revision 条件 B");
    await revisionEditor.getByLabel("替换 Milestone #2 验收要求").fill("S6 Revision 验收 B");
    await revisionEditor.getByLabel("替换 Milestone #2 业务说明").fill("S6 Revision 业务说明 B");
    await revisionEditor
      .getByRole("button", { name: "前移替换 Milestone #2" })
      .click();
    await expect(revisionEditor.getByLabel("替换 Milestone #1 目标")).toHaveValue(
      "S6 Revision 新目标 B",
    );
    await revisionEditor
      .getByLabel("候选 Termination 业务说明")
      .fill("S6 Revision Termination 业务说明");
    await revisionEditor.getByRole("button", { name: "保存 Revision Draft" }).click();
    await expect(page.getByText("Revision Draft 已创建。")).toBeVisible();
    await page.getByRole("button", { name: "编辑候选计划" }).click();
    await expect(page.getByRole("heading", { name: /Revision 候选计划（编辑已有）/ })).toBeVisible();
    await revisionEditor.getByLabel("修订原因").fill("S6 二次编辑候选计划");
    await revisionEditor.getByRole("button", { name: "更新 Revision Draft" }).click();
    await expect(page.getByText("Revision Draft 已更新。")).toBeVisible();
    await page.getByRole("button", { name: "查看三层 Diff" }).click();
    await expect(page.getByRole("heading", { name: "结构 / 字段 / 资源 Diff" })).toBeVisible();
    await page.getByRole("button", { name: "提交审批" }).click();
    await expect(page.getByText("Revision 已提交。")).toBeVisible();

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("tab", { name: "修订与历史" }).click();
    await page.getByRole("button", { name: "批准" }).click();
    await expect(page.getByText("Revision 已批准并应用。")).toBeVisible();
    await expect
      .poll(() =>
        prisma.revisionNode.findFirst({
          where: { node: { taskId: fixture.taskId } },
          orderBy: { node: { createdAt: "desc" } },
          select: { status: true },
        }),
      )
      .toEqual({ status: "EFFECTIVE" });

    await page.getByRole("tab", { name: "审计" }).click();
    await expect(page.getByRole("heading", { name: "Task 审计" })).toBeVisible();
    await page.getByLabel("审计事件类型").selectOption("pm.revision.apply");
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(
      page.locator("ol li").getByText("pm.revision.apply", { exact: true }),
    ).toBeVisible();

    await page.getByRole("tab", { name: /验收/ }).click();
    const outcomeSelect = page.getByLabel("结束结果");
    await expect(outcomeSelect.locator("option")).toHaveCount(4);
    await outcomeSelect.selectOption("CANCELLED");
    await page.getByLabel("原因").fill("S6 Reviewer 提前取消");
    await page.getByLabel("总结").fill("S6 生命周期 UI 闭环完成");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "确认结束 Task" }).click();
    await expect(page.getByText("Task 已完成 Termination 确认。")).toBeVisible();
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { status: true },
        }),
      )
      .toEqual({ status: "CANCELLED" });
    await page.getByRole("tab", { name: "概览" }).click();
    await expect(page.getByRole("button", { name: "保存成员" })).toHaveCount(0);
    await expectHealthyPage(page);
  });

  test("S7 resource filters, removed conflict route and personal timeline work on desktop and mobile", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(90_000);
    const fixture = await createUiFixture();
    await prisma.workSegment.update({
      where: { id: fixture.confirmableSegmentId },
      data: { status: "PENDING_CONFIRMATION" },
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.member.openId,
      name: fixture.member.person.displayName,
    });

    await page.goto(`/progress/resources?focus=${fixture.confirmableSegmentId}`);
    await expect(page.getByTestId("segment-inspector")).toContainText(
      "P6 UI 可确认计划",
    );

    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&tasks=${fixture.taskId}&types=planned&statuses=pending_confirmation&group=person&zoom=hour&focus=${fixture.confirmableSegmentId}`,
    );
    await expect(page.getByRole("heading", { name: "人员计划" })).toBeVisible();
    await expect(page.getByRole("region", { name: "资源计划筛选" })).toBeVisible();
    await expect(page.getByText("人员（2）")).toBeVisible();
    await expect(page.getByText("Task（1）")).toBeVisible();
    await expect(page.getByLabel("待确认")).toBeChecked();
    await expect(page.getByTestId("segment-inspector")).toContainText("P6 UI 可确认计划");
    await page.getByRole("button", { name: "7 天" }).click();
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(page).toHaveURL(/to=2026-08-17/);
    await page.getByRole("button", { name: "复制视图链接" }).click();
    await expect(page.getByText(/已复制当前视图链接|无法访问剪贴板/)).toBeVisible();
    await expectHealthyPage(page);

    const removedConflictPage = await page.goto("/progress/resources/conflicts");
    expect(removedConflictPage?.status()).toBe(404);

    await page.goto(`/progress/my-timeline?focus=${fixture.confirmableSegmentId}&mode=day`);
    await expect(page.getByRole("heading", { name: "我的时间" })).toBeVisible();
    await expect(page.getByTestId("segment-inspector")).toContainText(
      "P6 UI 可确认计划",
    );
    const dueQueue = page.getByRole("region", { name: "到期计划与确认队列" });
    await expect(dueQueue.getByRole("heading", { name: "到期计划与确认队列" })).toBeVisible();
    await expect(dueQueue.getByText("P6 UI 可确认计划")).toBeVisible();
    if (testInfo.project.name === "mobile") {
      await expect(page.getByTestId("time-agenda")).toBeVisible();
    } else {
      await expect(page.getByTestId("time-canvas-scroll")).toBeVisible();
    }
    await dueQueue.getByRole("button", { name: "与计划一致" }).click();
    await expect(page.getByText("已完整确认并生成 Actual")).toBeVisible();
    await expect.poll(() => prisma.workSegment.findUnique({
      where: { id: fixture.confirmableSegmentId },
      select: { status: true },
    })).toEqual({ status: "CONFIRMED" });

    const independentContent = `S7 独立安排 ${randomUUID()}`;
    await page.getByRole("button", { name: "新增投入" }).click();
    const quickCreate = page.getByRole("form", { name: "投入快速创建" });
    await expect(
      quickCreate.locator('input[type="hidden"][name="taskId"]'),
    ).toHaveValue("");
    await quickCreate.getByLabel("内容").fill(independentContent);
    await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByText("已创建投入记录")).toBeVisible();
    await expect.poll(() => prisma.workSegment.count({
      where: { personId: fixture.member.person.id, taskId: null, content: independentContent },
    })).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expectHealthyPage(page);
  });
});

async function createUiFixture() {
  const fixtureKey = randomUUID();
  const admin = await createAccountPerson(`P6 UI Team Admin ${fixtureKey}`);
  const owner = await createAccountPerson(`P6 UI Owner ${fixtureKey}`);
  const member = await createAccountPerson(`P6 UI Member ${fixtureKey}`);
  const reviewer = await createAccountPerson(`P6 UI Reviewer ${fixtureKey}`);
  const outsider = await createAccountPerson(`P6 UI Outsider ${fixtureKey}`);
  const inactiveHistory = await createAccountPerson(
    `P6 UI Historical Person ${fixtureKey}`,
  );
  await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
  const taskTitle = `P6 UI Task ${randomUUID()}`;
  const draft = await createTaskDraft(actor(admin), {
    title: taskTitle,
    description: "P6 UI 集成测试 Task",
    team: "英雄",
    techGroup: "电控",
    priority: "HIGH",
    tagIds: [],
    members: [
      { personId: owner.person.id, role: "OWNER" },
      { personId: member.person.id, role: "PARTICIPANT" },
      { personId: reviewer.person.id, role: "PARTICIPANT" },
      { personId: inactiveHistory.person.id, role: "PARTICIPANT" },
    ],
    milestones: [
      milestoneInput("P6 UI 第一阶段", "完成第一阶段", 1),
      milestoneInput("P6 UI 第二阶段", "完成第二阶段", 2),
    ],
    plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
    termination: terminationInput(5),
    idempotencyKey: `p6-ui-task-${randomUUID()}`,
  });
  const activated = await activateTask(actor(owner), {
    taskId: draft.taskId,
    expectedLockVersion: draft.lockVersion,
  });
  const activeNode = await prisma.planVersionNode.findFirstOrThrow({
    where: {
      planVersionId: activated.currentPlanVersionId,
      node: { type: "MILESTONE", status: "ACTIVE" },
    },
    select: { nodeId: true },
  });
  const confirmable = await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(9),
    endAt: atHour(10),
    content: "P6 UI 可确认计划",
    role: "DEVELOPER",
    priority: "MEDIUM",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  const movable = await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(10),
    endAt: atHour(11),
    content: "P6 UI 重叠计划 A",
    role: "DEVELOPER",
    priority: "MEDIUM",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  await createWorkSegment(actor(owner), {
    personId: owner.person.id,
    type: "PLANNED",
    startAt: atHour(8),
    endAt: atHour(9),
    content: "P6 UI 跨行目标人员安排",
    role: "LEAD",
    priority: "LOW",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(10.5),
    endAt: atHour(11.5),
    content: "P6 UI 重叠计划 B",
    role: "DEVELOPER",
    priority: "MEDIUM",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  const inactiveHistorySegment = await createWorkSegment(
    actor(inactiveHistory),
    {
      personId: inactiveHistory.person.id,
      type: "ACTUAL",
      startAt: atHour(15),
      endAt: atHour(16),
      content: "P6 UI 停用人员历史投入",
      actualOutput: "历史产出",
      completionPercent: 100,
      role: "SUPPORT",
      priority: "LOW",
      taskId: draft.taskId,
      nodeId: activeNode.nodeId,
      tagIds: [],
    },
  );
  await prisma.person.update({
    where: { id: inactiveHistory.person.id },
    data: { status: "INACTIVE" },
  });
  const batchCancelableA = await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(12),
    endAt: atHour(13),
    content: "P6 UI 批量取消 A",
    role: "SUPPORT",
    priority: "LOW",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  const batchCancelableB = await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(13),
    endAt: atHour(14),
    content: "P6 UI 批量取消 B",
    role: "SUPPORT",
    priority: "LOW",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  const notification = await prisma.inAppNotification.create({
    data: {
      eventKey: `p6-ui-notification-${randomUUID()}`,
      recipientAccountId: member.account.id,
      category: "TASK",
      title: "P6 UI 通知",
      summary: "这是一条用于验证通知中心的站内通知",
      entityType: "Task",
      entityId: draft.taskId,
      taskId: draft.taskId,
      linkPath: `/progress/tasks/${draft.taskId}`,
      payloadVersion: 1,
      payload: {},
    },
  });
  return {
    admin,
    owner,
    member,
    reviewer,
    outsider,
    inactiveHistory,
    taskId: draft.taskId,
    taskTitle,
    activeNodeId: activeNode.nodeId,
    confirmableSegmentId: confirmable.segment.id,
    movableSegmentId: movable.segment.id,
    inactiveHistorySegmentId: inactiveHistorySegment.segment.id,
    batchCancelableSegmentIds: [
      batchCancelableA.segment.id,
      batchCancelableB.segment.id,
    ] as const,
    brushCreateContent: `P6 UI 画布拖选创建 ${randomUUID()}`,
    mobileCreateContent: `P6 UI 移动端精确创建 ${randomUUID()}`,
    notificationId: notification.id,
  };
}

async function createDraftWorkbenchFixture() {
  const admin = await createAccountPerson("S6 Draft Team Admin");
  const owner = await createAccountPerson("S6 Draft Owner");
  const reviewer = await createAccountPerson("S6 Draft Reviewer");
  const taskTitle = `S6 Draft Workbench ${randomUUID()}`;
  const task = await createTaskDraft(actor(admin), {
    title: taskTitle,
    description: "S6 Draft 工作台测试",
    team: "英雄",
    techGroup: "电控",
    priority: "MEDIUM",
    tagIds: [],
    members: [
      { personId: owner.person.id, role: "OWNER" },
      { personId: reviewer.person.id, role: "PARTICIPANT" },
    ],
    milestones: [
      milestoneInput("S6 Draft 第一阶段", "完成第一阶段", 1),
      milestoneInput("S6 Draft 第二阶段", "完成第二阶段", 2),
    ],
    plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
    termination: terminationInput(5),
    idempotencyKey: `s6-draft-workbench-${randomUUID()}`,
  });
  return { admin, owner, reviewer, taskId: task.taskId, taskTitle };
}

async function createAccountPerson(displayName: string) {
  const openId = `ou_pm_p6_ui_${randomUUID()}`;
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
      person: {
        create: {
          displayName,
          status: "ACTIVE",
        },
      },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { account, person: account.person, openId };
}

async function grantRole(
  accountId: string,
  role: "PROJECT_ADMINISTRATOR",
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team: "",
      techGroup: "",
    },
  });
}

function actor(input: Awaited<ReturnType<typeof createAccountPerson>>): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles: [],
  };
}

function milestoneInput(goal: string, criteria: string, daysFromBase: number) {
  return {
    goal,
    completionCriteria: criteria,
    expectedCompletedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    reviewRequirements: "提交文本或链接证据",
    businessDescription: goal,
  };
}

function terminationInput(daysFromBase: number) {
  return {
    plannedOutcomeCriteria: "所有 Milestone 完成并完成总结",
    plannedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    businessDescription: "结束确认",
  };
}

function atHour(hour: number) {
  const fullHour = Math.trunc(hour);
  const minutes = Math.round((hour - fullHour) * 60);
  return new Date(Date.UTC(2026, 7, 10, fullHour, minutes, 0));
}
