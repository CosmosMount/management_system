// @playwright-project ui
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { getResourcePlanPageData } from "../lib/project-management/queries/time-canvas-queries";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";
import {
  createSegment,
  createTask,
  createTaskOptionFixtures,
} from "./helpers/project-management-canvas-security-fixtures";

import {
  actor,
  createAccountPerson,
  createUiFixture,
  grantRole,
} from "./helpers/project-management-ui-fixtures";

test.describe("project management UI project-management-ui-resource-planner", () => {
  test.beforeAll(async () => {
      const administrator = await createAccountPerson(
        `S5 UI Global Approval Administrator ${randomUUID()}`,
      );
      await grantRole(administrator.account.id, "PROJECT_ADMINISTRATOR");
    });

  test("my work and Task workbench render rows beyond the retired Task and Person limits", async ({
      context,
      page,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      const fixture = await createUiFixture();
      const taskTitlePrefix = `ZZZ My timeline Task ${randomUUID()}`;
      const taskIds = await createTaskOptionFixtures({
        ownerAccountId: fixture.member.account.id,
        ownerPersonId: fixture.member.person.id,
        titlePrefix: taskTitlePrefix,
        count: 51,
      });
      const additionalMembers = Array.from({ length: 51 }, (_, index) => ({
        id: randomUUID(),
        displayName: `ZZZ Task workbench Person ${String(index).padStart(2, "0")} ${fixture.taskId}`,
      }));
      await prisma.person.createMany({
        data: additionalMembers.map((person) => ({
          id: person.id,
          displayName: person.displayName,
          status: "ACTIVE" as const,
        })),
      });
      await prisma.taskMember.createMany({
        data: additionalMembers.map((person) => ({
          taskId: fixture.taskId,
          personId: person.id,
          role: "PARTICIPANT" as const,
          createdByAccountId: fixture.member.account.id,
        })),
      });
      await loginAsTestUser(context, baseURL, {
        openId: fixture.member.openId,
        name: fixture.member.person.displayName,
      });

      const finalTaskTitle = `${taskTitlePrefix} 50`;
      await page.goto("/progress");
      await expect(
        page.getByRole("link", { name: finalTaskTitle, exact: true }),
      ).toBeVisible();
      await expectVirtualRowAtBottom(
        page,
        `timeline-row-plan:${taskIds[50]}`,
      );

      await page.goto(`/progress/tasks/${fixture.taskId}`);
      await expectVirtualRowAtBottom(
        page,
        `timeline-row-person:${additionalMembers[50]!.id}`,
      );
      await expect(
        page.getByLabel(`${additionalMembers[50]!.displayName} 时间行`, {
          exact: true,
        }),
      ).toBeVisible();
      await expectHealthyPage(page);
    });

  test("resource plan Task status filters keep selected people's complete investments", async ({
      context,
      page,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      const owner = await createAccountPerson(`资源计划状态 UI Owner ${randomUUID()}`);
      await grantRole(owner.account.id, "PROJECT_ADMINISTRATOR");
      const project = await prisma.project.create({
        data: {
          name: `资源计划状态 UI Project ${randomUUID()}`,
          description: "资源计划状态多选 UI 回归",
          status: "ACTIVE",
          requesterAccountId: owner.account.id,
          startedAt: new Date("2026-08-10T00:00:00.000Z"),
        },
      });
      const activeTaskTitle = `资源计划状态 UI 进行中 ${randomUUID()}`;
      const activeTask = await createTask({
        ownerAccountId: owner.account.id,
        title: activeTaskTitle,
        team: "英雄",
        techGroup: "电控",
        status: "ACTIVE",
        members: [{ personId: owner.person.id, role: "OWNER" }],
      });
      const completedTaskTitle = `资源计划状态 UI 已完成 ${randomUUID()}`;
      const completedTask = await createTask({
        ownerAccountId: owner.account.id,
        title: completedTaskTitle,
        team: "英雄",
        techGroup: "电控",
        status: "COMPLETED",
        members: [{ personId: owner.person.id, role: "OWNER" }],
      });
      await prisma.task.updateMany({
        where: { id: { in: [activeTask.taskId, completedTask.taskId] } },
        data: { projectId: project.id },
      });
      const completedTaskSegment = await createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        taskId: completedTask.taskId,
        type: "ACTUAL",
        status: "CONFIRMED",
        startAt: new Date("2026-08-10T10:00:00.000Z"),
        endAt: new Date("2026-08-10T11:00:00.000Z"),
        content: "已筛除 Task 的人员完整投入",
      });
      const partiallyConfirmableSegment = await createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        taskId: activeTask.taskId,
        type: "PLANNED",
        status: "PENDING_CONFIRMATION",
        startAt: new Date("2026-08-10T11:00:00.000Z"),
        endAt: new Date("2026-08-10T13:00:00.000Z"),
        content: "无需原因的部分确认计划",
      });
      const shortPartiallyConfirmableSegment = await createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        taskId: activeTask.taskId,
        type: "PLANNED",
        status: "PENDING_CONFIRMATION",
        startAt: new Date("2026-08-10T14:00:00.000Z"),
        endAt: new Date("2026-08-10T14:01:01.000Z"),
        content: "六十一秒部分确认计划",
      });
      await prisma.$transaction([
        prisma.workSegment.update({
          where: { id: partiallyConfirmableSegment.id },
          data: { expectedOutput: "部分确认计划预期输出" },
        }),
        prisma.workSegment.update({
          where: { id: shortPartiallyConfirmableSegment.id },
          data: { expectedOutput: "六十一秒计划预期输出" },
        }),
      ]);
      await loginAsTestUser(context, baseURL, {
        openId: owner.openId,
        name: owner.person.displayName,
      });

      await page.goto(
        `/progress/resources?all=0&people=${owner.person.id}&taskStatuses=COMPLETED&taskStatuses=ACTIVE`,
      );
      await expect.poll(() => {
        const values = new URL(page.url()).searchParams.getAll("taskStatuses");
        return values;
      }).toEqual(["ACTIVE,COMPLETED"]);

      await page.goto(
        `/progress/resources?all=0&people=${owner.person.id}&taskStatuses=UNKNOWN,DRAFT,DRAFT`,
      );
      await expect.poll(() =>
        new URL(page.url()).searchParams.get("taskStatuses"),
      ).toBe("DRAFT");
      await expect(page.getByText("已忽略无法识别的 Task 状态", { exact: true })).toBeVisible();
      await expect(page.getByText("已忽略重复的 Task 状态", { exact: true })).toBeVisible();
      await expect.poll(() =>
        new URL(page.url()).searchParams.has("taskStatusNotice"),
      ).toBe(false);

      await page.goto(
        `/progress/resources?all=0&projects=${project.id}&people=${owner.person.id}&focus=${completedTaskSegment.id}`,
      );
      const focusedDetail = page.getByRole("dialog", { name: "投入详情" });
      await expect(focusedDetail).toContainText("已筛除 Task 的人员完整投入");
      await expect(focusedDetail).toContainText(completedTaskTitle);
      await focusedDetail.getByRole("button", { name: "Close" }).click();
      const filterBar = page.getByRole("region", { name: "资源计划选择" });
      for (const statusLabel of [
        "草稿",
        "进行中",
        "已完成",
        "失败结束",
        "已取消",
        "已超时",
        "已归档",
      ]) {
        await expect(
          filterBar.getByRole("checkbox", { name: statusLabel, exact: true }),
        ).toBeVisible();
      }
      await expect(
        filterBar.getByRole("checkbox", { name: "草稿", exact: true }),
      ).toBeChecked();
      await expect(
        filterBar.getByRole("checkbox", { name: "进行中", exact: true }),
      ).toBeChecked();
      for (const statusLabel of [
        "已完成",
        "失败结束",
        "已取消",
        "已超时",
        "已归档",
      ]) {
        await expect(
          filterBar.getByRole("checkbox", { name: statusLabel, exact: true }),
        ).not.toBeChecked();
      }
      expect(new URL(page.url()).searchParams.has("taskStatuses")).toBe(false);
      await expect(
        page.getByTestId(`timeline-row-plan:${activeTask.taskId}`),
      ).toBeVisible();
      await expect(
        page.getByTestId(`timeline-row-plan:${completedTask.taskId}`),
      ).toHaveCount(0);

      const taskPicker = filterBar.getByRole("combobox", { name: "筛选 Task" });
      await taskPicker.fill(completedTaskTitle);
      await expect(page.getByText("没有匹配项。", { exact: true })).toBeVisible();
      await taskPicker.press("Escape");
      await filterBar.getByRole("checkbox", { name: "草稿", exact: true }).uncheck();
      await filterBar.getByRole("checkbox", { name: "进行中", exact: true }).uncheck();
      await expect(
        filterBar.getByRole("combobox", { name: "筛选 Project" }),
      ).toBeEnabled();
      await expect(taskPicker).toBeDisabled();
      await filterBar.getByRole("button", { name: "应用选择" }).click();
      await expect.poll(() => {
        const search = new URL(page.url()).searchParams;
        return {
          present: search.has("taskStatuses"),
          value: search.get("taskStatuses"),
        };
      }).toEqual({ present: true, value: "" });
      await expect(
        page.getByTestId(`timeline-row-plan:${activeTask.taskId}`),
      ).toHaveCount(0);
      await expect(
        page.getByTestId(`timeline-row-plan:${completedTask.taskId}`),
      ).toHaveCount(0);
      await expect(
        page.getByTestId(`timeline-row-person:${owner.person.id}`),
      ).toBeVisible();
      await expect(
        page.getByTestId(`segment-block-${completedTaskSegment.id}`),
      ).toBeVisible();

      const emptyFilterBar = page.getByRole("region", { name: "资源计划选择" });
      await emptyFilterBar
        .getByRole("checkbox", { name: "已完成", exact: true })
        .check();
      await emptyFilterBar.getByRole("button", { name: "应用选择" }).click();
      await expect.poll(() =>
        new URL(page.url()).searchParams.get("taskStatuses"),
      ).toBe("COMPLETED");
      await expect(
        page.getByTestId(`timeline-row-plan:${completedTask.taskId}`),
      ).toBeVisible();
      await expect(
        page.getByTestId(`timeline-row-plan:${activeTask.taskId}`),
      ).toHaveCount(0);
      const completedFilterBar = page.getByRole("region", { name: "资源计划选择" });
      const completedTaskPicker = completedFilterBar.getByRole("combobox", {
        name: "筛选 Task",
      });
      await completedTaskPicker.fill(completedTaskTitle);
      await expect(
        page.getByRole("option", { name: completedTaskTitle, exact: true }),
      ).toBeVisible();
      await completedTaskPicker.press("Escape");
      await page.getByRole("button", { name: "年", exact: true }).click();
      await expect.poll(() =>
        new URL(page.url()).searchParams.get("taskStatuses"),
      ).toBe("COMPLETED");
      await page.reload();
      await expect(
        page
          .getByRole("region", { name: "资源计划选择" })
          .getByRole("checkbox", { name: "已完成", exact: true }),
      ).toBeChecked();
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )).toBe(true);

      await page.goto(
        `/progress/resources?all=0&people=${owner.person.id}&focus=${partiallyConfirmableSegment.id}`,
      );
      const partialDialog = page.getByRole("dialog", { name: "投入详情" });
      const partialForm = partialDialog.getByRole("form", { name: "确认计划" });
      await expect(partialForm).toBeVisible();
      await expect(partialForm.getByLabel("部分确认原因")).toHaveCount(0);
      await expect(partialForm.getByLabel("预期输出")).toHaveCount(0);
      await expect(partialForm.getByText("部分确认计划预期输出")).toBeVisible();
      const partialContent = partialForm.getByLabel("实际投入内容");
      const partialActualOutput = partialForm.getByLabel("实际输出");
      const partialButton = partialForm.getByRole("button", {
        name: "部分确认",
        exact: true,
      });
      await partialContent.fill("");
      await partialButton.click();
      await expect(partialContent).toHaveAttribute("aria-invalid", "true");
      await expect(partialActualOutput).toHaveAttribute("aria-invalid", "true");
      await expect(partialContent).toBeFocused();
      await partialContent.fill("逐字段清错验证");
      await expect(partialContent).not.toHaveAttribute("aria-invalid", "true");
      await partialContent.fill("");
      await partialButton.click();
      await partialForm.getByRole("button", {
        name: "完整确认",
        exact: true,
      }).click();
      await expect(partialContent).not.toHaveAttribute("aria-invalid", "true");
      await expect(
        partialForm.getByRole("alert").filter({ hasText: "请输入实际投入内容" }),
      ).toHaveCount(0);
      await expect(partialActualOutput).toHaveAttribute("aria-invalid", "true");
      await expect(partialActualOutput).toBeFocused();
      await partialForm
        .getByLabel("确认结束", { exact: true })
        .fill("2026-08-10T20:00");
      await partialContent.fill("部分确认后的实际投入");
      await partialActualOutput.fill("部分确认实际输出");
      await partialButton.click();
      await expect(page.getByText("已确认计划前段并保留剩余计划")).toBeVisible();
      await expect.poll(async () => {
        const original = await prisma.workSegment.findUniqueOrThrow({
          where: { id: partiallyConfirmableSegment.id },
          select: { status: true },
        });
        const actual = await prisma.workSegment.findFirst({
          where: {
            type: "ACTUAL",
            personId: owner.person.id,
            content: "部分确认后的实际投入",
            actualSources: {
              some: { plannedSegmentId: partiallyConfirmableSegment.id },
            },
          },
          select: {
            startAt: true,
            endAt: true,
            expectedOutput: true,
            actualOutput: true,
          },
        });
        const remaining = await prisma.workSegment.findMany({
          where: { sourceSplitFromId: partiallyConfirmableSegment.id },
          select: {
            startAt: true,
            endAt: true,
            status: true,
            expectedOutput: true,
          },
        });
        return {
          originalStatus: original.status,
          actual: actual && {
            startAt: actual.startAt.toISOString(),
            endAt: actual.endAt.toISOString(),
            expectedOutput: actual.expectedOutput,
            actualOutput: actual.actualOutput,
          },
          remaining: remaining.map((segment) => ({
            startAt: segment.startAt.toISOString(),
            endAt: segment.endAt.toISOString(),
            status: segment.status,
            expectedOutput: segment.expectedOutput,
          })),
        };
      }).toEqual({
        originalStatus: "CANCELLED",
        actual: {
          startAt: "2026-08-10T11:00:00.000Z",
          endAt: "2026-08-10T12:00:00.000Z",
          expectedOutput: "部分确认计划预期输出",
          actualOutput: "部分确认实际输出",
        },
        remaining: [{
          startAt: "2026-08-10T12:00:00.000Z",
          endAt: "2026-08-10T13:00:00.000Z",
          status: "PENDING_CONFIRMATION",
          expectedOutput: "部分确认计划预期输出",
        }],
      });

      await page.goto(
        `/progress/resources?all=0&people=${owner.person.id}&focus=${shortPartiallyConfirmableSegment.id}`,
      );
      const shortDialog = page.getByRole("dialog", { name: "投入详情" });
      const shortForm = shortDialog.getByRole("form", { name: "确认计划" });
      const shortPartialButton = shortForm.getByRole("button", {
        name: "部分确认",
        exact: true,
      });
      await expect(shortPartialButton).toBeEnabled();
      await expect(shortForm.getByLabel("确认结束", { exact: true })).toHaveValue(
        "2026-08-10T22:01",
      );
      await shortForm.getByLabel("实际投入内容").fill("完成六十秒实际投入");
      await shortForm.getByLabel("实际输出").fill("完成六十秒实际输出");
      await shortPartialButton.click();
      await expect(page.getByText("已确认计划前段并保留剩余计划")).toBeVisible();
      await expect.poll(async () => {
        const actual = await prisma.workSegment.findFirst({
          where: {
            type: "ACTUAL",
            actualSources: {
              some: { plannedSegmentId: shortPartiallyConfirmableSegment.id },
            },
          },
          select: { startAt: true, endAt: true, expectedOutput: true },
        });
        const remaining = await prisma.workSegment.findMany({
          where: { sourceSplitFromId: shortPartiallyConfirmableSegment.id },
          select: { startAt: true, endAt: true, expectedOutput: true },
        });
        return {
          actual: actual && {
            startAt: actual.startAt.toISOString(),
            endAt: actual.endAt.toISOString(),
            expectedOutput: actual.expectedOutput,
          },
          remaining: remaining.map((segment) => ({
            startAt: segment.startAt.toISOString(),
            endAt: segment.endAt.toISOString(),
            expectedOutput: segment.expectedOutput,
          })),
        };
      }).toEqual({
        actual: {
          startAt: "2026-08-10T14:00:00.000Z",
          endAt: "2026-08-10T14:01:00.000Z",
          expectedOutput: "六十一秒计划预期输出",
        },
        remaining: [{
          startAt: "2026-08-10T14:01:00.000Z",
          endAt: "2026-08-10T14:01:01.000Z",
          expectedOutput: "六十一秒计划预期输出",
        }],
      });
      await expectHealthyPage(page);
    });

  test("resource plan Project selection fully assembles rows, focus pin and legacy URL stay stable", async ({
      context,
      page,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      const owner = await createAccountPerson(`Resource Plan UI Owner ${randomUUID()}`);
      await grantRole(owner.account.id, "PROJECT_ADMINISTRATOR");
      const projectName = `Resource Plan UI Project ${randomUUID()}`;
      const project = await prisma.project.create({
        data: {
          name: projectName,
          description: "资源计划 Project picker 与全量装配回归",
          status: "ACTIVE",
          requesterAccountId: owner.account.id,
          startedAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      });
      const taskRecords = Array.from({ length: 26 }, (_, index) => ({
        id: randomUUID(),
        planVersionId: randomUUID(),
        nodeId: randomUUID(),
        title: `000 Resource Plan UI Task ${String(index).padStart(2, "0")} ${project.id}`,
      }));
      const people = Array.from({ length: 51 }, (_, index) => ({
        id: randomUUID(),
        displayName: `000 Resource Plan UI Person ${String(index).padStart(2, "0")} ${project.id}`,
      }));
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
        await tx.task.createMany({
          data: taskRecords.map((record) => ({
            id: record.id,
            title: record.title,
            team: "英雄",
            techGroup: "电控",
            status: "ACTIVE" as const,
            currentPlanVersionId: record.planVersionId,
            projectId: project.id,
            createdByAccountId: owner.account.id,
            startedAt: new Date("2026-08-01T01:00:00.000Z"),
          })),
        });
        await tx.taskPlanVersion.createMany({
          data: taskRecords.map((record) => ({
            id: record.planVersionId,
            taskId: record.id,
            versionNo: 1,
            status: "CURRENT" as const,
            plannedStartAt: new Date("2026-08-01T01:00:00.000Z"),
            reason: "资源计划全量 UI fixture",
            createdByAccountId: owner.account.id,
            activatedAt: new Date("2026-08-01T01:00:00.000Z"),
          })),
        });
        await tx.taskNode.createMany({
          data: taskRecords.map((record) => ({
            id: record.nodeId,
            taskId: record.id,
            type: "TERMINATION" as const,
            status: "ACTIVE" as const,
            businessDescription: "资源计划全量 Terminal",
            createdByAccountId: owner.account.id,
          })),
        });
        await tx.terminationNode.createMany({
          data: taskRecords.map((record, index) => ({
            nodeId: record.nodeId,
            name: `Terminal ${String(index).padStart(2, "0")}`,
            plannedOutcomeCriteria: "完成资源计划全量验证",
            plannedAt: new Date("2026-08-02T01:00:00.000Z"),
          })),
        });
        await tx.planVersionNode.createMany({
          data: taskRecords.map((record) => ({
            planVersionId: record.planVersionId,
            nodeId: record.nodeId,
            sequence: 1,
          })),
        });
        await tx.taskMember.createMany({
          data: taskRecords.map((record) => ({
            taskId: record.id,
            personId: owner.person.id,
            role: "OWNER" as const,
            createdByAccountId: owner.account.id,
          })),
        });
        await tx.person.createMany({
          data: people.map((person) => ({ ...person, status: "ACTIVE" as const })),
        });
        await tx.projectMember.createMany({
          data: people.map((person) => ({
            projectId: project.id,
            personId: person.id,
            role: "PARTICIPANT" as const,
            createdByAccountId: owner.account.id,
          })),
        });
      });
      const focusSegment = await prisma.workSegment.create({
        data: {
          personId: people[50]!.id,
          type: "PLANNED",
          status: "PLANNED",
          startAt: new Date("2026-08-10T01:00:00.000Z"),
          endAt: new Date("2026-08-10T02:00:00.000Z"),
          content: "资源计划 50 项外部焦点",
          expectedOutput: "焦点人员固定在第一页",
          createdByAccountId: owner.account.id,
        },
      });
      const terminalPlannedSegments = await Promise.all([
        prisma.workSegment.create({ data: {
          personId: people[0]!.id,
          taskId: taskRecords[0]!.id,
          type: "PLANNED",
          status: "CANCELLED",
          startAt: new Date("2026-08-11T01:00:00.000Z"),
          endAt: new Date("2026-08-11T02:00:00.000Z"),
          content: "资源计划隐藏已取消 Planned",
          expectedOutput: "已取消记录仍可审计",
          createdByAccountId: owner.account.id,
        } }),
        prisma.workSegment.create({ data: {
          personId: people[0]!.id,
          taskId: taskRecords[0]!.id,
          type: "PLANNED",
          status: "CONFIRMED",
          startAt: new Date("2026-08-11T02:00:00.000Z"),
          endAt: new Date("2026-08-11T03:00:00.000Z"),
          content: "资源计划隐藏已确认 Planned",
          expectedOutput: "已确认记录仍可审计",
          createdByAccountId: owner.account.id,
        } }),
      ]);
      const deletedTaskPlannedSegment = await prisma.workSegment.create({
        data: {
          personId: people[0]!.id,
          taskId: taskRecords[0]!.id,
          type: "PLANNED",
          status: "PLANNED",
          startAt: new Date("2026-08-12T01:00:00.000Z"),
          endAt: new Date("2026-08-12T02:00:00.000Z"),
          content: "资源计划保留已删除 Task 的有效 Planned",
          expectedOutput: "有效历史投入仍可定位",
          createdByAccountId: owner.account.id,
        },
      });
      const resourceData = await getResourcePlanPageData({
        actor: actor(owner),
        input: {
          all: false,
          projectIds: [project.id],
          taskIds: [],
          personIds: [],
        },
        preferredCenterMs: Date.parse("2026-08-11T01:30:00.000Z"),
        load: { mode: "INITIAL" },
      });
      const resourceSegmentIds = resourceData.data.segments.flatMap((segment) =>
        segment.kind === "SEGMENT" ? [segment.id] : [],
      );
      expect(resourceSegmentIds).toContain(deletedTaskPlannedSegment.id);
      for (const segment of terminalPlannedSegments) {
        expect(resourceSegmentIds).not.toContain(segment.id);
      }
      await loginAsTestUser(context, baseURL, {
        openId: owner.openId,
        name: owner.person.displayName,
      });

      await page.goto(`/progress/resources?all=0&focus=${focusSegment.id}`);
      const independentDetail = page.getByRole("dialog", { name: "投入详情" });
      await expect(independentDetail).toContainText(
        "资源计划 50 项外部焦点",
      );
      await expect(independentDetail.getByText("关联 Task", { exact: true })).toBeVisible();
      await expect(independentDetail.getByText("独立投入", { exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.has("people")).toBe(false);
      await independentDetail
        .getByRole("button", { name: "Close" }).click();

      await page.goto("/progress/resources?all=0");
      await page.getByRole("checkbox", { name: /显示全部资源/ }).uncheck();
      await page.getByRole("combobox", { name: "筛选 Project" }).fill(projectName);
      await page.getByRole("option", { name: projectName, exact: true }).click();
      await page.getByRole("button", { name: "应用选择" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("projects")).toBe(project.id);
      await expect(page.getByText("Project（1）")).toBeVisible();
      await expect(page.getByRole("link", { name: "下一页 Task" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "下一页人员" })).toHaveCount(0);
      await page.getByTestId("time-canvas-scroll").evaluate((element) => {
        element.scrollTop = 25 * 112;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect(page.getByTestId(`timeline-row-plan:${taskRecords[25]!.id}`)).toBeVisible();
      for (const segment of terminalPlannedSegments) {
        await expect(page.getByTestId(`segment-block-${segment.id}`)).toHaveCount(0);
      }
      await page.getByTestId("time-canvas-scroll").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect(page.getByTestId(`timeline-row-person:${people[50]!.id}`)).toBeVisible();
      await page.reload();
      await expect(page.getByText("Project（1）")).toBeVisible();
      await expect(page.getByLabel(projectName, { exact: true })).toBeVisible();

      await prisma.task.update({
        where: { id: taskRecords[0]!.id },
        data: { deletedAt: new Date() },
      });
      await page.goto(
        `/progress/resources?all=0&focus=${deletedTaskPlannedSegment.id}`,
      );
      await expect(page.getByRole("dialog", { name: "投入详情" })).toContainText(
        "资源计划保留已删除 Task 的有效 Planned",
      );
      const deletedTaskDetail = page.getByRole("dialog", { name: "投入详情" });
      await expect(deletedTaskDetail.getByText("关联 Task", { exact: true })).toBeVisible();
      await expect(
        deletedTaskDetail.getByText(`${taskRecords[0]!.title}（已删除）`, {
          exact: true,
        }).first(),
      ).toBeVisible();
      await expect(
        deletedTaskDetail.getByRole("link", {
          name: taskRecords[0]!.title,
          exact: true,
        }),
      ).toHaveCount(0);
      await deletedTaskDetail
        .getByRole("button", { name: "Close" }).click();

      const explicitPeople = people.slice(0, 50).map((person) => person.id);
      await page.goto(
        `/progress/resources?all=0&people=${explicitPeople.join(",")}&focus=${focusSegment.id}`,
      );
      await expect(page.getByText("人员（50）")).toBeVisible();
      await expect(page.getByLabel(`${people[50]!.displayName} 时间行`, { exact: true })).toBeVisible();
      const focusedUrl = new URL(page.url());
      expect(focusedUrl.searchParams.get("people")?.split(",")).not.toContain(people[50]!.id);
      await page.getByRole("dialog", { name: "投入详情" }).getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: "应用选择" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.has("focus")).toBe(false);
      expect(new Set(new URL(page.url()).searchParams.get("people")?.split(","))).toEqual(
        new Set(explicitPeople),
      );

      await page.goto(
        `/progress/resources?all=0&tags=legacy&from=2026-08-10&to=2026-08-12&group=person&types=PLANNED&statuses=ACTIVE&zoom=hour&start=2026-08-01&end=2026-09-01&personId=${people[0]!.id}&taskId=${taskRecords[0]!.id}&timelineDate=2026-08-03&timelineFocus=${focusSegment.id}&focusSegmentIds=${focusSegment.id}`,
      );
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (value: string) => {
              window.sessionStorage.setItem("resource-plan-copied-url", value);
            },
          },
        });
      });
      await page.getByRole("button", { name: "复制视图链接" }).click();
      const copiedUrl = new URL(await page.evaluate(() =>
        window.sessionStorage.getItem("resource-plan-copied-url") ?? "",
      ));
      for (const key of ["tags", "from", "to", "group", "types", "statuses", "zoom", "start", "end", "personId", "taskId", "timelineDate", "timelineFocus", "focusSegmentIds"]) {
        expect(copiedUrl.searchParams.has(key), `复制链接仍包含 ${key}`).toBe(false);
      }
      await page.getByRole("button", { name: "年", exact: true }).click();
      await expect(page).toHaveURL(/scale=year/);
      for (const key of ["tags", "from", "to", "group", "types", "statuses", "zoom", "start", "end", "personId", "taskId", "timelineDate", "timelineFocus", "focusSegmentIds"]) {
        expect(new URL(page.url()).searchParams.has(key), `导航后仍包含 ${key}`).toBe(false);
      }
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )).toBe(true);

      const expectedCanonicalPeople = people.map((person) => person.id).sort();
      const missingId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      await page.goto(
        `/progress/resources?all=0&projects=${project.id.toUpperCase()}&tasks=${taskRecords[1]!.id.toUpperCase()}&people=${people[1]!.id.toUpperCase()}`,
      );
      await expect.poll(() => {
        const search = new URL(page.url()).searchParams;
        return {
          projects: search.get("projects"),
          tasks: search.get("tasks"),
          people: search.get("people"),
        };
      }).toEqual({
        projects: project.id,
        tasks: taskRecords[1]!.id,
        people: people[1]!.id,
      });
      await expect(page.getByText("Project（1）")).toBeVisible();
      await expect(page.getByText("Task（1）")).toBeVisible();
      await expect(page.getByText("人员（1）")).toBeVisible();

      await page.goto(
        `/progress/resources?all=0&people=${[
          ...people.map((person) => person.id).reverse(),
          people[0]!.id,
          missingId,
          "not-a-uuid",
        ].join(",")}&tasks=${missingId}&projects=${missingId}`,
      );
      await expect.poll(() => new URL(page.url()).searchParams.get("people")).toBe(
        expectedCanonicalPeople.join(","),
      );
      expect(new URL(page.url()).searchParams.has("tasks")).toBe(false);
      expect(new URL(page.url()).searchParams.has("projects")).toBe(false);

      await page.goto(
        `/progress/resources?all=0&people=${people[0]!.id}&center=2000-01-01T00:00:00.000Z&scale=year`,
      );
      await expect.poll(() => {
        const center = Date.parse(new URL(page.url()).searchParams.get("center") ?? "");
        return center > Date.parse("2025-01-01T00:00:00.000Z");
      }).toBe(true);
      await expectHealthyPage(page);
    });

  test("S7 resource filters, removed routes and unified my-work timeline work on desktop and mobile", async ({
      context,
      page,
      baseURL,
    }, testInfo) => {
      test.setTimeout(90_000);
      const fixture = await createUiFixture();
      const paginationKey = randomUUID();
      await prisma.person.createMany({
        data: Array.from({ length: 55 }, (_, index) => ({
          displayName: `000 S7 resource pagination ${String(index).padStart(2, "0")} ${paginationKey}`,
          status: "ACTIVE" as const,
        })),
      });
      await prisma.workSegment.update({
        where: { id: fixture.confirmableSegmentId },
        data: { status: "PENDING_CONFIRMATION" },
      });
      await prisma.workSegmentChange.createMany({
        data: Array.from({ length: 21 }, (_, index) => ({
          segmentId: fixture.confirmableSegmentId,
          action: "UPDATE" as const,
          before: { content: `分页前内容 ${index}` },
          after: { content: `分页后内容 ${index}` },
          reason: `历史分页回归 ${index}`,
          actorAccountId: fixture.member.account.id,
          createdAt: new Date(Date.UTC(2026, 7, 11, 5, index)),
        })),
      });
      await prisma.workSegmentChange.deleteMany({
        where: { segmentId: fixture.movableSegmentId },
      });
      await loginAsTestUser(context, baseURL, {
        openId: fixture.member.openId,
        name: fixture.member.person.displayName,
      });

      await page.goto("/progress?taskCursor=invalid-cursor");
      await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
      await expect.poll(() => new URL(page.url()).searchParams.has("taskCursor")).toBe(false);
      await page.goto("/progress?scale=month");
      await expect(page.getByTestId("time-canvas-root")).toHaveAttribute("data-zoom", "MONTH");
      await page.goto("/progress?scale=year");
      await expect(page.getByTestId("time-canvas-root")).toHaveAttribute("data-zoom", "YEAR");
      await page.goBack();
      await expect(page).toHaveURL(/scale=month/);
      await expect(page.getByTestId("time-canvas-root")).toHaveAttribute("data-zoom", "MONTH");

      let releaseInitialHistoryRequest = () => {};
      const heldInitialHistoryRequest = new Promise<void>((resolve) => {
        releaseInitialHistoryRequest = resolve;
      });
      let abortedInitialHistoryRequest = false;
      const abortInitialHistoryRequest = async (
        route: import("@playwright/test").Route,
      ) => {
        const body = route.request().postData() ?? "";
        if (
          !abortedInitialHistoryRequest &&
          route.request().method() === "POST" &&
          body.includes("limit")
        ) {
          abortedInitialHistoryRequest = true;
          await heldInitialHistoryRequest;
          await route.abort();
          return;
        }
        await route.continue();
      };
      await page.route("**/progress/resources**", abortInitialHistoryRequest);
      await page.goto(`/progress/resources?all=0&focus=${fixture.movableSegmentId}`);
      const emptyHistoryInspector = page.getByTestId("segment-inspector");
      await expect(emptyHistoryInspector.getByText("正在加载变更历史…")).toBeVisible();
      releaseInitialHistoryRequest();
      await expect(
        emptyHistoryInspector.getByText(/变更历史加载失败：网络异常/),
      ).toBeVisible();
      await page.unroute("**/progress/resources**", abortInitialHistoryRequest);
      await emptyHistoryInspector.getByRole("button", { name: "重试历史" }).click();
      await expect(emptyHistoryInspector.getByText("暂无可见变更。")).toBeVisible();

      await page.goto(`/progress/resources?all=0&focus=${fixture.confirmableSegmentId}`);
      const initialInspector = page.getByTestId("segment-inspector");
      await expect(initialInspector).toContainText(
        "P6 UI 可确认计划",
      );
      const loadMoreHistory = initialInspector.getByRole("button", {
        name: "加载更多变更",
      });
      await expect(loadMoreHistory).toBeVisible();
      let releaseHistoryRequest = () => {};
      const heldHistoryRequest = new Promise<void>((resolve) => {
        releaseHistoryRequest = resolve;
      });
      let abortedHistoryRequest = false;
      const abortHeldHistoryRequest = async (
        route: import("@playwright/test").Route,
      ) => {
        if (!abortedHistoryRequest && route.request().method() === "POST") {
          abortedHistoryRequest = true;
          await heldHistoryRequest;
          await route.abort();
          return;
        }
        await route.continue();
      };
      await page.route("**/progress/resources**", abortHeldHistoryRequest);
      await loadMoreHistory.click();
      await expect(
        initialInspector.getByRole("button", { name: "正在加载更多变更…" }),
      ).toBeVisible();
      releaseHistoryRequest();
      await expect(initialInspector.getByText(/变更历史加载失败：网络异常/)).toBeVisible();
      await page.unroute("**/progress/resources**", abortHeldHistoryRequest);
      await initialInspector.getByRole("button", { name: "重试历史" }).click();
      await expect(initialInspector.getByText("已加载全部变更。")).toBeVisible();

      await page.goto(`/progress/resources?all=0&focus=${randomUUID()}`);
      await expect(page).toHaveURL(/focusError=1/);
      await expect(page.getByText(
        "无法定位该时间对象，请确认链接仍然有效且你有权查看。",
      )).toBeVisible();

      await page.goto(
        "/progress/resources?all=0&from=2026-08-10&to=2026-08-12&group=person&taskCursor=old-task&personCursor=old-person",
      );
      await expect.poll(() => new URL(page.url()).searchParams.has("taskCursor")).toBe(false);
      expect(new URL(page.url()).searchParams.has("personCursor")).toBe(false);
      await page.getByRole("button", { name: "年", exact: true }).click();
      await expect(page).toHaveURL(/scale=year/);
      await expect
        .poll(() => new URL(page.url()).searchParams.get("center"))
        .not.toBeNull();

      await page.goto(
        `/progress/resources?all=0&people=${fixture.member.person.id},${fixture.owner.person.id}&tasks=${fixture.taskId}&focus=${fixture.confirmableSegmentId}`,
      );
      const detailDialog = page.getByRole("dialog", { name: "投入详情" });
      await expect(detailDialog.getByTestId("segment-inspector")).toContainText(
        "P6 UI 可确认计划",
      );
      await expect(
        detailDialog.getByRole("form", { name: "确认计划" }),
      ).toBeVisible();
      await expect(detailDialog.getByLabel("部分确认原因")).toHaveCount(0);
      await detailDialog.getByRole("button", { name: "Close" }).click();
      await expect(detailDialog).toHaveCount(0);
      await expect
        .poll(() => new URL(page.url()).searchParams.has("focus"))
        .toBe(false);
      await expect(page.getByRole("heading", { name: "资源计划" })).toBeVisible();
      await expect(page.getByRole("region", { name: "资源计划选择" })).toBeVisible();
      await expect(page.getByText("人员（2）")).toBeVisible();
      await expect(page.getByText("Task（1）")).toBeVisible();
      await expect(page.getByRole("checkbox", { name: /显示全部资源/ })).not.toBeChecked();
      const centerBeforeYearScale = new URL(page.url()).searchParams.get("center");
      expect(centerBeforeYearScale).not.toBeNull();
      await page.getByRole("button", { name: "年", exact: true }).click();
      await expect(page).toHaveURL(/scale=year/);
      await expect
        .poll(() => new URL(page.url()).searchParams.get("center"))
        .not.toBe(centerBeforeYearScale);
      const preservedCenter = new URL(page.url()).searchParams.get("center");
      expect(preservedCenter).not.toBeNull();
      await page.getByRole("button", {
        name: `移除${fixture.owner.person.displayName}`,
      }).click();
      await page.getByRole("combobox", { name: "筛选人员" }).press("Escape");
      await page.getByRole("button", { name: "应用选择" }).click();
      await expect(page).toHaveURL(/all=0/);
      await expect(page).toHaveURL(/scale=year/);
      expect(new URL(page.url()).searchParams.get("center")).toBe(preservedCenter);
      await expect(page.getByText("人员（1）")).toBeVisible();
      await page.getByRole("button", { name: "复制视图链接" }).click();
      await expect(page.getByText(/已复制当前资源计划链接|无法访问剪贴板/)).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "季", exact: true }).click();
      await expect(page).toHaveURL(/scale=quarter/);
      const pendingSegment = page.getByTestId(
        `segment-block-${fixture.confirmableSegmentId}`,
      );
      await expect(pendingSegment).toBeVisible();
      await pendingSegment.focus();
      await pendingSegment.press("Enter");
      const dirtyInspector = page.getByRole("form", { name: "编辑投入详情" });
      await expect(dirtyInspector).toBeVisible();
      const unsavedContent = `未保存的历史导航内容 ${randomUUID()}`;
      await dirtyInspector.getByLabel("内容").fill(unsavedContent);
      if (testInfo.project.name === "desktop") {
        await page.goBack();
        await expect(dirtyInspector.getByLabel("内容")).toHaveValue(unsavedContent);
        await expect(
          page.getByText("当前投入有未保存修改，请保存或关闭后再切换时间窗口。"),
        ).toBeVisible();
      } else {
        await expect(dirtyInspector.getByLabel("内容")).toHaveValue(unsavedContent);
      }
      await expectHealthyPage(page);
      let discardConfirmationSeen = false;
      page.once("dialog", async (dialog) => {
        discardConfirmationSeen = true;
        await dialog.accept();
      });
      await detailDialog.getByRole("button", { name: "Close" }).click();
      await expect.poll(() => discardConfirmationSeen).toBe(true);
      await expect
        .poll(() => new URL(page.url()).searchParams.has("focus"))
        .toBe(false);
      await page.waitForLoadState("networkidle");
      await expect(detailDialog).toHaveCount(0);

      const removedConflictPage = await page.goto("/progress/resources/conflicts");
      expect(removedConflictPage?.status()).toBe(404);
      const removedTagPage = await page.goto("/progress/tags");
      expect(removedTagPage?.status()).toBe(404);

      await page.goto(`/progress?focus=${fixture.confirmableSegmentId}`);
      await expect(page.getByTestId("segment-inspector")).toContainText(
        "P6 UI 可确认计划",
        { timeout: 15_000 },
      );
      await detailDialog.getByRole("button", { name: "Close" }).click();
      await expect(detailDialog).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
      const dueQueue = page.getByRole("region", { name: "到期计划与确认队列" });
      await expect(dueQueue.getByRole("heading", { name: "到期计划与确认队列" })).toBeVisible();
      await expect(dueQueue.getByText("P6 UI 可确认计划")).toBeVisible();
      await expect(page.getByTestId("time-canvas-scroll")).toBeVisible();
      await dueQueue.getByRole("link", { name: "处理" }).click();
      await expect(page.getByTestId("segment-inspector")).toContainText(
        "P6 UI 可确认计划",
      );
      const confirmationForm = page
        .getByTestId("segment-inspector")
        .getByRole("form", { name: "确认计划" });
      const actualOutput = confirmationForm.getByLabel("实际输出");
      await expect(actualOutput).not.toHaveAttribute("aria-invalid", "true");
      await confirmationForm.getByRole("button", { name: "完整确认" }).click();
      await expect(actualOutput).toHaveAttribute("aria-invalid", "true");
      await expect(actualOutput).toBeFocused();
      await expect(
        confirmationForm.getByRole("alert").filter({ hasText: "请输入实际输出" }),
      ).toBeVisible();
      await actualOutput.fill("P6 UI 到期计划实际产出");
      await expect(actualOutput).not.toHaveAttribute("aria-invalid", "true");
      await confirmationForm.getByRole("button", { name: "完整确认" }).click();
      await expect(page.getByText("已完整确认并生成 Actual")).toBeVisible();
      await expect(detailDialog).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).searchParams.has("focus")).toBe(false);
      await expect(dueQueue.getByText("P6 UI 可确认计划")).toHaveCount(0);
      await expect.poll(() => prisma.workSegment.findUnique({
        where: { id: fixture.confirmableSegmentId },
        select: { status: true },
      })).toEqual({ status: "CONFIRMED" });
      await expect.poll(() => prisma.workSegment.findFirst({
        where: {
          type: "ACTUAL",
          actualSources: { some: { plannedSegmentId: fixture.confirmableSegmentId } },
        },
        select: { expectedOutput: true, actualOutput: true },
      })).toEqual({
        expectedOutput: "P6 UI 计划预期产出",
        actualOutput: "P6 UI 到期计划实际产出",
      });

      const independentContent = `S7 独立安排 ${randomUUID()}`;
      await page.getByRole("button", { name: "新增投入" }).click();
      const quickCreate = page.getByRole("form", { name: "投入快速创建" });
      await expect(
        quickCreate.locator('input[type="hidden"][name="taskId"]'),
      ).toHaveValue("");
      const quickContent = quickCreate.getByLabel("内容");
      await expect(quickContent).toHaveValue("");
      await expect(quickContent).not.toHaveAttribute("aria-invalid", "true");
      await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
      await expect(quickContent).toHaveAttribute("aria-invalid", "true");
      await expect(quickContent).toBeFocused();
      await expect(quickCreate.getByRole("alert").filter({ hasText: "请输入工作内容" })).toBeVisible();
      await quickContent.fill(independentContent);
      await expect(quickContent).not.toHaveAttribute("aria-invalid", "true");
      await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
      await expect(page.getByText("已创建投入记录")).toBeVisible();
      await expect.poll(() => prisma.workSegment.count({
        where: { personId: fixture.member.person.id, taskId: null, content: independentContent },
      })).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await expectHealthyPage(page);
    });
});

async function expectVirtualRowAtBottom(page: Page, testId: string) {
  const row = page.getByTestId(testId);
  await expect.poll(
    async () => {
      await page.getByTestId("time-canvas-scroll").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      return row.count();
    },
    { timeout: 10_000 },
  ).toBe(1);
  await expect(row).toBeVisible();
}
