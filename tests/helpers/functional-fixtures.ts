import fs from "node:fs";
import path from "node:path";
import { decode, encode } from "@auth/core/jwt";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { Cookie } from "@playwright/test";
import {
  FeedbackStatus,
  FileAssetKind,
  Importance,
  OrderStatus,
  Prisma,
  ProgressReminderKind,
  ProjectStatus,
  StageStatus,
  TaskRiskSource,
  TaskRiskStatus,
  TaskStatus,
  Urgency,
  UserRoleType,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { storagePathToAbsolute } from "../../lib/upload-paths";

const SESSION_COOKIE_NAME = "authjs.session-token";
const TEST_PREFIX = "PW全功能";
const FALLBACK_NORMAL_OPEN_ID = "ou_playwright_liqixuan";
const FALLBACK_ADMIN_OPEN_ID = "ou_playwright_admin";
const FALLBACK_OTHER_OPEN_ID = "ou_playwright_other";
const FALLBACK_NORMAL_NAME = "李棋轩";
const FALLBACK_ADMIN_NAME = "Playwright 管理员";
const FALLBACK_OTHER_NAME = "Playwright 旁观者";
const NORMAL_SIGNATURE_PUBLIC_PATH = "/uploads/playwright/signature-normal.png";
const ADMIN_SIGNATURE_PUBLIC_PATH = "/uploads/playwright/signature-admin.png";
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

type AuthMaterial = {
  openId: string;
  name: string;
  cookies?: Cookie[];
};

export type FunctionalFixtureIds = {
  normalOpenId: string;
  adminOpenId: string;
  otherOpenId: string;
  draftOrderId: string;
  reviewOrderId: string;
  managementRejectOrderId: string;
  teacherRejectOrderId: string;
  reimbursementOrderId: string;
  projectId: string;
  projectCurrentStageId: string;
  taskId: string;
  taskRequestProjectId: string;
  stageDueChangeProjectId: string;
  stageDueChangeCurrentStageId: string;
  stageDueChangeNextStageId: string;
  todoTaskId: string;
  deliveryTaskId: string;
  deliveryRejectTaskId: string;
  ddlRejectTaskId: string;
  deletionTaskId: string;
  deletionRejectTaskId: string;
  completableProjectId: string;
  cancelProjectId: string;
  cancelTodoTaskId: string;
  cancelInProgressTaskId: string;
  cancelPendingTaskId: string;
  cancelCompletedTaskId: string;
  cancelArchivedTaskId: string;
  uploadPublicPath: string;
  openFeedbackId: string;
  closedFeedbackId: string;
};

export async function resolveNormalAuthMaterial(): Promise<AuthMaterial> {
  if (process.env.PLAYWRIGHT_USE_STORAGE_NORMAL === "true") {
    const storagePath =
      process.env.PLAYWRIGHT_NORMAL_STORAGE_STATE ??
      path.join(process.cwd(), ".tmp/playwright-liqixuan-storage.json");
    const storage = readStorageState(storagePath);
    if (!storage) {
      throw new Error(
        `PLAYWRIGHT_USE_STORAGE_NORMAL=true 但无法读取 storage state: ${storagePath}`,
      );
    }
    const openId = storage
      ? await readOpenIdFromStorageState(storage.cookies)
      : undefined;
    if (!openId) {
      throw new Error(
        `PLAYWRIGHT_USE_STORAGE_NORMAL=true 但 storage state 未包含有效 openId: ${storagePath}`,
      );
    }

    return {
      openId,
      name: FALLBACK_NORMAL_NAME,
      cookies: storage.cookies,
    };
  }

  return {
    openId: FALLBACK_NORMAL_OPEN_ID,
    name: FALLBACK_NORMAL_NAME,
  };
}

export async function prepareFunctionalFixtures(
  normalAuth: AuthMaterial,
): Promise<FunctionalFixtureIds> {
  assertTestDatabase();

  const normalOpenId = normalAuth.openId;
  const adminOpenId = FALLBACK_ADMIN_OPEN_ID;
  const now = new Date();
  const yesterday = addDays(now, -1);
  const tomorrow = addDays(now, 1);
  const nextWeek = addDays(now, 7);

  await cleanupFunctionalFixtures([normalOpenId, adminOpenId, FALLBACK_OTHER_OPEN_ID]);
  await createPlaywrightSignatureFiles({
    normalOpenId,
    adminOpenId,
  });

  await prisma.user.upsert({
    where: { openId: normalOpenId },
    update: {
      name: FALLBACK_NORMAL_NAME,
      signaturePath: NORMAL_SIGNATURE_PUBLIC_PATH,
    },
    create: {
      openId: normalOpenId,
      name: FALLBACK_NORMAL_NAME,
      signaturePath: NORMAL_SIGNATURE_PUBLIC_PATH,
    },
  });
  await prisma.user.upsert({
    where: { openId: FALLBACK_OTHER_OPEN_ID },
    update: { name: FALLBACK_OTHER_NAME },
    create: { openId: FALLBACK_OTHER_OPEN_ID, name: FALLBACK_OTHER_NAME },
  });
  await prisma.user.upsert({
    where: { openId: adminOpenId },
    update: {
      name: FALLBACK_ADMIN_NAME,
      signaturePath: ADMIN_SIGNATURE_PUBLIC_PATH,
    },
    create: {
      openId: adminOpenId,
      name: FALLBACK_ADMIN_NAME,
      signaturePath: ADMIN_SIGNATURE_PUBLIC_PATH,
    },
  });

  await prisma.userRole.deleteMany({
    where: { openId: { in: [normalOpenId, FALLBACK_OTHER_OPEN_ID] } },
  });

  await prisma.userRole.createMany({
    data: [
      { openId: adminOpenId, role: UserRoleType.SUPER_ADMIN },
      { openId: adminOpenId, role: UserRoleType.PROJECT_MANAGER },
      { openId: adminOpenId, role: UserRoleType.TEAM_ADMIN, team: "英雄" },
      {
        openId: adminOpenId,
        role: UserRoleType.TECH_GROUP_ADMIN,
        techGroup: "电控",
      },
      { openId: adminOpenId, role: UserRoleType.FINANCE, techGroup: "电控" },
      { openId: adminOpenId, role: UserRoleType.TEACHER, techGroup: "电控" },
    ],
    skipDuplicates: true,
  });

  await seedAdminReferenceData();

  const draftOrder = await prisma.purchaseOrder.create({
    data: {
      orderNo: "PW-FULL-DRAFT",
      initiatorId: (await getUserId(normalOpenId)),
      initiatorName: FALLBACK_NORMAL_NAME,
      team: "英雄",
      techGroup: "电控",
      totalPrice: 128,
      status: OrderStatus.DRAFT,
      items: {
        create: [
          {
            name: `${TEST_PREFIX}-草稿物料`,
            spec: "A1",
            purchaseLink: "https://example.com/item-a1",
            quantity: 2,
            unitPrice: 64,
          },
        ],
      },
    },
  });

  const reviewOrder = await prisma.purchaseOrder.create({
    data: {
      orderNo: "PW-FULL-REVIEW",
      initiatorId: (await getUserId(normalOpenId)),
      initiatorName: FALLBACK_NORMAL_NAME,
      team: "英雄",
      techGroup: "电控",
      totalPrice: 256,
      status: OrderStatus.MANAGEMENT_REVIEW,
      items: {
        create: [
          {
            name: `${TEST_PREFIX}-审核物料`,
            spec: "B2",
            purchaseLink: "https://example.com/item-b2",
            quantity: 4,
            unitPrice: 64,
          },
        ],
      },
    },
  });

  const managementRejectOrder = await prisma.purchaseOrder.create({
    data: {
      orderNo: "PW-FULL-MGMT-REJECT",
      initiatorId: (await getUserId(normalOpenId)),
      initiatorName: FALLBACK_NORMAL_NAME,
      team: "英雄",
      techGroup: "电控",
      totalPrice: 96,
      status: OrderStatus.MANAGEMENT_REVIEW,
      items: {
        create: [
          {
            name: `${TEST_PREFIX}-管理驳回物料`,
            spec: "R1",
            purchaseLink: "https://example.com/reject-r1",
            quantity: 1,
            unitPrice: 96,
          },
        ],
      },
    },
  });

  const teacherRejectOrder = await prisma.purchaseOrder.create({
    data: {
      orderNo: "PW-FULL-TEACHER-REJECT",
      initiatorId: (await getUserId(normalOpenId)),
      initiatorName: FALLBACK_NORMAL_NAME,
      team: "英雄",
      techGroup: "电控",
      totalPrice: 144,
      status: OrderStatus.TEACHER_REVIEW,
      teamApproved: true,
      techGroupApproved: true,
      teamApproverOpenId: adminOpenId,
      techGroupApproverOpenId: adminOpenId,
      items: {
        create: [
          {
            name: `${TEST_PREFIX}-老师驳回物料`,
            spec: "R2",
            purchaseLink: "https://example.com/reject-r2",
            quantity: 2,
            unitPrice: 72,
          },
        ],
      },
    },
  });

  const reimbursementOrder = await prisma.purchaseOrder.create({
    data: {
      orderNo: "PW-FULL-REIMBURSE",
      initiatorId: (await getUserId(normalOpenId)),
      initiatorName: FALLBACK_NORMAL_NAME,
      team: "英雄",
      techGroup: "电控",
      totalPrice: 188,
      status: OrderStatus.PENDING_APPLICANT_DOCS,
      teamApproved: true,
      techGroupApproved: true,
      teamApproverOpenId: adminOpenId,
      techGroupApproverOpenId: adminOpenId,
      items: {
        create: [
          {
            name: `${TEST_PREFIX}-报销物料`,
            spec: "BXR",
            purchaseLink: "https://example.com/reimburse",
            quantity: 2,
            unitPrice: 94,
          },
        ],
      },
    },
  });

  const project = await prisma.project.create({
    data: {
      name: `${TEST_PREFIX}-逾期项目`,
      description: "Playwright fixture project",
      team: "英雄",
      techGroup: "电控",
      status: ProjectStatus.IN_PROGRESS,
      ownerOpenId: normalOpenId,
      ownerName: FALLBACK_NORMAL_NAME,
      allowOwnerSelfApproval: true,
      owners: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      participants: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
    },
  });

  const overdueStage = await prisma.projectStage.create({
    data: {
      projectId: project.id,
      name: `${TEST_PREFIX}-当前阶段`,
      goal: "验证阶段 DDL 风险展示",
      sortOrder: 0,
      status: StageStatus.IN_PROGRESS,
      ownerOpenId: normalOpenId,
      ownerName: FALLBACK_NORMAL_NAME,
      dueAt: yesterday,
    },
  });

  await prisma.projectStage.create({
    data: {
      projectId: project.id,
      name: `${TEST_PREFIX}-后续阶段`,
      goal: "验证阶段列表",
      sortOrder: 1,
      status: StageStatus.NOT_STARTED,
      ownerOpenId: normalOpenId,
      ownerName: FALLBACK_NORMAL_NAME,
      dueAt: nextWeek,
    },
  });

  await prisma.projectStage.create({
    data: {
      projectId: project.id,
      name: `${TEST_PREFIX}-第三阶段`,
      goal: "验证批量 DDL 调整范围",
      sortOrder: 2,
      status: StageStatus.NOT_STARTED,
      ownerOpenId: normalOpenId,
      ownerName: FALLBACK_NORMAL_NAME,
      dueAt: addDays(nextWeek, 7),
    },
  });

  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      stageId: overdueStage.id,
      title: `${TEST_PREFIX}-逾期任务`,
      goal: "验证任务面板、风险和技术组展示",
      urgency: Urgency.HIGH,
      importance: Importance.HIGH,
      assigneeOpenId: normalOpenId,
      assigneeName: FALLBACK_NORMAL_NAME,
      team: "英雄",
      techGroup: "电控",
      dueAt: yesterday,
      status: TaskStatus.IN_PROGRESS,
      isOverdue: true,
      needsWeeklyReport: true,
      metrics: "完成 Playwright 检查",
      riskNote: `${TEST_PREFIX}-活动风险`,
      riskUpdatedAt: now,
      assignees: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      techGroups: {
        create: [
          { techGroup: "电控", sortOrder: 0 },
          { techGroup: "宣运", sortOrder: 1 },
        ],
      },
      riskRecords: {
        create: [
          {
            content: `${TEST_PREFIX}-活动风险`,
            source: TaskRiskSource.MANUAL,
            status: TaskRiskStatus.ACTIVE,
            createdByOpenId: normalOpenId,
            createdByName: FALLBACK_NORMAL_NAME,
          },
        ],
      },
      acceptanceChecklistItems: {
        create: [
          {
            content: `${TEST_PREFIX}-验收项`,
            sortOrder: 0,
          },
        ],
      },
    },
  });

  const todoTask = await prisma.task.create({
    data: {
      projectId: project.id,
      stageId: overdueStage.id,
      title: `${TEST_PREFIX}-待开始任务`,
      goal: "验证任务开始状态流转",
      urgency: Urgency.LOW,
      importance: Importance.MEDIUM,
      assigneeOpenId: normalOpenId,
      assigneeName: FALLBACK_NORMAL_NAME,
      team: "英雄",
      techGroup: "电控",
      dueAt: tomorrow,
      status: TaskStatus.TODO,
      assignees: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      techGroups: {
        create: [{ techGroup: "宣运", sortOrder: 0 }],
      },
    },
  });

  const deliveryTask = await prisma.task.create({
    data: {
      projectId: project.id,
      stageId: overdueStage.id,
      title: `${TEST_PREFIX}-交付验收任务`,
      goal: "验证任务交付和验收审批",
      urgency: Urgency.MEDIUM,
      importance: Importance.HIGH,
      assigneeOpenId: normalOpenId,
      assigneeName: FALLBACK_NORMAL_NAME,
      team: "英雄",
      techGroup: "电控",
      dueAt: tomorrow,
      status: TaskStatus.IN_PROGRESS,
      metrics: "提交交付后由管理员验收",
      assignees: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      techGroups: {
        create: [{ techGroup: "电控", sortOrder: 0 }],
      },
      acceptanceChecklistItems: {
        create: [
          {
            content: `${TEST_PREFIX}-交付验收项`,
            sortOrder: 0,
          },
        ],
      },
    },
  });

  const deliveryRejectTask = await prisma.task.create({
    data: {
      projectId: project.id,
      stageId: overdueStage.id,
      title: `${TEST_PREFIX}-交付驳回任务`,
      goal: "验证任务交付验收驳回",
      urgency: Urgency.MEDIUM,
      importance: Importance.HIGH,
      assigneeOpenId: normalOpenId,
      assigneeName: FALLBACK_NORMAL_NAME,
      team: "英雄",
      techGroup: "电控",
      dueAt: tomorrow,
      status: TaskStatus.IN_PROGRESS,
      metrics: "提交交付后由管理员驳回",
      assignees: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      techGroups: {
        create: [{ techGroup: "电控", sortOrder: 0 }],
      },
      acceptanceChecklistItems: {
        create: [
          {
            content: `${TEST_PREFIX}-交付驳回验收项`,
            sortOrder: 0,
          },
        ],
      },
    },
  });

  const ddlRejectTask = await prisma.task.create({
    data: {
      projectId: project.id,
      stageId: overdueStage.id,
      title: `${TEST_PREFIX}-DDL 驳回任务`,
      goal: "验证任务 DDL 修改驳回",
      urgency: Urgency.MEDIUM,
      importance: Importance.MEDIUM,
      assigneeOpenId: normalOpenId,
      assigneeName: FALLBACK_NORMAL_NAME,
      team: "英雄",
      techGroup: "电控",
      dueAt: tomorrow,
      status: TaskStatus.IN_PROGRESS,
      assignees: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      techGroups: {
        create: [{ techGroup: "电控", sortOrder: 0 }],
      },
    },
  });

  const deletionRequestFixture = await createDeletionRequestProjectFixture({
    normalOpenId,
    adminOpenId,
    tomorrow,
  });
  const taskCreationRequestFixture =
    await createTaskCreationRequestProjectFixture({
      normalOpenId,
      adminOpenId,
      tomorrow,
    });
  const stageDueChangeFixture = await createStageDueChangeProjectFixture({
    normalOpenId,
    tomorrow,
    nextWeek,
  });

  await prisma.task.create({
    data: {
      projectId: project.id,
      stageId: overdueStage.id,
      title: `${TEST_PREFIX}-待验收任务`,
      goal: "验证任务看板待验收列",
      urgency: Urgency.MEDIUM,
      importance: Importance.MEDIUM,
      assigneeOpenId: normalOpenId,
      assigneeName: FALLBACK_NORMAL_NAME,
      team: "英雄",
      techGroup: "电控",
      dueAt: tomorrow,
      status: TaskStatus.PENDING_ACCEPTANCE,
      assignees: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      techGroups: {
        create: [{ techGroup: "电控", sortOrder: 0 }],
      },
    },
  });

  await createProjectFixture({
    name: `${TEST_PREFIX}-今日到期项目`,
    normalOpenId,
    dueAt: now,
    stageStatus: StageStatus.IN_PROGRESS,
  });
  await createProjectFixture({
    name: `${TEST_PREFIX}-正常项目`,
    normalOpenId,
    dueAt: nextWeek,
    stageStatus: StageStatus.IN_PROGRESS,
  });

  const cancellationFixtures = await createCancellationProjectFixture({
    normalOpenId,
    now,
    tomorrow,
  });
  const completableProject = await createCompletableProjectFixture({
    normalOpenId,
    now,
    tomorrow,
  });
  const uploadPublicPath = await createUploadFixture(normalOpenId);

  const openFeedback = await prisma.feedback.create({
    data: {
      submitterOpenId: normalOpenId,
      submitterName: FALLBACK_NORMAL_NAME,
      status: FeedbackStatus.OPEN,
      lastMessageAt: now,
      messages: {
        create: [
          {
            authorOpenId: normalOpenId,
            authorName: FALLBACK_NORMAL_NAME,
            body: `${TEST_PREFIX}-活动反馈`,
          },
        ],
      },
    },
  });

  const closedFeedback = await prisma.feedback.create({
    data: {
      submitterOpenId: normalOpenId,
      submitterName: FALLBACK_NORMAL_NAME,
      status: FeedbackStatus.CLOSED,
      lastMessageAt: yesterday,
      closedAt: yesterday,
      messages: {
        create: [
          {
            authorOpenId: normalOpenId,
            authorName: FALLBACK_NORMAL_NAME,
            body: `${TEST_PREFIX}-已关闭反馈`,
          },
        ],
      },
    },
  });

  return {
    normalOpenId,
    adminOpenId,
    otherOpenId: FALLBACK_OTHER_OPEN_ID,
    draftOrderId: draftOrder.id,
    reviewOrderId: reviewOrder.id,
    managementRejectOrderId: managementRejectOrder.id,
    teacherRejectOrderId: teacherRejectOrder.id,
    reimbursementOrderId: reimbursementOrder.id,
    projectId: project.id,
    projectCurrentStageId: overdueStage.id,
    taskId: task.id,
    taskRequestProjectId: taskCreationRequestFixture.projectId,
    stageDueChangeProjectId: stageDueChangeFixture.projectId,
    stageDueChangeCurrentStageId: stageDueChangeFixture.currentStageId,
    stageDueChangeNextStageId: stageDueChangeFixture.nextStageId,
    todoTaskId: todoTask.id,
    deliveryTaskId: deliveryTask.id,
    deliveryRejectTaskId: deliveryRejectTask.id,
    ddlRejectTaskId: ddlRejectTask.id,
    deletionTaskId: deletionRequestFixture.taskId,
    deletionRejectTaskId: deletionRequestFixture.rejectTaskId,
    completableProjectId: completableProject.projectId,
    cancelProjectId: cancellationFixtures.projectId,
    cancelTodoTaskId: cancellationFixtures.todoTaskId,
    cancelInProgressTaskId: cancellationFixtures.inProgressTaskId,
    cancelPendingTaskId: cancellationFixtures.pendingTaskId,
    cancelCompletedTaskId: cancellationFixtures.completedTaskId,
    cancelArchivedTaskId: cancellationFixtures.archivedTaskId,
    uploadPublicPath,
    openFeedbackId: openFeedback.id,
    closedFeedbackId: closedFeedback.id,
  };
}

