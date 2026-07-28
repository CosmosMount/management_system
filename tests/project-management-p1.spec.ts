import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  authorize,
  taskReadableWhere,
} from "../lib/project-management/authorization";
import {
  backfillProjectManagementIdentities,
  getProjectManagementActorForFeishuUser,
  projectManagementFeishuProviderSubject,
  resolveFeishuIdentityForUser,
  type ProjectManagementActor,
} from "../lib/project-management/identity";
import {
  createInAppNotificationTx,
  enqueueProjectManagementNotification,
  PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION,
  type ProjectManagementNotificationPayload,
} from "../lib/project-management/notifications/events";
import { createDomainAuditEventTx } from "../lib/project-management/audit";
import { getNotificationChannelAdapter } from "../lib/notification-channels";
import { NonRetryableNotificationError } from "../lib/notification-channels/types";
import { prisma } from "../lib/prisma";

test.describe("project management P1 schema, identity and authorization", () => {
  test("schema constraints enforce current plan, tag, segment, review and conflict invariants", async () => {
    const { account, person } = await createAccountPerson("约束测试用户");
    const task = await createTaskWithCurrentPlan({
      accountId: account.id,
      title: "P1 约束测试 Task",
      team: "英雄",
      techGroup: "电控",
    });

    await expect(
      prisma.taskPlanVersion.create({
        data: {
          taskId: task.taskId,
          versionNo: 2,
          status: "CURRENT",
          reason: "非法第二 Current",
          createdByAccountId: account.id,
        },
      }),
    ).rejects.toThrow();

    await prisma.tag.create({
      data: {
        name: `P1-Tag-${randomUUID()}`,
        color: "#2563eb",
        createdByAccountId: account.id,
      },
    });
    const duplicateTagName = `P1-Dupe-${randomUUID()}`;
    const duplicateTag = await prisma.tag.create({
      data: {
        name: duplicateTagName,
        color: "#16a34a",
        createdByAccountId: account.id,
      },
    });
    await expect(
      prisma.tag.create({
        data: {
          name: duplicateTagName,
          color: "#dc2626",
          createdByAccountId: account.id,
        },
      }),
    ).rejects.toThrow();
    await prisma.tag.update({
      where: { id: duplicateTag.id },
      data: { archivedAt: new Date() },
    });
    await expect(
      prisma.tag.create({
        data: {
          name: duplicateTagName,
          color: "#f59e0b",
          createdByAccountId: account.id,
        },
      }),
    ).resolves.toBeTruthy();

    await expect(
      prisma.workSegment.create({
        data: {
          personId: person.id,
          type: "PLANNED",
          status: "PLANNED",
          startAt: new Date("2026-07-28T09:00:00.000Z"),
          endAt: new Date("2026-07-28T10:00:00.000Z"),
          content: "非法 allocation",
          allocation: new Prisma.Decimal(100.01),
          createdByAccountId: account.id,
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.workSegment.create({
        data: {
          personId: person.id,
          type: "PLANNED",
          status: "PLANNED",
          startAt: new Date("2026-07-28T10:00:00.000Z"),
          endAt: new Date("2026-07-28T09:00:00.000Z"),
          content: "非法时间",
          allocation: new Prisma.Decimal(50),
          createdByAccountId: account.id,
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.workSegment.create({
        data: {
          personId: person.id,
          type: "ACTUAL",
          status: "CONFIRMED",
          startAt: new Date("2026-07-28T09:00:00.000Z"),
          endAt: new Date("2026-07-28T10:00:00.000Z"),
          content: "允许缺 allocation 以便冲突扫描解释",
          allocation: null,
          createdByAccountId: account.id,
        },
      }),
    ).resolves.toBeTruthy();

    const milestone = await createMilestone(task.taskId, task.planVersionId, account.id);
    await prisma.milestoneReview.create({
      data: {
        milestoneNodeId: milestone.milestoneId,
        result: "PENDING",
        submittedByAccountId: account.id,
        idempotencyKey: "same-click",
      },
    });
    await expect(
      prisma.milestoneReview.create({
        data: {
          milestoneNodeId: milestone.milestoneId,
          result: "PENDING",
          submittedByAccountId: account.id,
          idempotencyKey: "same-click",
        },
      }),
    ).rejects.toThrow();

    await prisma.resourceConflict.create({
      data: {
        personId: person.id,
        kind: "ALLOCATION_OVER_LIMIT",
        startAt: new Date("2026-07-28T09:00:00.000Z"),
        endAt: new Date("2026-07-28T11:00:00.000Z"),
        severity: "HIGH",
        fingerprint: `p1-conflict-${randomUUID()}`,
      },
    });
    const fingerprint = `p1-conflict-dupe-${randomUUID()}`;
    await prisma.resourceConflict.create({
      data: {
        personId: person.id,
        kind: "ALLOCATION_OVER_LIMIT",
        startAt: new Date("2026-07-28T09:00:00.000Z"),
        endAt: new Date("2026-07-28T11:00:00.000Z"),
        severity: "HIGH",
        fingerprint,
      },
    });
    await expect(
      prisma.resourceConflict.create({
        data: {
          personId: person.id,
          kind: "ALLOCATION_OVER_LIMIT",
          startAt: new Date("2026-07-28T09:00:00.000Z"),
          endAt: new Date("2026-07-28T11:00:00.000Z"),
          severity: "HIGH",
          fingerprint,
        },
      }),
    ).rejects.toThrow();
  });

  test("Feishu identity resolution is idempotent, upgrades openId fallback and rejects conflicts or disabled accounts", async () => {
    const openId = `ou_pm_${randomUUID()}`;
    const unionId = `on_pm_${randomUUID()}`;
    await prisma.user.create({
      data: {
        openId,
        unionId: null,
        name: "身份测试用户",
      },
    });

    const first = await resolveFeishuIdentityForUser({
      openId,
      name: "身份测试用户",
    });
    expect(first.created).toBe(true);
    expect(first.identity.providerSubject).toBe(`open:${openId}`);

    await prisma.user.update({
      where: { openId },
      data: { unionId },
    });
    const upgraded = await resolveFeishuIdentityForUser({
      openId,
      unionId,
      name: "身份测试用户",
    });
    expect(upgraded.created).toBe(false);
    expect(upgraded.account.id).toBe(first.account.id);
    expect(upgraded.identity.providerSubject).toBe(unionId);

    const repeated = await resolveFeishuIdentityForUser({
      openId,
      unionId,
      name: "身份测试用户",
    });
    expect(repeated.account.id).toBe(first.account.id);
    expect(await prisma.account.count()).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.accountIdentity.count({
        where: {
          OR: [{ openId }, { unionId }],
        },
      }),
    ).toBe(1);

    await prisma.account.update({
      where: { id: first.account.id },
      data: { status: "DISABLED" },
    });
    await expect(
      getProjectManagementActorForFeishuUser({
        openId,
        unionId,
        name: "身份测试用户",
      }),
    ).rejects.toThrow("账号已禁用");

    const conflictOpenId = `ou_pm_conflict_${randomUUID()}`;
    const conflictUnionId = `on_pm_conflict_${randomUUID()}`;
    const accountA = await prisma.account.create({ data: {} });
    const accountB = await prisma.account.create({ data: {} });
    await prisma.accountIdentity.create({
      data: {
        accountId: accountA.id,
        provider: "FEISHU",
        providerSubject: conflictUnionId,
        tenantId: "default",
        unionId: conflictUnionId,
      },
    });
    await prisma.accountIdentity.create({
      data: {
        accountId: accountB.id,
        provider: "FEISHU",
        providerSubject: `open:${conflictOpenId}`,
        tenantId: "default",
        openId: conflictOpenId,
      },
    });
    await expect(
      resolveFeishuIdentityForUser({
        openId: conflictOpenId,
        unionId: conflictUnionId,
        name: "冲突用户",
      }),
    ).rejects.toThrow("飞书身份已关联多个项目管理账号");
    const conflictAudit = await prisma.domainAuditEvent.findFirstOrThrow({
      where: {
        action: "pm.identity.conflict",
        entityType: "AccountIdentity",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(conflictAudit.after)).toContain(
      "ADMIN_REVIEW_REQUIRED",
    );
    expect(JSON.stringify(conflictAudit.before)).not.toContain(conflictOpenId);
    expect(JSON.stringify(conflictAudit.before)).not.toContain(conflictUnionId);
  });

  test("identity backfill dry-run is non-mutating and APPLY is idempotent", async () => {
    const openId = `ou_backfill_${randomUUID()}`;
    await prisma.user.create({
      data: {
        openId,
        unionId: `on_backfill_${randomUUID()}`,
        name: "Backfill 用户",
      },
    });

    const beforeAccounts = await prisma.account.count();
    const dryRun = await backfillProjectManagementIdentities();
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.totalUsers).toBeGreaterThanOrEqual(1);
    expect(dryRun.wouldCreate).toBeGreaterThanOrEqual(1);
    expect(await prisma.account.count()).toBe(beforeAccounts);

    const originalApply = process.env.APPLY_PM_IDENTITY_BACKFILL;
    process.env.APPLY_PM_IDENTITY_BACKFILL = "true";
    try {
      const applied = await backfillProjectManagementIdentities({
        dryRun: false,
      });
      expect(applied.created).toBeGreaterThanOrEqual(1);
      const appliedAgain = await backfillProjectManagementIdentities({
        dryRun: false,
      });
      expect(appliedAgain.created).toBe(0);
    } finally {
      restoreEnv("APPLY_PM_IDENTITY_BACKFILL", originalApply);
    }
  });

  test("authorization and readableWhere deny non-members and do not inherit permissions from Tag", async () => {
    const owner = await createAccountPerson("Owner");
    const viewer = await createAccountPerson("Viewer");
    const outsider = await createAccountPerson("Outsider");
    const teamAdmin = await createAccountPerson("Team Admin");
    const otherTeamAdmin = await createAccountPerson("Other Team Admin");
    const task = await createTaskWithCurrentPlan({
      accountId: owner.account.id,
      title: "权限测试 Task",
      team: "英雄",
      techGroup: "电控",
    });
    await prisma.taskMember.create({
      data: {
        taskId: task.taskId,
        personId: owner.person.id,
        role: "OWNER",
        createdByAccountId: owner.account.id,
      },
    });
    await prisma.taskMember.create({
      data: {
        taskId: task.taskId,
        personId: viewer.person.id,
        role: "VIEWER",
        createdByAccountId: owner.account.id,
      },
    });
    const tag = await prisma.tag.create({
      data: {
        name: `权限标签-${randomUUID()}`,
        createdByAccountId: outsider.account.id,
      },
    });
    await prisma.taskTag.create({
      data: { taskId: task.taskId, tagId: tag.id },
    });
    await prisma.systemRoleAssignment.create({
      data: {
        accountId: teamAdmin.account.id,
        role: "TEAM_ADMINISTRATOR",
        team: "英雄",
        techGroup: "",
      },
    });
    await prisma.systemRoleAssignment.create({
      data: {
        accountId: otherTeamAdmin.account.id,
        role: "TEAM_ADMINISTRATOR",
        team: "步兵",
        techGroup: "",
      },
    });

    const ownerActor = actor(owner.account.id, owner.person.id, []);
    const viewerActor = actor(viewer.account.id, viewer.person.id, []);
    const outsiderActor = actor(outsider.account.id, outsider.person.id, []);
    const teamAdminActor = actor(teamAdmin.account.id, teamAdmin.person.id, [
      { role: "TEAM_ADMINISTRATOR", team: "英雄", techGroup: "" },
    ]);
    const globalTeamAdminActor = actor(teamAdmin.account.id, teamAdmin.person.id, [
      { role: "TEAM_ADMINISTRATOR", team: "", techGroup: "" },
    ]);
    const globalAuditorActor = actor(teamAdmin.account.id, teamAdmin.person.id, [
      { role: "AUDITOR", team: "", techGroup: "" },
    ]);
    const otherTeamAdminActor = actor(
      otherTeamAdmin.account.id,
      otherTeamAdmin.person.id,
      [{ role: "TEAM_ADMINISTRATOR", team: "步兵", techGroup: "" }],
    );
    const resource = {
      type: "task" as const,
      team: "英雄",
      techGroup: "电控",
      allowSelfReview: false,
      submittedByAccountId: owner.account.id,
      members: [
        { personId: owner.person.id, role: "OWNER" as const },
        { personId: viewer.person.id, role: "VIEWER" as const },
      ],
    };

    expect(authorize({ actor: ownerActor, action: "task.view", resource })).toMatchObject({
      allowed: true,
    });
    expect(
      authorize({ actor: viewerActor, action: "task.update_metadata", resource }),
    ).toMatchObject({ allowed: false });
    expect(
      authorize({ actor: outsiderActor, action: "task.view", resource }),
    ).toMatchObject({ allowed: false });
    expect(
      authorize({ actor: teamAdminActor, action: "task.view", resource }),
    ).toMatchObject({ allowed: true });
    expect(
      authorize({ actor: globalTeamAdminActor, action: "task.view", resource }),
    ).toMatchObject({ allowed: false });
    expect(
      authorize({ actor: globalAuditorActor, action: "task.view", resource }),
    ).toMatchObject({ allowed: true });
    expect(
      authorize({ actor: otherTeamAdminActor, action: "task.view", resource }),
    ).toMatchObject({ allowed: false });
    expect(
      authorize({ actor: ownerActor, action: "milestone.review", resource }),
    ).toMatchObject({ allowed: false, reason: "self_review_denied" });
    expect(
      authorize({
        actor: outsiderActor,
        action: "task.view",
        resource: { type: "tag", createdByAccountId: outsider.account.id },
      }),
    ).toMatchObject({ allowed: false });

    const ownerVisible = await prisma.task.findMany({
      where: taskReadableWhere(ownerActor),
      select: { id: true },
    });
    expect(ownerVisible.map((item) => item.id)).toContain(task.taskId);
    const outsiderVisible = await prisma.task.findMany({
      where: taskReadableWhere(outsiderActor),
      select: { id: true },
    });
    expect(outsiderVisible.map((item) => item.id)).not.toContain(task.taskId);
    const adminVisible = await prisma.task.findMany({
      where: taskReadableWhere(teamAdminActor),
      select: { id: true },
    });
    expect(adminVisible.map((item) => item.id)).toContain(task.taskId);
    const globalTeamAdminVisible = await prisma.task.findMany({
      where: taskReadableWhere(globalTeamAdminActor),
      select: { id: true },
    });
    expect(globalTeamAdminVisible.map((item) => item.id)).not.toContain(
      task.taskId,
    );
    await expect(
      prisma.systemRoleAssignment.create({
        data: {
          accountId: otherTeamAdmin.account.id,
          role: "TEAM_ADMINISTRATOR",
          team: "",
          techGroup: "",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.systemRoleAssignment.create({
        data: {
          accountId: otherTeamAdmin.account.id,
          role: "SYSTEM_ADMINISTRATOR",
          team: "英雄",
          techGroup: "",
        },
      }),
    ).rejects.toThrow();
  });

  test("project management notifications and audit are transactional and stay inside outbox boundaries", async () => {
    const { account, person } = await createAccountPerson("通知审计用户");
    const eventKey = `pm:p1:test:${randomUUID()}`;
    const payload: ProjectManagementNotificationPayload = {
      kind: "revision_pending_review",
      payloadVersion: PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION,
      purpose: "approval_request",
      category: "REVISION",
      title: "修订待审批",
      summary: "请审批计划修订",
      actorName: "通知审计用户",
      taskId: null,
      taskTitle: "P1 通知 Task",
      entityType: "RevisionNode",
      entityId: `revision-${randomUUID()}`,
      linkPath: "/progress/approvals",
      recipientOpenIds: ["ou_pm_notify", "ou_pm_notify", ""],
      mandatory: true,
      context: { planVersion: "v1" },
    };

    await expect(
      prisma.$transaction(async (tx) => {
        await createInAppNotificationTx(tx, {
          eventKey,
          recipientAccountId: account.id,
          category: "REVISION",
          title: "修订待审批",
          entityType: "RevisionNode",
          entityId: payload.entityId,
          linkPath: "/progress/approvals",
          payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
        });
        await createDomainAuditEventTx(tx, {
          actorAccountId: account.id,
          actorPersonId: person.id,
          action: "pm.revision.submit",
          entityType: "RevisionNode",
          entityId: payload.entityId,
          before: { token: "should-not-persist", title: "旧标题" },
          after: { title: "新标题" },
          reason: "测试",
        });
      }),
    ).resolves.toBeUndefined();
    await enqueueProjectManagementNotification({
      eventKey: `${eventKey}:feishu`,
      type: payload.kind,
      payload,
    });

    const inApp = await prisma.inAppNotification.findUniqueOrThrow({
      where: { eventKey },
    });
    expect(inApp.recipientAccountId).toBe(account.id);
    expect(inApp.payloadVersion).toBe(PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION);

    const audit = await prisma.domainAuditEvent.findFirstOrThrow({
      where: { entityId: payload.entityId },
    });
    expect(JSON.stringify(audit.before)).toContain("[REDACTED]");
    expect(JSON.stringify(audit.before)).not.toContain("should-not-persist");
    await expect(
      prisma.domainAuditEvent.update({
        where: { id: audit.id },
        data: { reason: "审计不允许更新" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.domainAuditEvent.delete({
        where: { id: audit.id },
      }),
    ).rejects.toThrow();

    const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey: `${eventKey}:feishu` },
    });
    expect(outbox).toMatchObject({
      channel: "project-management",
      botKind: "approval",
      type: "revision_pending_review",
      status: "PENDING",
    });
    const adapter = getNotificationChannelAdapter("project-management");
    await expect(adapter.resolveRecipientPlan(outbox)).resolves.toEqual({
      supported: true,
      openIds: ["ou_pm_notify"],
      directOpenIds: ["ou_pm_notify"],
      requiresDirectRecipient: true,
    });
    try {
      await adapter.sendToRecipient(outbox, "ou_pm_notify");
      throw new Error("项目管理飞书通知不应在 P1 投递");
    } catch (error) {
      expect(error).toBeInstanceOf(NonRetryableNotificationError);
      expect(error).toHaveProperty(
        "message",
        "项目管理飞书通知投递将在 P6 启用",
      );
    }
    await expect(
      enqueueProjectManagementNotification({
        eventKey: `${eventKey}:invalid-approval`,
        type: "task_assigned",
        payload: {
          ...payload,
          kind: "task_assigned",
          purpose: "approval_request",
          category: "TASK",
          entityType: "Task",
          entityId: `task-${randomUUID()}`,
        },
      }),
    ).rejects.toThrow();
  });
});

async function createAccountPerson(displayName: string) {
  const account = await prisma.account.create({
    data: {
      status: "ACTIVE",
      person: {
        create: {
          displayName,
          status: "ACTIVE",
        },
      },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { account, person: account.person };
}

async function createTaskWithCurrentPlan({
  accountId,
  title,
  team,
  techGroup,
}: {
  accountId: string;
  title: string;
  team: string;
  techGroup: string;
}) {
  const taskId = randomUUID();
  const planVersionId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.create({
      data: {
        id: taskId,
        title,
        team,
        techGroup,
        currentPlanVersionId: planVersionId,
        createdByAccountId: accountId,
      },
    });
    await tx.taskPlanVersion.create({
      data: {
        id: planVersionId,
        taskId,
        versionNo: 1,
        status: "CURRENT",
        reason: "初始计划",
        createdByAccountId: accountId,
        activatedAt: new Date(),
      },
    });
  });
  return { taskId, planVersionId };
}

async function createMilestone(
  taskId: string,
  planVersionId: string,
  accountId: string,
) {
  const node = await prisma.taskNode.create({
    data: {
      taskId,
      type: "MILESTONE",
      status: "ACTIVE",
      businessDescription: "测试 Milestone",
      createdByAccountId: accountId,
    },
  });
  const milestone = await prisma.milestoneNode.create({
    data: {
      nodeId: node.id,
      goal: "完成 P1 约束",
      completionCriteria: "约束测试通过",
      expectedCompletedAt: new Date("2026-07-30T10:00:00.000Z"),
      reviewRequirements: "提交测试证据",
    },
  });
  await prisma.planVersionNode.create({
    data: {
      planVersionId,
      nodeId: node.id,
      sequence: 1,
    },
  });
  return { nodeId: node.id, milestoneId: milestone.id };
}

function actor(
  accountId: string,
  personId: string,
  systemRoles: ProjectManagementActor["systemRoles"],
): ProjectManagementActor {
  return {
    accountId,
    personId,
    openId: `ou_actor_${accountId}`,
    unionId: null,
    systemRoles,
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

test("providerSubject uses unionId first and prefixed openId fallback", () => {
  expect(
    projectManagementFeishuProviderSubject({
      openId: "ou_subject",
      unionId: "on_subject",
    }),
  ).toBe("on_subject");
  expect(
    projectManagementFeishuProviderSubject({
      openId: "ou_subject",
      unionId: null,
    }),
  ).toBe("open:ou_subject");
});
