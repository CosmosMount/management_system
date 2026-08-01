import type { AccountStatus, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import {
  createInAppNotificationTx,
  enqueueProjectManagementNotificationTx,
  PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION,
} from "@/lib/project-management/notifications/events";
import type {
  AssignReimbursementRoleInput,
  GrantAccountRoleInput,
} from "@/lib/validations/account-management";

const SUPER_ADMIN_MUTATION_LOCK = 2_026_073_101;

type Transaction = Prisma.TransactionClient;

type SecurityTarget = {
  id: string;
  person: { displayName: string } | null;
  identities: Array<{ openId: string | null }>;
};

async function assertActorIsSuperAdministrator(
  tx: Transaction,
  actorAccountId: string,
) {
  const assignment = await tx.systemRoleAssignment.findFirst({
    where: {
      accountId: actorAccountId,
      role: "SUPER_ADMINISTRATOR",
      team: "",
      techGroup: "",
      revokedAt: null,
    },
    select: { id: true },
  });
  if (!assignment) throw new Error("无管理权限");
}

async function lockAccountMutations(tx: Transaction, accountId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'account-permissions:' + accountId}))`;
}

async function loadSecurityTarget(tx: Transaction, targetAccountId: string) {
  const target = await tx.account.findUnique({
    where: { id: targetAccountId },
    select: {
      id: true,
      projectAccessStatus: true,
      person: { select: { displayName: true } },
      identities: {
        where: { provider: "FEISHU", tenantId: "default" },
        orderBy: { createdAt: "asc" },
        select: { openId: true },
      },
      reimbursementUser: { select: { openId: true } },
    },
  });
  if (!target) throw new Error("目标账号不存在");
  return target;
}

async function actorName(tx: Transaction, actorAccountId: string) {
  const actor = await tx.account.findUnique({
    where: { id: actorAccountId },
    select: { person: { select: { displayName: true } } },
  });
  return actor?.person?.displayName ?? "超级管理员";
}

async function createAccountSecuritySideEffects(
  tx: Transaction,
  input: {
    actorAccountId: string;
    target: SecurityTarget;
    action: string;
    entityType: string;
    entityId: string;
    eventId?: string;
    title: string;
    summary: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  },
) {
  const operatorName = await actorName(tx, input.actorAccountId);
  await createDomainAuditEventTx(tx, {
    actorAccountId: input.actorAccountId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before,
    after: input.after,
    reason: "超级管理员通过账号与权限后台操作",
  });

  const eventKey = `account-security:${input.action}:${input.eventId ?? input.entityId}`;
  await createInAppNotificationTx(tx, {
    eventKey: `${eventKey}:inapp:${input.target.id}`,
    recipientAccountId: input.target.id,
    category: "ACCOUNT_SECURITY",
    title: input.title,
    summary: `${operatorName}：${input.summary}`,
    entityType: input.entityType,
    entityId: input.entityId,
    linkPath: "/",
    payload: { action: input.action, operatorName },
  });

  const recipientOpenIds = [
    ...new Set(
      input.target.identities.flatMap((identity) =>
        identity.openId?.trim() ? [identity.openId.trim()] : [],
      ),
    ),
  ];
  await enqueueProjectManagementNotificationTx(tx, {
    eventKey: `${eventKey}:feishu`,
    type: "account_security",
    payload: {
      kind: "account_security",
      payloadVersion: PROJECT_MANAGEMENT_NOTIFICATION_PAYLOAD_VERSION,
      purpose: "notification",
      category: "ACCOUNT_SECURITY",
      title: input.title,
      summary: input.summary,
      actorName: operatorName,
      entityType: input.entityType,
      entityId: input.entityId,
      linkPath: "/",
      recipientOpenIds,
      mandatory: true,
      context: { targetName: input.target.person?.displayName ?? "未知用户" },
    },
  });
}

export async function grantAccountRole(
  actorAccountId: string,
  input: GrantAccountRoleInput,
) {
  return prisma.$transaction(async (tx) => {
    await assertActorIsSuperAdministrator(tx, actorAccountId);
    if (input.role === "SUPER_ADMINISTRATOR") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPER_ADMIN_MUTATION_LOCK})`;
    }
    await lockAccountMutations(tx, input.targetAccountId);
    const target = await loadSecurityTarget(tx, input.targetAccountId);
    const team = input.role === "GROUP_LEADER" ? input.team : "";
    const techGroup = input.role === "GROUP_LEADER" ? input.techGroup : "";
    const existing = await tx.systemRoleAssignment.findFirst({
      where: {
        accountId: target.id,
        role: input.role,
        team,
        techGroup,
        revokedAt: null,
      },
    });
    if (existing) return { assignment: existing, changed: false };

    const assignment = await tx.systemRoleAssignment.create({
      data: {
        accountId: target.id,
        role: input.role,
        team,
        techGroup,
        grantedByAccountId: actorAccountId,
      },
    });
    await createAccountSecuritySideEffects(tx, {
      actorAccountId,
      target,
      action: "account.role.granted",
      entityType: "SystemRoleAssignment",
      entityId: assignment.id,
      title: "账号权限已更新",
      summary: `已授予${formatAccountRole(input.role, team, techGroup)}`,
      after: { role: input.role, team, techGroup, active: true },
    });
    return { assignment, changed: true };
  });
}

