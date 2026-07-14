import { expect, test, type Locator, type Page } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { updateProjectSchema } from "../lib/validations/progress";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

test.describe.configure({ mode: "serial" });

const prefix = "PW全功能-阶段多人";
const users = {
  owner: { openId: "ou_pw_stage_project_owner", name: "PW阶段项目负责人" },
  participant: { openId: "ou_pw_stage_participant", name: "PW阶段项目参与人" },
  stageA: { openId: "ou_pw_stage_owner_a", name: "PW阶段负责人甲" },
  stageB: { openId: "ou_pw_stage_owner_b", name: "PW阶段负责人乙" },
  manager: { openId: "ou_pw_stage_manager", name: "PW阶段项管" },
  teamLead: { openId: "ou_pw_stage_team_lead", name: "PW阶段车组组长" },
  techLead: { openId: "ou_pw_stage_tech_lead", name: "PW阶段技术组组长" },
  superAdmin: { openId: "ou_pw_stage_super", name: "PW阶段超管" },
  outsider: { openId: "ou_pw_stage_outsider", name: "PW阶段无关用户" },
};

let editableProjectId = "";
let editableStageId = "";
let editableSecondStageId = "";

test.beforeAll(async ({}, workerInfo) => {
  await prisma.project.deleteMany({ where: { name: { startsWith: prefix } } });
  const allUsers = Object.values(users);
  for (const user of allUsers) {
    await prisma.user.upsert({
      where: { openId: user.openId },
      update: { name: user.name },
      create: user,
    });
  }
  await prisma.userRole.deleteMany({
    where: { openId: { in: allUsers.map((user) => user.openId) } },
  });
  await prisma.userRole.createMany({
    data: [
      { openId: users.manager.openId, role: "PROJECT_MANAGER" },
      { openId: users.teamLead.openId, role: "TEAM_ADMIN", team: "英雄" },
      {
        openId: users.techLead.openId,
        role: "TECH_GROUP_ADMIN",
        techGroup: "电控",
      },
      { openId: users.superAdmin.openId, role: "SUPER_ADMIN" },
    ],
  });

  const project = await prisma.project.create({
    data: {
      name: `${prefix}-编辑-${workerInfo.project.name}`,
      description: "阶段多人负责人编辑测试",
      team: "英雄",
      techGroup: "电控",
      status: "IN_PROGRESS",
      ownerOpenId: users.owner.openId,
      ownerName: users.owner.name,
      owners: { create: [{ ...users.owner, sortOrder: 0 }] },
      participants: { create: [{ ...users.participant, sortOrder: 0 }] },
      stages: {
        create: [
          {
            name: `${prefix}-当前阶段`,
            goal: "原阶段目标",
            sortOrder: 0,
            status: "IN_PROGRESS",
            ownerOpenId: users.stageA.openId,
            ownerName: users.stageA.name,
            dueAt: addDays(new Date(), 5),
            evidenceUrl: "https://example.com/original-evidence",
            owners: {
              create: [
                { ...users.stageA, sortOrder: 0 },
                { ...users.stageB, sortOrder: 1 },
              ],
            },
          },
          {
            name: `${prefix}-后续阶段`,
            goal: "后续目标",
            sortOrder: 1,
            status: "NOT_STARTED",
            ownerOpenId: users.stageA.openId,
            ownerName: users.stageA.name,
            dueAt: addDays(new Date(), 10),
            owners: { create: [{ ...users.stageA, sortOrder: 0 }] },
          },
        ],
      },
    },
    include: { stages: { orderBy: { sortOrder: "asc" } } },
  });
  editableProjectId = project.id;
  editableStageId = project.stages[0]?.id ?? "";
  editableSecondStageId = project.stages[1]?.id ?? "";
});

test.afterAll(async () => {
  await prisma.project.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.userRole.deleteMany({
    where: { openId: { in: Object.values(users).map((user) => user.openId) } },
  });
});

