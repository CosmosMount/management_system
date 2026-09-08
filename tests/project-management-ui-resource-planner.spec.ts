// @playwright-project ui
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  softDeleteWorkSegment,
  updateWorkSegment,
} from "../lib/project-management/application/segment-service";
import { shanghaiDateTimeLocalToIso } from "../lib/project-management/date-time";
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
        startAt: new Date("2026-08-10T10:00:00.000Z"),
        endAt: new Date("2026-08-10T11:00:00.000Z"),
        content: "已筛除 Task 的人员完整投入",
      });
      const editableSegment = await createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        taskId: activeTask.taskId,
        startAt: new Date("2026-08-10T11:00:00.000Z"),
        endAt: new Date("2026-08-10T13:00:00.000Z"),
        content: "过去的普通投入记录",
      });
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

      const taskPicker = filterBar.getByRole("combobox", { name: "筛选任务" });
      await taskPicker.fill(completedTaskTitle);
      await expect(page.getByText("没有匹配项。", { exact: true })).toBeVisible();
      await taskPicker.press("Escape");
      await filterBar.getByRole("checkbox", { name: "草稿", exact: true }).uncheck();
      await filterBar.getByRole("checkbox", { name: "进行中", exact: true }).uncheck();
      await expect(
        filterBar.getByRole("combobox", { name: "筛选项目" }),
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
        name: "筛选任务",
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
        `/progress/resources?all=0&people=${owner.person.id}&focus=${editableSegment.id}`,
      );
      const detailDialog = page.getByRole("dialog", { name: "投入详情" });
      const editForm = detailDialog.getByRole("form", { name: "编辑投入详情" });
      await expect(editForm).toBeVisible();
      await expectRetiredSegmentControlsAbsent(detailDialog);
      await editForm.getByLabel("内容", { exact: true }).fill("");
      await editForm.getByRole("button", { name: "保存基本信息" }).click();
      await expect(editForm.getByLabel("内容", { exact: true })).toHaveAttribute("aria-invalid", "true");
      await expect(editForm.getByLabel("内容", { exact: true })).toBeFocused();
      const updatedContent = `普通投入更新 ${randomUUID()} ${"LongUnbrokenContent".repeat(90)}`;
      await editForm.getByLabel("内容", { exact: true }).fill(updatedContent);
      await editForm.getByLabel("开始", { exact: true }).fill("2026-08-10T19:15");
      await editForm.getByLabel("结束", { exact: true }).fill("2026-08-10T18:00");
      await editForm.getByRole("button", { name: "保存基本信息" }).click();
      await expect(editForm.getByLabel("开始", { exact: true })).toBeFocused();
      expect((await prisma.workSegment.findUniqueOrThrow({ where: { id: editableSegment.id } })).endAt).toEqual(editableSegment.endAt);
      await editForm.getByLabel("结束", { exact: true }).fill("2026-08-10T20:15");
      await editForm.getByRole("button", { name: "保存基本信息" }).click();
      await expect(page.getByText("已更新投入详情")).toBeVisible();
      await expect(detailDialog).toHaveCount(0);
      await expect.poll(() => prisma.workSegment.findUniqueOrThrow({
        where: { id: editableSegment.id },
        select: { content: true, personId: true, taskId: true, startAt: true, endAt: true },
      })).toEqual({
        content: updatedContent,
        personId: owner.person.id,
        taskId: activeTask.taskId,
        startAt: new Date("2026-08-10T11:15:00.000Z"),
        endAt: new Date("2026-08-10T12:15:00.000Z"),
      });
      await page.goto(`/progress/resources?all=0&focus=${editableSegment.id}`);
      await expect(detailDialog.getByRole("heading", { name: updatedContent, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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
          startAt: new Date("2026-08-10T01:00:00.000Z"),
          endAt: new Date("2026-08-10T02:00:00.000Z"),
          content: "资源计划 50 项外部焦点",
          createdByAccountId: owner.account.id,
        },
      });
      const deletedSegments = await Promise.all([
        prisma.workSegment.create({ data: {
          personId: people[0]!.id,
          taskId: taskRecords[0]!.id,
          deletedAt: new Date(),
          startAt: new Date("2026-08-11T01:00:00.000Z"),
          endAt: new Date("2026-08-11T02:00:00.000Z"),
          content: "资源计划隐藏已删除投入一",
          createdByAccountId: owner.account.id,
        } }),
        prisma.workSegment.create({ data: {
          personId: people[0]!.id,
          taskId: taskRecords[0]!.id,
          deletedAt: new Date(),
          startAt: new Date("2026-08-11T02:00:00.000Z"),
          endAt: new Date("2026-08-11T03:00:00.000Z"),
          content: "资源计划隐藏已删除投入二",
          createdByAccountId: owner.account.id,
        } }),
      ]);
      const deletedTaskSegment = await prisma.workSegment.create({
        data: {
          personId: people[0]!.id,
          taskId: taskRecords[0]!.id,
          startAt: new Date("2026-08-12T01:00:00.000Z"),
          endAt: new Date("2026-08-12T02:00:00.000Z"),
          content: "资源计划保留已删除 Task 的有效投入",
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
      expect(resourceSegmentIds).toContain(deletedTaskSegment.id);
      for (const segment of deletedSegments) {
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
      await expect(independentDetail.getByRole("term").filter({ hasText: /^关联任务$/ })).toBeVisible();
      await expect(independentDetail.getByText("独立投入", { exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.has("people")).toBe(false);
      await independentDetail
        .getByRole("button", { name: "Close" }).click();

      await page.goto("/progress/resources?all=0");
      await page.getByRole("checkbox", { name: /显示全部资源/ }).uncheck();
      await page.getByRole("combobox", { name: "筛选项目" }).fill(projectName);
      await page.getByRole("option", { name: projectName, exact: true }).click();
      await page.getByRole("button", { name: "应用选择" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("projects")).toBe(project.id);
      await expect(page.getByText("项目（1）")).toBeVisible();
      await expect(page.getByRole("link", { name: "下一页任务" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "下一页人员" })).toHaveCount(0);
      await page.getByTestId("time-canvas-scroll").evaluate((element) => {
        element.scrollTop = 25 * 112;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect(page.getByTestId(`timeline-row-plan:${taskRecords[25]!.id}`)).toBeVisible();
      for (const segment of deletedSegments) {
        await expect(page.getByTestId(`segment-block-${segment.id}`)).toHaveCount(0);
      }
      await page.getByTestId("time-canvas-scroll").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect(page.getByTestId(`timeline-row-person:${people[50]!.id}`)).toBeVisible();
      await page.reload();
      await expect(page.getByText("项目（1）")).toBeVisible();
      await expect(page.getByLabel(projectName, { exact: true })).toBeVisible();

      await prisma.task.update({
        where: { id: taskRecords[0]!.id },
        data: { deletedAt: new Date() },
      });
      await page.goto(
        `/progress/resources?all=0&focus=${deletedTaskSegment.id}`,
      );
      await expect(page.getByRole("dialog", { name: "投入详情" })).toContainText(
        "资源计划保留已删除 Task 的有效投入",
      );
      const deletedTaskDetail = page.getByRole("dialog", { name: "投入详情" });
      await expect(deletedTaskDetail.getByRole("term").filter({ hasText: /^关联任务$/ })).toBeVisible();
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
      await expect(page.getByText("项目（1）")).toBeVisible();
      await expect(page.getByText("任务（1）")).toBeVisible();
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

  test("canvas accessible names use Chinese work and busy labels without internal enums", async ({
    context,
    page,
    baseURL,
  }) => {
    const viewer = await createAccountPerson("投入画布无障碍测试成员");
    await loginAsTestUser(context, baseURL, {
      openId: viewer.openId,
      name: viewer.person.displayName,
    });
    await page.goto("/progress/time-canvas-fixtures?mode=RESOURCE_PLANNER&scale=week");
    const workBlock = page.getByTestId("segment-block-resource-segment-0-0");
    const busyBlock = page.getByTestId("segment-block-resource-segment-0-3");
    await expect(workBlock).toBeVisible();
    await expect(workBlock).toHaveAccessibleName(/^投入记录 /);
    await expect(workBlock).not.toHaveAccessibleName(/\b(?:PLANNED|ACTUAL|WORK)\b/);
    await expect(busyBlock).toBeVisible();
    await expect(busyBlock).toHaveAccessibleName(/^其他占用 /);
    await expect(busyBlock).not.toHaveAccessibleName(/\b(?:PLANNED|ACTUAL|WORK|BUSY|Task)\b/);
    await expectHealthyPage(page);
  });

  test("ordinary work records support future drafts, task association, transforms and deletion", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    const fixture = await createUiFixture();
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await loginAsTestUser(context, baseURL, {
      openId: fixture.member.openId,
      name: fixture.member.person.displayName,
    });
    await page.goto("/progress?scale=week");
    await page.getByRole("button", { name: "新增投入" }).click();
    const quickCreate = page.getByRole("form", { name: "投入快速创建" });
    await expectRetiredSegmentControlsAbsent(quickCreate);
    await expect(page.getByTestId("time-canvas-creation-range")).toBeVisible();
    const content = `未来普通投入 ${randomUUID()}`;
    await quickCreate.getByLabel("内容", { exact: true }).fill(content);
    await quickCreate.getByLabel("结束", { exact: true }).fill("2027-01-05T18:00");
    await quickCreate.getByLabel("开始", { exact: true }).fill("2027-01-05T09:00");
    await expect(quickCreate.getByLabel("开始", { exact: true })).toHaveValue("2027-01-05T09:00");
    await expect(quickCreate.getByLabel("结束", { exact: true })).toHaveValue("2027-01-05T18:00");
    await expect(page.getByTestId("time-canvas-creation-range")).toBeVisible();
    await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByText("已创建投入记录")).toBeVisible();
    await expect.poll(() => prisma.workSegment.count({
      where: { personId: fixture.member.person.id, content, taskId: null },
    })).toBe(1);
    const created = await prisma.workSegment.findFirstOrThrow({
      where: { personId: fixture.member.person.id, content },
    });
    expect(created.startAt.toISOString()).toBe("2027-01-05T01:00:00.000Z");
    expect(created.endAt.toISOString()).toBe("2027-01-05T10:00:00.000Z");

    await page.goto(`/progress?focus=${created.id}&scale=week`);
    const detailDialog = page.getByRole("dialog", { name: "投入详情" });
    const editForm = detailDialog.getByRole("form", { name: "编辑投入详情" });
    await expect(editForm).toBeVisible();
    await expectRetiredSegmentControlsAbsent(detailDialog);
    const createdBlock = detailDialog.getByTestId(`segment-block-${created.id}`);
    await expect(createdBlock).toHaveAccessibleName(/^投入记录 /);
    await expect(createdBlock).not.toHaveAccessibleName(/\b(?:PLANNED|ACTUAL|WORK)\b/);
    await editForm.getByRole("combobox", { name: "关联任务", exact: true }).fill(fixture.taskTitle);
    await page.getByRole("option", { name: fixture.taskTitle, exact: true }).click();
    const startInput = editForm.getByLabel("开始", { exact: true });
    const endInput = editForm.getByLabel("结束", { exact: true });
    if (testInfo.project.name === "desktop") {
      const block = detailDialog.getByTestId(`segment-block-${created.id}`);
      await block.scrollIntoViewIfNeeded();
      await expect.poll(() => block.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return {
          segmentHit: target?.closest("[data-canvas-object]") === element,
          resizeHandle: target?.closest("[data-resize-handle]")?.getAttribute("data-resize-handle") ?? null,
        };
      })).toEqual({ segmentHit: true, resizeHandle: null });
      const blockBox = await block.boundingBox();
      expect(blockBox).not.toBeNull();
      await page.mouse.move(blockBox!.x + blockBox!.width / 2, blockBox!.y + blockBox!.height / 2);
      await page.mouse.down();
      await page.mouse.move(blockBox!.x + blockBox!.width / 2 + 40, blockBox!.y + blockBox!.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect(startInput).not.toHaveValue("2027-01-05T09:00");
      const movedStart = await startInput.inputValue();
      const movedEnd = await endInput.inputValue();
      const startDeltaMs = Date.parse(shanghaiDateTimeLocalToIso(movedStart)) - created.startAt.getTime();
      const endDeltaMs = Date.parse(shanghaiDateTimeLocalToIso(movedEnd)) - created.endAt.getTime();
      expect(startDeltaMs).toBeGreaterThan(0);
      expect(endDeltaMs).toBe(startDeltaMs);
      const resizeHandle = block.locator('[data-resize-handle="end"]');
      const handleBox = await resizeHandle.boundingBox();
      expect(handleBox).not.toBeNull();
      await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 30, handleBox!.y + handleBox!.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect(endInput).not.toHaveValue(movedEnd);
      await expect(startInput).toHaveValue(movedStart);
      expect(Date.parse(shanghaiDateTimeLocalToIso(await endInput.inputValue())))
        .toBeGreaterThan(Date.parse(shanghaiDateTimeLocalToIso(movedEnd)));
    } else {
      await startInput.fill("2027-01-05T10:00");
      await endInput.fill("2027-01-05T19:00");
    }
    const expectedStartAt = new Date(shanghaiDateTimeLocalToIso(await startInput.inputValue()));
    const expectedEndAt = new Date(shanghaiDateTimeLocalToIso(await endInput.inputValue()));
    await editForm.getByRole("button", { name: "保存基本信息" }).click();
    await expect(page.getByText("已更新投入详情")).toBeVisible();
    await expect.poll(() => prisma.workSegment.findUniqueOrThrow({
      where: { id: created.id },
      select: { personId: true, taskId: true, startAt: true, endAt: true },
    })).toEqual({
      personId: fixture.member.person.id,
      taskId: fixture.taskId,
      startAt: expectedStartAt,
      endAt: expectedEndAt,
    });
    await page.goto(`/progress?focus=${created.id}`);
    await expect(editForm).toBeVisible();
    page.once("dialog", (dialog) => dialog.dismiss());
    await detailDialog.getByRole("button", { name: "删除投入", exact: true }).click();
    expect((await prisma.workSegment.findUniqueOrThrow({ where: { id: created.id } })).deletedAt).toBeNull();
    page.once("dialog", (dialog) => dialog.accept());
    await detailDialog.getByRole("button", { name: "删除投入", exact: true }).click();
    await expect(page.getByText("已删除投入记录")).toBeVisible();
    await expect(detailDialog).toHaveCount(0);
    await expect.poll(async () => (await prisma.workSegment.findUniqueOrThrow({
      where: { id: created.id },
    })).deletedAt).not.toBeNull();
    await page.reload();
    await expect(page.getByTestId(`segment-block-${created.id}`)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(browserErrors).toEqual([]);
    await expectHealthyPage(page);
  });

  test("ordinary work records keep read-only, inactive-person and server permission boundaries", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const fixture = await createUiFixture();
    const original = await prisma.workSegment.findUniqueOrThrow({
      where: { id: fixture.movableSegmentId },
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.reviewer.openId,
      name: fixture.reviewer.person.displayName,
    });
    await page.goto(`/progress/resources?all=0&focus=${original.id}`);
    const detailDialog = page.getByRole("dialog", { name: "投入详情" });
    await expect(detailDialog.getByTestId("segment-inspector")).toBeVisible();
    await expect(detailDialog.getByRole("form", { name: "编辑投入详情" })).toHaveCount(0);
    await expect(detailDialog.getByRole("button", { name: "删除投入" })).toHaveCount(0);
    await expectRetiredSegmentControlsAbsent(detailDialog);
    await expect(updateWorkSegment(actor(fixture.reviewer), {
      segmentId: original.id,
      expectedUpdatedAt: original.updatedAt.toISOString(),
      content: "越权修改不得保存",
    })).rejects.toMatchObject({ name: "ProjectManagementAuthorizationError" });
    await expect(softDeleteWorkSegment(actor(fixture.reviewer), {
      segmentId: original.id,
      expectedUpdatedAt: original.updatedAt.toISOString(),
    })).rejects.toMatchObject({ name: "ProjectManagementAuthorizationError" });
    const unchanged = await prisma.workSegment.findUniqueOrThrow({ where: { id: original.id } });
    expect(unchanged.content).toBe(original.content);
    expect(unchanged.updatedAt).toEqual(original.updatedAt);
    expect(unchanged.deletedAt).toBeNull();
    await page.goto(`/progress/resources?all=0&focus=${fixture.inactiveHistorySegmentId}`);
    await expect(detailDialog.getByTestId("segment-inspector")).toBeVisible();
    await expect(detailDialog.getByRole("form", { name: "编辑投入详情" })).toHaveCount(0);
    await expectHealthyPage(page);

    await loginAsTestUser(context, baseURL, {
      openId: fixture.outsider.openId,
      name: fixture.outsider.person.displayName,
    });
    await page.goto(`/progress/resources?all=0&focus=${original.id}`);
    await expect(detailDialog.getByRole("heading", { name: original.content, exact: true })).toBeVisible();
    await expect(detailDialog.getByRole("form", { name: "编辑投入详情" })).toHaveCount(0);
    await expect(detailDialog.getByRole("button", { name: "删除投入" })).toHaveCount(0);
    await expect(softDeleteWorkSegment(actor(fixture.outsider), {
      segmentId: original.id,
      expectedUpdatedAt: original.updatedAt.toISOString(),
    })).rejects.toMatchObject({ name: "ProjectManagementAuthorizationError" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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
        data: { content: "普通投入历史记录" },
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
      await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();
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
        "普通投入历史记录",
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
        "普通投入历史记录",
      );
      await expect(
        detailDialog.getByRole("form", { name: "编辑投入详情" }),
      ).toBeVisible();
      await expectRetiredSegmentControlsAbsent(detailDialog);
      await detailDialog.getByRole("button", { name: "Close" }).click();
      await expect(detailDialog).toHaveCount(0);
      await expect
        .poll(() => new URL(page.url()).searchParams.has("focus"))
        .toBe(false);
      await expect(page.getByRole("heading", { name: "资源计划" })).toBeVisible();
      await expect(page.getByRole("region", { name: "资源计划选择" })).toBeVisible();
      await expect(page.getByText("人员（2）")).toBeVisible();
      await expect(page.getByText("任务（1）")).toBeVisible();
      await expect(page.getByRole("checkbox", { name: /显示全部资源/ })).not.toBeChecked();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("center"))
        .not.toBeNull();
      await page.getByRole("button", { name: "年", exact: true }).click();
      await expect(page).toHaveURL(/scale=year/);
      const preservedCenter = await stableUrlSearchParam(page, "center");
      await page.getByRole("button", {
        name: `移除${fixture.owner.person.displayName}`,
      }).click();
      await page.getByRole("combobox", { name: "筛选人员" }).press("Escape");
      await page.getByRole("button", { name: "应用选择" }).click();
      await expect(page).toHaveURL(/all=0/);
      await expect(page).toHaveURL(/scale=year/);
      await expect
        .poll(() => new URL(page.url()).searchParams.get("center"))
        .toBe(preservedCenter);
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
        "普通投入历史记录",
        { timeout: 15_000 },
      );
      await detailDialog.getByRole("button", { name: "Close" }).click();
      await expect(detailDialog).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();
      await expect(page.getByRole("region", { name: "到期计划与确认队列" })).toHaveCount(0);
      await expect(page.getByTestId("time-canvas-scroll")).toBeVisible();

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

async function stableUrlSearchParam(page: Page, key: string) {
  let candidate = new URL(page.url()).searchParams.get(key);
  let stableSince = Date.now();
  await expect.poll(
    () => {
      const current = new URL(page.url()).searchParams.get(key);
      if (current !== candidate) {
        candidate = current;
        stableSince = Date.now();
      }
      return current !== null && Date.now() - stableSince >= 500;
    },
    { timeout: 5_000, intervals: [100, 100, 200, 300] },
  ).toBe(true);
  return candidate!;
}

async function expectRetiredSegmentControlsAbsent(container: Locator) {
  await expect(container.getByLabel(/^(类型|状态|优先级|预期输出|实际输出|修改原因|删除原因)$/)).toHaveCount(0);
  await expect(container.getByRole("button", { name: /^(完整确认|部分确认|取消计划|删除 Actual|合并|批量)/ })).toHaveCount(0);
  await expect(container.getByRole("form", { name: "确认计划" })).toHaveCount(0);
  await expect(container.getByRole("heading", { name: "来源与变更历史" })).toHaveCount(0);
}