export async function loginAsNormalUser(
  context: BrowserContext,
  baseURL: string | undefined,
  auth: AuthMaterial,
) {
  await context.clearCookies();
  if (auth.cookies && auth.cookies.length > 0) {
    await context.addCookies(normalizeCookiesForBaseUrl(auth.cookies, baseURL));
    return;
  }
  await context.addCookies([
    await createSessionCookie(auth.openId, auth.name, baseURL),
  ]);
}

export async function loginAsAdminUser(
  context: BrowserContext,
  baseURL: string | undefined,
) {
  await context.clearCookies();
  await context.addCookies([
    await createSessionCookie(FALLBACK_ADMIN_OPEN_ID, FALLBACK_ADMIN_NAME, baseURL),
  ]);
}

export async function loginAsOtherUser(
  context: BrowserContext,
  baseURL: string | undefined,
) {
  await context.clearCookies();
  await context.addCookies([
    await createSessionCookie(FALLBACK_OTHER_OPEN_ID, FALLBACK_OTHER_NAME, baseURL),
  ]);
}

export async function loginAsTestUser(
  context: BrowserContext,
  baseURL: string | undefined,
  user: { openId: string; name: string },
) {
  await context.clearCookies();
  await context.addCookies([
    await createSessionCookie(user.openId, user.name, baseURL),
  ]);
}

