// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { revokeAccountRole } from "../lib/account-management";
import {
  completeProject,
  createProject,
  deleteProject,
  resubmitProject,
  reviewProjectEstablishment,
} from "../lib/project-management/application/project-service";
import { createRisk } from "../lib/project-management/application/collaboration-service";
import { toProjectManagementServiceError } from "../lib/project-management/application/errors";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import { formatDateTime } from "../lib/project-management/labels";
import { getActionInbox } from "../lib/project-management/queries/action-inbox-queries";
import { searchTaskOptions } from "../lib/project-management/queries/option-queries";
import {
  getProjectDetail,
  listProjects,
  locateProjectTimelineFocus,
} from "../lib/project-management/queries/project-queries";
import {
  getAdaptiveTimeCanvasBlock,
  getContentDrivenTimeCanvasData,
  resolveProjectTimelinePersonIds,
} from "../lib/project-management/queries/time-canvas-queries";
import {
  expectHealthyPage,
  expectThreeLayerDetailLayout,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

const projectDetailLayoutIds = {
  overview: "project-overview",
  timeline: "project-timeline-layer",
  lowerGrid: "project-detail-lower-grid",
  mainColumn: "project-detail-main-column",
  leftColumn: "project-detail-left-column",
  rightColumn: "project-detail-right-column",
} as const;

test.describe("Project 立项与生命周期", () => {
  test("Project 导航、默认筛选、列表和创建页在桌面与移动端可用", { tag: "@smoke" }, async ({ context, page, baseURL }, testInfo) => {
    const requester = await actor(`Project UI ${testInfo.project.name}`);
    const admin = await actor(`Project UI 管理员 ${testInfo.project.name}`, "PROJECT_ADMINISTRATOR");
    const participant = await actor(`Project UI Task 成员 ${testInfo.project.name}`);
    const selectableTask = await draftTask(
      requester,
      participant,
      `Project UI 已选 Task ${"很长的名称".repeat(18)}`,
    );
    const olderProjectIds = Array.from({ length: 51 }, () => randomUUID());
    const olderTimestamp = new Date(Date.now() - 60_000);
    await prisma.project.createMany({
      data: olderProjectIds.map((id, index) => ({
        id,
        name: `Project UI 分页草稿 ${index}`,
        description: "验证全部状态筛选在翻页时不会恢复为默认状态",
        status: "DRAFT",
        requesterAccountId: requester.accountId,
        submittedAt: olderTimestamp,
        createdAt: olderTimestamp,
        updatedAt: olderTimestamp,
      })),
    });
    await prisma.projectMember.createMany({
      data: olderProjectIds.map((projectId) => ({
        projectId,
        personId: requester.personId,
        role: "OWNER",
        createdByAccountId: requester.accountId,
      })),
    });
    const name = `Project UI ${randomUUID()}`;
    const created = await createProject(requester, { name, description: "用于验证 Project 列表和响应式创建页", avatarPath: null, members: [{ personId: requester.personId, role: "OWNER" }], requestedTaskIds: [], idempotencyKey: randomUUID() });
    const request = await prisma.projectEstablishmentRequest.findFirstOrThrow({ where: { projectId: created.projectId, status: "PENDING" } });
    await reviewProjectEstablishment(admin, { projectId: created.projectId, requestId: request.id, expectedLockVersion: 0, decision: "APPROVE", comment: "" });
    await loginAsTestUser(context, baseURL, { openId: requester.openId, name: `Project UI ${testInfo.project.name}` });
    await page.goto("/progress/projects");
    await expect(page.getByRole("heading", { name: "Project", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "只看我参与" })).toBeChecked();
    await expect(page.getByRole("combobox", { name: "Project 状态" })).toHaveValue("ACTIVE");
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    if (testInfo.project.name === "desktop") {
      const navigation = page.getByRole("navigation", { name: "项目管理导航" });
      const links = navigation.getByRole("link");
      await expect(links.nth(1)).toHaveAttribute("href", "/progress/projects");
      await expect(links.nth(2)).toHaveAttribute("href", "/progress/tasks");
    } else {
      await page.getByRole("button", { name: "打开项目管理导航" }).click();
      await expect(page.getByTestId("project-management-drawer").getByRole("link", { name: "Project" })).toHaveAttribute("aria-current", "page");
      await page.keyboard.press("Escape");
    }
    await expectHealthyPage(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole("combobox", { name: "Project 状态" }).selectOption("");
    await page.getByRole("button", { name: "筛选" }).click();
    await expect(page.getByRole("combobox", { name: "Project 状态" })).toHaveValue("");
    const nextProjectHref = await page.getByRole("link", { name: "下一页 Project" }).getAttribute("href");
    expect(nextProjectHref).not.toBeNull();
    const nextProjectUrl = new URL(nextProjectHref!, baseURL!);
    expect(nextProjectUrl.searchParams.has("status")).toBe(true);
    expect(nextProjectUrl.searchParams.get("status")).toBe("");
    await page.getByRole("link", { name: "提交立项" }).click();
    await expect(page).toHaveURL("/progress/projects/new");
    await expect(page.getByRole("heading", { name: "提交 Project 立项" })).toBeVisible();
    const submitProject = page.getByRole("button", { name: "提交立项" });
    const projectNameInput = page.getByLabel("Project 名称");
    const projectDescriptionInput = page.getByLabel("Project 内容");
    await expect(projectNameInput).not.toHaveAttribute("aria-invalid", "true");
    await submitProject.click();
    await expect(projectNameInput).toHaveAttribute("aria-invalid", "true");
    await expect(projectNameInput).toBeFocused();
    await expect(page.getByRole("alert").filter({ hasText: "请输入 Project 名称" })).toBeVisible();
    await projectNameInput.fill("响应式 Project 草稿");
    await expect(projectNameInput).not.toHaveAttribute("aria-invalid", "true");
    await projectDescriptionInput.fill("验证 Project 表单字段错误展示");
    await expect(projectDescriptionInput).not.toHaveAttribute("aria-invalid", "true");
    const taskSearch = page.getByRole("combobox", { name: "搜索可加入的 Task" });
    await taskSearch.fill(selectableTask.title);
    await page.getByRole("option", { name: new RegExp(selectableTask.title.slice(0, 30)) }).click();
    await expect(page.getByText("已选择 1 个 Task", { exact: true })).toBeVisible();
    const selectedTasks = page.getByRole("list", { name: "已选择的 Task" });
    await expect(selectedTasks).toContainText(selectableTask.title);
    await expect(selectedTasks.getByRole("button", { name: `移除${selectableTask.title}` })).toBeVisible();
    await expectHealthyPage(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("立项驳回空意见在桌面与移动端标红并聚焦", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    const requesterName = `Project 驳回校验申请人 ${testInfo.project.name}`;
    const requester = await actor(requesterName);
    const adminName = `Project 驳回校验管理员 ${testInfo.project.name}`;
    const admin = await actor(adminName, "PROJECT_ADMINISTRATOR");
    const participant = await actor(`Project 待审批 Task 成员 ${testInfo.project.name}`);
    const requestedTask = await draftTask(requester, participant, `立项待审批超长 Task ${"很长的名称".repeat(24)}`);
    const projectName = `Project 驳回字段校验 ${randomUUID()}`;
    const created = await createProject(requester, {
      name: projectName,
      description: "验证驳回意见的字段错误",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: [requestedTask.id],
      idempotencyKey: randomUUID(),
    });
    const emptyCreated = await createProject(requester, {
      name: `Project 空 Task 立项 ${randomUUID()}`,
      description: "验证当前立项申请的空 Task 状态",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: [],
      idempotencyKey: randomUUID(),
    });
    const request = await prisma.projectEstablishmentRequest.findFirstOrThrow({ where: { projectId: created.projectId, status: "PENDING" }, select: { id: true, submittedAt: true } });
    await loginAsTestUser(context, baseURL, {
      openId: admin.openId,
      name: adminName,
    });
    await page.goto(`/progress/projects/${created.projectId}`);

    const pendingRequest = page.getByTestId("project-pending-establishment");
    await expect(pendingRequest.getByRole("heading", { name: "当前立项申请" })).toBeVisible();
    await expect(pendingRequest.getByText("第 1 轮", { exact: true })).toBeVisible();
    await expect(pendingRequest.getByText(requesterName, { exact: true })).toBeVisible();
    await expect(pendingRequest.getByText(formatDateTime(request.submittedAt), { exact: true })).toBeVisible();
    const requestedTasks = pendingRequest.getByRole("list", { name: "本次立项申请的 Task" });
    await expect(requestedTasks.getByRole("link", { name: requestedTask.title, exact: true })).toBeVisible();
    await expect(requestedTasks.getByText("草稿", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "通过立项" })).toBeVisible();
    const comment = page.getByLabel("立项审批意见");
    await expect(comment).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "驳回", exact: true }).click();
    await expect(comment).toHaveAttribute("aria-invalid", "true");
    await expect(comment).toBeFocused();
    await expect(page.getByRole("alert").filter({ hasText: "驳回立项时请填写审批意见" })).toBeVisible();
    await comment.fill("已补充驳回意见");
    await expect(comment).not.toHaveAttribute("aria-invalid", "true");
    await expectHealthyPage(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

    await loginAsTestUser(context, baseURL, { openId: requester.openId, name: requesterName });
    await page.goto(`/progress/projects/${created.projectId}`);
    await expect(page.getByTestId("project-pending-establishment")).toContainText(requestedTask.title);
    await expect(page.getByRole("button", { name: "通过立项" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "驳回", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("立项审批意见")).toHaveCount(0);

    await reviewProjectEstablishment(admin, { projectId: created.projectId, requestId: request.id, expectedLockVersion: 0, decision: "REJECT", comment: "第一轮信息需补充" });
    const secondRequestedTask = await draftTask(requester, participant, `立项第二轮 Task ${randomUUID()}`);
    const resubmitted = await resubmitProject(requester, {
      projectId: created.projectId,
      expectedLockVersion: 1,
      name: projectName,
      description: "已补充第二轮立项信息",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: [secondRequestedTask.id],
      idempotencyKey: randomUUID(),
    });
    const secondRequest = await prisma.projectEstablishmentRequest.findUniqueOrThrow({ where: { id: resubmitted.requestId }, select: { submittedAt: true } });

    await page.reload();
    const requesterSecondRequest = page.getByTestId("project-pending-establishment");
    await expect(requesterSecondRequest.getByText("第 2 轮", { exact: true })).toBeVisible();
    await expect(requesterSecondRequest).toContainText(secondRequestedTask.title);
    await expect(requesterSecondRequest.getByText(requestedTask.title, { exact: true })).toHaveCount(0);

    await loginAsTestUser(context, baseURL, { openId: admin.openId, name: adminName });
    await page.goto(`/progress/projects/${created.projectId}`);
    const adminSecondRequest = page.getByTestId("project-pending-establishment");
    await expect(adminSecondRequest).toContainText(secondRequestedTask.title);
    await expect(adminSecondRequest.getByText(formatDateTime(secondRequest.submittedAt), { exact: true })).toBeVisible();
    await reviewProjectEstablishment(admin, { projectId: created.projectId, requestId: resubmitted.requestId, expectedLockVersion: 2, decision: "APPROVE", comment: "第二轮信息完整" });
    await page.reload();
    await expect(page.getByTestId("project-pending-establishment")).toHaveCount(0);

    await page.goto(`/progress/projects/${emptyCreated.projectId}`);
    const emptyPendingRequest = page.getByTestId("project-pending-establishment");
    await expect(emptyPendingRequest).toContainText("本次立项未申请加入 Task。");
    await expect(emptyPendingRequest.getByRole("list", { name: "本次立项申请的 Task" })).toHaveCount(0);
    await expectHealthyPage(page);
  });

  test("Project 详情使用概览、全宽时间线和三列协作区", async ({
    browser,
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const requester = await actor(`Project 详情申请人 ${randomUUID()}`);
    const admin = await actor(
      `Project 详情管理员 ${randomUUID()}`,
      "PROJECT_ADMINISTRATOR",
    );
    const participant = await actor("超长人员".repeat(64));
    const viewer = await actor(`Project 详情只读用户 ${randomUUID()}`);
    const draft = await draftTask(
      requester,
      participant,
      "草".repeat(200),
    );
    const active = await draftTask(requester, participant, "进行中 Task 时间线");
    const completed = await draftTask(requester, participant, "已完成 Task 时间线");
    const farTask = await draftTask(
      requester,
      participant,
      "初始加载范围外 Task 时间线",
    );
    const farTaskStart = new Date("2032-01-08T09:00:00+08:00");
    await prisma.taskPlanVersion.updateMany({
      where: { taskId: farTask.id },
      data: { plannedStartAt: farTaskStart },
    });
    const activePlanNodes = await addTaskPlanNodes(
      active.id,
      requester,
      "进行中节点",
    );
    const completedPlanNodes = await addTaskPlanNodes(
      completed.id,
      requester,
      "已完成节点",
    );

    const projectName = "项".repeat(200);
    const projectDescription = "描".repeat(8_000);
    const created = await createProject(requester, {
      name: projectName,
      description: projectDescription,
      avatarPath: null,
      members: [
        { personId: requester.personId, role: "OWNER" },
        { personId: participant.personId, role: "PARTICIPANT" },
      ],
      requestedTaskIds: [completed.id, active.id, draft.id, farTask.id],
      idempotencyKey: randomUUID(),
    });
    const request = await prisma.projectEstablishmentRequest.findFirstOrThrow({
      where: { projectId: created.projectId, status: "PENDING" },
    });
    await reviewProjectEstablishment(admin, {
      projectId: created.projectId,
      requestId: request.id,
      expectedLockVersion: created.lockVersion,
      decision: "APPROVE",
      comment: "同意详情页回归项目",
    });
    const visibleProjectRisk = `旁观者可见 Project 风险 ${randomUUID()}`;
    await createRisk(requester, {
      targetType: "PROJECT",
      targetId: created.projectId,
      content: visibleProjectRisk,
    });
    await prisma.task.update({
      where: { id: active.id },
      data: {
        status: "ACTIVE",
        activeMilestoneNodeId: activePlanNodes.milestoneNodeId,
      },
    });
    await prisma.taskNode.update({
      where: { id: activePlanNodes.milestoneNodeId },
      data: { status: "ACTIVE" },
    });
    await prisma.task.update({
      where: { id: completed.id },
      data: { status: "COMPLETED" },
    });
    await prisma.taskNode.updateMany({
      where: {
        id: {
          in: [
            completedPlanNodes.milestoneNodeId,
            completedPlanNodes.terminationNodeId,
          ],
        },
      },
      data: { status: "COMPLETED" },
    });
    const externalTask = await draftTask(
      requester,
      participant,
      "Project 外部 Task 投入",
    );
    const inactiveMember = await actor(`Project 停用空成员 ${randomUUID()}`);
    await prisma.taskMember.create({
      data: {
        taskId: active.id,
        personId: inactiveMember.personId,
        role: "PARTICIPANT",
        createdByAccountId: requester.accountId,
      },
    });
    await prisma.person.update({
      where: { id: inactiveMember.personId },
      data: { status: "INACTIVE" },
    });
    await expect(resolveProjectTimelinePersonIds({
      actor: requester,
      personIds: [participant.personId, inactiveMember.personId],
    })).resolves.toEqual([participant.personId]);
    const [projectTaskSegment, externalTaskSegment, independentSegment, unrelatedSegment] =
      await Promise.all([
        prisma.workSegment.create({
          data: {
            personId: participant.personId,
            taskId: active.id,
            type: "PLANNED",
            status: "PLANNED",
            startAt: new Date("2026-08-09T09:00:00+08:00"),
            endAt: new Date("2026-08-09T11:00:00+08:00"),
            content: "Project 内 Task 投入",
            expectedOutput: "Project 内产出",
            createdByAccountId: requester.accountId,
          },
        }),
        prisma.workSegment.create({
          data: {
            personId: participant.personId,
            taskId: externalTask.id,
            type: "PLANNED",
            status: "PLANNED",
            startAt: new Date("2026-08-09T12:00:00+08:00"),
            endAt: new Date("2026-08-09T14:00:00+08:00"),
            content: "Project 成员外部 Task 投入",
            expectedOutput: "外部 Task 产出",
            createdByAccountId: requester.accountId,
          },
        }),
        prisma.workSegment.create({
          data: {
            personId: participant.personId,
            type: "PLANNED",
            status: "PLANNED",
            startAt: new Date("2026-08-09T15:00:00+08:00"),
            endAt: new Date("2026-08-09T17:00:00+08:00"),
            content: "Project 成员独立投入",
            expectedOutput: "独立产出",
            createdByAccountId: requester.accountId,
          },
        }),
        prisma.workSegment.create({
          data: {
            personId: viewer.personId,
            type: "PLANNED",
            status: "PLANNED",
            startAt: new Date("2026-08-09T09:00:00+08:00"),
            endAt: new Date("2026-08-09T10:00:00+08:00"),
            content: "非 Project 成员投入",
            expectedOutput: "不应展示",
            createdByAccountId: viewer.accountId,
          },
        }),
      ]);

    await loginAsTestUser(context, baseURL, {
      openId: requester.openId,
      name: "Project 详情申请人",
    });
    await page.goto(`/progress/projects/${created.projectId}`);

    await expect(page.getByTestId("project-overview")).toBeVisible();
    await expect(
      page
        .getByTestId("project-management-command-bar")
        .getByRole("heading", { name: "Project 详情", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
    await expect(page.getByText(projectDescription, { exact: true })).toBeVisible();
    await expect(page.getByText(requester.personId, { exact: true })).toHaveCount(0);
    await expect(page.getByText("Task 完成进度", { exact: true })).toBeVisible();
    await expect(page.getByText("1/4 已完成", { exact: true })).toHaveCount(2);
    await expect(page.getByRole("link", { name: "编辑" })).toBeVisible();
    await expect(page.getByRole("button", { name: "结束 Project" })).toBeVisible();
    await expect(page.getByRole("button", { name: "删除 Project" })).toBeVisible();
    await expect(page.getByRole("button", { name: "复制链接" })).toBeVisible();

    await expect(
      page.getByRole("heading", { name: "Project 风险", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Project 评论", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
    await expect(page.getByText("立项申请", { exact: true })).toHaveCount(0);
    await expect(page.getByText("最近审计记录", { exact: true })).toHaveCount(0);
    await expect(page.locator("#establishment")).toBeVisible();
    await expect(page.getByTestId("project-timeline-layer")).toBeVisible();
    await expect(page.getByTestId("project-detail-lower-grid")).toBeVisible();
    await expect(page.getByTestId("project-detail-main-column")).toBeVisible();
    await expect(page.getByTestId("project-detail-left-column")).toBeVisible();
    await expect(page.getByTestId("project-detail-right-column")).toBeVisible();

    await expectThreeLayerDetailLayout(
      page,
      projectDetailLayoutIds,
      testInfo.project.name === "desktop" ? "columns" : "stacked",
    );
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 1279, height: 1000 });
      await expectThreeLayerDetailLayout(page, projectDetailLayoutIds, "stacked");
      await page.setViewportSize({ width: 1280, height: 1000 });
      await expectThreeLayerDetailLayout(page, projectDetailLayoutIds, "columns");
      await page.setViewportSize({ width: 1440, height: 1000 });
      await expectThreeLayerDetailLayout(page, projectDetailLayoutIds, "columns");
    } else {
      const canvasScroll = page.getByTestId("time-canvas-scroll");
      const initialScroll = await canvasScroll.evaluate((element) => ({
        left: element.scrollLeft,
        maximum: element.scrollWidth - element.clientWidth,
      }));
      expect(initialScroll.maximum).toBeGreaterThan(1);
      await canvasScroll.evaluate((element) => {
        const maximum = element.scrollWidth - element.clientWidth;
        element.scrollLeft = element.scrollLeft < maximum
          ? Math.min(maximum, element.scrollLeft + 50)
          : Math.max(0, element.scrollLeft - 50);
        element.dispatchEvent(new Event("scroll"));
      });
      await expect
        .poll(() => canvasScroll.evaluate((element) => element.scrollLeft))
        .not.toBe(initialScroll.left);
    }

    const draftGroup = page.getByTestId("project-task-group-DRAFT");
    const activeGroup = page.getByTestId("project-task-group-ACTIVE");
    const completedGroup = page.getByTestId("project-task-group-COMPLETED");
    const draftToggle = draftGroup.getByRole("button", {
      name: "展开草稿 Task 列表",
    });
    const activeToggle = activeGroup.getByRole("button", {
      name: "收起进行中 Task 列表",
    });
    const completedToggle = completedGroup.getByRole("button", {
      name: "展开已完成 Task 列表",
    });
    await expect(draftToggle).toHaveAttribute("aria-expanded", "false");
    await expect(activeToggle).toHaveAttribute("aria-expanded", "true");
    await expect(completedToggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("table", { name: "草稿 Task 列表" })).toHaveCount(0);
    await expect(page.getByRole("table", { name: "进行中 Task 列表" })).toBeVisible();
    await expect(page.getByRole("table", { name: "已完成 Task 列表" })).toHaveCount(0);
    await expect(page.getByTestId("project-task-group-ratio-DRAFT")).toHaveText("已展示 0/2");
    await expect(page.getByTestId("project-task-group-ratio-ACTIVE")).toHaveText("已展示 1/1");
    await expect(page.getByTestId("project-task-group-ratio-COMPLETED")).toHaveText("已展示 0/1");
    await expect(
      page.getByRole("checkbox", { name: `在时间线中显示 ${active.title}` }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "显示全部进行中 Task 时间线" }),
    ).toBeChecked();
    await expect(page.getByText("已展示 1/4 个 Project Task 计划", { exact: false })).toBeVisible();
    await expect(page.getByTestId(`timeline-row-project-plan:${draft.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`timeline-row-project-plan:${farTask.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`timeline-row-project-plan:${active.id}`)).toBeVisible();
    await expect(page.getByTestId(`timeline-row-project-plan:${completed.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`timeline-row-person:${inactiveMember.personId}`)).toHaveCount(0);
    await expect(page.locator('[data-testid^="timeline-row-plan:"]')).toHaveCount(0);
    await expect(page.getByTestId(`timeline-row-project-plan:${externalTask.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`segment-block-${projectTaskSegment.id}`)).toHaveAttribute(
      "title",
      new RegExp(`Task：${active.title}`),
    );
    await expect(page.getByTestId(`segment-block-${externalTaskSegment.id}`)).toHaveAttribute(
      "title",
      new RegExp(`Task：${externalTask.title}`),
    );
    await expect(page.getByTestId(`segment-block-${independentSegment.id}`)).toHaveAttribute(
      "title",
      /Task：独立投入/,
    );
    await expect(page.getByTestId(`segment-block-${unrelatedSegment.id}`)).toHaveCount(0);

    await draftToggle.click();
    const draftTable = page.getByRole("table", { name: "草稿 Task 列表" });
    await expect(draftTable.getByRole("link", { name: draft.title, exact: true })).toBeVisible();
    await expect(draftTable.getByRole("link", { name: farTask.title, exact: true })).toBeVisible();
    const draftCheckbox = page.getByRole("checkbox", {
      name: `在时间线中显示 ${draft.title}`,
    });
    const farTaskCheckbox = page.getByRole("checkbox", {
      name: `在时间线中显示 ${farTask.title}`,
    });
    const allDraftCheckbox = page.getByRole("checkbox", {
      name: "显示全部草稿 Task 时间线",
    });
    await expect(draftCheckbox).not.toBeChecked();
    await expect(farTaskCheckbox).not.toBeChecked();
    await draftCheckbox.check();
    await expect(page.getByTestId("project-task-group-ratio-DRAFT")).toHaveText("已展示 1/2");
    await expect(allDraftCheckbox).toHaveAttribute("aria-checked", "mixed");
    await expect(page.getByTestId(`timeline-row-project-plan:${draft.id}`)).toBeVisible();
    await draftGroup.getByRole("button", { name: "收起草稿 Task 列表" }).click();
    await expect(draftTable).toHaveCount(0);
    await expect(page.getByTestId(`timeline-row-project-plan:${draft.id}`)).toBeVisible();
    await draftGroup.getByRole("button", { name: "展开草稿 Task 列表" }).click();
    await allDraftCheckbox.check();
    await expect(page.getByTestId("project-task-group-ratio-DRAFT")).toHaveText("已展示 2/2");
    await expect(farTaskCheckbox).toBeChecked();
    await expect(page.getByTestId(`timeline-row-project-plan:${farTask.id}`)).toBeVisible();

    await activeToggle.click();
    await expect(page.getByRole("table", { name: "进行中 Task 列表" })).toHaveCount(0);
    await expect(page.getByTestId(`timeline-row-project-plan:${active.id}`)).toBeVisible();
    await activeGroup.getByRole("button", { name: "展开进行中 Task 列表" }).click();

    await completedToggle.click();
    const completedCheckbox = page.getByRole("checkbox", {
      name: `在时间线中显示 ${completed.title}`,
    });
    await expect(completedCheckbox).not.toBeChecked();
    await completedCheckbox.check();
    await expect(page.getByTestId("project-task-group-ratio-COMPLETED")).toHaveText("已展示 1/1");
    await expect(page.getByTestId(`timeline-row-project-plan:${completed.id}`)).toBeVisible();
    await expect(
      page.getByTestId(
        `milestone-marker-project-node:${completedPlanNodes.milestoneNodeId}`,
      ),
    ).toHaveAttribute("data-anchor-completed", "true");
    await expect(
      page.getByTestId(
        `milestone-marker-project-node:${completedPlanNodes.milestoneNodeId}`,
      ),
    ).toHaveAttribute("data-anchor-icon", "CHECK");
    await expect(
      page.getByTestId(
        `milestone-marker-project-node:${activePlanNodes.milestoneNodeId}`,
      ),
    ).toHaveAttribute("data-anchor-completed", "false");
    await expect(
      page.getByTestId(
        `milestone-marker-project-node:${activePlanNodes.milestoneNodeId}`,
      ),
    ).toHaveAttribute("data-anchor-icon", "CIRCLE");
    const locateActive = page.getByRole("button", {
      name: `在时间线中定位 ${active.title}`,
    });
    await locateActive.click();
    await expect(locateActive).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByTestId(
        `milestone-marker-project-node:${activePlanNodes.milestoneNodeId}`,
      ),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByTestId(
        `milestone-marker-project-node:${activePlanNodes.milestoneNodeId}`,
      ),
    ).toBeFocused();
    await expect(page.getByTestId("project-timeline-layer")).toBeInViewport();
    await expect(
      page.getByTestId(`milestone-marker-project-start:${active.id}`),
    ).toHaveAttribute("aria-pressed", "false");

    const locateFarTask = page.getByRole("button", {
      name: `在时间线中定位 ${farTask.title}`,
    });
    await locateFarTask.click();
    await expect.poll(() => {
      const url = new URL(page.url());
      return {
        focus: url.searchParams.get("focus"),
        center: url.searchParams.get("center"),
      };
    }).toEqual({
      focus: `project-start:${farTask.id}`,
      center: farTaskStart.toISOString(),
    });
    const farTaskMarker = page.getByTestId(
      `milestone-marker-project-start:${farTask.id}`,
    );
    await expect(farTaskMarker).toHaveAttribute("aria-pressed", "true");
    await expect(farTaskMarker).toBeFocused();
    await expect(page.getByTestId("project-timeline-layer")).toBeInViewport();

    await expectHealthyPage(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    const deepLinkPage = await context.newPage();
    const deepLinkPageErrors: string[] = [];
    deepLinkPage.on("pageerror", (error) => deepLinkPageErrors.push(error.message));
    try {
      await deepLinkPage.goto(
        `/progress/projects/${created.projectId}?focus=${encodeURIComponent(`project-start:${farTask.id}`)}`,
      );
      const focusedDraftGroup = deepLinkPage.getByTestId("project-task-group-DRAFT");
      await expect(
        focusedDraftGroup.getByRole("button", { name: "收起草稿 Task 列表" }),
      ).toHaveAttribute("aria-expanded", "true");
      const focusedDraftCheckbox = deepLinkPage.getByRole("checkbox", {
        name: `在时间线中显示 ${draft.title}`,
      });
      const focusedFarTaskCheckbox = deepLinkPage.getByRole("checkbox", {
        name: `在时间线中显示 ${farTask.title}`,
      });
      const focusedAllDraftCheckbox = deepLinkPage.getByRole("checkbox", {
        name: "显示全部草稿 Task 时间线",
      });
      await expect(focusedDraftCheckbox).not.toBeChecked();
      await expect(focusedFarTaskCheckbox).toBeChecked();
      await expect(focusedAllDraftCheckbox).toHaveAttribute("aria-checked", "mixed");
      await expect(
        deepLinkPage.getByRole("checkbox", {
          name: `在时间线中显示 ${active.title}`,
        }),
      ).toBeChecked();
      await expect(
        deepLinkPage.getByTestId(`timeline-row-project-plan:${farTask.id}`),
      ).toBeVisible();

      await focusedAllDraftCheckbox.check();
      await expect(focusedDraftCheckbox).toBeChecked();
      await focusedAllDraftCheckbox.uncheck();
      await expect(
        deepLinkPage.getByTestId("project-task-group-ratio-DRAFT"),
      ).toHaveText("已展示 0/2");
      await focusedDraftGroup
        .getByRole("button", { name: "收起草稿 Task 列表" })
        .click();

      const refreshComment = `刷新后保留时间线选择 ${randomUUID()}`;
      await deepLinkPage.getByLabel("发表评论").fill(refreshComment);
      await deepLinkPage.getByRole("button", { name: "发布评论" }).click();
      await expect(deepLinkPage.getByText(refreshComment, { exact: true })).toBeVisible();
      await expect(
        focusedDraftGroup.getByRole("button", { name: "展开草稿 Task 列表" }),
      ).toHaveAttribute("aria-expanded", "false");
      await expect(
        deepLinkPage.getByTestId("project-task-group-ratio-DRAFT"),
      ).toHaveText("已展示 0/2");
      await expect(
        deepLinkPage.getByTestId(`timeline-row-project-plan:${farTask.id}`),
      ).toHaveCount(0);
      await expect(
        deepLinkPage.getByTestId(`timeline-row-project-plan:${active.id}`),
      ).toBeVisible();
      await expectHealthyPage(deepLinkPage);
      expect(deepLinkPageErrors).toEqual([]);
    } finally {
      await deepLinkPage.close();
    }

    const viewerContext = await browser.newContext({
      viewport: page.viewportSize() ?? { width: 1440, height: 1000 },
    });
    try {
      await loginAsTestUser(viewerContext, baseURL, {
        openId: viewer.openId,
        name: "Project 详情只读用户",
      });
      const viewerPage = await viewerContext.newPage();
      const viewerPageErrors: string[] = [];
      viewerPage.on("pageerror", (error) => viewerPageErrors.push(error.message));
      await viewerPage.goto(`/progress/projects/${created.projectId}`);
      await expect(viewerPage.getByTestId("project-overview")).toBeVisible();
      await expectThreeLayerDetailLayout(
        viewerPage,
        projectDetailLayoutIds,
        testInfo.project.name === "desktop" ? "columns" : "stacked",
      );
      await expect(
        viewerPage.getByRole("heading", { name: "Project 风险", exact: true }),
      ).toBeVisible();
      await expect(
        viewerPage.getByRole("heading", { name: "Project 评论", exact: true }),
      ).toBeVisible();
      await expect(
        viewerPage.getByRole("heading", { name: "近期动态", exact: true }),
      ).toBeVisible();
      await expect(
        viewerPage
          .getByTestId("project-detail-left-column")
          .getByText(visibleProjectRisk, { exact: true }),
      ).toBeVisible();
      await expect(viewerPage.getByRole("link", { name: "编辑" })).toHaveCount(0);
      await expect(
        viewerPage.getByRole("button", { name: "结束 Project" }),
      ).toHaveCount(0);
      await expect(
        viewerPage.getByRole("button", { name: "删除 Project" }),
      ).toHaveCount(0);
      await expect(
        viewerPage.getByRole("button", { name: "复制链接" }),
      ).toBeVisible();
      await expect(
        viewerPage.getByRole("button", { name: "提出风险", exact: true }),
      ).toHaveCount(0);
      await expect(
        viewerPage.getByRole("button", { name: "解决风险", exact: true }),
      ).toHaveCount(0);
      const viewerComment = viewerPage.getByLabel("发表评论");
      await expect(viewerComment).toBeEnabled();
      await viewerComment.fill("旁观者仍可发表评论");
      await expect(
        viewerPage.getByRole("button", { name: "发布评论", exact: true }),
      ).toBeEnabled();
      await expectHealthyPage(viewerPage);
      expect(viewerPageErrors).toEqual([]);
    } finally {
      await viewerContext.close();
    }
    expect(pageErrors).toEqual([]);
  });

  test("空 Project 可以直接结束并记录审计与通知", async ({ context, page, baseURL }, testInfo) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const requester = await actor(`空 Project 申请人 ${testInfo.project.name}`);
    const admin = await actor(`空 Project 管理员 ${testInfo.project.name}`, "PROJECT_ADMINISTRATOR");
    const created = await createProject(requester, {
      name: `空 Project ${randomUUID()}`,
      description: "验证没有 Task 时仍可结束",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: [],
      idempotencyKey: randomUUID(),
    });
    const request = await prisma.projectEstablishmentRequest.findFirstOrThrow({
      where: { projectId: created.projectId, status: "PENDING" },
    });
    const approved = await reviewProjectEstablishment(admin, {
      projectId: created.projectId,
      requestId: request.id,
      expectedLockVersion: created.lockVersion,
      decision: "APPROVE",
      comment: "",
    });

    await loginAsTestUser(context, baseURL, {
      openId: requester.openId,
      name: `空 Project 申请人 ${testInfo.project.name}`,
    });
    await page.goto(`/progress/projects/${created.projectId}`);
    await expect(page.getByTestId("project-timeline-layer")).toBeVisible();
    await expect(page.getByTestId("project-detail-lower-grid")).toBeVisible();
    await expect(page.getByText("尚未关联 Task", { exact: true })).toBeVisible();
    await expectThreeLayerDetailLayout(
      page,
      projectDetailLayoutIds,
      testInfo.project.name === "desktop" ? "columns" : "stacked",
    );
    await page.getByRole("button", { name: "结束 Project" }).click();
    const dialog = page.getByRole("dialog", { name: "结束 Project" });
    await expect(dialog).toContainText("当前没有关联 Task。");
    await expect(dialog.getByRole("button", { name: "确认结束" })).toBeEnabled();
    await dialog.getByRole("button", { name: "确认结束" }).click();

    await expect(page.getByText("已结束", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        prisma.project.findUnique({
          where: { id: created.projectId },
          select: { status: true, completedAt: true, lockVersion: true },
        }),
      )
      .toMatchObject({
        status: "COMPLETED",
        completedAt: expect.any(Date),
        lockVersion: approved.lockVersion + 1,
      });
    const audit = await prisma.domainAuditEvent.findFirstOrThrow({
      where: {
        projectId: created.projectId,
        action: "pm.project.complete",
      },
    });
    expect(audit.after).toMatchObject({ status: "COMPLETED", taskCount: 0 });
    const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: {
        eventKey: `pm:project:${created.projectId}:project_completed:${approved.lockVersion + 1}:feishu`,
      },
    });
    expect(outbox).toMatchObject({
      channel: "project-management",
      botKind: "notification",
      type: "project_completed",
    });
    expect(JSON.parse(outbox.payload)).toMatchObject({
      kind: "project_completed",
      linkPath: `/progress/projects/${created.projectId}`,
      context: { taskCount: 0 },
    });
    await expectHealthyPage(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test("只有草稿和进行中 Task 阻止 Project 结束", async ({ context, page, baseURL }, testInfo) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const requester = await actor(`Project 结束门禁申请人 ${testInfo.project.name}`);
    const participant = await actor(`Project 结束门禁成员 ${testInfo.project.name}`);
    const admin = await actor(
      `Project 结束门禁管理员 ${testInfo.project.name}`,
      "PROJECT_ADMINISTRATOR",
    );
    const taskCases = [
      { status: "DRAFT", title: "草稿阻塞 Task", deleted: false },
      { status: "ACTIVE", title: "进行中阻塞 Task", deleted: false },
      { status: "COMPLETED", title: "成功完成终态 Task", deleted: false },
      { status: "FAILED", title: "失败结束终态 Task", deleted: false },
      { status: "CANCELLED", title: "取消终态 Task", deleted: false },
      { status: "TIMEOUT", title: "超时终态 Task", deleted: false },
      { status: "ARCHIVED", title: "归档终态 Task", deleted: false },
      { status: "DRAFT", title: "已软删除草稿 Task", deleted: true },
    ] as const;
    const taskFixtures = await Promise.all(
      taskCases.map(async (taskCase) => ({
        ...taskCase,
        task: await draftTask(
          requester,
          participant,
          `${taskCase.title} ${testInfo.project.name}`,
        ),
      })),
    );
    const created = await createProject(requester, {
      name: `Project 结束门禁 ${randomUUID()}`,
      description: "验证只有草稿和进行中 Task 阻止 Project 结束",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: taskFixtures.map((fixture) => fixture.task.id),
      idempotencyKey: randomUUID(),
    });
    const request = await prisma.projectEstablishmentRequest.findFirstOrThrow({
      where: { projectId: created.projectId, status: "PENDING" },
    });
    const approved = await reviewProjectEstablishment(admin, {
      projectId: created.projectId,
      requestId: request.id,
      expectedLockVersion: created.lockVersion,
      decision: "APPROVE",
      comment: "同意结束门禁回归",
    });
    await Promise.all(
      taskFixtures.map((fixture) =>
        prisma.task.update({
          where: { id: fixture.task.id },
          data: {
            status: fixture.status,
            ...(fixture.deleted ? { deletedAt: new Date() } : {}),
          },
        }),
      ),
    );

    const blockedDetail = await getProjectDetail({
      actor: requester,
      projectId: created.projectId,
    });
    expect(blockedDetail).toMatchObject({
      taskTotalCount: 7,
      completionTaskTotalCount: 6,
      completedTaskTotalCount: 1,
      blockingTaskTotalCount: 2,
    });
    expect(blockedDetail.blockingTasks).toHaveLength(2);
    expect(new Set(blockedDetail.blockingTasks.map((task) => task.status))).toEqual(
      new Set(["DRAFT", "ACTIVE"]),
    );
    await expect(
      completeProject(requester, {
        projectId: created.projectId,
        expectedLockVersion: approved.lockVersion,
      }).catch((error) => {
        throw toProjectManagementServiceError(error);
      }),
    ).rejects.toMatchObject({
      code: "STATE_CONFLICT",
      message: expect.stringContaining("2 个 Task 处于草稿或进行中"),
    });
    expect(await prisma.project.findUniqueOrThrow({
      where: { id: created.projectId },
      select: { status: true, completedAt: true, lockVersion: true },
    })).toEqual({
      status: "ACTIVE",
      completedAt: null,
      lockVersion: approved.lockVersion,
    });
    expect(await prisma.domainAuditEvent.count({
      where: { projectId: created.projectId, action: "pm.project.complete" },
    })).toBe(0);
    expect(await prisma.notificationOutbox.count({
      where: { eventKey: { startsWith: `pm:project:${created.projectId}:project_completed:` } },
    })).toBe(0);

    await loginAsTestUser(context, baseURL, {
      openId: requester.openId,
      name: `Project 结束门禁申请人 ${testInfo.project.name}`,
    });
    await page.goto(`/progress/projects/${created.projectId}`);
    await expect(page.getByText("1/6 已完成", { exact: true })).toHaveCount(2);
    for (const [status, label] of [
      ["DRAFT", "草稿"],
      ["ACTIVE", "进行中"],
      ["COMPLETED", "已完成"],
      ["FAILED", "失败结束"],
      ["CANCELLED", "已取消"],
      ["TIMEOUT", "已超时"],
      ["ARCHIVED", "已归档"],
    ] as const) {
      const expanded = status === "ACTIVE";
      const group = page.getByTestId(`project-task-group-${status}`);
      await expect(group).toBeVisible();
      await expect(
        group.getByRole("button", {
          name: `${expanded ? "收起" : "展开"}${label} Task 列表`,
        }),
      ).toHaveAttribute("aria-expanded", String(expanded));
      await expect(
        page.getByTestId(`project-task-group-ratio-${status}`),
      ).toHaveText(`已展示 ${expanded ? 1 : 0}/1`);
    }
    await page.getByRole("button", { name: "结束 Project" }).click();
    let dialog = page.getByRole("dialog", { name: "结束 Project" });
    await expect(dialog).toContainText("仍有 2 个 Task 处于草稿或进行中，暂时不能结束 Project。");
    for (const fixture of taskFixtures.filter((item) => !item.deleted && ["DRAFT", "ACTIVE"].includes(item.status))) {
      await expect(dialog.getByText(fixture.task.title, { exact: true })).toBeVisible();
    }
    for (const fixture of taskFixtures.filter((item) => item.deleted || !["DRAFT", "ACTIVE"].includes(item.status))) {
      await expect(dialog.getByText(fixture.task.title, { exact: true })).toHaveCount(0);
    }
    await expect(dialog.getByRole("button", { name: "确认结束" })).toBeDisabled();
    await dialog.getByRole("button", { name: "取消" }).click();

    const draftBlocker = taskFixtures.find((fixture) => fixture.status === "DRAFT" && !fixture.deleted)!;
    const activeBlocker = taskFixtures.find((fixture) => fixture.status === "ACTIVE")!;
    await Promise.all([
      prisma.task.update({ where: { id: draftBlocker.task.id }, data: { status: "CANCELLED" } }),
      prisma.task.update({ where: { id: activeBlocker.task.id }, data: { status: "FAILED" } }),
    ]);
    const terminalOnlyDetail = await getProjectDetail({
      actor: requester,
      projectId: created.projectId,
    });
    expect(terminalOnlyDetail).toMatchObject({
      taskTotalCount: 7,
      completionTaskTotalCount: 5,
      completedTaskTotalCount: 1,
      blockingTaskTotalCount: 0,
      blockingTasks: [],
    });

    await page.reload();
    await expect(page.getByText("1/5 已完成", { exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: "结束 Project" }).click();
    dialog = page.getByRole("dialog", { name: "结束 Project" });
    await expect(dialog).toContainText("确认结束 Project？结束后 Project 资料、成员和 Task 归属将变为只读。");
    await expect(dialog.getByRole("button", { name: "确认结束" })).toBeEnabled();
    await dialog.getByRole("button", { name: "确认结束" }).click();

    await expect(page.getByText("已结束", { exact: true })).toBeVisible();
    await expect.poll(() => prisma.project.findUnique({
      where: { id: created.projectId },
      select: { status: true, completedAt: true, lockVersion: true },
    })).toMatchObject({
      status: "COMPLETED",
      completedAt: expect.any(Date),
      lockVersion: approved.lockVersion + 1,
    });
    const audit = await prisma.domainAuditEvent.findFirstOrThrow({
      where: { projectId: created.projectId, action: "pm.project.complete" },
    });
    expect(audit.after).toMatchObject({ status: "COMPLETED", taskCount: 7 });
    const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: {
        eventKey: `pm:project:${created.projectId}:project_completed:${approved.lockVersion + 1}:feishu`,
      },
    });
    expect(outbox).toMatchObject({
      channel: "project-management",
      botKind: "notification",
      type: "project_completed",
    });
    expect(JSON.parse(outbox.payload)).toMatchObject({
      kind: "project_completed",
      context: { taskCount: 7 },
    });
    await expectHealthyPage(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test("Project 时间线节点超限时保留三层结构", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "节点预算错误只需在桌面 fixture 覆盖一次");
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const requester = await actor(`Project 超限申请人 ${randomUUID()}`);
    const admin = await actor(
      `Project 超限管理员 ${randomUUID()}`,
      "PROJECT_ADMINISTRATOR",
    );
    const participant = await actor(`Project 超限成员 ${randomUUID()}`);
    const task = await draftTask(requester, participant, "Project 超过节点预算 Task");
    const created = await createProject(requester, {
      name: `Project 时间线超限 ${randomUUID()}`,
      description: "验证时间线错误仍位于第二层，且第三层保持可用",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: [task.id],
      idempotencyKey: randomUUID(),
    });
    const request = await prisma.projectEstablishmentRequest.findFirstOrThrow({
      where: { projectId: created.projectId, status: "PENDING" },
    });
    await reviewProjectEstablishment(admin, {
      projectId: created.projectId,
      requestId: request.id,
      expectedLockVersion: created.lockVersion,
      decision: "APPROVE",
      comment: "批准节点预算错误回归 fixture",
    });
    const plan = await prisma.taskPlanVersion.findFirstOrThrow({
      where: { taskId: task.id, status: "CURRENT" },
      select: { id: true },
    });
    const nodeIds = Array.from({ length: 5_001 }, () => randomUUID());
    const firstExpectedCompletedAt = Date.parse("2026-08-20T18:00:00+08:00");
    await prisma.$transaction(async (tx) => {
      for (let offset = 0; offset < nodeIds.length; offset += 1_000) {
        const batch = nodeIds.slice(offset, offset + 1_000);
        await tx.taskNode.createMany({
          data: batch.map((id, index) => ({
            id,
            taskId: task.id,
            type: "MILESTONE",
            status: "PENDING",
            businessDescription: `节点预算错误 fixture ${offset + index + 1}`,
            createdByAccountId: requester.accountId,
          })),
        });
        await tx.milestoneNode.createMany({
          data: batch.map((nodeId, index) => ({
            nodeId,
            goal: `节点预算错误 Milestone ${offset + index + 1}`,
            completionCriteria: "完成节点预算错误回归",
            expectedCompletedAt: new Date(
              firstExpectedCompletedAt + (offset + index) * 60_000,
            ),
            reviewRequirements: "无需提交真实审批",
          })),
        });
        await tx.planVersionNode.createMany({
          data: batch.map((nodeId, index) => ({
            planVersionId: plan.id,
            nodeId,
            sequence: offset + index + 1,
          })),
        });
      }
    }, { timeout: 120_000 });

    await loginAsTestUser(context, baseURL, {
      openId: requester.openId,
      name: "Project 超限申请人",
    });
    await page.goto(`/progress/projects/${created.projectId}`);
    const timelineLayer = page.getByTestId("project-timeline-layer");
    await expect(timelineLayer).toBeVisible();
    await expect(timelineLayer.getByRole("alert")).toContainText(
      "Project Task 计划节点超过 5000 个，无法展示时间线。",
    );
    await expect(timelineLayer.getByTestId("time-canvas-root")).toHaveCount(0);
    await page
      .getByTestId("project-task-group-DRAFT")
      .getByRole("button", { name: "展开草稿 Task 列表" })
      .click();
    await expect(
      page
        .getByTestId("project-detail-main-column")
        .getByRole("link", { name: task.title, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: `在时间线中显示 ${task.title}` }),
    ).toBeDisabled();
    await expect(
      page.getByRole("checkbox", { name: "显示全部草稿 Task 时间线" }),
    ).toBeDisabled();
    await expectThreeLayerDetailLayout(page, projectDetailLayoutIds, "columns");
    await expectHealthyPage(page);
    expect(pageErrors).toEqual([]);
  });

  test("普通账号提交、管理员驳回、原申请人重提并批准", async () => {
    const requester = await actor("Project 申请人");
    const admin = await actor("Project 管理员", "PROJECT_ADMINISTRATOR");
    const outsider = await actor("Project 普通用户");
    const created = await createProject(requester, {
      name: `Project ${randomUUID()}`,
      description: "验证完整的立项审批轮次",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: [],
      idempotencyKey: randomUUID(),
    });
    expect(created.status).toBe("PENDING_APPROVAL");
    const request = await prisma.projectEstablishmentRequest.findFirstOrThrow({ where: { projectId: created.projectId, status: "PENDING" } });
    const adminInbox = await getActionInbox({ actor: admin, input: { limit: 100 } });
    expect(adminInbox.items).toContainEqual(expect.objectContaining({ kind: "PROJECT_ESTABLISHMENT", href: `/progress/projects/${created.projectId}#establishment` }));
    await expectCode(reviewProjectEstablishment(outsider, { projectId: created.projectId, requestId: request.id, expectedLockVersion: 0, decision: "APPROVE", comment: "" }), "FORBIDDEN");
    const rejected = await reviewProjectEstablishment(admin, { projectId: created.projectId, requestId: request.id, expectedLockVersion: 0, decision: "REJECT", comment: "信息需要补充" });
    expect(rejected).toMatchObject({ status: "DRAFT", lockVersion: 1 });
    const resubmitInput = {
      projectId: created.projectId,
      expectedLockVersion: 1,
      name: `Project ${randomUUID()}`,
      description: "已补充完整信息",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: [],
      idempotencyKey: randomUUID(),
    };
    const resubmitted = await resubmitProject(requester, resubmitInput);
    expect(resubmitted).toMatchObject({ status: "PENDING_APPROVAL", lockVersion: 2 });
    await expect(resubmitProject(requester, resubmitInput)).resolves.toMatchObject({ requestId: resubmitted.requestId, status: "PENDING_APPROVAL", lockVersion: 2 });
    const latestHistory = await getProjectDetail({ actor: requester, projectId: created.projectId, pagination: { pageSize: 1 } });
    expect(latestHistory.requests.map((item) => item.round)).toEqual([2]);
    expect(latestHistory.pendingRequestId).toBe(resubmitted.requestId);
    expect(latestHistory.requestNextCursor).not.toBeNull();
    const olderHistory = await getProjectDetail({ actor: requester, projectId: created.projectId, pagination: { pageSize: 1, requestCursor: latestHistory.requestNextCursor! } });
    expect(olderHistory.requests.map((item) => item.round)).toEqual([1]);
    expect(latestHistory.auditNextCursor).not.toBeNull();
    const olderAudit = await getProjectDetail({ actor: requester, projectId: created.projectId, pagination: { pageSize: 1, auditCursor: latestHistory.auditNextCursor! } });
    expect(olderAudit.auditEvents[0]?.id).not.toBe(latestHistory.auditEvents[0]?.id);
    const approvalInput = { projectId: created.projectId, requestId: resubmitted.requestId, expectedLockVersion: 2, decision: "APPROVE" as const, comment: "同意" };
    const approved = await reviewProjectEstablishment(admin, approvalInput);
    expect(approved).toMatchObject({ status: "ACTIVE", lockVersion: 3 });
    await expect(reviewProjectEstablishment(admin, approvalInput)).resolves.toMatchObject({ status: "ACTIVE", lockVersion: 3, requestId: resubmitted.requestId });
    await expectCode(reviewProjectEstablishment(admin, { ...approvalInput, decision: "REJECT", comment: "反向决定" }), "STATE_CONFLICT");
    expect(await prisma.projectEstablishmentRequest.count({ where: { projectId: created.projectId } })).toBe(2);
    expect(await prisma.projectEstablishmentRequest.count({ where: { projectId: created.projectId, status: "PENDING" } })).toBe(0);
  });

  test("立项提交先锁定审批人集合并与全局角色撤销无死锁串行化", async () => {
    const requester = await actor("Project 立项锁顺序申请人");
    const operator = await actor(
      "Project 立项锁顺序超管",
      "SUPER_ADMINISTRATOR",
    );
    const target = await actor(
      "Project 立项锁顺序审批人",
      "PROJECT_ADMINISTRATOR",
    );
    const targetAssignment = await prisma.systemRoleAssignment.findFirstOrThrow({
      where: {
        accountId: target.accountId,
        role: "PROJECT_ADMINISTRATOR",
        revokedAt: null,
      },
      select: { id: true },
    });

    let releasePersonLock!: () => void;
    const personLockGate = new Promise<void>((resolve) => {
      releasePersonLock = resolve;
    });
    let markPersonLocked!: () => void;
    const personLocked = new Promise<void>((resolve) => {
      markPersonLocked = resolve;
    });
    const personLockHolder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "Person"
        WHERE "id" = ${requester.personId}
        FOR UPDATE
      `;
      markPersonLocked();
      await personLockGate;
    });
    await personLocked;

    const idempotencyKey = randomUUID();
    const submission = createProject(requester, {
      name: `Project 立项锁顺序 ${randomUUID()}`,
      description: "验证立项提交与审批角色撤销的统一锁顺序",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: [],
      idempotencyKey,
    });
    await new Promise((resolve) => setTimeout(resolve, 75));

    let revocationSettled = false;
    const revocation = revokeAccountRole(
      operator.accountId,
      targetAssignment.id,
    ).finally(() => {
      revocationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(revocationSettled).toBe(false);

    releasePersonLock();
    const [created] = await Promise.all([
      submission,
      revocation,
      personLockHolder,
    ]);
    await expect(
      prisma.project.findUniqueOrThrow({
        where: { id: created.projectId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "PENDING_APPROVAL" });
    const submittedOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: {
        eventKey: `pm:project:${created.projectId}:establishment:1:submitted:feishu`,
      },
      select: { payload: true },
    });
    expect(JSON.parse(submittedOutbox.payload)).toMatchObject({
      linkPath: `/progress/projects/${created.projectId}#establishment`,
      recipientOpenIds: expect.arrayContaining([
        operator.openId,
        target.openId,
      ]),
    });
  });

  test("提交人在审批前停用时批准失败且不产生部分写入", async () => {
    const requester = await actor("Project 停用提交人");
    const participant = await actor("Project 停用提交成员");
    const admin = await actor(
      "Project 停用提交审批人",
      "PROJECT_ADMINISTRATOR",
    );
    const task = await draftTask(
      requester,
      participant,
      `Project 停用提交 Task ${randomUUID()}`,
    );
    const created = await createProject(requester, {
      name: `Project 停用提交 ${randomUUID()}`,
      description: "验证提交后离职不会在审批时挂载 Task",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: [task.id],
      idempotencyKey: randomUUID(),
    });
    const request = await prisma.projectEstablishmentRequest.findFirstOrThrow({
      where: { projectId: created.projectId, status: "PENDING" },
    });
    const taskBefore = await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
      select: { lockVersion: true },
    });

    await prisma.person.update({
      where: { id: requester.personId },
      data: { status: "INACTIVE" },
    });

    await expectCode(
      reviewProjectEstablishment(admin, {
        projectId: created.projectId,
        requestId: request.id,
        expectedLockVersion: created.lockVersion,
        decision: "APPROVE",
        comment: "提交人已停用，不应批准",
      }),
      "STATE_CONFLICT",
    );
    await expect(
      prisma.project.findUniqueOrThrow({
        where: { id: created.projectId },
        select: { status: true, lockVersion: true, reviewedAt: true },
      }),
    ).resolves.toEqual({
      status: "PENDING_APPROVAL",
      lockVersion: created.lockVersion,
      reviewedAt: null,
    });
    await expect(
      prisma.projectEstablishmentRequest.findUniqueOrThrow({
        where: { id: request.id },
        select: { status: true, reviewerAccountId: true, reviewedAt: true },
      }),
    ).resolves.toEqual({
      status: "PENDING",
      reviewerAccountId: null,
      reviewedAt: null,
    });
    await expect(
      prisma.task.findUniqueOrThrow({
        where: { id: task.id },
        select: { projectId: true, lockVersion: true },
      }),
    ).resolves.toEqual({
      projectId: null,
      lockVersion: taskBefore.lockVersion,
    });
    await expect(
      prisma.domainAuditEvent.count({
        where: {
          projectId: created.projectId,
          action: "pm.project.establishment.approve",
        },
      }),
    ).resolves.toBe(0);
  });

  test("零成员草稿创建者可以选择并通过 Project 立项挂载 Task", async () => {
    const requester = await actor("Project 零成员 Task 申请人");
    const formerParticipant = await actor("Project 零成员 Task 非成员");
    const admin = await actor(
      "Project 零成员 Task 管理员",
      "PROJECT_ADMINISTRATOR",
    );
    const task = await draftTask(
      requester,
      formerParticipant,
      `Project 零成员 Task ${randomUUID()}`,
    );
    await prisma.taskMember.deleteMany({ where: { taskId: task.id } });

    await expect(
      searchTaskOptions({
        actor: requester,
        input: { query: task.title, projectCandidates: true, limit: 50 },
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: task.id })],
    });
    await expect(
      searchTaskOptions({
        actor: formerParticipant,
        input: { query: task.title, projectCandidates: true, limit: 50 },
      }),
    ).resolves.toMatchObject({ items: [] });

    const created = await createProject(requester, {
      name: `Project 零成员 Task 立项 ${randomUUID()}`,
      description: "验证草稿创建者权限贯穿立项提交和批准",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: [task.id],
      idempotencyKey: randomUUID(),
    });
    const approved = await reviewProjectEstablishment(admin, {
      projectId: created.projectId,
      requestId: created.requestId!,
      expectedLockVersion: created.lockVersion,
      decision: "APPROVE",
      comment: "批准零成员草稿随 Project 立项挂载",
    });
    expect(approved.status).toBe("ACTIVE");
    await expect(
      prisma.task.findUniqueOrThrow({
        where: { id: task.id },
        select: { projectId: true, lockVersion: true },
      }),
    ).resolves.toEqual({ projectId: created.projectId, lockVersion: 1 });
    await expect(
      prisma.taskMember.count({ where: { taskId: task.id } }),
    ).resolves.toBe(0);
  });

  test("批准时原子挂载 Task、同步成员，并执行结束与删除门禁", async () => {
    const requester = await actor("Project Task 申请人");
    const participant = await actor("Project Task 成员");
    const formerParticipant = await actor("Project Task 已结束成员");
    const admin = await actor("Project Task 管理员", "SUPER_ADMINISTRATOR");
    const task = await draftTask(requester, participant);
    const secondTask = await draftTask(requester, participant);
    await prisma.taskMember.create({
      data: {
        taskId: task.id,
        personId: formerParticipant.personId,
        role: "PARTICIPANT",
        removedAt: new Date(),
        createdByAccountId: requester.accountId,
      },
    });
    expect((await searchTaskOptions({ actor: requester, input: { query: "Project Task", projectCandidates: true, limit: 50 } })).items.map((item) => item.id)).toContain(task.id);
    expect((await searchTaskOptions({ actor: formerParticipant, input: { query: "Project Task", projectCandidates: true, limit: 50 } })).items.map((item) => item.id)).not.toContain(task.id);
    const created = await createProject(requester, {
      name: `Project Task ${randomUUID()}`,
      description: "验证 Task 关系",
      avatarPath: null,
      members: [{ personId: requester.personId, role: "OWNER" }],
      requestedTaskIds: [task.id, secondTask.id],
      idempotencyKey: randomUUID(),
    });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).projectId).toBeNull();
    const request = await prisma.projectEstablishmentRequest.findFirstOrThrow({ where: { projectId: created.projectId, status: "PENDING" } });
    const approved = await reviewProjectEstablishment(admin, { projectId: created.projectId, requestId: request.id, expectedLockVersion: 0, decision: "APPROVE", comment: "" });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).projectId).toBe(created.projectId);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: secondTask.id } })).projectId).toBe(created.projectId);
    await prisma.task.update({ where: { id: secondTask.id }, data: { status: "ACTIVE" } });
    const projectDetail = await getProjectDetail({ actor: requester, projectId: created.projectId, pagination: { pageSize: 1 } });
    expect(projectDetail.tasks).toHaveLength(2);
    expect(projectDetail.tasks[0]).toMatchObject({ id: task.id, status: "DRAFT" });
    expect(projectDetail.tasks[1]).toMatchObject({ id: secondTask.id, status: "ACTIVE" });
    const fillerTasks = Array.from({ length: 24 }, (_, index) => ({
      id: randomUUID(),
      planId: randomUUID(),
      title: `Project locator filler ${index}`,
    }));
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
      await tx.task.createMany({
        data: fillerTasks.map((filler) => ({
          id: filler.id,
          title: filler.title,
          team: "英雄",
          techGroup: "电控",
          status: "DRAFT",
          projectId: created.projectId,
          currentPlanVersionId: filler.planId,
          createdByAccountId: requester.accountId,
        })),
      });
      await tx.taskPlanVersion.createMany({
        data: fillerTasks.map((filler) => ({
          id: filler.planId,
          taskId: filler.id,
          versionNo: 1,
          status: "CURRENT",
          createdByAccountId: requester.accountId,
        })),
      });
    });
    const crossPageLocator = await locateProjectTimelineFocus({
      actor: requester,
      projectId: created.projectId,
      focus: `project-start:${secondTask.id}`,
    });
    expect(crossPageLocator).toMatchObject({
      focusId: `project-start:${secondTask.id}`,
    });
    const focusedProject = await getProjectDetail({
      actor: requester,
      projectId: created.projectId,
    });
    expect(focusedProject.tasks).toHaveLength(26);
    expect(focusedProject.blockingTaskTotalCount).toBe(26);
    expect(focusedProject.blockingTasks).toHaveLength(10);
    expect(focusedProject.blockingTasks.every((item) => ["DRAFT", "ACTIVE"].includes(item.status))).toBe(true);
    expect(focusedProject.tasks.map((item) => item.id)).toContain(secondTask.id);
    await expect(locateProjectTimelineFocus({
      actor: requester,
      projectId: created.projectId,
      focus: `project-node:${randomUUID()}`,
    })).resolves.toBeNull();
    await expect(locateProjectTimelineFocus({
      actor: formerParticipant,
      projectId: created.projectId,
      focus: `project-start:${secondTask.id}`,
    })).resolves.toMatchObject({
      focusId: `project-start:${secondTask.id}`,
    });
    const canvas = await getContentDrivenTimeCanvasData({
      actor: requester,
      preferredCenterMs: Date.now(),
      load: { mode: "INITIAL" },
      input: {
        scope: { kind: "TASK_SCOPED", taskId: task.id },
        personIds: [],
        taskIds: [],
        types: [],
        statuses: [],
        groupBy: "PERSON",
        includeTaskAnchors: true,
        includeActual: true,
        includeBusyBlocks: false,
      },
    });
    await expect(getAdaptiveTimeCanvasBlock({
      actor: requester,
      input: {
        kind: "TASK",
        taskId: task.id,
        rowPageKey: canvas.data.rowPageKey,
        preferredCenter: new Date(canvas.resolvedCenterMs).toISOString(),
        blockStart: new Date(canvas.loadedRange.startMs).toISOString(),
        blockEnd: new Date(canvas.loadedRange.endMs).toISOString(),
      },
    })).resolves.toMatchObject({ rowPageKey: canvas.data.rowPageKey });
    await expectCode(getAdaptiveTimeCanvasBlock({
      actor: requester,
      input: {
        kind: "TASK",
        taskId: task.id,
        rowPageKey: `${canvas.data.rowPageKey}-stale`,
        preferredCenter: new Date(canvas.resolvedCenterMs).toISOString(),
        blockStart: new Date(canvas.loadedRange.startMs).toISOString(),
        blockEnd: new Date(canvas.loadedRange.endMs).toISOString(),
      },
    }), "STATE_CONFLICT");
    await expectCode(getAdaptiveTimeCanvasBlock({
      actor: requester,
      input: {
        kind: "TASK",
        taskId: task.id,
        rowPageKey: canvas.data.rowPageKey,
        preferredCenter: new Date(canvas.resolvedCenterMs).toISOString(),
        blockStart: new Date(canvas.fullRange.startMs - 1).toISOString(),
        blockEnd: new Date(canvas.fullRange.startMs + 86_400_000).toISOString(),
      },
    }), "VALIDATION_ERROR");
    expect((await searchTaskOptions({ actor: requester, input: { query: "Project Task", projectCandidates: true, limit: 50 } })).items.map((item) => item.id)).not.toContain(task.id);
    expect(await prisma.projectMember.findFirst({ where: { projectId: created.projectId, personId: participant.personId, role: "PARTICIPANT", removedAt: null } })).not.toBeNull();
    expect(await prisma.projectMember.findFirst({ where: { projectId: created.projectId, personId: formerParticipant.personId, removedAt: null } })).toBeNull();
    await expectCode(completeProject(requester, { projectId: created.projectId, expectedLockVersion: approved.lockVersion }), "STATE_CONFLICT");
    const deleted = await deleteProject(requester, { projectId: created.projectId, expectedLockVersion: approved.lockVersion });
    expect(deleted.lockVersion).toBe(approved.lockVersion + 1);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).projectId).toBeNull();
    expect((await prisma.task.findUniqueOrThrow({ where: { id: secondTask.id } })).projectId).toBeNull();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: created.projectId } })).deletedAt).not.toBeNull();
    expect(await prisma.domainAuditEvent.count({ where: { taskId: task.id, action: "pm.task.project.remove" } })).toBe(1);
    const deletedOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: {
        eventKey: `pm:project:${created.projectId}:project_deleted:${deleted.lockVersion}:feishu`,
      },
      select: { payload: true },
    });
    expect(JSON.parse(deletedOutbox.payload)).toMatchObject({
      kind: "project_deleted",
      linkPath: "/progress/projects",
    });
  });

  test("Project 列表使用稳定游标继续加载", async () => {
    const requester = await actor("Project 分页申请人");
    const projectIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const created = await createProject(requester, {
        name: `Project 分页 ${index} ${randomUUID()}`,
        description: "验证列表不会在固定数量后静默截断",
        avatarPath: null,
        members: [{ personId: requester.personId, role: "OWNER" }],
        requestedTaskIds: [],
        idempotencyKey: randomUUID(),
      });
      projectIds.push(created.projectId);
    }
    const firstPage = await listProjects({ actor: requester, input: { status: "PENDING_APPROVAL", mine: true, limit: 1 } });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await listProjects({ actor: requester, input: { status: "PENDING_APPROVAL", mine: true, limit: 1, cursor: firstPage.nextCursor! } });
    expect(secondPage.items).toHaveLength(1);
    expect(new Set([firstPage.items[0]!.id, secondPage.items[0]!.id])).toEqual(new Set(projectIds));
    expect(secondPage.nextCursor).toBeNull();
  });
});

