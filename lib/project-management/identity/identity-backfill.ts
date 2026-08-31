import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import {
  projectManagementFeishuProviderSubject,
  resolveFeishuIdentityForUser,
} from "@/lib/project-management/identity/feishu-identity";
import {
  DEFAULT_TENANT_ID,
  FEISHU_PROVIDER,
  stableIdentityHash,
} from "@/lib/project-management/identity/identity-support";
import {
  ProjectManagementIdentityError,
  type ProjectManagementIdentityInput,
} from "@/lib/project-management/identity/identity-types";

export type ProjectManagementIdentityBackfillResult = {
  dryRun: boolean;
  totalUsers: number;
  alreadyExisting: number;
  wouldCreate: number;
  created: number;
  conflicts: Array<{
    subjectHash: string;
    reason: string;
  }>;
};

export async function backfillProjectManagementIdentities({
  dryRun = true,
}: {
  dryRun?: boolean;
} = {}): Promise<ProjectManagementIdentityBackfillResult> {
  if (!dryRun && process.env.APPLY_PM_IDENTITY_BACKFILL !== "true") {
    throw new ProjectManagementIdentityError(
      "VALIDATION_ERROR",
      "执行项目管理身份初始化必须设置 APPLY_PM_IDENTITY_BACKFILL=true",
    );
  }

  const users = await prisma.user.findMany({
    select: {
      openId: true,
      unionId: true,
      name: true,
      avatar: true,
    },
    orderBy: { id: "asc" },
  });

  const result: ProjectManagementIdentityBackfillResult = {
    dryRun,
    totalUsers: users.length,
    alreadyExisting: 0,
    wouldCreate: 0,
    created: 0,
    conflicts: [],
  };
  const usersToApply: ProjectManagementIdentityInput[] = [];

  for (const user of users) {
    const subject = projectManagementFeishuProviderSubject(user);
    const identities = await prisma.accountIdentity.findMany({
      where: {
        provider: FEISHU_PROVIDER,
        tenantId: DEFAULT_TENANT_ID,
        OR: [
          { providerSubject: subject },
          { openId: user.openId },
          ...(user.unionId ? [{ unionId: user.unionId }] : []),
        ],
      },
      select: { accountId: true },
    });
    const accountIds = new Set(identities.map((identity) => identity.accountId));
    if (accountIds.size > 1) {
      result.conflicts.push({
        subjectHash: stableIdentityHash(subject),
        reason: "multiple_accounts_for_feishu_identity",
      });
      continue;
    }
    if (identities.length > 0) {
      result.alreadyExisting += 1;
      usersToApply.push(user);
      continue;
    }
    result.wouldCreate += 1;
    usersToApply.push(user);
  }

  if (dryRun) {
    return result;
  }

  if (result.conflicts.length > 0) {
    await recordBackfillIdentityConflictsAudit(result.conflicts);
    throw new ProjectManagementIdentityError(
      "IDENTITY_CONFLICT",
      "项目管理身份初始化存在冲突，已停止",
    );
  }

  for (const user of usersToApply) {
    const resolved = await resolveFeishuIdentityForUser(user);
    if (resolved.created) result.created += 1;
  }

  return result;
}

async function recordBackfillIdentityConflictsAudit(
  conflicts: ProjectManagementIdentityBackfillResult["conflicts"],
) {
  try {
    await prisma.$transaction((tx) =>
      createDomainAuditEventTx(tx, {
        action: "pm.identity.backfill_conflict",
        entityType: "AccountIdentityBackfill",
        entityId: "project-management-identity-backfill",
        after: {
          status: "ADMIN_REVIEW_REQUIRED",
          conflictCount: conflicts.length,
          conflicts,
        },
        reason: "项目管理身份初始化存在冲突，需管理员处理",
        source: "MIGRATION",
      }),
    );
  } catch (auditError) {
    logger.error("project_management.identity.backfill_conflict_audit.failed", {
      module: "project-management",
      action: "recordBackfillIdentityConflictsAudit",
      entityType: "AccountIdentityBackfill",
      entityId: "project-management-identity-backfill",
      result: "failure",
      error: auditError,
    });
  }
}