test("立项表单支持多个阶段负责人并在审批后保留", async ({
  page,
  context,
  browser,
  baseURL,
}, testInfo) => {
  await loginAsTestUser(context, baseURL, users.owner);
  const projectName = `${prefix}-立项-${testInfo.project.name}`;
  await page.goto("/progress/new", { waitUntil: "networkidle" });
  await page.getByText("项目名称").locator("xpath=following::input[1]").fill(projectName);
  await selectUser(page, "搜索项目负责人", users.owner.openId);
  await page.getByText("车组").locator("xpath=following::button[1]").click();
  await page.getByRole("option", { name: "英雄" }).click();
  await page
    .getByText("技术组", { exact: true })
    .locator("xpath=following::button[1]")
    .click();
  await page.getByRole("option", { name: "电控" }).click();
  await selectUser(page, "搜索阶段负责人", users.stageB.openId, 0);
  await page.getByRole("button", { name: "提交立项" }).click();
  await expect(page).toHaveURL(/\/progress$/);

  const project = await prisma.project.findFirstOrThrow({
    where: { name: projectName },
    include: {
      stages: {
        orderBy: { sortOrder: "asc" },
        include: { owners: { orderBy: { sortOrder: "asc" } } },
      },
    },
  });
  expect(project.stages[0]?.owners.map((owner) => owner.openId)).toEqual([
    users.owner.openId,
    users.stageB.openId,
  ]);
  expect(project.stages[0]?.ownerOpenId).toBe(users.owner.openId);

  const reviewContext = await browser.newContext();
  try {
    await loginAsTestUser(reviewContext, baseURL, users.superAdmin);
    const reviewPage = await reviewContext.newPage();
    await reviewPage.goto(`/progress/${project.id}`, { waitUntil: "networkidle" });
    await reviewPage.getByRole("button", { name: "通过立项" }).click();
    await expect
      .poll(async () =>
        prisma.project.findUnique({ where: { id: project.id }, select: { status: true } }),
      )
      .toEqual({ status: "NOT_STARTED" });
  } finally {
    await reviewContext.close();
  }
  await expectHealthyPage(page);
});

