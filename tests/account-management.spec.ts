import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  grantAccountRole,
  revokeAccountRole,
} from "../lib/account-management";
import { isGlobalSuperAdministrator } from "../lib/account-authorization";
import { authorize } from "../lib/project-management/authorization";
import {
  getProjectManagementActorForFeishuUser,
  type ProjectManagementActor,
} from "../lib/project-management/identity";
import { prisma } from "../lib/prisma";

test.describe.configure({ mode: "serial" });

test("统一超管、项目角色、审计和通知保持事务一致", async () => {
  const actor = await createAccount("权限测试超管");
  const target = await createAccount("权限测试目标");
  const outsider = await createAccount("权限测试普通成员");
  const superAssignment = await prisma.systemRoleAssignment.create({
    data: { accountId: actor.accountId, role: "SUPER_ADMINISTRATOR" },
  });

  expect(await isGlobalSuperAdministrator(actor.openId)).toBe(true);
  await expect(
    prisma.systemRoleAssignment.create({
      data: {
        accountId: target.accountId,
        role: "GROUP_LEADER",
        team: "英雄",
        techGroup: "电控",
      },
    }),
  ).rejects.toThrow();
  await expect(
    grantAccountRole(outsider.accountId, {
      targetAccountId: target.accountId,
      role: "PROJECT_ADMINISTRATOR",
      team: "",
      techGroup: "",
    }),
  ).rejects.toThrow("无管理权限");
  const first = await grantAccountRole(actor.accountId, {
    targetAccountId: target.accountId,
    role: "PROJECT_ADMINISTRATOR",
    team: "",
    techGroup: "",
  });
  const repeated = await grantAccountRole(actor.accountId, {
    targetAccountId: target.accountId,
    role: "PROJECT_ADMINISTRATOR",
    team: "",
    techGroup: "",
  });
  expect(first.changed).toBe(true);
  expect(repeated.changed).toBe(false);

  await expect(
    getProjectManagementActorForFeishuUser({ openId: target.openId }),
  ).resolves.toMatchObject({ accountId: target.accountId });

  const [account, auditCount, inAppCount, outboxCount] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id: target.accountId } }),
    prisma.domainAuditEvent.count({
      where: { actorAccountId: actor.accountId, entityType: { in: ["Account", "SystemRoleAssignment"] } },
    }),
    prisma.inAppNotification.count({
      where: { recipientAccountId: target.accountId, category: "ACCOUNT_SECURITY" },
    }),
    prisma.notificationOutbox.count({
      where: { eventKey: { startsWith: "account-security:" } },
    }),
  ]);
  expect(account.id).toBe(target.accountId);
  expect(auditCount).toBeGreaterThanOrEqual(1);
  expect(inAppCount).toBeGreaterThanOrEqual(1);
  expect(outboxCount).toBeGreaterThanOrEqual(1);

  const roleOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
    where: {
      eventKey: `account-security:account.role.granted:${first.assignment.id}:feishu`,
    },
    include: { recipients: true },
  });
  const rolePayload = JSON.parse(roleOutbox.payload) as {
    actorName?: string;
    mandatory?: boolean;
    recipientOpenIds?: string[];
    summary?: string;
  };
  expect(roleOutbox).toMatchObject({
    botKind: "notification",
    type: "account_security",
  });
  expect(rolePayload).toMatchObject({
    actorName: "权限测试超管",
    mandatory: true,
  });
  expect(rolePayload.summary).toContain("项目管理员");
  expect(rolePayload.recipientOpenIds).toContain(target.openId);
  expect(roleOutbox.recipients).toHaveLength(0);

  await expect(revokeAccountRole(actor.accountId, first.assignment.id)).resolves.toMatchObject({
    changed: true,
  });
  await expect(revokeAccountRole(actor.accountId, first.assignment.id)).resolves.toMatchObject({
    changed: false,
  });
  await expect(
    revokeAccountRole(actor.accountId, superAssignment.id),
  ).rejects.toThrow("不能撤销自己的超级管理员权限");
});