async function actor(displayName: string, role?: "SUPER_ADMINISTRATOR" | "PROJECT_ADMINISTRATOR"): Promise<ProjectManagementActor> {
  const openId = `ou_project_${randomUUID()}`;
  const account = await prisma.account.create({ data: { identities: { create: { provider: "FEISHU", tenantId: "default", providerSubject: `open:${openId}`, openId } }, person: { create: { displayName, status: "ACTIVE" } }, ...(role ? { systemRoles: { create: { role, team: "", techGroup: "", grantedByAccountId: undefined } } } : {}) }, include: { person: true, systemRoles: true } });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { accountId: account.id, personId: account.person.id, openId, unionId: null, systemRoles: account.systemRoles.map(({ role: itemRole, team, techGroup }) => ({ role: itemRole, team, techGroup })) };
}

async function draftTask(owner: ProjectManagementActor, participant: ProjectManagementActor, title = `Project Task ${randomUUID()}`) {
  const taskId = randomUUID(); const planId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.create({ data: { id: taskId, title, team: "英雄", techGroup: "电控", status: "DRAFT", currentPlanVersionId: planId, createdByAccountId: owner.accountId } });
    await tx.taskPlanVersion.create({ data: { id: planId, taskId, versionNo: 1, status: "CURRENT", createdByAccountId: owner.accountId } });
    await tx.taskMember.createMany({ data: [{ taskId, personId: owner.personId, role: "OWNER", createdByAccountId: owner.accountId }, { taskId, personId: participant.personId, role: "PARTICIPANT", createdByAccountId: owner.accountId }] });
  });
  return { id: taskId, title };
}