test("编辑项目可修改阶段信息和多人负责人但保持结构与DDL", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsTestUser(context, baseURL, users.owner);
  const before = await prisma.projectStage.findUniqueOrThrow({
    where: { id: editableStageId },
    select: {
      dueAt: true,
      sortOrder: true,
      status: true,
      evidenceUrl: true,
      currentSubmissionId: true,
    },
  });
  const stageCount = await prisma.projectStage.count({
    where: { projectId: editableProjectId },
  });

  await page.goto(`/progress/${editableProjectId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "编辑项目" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑项目" });
  await expect(dialog.getByTestId("project-stage-editor")).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "添加" })).toHaveCount(0);
  await expect(dialog.getByLabel(/阶段 .*耗时/)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /上移阶段|下移阶段|删除阶段/ })).toHaveCount(0);

  const firstStage = dialog.getByTestId("project-stage-editor").first();
  await firstStage.getByText("阶段名称").locator("xpath=following::input[1]").fill(`${prefix}-已编辑`);
  await firstStage.getByText("阶段目标").locator("xpath=following::textarea[1]").fill("更新后的阶段目标");
  await firstStage.getByRole("button", { name: `移除${users.stageB.name}` }).click();
  await selectUser(
    page,
    "搜索阶段负责人",
    users.participant.openId,
    0,
    firstStage,
  );
  await dialog.getByRole("button", { name: "保存修改" }).click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(async () => {
      const stage = await prisma.projectStage.findUniqueOrThrow({
        where: { id: editableStageId },
        include: { owners: { orderBy: { sortOrder: "asc" } } },
      });
      return {
        name: stage.name,
        goal: stage.goal,
        ownerOpenIds: stage.owners.map((owner) => owner.openId),
        primaryOwnerOpenId: stage.ownerOpenId,
        dueAt: stage.dueAt?.toISOString(),
        sortOrder: stage.sortOrder,
        status: stage.status,
        evidenceUrl: stage.evidenceUrl,
        currentSubmissionId: stage.currentSubmissionId,
        count: await prisma.projectStage.count({ where: { projectId: editableProjectId } }),
      };
    })
    .toEqual({
      name: `${prefix}-已编辑`,
      goal: "更新后的阶段目标",
      ownerOpenIds: [users.stageA.openId, users.participant.openId],
      primaryOwnerOpenId: users.stageA.openId,
      dueAt: before.dueAt?.toISOString(),
      sortOrder: before.sortOrder,
      status: before.status,
      evidenceUrl: before.evidenceUrl,
      currentSubmissionId: before.currentSubmissionId,
      count: stageCount,
    });

  const outbox = await prisma.notificationOutbox.findFirstOrThrow({
    where: { eventKey: { startsWith: `progress:project_updated:${editableProjectId}:` } },
    orderBy: { createdAt: "desc" },
  });
  expect(outbox.payload).toContain("阶段名称");
  expect(outbox.payload).toContain(users.stageB.openId);
  expect(outbox.payload).toContain(users.participant.openId);
  expect(
    updateProjectSchema.safeParse({
      projectId: editableProjectId,
      expectedUpdatedAt: new Date().toISOString(),
      name: "非法字段",
      team: "英雄",
      techGroup: "电控",
      ownerOpenIds: [users.owner.openId],
      participantOpenIds: [],
      allowOwnerSelfApproval: false,
      stages: [
        {
          id: editableStageId,
          expectedUpdatedAt: new Date().toISOString(),
          name: "非法阶段",
          goal: "非法阶段目标",
          ownerOpenIds: [users.stageA.openId],
          dueAt: "2000-01-01T00:00:00.000Z",
        },
      ],
    }).success,
  ).toBe(false);

  const currentProject = await prisma.project.findUniqueOrThrow({
    where: { id: editableProjectId },
    include: { stages: { orderBy: { sortOrder: "asc" } } },
  });
  const validStageInputs = currentProject.stages.map((stage) => ({
    id: stage.id,
    expectedUpdatedAt: stage.updatedAt.toISOString(),
    name: stage.name,
    goal: stage.goal,
    ownerOpenIds: [users.stageA.openId],
  }));
  const baseUpdateInput = {
    projectId: currentProject.id,
    expectedUpdatedAt: currentProject.updatedAt.toISOString(),
    name: currentProject.name,
    description: currentProject.description,
    team: currentProject.team,
    techGroup: currentProject.techGroup,
    ownerOpenIds: [users.owner.openId],
    participantOpenIds: [users.participant.openId],
    allowOwnerSelfApproval: currentProject.allowOwnerSelfApproval,
  };
  expect(
    updateProjectSchema.safeParse({
      ...baseUpdateInput,
      stages: validStageInputs.map((stage, index) => ({
        ...stage,
        goal: index === 0 ? "" : stage.goal,
      })),
    }).success,
  ).toBe(true);
  expect(
    updateProjectSchema.safeParse({
      ...baseUpdateInput,
      stages: validStageInputs.map((stage, index) => ({
        ...stage,
        ownerOpenIds:
          index === 0
            ? [users.stageA.openId, users.stageA.openId]
            : stage.ownerOpenIds,
      })),
    }).success,
  ).toBe(false);

  await page.goto("/progress/list", { waitUntil: "networkidle" });
  const projectCard = page.getByRole("link", { name: new RegExp(currentProject.name) });
  await expect(projectCard).toContainText(users.stageA.name);
  await expect(projectCard).toContainText(users.participant.name);
  await expectHealthyPage(page);
});

test("编辑项目权限保持现有管理权限矩阵", async ({ browser, baseURL }) => {
  const allowed = [
    users.owner,
    users.manager,
    users.teamLead,
    users.techLead,
    users.superAdmin,
  ];
  const denied = [users.participant, users.stageA, users.outsider];
  for (const user of [...allowed, ...denied]) {
    const context = await browser.newContext();
    try {
      await loginAsTestUser(context, baseURL, user);
      const page = await context.newPage();
      await page.goto(`/progress/${editableProjectId}`, { waitUntil: "networkidle" });
      await expect(page.getByRole("button", { name: "编辑项目" })).toHaveCount(
        allowed.includes(user) ? 1 : 0,
      );
      await expectHealthyPage(page);
    } finally {
      await context.close();
    }
  }
});

test("阶段版本冲突时编辑项目整体回滚", async ({ page, context, baseURL }) => {
  await loginAsTestUser(context, baseURL, users.owner);
  await page.goto(`/progress/${editableProjectId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "编辑项目" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑项目" });
  const originalProject = await prisma.project.findUniqueOrThrow({
    where: { id: editableProjectId },
    select: { description: true },
  });
  await prisma.projectStage.update({
    where: { id: editableSecondStageId },
    data: { goal: "并发更新后的后续目标" },
  });
  await dialog.getByText("描述").locator("xpath=following::input[1]").fill("不应部分保存");
  await dialog.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("项目阶段已被更新，请刷新后重试")).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect
    .poll(async () =>
      prisma.project.findUniqueOrThrow({
        where: { id: editableProjectId },
        select: { description: true },
      }),
    )
    .toEqual(originalProject);
});

