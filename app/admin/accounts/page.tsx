import type { Prisma } from "@prisma/client";
import { AccountsPanel } from "@/components/admin/accounts-panel";
import { prisma } from "@/lib/prisma";
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";
import {
  normalizeSearchText,
  searchTerms,
} from "@/lib/search/normalize-search-text";

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
    orderBy: { createdAt: "asc" as const },
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

  let accounts: Prisma.AccountGetPayload<{ select: typeof accountRowSelect }>[];
  let total: number;
  let hasMoreByQuery = false;
  if (query) {
    const candidateSelect = {
      id: true,
      person: { select: { displayName: true } },
      identities: {
        where: { provider: "FEISHU" as const, tenantId: "default" },
        select: { openId: true, unionId: true },
      },
      reimbursementUser: {
        select: { name: true, email: true, openId: true },
      },
    } satisfies Prisma.AccountSelect;
    const directSearchConditions = searchTerms(query).map(
      (term): Prisma.AccountWhereInput => ({
        OR: [
          { person: { displayName: { contains: term, mode: "insensitive" } } },
          { reimbursementUser: { name: { contains: term, mode: "insensitive" } } },
          { reimbursementUser: { email: { contains: term, mode: "insensitive" } } },
          { reimbursementUser: { openId: { contains: term, mode: "insensitive" } } },
          {
            identities: {
              some: {
                provider: "FEISHU",
                tenantId: "default",
                openId: { contains: term, mode: "insensitive" },
              },
            },
          },
          {
            identities: {
              some: {
                provider: "FEISHU",
                tenantId: "default",
                unionId: { contains: term, mode: "insensitive" },
              },
            },
          },
        ],
      }),
    );
    const directCandidates = await prisma.account.findMany({
      where: {
        AND: [where, ...directSearchConditions],
      },
      orderBy: [{ person: { displayName: "asc" } }, { createdAt: "asc" }],
      take: 501,
      select: candidateSelect,
    });
    const fallbackCandidates = directCandidates.length < 50
      ? await prisma.account.findMany({
          where,
          orderBy: [{ person: { displayName: "asc" } }, { createdAt: "asc" }],
          take: 501,
          select: candidateSelect,
        })
      : [];
    const candidates = [...new Map(
      [...directCandidates, ...fallbackCandidates].map((account) => [account.id, account]),
    ).values()];
    const ranked = rankFuzzyMatches(
      candidates,
      query,
      (account) => [
        { text: account.person?.displayName ?? "", weight: 2, pinyin: true },
        { text: account.reimbursementUser?.name ?? "", weight: 2, pinyin: true },
        ...account.identities.flatMap((identity) => [
          { text: identity.openId ?? "" },
          { text: identity.unionId ?? "" },
        ]),
        { text: account.reimbursementUser?.openId ?? "" },
        { text: account.reimbursementUser?.email ?? "" },
      ],
      (left, right) => {
        const leftName = left.person?.displayName ?? left.reimbursementUser?.name ?? "";
        const rightName = right.person?.displayName ?? right.reimbursementUser?.name ?? "";
        return (
          leftName.localeCompare(rightName, "zh-CN") ||
          left.id.localeCompare(right.id)
        );
      },
    );
    total = ranked.length;
    hasMoreByQuery =
      directCandidates.length === 501 || fallbackCandidates.length === 501;
    const pageIds = ranked
      .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
      .map(({ item }) => item.id);
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
      hasMoreByQuery={hasMoreByQuery}
      filters={{ query, role, team, techGroup }}
    />
  );
}
