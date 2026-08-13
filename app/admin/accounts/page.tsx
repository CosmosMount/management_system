import type { Prisma } from "@prisma/client";
import { AccountsPanel } from "@/components/admin/accounts-panel";
import {
  findRankedAdminAccountCandidates,
} from "@/lib/admin-account-search";
import { prisma } from "@/lib/prisma";
import { normalizeSearchText } from "@/lib/search/normalize-search-text";

const PAGE_SIZE = 30;
const projectRoleValues = [
  "SUPER_ADMINISTRATOR",
  "PROJECT_ADMINISTRATOR",
] as const;
const reimbursementRoleValues = [
  "TEAM_ADMIN",
  "TECH_GROUP_ADMIN",
  "TEACHER",
  "FINANCE",
] as const;

const accountRowSelect = {
  id: true,
  lastLoginAt: true,
  createdAt: true,
  person: { select: { displayName: true, avatar: true } },
  identities: {
    where: { provider: "FEISHU" as const, tenantId: "default" },
    orderBy: [
      { createdAt: "asc" as const },
      { id: "asc" as const },
    ],
    select: { id: true, openId: true, unionId: true },
  },
  reimbursementUser: {
    select: { openId: true, name: true, email: true },
  },
  systemRoles: {
    orderBy: { createdAt: "desc" as const },
    select: {
      id: true,
      role: true,
      team: true,
      techGroup: true,
      createdAt: true,
      revokedAt: true,
    },
  },
  reimbursementRoles: {
    orderBy: { createdAt: "desc" as const },
    select: {
      id: true,
      role: true,
      team: true,
      techGroup: true,
      createdAt: true,
      revokedAt: true,
    },
  },
} satisfies Prisma.AccountSelect;

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function AdminAccountsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const query = normalizeSearchText(firstParam(params.q));
  const role = firstParam(params.role);
  const team = firstParam(params.team);
  const techGroup = firstParam(params.techGroup);
  const requestedPage = Number.parseInt(firstParam(params.page), 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const conditions: Prisma.AccountWhereInput[] = [];
  if (projectRoleValues.includes(role as (typeof projectRoleValues)[number])) {
    conditions.push({
      systemRoles: {
        some: {
          role: role as (typeof projectRoleValues)[number],
          revokedAt: null,
        },
      },
    });
  } else if (
    reimbursementRoleValues.includes(
      role as (typeof reimbursementRoleValues)[number],
    )
  ) {
    conditions.push({
      reimbursementRoles: {
        some: {
          role: role as (typeof reimbursementRoleValues)[number],
          revokedAt: null,
        },
      },
    });
  } else if (role === "ORDINARY") {
    conditions.push({
      systemRoles: {
        none: { role: { in: [...projectRoleValues] }, revokedAt: null },
      },
    });
  }
  if (team) {
    conditions.push({
      OR: [
        { systemRoles: { some: { team, revokedAt: null } } },
        { reimbursementRoles: { some: { team, revokedAt: null } } },
      ],
    });
  }
  if (techGroup) {
    conditions.push({
      OR: [
        { systemRoles: { some: { techGroup, revokedAt: null } } },
        { reimbursementRoles: { some: { techGroup, revokedAt: null } } },
      ],
    });
  }
  const where: Prisma.AccountWhereInput =
    conditions.length > 0 ? { AND: conditions } : {};

  const responsibilitiesPromise = prisma.userRole.findMany({
    where: {
      revokedAt: null,
      role: { in: [...reimbursementRoleValues] },
      accountId: { not: null },
    },
    orderBy: [
      { team: "asc" },
      { techGroup: "asc" },
      { role: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
    select: {
      id: true,
      role: true,
      team: true,
      techGroup: true,
      account: {
        select: {
          id: true,
          person: { select: { displayName: true, avatar: true } },
          reimbursementUser: {
            select: { name: true, avatar: true, email: true },
          },
        },
      },
    },
  });

  let accounts: Prisma.AccountGetPayload<{ select: typeof accountRowSelect }>[];
  let total: number;
  let hasMoreByQuery = false;
  if (query) {
    const ranked = await findRankedAdminAccountCandidates({ where, query });
    total = ranked.items.length;
    hasMoreByQuery = ranked.hasMoreByQuery;
    const pageIds = ranked.items
      .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
      .map((item) => item.id);
    const rows = pageIds.length
      ? await prisma.account.findMany({
          where: { AND: [where, { id: { in: pageIds } }] },
          select: accountRowSelect,
        })
      : [];
    const byId = new Map(rows.map((account) => [account.id, account]));
    accounts = pageIds.flatMap((id) => {
      const account = byId.get(id);
      return account ? [account] : [];
    });
  } else {
    [accounts, total] = await Promise.all([
      prisma.account.findMany({
        where,
        orderBy: [{ person: { displayName: "asc" } }, { createdAt: "asc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: accountRowSelect,
      }),
      prisma.account.count({ where }),
    ]);
  }

  const entityAccountIds = new Map<string, string>();
  for (const account of accounts) {
    entityAccountIds.set(account.id, account.id);
    for (const assignment of account.systemRoles) {
      entityAccountIds.set(assignment.id, account.id);
    }
    for (const assignment of account.reimbursementRoles) {
      entityAccountIds.set(assignment.id, account.id);
    }
  }
  const securityAuditEvents = entityAccountIds.size
    ? await prisma.domainAuditEvent.findMany({
        where: {
          action: { startsWith: "account." },
          entityId: { in: [...entityAccountIds.keys()] },
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          action: true,
          entityId: true,
          source: true,
          before: true,
          createdAt: true,
          actorAccount: {
            select: { person: { select: { displayName: true } } },
          },
        },
      })
    : [];
  const auditsByAccount = new Map<
    string,
    Array<{
      id: string;
      action: string;
      source: string;
      operatorName: string;
      createdAt: string;
    }>
  >();
  const archivedProjectRolesByAccount = new Map<
    string,
    Array<{
      id: string;
      role: string;
      team: string;
      techGroup: string;
      createdAt: string;
      revokedAt: string;
    }>
  >();
  for (const event of securityAuditEvents) {
    const accountId = entityAccountIds.get(event.entityId);
    if (!accountId) continue;
    const existing = auditsByAccount.get(accountId) ?? [];
    existing.push({
      id: event.id,
      action: event.action,
      source: event.source,
      operatorName: event.actorAccount?.person?.displayName ?? "系统迁移",
      createdAt: event.createdAt.toISOString(),
    });
    auditsByAccount.set(accountId, existing);
    const archivedRole = archivedProjectRoleFromAudit(event);
    if (archivedRole) {
      const archived = archivedProjectRolesByAccount.get(accountId) ?? [];
      archived.push(archivedRole);
      archivedProjectRolesByAccount.set(accountId, archived);
    }
  }

  const responsibilities = (await responsibilitiesPromise).flatMap(
    (assignment) => {
      const account = assignment.account;
      const reimbursementUser = account?.reimbursementUser;
      if (!account || !reimbursementUser || assignment.role === "SUPER_ADMIN") {
        return [];
      }
      return [{
        id: assignment.id,
        role: assignment.role,
        team: assignment.team,
        techGroup: assignment.techGroup,
        account: {
          id: account.id,
          displayName:
            account.person?.displayName || reimbursementUser.name || "未知用户",
          avatar: account.person?.avatar ?? reimbursementUser.avatar,
          email: reimbursementUser.email,
        },
      }];
    },
  );
  // The client keeps successful matrix mutations visible while the RSC refresh
  // is in flight. Remount only after the authoritative responsibility snapshot
  // actually changes, so a stale refresh cannot erase the immediate feedback.
  const responsibilityViewVersion = JSON.stringify(responsibilities);

  return (
    <AccountsPanel
      key={responsibilityViewVersion}
      responsibilities={responsibilities}
      accounts={accounts.map((account) => ({
        ...account,
        lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
        createdAt: account.createdAt.toISOString(),
        systemRoles: account.systemRoles.map((assignment) => ({
          ...assignment,
          createdAt: assignment.createdAt.toISOString(),
          revokedAt: assignment.revokedAt?.toISOString() ?? null,
        })),
        archivedProjectRoles:
          archivedProjectRolesByAccount.get(account.id) ?? [],
        reimbursementRoles: account.reimbursementRoles.map((assignment) => ({
          ...assignment,
          createdAt: assignment.createdAt.toISOString(),
          revokedAt: assignment.revokedAt?.toISOString() ?? null,
        })),
        securityAuditEvents: auditsByAccount.get(account.id) ?? [],
      }))}
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      hasMoreByQuery={hasMoreByQuery}
      filters={{ query, role, team, techGroup }}
    />
  );
}

function archivedProjectRoleFromAudit(event: {
  id: string;
  action: string;
  before: Prisma.JsonValue | null;
}) {
  if (
    event.action !== "account.legacy_project_role.archived" ||
    !event.before ||
    typeof event.before !== "object" ||
    Array.isArray(event.before)
  ) {
    return null;
  }
  const before = event.before as Record<string, Prisma.JsonValue>;
  if (
    typeof before.assignmentId !== "string" ||
    typeof before.role !== "string" ||
    typeof before.team !== "string" ||
    typeof before.techGroup !== "string" ||
    typeof before.createdAt !== "string" ||
    typeof before.revokedAt !== "string"
  ) {
    return null;
  }
  return {
    id: event.id,
    role: before.role,
    team: before.team,
    techGroup: before.techGroup,
    createdAt: before.createdAt,
    revokedAt: before.revokedAt,
  };
}