export async function expectHealthyPage(page: Page) {
  await expect(
    page.getByText(/Application error|Internal Server Error|Unhandled Runtime Error/i),
  ).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
}

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function createProjectFixture({
  name,
  normalOpenId,
  dueAt,
  stageStatus,
}: {
  name: string;
  normalOpenId: string;
  dueAt: Date;
  stageStatus: StageStatus;
}) {
  const project = await prisma.project.create({
    data: {
      name,
      description: "Playwright project deadline fixture",
      team: "英雄",
      techGroup: "电控",
      status: ProjectStatus.IN_PROGRESS,
      ownerOpenId: normalOpenId,
      ownerName: FALLBACK_NORMAL_NAME,
      owners: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      participants: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      stages: {
        create: [
          {
            name: `${name}-阶段`,
            goal: "deadline fixture",
            sortOrder: 0,
            status: stageStatus,
            ownerOpenId: normalOpenId,
            ownerName: FALLBACK_NORMAL_NAME,
            dueAt,
          },
        ],
      },
    },
  });
  return project;
}

async function createDeletionRequestProjectFixture({
  normalOpenId,
  adminOpenId,
  tomorrow,
}: {
  normalOpenId: string;
  adminOpenId: string;
  tomorrow: Date;
}) {
  const project = await prisma.project.create({
    data: {
      name: `${TEST_PREFIX}-删除申请项目`,
      description: "Playwright task deletion request fixture",
      team: "英雄",
      techGroup: "电控",
      status: ProjectStatus.IN_PROGRESS,
      ownerOpenId: adminOpenId,
      ownerName: FALLBACK_ADMIN_NAME,
      owners: {
        create: [
          {
            openId: adminOpenId,
            name: FALLBACK_ADMIN_NAME,
            sortOrder: 0,
          },
        ],
      },
      participants: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
    },
  });
  const stage = await prisma.projectStage.create({
    data: {
      projectId: project.id,
      name: `${TEST_PREFIX}-删除申请阶段`,
      goal: "task deletion request fixture",
      sortOrder: 0,
      status: StageStatus.IN_PROGRESS,
      ownerOpenId: adminOpenId,
      ownerName: FALLBACK_ADMIN_NAME,
      dueAt: tomorrow,
    },
  });
  async function createDeletionTask(title: string) {
    return prisma.task.create({
      data: {
        projectId: project.id,
        stageId: stage.id,
        title,
        goal: "验证任务删除申请审批",
        urgency: Urgency.LOW,
        importance: Importance.MEDIUM,
        assigneeOpenId: normalOpenId,
        assigneeName: FALLBACK_NORMAL_NAME,
        team: "英雄",
        techGroup: "电控",
        dueAt: tomorrow,
        status: TaskStatus.TODO,
        assignees: {
          create: [
            {
              openId: normalOpenId,
              name: FALLBACK_NORMAL_NAME,
              sortOrder: 0,
            },
          ],
        },
        techGroups: {
          create: [{ techGroup: "电控", sortOrder: 0 }],
        },
      },
    });
  }

  const [task, rejectTask] = await Promise.all([
    createDeletionTask(`${TEST_PREFIX}-删除申请任务`),
    createDeletionTask(`${TEST_PREFIX}-删除驳回任务`),
  ]);

  return { taskId: task.id, rejectTaskId: rejectTask.id };
}

