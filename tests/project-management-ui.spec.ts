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
  scanConflictsForPerson,
} from "../lib/project-management/application/conflict-service";
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

  test("dashboard, Task workbench, resource timeline, conflicts and notifications work", async ({
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
    await expect(page.getByText(fixture.taskTitle)).toBeVisible();
    await expect(page.getByText("未读通知")).toBeVisible();
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
    if (testInfo.project.name === "desktop") {
      await page.goto(
        `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.reviewer.person.id}&zoom=hour`,
      );
      const emptyCanvasScroll = page.getByTestId("time-canvas-scroll");
      await emptyCanvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const emptyRow = page.getByLabel(`${fixture.reviewer.person.displayName} 时间行`, { exact: true });
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
      await brushCreate.getByLabel("Task").selectOption(fixture.taskId);
      await brushCreate.getByLabel("内容").fill(fixture.brushCreateContent);
      await brushCreate.getByRole("button", { name: "创建", exact: true }).click();
      await expect(page.getByText("已创建投入记录")).toBeVisible();
      await expect.poll(() => prisma.workSegment.count({
        where: {
          personId: fixture.reviewer.person.id,
          content: fixture.brushCreateContent,
        },
      })).toBe(1);
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

    await page.goto("/progress/resources/conflicts");
    await expect(page.getByRole("heading", { name: "资源冲突" })).toBeVisible();
    await expect(page.getByText("投入超过 100%").first()).toBeVisible();
    await page.getByRole("button", { name: "确认已知" }).click();
    await expect(page.getByText("已确认知晓该冲突")).toBeVisible();
    await expect
      .poll(async () => {
        return prisma.resourceConflict.count({
          where: {
            personId: fixture.member.person.id,
            status: "ACKNOWLEDGED",
          },
        });
      })
      .toBeGreaterThan(0);
    await expectHealthyPage(page);

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

  test("non-member cannot enumerate Task workbench", async ({
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
    await expect(
      page.getByRole("heading", { name: "页面不存在或无权访问" }),
    ).toBeVisible();
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
});

async function createUiFixture() {
  const admin = await createAccountPerson("P6 UI Team Admin");
  const owner = await createAccountPerson("P6 UI Owner");
  const member = await createAccountPerson("P6 UI Member");
  const reviewer = await createAccountPerson("P6 UI Reviewer");
  const outsider = await createAccountPerson("P6 UI Outsider");
  await grantRole(admin.account.id, "TEAM_ADMINISTRATOR", {
    team: "英雄",
    techGroup: "电控",
  });
  await grantRole(member.account.id, "TEAM_ADMINISTRATOR", {
    team: "英雄",
    techGroup: "电控",
  });
  await grantRole(member.account.id, "RESOURCE_MANAGER", {
    team: "英雄",
    techGroup: "电控",
  });
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
      { personId: member.person.id, role: "MEMBER" },
      { personId: reviewer.person.id, role: "REVIEWER" },
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
    allocation: 40,
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
    content: "P6 UI 冲突计划 A",
    allocation: 80,
    role: "DEVELOPER",
    priority: "MEDIUM",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  await createWorkSegment(actor(admin), {
    personId: owner.person.id,
    type: "PLANNED",
    startAt: atHour(8),
    endAt: atHour(9),
    content: "P6 UI 跨行目标人员安排",
    allocation: 30,
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
    content: "P6 UI 冲突计划 B",
    allocation: 50,
    role: "DEVELOPER",
    priority: "MEDIUM",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  const batchCancelableA = await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(12),
    endAt: atHour(13),
    content: "P6 UI 批量取消 A",
    allocation: 20,
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
    allocation: 20,
    role: "SUPPORT",
    priority: "LOW",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  await scanConflictsForPerson({
    personId: member.person.id,
    startAt: atHour(8),
    endAt: atHour(12),
  });
  const conflict = await prisma.resourceConflict.findFirstOrThrow({
    where: {
      personId: member.person.id,
      kind: "ALLOCATION_OVER_LIMIT",
      status: "OPEN",
    },
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
    taskId: draft.taskId,
    taskTitle,
    confirmableSegmentId: confirmable.segment.id,
    movableSegmentId: movable.segment.id,
    batchCancelableSegmentIds: [
      batchCancelableA.segment.id,
      batchCancelableB.segment.id,
    ] as const,
    brushCreateContent: `P6 UI 画布拖选创建 ${randomUUID()}`,
    mobileCreateContent: `P6 UI 移动端精确创建 ${randomUUID()}`,
    conflictId: conflict.id,
    notificationId: notification.id,
  };
}

async function createAccountPerson(displayName: string) {
  const openId = `ou_pm_p6_ui_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      status: "ACTIVE",
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
  role: "TEAM_ADMINISTRATOR" | "RESOURCE_MANAGER",
  scope: { team: string; techGroup: string },
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team: scope.team,
      techGroup: scope.techGroup,
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