test("两名超级管理员并发互撤只能成功一次并保留最后一名", async () => {
  const first = await createAccount("并发超管甲");
  const second = await createAccount("并发超管乙");
  const firstAssignment = await prisma.systemRoleAssignment.create({
    data: { accountId: first.accountId, role: "SUPER_ADMINISTRATOR" },
  });
  const secondAssignment = await prisma.systemRoleAssignment.create({
    data: { accountId: second.accountId, role: "SUPER_ADMINISTRATOR" },
  });
  const unrelatedAssignments = await prisma.systemRoleAssignment.findMany({
    where: {
      role: "SUPER_ADMINISTRATOR",
      revokedAt: null,
      id: { notIn: [firstAssignment.id, secondAssignment.id] },
    },
    select: { id: true },
  });
  try {
    if (unrelatedAssignments.length > 0) {
      await prisma.systemRoleAssignment.updateMany({
        where: { id: { in: unrelatedAssignments.map((item) => item.id) } },
        data: { revokedAt: new Date() },
      });
    }
    const results = await Promise.allSettled([
      revokeAccountRole(first.accountId, secondAssignment.id),
      revokeAccountRole(second.accountId, firstAssignment.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect((rejected?.reason as Error).message).toContain(
      "至少保留一名超级管理员",
    );
    await expect(
      prisma.systemRoleAssignment.count({
        where: { role: "SUPER_ADMINISTRATOR", revokedAt: null },
      }),
    ).resolves.toBe(1);
  } finally {
    if (unrelatedAssignments.length > 0) {
      await prisma.systemRoleAssignment.updateMany({
        where: { id: { in: unrelatedAssignments.map((item) => item.id) } },
        data: { revokedAt: null, revokedByAccountId: null },
      });
    }
    await prisma.systemRoleAssignment.updateMany({
      where: { id: { in: [firstAssignment.id, secondAssignment.id] } },
      data: { revokedAt: new Date() },
    });
  }
});

test("最后一名可用全局审批人不能被并发撤销角色或清空飞书身份", async () => {
  const actor = await createAccount("审批人保护操作超管");
  const target = await createAccount("最后一名活跃审批人");
  const actorAssignment = await prisma.systemRoleAssignment.create({
    data: { accountId: actor.accountId, role: "SUPER_ADMINISTRATOR" },
  });
  const targetAssignment = await prisma.systemRoleAssignment.create({
    data: { accountId: target.accountId, role: "PROJECT_ADMINISTRATOR" },
  });
  const guardedTask = await createTaskForAdministratorGuard(actor);
  const actorIdentities = await prisma.accountIdentity.findMany({
    where: { accountId: actor.accountId, provider: "FEISHU", tenantId: "default" },
    select: { id: true, openId: true },
  });
  const targetIdentities = await prisma.accountIdentity.findMany({
    where: { accountId: target.accountId, provider: "FEISHU", tenantId: "default" },
    select: { id: true, openId: true },
  });
  expect(actorIdentities).not.toHaveLength(0);
  expect(targetIdentities).not.toHaveLength(0);
  const blankOpenIds = await allocateUniqueBlankOpenIds(
    actorIdentities.length + targetIdentities.length,
  );
  const unrelatedAssignments = await prisma.systemRoleAssignment.findMany({
    where: {
      id: { notIn: [actorAssignment.id, targetAssignment.id] },
      role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] },
      team: "",
      techGroup: "",
      revokedAt: null,
    },
    select: { id: true },
  });
  try {
    await prisma.systemRoleAssignment.updateMany({
      where: { id: { in: unrelatedAssignments.map((item) => item.id) } },
      data: { revokedAt: new Date() },
    });
    for (const [index, identity] of actorIdentities.entries()) {
      await prisma.accountIdentity.update({
        where: { id: identity.id },
        data: { openId: blankOpenIds[index] },
      });
    }
    const sideEffectsBefore = await prisma.domainAuditEvent.count({
      where: {
        entityId: targetAssignment.id,
        action: "account.role.revoked",
      },
    });
    const outcomes = await Promise.allSettled([
      revokeAccountRole(actor.accountId, targetAssignment.id),
      prisma.$transaction(
        targetIdentities.map((identity, index) =>
          prisma.accountIdentity.update({
            where: { id: identity.id },
            data: { openId: blankOpenIds[actorIdentities.length + index] },
          }),
        ),
      ),
    ]);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect((outcome.reason as Error).message).toMatch(
          /至少保留一名具有有效飞书身份的全局管理员|usable global approval administrator/,
        );
      }
    }
    await expect(
      prisma.systemRoleAssignment.findUniqueOrThrow({
        where: { id: targetAssignment.id },
        select: { revokedAt: true },
      }),
    ).resolves.toEqual({ revokedAt: null });
    await expect(
      prisma.accountIdentity.findMany({
        where: { id: { in: targetIdentities.map((identity) => identity.id) } },
        select: { id: true, openId: true },
        orderBy: { id: "asc" },
      }),
    ).resolves.toEqual(
      [...targetIdentities].sort((left, right) => left.id.localeCompare(right.id)),
    );
    await expect(
      prisma.domainAuditEvent.count({
        where: {
          entityId: targetAssignment.id,
          action: "account.role.revoked",
        },
      }),
    ).resolves.toBe(sideEffectsBefore);
  } finally {
    for (const identity of [...actorIdentities, ...targetIdentities]) {
      await prisma.accountIdentity.update({
        where: { id: identity.id },
        data: { openId: identity.openId },
      });
    }
    await prisma.systemRoleAssignment.updateMany({
      where: { id: { in: unrelatedAssignments.map((item) => item.id) } },
      data: { revokedAt: null, revokedByAccountId: null },
    });
    await prisma.$executeRaw`
      WITH deleted_members AS (
        DELETE FROM "TaskMember" WHERE "taskId" = ${guardedTask.taskId}
      ), deleted_plan AS (
        DELETE FROM "TaskPlanVersion" WHERE id = ${guardedTask.planVersionId}
      )
      DELETE FROM "Task" WHERE id = ${guardedTask.taskId}
    `;
    await prisma.systemRoleAssignment.updateMany({
      where: { id: { in: [actorAssignment.id, targetAssignment.id] } },
      data: { revokedAt: new Date() },
    });
  }
});