async function createTaskCreationRequestProjectFixture({
  normalOpenId,
  adminOpenId,
  tomorrow,
}: {
  normalOpenId: string;
  adminOpenId: string;
  tomorrow: Date;
}) {
  const project = await prisma.project.create({
    data: {
      name: `${TEST_PREFIX}-任务申请项目`,
      description: "Playwright task creation request fixture",
      team: "英雄",
      techGroup: "电控",
      status: ProjectStatus.IN_PROGRESS,
      ownerOpenId: adminOpenId,
      ownerName: FALLBACK_ADMIN_NAME,
      owners: {
        create: [
          {
            openId: adminOpenId,
            name: FALLBACK_ADMIN_NAME,
            sortOrder: 0,
          },
        ],
      },
      participants: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      stages: {
        create: [
          {
            name: `${TEST_PREFIX}-任务申请阶段`,
            goal: "task creation request stage",
            sortOrder: 0,
            status: StageStatus.IN_PROGRESS,
            ownerOpenId: adminOpenId,
            ownerName: FALLBACK_ADMIN_NAME,
            dueAt: tomorrow,
          },
        ],
      },
    },
  });

  return { projectId: project.id };
}

async function createStageDueChangeProjectFixture({
  normalOpenId,
  tomorrow,
  nextWeek,
}: {
  normalOpenId: string;
  tomorrow: Date;
  nextWeek: Date;
}) {
  const project = await prisma.project.create({
    data: {
      name: `${TEST_PREFIX}-单阶段 DDL 项目`,
      description: "Playwright single stage DDL change fixture",
      team: "英雄",
      techGroup: "电控",
      status: ProjectStatus.IN_PROGRESS,
      ownerOpenId: normalOpenId,
      ownerName: FALLBACK_NORMAL_NAME,
      owners: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      participants: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
    },
  });
  const [currentStage, nextStage] = await Promise.all([
    prisma.projectStage.create({
      data: {
        projectId: project.id,
        name: `${TEST_PREFIX}-单阶段当前阶段`,
        goal: "single stage DDL fixture",
        sortOrder: 0,
        status: StageStatus.IN_PROGRESS,
        ownerOpenId: normalOpenId,
        ownerName: FALLBACK_NORMAL_NAME,
        dueAt: tomorrow,
      },
    }),
    prisma.projectStage.create({
      data: {
        projectId: project.id,
        name: `${TEST_PREFIX}-单阶段后续阶段`,
        goal: "single stage DDL fixture next",
        sortOrder: 1,
        status: StageStatus.NOT_STARTED,
        ownerOpenId: normalOpenId,
        ownerName: FALLBACK_NORMAL_NAME,
        dueAt: nextWeek,
      },
    }),
  ]);

  return {
    projectId: project.id,
    currentStageId: currentStage.id,
    nextStageId: nextStage.id,
  };
}

