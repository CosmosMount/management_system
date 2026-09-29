// @playwright-project ui
import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createWorkSegment } from "../lib/project-management/application/segment-service";
import { createMeeting } from "../lib/project-management/meetings/service";
import { actor, atHour, createUiFixture } from "./helpers/project-management-ui-fixtures";
import { expectHealthyPage, expectNoHorizontalOverflow, loginAsTestUser } from "./helpers/functional-fixtures";

const surfaces = ["我的工作", "资源计划", "人员时间线", "Task 工作台", "Project 详情", "会议详情"] as const;

for (const surface of surfaces) {
  for (const width of [1440, 393]) {
    test(`${surface} 按投入权限编辑、审计及软删除 ${width}`, async ({ page, context, baseURL }, testInfo) => {
      test.setTimeout(120_000);
      if (!baseURL) throw new Error("缺少隔离测试服务地址");
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 851 });
      const fixture = await createUiFixture();
      await prisma.systemRoleAssignment.updateMany({ where: { accountId: fixture.admin.account.id }, data: { role: "SUPER_ADMINISTRATOR" } });
      const viewer = surface === "我的工作" ? fixture.member : fixture.admin;
      const project = await prisma.project.create({ data: { name: `投入权限项目 ${randomUUID()}`,
        status: "ACTIVE", description: "投入权限回归", requesterAccountId: fixture.admin.account.id } });
      await prisma.task.update({ where: { id: fixture.taskId }, data: { projectId: project.id } });
      const originalContent = `${"投入完整修改历史".repeat(30)}修改前结尾`;
      const content = `${"投入完整修改历史".repeat(30)}修改后结尾`;
      // The Task workbench initially focuses its active milestone on narrow screens.
      const startAt = surface === "Task 工作台" ? new Date("2026-08-01T09:00:00.000Z") : atHour(9);
      const endAt = new Date(startAt.getTime() + 3_600_000);
      const created = await createWorkSegment(actor(fixture.member), {
        personId: fixture.member.person.id, startAt, endAt, content: originalContent,
        taskId: ["资源计划", "会议详情"].includes(surface) ? null : fixture.taskId,
      });
      const segmentId = created.segment.id;
      const viewport = "scale=week&center=2026-08-10T09%3A00%3A00.000Z";
      let path: string;
      switch (surface) {
        case "我的工作": path = `/progress?${viewport}`; break;
        case "资源计划": path = `/progress/resources?all=0&people=${fixture.member.person.id}&${viewport}`; break;
        case "人员时间线": path = `/progress/kanban?people=${fixture.member.person.id}&${viewport}`; break;
        case "Task 工作台": path = `/progress/tasks/${fixture.taskId}?${viewport}`; break;
        case "Project 详情": path = `/progress/projects/${project.id}?${viewport}`; break;
        case "会议详情": {
          const meeting = await createMeeting(actor(fixture.admin), { requestId: randomUUID(), topic: "非参会超管代改投入",
            personIds: [fixture.member.person.id, fixture.owner.person.id], rangeStart: atHour(8).toISOString(), rangeEnd: atHour(18).toISOString(), minutes: "" });
          path = `/progress/meetings/${meeting.id}`;
          break;
        }
      }
      const outboxBefore = await prisma.notificationOutbox.count();
      const notificationsBefore = await prisma.inAppNotification.count();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await loginAsTestUser(context, baseURL, { openId: viewer.openId, name: viewer.person.displayName });
      await page.goto(path);
      await expect(page.getByRole("button", { name: "新增投入", exact: true })).toBeEnabled();
      const creationPersonId = surface === "会议详情" ? fixture.owner.person.id : fixture.member.person.id;
      await brushPersonRow(page, creationPersonId, surface === "会议详情" ? atHour(9).getTime() : undefined);
      const quickCreate = page.getByRole("form", { name: "投入快速创建" });
      await expect(quickCreate).toBeVisible();
      const newContent = `${surface}拖选新增 ${randomUUID()}`;
      await quickCreate.getByLabel("内容", { exact: true }).fill(newContent);
      if (["Project 详情", "会议详情"].includes(surface)) {
        await page.screenshot({ path: testInfo.outputPath(`investment-create-${width}.png`), animations: "disabled" });
      }
      await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
      await expect(quickCreate).not.toBeVisible();
      const added = await prisma.workSegment.findFirstOrThrow({ where: { content: newContent } });
      expect(added.personId).toBe(creationPersonId);
      expect(added.taskId).toBe(surface === "Task 工作台" ? fixture.taskId : null);
      expect(added.endAt.getTime()).toBeGreaterThan(added.startAt.getTime());
      const creationAudit = await prisma.workSegmentChange.findFirstOrThrow({ where: { segmentId: added.id } });
      expect(creationAudit.action).toBe("CREATE");
      expect(creationAudit.actorAccountId).toBe(viewer.account.id);
      await expect(page.getByTestId(`segment-block-${added.id}`)).toBeVisible();
      await expectNoHorizontalOverflow(page);
      if (surface === "人员时间线") {
        await page.setViewportSize({ width: 360, height: 851 });
        await expect(page.getByRole("button", { name: "新增投入", exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 851 });
      }
      await loginAsTestUser(context, baseURL, { openId: viewer.openId, name: viewer.person.displayName });
      await page.goto(path);
      const block = page.getByTestId(`segment-block-${segmentId}`);
      await expect(page.getByTestId(`time-canvas-row-header-person:${fixture.member.person.id}`).getByText("可编辑", { exact: true })).toBeVisible();
      await block.press("Enter");
      const dialog = page.getByRole("dialog", { name: "投入详情" });
      const form = dialog.getByRole("form", { name: "编辑投入详情" });
      await expect(form).toBeVisible();
      // The embedded context must never make another record editable.
      await expect(dialog.getByTestId(`segment-block-${segmentId}`)).toBeVisible();
      await expect(dialog.locator(`[data-testid^="segment-block-"]:not([data-testid="segment-block-${segmentId}"]) [data-resize-handle]`)).toHaveCount(0);
      await form.getByLabel("内容", { exact: true }).fill(content);
      const updateRequest = page.waitForRequest((request) => request.method() === "POST" &&
        Boolean(request.headers()["next-action"]) && Boolean(request.postData()?.includes('"expectedUpdatedAt"')));
      await form.getByRole("button", { name: "保存基本信息" }).click();
      const request = await updateRequest;
      await expect(dialog).not.toBeVisible();
      await expect.poll(async () => (await prisma.workSegment.findUniqueOrThrow({ where: { id: segmentId } })).content).toBe(content);
      await expect(block).toContainText(content);
      await block.press("Enter");
      const history = dialog.getByRole("region", { name: "变更历史" });
      await expect(history).toContainText(`操作者：${viewer.person.displayName}`);
      await expect(history).toContainText("操作说明：修改投入记录");
      await history.getByText("内容：展开完整修改前后内容", { exact: true }).click();
      await expect(history.getByText(originalContent, { exact: true })).toBeVisible();
      await expect(history.getByText(content, { exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      if (surface === "人员时间线") {
        await page.screenshot({ path: testInfo.outputPath(`investment-history-${width}.png`), animations: "disabled" });
        await page.setViewportSize({ width: 360, height: 851 });
        await expectNoHorizontalOverflow(page);
      }
      await dialog.getByRole("button", { name: "Close", exact: true }).click();

      await loginAsTestUser(context, baseURL, { openId: fixture.outsider.openId, name: fixture.outsider.person.displayName });
      const denied = await context.request.post(request.url(), { headers: {
        "next-action": request.headers()["next-action"], "content-type": request.headers()["content-type"], origin: baseURL,
      }, data: request.postData() ?? "" });
      expect(await denied.text()).toContain("FORBIDDEN");
      await page.goto(surface === "我的工作" ? `/progress/kanban?people=${fixture.member.person.id}&${viewport}` : path);
      await brushPersonRow(page, fixture.member.person.id);
      await expect(quickCreate).toHaveCount(0);
      await block.press("Enter");
      await expect(form).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "删除投入", exact: true })).toHaveCount(0);
      await expect(history).toContainText("修改投入");
      await expectHealthyPage(page);

      await loginAsTestUser(context, baseURL, { openId: viewer.openId, name: viewer.person.displayName });
      await page.goto(path);
      await block.press("Enter");
      page.once("dialog", (confirmation) => void confirmation.dismiss());
      await dialog.getByRole("button", { name: "删除投入", exact: true }).click();
      expect((await prisma.workSegment.findUniqueOrThrow({ where: { id: segmentId } })).deletedAt).toBeNull();
      page.once("dialog", (confirmation) => void confirmation.accept());
      await dialog.getByRole("button", { name: "删除投入", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(block).toHaveCount(0);
      const changes = await prisma.workSegmentChange.findMany({ where: { segmentId }, orderBy: { createdAt: "asc" } });
      expect(changes.map((change) => change.action)).toEqual(["CREATE", "UPDATE", "DELETE"]);
      expect(changes[1]).toMatchObject({ actorAccountId: viewer.account.id, before: { content: originalContent }, after: { content } });
      expect(changes[2].actorAccountId).toBe(viewer.account.id);
      expect(await prisma.domainAuditEvent.count({ where: { entityType: "WorkSegment", entityId: segmentId } })).toBe(3);
      expect(await prisma.notificationOutbox.count()).toBe(outboxBefore);
      expect(await prisma.inAppNotification.count()).toBe(notificationsBefore);
      await expectNoHorizontalOverflow(page);
      await expectHealthyPage(page);
      expect(errors).toEqual([]);
    });
  }
}

async function brushPersonRow(page: Page, personId: string, startAtMs?: number) {
  const row = page.locator(`[data-canvas-row="person:${personId}"]`).first();
  const header = page.getByTestId(`time-canvas-row-header-person:${personId}`).first();
  await header.scrollIntoViewIfNeeded();
  const headerBox = await header.boundingBox();
  const rowBox = await row.boundingBox();
  const viewport = await page.getByTestId("time-canvas-scroll").first().boundingBox();
  if (!rowBox || !viewport || !headerBox) throw new Error("缺少人员时间行坐标");
  const canvas = page.getByTestId("time-canvas-root").first();
  const rangeStart = Number(await canvas.getAttribute("data-range-start-ms"));
  const rangeEnd = Number(await canvas.getAttribute("data-range-end-ms"));
  const startX = startAtMs === undefined
    ? Math.max(rowBox.x, viewport.x, headerBox.x + headerBox.width) + 16
    : rowBox.x + (startAtMs - rangeStart) / (rangeEnd - rangeStart) * rowBox.width;
  const endX = Math.min(rowBox.x + rowBox.width, viewport.x + viewport.width) - 24;
  const y = rowBox.y + rowBox.height - 8;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(Math.min(endX, startX + (startAtMs === undefined ? 80 : 8)), y, { steps: 8 });
  await page.mouse.up();
}
