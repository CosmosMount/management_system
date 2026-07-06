import { expect, test } from "@playwright/test";
import {
  expectHealthyPage,
  expectNoHorizontalOverflow,
  loginAsAdminUser,
  loginAsNormalUser,
  loginAsOtherUser,
  prepareFunctionalFixtures,
  resolveNormalAuthMaterial,
  type FunctionalFixtureIds,
} from "./helpers/functional-fixtures";
import { canDeleteProjectComment } from "../lib/progress-project-comments";
import { getUserRoles } from "../lib/permissions";
import { prisma } from "../lib/prisma";

test.describe.serial("progress project comments", () => {
  let fixtures: FunctionalFixtureIds;
  let normalAuth: Awaited<ReturnType<typeof resolveNormalAuthMaterial>>;

  test.beforeAll(async () => {
    normalAuth = await resolveNormalAuthMaterial();
    fixtures = await prepareFunctionalFixtures(normalAuth);
  });

  test.beforeEach(async () => {
    await prisma.projectComment.deleteMany({
      where: { projectId: fixtures.projectId },
    });
  });

  test("project member can publish and delete their own project comment", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAsNormalUser(context, baseURL, normalAuth);
    await page.goto(`/progress/${fixtures.projectId}`, { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    const panel = page.getByTestId("project-comments-panel");
    await expect(panel.getByText("项目评论", { exact: true })).toBeVisible();
    await expect(panel.getByTestId("project-comment-submit")).toBeDisabled();

    const content = `PW项目评论-${Date.now()}\n这里记录一个跨阶段讨论结论。`;
    await panel.getByTestId("project-comment-input").fill(content);
    await panel.getByTestId("project-comment-submit").click();

    const item = panel.getByTestId("project-comment-item").filter({
      hasText: content,
    });
    await expect(item).toBeVisible();
    await expect(item.getByText("李棋轩")).toBeVisible();

    const saved = await prisma.projectComment.findFirstOrThrow({
      where: {
        projectId: fixtures.projectId,
        authorOpenId: fixtures.normalOpenId,
        content,
        deletedAt: null,
      },
    });
    await expect
      .poll(async () => {
        const log = await prisma.progressActivityLog.findFirst({
          where: {
            projectId: fixtures.projectId,
            action: "project.comment_created",
            payload: { contains: saved.id },
          },
        });
        return !!log;
      })
      .toBe(true);

    await item.getByTestId("project-comment-delete").click();
    await expect(item).toHaveCount(0);
    await expect
      .poll(async () => {
        const deleted = await prisma.projectComment.findUnique({
          where: { id: saved.id },
          select: { deletedAt: true, deletedByOpenId: true },
        });
        return {
          deleted: !!deleted?.deletedAt,
          deletedByOpenId: deleted?.deletedByOpenId,
        };
      })
      .toEqual({ deleted: true, deletedByOpenId: fixtures.normalOpenId });
    await expectNoHorizontalOverflow(page);
  });

  test("unrelated viewer can read but cannot delete another user's comment", async ({
    page,
    context,
    baseURL,
  }) => {
    const content = `PW项目评论-旁观者不可删-${Date.now()}`;
    await prisma.projectComment.create({
      data: {
        projectId: fixtures.projectId,
        authorOpenId: fixtures.normalOpenId,
        authorName: "李棋轩",
        content,
      },
    });

    await loginAsOtherUser(context, baseURL);
    await page.goto(`/progress/${fixtures.projectId}`, { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    const item = page
      .getByTestId("project-comments-panel")
      .getByTestId("project-comment-item")
      .filter({ hasText: content });
    await expect(item).toBeVisible();
    await expect(item.getByTestId("project-comment-delete")).toHaveCount(0);
    const [viewerRoles, project] = await Promise.all([
      getUserRoles(fixtures.otherOpenId),
      prisma.project.findUniqueOrThrow({
        where: { id: fixtures.projectId },
        include: { owners: true },
      }),
    ]);
    expect(
      canDeleteProjectComment({
        roles: viewerRoles,
        project,
        authorOpenId: fixtures.normalOpenId,
        userOpenId: fixtures.otherOpenId,
      }),
    ).toBe(false);
    await expectNoHorizontalOverflow(page);
  });

  test("project manager can delete another user's project comment", async ({
    page,
    context,
    baseURL,
  }) => {
    const content = `PW项目评论-管理员删除-${Date.now()}`;
    const comment = await prisma.projectComment.create({
      data: {
        projectId: fixtures.projectId,
        authorOpenId: fixtures.otherOpenId,
        authorName: "Playwright 旁观者",
        content,
      },
    });

    await loginAsAdminUser(context, baseURL);
    await page.goto(`/progress/${fixtures.projectId}`, { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    const item = page
      .getByTestId("project-comments-panel")
      .getByTestId("project-comment-item")
      .filter({ hasText: content });
    await expect(item).toBeVisible();
    await item.getByTestId("project-comment-delete").click();
    await expect(item).toHaveCount(0);

    await expect
      .poll(async () => {
        const deleted = await prisma.projectComment.findUnique({
          where: { id: comment.id },
          select: { deletedAt: true, deletedByOpenId: true },
        });
        return {
          deleted: !!deleted?.deletedAt,
          deletedByOpenId: deleted?.deletedByOpenId,
        };
      })
      .toEqual({ deleted: true, deletedByOpenId: fixtures.adminOpenId });
    const [adminRoles, project] = await Promise.all([
      getUserRoles(fixtures.adminOpenId),
      prisma.project.findUniqueOrThrow({
        where: { id: fixtures.projectId },
        include: { owners: true },
      }),
    ]);
    expect(
      canDeleteProjectComment({
        roles: adminRoles,
        project,
        authorOpenId: fixtures.otherOpenId,
        userOpenId: fixtures.adminOpenId,
      }),
    ).toBe(true);
  });

  test("legacy project ownerOpenId still grants comment deletion when owner rows are absent", async () => {
    expect(
      canDeleteProjectComment({
        roles: [],
        project: {
          team: "英雄",
          techGroup: "电控",
          ownerOpenId: fixtures.normalOpenId,
          owners: [],
        },
        authorOpenId: fixtures.otherOpenId,
        userOpenId: fixtures.normalOpenId,
      }),
    ).toBe(true);
  });
});
