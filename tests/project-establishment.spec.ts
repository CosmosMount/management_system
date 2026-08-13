import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import {
  completeProject,
  createProject,
  deleteProject,
  resubmitProject,
  reviewProjectEstablishment,
} from "../lib/project-management/application/project-service";
import { toProjectManagementServiceError } from "../lib/project-management/application/errors";
import type { ProjectManagementActor } from "../lib/project-management/identity";
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
} from "../lib/project-management/queries/time-canvas-queries";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

test.describe("Project 立项与生命周期", () => {
  test("Project 导航、默认筛选、列表和创建页在桌面与移动端可用", async ({ context, page, baseURL }, testInfo) => {
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
    await expect(page.getByRole("button", { name: "提交立项" })).toBeVisible();
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

  test("Project 详情使用概览、三列工作区和当前页 Task 时间线", async ({
    browser,
    context,
    page,
    baseURL,
  }) => {
    const requester = await actor(`Project 详情申请人 ${randomUUID()}`);
    const admin = await actor(
      `Project 详情管理员 ${randomUUID()}`,
      "PROJECT_ADMINISTRATOR",
    );
    const participant = await actor(`Project 详情参与人 ${randomUUID()}`);
    const viewer = await actor(`Project 详情只读用户 ${randomUUID()}`);
    const draft = await draftTask(
      requester,
      participant,
      `草稿 Task ${"很长的名称".repeat(16)}`,
    );
    const active = await draftTask(requester, participant, "进行中 Task 时间线");
    const completed = await draftTask(requester, participant, "已完成 Task 时间线");
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

    const projectName = `Project 详情 UI ${randomUUID()}`;
    const projectDescription = `Project 完整内容 ${"需要安全换行的长内容".repeat(18)}`;
    const created = await createProject(requester, {
      name: projectName,
      description: projectDescription,
      avatarPath: null,
      members: [
        { personId: requester.personId, role: "OWNER" },
        { personId: participant.personId, role: "PARTICIPANT" },
      ],
      requestedTaskIds: [completed.id, active.id, draft.id],
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
    await expect(page.getByText("1/3 已完成", { exact: true })).toHaveCount(2);
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

    const taskItems = page
      .getByRole("list", { name: "Project Task 列表" })
      .getByRole("listitem");
    await expect(taskItems).toHaveCount(3);
    await expect(taskItems.nth(0)).toContainText(draft.title);
    await expect(taskItems.nth(1)).toContainText(active.title);
    await expect(taskItems.nth(2)).toContainText(completed.title);
    await expect(page.getByTestId(`timeline-row-project-plan:${draft.id}`)).toBeVisible();
    await expect(page.getByTestId(`timeline-row-project-plan:${active.id}`)).toBeVisible();
    await expect(page.getByTestId(`timeline-row-project-plan:${completed.id}`)).toBeVisible();
    await expect(page.locator('[data-testid^="timeline-row-plan:"]')).toHaveCount(0);
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
      page.getByTestId(`milestone-marker-project-start:${active.id}`),
    ).toHaveAttribute("aria-pressed", "false");

    await expectHealthyPage(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    const viewerContext = await browser.newContext();
    try {
      await loginAsTestUser(viewerContext, baseURL, {
        openId: viewer.openId,
        name: "Project 详情只读用户",
      });
      const viewerPage = await viewerContext.newPage();
      await viewerPage.goto(`/progress/projects/${created.projectId}`);
      await expect(viewerPage.getByTestId("project-overview")).toBeVisible();
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
      await expectHealthyPage(viewerPage);
    } finally {
      await viewerContext.close();
    }
  });

  test("空 Project 可以直接结束并记录审计与通知", async ({ context, page, baseURL }, testInfo) => {
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
      context: { taskCount: 0 },
    });
    await expectHealthyPage(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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
    const adminInbox = await getActionInbox({ actor: admin, limit: 200 });
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
    const firstTaskPage = await getProjectDetail({ actor: requester, projectId: created.projectId, pagination: { pageSize: 1 } });
    expect(firstTaskPage.taskNextCursor).not.toBeNull();
    const secondTaskPage = await getProjectDetail({ actor: requester, projectId: created.projectId, pagination: { pageSize: 1, taskCursor: firstTaskPage.taskNextCursor! } });
    expect(firstTaskPage.tasks[0]).toMatchObject({ id: task.id, status: "DRAFT" });
    expect(secondTaskPage.tasks[0]).toMatchObject({ id: secondTask.id, status: "ACTIVE" });
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
    expect(crossPageLocator?.taskCursor).not.toBeNull();
    const focusedTaskPage = await getProjectDetail({
      actor: requester,
      projectId: created.projectId,
      pagination: { pageSize: 25, taskCursor: crossPageLocator!.taskCursor! },
    });
    expect(focusedTaskPage.tasks.map((item) => item.id)).toContain(secondTask.id);
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
        rowLimit: 50,
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
