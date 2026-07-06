import { expect, test } from "@playwright/test";
import { UserRoleType } from "@prisma/client";
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

const COMMENT_MUTED_SUPER_ADMIN_OPEN_ID = "ou_pw_comment_muted_super_admin";

test.describe.serial("progress project comments", () => {
  let fixtures: FunctionalFixtureIds;
  let normalAuth: Awaited<ReturnType<typeof resolveNormalAuthMaterial>>;

  test.beforeAll(async () => {
    normalAuth = await resolveNormalAuthMaterial();
    fixtures = await prepareFunctionalFixtures(normalAuth);
  });

  test.beforeEach(async () => {
    await prisma.notificationOutbox.deleteMany({
      where: {
        channel: "progress",
        type: { in: ["project_comment_created", "project_followed"] },
      },
    });
    await prisma.projectFollowPreference.deleteMany({
      where: {
        projectId: fixtures.projectId,
        openId: {
          in: [
            fixtures.normalOpenId,
            fixtures.otherOpenId,
            COMMENT_MUTED_SUPER_ADMIN_OPEN_ID,
          ],
        },
      },
    });
    await prisma.userRole.deleteMany({
      where: { openId: COMMENT_MUTED_SUPER_ADMIN_OPEN_ID },
    });
    await prisma.user.deleteMany({
      where: { openId: COMMENT_MUTED_SUPER_ADMIN_OPEN_ID },
    });
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
    await expect(panel.getByTestId("project-comment-auto-follow")).toBeChecked();
    await expect(panel.getByTestId("project-comment-auto-follow")).toBeDisabled();
    await expect(
      panel.getByText("已关注该项目，将接收后续项目通知"),
    ).toBeVisible();

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
    await expect
      .poll(async () => {
        const preference = await prisma.projectFollowPreference.findUnique({
          where: {
            projectId_openId: {
              projectId: fixtures.projectId,
              openId: fixtures.normalOpenId,
            },
          },
        });
        return preference?.state ?? null;
      })
      .toBe(null);

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

  test("unrelated viewer auto-follows after publishing a comment and notifies existing followers", async ({
    page,
    context,
    baseURL,
  }) => {
    await prisma.user.create({
      data: {
        openId: COMMENT_MUTED_SUPER_ADMIN_OPEN_ID,
        name: "PW评论已取关超管",
      },
    });
    await prisma.userRole.create({
      data: {
        openId: COMMENT_MUTED_SUPER_ADMIN_OPEN_ID,
        role: UserRoleType.SUPER_ADMIN,
      },
    });
    await prisma.projectFollowPreference.create({
      data: {
        projectId: fixtures.projectId,
        openId: COMMENT_MUTED_SUPER_ADMIN_OPEN_ID,
        state: "MUTED",
      },
    });

    await loginAsOtherUser(context, baseURL);
    await page.goto(`/progress/${fixtures.projectId}`, { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    const panel = page.getByTestId("project-comments-panel");
    await expect(panel.getByTestId("project-comment-auto-follow")).toBeChecked();
    await expect(panel.getByTestId("project-comment-auto-follow")).toBeEnabled();

    const content = `PW项目评论-自动关注-${Date.now()}`;
    await panel.getByTestId("project-comment-input").fill(content);
    await panel.getByTestId("project-comment-submit").click();
    await expect(
      panel.getByTestId("project-comment-item").filter({ hasText: content }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const preference = await prisma.projectFollowPreference.findUnique({
          where: {
            projectId_openId: {
              projectId: fixtures.projectId,
              openId: fixtures.otherOpenId,
            },
          },
          select: { state: true },
        });
        return preference?.state ?? null;
      })
      .toBe("FOLLOWING");

    const savedComment = await prisma.projectComment.findFirstOrThrow({
      where: {
        projectId: fixtures.projectId,
        authorOpenId: fixtures.otherOpenId,
        content,
        deletedAt: null,
      },
      select: { id: true },
    });
    const outbox = await prisma.notificationOutbox.findFirstOrThrow({
      where: { channel: "progress", type: "project_comment_created" },
      orderBy: { createdAt: "desc" },
    });
    expect(outbox.botKind).toBe("notification");
    const stored = JSON.parse(outbox.payload) as {
      payload: {
        type: string;
        projectId: string;
        projectName: string;
        authorOpenId: string;
        authorName: string;
        content: string;
        createdAt: string;
        team: string;
        techGroup: string;
        ownerNames: string;
        currentStageName: string;
        recipientOpenIds: string[];
      };
    };
    expect(outbox.eventKey).toBe(
      `progress:project_comment_created:${savedComment.id}`,
    );
    expect(stored.payload).toMatchObject({
      type: "project_comment_created",
      projectId: fixtures.projectId,
      projectName: expect.any(String),
      authorOpenId: fixtures.otherOpenId,
      authorName: expect.any(String),
      content,
      createdAt: expect.any(String),
      team: expect.any(String),
      techGroup: expect.any(String),
      ownerNames: expect.any(String),
      currentStageName: expect.any(String),
    });
    expect(new Date(stored.payload.createdAt).toString()).not.toBe("Invalid Date");
    expect(stored.payload.projectName.length).toBeGreaterThan(0);
    expect(stored.payload.authorName.length).toBeGreaterThan(0);
    expect(stored.payload.team.length).toBeGreaterThan(0);
    expect(stored.payload.techGroup.length).toBeGreaterThan(0);
    expect(stored.payload.ownerNames.length).toBeGreaterThan(0);
    expect(stored.payload.currentStageName.length).toBeGreaterThan(0);
    expect(stored.payload.recipientOpenIds).not.toContain(fixtures.otherOpenId);
    expect(stored.payload.recipientOpenIds).not.toContain(
      COMMENT_MUTED_SUPER_ADMIN_OPEN_ID,
    );
    expect(stored.payload.recipientOpenIds).toContain(fixtures.normalOpenId);
    expect(new Set(stored.payload.recipientOpenIds).size).toBe(
      stored.payload.recipientOpenIds.length,
    );
    await expect
      .poll(async () =>
        prisma.notificationOutbox.count({
          where: {
            channel: "progress",
            type: "project_followed",
            payload: { contains: fixtures.otherOpenId },
          },
        }),
      )
      .toBe(0);
    await expectNoHorizontalOverflow(page);
  });

  test("unrelated viewer can publish a comment without changing follow state", async ({
    page,
    context,
    baseURL,
  }) => {
    await loginAsOtherUser(context, baseURL);
    await page.goto(`/progress/${fixtures.projectId}`, { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    const panel = page.getByTestId("project-comments-panel");
    const checkbox = panel.getByTestId("project-comment-auto-follow");
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();

    const content = `PW项目评论-不关注-${Date.now()}`;
    await panel.getByTestId("project-comment-input").fill(content);
    await panel.getByTestId("project-comment-submit").click();
    await expect(
      panel.getByTestId("project-comment-item").filter({ hasText: content }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const preference = await prisma.projectFollowPreference.findUnique({
          where: {
            projectId_openId: {
              projectId: fixtures.projectId,
              openId: fixtures.otherOpenId,
            },
          },
          select: { state: true },
        });
        return preference?.state ?? null;
      })
      .toBe(null);
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
