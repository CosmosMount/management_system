import { expect, test, type Browser, type Page } from "@playwright/test";
import { ProjectStatus, StageStatus, TaskStatus, UserRoleType } from "@prisma/client";
import {
  expectHealthyPage,
  expectNoHorizontalOverflow,
  loginAsAdminUser,
  loginAsNormalUser,
  loginAsOtherUser,
  loginAsTestUser,
  prepareFunctionalFixtures,
  resolveNormalAuthMaterial,
  type FunctionalFixtureIds,
} from "./helpers/functional-fixtures";
import {
  collectProjectBatchDdlReviewRecipients,
  collectProjectNotificationRecipients,
} from "../lib/progress-project-notifications";
import {
  collectTaskManagementReviewRecipients,
  collectTaskNotificationRecipients,
} from "../lib/progress-task-notifications";
import {
  getProjectFollowPolicy,
  getTaskFollowPolicy,
} from "../lib/progress-following";
import { getProgressApprovalBoard } from "../lib/progress-approval-board";
import { getUserRoles } from "../lib/permissions";
import { prisma } from "../lib/prisma";

test.describe.serial("progress project and task following", () => {
  const superOnlyUser = {
    openId: "ou_pw_follow_super_only",
    name: "PW关注超管",
  };
  const projectManagerUser = {
    openId: "ou_pw_follow_project_manager",
    name: "PW关注项管",
  };
  const teamLeadUser = {
    openId: "ou_pw_follow_team_lead",
    name: "PW关注车组组长",
  };
  const techLeadUser = {
    openId: "ou_pw_follow_tech_lead",
    name: "PW关注技术组组长",
  };
  let fixtures: FunctionalFixtureIds;
  let normalAuth: Awaited<ReturnType<typeof resolveNormalAuthMaterial>>;
  let customProjectId = "";
  let customTaskId = "";

  test.beforeAll(async () => {
    normalAuth = await resolveNormalAuthMaterial();
    fixtures = await prepareFunctionalFixtures(normalAuth);
    await seedSuperOnlyUser(superOnlyUser);
    await seedRoleUser(projectManagerUser, UserRoleType.PROJECT_MANAGER);
    await seedRoleUser(teamLeadUser, UserRoleType.TEAM_ADMIN, { team: "英雄" });
    await seedRoleUser(techLeadUser, UserRoleType.TECH_GROUP_ADMIN, {
      techGroup: "电控",
    });
    const seeded = await seedCustomFollowingFixture({
      normalOpenId: fixtures.normalOpenId,
      adminOpenId: fixtures.adminOpenId,
    });
    customProjectId = seeded.projectId;
    customTaskId = seeded.taskId;
  });

  test("super admin can mute an unrelated project without losing approval permissions", async ({
    browser,
    baseURL,
  }) => {
    const page = await newLoggedPage(browser, baseURL, "super", normalAuth);
    await page.goto(`/progress/${fixtures.projectId}`, { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    await expect(page.getByRole("button", { name: "取消关注项目" })).toBeVisible();
    await page.getByRole("button", { name: "取消关注项目" }).click();
    await expect(page.getByRole("button", { name: "关注项目" })).toBeVisible();
    await expect(page.getByText("取消关注了项目通知").first()).toBeVisible();
    await expect(page.getByText("project.unfollowed")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    const preference = await prisma.projectFollowPreference.findUnique({
      where: {
        projectId_openId: {
          projectId: fixtures.projectId,
          openId: superOnlyUser.openId,
        },
      },
    });
    expect(preference?.state).toBe("MUTED");
    const followOutbox = await latestProgressOutboxPayload(
      `progress:project_unfollowed:${fixtures.projectId}:${superOnlyUser.openId}:`,
    );
    expect(followOutbox?.botKind).toBe("notification");
    expect(followOutbox?.payload.type).toBe("project_unfollowed");
    expect(followOutbox?.payload.recipientOpenIds).toEqual([superOnlyUser.openId]);
    expect(followOutbox?.payload.projectName).toBeTruthy();
    expect(followOutbox?.payload.ownerNames).toBeTruthy();
    expect(followOutbox?.payload.projectStatus).toBeTruthy();

    const project = await loadProjectForRecipients(fixtures.projectId);
    const recipients = await collectProjectNotificationRecipients(project);
    expect(recipients).not.toContain(superOnlyUser.openId);
    expect(
      await collectProjectBatchDdlReviewRecipients(project, fixtures.normalOpenId),
    ).not.toContain(superOnlyUser.openId);

    const ddlRequest = await prisma.projectDdlChangeRequest.create({
      data: {
        projectId: fixtures.projectId,
        stageId: fixtures.projectCurrentStageId,
        type: "CASCADE_EXTENSION",
        status: "PENDING",
        pendingKey: `pw-follow-board-${Date.now()}`,
        requesterOpenId: fixtures.normalOpenId,
        requesterName: "李棋轩",
        reason: "PW关注测试：取关后仍应保留审批权限",
        oldDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        newDueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        durationDays: 1,
      },
    });
    const board = await getProgressApprovalBoard({
      roles: await getUserRoles(superOnlyUser.openId),
      userOpenId: superOnlyUser.openId,
    });
    expect(board.categories.flatMap((category) => category.items).map((item) => item.id)).toContain(
      `project-ddl:${ddlRequest.id}`,
    );
  });

  test("project members see a forced project follow state with a clear reason", async ({
    browser,
    baseURL,
  }) => {
    const page = await newLoggedPage(browser, baseURL, "normal", normalAuth);
    await page.goto(`/progress/${fixtures.projectId}`, { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    const button = page.getByRole("button", { name: "已关注" }).first();
    await expect(button).toBeDisabled();
    await expect(
      page.getByTitle(/不能取消关注：你是项目负责人，必须接收该项目通知/),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("a viewer can explicitly follow a single task", async ({ browser, baseURL }) => {
    const page = await newLoggedPage(browser, baseURL, "other", normalAuth);
    await page.goto(`/progress/task/${customTaskId}`, { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    await expect(page.getByRole("button", { name: "关注任务" })).toBeVisible();
    await page.getByRole("button", { name: "关注任务" }).click();
    await expect(page.getByRole("button", { name: "取消关注任务" })).toBeVisible();
    await expect(page.getByText("关注了任务通知").first()).toBeVisible();
    await expect(page.getByText("task.followed")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    const preference = await prisma.taskFollowPreference.findUnique({
      where: {
        taskId_openId: {
          taskId: customTaskId,
          openId: fixtures.otherOpenId,
        },
      },
    });
    expect(preference?.state).toBe("FOLLOWING");
    const followOutbox = await latestProgressOutboxPayload(
      `progress:task_followed:${customTaskId}:${fixtures.otherOpenId}:`,
    );
    expect(followOutbox?.botKind).toBe("notification");
    expect(followOutbox?.payload.type).toBe("task_followed");
    expect(followOutbox?.payload.recipientOpenIds).toEqual([fixtures.otherOpenId]);
    expect(followOutbox?.payload.projectName).toBeTruthy();
    expect(followOutbox?.payload.stageName).toBeTruthy();
    expect(followOutbox?.payload.assigneeNames).toBeTruthy();
    expect(followOutbox?.payload.taskStatus).toBeTruthy();

    const task = await loadTaskForRecipients(customTaskId);
    const recipients = await collectTaskNotificationRecipients(task);
    expect(recipients).toContain(fixtures.otherOpenId);
    expect(await collectTaskManagementReviewRecipients(task)).not.toContain(
      fixtures.otherOpenId,
    );
  });

  test("project participant can mute one task while remaining a project follower", async ({
    browser,
    baseURL,
  }) => {
    const page = await newLoggedPage(browser, baseURL, "normal", normalAuth);
    await page.goto(`/progress/task/${customTaskId}`, { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    await expect(page.getByRole("button", { name: "取消关注任务" })).toBeVisible();
    await page.getByRole("button", { name: "取消关注任务" }).click();
    await expect(page.getByRole("button", { name: "关注任务" })).toBeVisible();

    const taskPreference = await prisma.taskFollowPreference.findUnique({
      where: {
        taskId_openId: {
          taskId: customTaskId,
          openId: fixtures.normalOpenId,
        },
      },
    });
    expect(taskPreference?.state).toBe("MUTED");

    const project = await loadProjectForRecipients(customProjectId);
    const task = await loadTaskForRecipients(customTaskId);
    expect(await collectProjectNotificationRecipients(project)).toContain(
      fixtures.normalOpenId,
    );
    expect(await collectTaskNotificationRecipients(task)).not.toContain(
      fixtures.normalOpenId,
    );
  });

  test("explicit task follow overrides inherited project mute", async () => {
    await prisma.projectFollowPreference.upsert({
      where: {
        projectId_openId: {
          projectId: customProjectId,
          openId: superOnlyUser.openId,
        },
      },
      update: { state: "MUTED" },
      create: {
        projectId: customProjectId,
        openId: superOnlyUser.openId,
        state: "MUTED",
      },
    });
    await prisma.taskFollowPreference.deleteMany({
      where: { taskId: customTaskId, openId: superOnlyUser.openId },
    });

    const mutedTask = await loadTaskForRecipients(customTaskId);
    expect(await collectTaskNotificationRecipients(mutedTask)).not.toContain(
      superOnlyUser.openId,
    );

    await prisma.taskFollowPreference.create({
      data: {
        taskId: customTaskId,
        openId: superOnlyUser.openId,
        state: "FOLLOWING",
      },
    });

    const followedTask = await loadTaskForRecipients(customTaskId);
    expect(await collectTaskNotificationRecipients(followedTask)).toContain(
      superOnlyUser.openId,
    );
  });

  test("task owner cannot mute a forced task follow", async ({ browser, baseURL }) => {
    const page = await newLoggedPage(browser, baseURL, "admin", normalAuth);
    await page.goto(`/progress/task/${customTaskId}`, { waitUntil: "networkidle" });
    await expectHealthyPage(page);

    const button = page.getByRole("button", { name: "已关注" }).first();
    await expect(button).toBeDisabled();
    await expect(
      page.getByTitle(/不能取消关注：.*必须接收该任务通知/),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("project managers and matching team or tech leads are forced followers", async () => {
    const project = await loadProjectForRecipients(customProjectId);
    const task = await loadTaskForRecipients(customTaskId);
    for (const user of [projectManagerUser, teamLeadUser, techLeadUser]) {
      const roles = await getUserRoles(user.openId);
      const projectPolicy = await getProjectFollowPolicy({
        project,
        userOpenId: user.openId,
        roles,
      });
      expect(projectPolicy.followedByCurrentUser).toBe(true);
      expect(projectPolicy.forcedFollowedByCurrentUser).toBe(true);
      expect(projectPolicy.canUnfollow).toBe(false);
      if (user.openId === teamLeadUser.openId) {
        expect(projectPolicy.forcedFollowReasons).toContain(
          "你是该项目车组组长，必须接收该项目通知",
        );
      }
      if (user.openId === techLeadUser.openId) {
        expect(projectPolicy.forcedFollowReasons).toContain(
          "你是该项目技术组组长，必须接收该项目通知",
        );
      }

      const taskPolicy = await getTaskFollowPolicy({
        task,
        userOpenId: user.openId,
        roles,
      });
      expect(taskPolicy.followedByCurrentUser).toBe(true);
      expect(taskPolicy.forcedFollowedByCurrentUser).toBe(true);
      expect(taskPolicy.canUnfollow).toBe(false);
      if (user.openId === teamLeadUser.openId) {
        expect(taskPolicy.forcedFollowReasons).toContain(
          "你是该任务车组组长，必须接收该任务通知",
        );
      }
      if (user.openId === techLeadUser.openId) {
        expect(taskPolicy.forcedFollowReasons).toContain(
          "你是该任务技术组组长，必须接收该任务通知",
        );
      }
    }
  });
});

async function newLoggedPage(
  browser: Browser,
  baseURL: string | undefined,
  user: "admin" | "normal" | "other" | "super",
  normalAuth: Awaited<ReturnType<typeof resolveNormalAuthMaterial>>,
): Promise<Page> {
  const context = await browser.newContext();
  if (user === "admin") {
    await loginAsAdminUser(context, baseURL);
  } else if (user === "super") {
    await loginAsTestUser(context, baseURL, {
      openId: "ou_pw_follow_super_only",
      name: "PW关注超管",
    });
  } else if (user === "normal") {
    await loginAsNormalUser(context, baseURL, normalAuth);
  } else {
    await loginAsOtherUser(context, baseURL);
  }
  return context.newPage();
}

async function latestProgressOutboxPayload(eventKeyPrefix: string) {
  const outbox = await prisma.notificationOutbox.findFirst({
    where: { eventKey: { startsWith: eventKeyPrefix } },
    orderBy: { createdAt: "desc" },
    select: { botKind: true, payload: true },
  });
  if (!outbox) return null;
  const parsed = JSON.parse(outbox.payload) as {
    payload: Record<string, unknown>;
  };
  return { botKind: outbox.botKind, payload: parsed.payload };
}

async function seedSuperOnlyUser(user: { openId: string; name: string }) {
  await seedRoleUser(user, UserRoleType.SUPER_ADMIN);
}

async function seedRoleUser(
  user: { openId: string; name: string },
  role: UserRoleType,
  scope: { team?: string; techGroup?: string } = {},
) {
  await prisma.user.upsert({
    where: { openId: user.openId },
    update: { name: user.name },
    create: { openId: user.openId, name: user.name },
  });
  await prisma.userRole.deleteMany({ where: { openId: user.openId } });
  await prisma.userRole.create({
    data: {
      openId: user.openId,
      role,
      team: scope.team ?? "",
      techGroup: scope.techGroup ?? "",
    },
  });
}

async function seedCustomFollowingFixture({
  normalOpenId,
  adminOpenId,
}: {
  normalOpenId: string;
  adminOpenId: string;
}) {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { openId: adminOpenId },
    select: { name: true },
  });
  const normal = await prisma.user.findUniqueOrThrow({
    where: { openId: normalOpenId },
    select: { name: true },
  });
  const dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const project = await prisma.project.create({
    data: {
      name: `PW关注项目-${Date.now()}`,
      description: "progress following fixture",
      team: "英雄",
      techGroup: "电控",
      status: ProjectStatus.IN_PROGRESS,
      ownerOpenId: adminOpenId,
      ownerName: admin.name,
      owners: {
        create: [{ openId: adminOpenId, name: admin.name, sortOrder: 0 }],
      },
      participants: {
        create: [{ openId: normalOpenId, name: normal.name, sortOrder: 0 }],
      },
      stages: {
        create: [
          {
            name: "关注测试阶段",
            goal: "following fixture stage",
            sortOrder: 0,
            status: StageStatus.IN_PROGRESS,
            ownerOpenId: adminOpenId,
            ownerName: admin.name,
            dueAt,
          },
        ],
      },
    },
    include: { stages: true },
  });
  const stage = project.stages[0];
  if (!stage) throw new Error("Missing following fixture stage");
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      stageId: stage.id,
      title: `PW关注任务-${Date.now()}`,
      goal: "following fixture task",
      urgency: "MEDIUM",
      importance: "MEDIUM",
      assigneeOpenId: adminOpenId,
      assigneeName: admin.name,
      team: project.team,
      techGroup: project.techGroup,
      metrics: "following metrics",
      dueAt,
      status: TaskStatus.IN_PROGRESS,
      assignees: {
        create: [{ openId: adminOpenId, name: admin.name, sortOrder: 0 }],
      },
      techGroups: {
        create: [{ techGroup: "电控", sortOrder: 0 }],
      },
    },
  });
  return { projectId: project.id, taskId: task.id };
}

async function loadProjectForRecipients(projectId: string) {
  return prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: { orderBy: { sortOrder: "asc" } },
      tasks: {
        where: { deletedAt: null },
        include: {
          assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      followPreferences: true,
    },
  });
}

async function loadTaskForRecipients(taskId: string) {
  return prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: {
      assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      followPreferences: true,
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          participants: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          },
          stages: { orderBy: { sortOrder: "asc" } },
          tasks: {
            where: { deletedAt: null },
            include: {
              assignees: {
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              },
            },
          },
          followPreferences: true,
        },
      },
    },
  });
}