test("项目版本冲突和并发新增阶段时编辑整体回滚", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsTestUser(context, baseURL, users.owner);

  await page.goto(`/progress/${editableProjectId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "编辑项目" }).click();
  let dialog = page.getByRole("dialog", { name: "编辑项目" });
  await prisma.project.update({
    where: { id: editableProjectId },
    data: { description: "并发项目更新" },
  });
  await dialog.getByText("描述").locator("xpath=following::input[1]").fill("不应覆盖并发更新");
  await dialog.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("数据已被更新，请刷新后重试")).toBeVisible();
  await expect
    .poll(() =>
      prisma.project.findUniqueOrThrow({
        where: { id: editableProjectId },
        select: { description: true },
      }),
    )
    .toEqual({ description: "并发项目更新" });

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "编辑项目" }).click();
  dialog = page.getByRole("dialog", { name: "编辑项目" });
  const originalDescription = await prisma.project.findUniqueOrThrow({
    where: { id: editableProjectId },
    select: { description: true },
  });
  const insertedStage = await prisma.projectStage.create({
    data: {
      projectId: editableProjectId,
      name: `${prefix}-并发新增阶段`,
      goal: "不应被编辑接口忽略",
      sortOrder: 99,
      ownerOpenId: users.stageA.openId,
      ownerName: users.stageA.name,
      owners: { create: [{ ...users.stageA, sortOrder: 0 }] },
    },
  });
  try {
    await dialog.getByText("描述").locator("xpath=following::input[1]").fill("不应部分保存");
    await dialog.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByText(/项目阶段.*已更新，请刷新后重试/)).toBeVisible();
    await expect
      .poll(() =>
        prisma.project.findUniqueOrThrow({
          where: { id: editableProjectId },
          select: { description: true },
        }),
      )
      .toEqual(originalDescription);
  } finally {
    await prisma.projectStage.delete({ where: { id: insertedStage.id } });
  }
});

test("次要阶段负责人保持强制关注", async ({ browser, baseURL }, testInfo) => {
  const project = await createSubmissionProject(
    `${prefix}-强制关注-${testInfo.project.name}`,
    [users.stageA, users.stageB],
    [],
  );
  const context = await browser.newContext();
  try {
    await loginAsTestUser(context, baseURL, users.stageB);
    const page = await context.newPage();
    await page.goto(`/progress/${project.id}`, { waitUntil: "networkidle" });
    const followedButton = page.getByRole("button", { name: "已关注" });
    await expect(followedButton).toBeDisabled();
    await expect(followedButton.locator("xpath=..")).toHaveAttribute(
      "title",
      /阶段负责人.*必须接收该项目通知/,
    );
  } finally {
    await context.close();
  }
});

test("阶段负责人项目负责人参与人员和超管均可提交阶段材料", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000);
  const cases = [
    { label: "阶段第二负责人", actor: users.stageB, stageOwners: [users.stageA, users.stageB], participants: [] },
    { label: "项目负责人", actor: users.owner, stageOwners: [users.stageA], participants: [] },
    { label: "项目参与人员", actor: users.participant, stageOwners: [users.stageA], participants: [users.participant] },
    { label: "超级管理员", actor: users.superAdmin, stageOwners: [users.stageA], participants: [] },
  ];

  for (const item of cases) {
    const project = await createSubmissionProject(
      `${prefix}-提交-${item.label}-${testInfo.project.name}`,
      item.stageOwners,
      item.participants,
    );
    const context = await browser.newContext();
    try {
      await loginAsTestUser(context, baseURL, item.actor);
      const page = await context.newPage();
      await page.goto(`/progress/${project.id}`, { waitUntil: "networkidle" });
      await page.getByPlaceholder("文档或文件归档链接").fill("https://example.com/stage-evidence");
      await page.getByRole("button", { name: "提交阶段审批" }).click();
      await expect
        .poll(async () => {
          const stage = await prisma.projectStage.findUniqueOrThrow({
            where: { id: project.stageId },
          });
          const submission = await prisma.taskSubmission.findFirst({
            where: { stageId: project.stageId },
            orderBy: { submittedAt: "desc" },
          });
          return { status: stage.status, submittedBy: submission?.submittedBy };
        })
        .toEqual({ status: "PENDING_ACCEPTANCE", submittedBy: item.actor.openId });
      await expectHealthyPage(page);
    } finally {
      await context.close();
    }
  }

  const deniedProject = await createSubmissionProject(
    `${prefix}-提交-无权限-${testInfo.project.name}`,
    [users.stageA],
    [],
  );
  for (const deniedUser of [
    users.outsider,
    users.manager,
    users.teamLead,
    users.techLead,
  ]) {
    const deniedContext = await browser.newContext();
    try {
      await loginAsTestUser(deniedContext, baseURL, deniedUser);
      const page = await deniedContext.newPage();
      await page.goto(`/progress/${deniedProject.id}`, { waitUntil: "networkidle" });
      await expect(page.getByPlaceholder("文档或文件归档链接")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "提交阶段审批" })).toHaveCount(0);
      await expectHealthyPage(page);
    } finally {
      await deniedContext.close();
    }
  }
});

async function createSubmissionProject(
  name: string,
  stageOwners: Array<{ openId: string; name: string }>,
  participants: Array<{ openId: string; name: string }>,
) {
  const primaryStageOwner = stageOwners[0];
  if (!primaryStageOwner) throw new Error("测试阶段至少需要一名负责人");
  const project = await prisma.project.create({
    data: {
      name,
      team: "英雄",
      techGroup: "电控",
      status: "IN_PROGRESS",
      ownerOpenId: users.owner.openId,
      ownerName: users.owner.name,
      owners: { create: [{ ...users.owner, sortOrder: 0 }] },
      participants: {
        create: participants.map((participant, index) => ({
          ...participant,
          sortOrder: index,
        })),
      },
      stages: {
        create: {
          name: `${name}-当前阶段`,
          goal: "提交阶段材料权限测试",
          sortOrder: 0,
          status: "IN_PROGRESS",
          ownerOpenId: primaryStageOwner.openId,
          ownerName: primaryStageOwner.name,
          dueAt: addDays(new Date(), 5),
          owners: {
            create: stageOwners.map((owner, index) => ({ ...owner, sortOrder: index })),
          },
        },
      },
    },
    include: { stages: true },
  });
  const stageId = project.stages[0]?.id;
  if (!stageId) throw new Error("测试阶段创建失败");
  return { id: project.id, stageId };
}

async function selectUser(
  page: Page,
  placeholder: string,
  openId: string,
  index = 0,
  scope: Page | Locator = page,
) {
  await scope.getByPlaceholder(placeholder).nth(index).fill(openId);
  const option = page
    .locator(`[data-testid="user-search-option"][data-open-id="${openId}"]`)
    .first();
  await expect(option).toBeVisible();
  await option.click();
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
