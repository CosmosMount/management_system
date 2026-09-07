// @playwright-project ui
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "../lib/prisma";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";
import { createUiFixture } from "./helpers/project-management-ui-fixtures";

test.describe("project management person kanban", { tag: "@smoke" }, () => {
  test("a cached candidate becoming inactive restores the current person selection", async ({
    context,
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("人员看板测试缺少 baseURL");
    const fixture = await createUiFixture();
    const browserErrors = collectBrowserErrors(page);
    await prisma.person.createMany({
      data: Array.from({ length: 51 }, (_, index) => ({
        displayName: `000 看板回退候选 ${fixture.member.person.id} ${index}`,
        status: "ACTIVE",
      })),
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.outsider.openId,
      name: fixture.outsider.person.displayName,
    });
    await page.goto("/progress/kanban");
    const personPicker = page.getByRole("combobox", { name: "查看人员", exact: true });
    await personPicker.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await personPicker.fill(fixture.member.person.displayName);
    const candidate = page.getByRole("option").filter({
      hasText: fixture.member.person.displayName,
    });
    await expect(candidate).toBeVisible();
    await prisma.person.update({
      where: { id: fixture.member.person.id },
      data: { status: "INACTIVE" },
    });
    await candidate.click();
    await expect(page.getByRole("status")).toContainText(
      "所选人员不存在、已停用或当前不可查看",
    );
    await expect(personPicker).toBeEnabled();
    await expect(personPicker).toHaveValue(fixture.outsider.person.displayName);
    expect(new URL(page.url()).searchParams.get("people")).toBe(
      fixture.outsider.person.id,
    );
    await expect(
      page.getByTestId(`timeline-row-person:${fixture.outsider.person.id}`),
    ).toBeVisible();
    await expectHealthyPage(page);
    expect(browserErrors).toEqual([]);
  });

  test("segment owners, Task owners and administrators cannot mutate the kanban", async ({
    context,
    page,
    baseURL,
  }) => {
    test.slow();
    if (!baseURL) throw new Error("人员看板测试缺少 baseURL");
    const fixture = await createUiFixture();
    const browserErrors = collectBrowserErrors(page);
    const businessState = async () => ({
      segments: await prisma.workSegment.findMany({
        where: { taskId: fixture.taskId },
        orderBy: { id: "asc" },
      }),
      changes: await prisma.workSegmentChange.count({
        where: { segment: { taskId: fixture.taskId } },
      }),
      audits: await prisma.domainAuditEvent.count({
        where: { taskId: fixture.taskId },
      }),
      outbox: await prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    });
    const before = await businessState();
    for (const viewer of [fixture.member, fixture.owner, fixture.admin]) {
      await loginAsTestUser(context, baseURL, {
        openId: viewer.openId,
        name: viewer.person.displayName,
      });
      await page.goto(
        `/progress/kanban?people=${fixture.member.person.id}&scale=month&center=2026-08-10T10:00:00.000Z`,
      );
      await expect(page.getByRole("button", { name: "新增投入" })).toHaveCount(0);
      await expectReadOnlyConfirmableSegment(page, fixture.confirmableSegmentId);
      await expectHealthyPage(page);
      expect(await businessState()).toEqual(before);
    }
    expect(browserErrors).toEqual([]);
  });

  test("ordinary users select another person and inspect a read-only timeline", async ({
    context,
    page,
    request,
    baseURL,
  }, testInfo) => {
    if (!baseURL) throw new Error("人员看板测试缺少 baseURL");
    const unauthenticated = await request.get(
      new URL("/progress/kanban", baseURL).toString(),
      { maxRedirects: 0 },
    );
    expect([302, 303, 307, 308]).toContain(unauthenticated.status());

    const fixture = await createUiFixture();
    const longPersonName = `看板超长人员名称${"甲乙丙丁".repeat(24)}${fixture.member.person.id}`;
    await prisma.person.update({
      where: { id: fixture.member.person.id },
      data: { displayName: longPersonName },
    });
    const browserErrors = collectBrowserErrors(page);
    await loginAsTestUser(context, baseURL, {
      openId: fixture.outsider.openId,
      name: fixture.outsider.person.displayName,
    });

    await page.goto(
      "/progress/kanban?scale=month&center=2022-08-10T10:00:00.000Z",
    );
    await expect(page.getByRole("heading", { name: "看板" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`people=${fixture.outsider.person.id}`));
    await expect(page.getByTestId("time-canvas-root")).toHaveAttribute(
      "data-zoom",
      "MONTH",
    );
    await expect
      .poll(() => new URL(page.url()).searchParams.get("center"))
      .not.toBeNull();
    await expect(
      page.getByTestId(`timeline-row-person:${fixture.outsider.person.id}`),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="timeline-row-plan:"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="segment-block-"]')).toHaveCount(0);

    if (testInfo.project.name === "desktop") {
      await expect(
        page
          .getByTestId("project-management-sidebar")
          .getByRole("link", { name: "看板", exact: true }),
      ).toHaveAttribute("aria-current", "page");
    } else {
      await expect(
        page.getByTestId("project-management-mobile-bar").getByText("看板"),
      ).toBeVisible();
      await page.getByRole("button", { name: "打开项目管理导航" }).click();
      await expect(
        page
          .getByTestId("project-management-drawer")
          .getByRole("link", { name: "看板", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await page.getByRole("button", { name: "关闭项目管理导航" }).click();
    }

    const centerBeforeSelection = new URL(page.url()).searchParams.get("center");
    const personPicker = page.getByRole("combobox", { name: "查看人员", exact: true });
    await personPicker.fill(longPersonName);
    await page
      .getByRole("option")
      .filter({ hasText: longPersonName })
      .click();

    await expect
      .poll(() => new URL(page.url()).searchParams.get("people"))
      .toBe(fixture.member.person.id);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("scale"))
      .toBe("month");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("center"))
      .toBe(centerBeforeSelection);
    await expect(page.getByText(`当前查看：${longPersonName}。`)).toBeVisible();
    await expect(
      page.getByTestId(`timeline-row-person:${fixture.member.person.id}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`timeline-row-person:${fixture.owner.person.id}`),
    ).toHaveCount(0);
    await expect(
      page.getByTestId(`segment-block-${fixture.confirmableSegmentId}`),
    ).toHaveCount(0);

    await page.evaluate(
      (url) => window.location.replace(url),
      `/progress/kanban?people=${fixture.member.person.id}&scale=month&center=2026-08-10T10:00:00.000Z`,
    );
    await expect
      .poll(() => new URL(page.url()).searchParams.get("center"))
      .toBe("2026-08-10T10:00:00.000Z");
    const planRow = page.getByTestId(`timeline-row-plan:${fixture.taskId}`);
    await expect(planRow).toBeVisible();
    await expect(
      planRow.getByRole("link", { name: fixture.taskTitle, exact: true }),
    ).toHaveAttribute("href", `/progress/tasks/${fixture.taskId}`);
    await expect(
      page.getByText("双击投入打开只读详情；此页面不能修改既有投入。"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "新增投入" })).toHaveCount(0);

    await expectReadOnlyConfirmableSegment(page, fixture.confirmableSegmentId);

    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.goBack();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("people"))
      .toBe(fixture.outsider.person.id);
    await page.goForward();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("people"))
      .toBe(fixture.member.person.id);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("center"))
      .toBe("2026-08-10T10:00:00.000Z");

    await page.goto(
      `/progress/kanban?people=${fixture.member.person.id}&people=${fixture.owner.person.id}&scale=month&center=2026-08-10T10:00:00.000Z`,
    );
    await expect
      .poll(() => new URL(page.url()).searchParams.getAll("people"))
      .toEqual([fixture.member.person.id]);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("scale"))
      .toBe("month");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("center"))
      .toBe("2026-08-10T10:00:00.000Z");

    await page.goto("/progress/kanban?people=not-a-person");
    await expect(page).toHaveURL(new RegExp(`people=${fixture.outsider.person.id}`));
    await expect(page.getByRole("status")).toContainText(
      "所选人员不存在、已停用或当前不可查看",
    );
    await expectHealthyPage(page);
    expect(browserErrors).toEqual([]);
  });
});

function collectBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function expectReadOnlyConfirmableSegment(page: Page, segmentId: string) {
  const segment = page.getByTestId(`segment-block-${segmentId}`);
  await expect(segment).toBeVisible();
  const before = await prisma.workSegment.findUniqueOrThrow({
    where: { id: segmentId },
  });
  await expect(segment.locator("[data-resize-handle]")).toHaveCount(0);
  await segment.focus();
  await segment.press("Shift+ArrowRight");
  const segmentBox = await segment.boundingBox();
  if (!segmentBox) throw new Error("人员看板只读投入缺少拖动坐标");
  await page.mouse.move(
    segmentBox.x + segmentBox.width / 2,
    segmentBox.y + segmentBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    segmentBox.x + segmentBox.width / 2 + 48,
    segmentBox.y + segmentBox.height / 2,
    { steps: 3 },
  );
  await page.mouse.up();
  await segment.focus();
  await segment.press("Enter");
  const detail = page.getByRole("dialog", { name: "投入详情" });
  await expect(detail).toContainText("P6 UI 可确认计划");
  await expect(detail).toContainText("当前投入与其他对象均为只读");
  await expect(
    detail.getByRole("form", { name: "编辑投入详情" }),
  ).toHaveCount(0);
  await expect(detail.getByRole("form", { name: "确认计划" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "取消计划" })).toHaveCount(0);
  await detail.getByRole("button", { name: "Close" }).click();
  expect(
    await prisma.workSegment.findUniqueOrThrow({ where: { id: segmentId } }),
  ).toEqual(before);
}
