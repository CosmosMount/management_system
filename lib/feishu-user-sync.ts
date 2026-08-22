import { createHash } from "node:crypto";
import {
  fetchAllFeishuContactUsers,
  type FeishuContactUser,
} from "@/lib/feishu-contact";
import type { Prisma } from "@prisma/client";
import { lockFeishuContactSyncTx } from "@/lib/active-account";
import { prisma } from "@/lib/prisma";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { lockGlobalApprovalAdministratorSetTx } from "@/lib/project-management/approval-administrators";
import {
  ProjectManagementIdentityError,
  recordIdentityConflictAudit,
  resolveFeishuIdentityForUserTx,
} from "@/lib/project-management/identity";

const FEISHU_SYNC_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 15 * 60_000,
} as const;
const SNAPSHOT_DROP_GUARD_MINIMUM_ACCOUNTS = 10;
const SNAPSHOT_DROP_GUARD_MAX_RATIO = 0.3;

export type SyncFeishuUsersResult = {
  total: number;
  created: number;
  updated: number;
  deactivated: number;
  reactivated: number;
};

export class FeishuContactSyncConfirmationRequiredError extends Error {
  readonly code = "SNAPSHOT_DROP_CONFIRMATION_REQUIRED";

  constructor(
    readonly confirmationToken: string,
    readonly deactivateCount: number,
    readonly activeAccountCount: number,
  ) {
    super(
      `通讯录在职人数异常下降（将停用 ${deactivateCount}/${activeAccountCount} 人），请确认飞书授权范围完整后再次确认同步`,
    );
    this.name = "FeishuContactSyncConfirmationRequiredError";
  }
}

type ReconcileFeishuContactUsersOptions = {
  snapshotDropConfirmationToken?: string;
  confirmedByAccountId?: string;
  requestedByAccountId?: string;
};

export async function reconcileFeishuContactUsers(
  contacts: FeishuContactUser[],
  options: ReconcileFeishuContactUsersOptions = {},
): Promise<SyncFeishuUsersResult> {
  const activeContacts = contacts.filter((contact) => contact.isActive);
  if (activeContacts.some((contact) => !contact.openId.trim())) {
    throw new Error("飞书通讯录返回了缺少 openId 的在职成员，已停止同步");
  }
  if (activeContacts.length === 0) {
    throw new Error("飞书通讯录未返回任何用户，请检查应用通讯录权限范围");
  }

  let resolvingContact: FeishuContactUser | null = null;
  try {
    return await prisma.$transaction(
      (tx) =>
        reconcileFeishuContactUsersTx(tx, activeContacts, {
          ...options,
          onIdentityResolution: (contact) => {
            resolvingContact = contact;
          },
        }),
      FEISHU_SYNC_TRANSACTION_OPTIONS,
    );
  } catch (error) {
    if (
      resolvingContact &&
      error instanceof ProjectManagementIdentityError &&
      error.code === "IDENTITY_CONFLICT"
    ) {
      await recordIdentityConflictAudit(resolvingContact, error.message);
    }
    throw error;
  }
}

