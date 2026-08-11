import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { prisma } from "../lib/prisma";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import {
  activateTask,
  createRevision,
  createTaskDraft,
  submitMilestoneForReview,
} from "../lib/project-management/application/lifecycle-service";
import { withGlobalApprovalAdministratorGuardDisabled } from "./helpers/global-approval-administrator-guard";

const execFileAsync = promisify(execFile);
const repairScript = path.join(
  process.cwd(),
  "scripts/repair-task-approval-notifications.ts",
);
const tsxExecutable = path.join(process.cwd(), "node_modules/.bin/tsx");

test("approval notification repair is dry-run safe, per-object transactional and idempotent", async () => {
  test.setTimeout(120_000);
  const fixture = await createPendingApprovalFixture();
  const expectedAdministrators = await activeGlobalAdministrators();
  const milestoneLegacyKey =
    `pm:milestone:review_submitted:${fixture.reviewId}:feishu`;
  const revisionLegacyKey =
    `pm:revision:pending_review:${fixture.revisionId}:round:1:feishu`;
  const before = await notificationRepairSnapshot(fixture);

  await runRepair(false);
  expect(await notificationRepairSnapshot(fixture)).toEqual(before);
  for (const deliveryDisabled of [null, "false"] as const) {
    await expect(runRepair(true, deliveryDisabled)).rejects.toThrow(
      /NOTIFICATION_DELIVERY_DISABLED=true/,
    );
    expect(await notificationRepairSnapshot(fixture)).toEqual(before);
  }

  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "test_fail_revision_notification_repair"()
    RETURNS trigger AS $$
    BEGIN
      IF NEW."entityType" = 'RevisionNode'
         AND NEW."eventKey" LIKE '%global-admin:v2:%' THEN
        RAISE EXCEPTION 'injected revision notification repair failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "test_fail_revision_notification_repair"
    BEFORE INSERT ON "InAppNotification"
    FOR EACH ROW EXECUTE FUNCTION "test_fail_revision_notification_repair"();
  `);
  await expect(runRepair(true)).rejects.toThrow(
    /injected revision notification repair failure/,
  );

  expect(
    await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey: milestoneLegacyKey },
      select: { status: true, attempts: true, lastError: true },
    }),
  ).toMatchObject({
    status: "FAILED",
    attempts: 8,
    lastError: expect.stringContaining("全局管理员"),
  });
  expect(
    await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey: revisionLegacyKey },
      select: { status: true, attempts: true, lastError: true },
    }),
  ).toEqual({ status: "PENDING", attempts: 0, lastError: "" });
  expect(
    await prisma.inAppNotification.count({
      where: { eventKey: { contains: `global-admin:v2:${fixture.revisionId}` } },
    }),
  ).toBe(0);

  await prisma.$executeRawUnsafe(
    'DROP TRIGGER "test_fail_revision_notification_repair" ON "InAppNotification"',
  );
  await prisma.$executeRawUnsafe(
    'DROP FUNCTION "test_fail_revision_notification_repair"()',
  );
  await runRepair(true);

  const legacyOutboxes = await prisma.notificationOutbox.findMany({
    where: { eventKey: { in: [milestoneLegacyKey, revisionLegacyKey] } },
    select: {
      eventKey: true,
      status: true,
      attempts: true,
      nextRunAt: true,
      lastError: true,
      lockedUntil: true,
    },
    orderBy: { eventKey: "asc" },
  });
  expect(legacyOutboxes).toHaveLength(2);
  for (const outbox of legacyOutboxes) {
    expect(outbox).toMatchObject({
      status: "FAILED",
      attempts: 8,
      lastError: expect.stringContaining("旧 Reviewer/组长审批 outbox 已冻结"),
      lockedUntil: null,
    });
    expect(outbox.nextRunAt.toISOString()).toBe("9999-12-31T00:00:00.000Z");
  }

  const replacementInApp = await prisma.inAppNotification.findMany({
    where: {
      OR: [
        { eventKey: { contains: `global-admin:v2:${fixture.reviewId}` } },
        { eventKey: { contains: `global-admin:v2:${fixture.revisionId}` } },
      ],
    },
    select: { eventKey: true, recipientAccountId: true, payload: true },
    orderBy: { eventKey: "asc" },
  });
  expect(replacementInApp).toHaveLength(expectedAdministrators.length * 2);
  expect(new Set(replacementInApp.map((row) => row.recipientAccountId))).toEqual(
    new Set(expectedAdministrators.map((administrator) => administrator.accountId)),
  );
  expect(
    replacementInApp.every((row) =>
      JSON.stringify(row.payload).includes("GLOBAL_ADMINISTRATORS_V2"),
    ),
  ).toBe(true);
  expect(
    replacementInApp.some(
      (row) => row.recipientAccountId === fixture.owner.account.id,
    ),
  ).toBe(false);

  const replacementOutboxes = await prisma.notificationOutbox.findMany({
    where: {
      OR: [
        { eventKey: { contains: `global-admin:v2:${fixture.reviewId}` } },
        { eventKey: { contains: `global-admin:v2:${fixture.revisionId}` } },
      ],
    },
    select: { eventKey: true, botKind: true, payload: true },
    orderBy: { eventKey: "asc" },
  });
  expect(replacementOutboxes).toHaveLength(2);
  for (const outbox of replacementOutboxes) {
    expect(outbox.botKind).toBe("approval");
    const payload = JSON.parse(outbox.payload) as {
      recipientOpenIds?: string[];
      context?: { recipientPolicy?: string };
    };
    expect(payload.recipientOpenIds).toEqual(
      expect.arrayContaining(
        expectedAdministrators.flatMap((administrator) =>
          administrator.openId ? [administrator.openId] : [],
        ),
      ),
    );
    expect(payload.recipientOpenIds).toHaveLength(
      expectedAdministrators.filter((administrator) => administrator.openId)
        .length,
    );
    expect(payload.context?.recipientPolicy).toBe("GLOBAL_ADMINISTRATORS_V2");
  }

  const appliedSnapshot = await notificationRepairSnapshot(fixture);
  await runRepair(true);
  expect(await notificationRepairSnapshot(fixture)).toEqual(appliedSnapshot);
});

test("approval notification repair blocks before freezing when administrators lack Feishu openId", async () => {
  test.setTimeout(120_000);
  const fixture = await createPendingApprovalFixture();
  const before = await notificationRepairSnapshot(fixture);
  const identities = await prisma.accountIdentity.findMany({
    where: {
      provider: "FEISHU",
      tenantId: "default",
      account: {
        systemRoles: {
          some: {
            role: {
              in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"],
            },
            team: "",
            techGroup: "",
            revokedAt: null,
          },
        },
      },
    },
    select: { id: true, openId: true },
  });
  await withGlobalApprovalAdministratorGuardDisabled(async () => {
    try {
      await prisma.$transaction(
        identities.map((identity, index) =>
          prisma.accountIdentity.update({
            where: { id: identity.id },
            data: { openId: " ".repeat(index + 1) },
          }),
        ),
      );
      await expect(runRepair(true)).rejects.toThrow(
        /均缺少默认租户的有效飞书 openId/,
      );
      expect(await notificationRepairSnapshot(fixture)).toEqual(before);
    } finally {
      await prisma.$transaction(
        identities.map((identity) =>
          prisma.accountIdentity.update({
            where: { id: identity.id },
            data: { openId: identity.openId },
          }),
        ),
      );
    }
  });
});

async function runRepair(
  apply: boolean,
  notificationDeliveryDisabled: "true" | "false" | null = "true",
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NOTIFICATION_DELIVERY_DISABLED;
  if (notificationDeliveryDisabled !== null) {
    env.NOTIFICATION_DELIVERY_DISABLED = notificationDeliveryDisabled;
  }
  return execFileAsync(
    tsxExecutable,
    apply ? [repairScript, "--apply"] : [repairScript],
    {
      cwd: process.cwd(),
      env,
      timeout: 30_000,
    },
  );
}

async function notificationRepairSnapshot(
  fixture: Awaited<ReturnType<typeof createPendingApprovalFixture>>,
) {
  const [replacementInApp, replacementOutbox, repairAudits, legacyOutboxes] =
    await Promise.all([
      prisma.inAppNotification.count({
        where: {
          OR: [
            { eventKey: { contains: `global-admin:v2:${fixture.reviewId}` } },
            { eventKey: { contains: `global-admin:v2:${fixture.revisionId}` } },
          ],
        },
      }),
      prisma.notificationOutbox.count({
        where: {
          OR: [
            { eventKey: { contains: `global-admin:v2:${fixture.reviewId}` } },
            { eventKey: { contains: `global-admin:v2:${fixture.revisionId}` } },
          ],
        },
      }),
      prisma.domainAuditEvent.count({
        where: {
          id: {
            in: [
              `migration:task-approval-notification:v2:MilestoneReview:${fixture.reviewId}`,
              `migration:task-approval-notification:v2:RevisionNode:${fixture.revisionId}`,
            ],
          },
        },
      }),
      prisma.notificationOutbox.findMany({
        where: {
          eventKey: {
            in: [
              `pm:milestone:review_submitted:${fixture.reviewId}:feishu`,
              `pm:revision:pending_review:${fixture.revisionId}:round:1:feishu`,
            ],
          },
        },
        select: { eventKey: true, status: true, attempts: true, lastError: true },
        orderBy: { eventKey: "asc" },
      }),
    ]);
  return { replacementInApp, replacementOutbox, repairAudits, legacyOutboxes };
}

async function activeGlobalAdministrators() {
  const assignments = await prisma.systemRoleAssignment.findMany({
    where: {
      role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] },
      team: "",
      techGroup: "",
      revokedAt: null,
    },
    select: {
      account: {
        select: {
          id: true,
          identities: {
            where: { provider: "FEISHU", tenantId: "default" },
            select: { id: true, openId: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });
  const byAccount = new Map<
    string,
    { accountId: string; openId: string | null }
  >();
  for (const assignment of assignments) {
    byAccount.set(assignment.account.id, {
      accountId: assignment.account.id,
      openId:
        assignment.account.identities
          .map((identity) => identity.openId?.trim() ?? "")
          .find(Boolean) ?? null,
    });
  }
  return [...byAccount.values()];
}

async function createPendingApprovalFixture() {
  const owner = await createAccountPerson("Repair Owner");
  const participant = await createAccountPerson("Repair Participant");
  const superAdministrator = await createAccountPerson("Repair Super Admin");
  const projectAdministrator = await createAccountPerson("Repair Project Admin");
  await grantRole(superAdministrator.account.id, "SUPER_ADMINISTRATOR");
  await grantRole(superAdministrator.account.id, "PROJECT_ADMINISTRATOR");
  await grantRole(projectAdministrator.account.id, "PROJECT_ADMINISTRATOR");

  const draft = await createTaskDraft(actor(owner), {
    title: `Notification repair ${randomUUID()}`,
    description: "待审批通知修复回归",
    team: "英雄",
    techGroup: "电控",
    priority: "HIGH",
    members: [
      { personId: owner.person.id, role: "OWNER" },
      { personId: participant.person.id, role: "PARTICIPANT" },
    ],
    plannedStartAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
    milestones: [
      milestoneInput("Repair milestone 1", 2),
      milestoneInput("Repair milestone 2", 3),
    ],
    termination: {
      name: "Terminal",
      plannedOutcomeCriteria: "审批通知修复完成",
      plannedAt: new Date("2026-08-05T00:00:00.000Z").toISOString(),
      businessDescription: "Repair termination",
    },
    idempotencyKey: `repair-task-${randomUUID()}`,
  });
  const activated = await activateTask(actor(owner), {
    taskId: draft.taskId,
    expectedLockVersion: draft.lockVersion,
  });
  const activeMilestone = await prisma.planVersionNode.findFirstOrThrow({
    where: {
      planVersionId: activated.currentPlanVersionId,
      node: { type: "MILESTONE", status: "ACTIVE" },
    },
    select: { nodeId: true },
  });
  const review = await submitMilestoneForReview(actor(participant), {
    milestoneNodeId: activeMilestone.nodeId,
    idempotencyKey: `repair-review-${randomUUID()}`,
    evidences: [{ kind: "TEXT", note: "待管理员处理" }],
  });
  await prisma.milestoneReview.update({
    where: { id: review.reviewId },
    data: {
      revokedAt: new Date(),
      revokeReason: "测试构造迁移前的历史异常并发审批",
    },
  });
  const currentTask = await prisma.task.findUniqueOrThrow({
    where: { id: draft.taskId },
    select: { lockVersion: true, currentPlanVersionId: true },
  });
  const revision = await createRevision(actor(owner), {
    taskId: draft.taskId,
    basePlanVersionId: currentTask.currentPlanVersionId,
    baseTaskLockVersion: currentTask.lockVersion,
    reason: "验证管理员通知修复",
    description: "验证管理员通知修复",
    revisionAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
    replacementMilestones: [milestoneInput("Repair revised milestone", 4)],
    termination: {
      name: "Terminal",
      plannedOutcomeCriteria: "修订审批完成",
      plannedAt: new Date("2026-08-06T00:00:00.000Z").toISOString(),
      businessDescription: "Repair revised termination",
    },
    idempotencyKey: `repair-revision-${randomUUID()}`,
  });
  await prisma.milestoneReview.update({
    where: { id: review.reviewId },
    data: { revokedAt: null, revokeReason: "" },
  });
  return {
    owner,
    participant,
    superAdministrator,
    projectAdministrator,
    reviewId: review.reviewId,
    revisionId: revision.revisionNodeId,
  };
}

function milestoneInput(goal: string, day: number) {
  return {
    goal,
    completionCriteria: `${goal} 完成`,
    expectedCompletedAt: new Date(
      `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    ).toISOString(),
    reviewRequirements: "提交文本证据",
    businessDescription: goal,
  };
}

async function createAccountPerson(displayName: string) {
  const openId = `ou_task_repair_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: { create: { displayName, status: "ACTIVE" } },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("通知修复测试账号缺少 Person");
  return { account, person: account.person, openId };
}

async function grantRole(
  accountId: string,
  role: "SUPER_ADMINISTRATOR" | "PROJECT_ADMINISTRATOR",
) {
  await prisma.systemRoleAssignment.create({
    data: { accountId, role, team: "", techGroup: "" },
  });
}

function actor(
  input: Awaited<ReturnType<typeof createAccountPerson>>,
): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles: [],
  };
}