async function createCancellationProjectFixture({
  normalOpenId,
  now,
  tomorrow,
}: {
  normalOpenId: string;
  now: Date;
  tomorrow: Date;
}) {
  const project = await prisma.project.create({
    data: {
      name: `${TEST_PREFIX}-取消级联项目`,
      description: "Playwright project cancel fixture",
      team: "英雄",
      techGroup: "电控",
      status: ProjectStatus.IN_PROGRESS,
      ownerOpenId: normalOpenId,
      ownerName: FALLBACK_NORMAL_NAME,
      owners: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      participants: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
    },
  });
  const stage = await prisma.projectStage.create({
    data: {
      projectId: project.id,
      name: `${TEST_PREFIX}-取消当前阶段`,
      goal: "cancel cascade fixture",
      sortOrder: 0,
      status: StageStatus.IN_PROGRESS,
      ownerOpenId: normalOpenId,
      ownerName: FALLBACK_NORMAL_NAME,
      dueAt: tomorrow,
    },
  });

  async function createTask(title: string, status: TaskStatus) {
    return prisma.task.create({
      data: {
        projectId: project.id,
        stageId: stage.id,
        title,
        goal: "cancel cascade task",
        urgency: Urgency.MEDIUM,
        importance: Importance.MEDIUM,
        assigneeOpenId: normalOpenId,
        assigneeName: FALLBACK_NORMAL_NAME,
        team: "英雄",
        techGroup: "电控",
        dueAt: tomorrow,
        status,
        archivedAt:
          status === TaskStatus.ARCHIVED || status === TaskStatus.COMPLETED
            ? now
            : null,
        assignees: {
          create: [
            {
              openId: normalOpenId,
              name: FALLBACK_NORMAL_NAME,
              sortOrder: 0,
            },
          ],
        },
        techGroups: {
          create: [{ techGroup: "电控", sortOrder: 0 }],
        },
      },
    });
  }

  const [todoTask, inProgressTask, pendingTask, completedTask, archivedTask] =
    await Promise.all([
      createTask(`${TEST_PREFIX}-取消待办任务`, TaskStatus.TODO),
      createTask(`${TEST_PREFIX}-取消进行中任务`, TaskStatus.IN_PROGRESS),
      createTask(`${TEST_PREFIX}-取消待验收任务`, TaskStatus.PENDING_ACCEPTANCE),
      createTask(`${TEST_PREFIX}-取消已完成任务`, TaskStatus.COMPLETED),
      createTask(`${TEST_PREFIX}-取消已归档任务`, TaskStatus.ARCHIVED),
    ]);

  return {
    projectId: project.id,
    todoTaskId: todoTask.id,
    inProgressTaskId: inProgressTask.id,
    pendingTaskId: pendingTask.id,
    completedTaskId: completedTask.id,
    archivedTaskId: archivedTask.id,
  };
}