export async function revokeAccountRole(
  actorAccountId: string,
  assignmentId: string,
) {
  return prisma.$transaction(async (tx) => {
    await assertActorIsSuperAdministrator(tx, actorAccountId);
    let assignment = await tx.systemRoleAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!assignment) throw new Error("角色记录不存在");
    if (assignment.role === "SUPER_ADMINISTRATOR") {
      // All super-administrator mutations acquire the global lock before the
      // target-account lock. A stable order avoids a grant/revoke deadlock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPER_ADMIN_MUTATION_LOCK})`;
    }
    await lockAccountMutations(tx, assignment.accountId);
    assignment = await tx.systemRoleAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!assignment) throw new Error("角色记录不存在");
    if (assignment.revokedAt) return { assignment, changed: false };

    if (assignment.role === "SUPER_ADMINISTRATOR") {
      if (assignment.accountId === actorAccountId) {
        throw new Error("不能撤销自己的超级管理员权限");
      }
      const count = await tx.systemRoleAssignment.count({
        where: { role: "SUPER_ADMINISTRATOR", revokedAt: null },
      });
      if (count <= 1) throw new Error("至少保留一名超级管理员");
    }

    const target = await loadSecurityTarget(tx, assignment.accountId);
    const revokedAt = new Date();
    const updated = await tx.systemRoleAssignment.update({
      where: { id: assignment.id },
      data: { revokedAt, revokedByAccountId: actorAccountId },
    });
    await createAccountSecuritySideEffects(tx, {
      actorAccountId,
      target,
      action: "account.role.revoked",
      entityType: "SystemRoleAssignment",
      entityId: assignment.id,
      title: "账号权限已更新",
      summary: `已撤销${formatAccountRole(
        assignment.role,
        assignment.team,
        assignment.techGroup,
      )}`,
      before: {
        role: assignment.role,
        team: assignment.team,
        techGroup: assignment.techGroup,
        active: true,
      },
      after: { active: false, revokedAt: revokedAt.toISOString() },
    });
    return { assignment: updated, changed: true };
  });
}

export async function setProjectAccessStatus(
  actorAccountId: string,
  targetAccountId: string,
  status: AccountStatus,
) {
  return prisma.$transaction(async (tx) => {
    await assertActorIsSuperAdministrator(tx, actorAccountId);
    await lockAccountMutations(tx, targetAccountId);
    const target = await loadSecurityTarget(tx, targetAccountId);
    if (target.projectAccessStatus === status) return { status, changed: false };
    const changeId = randomUUID();
    await tx.account.update({
      where: { id: target.id },
      data: { projectAccessStatus: status },
    });
    await createAccountSecuritySideEffects(tx, {
      actorAccountId,
      target,
      action: "account.project_access.changed",
      entityType: "Account",
      entityId: target.id,
      eventId: changeId,
      title: status === "ACTIVE" ? "项目访问已启用" : "项目访问已禁用",
      summary:
        status === "ACTIVE"
          ? "你的项目管理访问权限已恢复，报销权限不受影响"
          : "你的项目管理访问权限已禁用，登录和报销权限不受影响",
      before: { projectAccessStatus: target.projectAccessStatus },
      after: { projectAccessStatus: status },
    });
    return { status, changed: true };
  });
}

