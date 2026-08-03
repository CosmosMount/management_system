import type { Prisma } from "@prisma/client";
import { AccountsPanel } from "@/components/admin/accounts-panel";
import { prisma } from "@/lib/prisma";

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
  const query = firstParam(params.q).trim();
  const status = firstParam(params.status);
  const role = firstParam(params.role);
  const team = firstParam(params.team);
  const techGroup = firstParam(params.techGroup);
  const requestedPage = Number.parseInt(firstParam(params.page), 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const conditions: Prisma.AccountWhereInput[] = [];
  if (query) {
    conditions.push({
      OR: [
            { person: { displayName: { contains: query, mode: "insensitive" } } },
            {
              reimbursementUser: {
                name: { contains: query, mode: "insensitive" },
              },
            },
            {
              identities: {
                some: { openId: { contains: query, mode: "insensitive" } },
              },
            },
          ],
    });
  }
  if (status === "ACTIVE" || status === "DISABLED") {
    conditions.push({ projectAccessStatus: status });
  }
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

  const [accounts, total] = await Promise.all([
    prisma.account.findMany({
      where,
      orderBy: [
        { person: { displayName: "asc" } },
        { createdAt: "asc" },
      ],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        projectAccessStatus: true,
        lastLoginAt: true,
        createdAt: true,
        person: { select: { displayName: true, avatar: true } },
        identities: {
          where: { provider: "FEISHU", tenantId: "default" },
          orderBy: { createdAt: "asc" },
          select: { id: true, openId: true, unionId: true },
        },
        reimbursementUser: {
          select: { openId: true, name: true, email: true },
        },
        systemRoles: {
          orderBy: { createdAt: "desc" },
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
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            role: true,
            team: true,
            techGroup: true,
            createdAt: true,
            revokedAt: true,
          },
        },
      },
    }),
    prisma.account.count({ where }),
  ]);

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
  }

  return (
    <AccountsPanel
      accounts={accounts.map((account) => ({
        ...account,
        lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
        createdAt: account.createdAt.toISOString(),
        systemRoles: account.systemRoles.map((assignment) => ({
          ...assignment,
          createdAt: assignment.createdAt.toISOString(),
          revokedAt: assignment.revokedAt?.toISOString() ?? null,
        })),
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
      filters={{ query, status, role, team, techGroup }}
    />
  );
}
