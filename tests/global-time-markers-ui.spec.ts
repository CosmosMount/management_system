// @playwright-project ui
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";
import { createUiFixture } from "./helpers/project-management-ui-fixtures";

test.describe("全局关键时间点 UI", () => {
  test("个人、资源、Task、Project 和 Composer 时间线直接显示节点与时间线", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(90_000);
    const fixture = await createUiFixture();
    const project = await prisma.project.create({
      data: {
        name: `全局关键时间点 UI Project ${randomUUID()}`,
        description: "验证所有业务时间线直接显示全局关键时间点",
        status: "ACTIVE",
        requesterAccountId: fixture.admin.account.id,
        startedAt: new Date("2026-08-01T00:00:00.000Z"),
        members: {
          create: {
            personId: fixture.member.person.id,
            role: "OWNER",
            createdByAccountId: fixture.admin.account.id,
          },
        },
      },
    });
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { projectId: project.id },
    });
    const marker = await prisma.globalTimeMarker.create({
      data: {
        name: `全局节点 ${randomUUID().slice(0, 8)}`,
        markedAt: new Date("2026-08-11T02:30:00.000Z"),
      },
    });
    const denseMarkers = Array.from({ length: 5 }, (_, index) => ({
      id: randomUUID(),
      name: `${`密集长名称${index + 1}`.repeat(12)}`.slice(0, 100),
      markedAt: new Date("2026-08-11T02:31:00.000Z"),
    }));
    await prisma.globalTimeMarker.createMany({ data: denseMarkers });
    const extremeMarker = await prisma.globalTimeMarker.create({
      data: {
        name: `极远全局节点 ${randomUUID()}`,
        markedAt: new Date("9999-12-31T15:59:00.000Z"),
      },
    });
    const center = encodeURIComponent(marker.markedAt.toISOString());

    try {
      await loginAsTestUser(context, baseURL, {
        openId: fixture.member.openId,
        name: fixture.member.person.displayName,
      });

      const routes = [
        { path: `/progress?center=${center}`, desktopOnlyCanvas: false },
        {
          path: `/progress/kanban?people=${fixture.member.person.id}&center=${center}`,
          desktopOnlyCanvas: false,
        },
        {
          path: `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id}&center=${center}`,
          desktopOnlyCanvas: false,
        },
        {
          path: "/progress/time-canvas-fixtures?mode=RESOURCE_PLANNER&empty=1&globalMarkers=1",
          desktopOnlyCanvas: false,
          empty: true,
        },
        {
          path: `/progress/tasks/${fixture.taskId}?center=${center}`,
          desktopOnlyCanvas: false,
        },
        {
          path: `/progress/projects/${project.id}?center=${center}`,
          desktopOnlyCanvas: false,
        },
        {
          path: "/progress/tasks/new?start=2026-08-10",
          desktopOnlyCanvas: true,
          boundedRange: true,
        },
      ];

      for (const route of routes) {
        await page.goto(route.path, { waitUntil: "networkidle" });
        if (route.desktopOnlyCanvas && testInfo.project.name === "mobile") {
          await expect(page.getByTestId("time-canvas-root")).toBeHidden();
          await expectHealthyPage(page);
          continue;
        }
        const markerLine = page
          .getByTestId(`global-time-marker-line-${marker.id}`)
          .first();
        await expect(markerLine).toBeAttached();
        await markerLine.scrollIntoViewIfNeeded();
        const markerLabel = page
          .getByTestId(`global-time-marker-${marker.id}`)
          .first();
        await expect(markerLabel).toBeVisible();
        await expect(markerLabel).toContainText(marker.name);
        await expect(markerLabel).not.toContainText("08-11 10:30");
        await expect(markerLabel).toHaveCSS("pointer-events", "auto");
        await expect(markerLabel).toHaveAttribute("title", /2026\/08\/11 10:30/);
        await expect(markerLine).toBeVisible();
        if (route.empty) {
          await expect(page.getByTestId("time-canvas-empty")).toBeVisible();
          await expect(page.getByTestId("time-canvas-global-markers")).toBeVisible();
        }
        if (route.boundedRange) {
          const canvasRoot = page.getByTestId("time-canvas-root");
          const rangeStart = Number(
            await canvasRoot.getAttribute("data-range-start-ms"),
          );
          const rangeEnd = Number(
            await canvasRoot.getAttribute("data-range-end-ms"),
          );
          expect((rangeEnd - rangeStart) / (24 * 60 * 60 * 1000)).toBeLessThanOrEqual(
            1_100,
          );
        }
        const overflow = page.getByTestId("global-time-marker-overflow").first();
        await expect(overflow).toBeVisible();
        await expect(overflow).toContainText("+5 个关键点");
        await expect(overflow).toHaveAttribute(
          "aria-label",
          new RegExp(denseMarkers[0]!.name.slice(0, 24)),
        );
        await overflow.click();
        const overflowDialog = page.getByTestId(
          "global-time-marker-overflow-dialog",
        );
        await expect(overflowDialog).toBeVisible();
        await expect(
          overflowDialog.getByText(denseMarkers[0]!.name, { exact: true }),
        ).toBeVisible();
        await overflowDialog
          .getByTestId(`global-time-marker-overflow-item-${denseMarkers[0]!.id}`)
          .click();
        const prioritizedMarker = page.getByTestId(
          `global-time-marker-${denseMarkers[0]!.id}`,
        );
        await expect(prioritizedMarker).toBeVisible();
        await expect(prioritizedMarker).not.toContainText("08-11 10:31");
        await expect(prioritizedMarker).toHaveAttribute(
          "title",
          /2026\/08\/11 10:31/,
        );
        const visibleLabels = page
          .getByTestId("time-canvas-global-markers")
          .locator(
            "[data-testid^='global-time-marker-']:not([data-testid^='global-time-marker-line-'])",
          );
        const boxes = (await visibleLabels.evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            };
          }),
        )).filter((box) => box.right > box.left && box.bottom > box.top);
        for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
            const left = boxes[leftIndex]!;
            const right = boxes[rightIndex]!;
            expect(
              left.left < right.right &&
                left.right > right.left &&
                left.top < right.bottom &&
                left.bottom > right.top,
            ).toBe(false);
          }
        }
        await expect(page.getByText("全局关键节点")).toHaveCount(0);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth + 1,
          ),
        ).toBe(true);
        await expectHealthyPage(page);
      }
    } finally {
      await prisma.globalTimeMarker.update({
        where: { id: marker.id },
        data: { deletedAt: new Date() },
      });
      await prisma.globalTimeMarker.updateMany({
        where: { id: { in: denseMarkers.map((item) => item.id) } },
        data: { deletedAt: new Date() },
      });
      await prisma.globalTimeMarker.update({
        where: { id: extremeMarker.id },
        data: { deletedAt: new Date() },
      });
    }
  });
});