async function createCompletableProjectFixture({
  normalOpenId,
  now,
  tomorrow,
}: {
  normalOpenId: string;
  now: Date;
  tomorrow: Date;
}) {
  const project = await prisma.project.create({
    data: {
      name: `${TEST_PREFIX}-可完成项目`,
      description: "Playwright project completion fixture",
      team: "英雄",
      techGroup: "电控",
      status: ProjectStatus.IN_PROGRESS,
      ownerOpenId: normalOpenId,
      ownerName: FALLBACK_NORMAL_NAME,
      owners: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
      participants: {
        create: [
          {
            openId: normalOpenId,
            name: FALLBACK_NORMAL_NAME,
            sortOrder: 0,
          },
        ],
      },
    },
  });
  const stage = await prisma.projectStage.create({
    data: {
      projectId: project.id,
      name: `${TEST_PREFIX}-已完成阶段`,
      goal: "completion fixture",
      sortOrder: 0,
      status: StageStatus.COMPLETED,
      ownerOpenId: normalOpenId,
      ownerName: FALLBACK_NORMAL_NAME,
      dueAt: tomorrow,
      completedAt: now,
    },
  });
  await Promise.all([
    prisma.task.create({
      data: {
        projectId: project.id,
        stageId: stage.id,
        title: `${TEST_PREFIX}-完成项目已完成任务`,
        goal: "completion fixture completed task",
        urgency: Urgency.LOW,
        importance: Importance.MEDIUM,
        assigneeOpenId: normalOpenId,
        assigneeName: FALLBACK_NORMAL_NAME,
        team: "英雄",
        techGroup: "电控",
        dueAt: tomorrow,
        status: TaskStatus.COMPLETED,
        archivedAt: now,
        assignees: {
          create: [
            {
              openId: normalOpenId,
              name: FALLBACK_NORMAL_NAME,
              sortOrder: 0,
            },
          ],
        },
        techGroups: {
          create: [{ techGroup: "电控", sortOrder: 0 }],
        },
      },
    }),
    prisma.task.create({
      data: {
        projectId: project.id,
        stageId: stage.id,
        title: `${TEST_PREFIX}-完成项目已归档任务`,
        goal: "completion fixture archived task",
        urgency: Urgency.LOW,
        importance: Importance.MEDIUM,
        assigneeOpenId: normalOpenId,
        assigneeName: FALLBACK_NORMAL_NAME,
        team: "英雄",
        techGroup: "电控",
        dueAt: tomorrow,
        status: TaskStatus.ARCHIVED,
        archivedAt: now,
        assignees: {
          create: [
            {
              openId: normalOpenId,
              name: FALLBACK_NORMAL_NAME,
              sortOrder: 0,
            },
          ],
        },
        techGroups: {
          create: [{ techGroup: "电控", sortOrder: 0 }],
        },
      },
    }),
  ]);

  return { projectId: project.id };
}