export async function assignReimbursementRole(
  actorAccountId: string,
  input: AssignReimbursementRoleInput,
) {
  return prisma.$transaction(async (tx) => {
    await assertActorIsSuperAdministrator(tx, actorAccountId);
    await lockAccountMutations(tx, input.targetAccountId);
    const target = await loadSecurityTarget(tx, input.targetAccountId);
    const openId = target.reimbursementUser?.openId;
    if (!openId) throw new Error("该账号缺少报销用户资料，请先同步飞书通讯录");
    const existing = await tx.userRole.findFirst({
      where: {
        accountId: target.id,
        role: input.role,
        team: input.team,
        techGroup: input.techGroup,
        revokedAt: null,
      },
    });
    if (existing) return { assignment: existing, changed: false };
    const assignment = await tx.userRole.create({
      data: {
        accountId: target.id,
        openId,
        role: input.role,
        team: input.team,
        techGroup: input.techGroup,
        grantedByAccountId: actorAccountId,
      },
    });
    await createAccountSecuritySideEffects(tx, {
      actorAccountId,
      target,
      action: "account.reimbursement_role.granted",
      entityType: "UserRole",
      entityId: assignment.id,
      title: "报销权限已更新",
      summary: `已授予${formatReimbursementRole(input.role, input.team, input.techGroup)}`,
      after: { role: input.role, team: input.team, techGroup: input.techGroup },
    });
    return { assignment, changed: true };
  });
}

export async function revokeReimbursementRole(
  actorAccountId: string,
  assignmentId: string,
) {
  return prisma.$transaction(async (tx) => {
    await assertActorIsSuperAdministrator(tx, actorAccountId);
    let assignment = await tx.userRole.findUnique({ where: { id: assignmentId } });
    if (!assignment) throw new Error("角色记录不存在");
    if (!assignment.accountId) throw new Error("角色记录缺少统一账号关联");
    await lockAccountMutations(tx, assignment.accountId);
    assignment = await tx.userRole.findUnique({ where: { id: assignmentId } });
    if (!assignment) throw new Error("角色记录不存在");
    if (assignment.role === "SUPER_ADMIN") {
      throw new Error("旧超级管理员记录只能通过迁移工具处理");
    }
    if (assignment.revokedAt) return { assignment, changed: false };
    if (!assignment.accountId) throw new Error("角色记录缺少统一账号关联");
    const target = await loadSecurityTarget(tx, assignment.accountId);
    const revokedAt = new Date();
    const updated = await tx.userRole.update({
      where: { id: assignment.id },
      data: { revokedAt, revokedByAccountId: actorAccountId },
    });
    await createAccountSecuritySideEffects(tx, {
      actorAccountId,
      target,
      action: "account.reimbursement_role.revoked",
      entityType: "UserRole",
      entityId: assignment.id,
      title: "报销权限已更新",
      summary: `已撤销${formatReimbursementRole(
        assignment.role,
        assignment.team,
        assignment.techGroup,
      )}`,
      before: { role: assignment.role, team: assignment.team, techGroup: assignment.techGroup },
      after: { active: false, revokedAt: revokedAt.toISOString() },
    });
    return { assignment: updated, changed: true };
  });
}

function formatAccountRole(role: string, team: string, techGroup: string) {
  if (role === "SUPER_ADMINISTRATOR") return "超级管理员";
  if (role === "PROJECT_ADMINISTRATOR") return "项目管理员";
  return `${team || techGroup}组长`;
}

function formatReimbursementRole(role: string, team: string, techGroup: string) {
  const label = {
    TEAM_ADMIN: "报销车组组长",
    TECH_GROUP_ADMIN: "报销技术组组长",
    TEACHER: "指导老师",
    FINANCE: "报销员",
  }[role] ?? "报销角色";
  return `${team || techGroup}${label}`;
}
