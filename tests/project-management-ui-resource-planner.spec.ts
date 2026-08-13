import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { getResourcePlanPageData } from "../lib/project-management/queries/time-canvas-queries";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

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

  test("resource plan Project selection, independent pagination, focus pin and legacy URL stay stable", async ({
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
          description: "资源计划 Project picker 与分页回归",
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
            reason: "资源计划分页 UI fixture",
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
            businessDescription: "资源计划分页 Terminal",
            createdByAccountId: owner.account.id,
          })),
        });
        await tx.terminationNode.createMany({
          data: taskRecords.map((record, index) => ({
            nodeId: record.nodeId,
            name: `Terminal ${String(index).padStart(2, "0")}`,
            plannedOutcomeCriteria: "完成资源计划分页验证",
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

      await page.goto("/progress/resources");
      await page.getByRole("checkbox", { name: /显示全部资源/ }).uncheck();
      await page.getByRole("combobox", { name: "筛选 Project" }).fill(projectName);
      await page.getByRole("option", { name: projectName, exact: true }).click();
      await page.getByRole("button", { name: "应用选择" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("projects")).toBe(project.id);
      await expect(page.getByText("Project（1）")).toBeVisible();
      await expect(page.getByRole("link", { name: "下一页 Task" })).toBeVisible();
      await expect(page.getByRole("link", { name: "下一页人员" })).toBeVisible();
      await page.getByTestId("time-canvas-scroll").evaluate((element) => {
        element.scrollTop = Math.min(
          element.scrollHeight - element.clientHeight,
          25 * 112,
        );
        element.dispatchEvent(new Event("scroll"));
      });
      for (const segment of terminalPlannedSegments) {
        await expect(page.getByTestId(`segment-block-${segment.id}`)).toHaveCount(0);
      }

      await page.getByRole("link", { name: "下一页 Task" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.has("taskCursor")).toBe(true);
      expect(new URL(page.url()).searchParams.has("personCursor")).toBe(false);
      await page.getByRole("link", { name: "下一页人员" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.has("personCursor")).toBe(true);
      expect(new URL(page.url()).searchParams.has("taskCursor")).toBe(true);
      await page.getByRole("link", { name: "Task 返回第一页" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.has("taskCursor")).toBe(false);
      expect(new URL(page.url()).searchParams.has("personCursor")).toBe(true);
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
        "/progress/resources?tags=legacy&from=2026-08-10&to=2026-08-12&group=person&types=PLANNED&statuses=ACTIVE&zoom=hour",
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
      for (const key of ["tags", "from", "to", "group", "types", "statuses", "zoom"]) {
        expect(copiedUrl.searchParams.has(key), `复制链接仍包含 ${key}`).toBe(false);
      }
      await page.getByRole("button", { name: "年", exact: true }).click();
      await expect(page).toHaveURL(/scale=year/);
      for (const key of ["tags", "from", "to", "group", "types", "statuses", "zoom"]) {
        expect(new URL(page.url()).searchParams.has(key), `导航后仍包含 ${key}`).toBe(false);
      }
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )).toBe(true);

      const expectedCanonicalPeople = people.map((person) => person.id).sort().slice(0, 50);
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
      await page.goto(`/progress/resources?focus=${fixture.movableSegmentId}`);
      const emptyHistoryInspector = page.getByTestId("segment-inspector");
      await expect(emptyHistoryInspector.getByText("正在加载变更历史…")).toBeVisible();
      releaseInitialHistoryRequest();
      await expect(
        emptyHistoryInspector.getByText(/变更历史加载失败：网络异常/),
      ).toBeVisible();
      await page.unroute("**/progress/resources**", abortInitialHistoryRequest);
      await emptyHistoryInspector.getByRole("button", { name: "重试历史" }).click();
      await expect(emptyHistoryInspector.getByText("暂无可见变更。")).toBeVisible();

      await page.goto(`/progress/resources?focus=${fixture.confirmableSegmentId}`);
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

      await page.goto(`/progress/resources?focus=${randomUUID()}`);
      await expect(page).toHaveURL(/focusError=1/);
      await expect(page.getByText(
        "无法定位该时间对象，请确认链接仍然有效且你有权查看。",
      )).toBeVisible();

      await page.goto(
        "/progress/resources?from=2026-08-10&to=2026-08-12&group=person",
      );
      const nextResourcePage = page.getByRole("link", { name: "下一页人员" });
      await expect(nextResourcePage).toBeVisible();
      await page.getByRole("button", { name: "年", exact: true }).click();
      await expect(page).toHaveURL(/scale=year/);
      expect(new URL(page.url()).searchParams.get("center")).not.toBeNull();
      await expect(nextResourcePage).toHaveAttribute("href", /scale=year/);
      const paginationRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return request.method() === "GET" && url.searchParams.has("personCursor");
      });
      await nextResourcePage.click();
      const paginationCenter = new URL(
        (await paginationRequest).url(),
      ).searchParams.get("center");
      expect(paginationCenter).not.toBeNull();
      await expect(page).toHaveURL(/personCursor=/);
      await expect(page).toHaveURL(/scale=year/);
      expect(new URL(page.url()).searchParams.get("center")).toBe(
        paginationCenter,
      );

      await page.goto(
        `/progress/resources?all=0&people=${fixture.member.person.id},${fixture.owner.person.id}&tasks=${fixture.taskId}&focus=${fixture.confirmableSegmentId}`,
      );
      const detailDialog = page.getByRole("dialog", { name: "投入详情" });
      await expect(detailDialog.getByTestId("segment-inspector")).toContainText(
        "P6 UI 可确认计划",
      );
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
      await page.getByRole("button", { name: "年", exact: true }).click();
      await expect(page).toHaveURL(/scale=year/);
      await page.waitForTimeout(500);
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
      await page.getByTestId("segment-inspector").getByRole("button", { name: "完整确认" }).click();
      await expect(page.getByText("已完整确认并生成 Actual")).toBeVisible();
      await expect(detailDialog).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).searchParams.has("focus")).toBe(false);
      await expect(dueQueue.getByText("P6 UI 可确认计划")).toHaveCount(0);
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