async function createUploadFixture(ownerOpenId: string): Promise<string> {
  const storagePath = "playwright/owned-note.txt";
  const publicPath = `/uploads/${storagePath}`;
  const filePath = storagePathToAbsolute(storagePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "playwright-owned-file\n", "utf8");
  await prisma.fileAsset.create({
    data: {
      publicPath,
      storagePath,
      kind: FileAssetKind.TEMP_UPLOAD,
      mimeType: "text/plain",
      size: Buffer.byteLength("playwright-owned-file\n"),
      ownerOpenId,
    },
  });
  return publicPath;
}

async function createPlaywrightSignatureFiles({
  normalOpenId,
  adminOpenId,
}: {
  normalOpenId: string;
  adminOpenId: string;
}) {
  const signatures = [
    {
      openId: normalOpenId,
      publicPath: NORMAL_SIGNATURE_PUBLIC_PATH,
      storagePath: "playwright/signature-normal.png",
    },
    {
      openId: adminOpenId,
      publicPath: ADMIN_SIGNATURE_PUBLIC_PATH,
      storagePath: "playwright/signature-admin.png",
    },
  ];

  for (const signature of signatures) {
    const filePath = storagePathToAbsolute(signature.storagePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, ONE_BY_ONE_PNG);
    await prisma.fileAsset.upsert({
      where: { publicPath: signature.publicPath },
      update: {
        storagePath: signature.storagePath,
        kind: FileAssetKind.USER_SIGNATURE,
        mimeType: "image/png",
        size: ONE_BY_ONE_PNG.length,
        signatureOwnerOpenId: signature.openId,
        ownerOpenId: signature.openId,
      },
      create: {
        publicPath: signature.publicPath,
        storagePath: signature.storagePath,
        kind: FileAssetKind.USER_SIGNATURE,
        mimeType: "image/png",
        size: ONE_BY_ONE_PNG.length,
        signatureOwnerOpenId: signature.openId,
        ownerOpenId: signature.openId,
      },
    });
  }
}

