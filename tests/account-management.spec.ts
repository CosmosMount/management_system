// @playwright-project node-db
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { lockFeishuContactSyncTx } from "../lib/active-account";
import {
  assignReimbursementRole,
  grantAccountRole,
  revokeAccountRole,
} from "../lib/account-management";
import { isGlobalSuperAdministrator } from "../lib/account-authorization";
import { authorize } from "../lib/project-management/authorization";
import { lockGlobalApprovalAdministratorSetTx } from "../lib/project-management/approval-administrators";
import {
  getProjectManagementActorForFeishuUser,
  type ProjectManagementActor,
} from "../lib/project-management/identity";
import { prisma } from "../lib/prisma";

test.describe.configure({ mode: "serial" });

test("账号权限写与通讯录反序锁 Person 时不会死锁", async () => {
  const actor = await createAccount("通讯录锁顺序超管");
  const target = await createAccount("通讯录锁顺序目标");
  await prisma.systemRoleAssignment.create({
    data: { accountId: actor.accountId, role: "SUPER_ADMINISTRATOR" },
  });
  await prisma.user.create({
    data: {
      accountId: target.accountId,
      openId: target.openId,
      name: "通讯录锁顺序目标",
    },
  });

  let releaseSync!: () => void;
  const syncGate = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  let markTargetLocked!: () => void;
  const targetLocked = new Promise<void>((resolve) => {
    markTargetLocked = resolve;
  });
  const simulatedSync = prisma.$transaction(async (tx) => {
    await lockFeishuContactSyncTx(tx);
    await tx.$queryRaw`
      SELECT "id" FROM "Person"
      WHERE "id" = ${target.personId}
      FOR UPDATE
    `;
    markTargetLocked();
    await syncGate;
    await tx.$queryRaw`
      SELECT "id" FROM "Person"
      WHERE "id" = ${actor.personId}
      FOR UPDATE
    `;
  });

  let released = false;
  let roleWrite: ReturnType<typeof assignReimbursementRole> | undefined;
  try {
    await targetLocked;
    roleWrite = assignReimbursementRole(actor.accountId, {
      targetAccountId: target.accountId,
      role: "TEAM_ADMIN",
      team: "英雄",
      techGroup: "",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    releaseSync();
    released = true;
    const outcomes = await Promise.race([
      Promise.allSettled([simulatedSync, roleWrite]),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("账号权限与通讯录反序锁超时")), 5_000);
      }),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(
      true,
    );
  } finally {
    if (!released) releaseSync();
    await Promise.allSettled([
      simulatedSync,
      ...(roleWrite ? [roleWrite] : []),
    ]);
  }
});

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
        role: "PROJECT_ADMINISTRATOR",
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
    expect((rejected?.reason as Error).message).toMatch(
      /至少保留一名超级管理员|无管理权限/,
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

test("全局角色撤销在 Person 行锁前获取管理员集合锁", async () => {
  const actor = await createAccount("锁顺序测试超管");
  const target = await createAccount("锁顺序测试项目管理员");
  await prisma.systemRoleAssignment.create({
    data: { accountId: actor.accountId, role: "SUPER_ADMINISTRATOR" },
  });
  const targetAssignment = await prisma.systemRoleAssignment.create({
    data: { accountId: target.accountId, role: "PROJECT_ADMINISTRATOR" },
  });

  let releasePersonLock!: () => void;
  const personLockGate = new Promise<void>((resolve) => {
    releasePersonLock = resolve;
  });
  let markPersonLocked!: () => void;
  const personLocked = new Promise<void>((resolve) => {
    markPersonLocked = resolve;
  });
  const personLockHolder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "Person"
      WHERE "id" = ${actor.personId}
      FOR UPDATE
    `;
    markPersonLocked();
    await personLockGate;
  });
  await personLocked;

  const revocation = revokeAccountRole(
    actor.accountId,
    targetAssignment.id,
  );
  await new Promise((resolve) => setTimeout(resolve, 75));

  let probeAcquiredGlobalLock = false;
  const globalLockProbe = prisma.$transaction(async (tx) => {
    await lockGlobalApprovalAdministratorSetTx(tx);
    probeAcquiredGlobalLock = true;
    await tx.$queryRaw`
      SELECT "id"
      FROM "Person"
      WHERE "id" = ${actor.personId}
      FOR UPDATE
    `;
  });
  await new Promise((resolve) => setTimeout(resolve, 75));

  const probeAcquiredBeforeRelease = probeAcquiredGlobalLock;
  releasePersonLock();
  const outcomes = await Promise.allSettled([
    personLockHolder,
    revocation,
    globalLockProbe,
  ]);
  expect(probeAcquiredBeforeRelease).toBe(false);
  expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(
    true,
  );
  await expect(
    prisma.systemRoleAssignment.findUniqueOrThrow({
      where: { id: targetAssignment.id },
      select: { revokedAt: true },
    }),
  ).resolves.toMatchObject({ revokedAt: expect.any(Date) });
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

test("项目管理员全局放行并允许自审，普通账号保持全员读取权限", async () => {
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
  expect(authorize({ actor: projectAdmin, action: "task.manage_members", resource: task }).allowed).toBe(true);
  expect(authorize({ actor: base, action: "termination.submit_review", resource: task }).allowed).toBe(false);
  expect(authorize({ actor: base, action: "termination.review", resource: task }).allowed).toBe(false);
  expect(authorize({ actor: base, action: "segment.manage_others", resource: { type: "segment", task } }).allowed).toBe(false);
  expect(authorize({ actor: base, action: "task.view", resource: task }).allowed).toBe(true);
  expect(authorize({ actor: projectAdmin, action: "milestone.review", resource: task })).toMatchObject({ allowed: true, reason: "global_administrator" });
});

test("停用人员的身份解析不会恢复在职状态或携带项目管理员角色", async () => {
  const inactive = await createAccount("离职身份解析测试");
  await prisma.systemRoleAssignment.create({
    data: {
      accountId: inactive.accountId,
      role: "PROJECT_ADMINISTRATOR",
    },
  });
  await prisma.person.update({
    where: { id: inactive.personId },
    data: { status: "INACTIVE" },
  });

  const inactiveActor = await getProjectManagementActorForFeishuUser({
    openId: inactive.openId,
  });
  expect(inactiveActor).toMatchObject({ isActive: false, systemRoles: [] });
  expect(
    authorize({
      actor: inactiveActor,
      action: "task.view",
      resource: { type: "task" },
    }),
  ).toMatchObject({ allowed: true });
  expect(
    authorize({
      actor: inactiveActor,
      action: "project.comment.create",
      resource: { type: "project" },
    }),
  ).toMatchObject({ allowed: false, reason: "inactive_person_read_only" });
  expect(
    authorize({
      actor: inactiveActor,
      action: "task.risk.create",
      resource: {
        type: "task",
        members: [{ personId: inactive.personId, role: "OWNER" }],
      },
    }),
  ).toMatchObject({ allowed: false, reason: "inactive_person_read_only" });
  expect(
    authorize({
      actor: inactiveActor,
      action: "segment.manage_self",
      resource: { type: "segment", personId: inactive.personId },
    }),
  ).toMatchObject({ allowed: false, reason: "inactive_person_read_only" });
  await expect(
    prisma.person.findUnique({
      where: { id: inactive.personId },
      select: { status: true },
    }),
  ).resolves.toEqual({ status: "INACTIVE" });
});

test("停用操作人或目标账号不能在角色事务中取得新权限", async () => {
  const actor = await createAccount("停用角色事务操作人");
  const target = await createAccount("停用角色事务目标");
  await prisma.systemRoleAssignment.create({
    data: {
      accountId: actor.accountId,
      role: "SUPER_ADMINISTRATOR",
    },
  });
  await prisma.person.update({
    where: { id: target.personId },
    data: { status: "INACTIVE" },
  });

  await expect(
    grantAccountRole(actor.accountId, {
      targetAccountId: target.accountId,
      role: "PROJECT_ADMINISTRATOR",
      team: "",
      techGroup: "",
    }),
  ).rejects.toThrow("目标账号已停用，无法授予角色");
  await expect(
    assignReimbursementRole(actor.accountId, {
      targetAccountId: target.accountId,
      role: "TEAM_ADMIN",
      team: "英雄",
      techGroup: "",
    }),
  ).rejects.toThrow("目标账号已停用，无法授予角色");

  await prisma.person.update({
    where: { id: actor.personId },
    data: { status: "INACTIVE" },
  });
  await prisma.person.update({
    where: { id: target.personId },
    data: { status: "ACTIVE" },
  });
  await expect(
    grantAccountRole(actor.accountId, {
      targetAccountId: target.accountId,
      role: "PROJECT_ADMINISTRATOR",
      team: "",
      techGroup: "",
    }),
  ).rejects.toThrow("无管理权限");
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