test("项目管理员全局放行并允许自审，退役组长仅保留全员读取权限", async () => {
  const base = { accountId: randomUUID(), personId: randomUUID(), openId: "test", systemRoles: [] };
  const task = {
    type: "task" as const,
    team: "英雄",
    techGroup: "电控",
    members: [],
  };
  const projectAdmin: ProjectManagementActor = {
    ...base,
    systemRoles: [{ role: "PROJECT_ADMINISTRATOR", team: "", techGroup: "" }],
  };
  const teamLeader: ProjectManagementActor = {
    ...base,
    systemRoles: [{ role: "GROUP_LEADER", team: "英雄", techGroup: "" }],
  };
  const techLeader: ProjectManagementActor = {
    ...base,
    systemRoles: [{ role: "GROUP_LEADER", team: "", techGroup: "电控" }],
  };
  const otherLeader: ProjectManagementActor = {
    ...base,
    systemRoles: [{ role: "GROUP_LEADER", team: "步兵", techGroup: "" }],
  };

  expect(authorize({ actor: projectAdmin, action: "task.manage_members", resource: task }).allowed).toBe(true);
  expect(authorize({ actor: teamLeader, action: "task.terminate", resource: task }).allowed).toBe(false);
  expect(authorize({ actor: techLeader, action: "segment.manage_others", resource: { type: "segment", task } }).allowed).toBe(false);
  expect(authorize({ actor: otherLeader, action: "task.view", resource: task }).allowed).toBe(true);
  expect(authorize({ actor: projectAdmin, action: "milestone.review", resource: task })).toMatchObject({ allowed: true, reason: "global_administrator" });
});

async function createAccount(name: string) {
  const suffix = randomUUID();
  const openId = `ou_account_management_${suffix}`;
  const account = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: { create: { displayName: name } },
    },
    include: { person: { select: { id: true } } },
  });
  if (!account.person) throw new Error("测试账号缺少人员记录");
  return {
    accountId: account.id,
    personId: account.person.id,
    openId,
  };
}

async function createTaskForAdministratorGuard(account: {
  accountId: string;
  personId: string;
}) {
  const taskId = randomUUID();
  const planVersionId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.create({
      data: {
        id: taskId,
        title: `全局审批管理员门禁测试 ${taskId}`,
        team: "英雄",
        techGroup: "电控",
        currentPlanVersionId: planVersionId,
        createdByAccountId: account.accountId,
      },
    });
    await tx.taskPlanVersion.create({
      data: {
        id: planVersionId,
        taskId,
        versionNo: 1,
        status: "CURRENT",
        createdByAccountId: account.accountId,
      },
    });
    await tx.taskMember.create({
      data: {
        taskId,
        personId: account.personId,
        role: "OWNER",
        createdByAccountId: account.accountId,
      },
    });
  });
  return { taskId, planVersionId };
}

async function allocateUniqueBlankOpenIds(count: number): Promise<string[]> {
  const existing = await prisma.accountIdentity.findMany({
    where: {
      provider: "FEISHU",
      tenantId: "default",
      openId: { not: null },
    },
    select: { openId: true },
  });
  const used = new Set(
    existing
      .map(({ openId }) => openId)
      .filter((openId): openId is string => openId !== null && openId.trim() === ""),
  );
  const allocated: string[] = [];
  let candidate = " ";
  while (allocated.length < count) {
    if (!used.has(candidate)) {
      allocated.push(candidate);
      used.add(candidate);
    }
    candidate += " ";
  }
  return allocated;
}