async function cleanupFunctionalFixtures(openIds: string[]) {
  await prisma.feedback.deleteMany({
    where: {
      OR: [
        { submitterOpenId: { in: openIds } },
        { messages: { some: { body: { startsWith: TEST_PREFIX } } } },
      ],
    },
  });
  await prisma.purchaseOrder.deleteMany({
    where: { orderNo: { startsWith: "PW-FULL-" } },
  });
  await prisma.project.deleteMany({
    where: { name: { startsWith: TEST_PREFIX } },
  });
  await prisma.notificationOutbox.deleteMany({
    where: { eventKey: { startsWith: "playwright:" } },
  });
  await prisma.fileAsset.deleteMany({
    where: { publicPath: { startsWith: "/uploads/playwright/" } },
  });
}

async function seedAdminReferenceData() {
  await prisma.acceptanceChecklistTemplate.upsert({
    where: { content: `${TEST_PREFIX}-验收条例` },
    update: {},
    create: {
      content: `${TEST_PREFIX}-验收条例`,
      sortOrder: 0,
    },
  });

  await prisma.projectTemplate.upsert({
    where: { name: `${TEST_PREFIX}-项目模板` },
    update: { enabled: true },
    create: {
      name: `${TEST_PREFIX}-项目模板`,
      description: "Playwright fixture template",
      enabled: true,
      stages: {
        create: [
          {
            name: `${TEST_PREFIX}-模板阶段`,
            goal: "template fixture",
            dueOffsetDays: 3,
            sortOrder: 0,
          },
        ],
      },
    },
  });

  for (const kind of [
    ProgressReminderKind.TASK_OVERDUE,
    ProgressReminderKind.TASK_DUE_SOON,
    ProgressReminderKind.WEEKLY_REPORT_MISSING,
    ProgressReminderKind.STAGE_STALE_OR_DUE_SOON,
  ]) {
    await prisma.progressReminderRule.upsert({
      where: { kind },
      update: { enabled: true },
      create: {
        kind,
        enabled: true,
        scheduleTime: "09:00",
        paramsJson: "{}",
        recipientConfigJson: "{}",
      },
    });
  }

  await prisma.procurementBudgetPool.upsert({
    where: {
      team_techGroup_period: {
        team: "英雄",
        techGroup: "电控",
        period: "playwright",
      },
    },
    update: { budgetAmount: 10000 },
    create: {
      team: "英雄",
      techGroup: "电控",
      period: "playwright",
      description: `${TEST_PREFIX}-预算池`,
      budgetAmount: 10000,
    },
  });
}

async function getUserId(openId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { openId },
    select: { id: true },
  });
  if (!user) throw new Error(`Missing seeded user ${openId}`);
  return user.id;
}

function readStorageState(storagePath: string): { cookies: Cookie[] } | null {
  if (!fs.existsSync(storagePath)) return null;
  const raw = fs.readFileSync(storagePath, "utf8");
  const parsed = JSON.parse(raw) as { cookies?: Cookie[] };
  return { cookies: parsed.cookies ?? [] };
}

async function readOpenIdFromStorageState(
  cookies: Cookie[],
): Promise<string | undefined> {
  const cookie = cookies.find((item) => item.name.includes("session-token"));
  if (!cookie) return undefined;
  const secret = authSecret();
  const salts = [
    cookie.name,
    SESSION_COOKIE_NAME,
    "__Secure-authjs.session-token",
    "next-auth.session-token",
  ];
  for (const salt of salts) {
    const decoded = await decode({
      token: cookie.value,
      secret,
      salt,
    }).catch(() => null);
    const openId =
      (decoded?.openId as string | undefined) ??
      (decoded?.sub as string | undefined);
    if (openId) return openId;
  }
  return undefined;
}

function normalizeCookiesForBaseUrl(
  cookies: Cookie[],
  baseURL: string | undefined,
): Cookie[] {
  const url = new URL(baseURL ?? "http://127.0.0.1:3100");
  return cookies
    .filter((cookie) => cookie.name.includes("session-token"))
    .map((cookie) => ({
      ...cookie,
      domain: url.hostname,
      path: cookie.path || "/",
      secure: url.protocol === "https:",
      sameSite: cookie.sameSite ?? "Lax",
    }));
}

async function createSessionCookie(
  openId: string,
  name: string,
  baseURL: string | undefined,
): Promise<Cookie> {
  const url = new URL(baseURL ?? "http://127.0.0.1:3100");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expires = nowSeconds + 60 * 60 * 24;
  const value = await encode({
    secret: authSecret(),
    salt: SESSION_COOKIE_NAME,
    token: {
      sub: openId,
      openId,
      name,
      iat: nowSeconds,
      exp: expires,
    },
  });

  return {
    name: SESSION_COOKIE_NAME,
    value,
    domain: url.hostname,
    path: "/",
    expires,
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "Lax",
  };
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is required for Playwright authenticated tests");
  }
  return secret;
}

function assertTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `Refusing to seed functional fixtures outside a _test database: ${databaseName}`,
    );
  }
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function formatPrismaError(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
