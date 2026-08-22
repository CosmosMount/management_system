import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  createRevision,
  createTaskDraft,
  rejectRevision,
} from "../lib/project-management/application/lifecycle-service";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

import {
  actor,
  createAccountPerson,
  createDraftWorkbenchFixture,
  createUiFixture,
  grantRole,
  milestoneInput,
  terminationInput,
} from "./helpers/project-management-ui-fixtures";
import { updateDraftMetadataThroughCurrentInterface } from "./helpers/project-management-plan-mutation-fixtures";

test.describe("project management UI project-management-ui-workbench", () => {
  test.beforeAll(async () => {
      const administrator = await createAccountPerson(
        `S5 UI Global Approval Administrator ${randomUUID()}`,
      );
      await grantRole(administrator.account.id, "PROJECT_ADMINISTRATOR");
    });

  test("server-rendered Task workbench tabs remain navigable without client JavaScript", async ({
      browser,
      baseURL,
    }, testInfo) => {
      if (!baseURL) throw new Error("无脚本回归缺少 Playwright baseURL");
      const owner = await createAccountPerson(
        `P6 UI No-JS Owner ${testInfo.project.name} ${randomUUID()}`,
      );
      const task = await createTaskDraft(actor(owner), {
        title: `P6 UI No-JS Task ${randomUUID()}`,
        description: "验证客户端脚本加载失败时的工作台导航",
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        members: [{ personId: owner.person.id, role: "OWNER" }],
        milestones: [milestoneInput("No-JS Milestone", "完成无脚本回归", 1)],
        plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
        termination: terminationInput(5),
        idempotencyKey: `p6-ui-no-js-${randomUUID()}`,
      });
      await activateTask(actor(owner), {
        taskId: task.taskId,
        expectedLockVersion: task.lockVersion,
      });

      const context = await browser.newContext({
        baseURL,
        javaScriptEnabled: false,
        viewport:
          testInfo.project.name === "mobile"
            ? { width: 393, height: 727 }
            : { width: 1_440, height: 1_000 },
      });
      try {
        await loginAsTestUser(context, baseURL, {
          openId: owner.openId,
          name: owner.person.displayName,
        });
        const page = await context.newPage();
        await page.goto(`/progress/tasks/${task.taskId}`);
        await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
        await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
        await expect(page.getByRole("heading", { name: "No-JS Milestone" })).toBeVisible();
        await expect(page.getByRole("tab")).toHaveCount(0);
      } finally {
        await context.close();
      }
    });

  test("Task workbench uses the unified Draft editor and locks it after activation", async ({
      context,
      page,
      baseURL,
    }, testInfo) => {
      const fixture = await createDraftWorkbenchFixture();
      const addedMember = await createAccountPerson(
        `S6 Unified Editor Member ${randomUUID()}`,
      );
      const inactiveCurrentMember = await createAccountPerson(
        "S6 Unified Editor Inactive Member",
      );
      await prisma.taskMember.create({
        data: {
          taskId: fixture.taskId,
          personId: inactiveCurrentMember.person.id,
          role: "PARTICIPANT",
          createdByAccountId: fixture.admin.account.id,
        },
      });
      await prisma.person.update({
        where: { id: inactiveCurrentMember.person.id },
        data: { status: "INACTIVE" },
      });
      const updatedTitle = `S6 Unified Edited ${randomUUID()}`;
      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}`);
      await expect(
        page
          .getByTestId("task-workbench-v2")
          .getByRole("heading", { name: fixture.taskTitle, exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
      await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
      await expect(page.getByRole("heading", { name: "编辑 Draft 计划" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "编辑 Task" })).toBeVisible();
      await expect(page.getByRole("button", { name: "修改 Task 基本信息" })).toHaveCount(0);

      await page.getByRole("link", { name: "编辑 Task" }).click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}/edit`);
      await expect(page.getByRole("heading", { name: "编辑 Task" })).toBeVisible();
      await expect(page.getByTestId("task-composer")).toHaveAttribute(
        "data-composer-mode",
        "EDIT_DRAFT",
      );
      await expect(page.getByLabel("Task 名称")).toHaveValue(fixture.taskTitle);
      await expect(page.getByText(inactiveCurrentMember.person.displayName)).toBeVisible();
      await expect(page.getByRole("button", { name: "保存 Task" }).first()).toBeDisabled();
      if (testInfo.project.name === "mobile") {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      } else {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      }
      await expect(page.getByRole("button", { name: "保存 Task" }).first()).toBeDisabled();

      await page.getByLabel("描述").fill("会被撤销的本地修改");
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).some(
              (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      await page.getByRole("button", { name: "撤销" }).click();
      await expect(page.getByLabel("描述")).toHaveValue("S6 Draft 工作台测试");
      await expect(page.getByRole("button", { name: "保存 Task" }).first()).toBeDisabled();
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).every(
              (key) => !key.startsWith("task-edit-draft:") || !key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      await page.goBack();
      await expect(page).toHaveURL(
        new RegExp(`/progress/tasks/${fixture.taskId}(?:\\?.*)?$`),
      );
      await page.getByRole("link", { name: "编辑 Task" }).click();
      await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toHaveCount(0);

      await page.getByLabel("Task 名称").fill(updatedTitle);
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).some(
              (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      const editDraftStorageKey = await page.evaluate((taskId) =>
        Object.keys(window.localStorage).find(
          (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
        ) ?? null,
      fixture.taskId);
      expect(editDraftStorageKey).not.toBeNull();
      await page.reload();
      await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toBeVisible();
      await page.getByRole("button", { name: "恢复草稿" }).click();
      await expect(page.getByLabel("Task 名称")).toHaveValue(updatedTitle);

      await page.getByLabel("搜索参与人员", { exact: true }).fill(addedMember.person.displayName);
      await page
        .getByRole("option", {
          name: addedMember.person.displayName,
          exact: true,
        })
        .click();

      if (testInfo.project.name === "mobile") {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      } else {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      }
      await page.getByLabel("目标").fill("S6 Draft 持久化目标");
      await page.getByRole("button", { name: "添加 Milestone", exact: true }).first().click();
      const draftInspector = page.getByTestId("task-composer-inspector");
      await draftInspector
        .getByRole("textbox", { name: /^目标/ })
        .fill("S6 新增 Milestone");
      await draftInspector
        .getByRole("textbox", { name: /^完成条件/ })
        .fill("新增节点保存到数据库");
      await draftInspector
        .getByRole("textbox", { name: /^验收要求/ })
        .fill("提交文本证据");
      await page.getByLabel("预期完成时间").fill("2026-08-03T18:00");
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ })
        .click();
      await page.getByLabel("Terminal 名称").fill("S6 Edited Terminal");
      await page.getByRole("button", { name: "保存 Task" }).first().click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
      await expect
        .poll(async () => {
          const task = await prisma.task.findUniqueOrThrow({
            where: { id: fixture.taskId },
            include: {
              currentPlanVersion: {
                include: {
                  nodes: {
                    include: {
                      node: { include: { milestone: true, termination: true } },
                    },
                  },
                },
              },
              members: { where: { removedAt: null } },
            },
          });
          return {
            title: task.title,
            lockVersion: task.lockVersion,
            memberIds: task.members.map((member) => member.personId),
            milestones: task.currentPlanVersion.nodes
              .flatMap((entry) => entry.node.milestone?.goal ?? [])
              .sort(),
            terminal: task.currentPlanVersion.nodes.find(
              (entry) => entry.node.termination,
            )?.node.termination?.name,
          };
        })
        .toEqual({
          title: updatedTitle,
          lockVersion: 1,
          memberIds: expect.arrayContaining([addedMember.person.id]),
          milestones: [
            "S6 Draft 持久化目标",
            "S6 Draft 第二阶段",
            "S6 新增 Milestone",
          ].sort(),
          terminal: "S6 Edited Terminal",
        });
      expect(
        await page.evaluate((key) => key ? window.localStorage.getItem(key) : null, editDraftStorageKey),
      ).toBeNull();

      page.once("dialog", (dialog) => void dialog.accept());
      await page.getByRole("button", { name: "激活 Task" }).click();
      await expect(page.getByText("Task 已激活。")).toBeVisible();
      await expect(page.getByRole("button", { name: "修改 Task 基本信息" })).toBeVisible();
      await expect(page.getByRole("link", { name: "编辑 Task" })).toHaveCount(0);
      await expect
        .poll(() =>
          prisma.task.findUnique({
            where: { id: fixture.taskId },
            select: { status: true, lockVersion: true },
          }),
        )
        .toEqual({ status: "ACTIVE", lockVersion: 2 });
      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
      await expectHealthyPage(page);
    });

  test("Task Owner can delete an unactivated draft from the workbench", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();

      await loginAsTestUser(context, baseURL, {
        openId: fixture.reviewer.openId,
        name: fixture.reviewer.person.displayName,
      });
      await page.goto(`/progress/tasks/${fixture.taskId}`);
      await expect(page.getByRole("button", { name: "删除草稿" })).toHaveCount(0);

      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });
      await page.goto(`/progress/tasks/${fixture.taskId}`);
      const deleteButton = page.getByRole("button", { name: "删除草稿" });
      await expect(deleteButton).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      page.once("dialog", async (dialog) => {
        expect(dialog.message()).toContain("确定删除这个 Task 草稿");
        await dialog.accept();
      });
      await deleteButton.click();
      await expect(page).toHaveURL("/progress/tasks");
      await expect
        .poll(() =>
          prisma.task.findUnique({
            where: { id: fixture.taskId },
            select: { deletedAt: true, lockVersion: true },
          }),
        )
        .toMatchObject({ deletedAt: expect.any(Date), lockVersion: 1 });
      await expect(
        prisma.domainAuditEvent.count({
          where: { taskId: fixture.taskId, action: "pm.task.draft.delete" },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.notificationOutbox.count({
          where: {
            eventKey: `pm:task:deleted:${fixture.taskId}:1:feishu`,
            type: "task_deleted",
            botKind: "notification",
          },
        }),
      ).resolves.toBe(1);
      const deletedResponse = await page.goto(`/progress/tasks/${fixture.taskId}`);
      expect(deletedResponse?.status()).toBe(404);
      await expectHealthyPage(page);
    });

  test("Draft editor omits unchanged members after a live ownership downgrade", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();
      const replacementOwner = await createAccountPerson("S6 Replacement Draft Owner");
      const updatedTitle = `S6 Downgraded Draft Edited ${randomUUID()}`;
      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await expect(page.getByLabel("搜索负责人", { exact: true })).toBeVisible();
      await expect(page.getByLabel("搜索参与人员", { exact: true })).toBeVisible();
      await prisma.taskMember.updateMany({
        where: {
          taskId: fixture.taskId,
          personId: fixture.owner.person.id,
          role: "OWNER",
          removedAt: null,
        },
        data: { role: "PARTICIPANT" },
      });
      await prisma.taskMember.create({
        data: {
          taskId: fixture.taskId,
          personId: replacementOwner.person.id,
          role: "OWNER",
          createdByAccountId: fixture.admin.account.id,
        },
      });

      await page.getByLabel("Task 名称").fill(updatedTitle);
      await page.getByRole("button", { name: "保存 Task" }).first().click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
      await expect
        .poll(async () => {
          const task = await prisma.task.findUniqueOrThrow({
            where: { id: fixture.taskId },
            select: {
              title: true,
              lockVersion: true,
              members: {
                where: { removedAt: null },
                select: { personId: true, role: true },
                orderBy: [{ personId: "asc" }, { role: "asc" }],
              },
            },
          });
          return task;
        })
        .toEqual({
          title: updatedTitle,
          lockVersion: 1,
          members: [
            { personId: fixture.admin.person.id, role: "OWNER" },
            { personId: fixture.owner.person.id, role: "PARTICIPANT" },
            { personId: fixture.reviewer.person.id, role: "PARTICIPANT" },
            { personId: replacementOwner.person.id, role: "OWNER" },
          ].sort((left, right) =>
            left.personId.localeCompare(right.personId) ||
            left.role.localeCompare(right.role),
          ),
        });
      await expectHealthyPage(page);
    });

  test("Draft editor preserves stale local input without overwriting the server", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();
      const serverTitle = `S6 Server Latest ${randomUUID()}`;
      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await page.getByLabel("Task 名称").fill("S6 尚未提交的本地版本");
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).some(
              (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      const storageKey = await page.evaluate((taskId) =>
        Object.keys(window.localStorage).find(
          (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
        ) ?? null,
      fixture.taskId);
      expect(storageKey).not.toBeNull();

      await updateDraftMetadataThroughCurrentInterface(actor(fixture.owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
        title: serverTitle,
        description: "服务端并发更新",
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        relatedTaskId: null,
      });
      await page.getByRole("button", { name: "保存 Task" }).first().click();
      await expect(
        page.getByText(
          "Task 已在服务端更新，当前本地修改不会覆盖最新版本。请先导出，或放弃并加载最新版本。",
        ),
      ).toBeVisible();
      await expect(page.getByLabel("Task 名称")).toHaveValue("S6 尚未提交的本地版本");
      await expect(page.getByRole("button", { name: "导出原始草稿" })).toBeVisible();
      await expect
        .poll(() =>
          prisma.task.findUnique({
            where: { id: fixture.taskId },
            select: { title: true, lockVersion: true },
          }),
        )
        .toEqual({ title: serverTitle, lockVersion: 1 });

      await page.reload();
      await expect(
        page.getByText("Task 已在服务端更新，旧本地草稿不能直接覆盖最新版本。"),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "恢复草稿" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "导出原始草稿" })).toBeVisible();
      await page.getByRole("button", { name: "放弃并加载最新版本" }).click();
      await expect(page.getByLabel("Task 名称")).toHaveValue(serverTitle);
      expect(
        await page.evaluate(
          (key) => (key ? window.localStorage.getItem(key) : null),
          storageKey,
        ),
      ).toBeNull();
      await expectHealthyPage(page);
    });

  test("Draft editor keeps Participant members read-only and denies unauthorized direct access", async ({
      context,
      page,
      baseURL,
    }, testInfo) => {
      const fixture = await createDraftWorkbenchFixture();
      const outsider = await createAccountPerson("S6 Unified Editor Outsider");
      const searchFillerKey = randomUUID();
      await prisma.person.createMany({
        data: Array.from({ length: 55 }, (_, index) => ({
          displayName: `000 S6 permission search filler ${String(index).padStart(2, "0")} ${searchFillerKey}`,
          status: "ACTIVE" as const,
        })),
      });
      const localOnlyMember = await createAccountPerson(
        `S6 Permission Downgrade Local Member ${randomUUID()}`,
      );
      const temporaryAdministrator = await prisma.systemRoleAssignment.create({
        data: {
          accountId: fixture.reviewer.account.id,
          role: "PROJECT_ADMINISTRATOR",
          team: "",
          techGroup: "",
        },
      });
      const participantTitle = `S6 Participant Edited ${randomUUID()}`;
      const memberIdsBefore = (
        await prisma.taskMember.findMany({
          where: { taskId: fixture.taskId, removedAt: null },
          select: { personId: true },
          orderBy: { personId: "asc" },
        })
      ).map((member) => member.personId);
      await loginAsTestUser(context, baseURL, {
        openId: fixture.reviewer.openId,
        name: fixture.reviewer.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      const memberPicker = page.getByLabel("搜索参与人员", { exact: true });
      await memberPicker.click();
      await memberPicker.press("ControlOrMeta+A");
      await memberPicker.pressSequentially(localOnlyMember.person.displayName);
      await page
        .getByRole("option", {
          name: localOnlyMember.person.displayName,
          exact: true,
        })
        .click();
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).some(
              (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      await prisma.systemRoleAssignment.update({
        where: { id: temporaryAdministrator.id },
        data: {
          revokedAt: new Date(),
          revokedByAccountId: fixture.reviewer.account.id,
        },
      });
      await page.reload();
      await expect(page.getByRole("button", { name: "恢复草稿" })).toBeVisible();
      await page.getByRole("button", { name: "恢复草稿" }).click();
      await expect(page.getByText("你可以编辑 Task 内容和计划，成员与角色为只读。")).toBeVisible();
      await expect(page.getByLabel("搜索负责人", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("搜索参与人员", { exact: true })).toHaveCount(0);
      await expect(page.getByText(localOnlyMember.person.displayName)).toHaveCount(0);
      await page.getByLabel("Task 名称").fill(participantTitle);
      if (testInfo.project.name === "mobile") {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      } else {
        await page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /S6 Draft 第一阶段/ })
          .click();
      }
      await page.getByLabel("目标").fill("S6 Participant 更新计划");
      await page.getByRole("button", { name: "保存 Task" }).first().click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
      await expect
        .poll(async () => {
          const task = await prisma.task.findUniqueOrThrow({
            where: { id: fixture.taskId },
            include: {
              members: {
                where: { removedAt: null },
                select: { personId: true },
                orderBy: { personId: "asc" },
              },
            },
          });
          return {
            title: task.title,
            lockVersion: task.lockVersion,
            memberIds: task.members.map((member) => member.personId),
          };
        })
        .toEqual({
          title: participantTitle,
          lockVersion: 1,
          memberIds: memberIdsBefore,
        });

      await loginAsTestUser(context, baseURL, {
        openId: outsider.openId,
        name: outsider.person.displayName,
      });
      const response = await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      expect(response?.status()).toBe(404);
      await expect(page.getByTestId("task-composer")).toHaveCount(0);
    });

  test("Draft editor isolates local recovery across Tasks and accounts", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();
      const secondTitle = `S6 Isolated Draft ${randomUUID()}`;
      const secondTask = await createTaskDraft(actor(fixture.admin), {
        title: secondTitle,
        description: "用于验证编辑草稿按 Task 隔离",
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        relatedTaskId: null,
        members: [{ personId: fixture.owner.person.id, role: "OWNER" }],
        milestones: [],
        plannedStartAt: new Date(Date.UTC(2026, 7, 10, 10, 0, 0)).toISOString(),
        termination: terminationInput(12),
        idempotencyKey: `s6-edit-isolation-${randomUUID()}`,
      });
      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });

      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await page.getByLabel("Task 名称").fill("S6 Owner Task One Local Draft");
      await expect
        .poll(() =>
          page.evaluate((taskId) =>
            Object.keys(window.localStorage).some(
              (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
            ),
          fixture.taskId),
        )
        .toBe(true);
      await page.getByRole("button", { name: "返回 Task 工作台" }).click();
      await page.getByRole("button", { name: "保存本地草稿并离开" }).click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);

      await page.goto(`/progress/tasks/${secondTask.taskId}/edit`);
      await expect(page.getByLabel("Task 名称")).toHaveValue(secondTitle);
      await expect(page.getByRole("button", { name: "恢复草稿" })).toHaveCount(0);

      await loginAsTestUser(context, baseURL, {
        openId: fixture.reviewer.openId,
        name: fixture.reviewer.person.displayName,
      });
      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await expect(page.getByLabel("Task 名称")).toHaveValue(fixture.taskTitle);
      await expect(page.getByRole("button", { name: "恢复草稿" })).toHaveCount(0);

      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });
      await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
      await expect(page.getByRole("button", { name: "恢复草稿" })).toBeVisible();
      await page.getByRole("button", { name: "恢复草稿" }).click();
      await expect(page.getByLabel("Task 名称")).toHaveValue(
        "S6 Owner Task One Local Draft",
      );
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

  test("Task workbench expands its range for an earlier Planned and preserves the latest user viewport", async ({
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
    const canvasRoot = page
      .getByTestId("resource-planner-workbench")
      .getByTestId("time-canvas-root");
    await expect(canvasRoot).toHaveAttribute("data-zoom", "WEEK");
    await canvasRoot.getByRole("button", { name: "月", exact: true }).click();
    await expect(canvasRoot).toHaveAttribute("data-zoom", "MONTH");
    await expect(page).toHaveURL(/scale=month/);
    await expect
      .poll(() =>
        Number.isFinite(
          Date.parse(new URL(page.url()).searchParams.get("center") ?? ""),
        ),
      )
      .toBe(true);
    await page.waitForTimeout(500);
    const centerBefore = Date.parse(
      new URL(page.url()).searchParams.get("center") ?? "",
    );
    const originalRangeStart = Number(
      await canvasRoot.getAttribute("data-range-start-ms"),
    );

    const content = `范围扩展 Planned ${randomUUID()}`;
    const horizontalScroller = page.getByLabel("时间轴横向滚动");
    await expect(horizontalScroller).toBeVisible();
    const scrollBefore = await horizontalScroller.evaluate((element) => ({
      left: element.scrollLeft,
      maximum: element.scrollWidth - element.clientWidth,
    }));
    expect(scrollBefore.maximum).toBeGreaterThan(80);
    const panKey =
      scrollBefore.left < scrollBefore.maximum / 2 ? "ArrowRight" : "ArrowLeft";
    await horizontalScroller.focus();
    for (let index = 0; index < 8; index += 1) {
      await horizontalScroller.press(panKey);
    }
    await expect
      .poll(async () =>
        Math.abs(
          (await horizontalScroller.evaluate((element) => element.scrollLeft)) -
            scrollBefore.left,
        ),
      )
      .toBeGreaterThan(20);
    expect(
      Date.parse(new URL(page.url()).searchParams.get("center") ?? ""),
    ).toBe(centerBefore);
    await page.getByRole("button", { name: "新增投入", exact: true }).click();
    const quickCreate = page.getByRole("form", { name: "投入快速创建" });
    await expect
      .poll(() => {
        const center = Date.parse(
          new URL(page.url()).searchParams.get("center") ?? "",
        );
        return Math.abs(center - centerBefore);
      })
      .toBeGreaterThan(60 * 60 * 1_000);
    const centerAfterUserPan = Date.parse(
      new URL(page.url()).searchParams.get("center") ?? "",
    );
    const draftScrollBefore = await horizontalScroller.evaluate((element) => ({
      left: element.scrollLeft,
      maximum: element.scrollWidth - element.clientWidth,
    }));
    const draftPanKey =
      draftScrollBefore.left < draftScrollBefore.maximum / 2
        ? "ArrowRight"
        : "ArrowLeft";
    await horizontalScroller.focus();
    for (let index = 0; index < 4; index += 1) {
      await horizontalScroller.press(draftPanKey);
    }
    await expect
      .poll(async () =>
        Math.abs(
          (await horizontalScroller.evaluate((element) => element.scrollLeft)) -
            draftScrollBefore.left,
        ),
      )
      .toBeGreaterThan(10);
    await expect
      .poll(() => {
        const center = Date.parse(
          new URL(page.url()).searchParams.get("center") ?? "",
        );
        return Math.abs(center - centerAfterUserPan);
      })
      .toBeGreaterThan(60 * 60 * 1_000);
    const centerAfterDraftPan = Date.parse(
      new URL(page.url()).searchParams.get("center") ?? "",
    );
    await quickCreate
      .getByLabel("开始", { exact: true })
      .fill("2025-06-01T09:00");
    await quickCreate
      .getByLabel("结束", { exact: true })
      .fill("2025-06-02T09:00");
    await quickCreate.getByLabel("内容", { exact: true }).fill(content);
    await quickCreate
      .getByRole("button", { name: "创建", exact: true })
      .click();

    await expect(page.getByText("已创建投入记录")).toBeVisible();
    const expandedStart = Date.parse("2025-04-01T00:00:00.000+08:00");
    await expect(canvasRoot).toHaveAttribute(
      "data-range-start-ms",
      String(expandedStart),
    );
    expect(originalRangeStart).toBeGreaterThan(expandedStart);
    await expect(canvasRoot).toHaveAttribute("data-zoom", "MONTH");
    await expect(page).toHaveURL(/scale=month/);
    await expect
      .poll(() => {
        const centerAfter = Date.parse(
          new URL(page.url()).searchParams.get("center") ?? "",
        );
        return Math.abs(centerAfter - centerAfterDraftPan);
      })
      .toBeLessThan(60 * 60 * 1_000);
    await expect(canvasRoot).toHaveAttribute("data-zoom", "MONTH");
    await expect(page).toHaveURL(/scale=month/);
    await expect
      .poll(() =>
        prisma.workSegment.findFirst({
          where: { taskId: fixture.taskId, content },
          select: { type: true, status: true, startAt: true, endAt: true },
        }),
      )
      .toEqual({
        type: "PLANNED",
        status: "PLANNED",
        startAt: new Date("2025-06-01T09:00:00.000+08:00"),
        endAt: new Date("2025-06-02T09:00:00.000+08:00"),
      });

    const createdSegment = await prisma.workSegment.findFirstOrThrow({
      where: { taskId: fixture.taskId, content },
      select: { id: true },
    });
    const editedCanvasRoot = canvasRoot;
    await page.getByTestId("time-canvas-scroll").evaluate((element) => {
      const root = element.closest<HTMLElement>(
        '[data-testid="time-canvas-root"]',
      );
      const rangeStart = Number(root?.dataset.rangeStartMs);
      const rangeEnd = Number(root?.dataset.rangeEndMs);
      const target = Date.parse("2025-06-01T09:00:00.000+08:00");
      const ratio = (target - rangeStart) / (rangeEnd - rangeStart);
      element.scrollLeft = Math.max(
        0,
        ratio * element.scrollWidth - element.clientWidth / 2,
      );
      element.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(
        async () =>
          (await canvasRoot.getAttribute("data-loaded-ranges"))
            ?.split("|")
            .some((range) => range.startsWith(`${expandedStart}:`)) ?? false,
        { timeout: 30_000 },
      )
      .toBe(true);
    const adjacentBlockStart = expandedStart + 180 * 24 * 60 * 60 * 1_000;
    await expect
      .poll(
        async () =>
          (await canvasRoot.getAttribute("data-loaded-ranges"))
            ?.split("|")
            .some((range) => range.startsWith(`${adjacentBlockStart}:`)) ??
          false,
        { timeout: 15_000 },
      )
      .toBe(true);
    await horizontalScroller.focus();
    await horizontalScroller.press("ArrowRight");
    const segmentBlock = page.getByTestId(`segment-block-${createdSegment.id}`);
    await expect(segmentBlock).toBeVisible({ timeout: 15_000 });
    await segmentBlock.focus();
    await segmentBlock.press("Enter");
    const editForm = page.getByRole("form", { name: "编辑投入详情" });
    await expect(editForm).toBeVisible();
    await expect
      .poll(
        async () => {
          const viewportStart = Number(
            await editedCanvasRoot.getAttribute("data-viewport-start-ms"),
          );
          const viewportEnd = Number(
            await editedCanvasRoot.getAttribute("data-viewport-end-ms"),
          );
          const urlCenter = Date.parse(
            new URL(page.url()).searchParams.get("center") ?? "",
          );
          if (
            !Number.isFinite(viewportStart) ||
            !Number.isFinite(viewportEnd) ||
            !Number.isFinite(urlCenter)
          ) {
            return Number.POSITIVE_INFINITY;
          }
          return Math.abs(urlCenter - (viewportStart + viewportEnd) / 2);
        },
        { timeout: 15_000 },
      )
      .toBeLessThan(48 * 60 * 60 * 1_000);
    const centerBeforeEdit = Date.parse(
      new URL(page.url()).searchParams.get("center") ?? "",
    );
    await editForm.getByLabel("开始", { exact: true }).fill("2024-06-01T09:00");
    await editForm.getByLabel("结束", { exact: true }).fill("2024-06-02T09:00");
    await editForm
      .getByRole("button", { name: "保存基本信息", exact: true })
      .click();

    await expect(page.getByText("已更新投入详情")).toBeVisible();
    const editedExpandedStart = Date.parse("2024-04-01T00:00:00.000+08:00");
    await expect(editedCanvasRoot).toHaveAttribute(
      "data-range-start-ms",
      String(editedExpandedStart),
    );
    await expect
      .poll(
        async () =>
          (await editedCanvasRoot.getAttribute("data-loaded-ranges"))
            ?.split("|")
            .some((range) => range.startsWith(`${editedExpandedStart}:`)) ??
          false,
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect(editedCanvasRoot).toHaveAttribute("data-zoom", "MONTH");
    await expect
      .poll(
        () => {
          const centerAfterEdit = Date.parse(
            new URL(page.url()).searchParams.get("center") ?? "",
          );
          return Math.abs(centerAfterEdit - centerBeforeEdit);
        },
        { timeout: 15_000 },
      )
      .toBeLessThan(60 * 60 * 1_000);
    await expect
      .poll(() =>
        prisma.workSegment.findUnique({
          where: { id: createdSegment.id },
          select: { type: true, status: true, startAt: true, endAt: true },
        }),
      )
      .toEqual({
        type: "PLANNED",
        status: "PLANNED",
        startAt: new Date("2024-06-01T09:00:00.000+08:00"),
        endAt: new Date("2024-06-02T09:00:00.000+08:00"),
      });
    await expectHealthyPage(page);
  });

  test("Task workbench Today loads the current window without changing scale", async ({
      context,
      page,
      baseURL,
    }) => {
      const fixture = await createDraftWorkbenchFixture();
      const historicalTitle = `S6 Historical Today ${randomUUID()}`;
      const historicalTask = await createTaskDraft(actor(fixture.admin), {
        title: historicalTitle,
        description: "验证历史内容仍可定位今天",
        team: "英雄",
        techGroup: "电控",
        priority: "MEDIUM",
        members: [{ personId: fixture.owner.person.id, role: "OWNER" }],
        milestones: [{
          goal: "历史 Milestone",
          completionCriteria: "历史节点完成",
          expectedCompletedAt: "2020-02-01T10:00:00.000Z",
          reviewRequirements: "提交历史证据",
          businessDescription: "历史 Milestone",
        }],
        plannedStartAt: "2020-01-01T10:00:00.000Z",
        termination: {
          name: "Historical Terminal",
          plannedOutcomeCriteria: "历史任务结束",
          plannedAt: "2020-03-01T10:00:00.000Z",
          businessDescription: "历史结束确认",
        },
        idempotencyKey: `s6-historical-today-${randomUUID()}`,
      });
      await loginAsTestUser(context, baseURL, {
        openId: fixture.owner.openId,
        name: fixture.owner.person.displayName,
      });

      await page.goto(
        `/progress/tasks/${historicalTask.taskId}?center=${encodeURIComponent("2020-02-01T10:00:00.000Z")}`,
      );
      const canvasRoot = page.getByTestId("time-canvas-root");
      const nowBeforeNavigation = Date.now();
      expect(Number(await canvasRoot.getAttribute("data-range-end-ms")))
        .toBeLessThan(nowBeforeNavigation);
      await canvasRoot.getByRole("button", { name: "季", exact: true }).click();
      await expect(canvasRoot).toHaveAttribute("data-zoom", "QUARTER");

      await canvasRoot.getByRole("button", { name: "今天", exact: true }).click();
      await canvasRoot.getByRole("button", { name: "月", exact: true }).click();
      await expect.poll(() => {
        const center = Date.parse(new URL(page.url()).searchParams.get("center") ?? "");
        return Math.abs(center - Date.now());
      }).toBeLessThan(12 * 60 * 60 * 1_000);
      await expect.poll(async () => {
        const now = Date.now();
        const start = Number(await canvasRoot.getAttribute("data-range-start-ms"));
        const end = Number(await canvasRoot.getAttribute("data-range-end-ms"));
        return start <= now && now < end;
      }).toBe(true);
      await expect.poll(async () => {
        const now = Date.now();
        return (await canvasRoot.getAttribute("data-loaded-ranges"))
          ?.split("|")
          .some((value) => {
            const [start, end] = value.split(":").map(Number);
            return start <= now && now < end;
          }) ?? false;
      }).toBe(true);
      await expect(canvasRoot).toHaveAttribute("data-zoom", "MONTH");
      await expect.poll(() => new URL(page.url()).searchParams.get("scale"))
        .toBe("month");

      const historicalMilestoneMs = Date.parse("2020-02-01T10:00:00.000Z");
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /历史 Milestone/ })
        .click();
      await expect
        .poll(
          () => {
            const center = Date.parse(
              new URL(page.url()).searchParams.get("center") ?? "",
            );
            return Math.abs(center - historicalMilestoneMs);
          },
          { timeout: 15_000 },
        )
        .toBeLessThan(60_000);
      await expect.poll(async () => {
        const start = Number(await canvasRoot.getAttribute("data-viewport-start-ms"));
        const end = Number(await canvasRoot.getAttribute("data-viewport-end-ms"));
        return start <= historicalMilestoneMs && historicalMilestoneMs < end;
      }).toBe(true);

      await page.goBack();
      await expect.poll(async () => {
        const now = Date.now();
        const start = Number(await canvasRoot.getAttribute("data-viewport-start-ms"));
        const end = Number(await canvasRoot.getAttribute("data-viewport-end-ms"));
        return start <= now && now < end;
      }).toBe(true);
      await page.goForward();
      await expect
        .poll(
          () => {
            const center = Date.parse(
              new URL(page.url()).searchParams.get("center") ?? "",
            );
            return Math.abs(center - historicalMilestoneMs);
          },
          { timeout: 15_000 },
        )
        .toBeLessThan(60_000);
      await expect
        .poll(
          async () => {
            const start = Number(
              await canvasRoot.getAttribute("data-viewport-start-ms"),
            );
            const end = Number(
              await canvasRoot.getAttribute("data-viewport-end-ms"),
            );
            return start <= historicalMilestoneMs && historicalMilestoneMs < end;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
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
      ).toBeVisible();
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
      await page.getByRole("link", { name: "编辑 Task" }).click();
      const relatedPicker = page.getByLabel("关联 Task", { exact: true });
      await relatedPicker.fill(relatedTitle);
      await page
        .getByRole("option", { name: relatedTitle, exact: true })
        .click();
      const memberPicker = page.getByLabel("搜索参与人员", { exact: true });
      await memberPicker.fill(addedMember.person.displayName);
      await page
        .getByRole("option", {
          name: addedMember.person.displayName,
          exact: true,
        })
        .click();
      await page.getByRole("button", { name: "保存 Task" }).first().click();
      await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
      await expect
        .poll(async () => ({
          task: await prisma.task.findUnique({
            where: { id: fixture.taskId },
            select: { relatedTaskId: true, lockVersion: true },
          }),
          memberCount: await prisma.taskMember.count({
            where: {
              taskId: fixture.taskId,
              personId: addedMember.person.id,
              role: "PARTICIPANT",
              removedAt: null,
            },
          }),
        }))
        .toEqual({
          task: { relatedTaskId: related.taskId, lockVersion: 1 },
          memberCount: 1,
        });
      await page.getByRole("link", { name: "编辑 Task" }).click();
      await expect(relatedPicker).toHaveValue(relatedTitle);
      await expect(page.getByText(addedMember.person.displayName)).toBeVisible();
      await expectHealthyPage(page);
    });

  test("cancelling a rejected Revision keeps an unrelated Milestone gate", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createUiFixture();
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: fixture.taskId },
      select: { currentPlanVersionId: true, lockVersion: true },
    });
    const reason = `S6 不相关门禁 ${randomUUID()}`;
    const revision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: task.currentPlanVersionId,
      baseTaskLockVersion: task.lockVersion,
      reason,
      description: reason,
      revisionAt: "2026-07-31T12:00:00.000Z",
      replacementMilestones: [
        milestoneInput("S6 不相关门禁候选", "候选完成条件", 2),
      ],
      termination: terminationInput(5),
      idempotencyKey: `s6-unrelated-gate-revision-${randomUUID()}`,
    });
    await rejectRevision(actor(fixture.admin), {
      revisionNodeId: revision.revisionNodeId,
      comment: "保留为可取消的已驳回 Revision",
    });
    const activeMilestone = await prisma.milestoneNode.findUniqueOrThrow({
      where: { nodeId: fixture.activeNodeId },
      select: { id: true },
    });
    await prisma.milestoneReview.create({
      data: {
        milestoneNodeId: activeMilestone.id,
        result: "PENDING",
        submittedByAccountId: fixture.owner.account.id,
        idempotencyKey: `s6-unrelated-gate-review-${randomUUID()}`,
      },
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}?tab=revisions`);
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "Milestone",
    );
    const [overviewBox, approvalGateBox, timelineBox] = await Promise.all([
      page.getByTestId("task-overview").boundingBox(),
      page.getByTestId("task-approval-gate").boundingBox(),
      page.getByTestId("task-timeline-layer").boundingBox(),
    ]);
    if (!overviewBox || !approvalGateBox || !timelineBox) {
      throw new Error("无法读取 Task 审批门禁的布局位置");
    }
    expect(approvalGateBox.y).toBeGreaterThan(
      overviewBox.y + overviewBox.height,
    );
    expect(timelineBox.y).toBeGreaterThan(
      approvalGateBox.y + approvalGateBox.height,
    );
    await page.evaluate(() => {
      const browserWindow = window as Window & {
        __taskApprovalGateRemoved?: boolean;
        __taskApprovalGateObserver?: MutationObserver;
      };
      browserWindow.__taskApprovalGateRemoved = false;
      browserWindow.__taskApprovalGateObserver = new MutationObserver(
        (records) => {
          for (const record of records) {
            for (const removedNode of record.removedNodes) {
              if (
                removedNode instanceof Element &&
                (removedNode.matches('[data-testid="task-approval-gate"]') ||
                  removedNode.querySelector(
                    '[data-testid="task-approval-gate"]',
                  ))
              ) {
                browserWindow.__taskApprovalGateRemoved = true;
              }
            }
          }
        },
      );
      browserWindow.__taskApprovalGateObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
    const revisionCard = page
      .getByRole("heading", { name: "当前 Revision 候选" })
      .locator("../..");
    await expect(
      revisionCard.getByText(reason, { exact: true }).first(),
    ).toBeVisible();
    await expect(
      revisionCard.getByRole("button", { name: "修改并重新送审" }),
    ).toBeDisabled();
    await revisionCard.getByRole("button", { name: "取消 Revision" }).click();
    await expect(page.getByText("Revision 已取消。")).toBeVisible();
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "Milestone",
    );
    expect(
      await page.evaluate(() => {
        const browserWindow = window as Window & {
          __taskApprovalGateRemoved?: boolean;
          __taskApprovalGateObserver?: MutationObserver;
        };
        browserWindow.__taskApprovalGateObserver?.disconnect();
        return browserWindow.__taskApprovalGateRemoved;
      }),
    ).toBe(false);
    await expect(
      page.getByRole("heading", { name: "当前待审批验收" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "提交验收" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "申请结束 Task" }),
    ).toBeDisabled();
    await expectHealthyPage(page);
  });

  test("Task UI v2 edits active metadata in a dialog and exposes selected-node actions", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const fixture = await createUiFixture();
    const renamedTitle = `${fixture.taskTitle} · v2`;
    const longTerminationReason = `R${"R".repeat(1_499)}`;
    const longTerminationSummary = `S${"S".repeat(2_999)}`;
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
    await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(0);
    await page.getByRole("button", { name: "修改 Task 基本信息" }).click();
    const editor = page.getByRole("dialog", { name: "修改 Task 基本信息" });
    await expect(editor).toBeVisible();
    await expect(
      editor.getByLabel("搜索负责人", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByLabel("搜索参与人员", { exact: true }),
    ).toBeVisible();
    await expect(editor.getByLabel("新增成员角色")).toHaveCount(0);
    const editForm = editor.getByRole("form", { name: "修改 Task" });
    await editForm.getByLabel("标题").fill(renamedTitle);
    await expect(
      editForm.getByRole("button", { name: "保存修改" }),
    ).toHaveCount(1);
    await expect(
      editForm.getByRole("button", { name: /保存基本信息|保存 Tags|保存成员/ }),
    ).toHaveCount(0);
    await editForm.getByRole("button", { name: "保存修改" }).click();
    await expect(
      page.getByTestId("task-workbench-v2").getByText("Task 修改已保存。"),
    ).toBeVisible();
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { title: true },
        }),
      )
      .toEqual({ title: renamedTitle });
    await expect(editor).toHaveCount(0);

    await page.getByRole("button", { name: "修改 Task 基本信息" }).click();
    const staleEditor = page.getByRole("dialog", {
      name: "修改 Task 基本信息",
    });
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: {
        title: "其他用户并发保存的标题",
        lockVersion: { increment: 1 },
      },
    });
    await staleEditor.getByLabel("标题").fill("不应覆盖并发修改的标题");
    await staleEditor.getByRole("button", { name: "保存修改" }).click();
    await expect(staleEditor.getByRole("alert")).toContainText(
      "Task 已被他人修改，请刷新后重试",
    );
    await expect(staleEditor.getByRole("alert")).toContainText(
      "请关闭并重新打开编辑窗口",
    );
    await expect(
      staleEditor.getByRole("button", { name: "保存修改" }),
    ).toBeDisabled();
    await staleEditor.getByLabel("标题").press("Enter");
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { title: true },
        }),
      )
      .toEqual({ title: "其他用户并发保存的标题" });
    await page.keyboard.press("Escape");
    await expect(staleEditor).toHaveCount(0);

    await page
      .getByRole("textbox", { name: "文本证据" })
      .fill("Task UI v2 验收证据");
    await page.getByRole("button", { name: "提交验收" }).click();
    await expect(page.getByText("Milestone 已提交验收。")).toBeVisible();
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "Milestone",
    );

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByLabel("审批说明").fill("Task UI v2 管理员通过");
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await expect(page.getByText("验收已通过。")).toBeVisible();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.member.openId,
      name: fixture.member.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: /Terminal/ })
      .click();
    await expect(page.getByLabel("结束结果")).toBeVisible();
    await page.getByLabel("结束结果").selectOption("CANCELLED");
    await expect(page.getByLabel("原因")).toHaveAttribute("maxlength", "2000");
    await expect(page.getByLabel("总结")).toHaveAttribute("maxlength", "4000");
    await page.getByLabel("原因").fill(longTerminationReason);
    await page.getByLabel("总结").fill(longTerminationSummary);
    await page.getByRole("button", { name: "提交结束审批" }).click();
    await expect(page.getByText("Task 结束申请已提交审批。")).toBeVisible();
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "Terminal",
    );
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { status: true },
        }),
      )
      .toEqual({ status: "ACTIVE" });
    await expect(
      page.getByRole("heading", { name: "当前待审批结束申请" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "通过", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "驳回", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "要求修订", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: /Terminal/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "当前待审批结束申请" }),
    ).toBeVisible();
    await expect(page.getByLabel("审批说明")).toHaveAttribute(
      "maxlength",
      "2000",
    );
    await expect(page.getByRole("button", { name: "要求修订" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "驳回", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("审批说明").fill("请补充结束总结");
    await expect(page.getByRole("button", { name: "要求修订" })).toBeEnabled();
    await page.getByRole("button", { name: "要求修订" }).click();
    await expect(page.getByText("已要求修订 Task 结束申请。")).toBeVisible();
    await expect(page.getByText("上一轮结束申请需要修订")).toBeVisible();
    await expect(page.getByLabel("结束结果")).toHaveValue("CANCELLED");
    await expect(page.getByLabel("原因")).toHaveValue(longTerminationReason);
    await expect(page.getByLabel("总结")).toHaveValue(longTerminationSummary);
    await page.getByLabel("总结").fill("Task UI v2 已补充结束总结");
    await page.getByRole("button", { name: "提交结束审批" }).click();
    await expect(page.getByText("Task 结束申请已提交审批。")).toBeVisible();
    await expect(page.getByLabel("审批说明")).toHaveValue("");
    await page.getByLabel("审批说明").fill("本轮仍不通过");
    await page.getByRole("button", { name: "驳回" }).click();
    await expect(page.getByText("Task 结束申请已驳回。")).toBeVisible();
    await expect(page.getByText("上一轮结束申请已驳回")).toBeVisible();
    await expect(page.getByLabel("结束结果")).toHaveValue("CANCELLED");
    await expect(page.getByLabel("原因")).toHaveValue(longTerminationReason);
    await expect(page.getByLabel("总结")).toHaveValue(
      "Task UI v2 已补充结束总结",
    );
    await loginAsTestUser(context, baseURL, {
      openId: fixture.member.openId,
      name: fixture.member.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: /Terminal/ })
      .click();
    await expect(page.getByText("上一轮结束申请已驳回")).toBeVisible();
    await expect(page.getByLabel("总结")).toHaveValue(
      "Task UI v2 已补充结束总结",
    );
    await page.getByRole("button", { name: "提交结束审批" }).click();
    await expect(page.getByText("Task 结束申请已提交审批。")).toBeVisible();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: /Terminal/ })
      .click();
    await page.getByLabel("审批说明").fill("Task UI v2 管理员批准结束");
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await expect(page.getByText("Task 结束申请已通过。")).toBeVisible();
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { status: true },
        }),
      )
      .toEqual({ status: "CANCELLED" });
    await expect(page.getByText("上一轮结束申请已驳回")).toHaveCount(0);
    await expect(page.getByText("上一轮结束申请需要修订")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Task 风险", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Task 评论", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await expectHealthyPage(page);
  });

  test("Task UI v2 creates and resubmits a Revision through the vertical Composer", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const fixture = await createUiFixture();
    const firstReason = `S6 v2 Revision ${randomUUID()}`;
    const firstDescription = "第一次 Revision 的详细变更内容";
    const secondReason = `${firstReason} 二次送审`;
    const secondDescription = "根据审批意见调整后的 Revision 详细内容";
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("link", { name: "发起 Revision" }).click();
    await expect(page.getByTestId("task-composer")).toHaveAttribute(
      "data-composer-mode",
      "CREATE_REVISION",
    );
    await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
    const revisionTaskInfo = page.getByLabel("Task 基本信息");
    await expect(
      revisionTaskInfo.getByRole("heading", { name: "基本信息" }),
    ).toBeVisible();
    await expect(revisionTaskInfo.getByLabel("Task 名称")).toHaveValue(
      fixture.taskTitle,
    );
    await expect(revisionTaskInfo.getByLabel("Task 名称")).toBeDisabled();
    await expect(
      page.getByRole("heading", { name: "Revision 信息" }),
    ).toHaveCount(0);
    await expect(page.getByText("只读基线", { exact: true })).toHaveCount(0);
    await expect(page.getByText("问题列表", { exact: true })).toHaveCount(0);
    const currentRevisionButton = page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: /当前 Revision/ });
    await expect(currentRevisionButton).toHaveAttribute("aria-pressed", "true");
    const revisionInspector = page.getByLabel("计划节点检查器");
    await expect(
      revisionInspector.getByText("不可删除", { exact: true }),
    ).toBeVisible();
    await expect(revisionInspector.getByRole("alert")).toContainText(
      "请输入 Revision 名称",
    );
    await expect(revisionInspector.getByRole("alert")).toContainText(
      "请输入 Revision 详细内容",
    );
    await revisionInspector.getByLabel("Revision 名称").fill(firstReason);
    await revisionInspector
      .getByLabel("Revision 详细内容")
      .fill(firstDescription);
    await page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: new RegExp(firstReason) })
      .click();
    await page.getByLabel("Revision 时间").fill("2026-08-03T12:00");
    await expect(page.getByText(/^本地已保存/)).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByLabel("Revision 名称")).toHaveValue(firstReason);
    await expect(page.getByLabel("Revision 详细内容")).toHaveValue(
      firstDescription,
    );
    await page.getByRole("button", { name: "创建并送审" }).first().click();
    const firstRevisionCard = page
      .getByRole("heading", { name: "当前 Revision 候选" })
      .locator("../..");
    await expect(firstRevisionCard).toContainText(firstReason);
    await expect(firstRevisionCard).toContainText(firstDescription);
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "Revision",
    );

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByLabel("处理说明").fill("请调整候选计划");
    await page.getByRole("button", { name: "驳回" }).click();
    await expect(page.getByText("Revision 已驳回。")).toBeVisible();

    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("link", { name: "修改并重新送审" }).click();
    await expect(page.getByTestId("task-composer")).toHaveAttribute(
      "data-composer-mode",
      "RESUBMIT_REVISION",
    );
    await page.getByLabel("Revision 名称").fill(secondReason);
    await page.getByLabel("Revision 详细内容").fill(secondDescription);
    await page.getByRole("button", { name: "修改并重新送审" }).first().click();
    const secondRevisionCard = page
      .getByRole("heading", { name: "当前 Revision 候选" })
      .locator("../..");
    await expect(secondRevisionCard).toContainText(secondReason);
    await expect(secondRevisionCard).toContainText(secondDescription);
    await expect
      .poll(() =>
        prisma.revisionNode.findFirst({
          where: { node: { taskId: fixture.taskId } },
          orderBy: { node: { createdAt: "desc" } },
          select: {
            status: true,
            reviewRound: true,
            node: { select: { businessDescription: true } },
          },
        }),
      )
      .toEqual({
        status: "PENDING_APPROVAL",
        reviewRound: 2,
        node: { businessDescription: secondDescription },
      });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    const approvalCard = page
      .getByRole("heading", { name: "当前 Revision 候选" })
      .locator("../..");
    await approvalCard.getByLabel("处理说明").fill("同意应用修订计划");
    await approvalCard.getByRole("button", { name: "批准" }).click();
    await expect(page.getByText("Revision 已批准并应用。")).toBeVisible();
    await page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: new RegExp(secondReason) })
      .click();
    const selectedRevision = page.locator("#task-selected-node-detail");
    await expect(selectedRevision).toContainText(secondReason);
    await expect(selectedRevision).toContainText(secondDescription);
    await expectHealthyPage(page);
  });
});