export async function reconcileFeishuContactUsersTx(
  tx: Prisma.TransactionClient,
  activeContacts: FeishuContactUser[],
  options: {
    onIdentityResolution?: (contact: FeishuContactUser) => void;
  } & ReconcileFeishuContactUsersOptions = {},
): Promise<SyncFeishuUsersResult> {
  if (
    activeContacts.length === 0 ||
    activeContacts.some((contact) => !contact.isActive)
  ) {
    throw new Error("同步事务只能接收非空的在职成员快照");
  }

  await lockFeishuContactSyncTx(tx);
  await lockGlobalApprovalAdministratorSetTx(tx);
  if (options.requestedByAccountId) {
    await assertActiveSuperAdministratorTx(
      tx,
      options.requestedByAccountId,
      "同步操作人已失去超级管理员权限，请重新发起同步",
    );
  }

  const previouslyActiveLinkedAccounts = await tx.account.findMany({
    where: {
      identities: {
        some: { provider: "FEISHU", tenantId: "default" },
      },
      person: { is: { status: "ACTIVE" } },
    },
    select: {
      id: true,
      person: { select: { id: true, status: true } },
    },
  });
  const activeLinkedAccountCount = previouslyActiveLinkedAccounts.length;
  let created = 0;
  let updated = 0;
  let reactivated = 0;
  const activeAccountIds = new Set<string>();

  for (const contact of activeContacts) {
      options.onIdentityResolution?.(contact);
      const identity = await resolveFeishuIdentityForUserTx(tx, {
        openId: contact.openId,
        unionId: contact.unionId,
        name: contact.name,
        avatar: contact.avatar,
      });
      activeAccountIds.add(identity.account.id);
      if (identity.reimbursementUserCreated) created++;
      else updated++;

      if (identity.person.status === "INACTIVE") {
        await tx.person.update({
          where: { id: identity.person.id },
          data: { status: "ACTIVE" },
        });
        reactivated++;
        await createDomainAuditEventTx(tx, {
          action: "person.feishu_contact_reactivated",
          entityType: "Person",
          entityId: identity.person.id,
          before: { status: "INACTIVE" },
          after: { status: "ACTIVE" },
          reason: "飞书通讯录全量同步确认成员仍在职",
          source: "SYSTEM",
        });
      }
  }

  const toDeactivate = previouslyActiveLinkedAccounts.filter(
    (account) => !activeAccountIds.has(account.id),
  );

  if (
    activeLinkedAccountCount >= SNAPSHOT_DROP_GUARD_MINIMUM_ACCOUNTS &&
    toDeactivate.length / activeLinkedAccountCount >
      SNAPSHOT_DROP_GUARD_MAX_RATIO
  ) {
    const confirmationToken = createSnapshotDropConfirmationToken(
      activeContacts,
      toDeactivate.map((account) => account.id),
      activeLinkedAccountCount,
    );
    if (
      options.snapshotDropConfirmationToken !== confirmationToken ||
      !options.confirmedByAccountId
    ) {
      throw new FeishuContactSyncConfirmationRequiredError(
        confirmationToken,
        toDeactivate.length,
        activeLinkedAccountCount,
      );
    }
    await assertActiveSuperAdministratorTx(
      tx,
      options.confirmedByAccountId,
      "确认操作人已失去超级管理员权限，请重新发起同步",
    );
    await createDomainAuditEventTx(tx, {
      actorAccountId: options.confirmedByAccountId,
      action: "person.feishu_contact_snapshot_drop_confirmed",
      entityType: "FeishuContactSync",
      entityId: confirmationToken,
      before: {
        activeAccountCount: activeLinkedAccountCount,
      },
      after: {
        activeSnapshotCount: activeAccountIds.size,
        deactivateCount: toDeactivate.length,
        deactivateRatio:
          toDeactivate.length / activeLinkedAccountCount,
      },
      reason: "管理员确认通讯录授权范围完整并继续高比例停用同步",
      source: "WEB",
    });
  }

  if (toDeactivate.length > 0) {
      const currentGlobalAdministratorCount =
        await tx.systemRoleAssignment.count({
          where: {
            role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] },
            team: "",
            techGroup: "",
            revokedAt: null,
          },
        });
      if (currentGlobalAdministratorCount > 0) {
        const remainingGlobalAdministratorCount =
          await tx.systemRoleAssignment.count({
            where: {
              accountId: { in: [...activeAccountIds] },
              role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] },
              team: "",
              techGroup: "",
              revokedAt: null,
            },
          });
        if (remainingGlobalAdministratorCount === 0) {
          throw new Error(
            "通讯录结果中没有在职的全局管理员，请先确认应用权限范围或移交管理员角色",
          );
        }
      }
  }

  for (const account of toDeactivate) {
      if (!account.person) continue;
      await tx.person.update({
        where: { id: account.person.id },
        data: { status: "INACTIVE" },
      });
      await createDomainAuditEventTx(tx, {
        action: "person.feishu_contact_deactivated",
        entityType: "Person",
        entityId: account.person.id,
        before: { status: "ACTIVE" },
        after: { status: "INACTIVE" },
        reason: "成员已不在飞书在职通讯录快照中",
        source: "SYSTEM",
      });
  }

  return {
    total: activeContacts.length,
    created,
    updated,
    deactivated: toDeactivate.length,
    reactivated,
  };
}

async function assertActiveSuperAdministratorTx(
  tx: Prisma.TransactionClient,
  accountId: string,
  errorMessage: string,
) {
  const people = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status"::text AS "status"
    FROM "Person"
    WHERE "accountId" = ${accountId}
    FOR UPDATE
  `;
  const assignment = await tx.systemRoleAssignment.findFirst({
    where: {
      accountId,
      role: "SUPER_ADMINISTRATOR",
      team: "",
      techGroup: "",
      revokedAt: null,
    },
    select: { id: true },
  });
  if (people.length !== 1 || people[0]?.status !== "ACTIVE" || !assignment) {
    throw new Error(errorMessage);
  }
}

export async function syncFeishuContactUsers(
  options: ReconcileFeishuContactUsersOptions = {},
): Promise<SyncFeishuUsersResult> {
  const snapshot = await fetchAllFeishuContactUsers();
  if (
    !snapshot.includesRootDepartment ||
    snapshot.departmentCount === 0
  ) {
    throw new Error("飞书通讯录快照未通过完整性校验，已停止同步");
  }
  return reconcileFeishuContactUsers(snapshot.contacts, options);
}

function createSnapshotDropConfirmationToken(
  activeContacts: FeishuContactUser[],
  deactivateAccountIds: string[],
  activeLinkedAccountCount: number,
): string {
  const activeContactIdentities = [
    ...new Set(
      activeContacts.map((contact) => {
        const unionId = contact.unionId?.trim();
        return unionId
          ? `union:${unionId}`
          : `open:${contact.openId.trim()}`;
      }),
    ),
  ].sort();

  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        activeContactIdentities,
        deactivateAccountIds: [...deactivateAccountIds].sort(),
        activeLinkedAccountCount,
      }),
    )
    .digest("hex");
}