async function addTaskPlanNodes(
  taskId: string,
  owner: ProjectManagementActor,
  label: string,
) {
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { currentPlanVersionId: true },
  });
  const milestoneNodeId = randomUUID();
  const terminationNodeId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.taskPlanVersion.update({
      where: { id: task.currentPlanVersionId },
      data: { plannedStartAt: new Date("2026-08-08T09:00:00+08:00") },
    });
    await tx.taskNode.create({
      data: {
        id: milestoneNodeId,
        taskId,
        type: "MILESTONE",
        status: "PENDING",
        businessDescription: `${label}业务说明`,
        createdByAccountId: owner.accountId,
        milestone: {
          create: {
            goal: label,
            completionCriteria: `${label}完成条件`,
            expectedCompletedAt: new Date("2026-08-10T18:00:00+08:00"),
            reviewRequirements: `${label}验收要求`,
          },
        },
      },
    });
    await tx.taskNode.create({
      data: {
        id: terminationNodeId,
        taskId,
        type: "TERMINATION",
        status: "PENDING",
        businessDescription: `${label}结束说明`,
        createdByAccountId: owner.accountId,
        termination: {
          create: {
            name: `${label} Terminal`,
            plannedOutcomeCriteria: `${label}结束条件`,
            plannedAt: new Date("2026-08-12T18:00:00+08:00"),
          },
        },
      },
    });
    await tx.planVersionNode.createMany({
      data: [
        {
          planVersionId: task.currentPlanVersionId,
          nodeId: milestoneNodeId,
          sequence: 1,
        },
        {
          planVersionId: task.currentPlanVersionId,
          nodeId: terminationNodeId,
          sequence: 2,
        },
      ],
    });
  });
  return { milestoneNodeId, terminationNodeId };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise.catch((error) => { throw toProjectManagementServiceError(error); })).rejects.toMatchObject({ code });
}
