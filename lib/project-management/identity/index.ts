import { createHash } from "node:crypto";
import type {
  Account,
  AccountIdentity,
  Person,
  ProjectManagementSystemRole,
  User,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";

const FEISHU_PROVIDER = "FEISHU";
const DEFAULT_TENANT_ID = "default";

export type ProjectManagementIdentityInput = {
  openId: string;
  unionId?: string | null;
  name?: string | null;
  avatar?: string | null;
};

export type ProjectManagementActor = {
  accountId: string;
  personId: string;
  openId: string;
  unionId?: string | null;
  systemRoles: ProjectManagementSystemRoleRecord[];
};

export type ProjectManagementSystemRoleRecord = {
  role: ProjectManagementSystemRole;
  team: string;
  techGroup: string;
};

export type ResolvedProjectManagementIdentity = {
  account: Account;
  identity: AccountIdentity;
  person: Person;
  reimbursementUser: User;
  created: boolean;
  reimbursementUserCreated: boolean;
};

export class ProjectManagementIdentityError extends Error {
  constructor(
    readonly code:
      | "UNAUTHENTICATED"
      | "IDENTITY_CONFLICT"
      | "ACCOUNT_DISABLED"
      | "VALIDATION_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "ProjectManagementIdentityError";
  }
}

type PrismaClientLike = Prisma.TransactionClient | typeof prisma;

export async function assertProjectAccessActiveTx(
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<void> {
  const account = await tx.account.findUnique({
    where: { id: accountId },
    select: { projectAccessStatus: true },
  });
  if (!account || account.projectAccessStatus !== "ACTIVE") {
    throw new ProjectManagementIdentityError(
      "ACCOUNT_DISABLED",
      "账号已禁用，无法访问项目管理",
    );
  }
}

type IdentityWithAccount = AccountIdentity & {
  account: Account & { person: Person | null };
};

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function projectManagementFeishuProviderSubject(input: {
  openId: string;
  unionId?: string | null;
}): string {
  const openId = normalizeOptional(input.openId);
  if (!openId) {
    throw new ProjectManagementIdentityError(
      "VALIDATION_ERROR",
      "飞书 openId 不能为空",
    );
  }
  const unionId = normalizeOptional(input.unionId);
  return unionId ?? `open:${openId}`;
}

function identityMetadata(input: { unionId?: string | null }) {
  return {
    source: "feishu",
    subjectKind: normalizeOptional(input.unionId) ? "unionId" : "openId",
  };
}

export async function resolveFeishuIdentityForUser(
  input: ProjectManagementIdentityInput,
): Promise<ResolvedProjectManagementIdentity> {
  try {
    return await prisma.$transaction((tx) =>
      resolveFeishuIdentityForUserTx(tx, input),
    );
  } catch (error) {
    if (
      error instanceof ProjectManagementIdentityError &&
      error.code === "IDENTITY_CONFLICT"
    ) {
      await recordIdentityConflictAudit(input, error.message);
    }
    throw error;
  }
}

export async function resolveFeishuIdentityForUserTx(
  tx: Prisma.TransactionClient,
  input: ProjectManagementIdentityInput,
): Promise<ResolvedProjectManagementIdentity> {
  const openId = normalizeOptional(input.openId);
  if (!openId) {
    throw new ProjectManagementIdentityError(
      "VALIDATION_ERROR",
      "飞书 openId 不能为空",
    );
  }
  const unionId = normalizeOptional(input.unionId);
  const requestedProviderSubject = projectManagementFeishuProviderSubject({
    openId,
    unionId,
  });
  const displayName = normalizeOptional(input.name) ?? "未知用户";
  const avatar = normalizeOptional(input.avatar);

  const [subjectIdentity, openIdentity, unionIdentity, openUser, unionUser] =
    await Promise.all([
    findIdentity(tx, { providerSubject: requestedProviderSubject }),
    findIdentity(tx, { openId }),
    unionId ? findIdentity(tx, { unionId }) : Promise.resolve(null),
    tx.user.findUnique({ where: { openId } }),
    unionId ? tx.user.findUnique({ where: { unionId } }) : Promise.resolve(null),
  ]);
  const identities = [subjectIdentity, openIdentity, unionIdentity].filter(
    (identity): identity is IdentityWithAccount => identity !== null,
  );
  const candidateUsers = [openUser, unionUser].filter(
    (user): user is User => user !== null,
  );
  const candidateUserIds = new Set(candidateUsers.map((user) => user.id));
  if (candidateUserIds.size > 1) {
    throw new ProjectManagementIdentityError(
      "IDENTITY_CONFLICT",
      "飞书报销用户身份存在冲突，请联系管理员处理",
    );
  }
  const accountIds = new Set([
    ...identities.map((identity) => identity.accountId),
    ...candidateUsers.flatMap((user) =>
      user.accountId ? [user.accountId] : [],
    ),
  ]);
  if (accountIds.size > 1) {
    throw new ProjectManagementIdentityError(
      "IDENTITY_CONFLICT",
      "飞书身份已关联多个项目管理账号，请联系管理员处理",
    );
  }
  const identityIds = new Set(identities.map((identity) => identity.id));
  if (identityIds.size > 1) {
    throw new ProjectManagementIdentityError(
      "IDENTITY_CONFLICT",
      "飞书身份存在重复映射，请联系管理员处理",
    );
  }

  const existing = subjectIdentity ?? unionIdentity ?? openIdentity;
  if (existing) {
    const effectiveUnionId = unionId ?? existing.unionId;
    const providerSubject = projectManagementFeishuProviderSubject({
      openId,
      unionId: effectiveUnionId,
    });
    const identity = await tx.accountIdentity.update({
      where: { id: existing.id },
      data: {
        providerSubject,
        openId,
        unionId: effectiveUnionId,
        metadata: identityMetadata({ unionId: effectiveUnionId }),
      },
      include: { account: { include: { person: true } } },
    });
    const account = await tx.account.update({
      where: { id: identity.accountId },
      data: { lastLoginAt: new Date() },
    });
    const person =
      identity.account.person ??
      (await tx.person.create({
        data: {
          accountId: identity.accountId,
          displayName,
          avatar,
          status: "ACTIVE",
        },
      }));

    if (
      person.displayName !== displayName ||
      (person.avatar ?? null) !== avatar
    ) {
      await tx.person.update({
        where: { id: person.id },
        data: { displayName, avatar },
      });
    }

    const reimbursementUser = await reconcileReimbursementUserTx(tx, {
      accountId: account.id,
      openId,
      unionId: effectiveUnionId,
      displayName,
      avatar,
    });
    return {
      account,
      identity,
      person: { ...person, displayName, avatar },
      reimbursementUser: reimbursementUser.user,
      created: false,
      reimbursementUserCreated: reimbursementUser.created,
    };
  }

  const existingAccountId = [...accountIds][0];
  const account = existingAccountId
    ? await tx.account.update({
        where: { id: existingAccountId },
        data: { lastLoginAt: new Date() },
      })
    : await tx.account.create({
        data: {
          projectAccessStatus: "ACTIVE",
          lastLoginAt: new Date(),
        },
      });
  const identity = await tx.accountIdentity.create({
    data: {
      accountId: account.id,
      provider: FEISHU_PROVIDER,
      providerSubject: requestedProviderSubject,
      tenantId: DEFAULT_TENANT_ID,
      openId,
      unionId,
      metadata: identityMetadata({ unionId }),
    },
  });
  const existingPerson = await tx.person.findUnique({
    where: { accountId: account.id },
  });
  const person = existingPerson
    ? await tx.person.update({
        where: { id: existingPerson.id },
        data: { displayName, avatar },
      })
    : await tx.person.create({
        data: {
          accountId: account.id,
          displayName,
          avatar,
          status: "ACTIVE",
        },
      });
  const reimbursementUser = await reconcileReimbursementUserTx(tx, {
    accountId: account.id,
    openId,
    unionId,
    displayName,
    avatar,
  });
  if (!identity || !person) {
    throw new ProjectManagementIdentityError(
      "IDENTITY_CONFLICT",
      "项目管理身份初始化失败，请联系管理员处理",
    );
  }
  return {
    account,
    identity,
    person,
    reimbursementUser: reimbursementUser.user,
    created: true,
    reimbursementUserCreated: reimbursementUser.created,
  };
}

async function reconcileReimbursementUserTx(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string;
    openId: string;
    unionId: string | null;
    displayName: string;
    avatar: string | null;
  },
): Promise<{ user: User; created: boolean }> {
  const [accountUser, openUser, unionUser] = await Promise.all([
    tx.user.findUnique({ where: { accountId: input.accountId } }),
    tx.user.findUnique({ where: { openId: input.openId } }),
    input.unionId
      ? tx.user.findUnique({ where: { unionId: input.unionId } })
      : Promise.resolve(null),
  ]);
  const candidates = [accountUser, unionUser, openUser].filter(
    (user): user is User => user !== null,
  );
  const userIds = new Set(candidates.map((user) => user.id));
  if (
    userIds.size > 1 ||
    candidates.some(
      (user) => user.accountId && user.accountId !== input.accountId,
    )
  ) {
    throw new ProjectManagementIdentityError(
      "IDENTITY_CONFLICT",
      "飞书身份与报销用户关联冲突，请联系管理员处理",
    );
  }
  const existing = accountUser ?? unionUser ?? openUser;
  if (existing) {
    return {
      user: await tx.user.update({
        where: { id: existing.id },
        data: {
          accountId: input.accountId,
          openId: input.openId,
          unionId: input.unionId ?? undefined,
          name: input.displayName,
          avatar: input.avatar,
        },
      }),
      created: false,
    };
  }
  return {
    user: await tx.user.create({
      data: {
        accountId: input.accountId,
        openId: input.openId,
        unionId: input.unionId,
        name: input.displayName,
        avatar: input.avatar,
      },
    }),
    created: true,
  };
}

async function findIdentity(
  client: PrismaClientLike,
  where:
    | { providerSubject: string }
    | { openId: string }
    | { unionId: string },
): Promise<IdentityWithAccount | null> {
  return client.accountIdentity.findFirst({
    where: {
      provider: FEISHU_PROVIDER,
      tenantId: DEFAULT_TENANT_ID,
      ...where,
    },
    include: { account: { include: { person: true } } },
  });
}

export async function getCurrentProjectManagementActor(): Promise<ProjectManagementActor> {
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  if (!session?.user?.openId) {
    throw new ProjectManagementIdentityError(
      "UNAUTHENTICATED",
      "请重新登录",
    );
  }
  return getProjectManagementActorForFeishuUser({
    openId: session.user.openId,
    unionId: session.user.unionId,
    name: session.user.name,
    avatar: session.user.image,
  });
}

export async function getProjectManagementActorForFeishuUser(
  input: ProjectManagementIdentityInput,
): Promise<ProjectManagementActor> {
  const resolved = await resolveFeishuIdentityForUser(input);
  if (resolved.account.projectAccessStatus !== "ACTIVE") {
    throw new ProjectManagementIdentityError(
      "ACCOUNT_DISABLED",
      "账号已禁用，无法访问项目管理",
    );
  }
  const systemRoles = await prisma.systemRoleAssignment.findMany({
    where: {
      accountId: resolved.account.id,
      revokedAt: null,
    },
    select: {
      role: true,
      team: true,
      techGroup: true,
    },
  });
  return {
    accountId: resolved.account.id,
    personId: resolved.person.id,
    openId: input.openId,
    unionId: input.unionId,
    systemRoles,
  };
}

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

function stableIdentityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function recordIdentityConflictAudit(
  input: ProjectManagementIdentityInput,
  reason: string,
) {
  const openId = normalizeOptional(input.openId);
  const unionId = normalizeOptional(input.unionId);
  if (!openId) return;
  const providerSubject = projectManagementFeishuProviderSubject({
    openId,
    unionId,
  });
  const subjectHash = stableIdentityHash(
    `${FEISHU_PROVIDER}:${DEFAULT_TENANT_ID}:${providerSubject}`,
  );

  try {
    await prisma.$transaction((tx) =>
      createDomainAuditEventTx(tx, {
        action: "pm.identity.conflict",
        entityType: "AccountIdentity",
        entityId: subjectHash,
        before: {
          provider: FEISHU_PROVIDER,
          tenantId: DEFAULT_TENANT_ID,
          subjectHash,
          openIdHash: stableIdentityHash(openId),
          unionIdHash: unionId ? stableIdentityHash(unionId) : null,
        },
        after: { status: "ADMIN_REVIEW_REQUIRED" },
        reason,
        source: "SYSTEM",
      }),
    );
  } catch (auditError) {
    logger.error("project_management.identity.conflict_audit.failed", {
      module: "project-management",
      action: "recordIdentityConflictAudit",
      entityType: "AccountIdentity",
      entityId: subjectHash,
      result: "failure",
      error: auditError,
    });
  }
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
