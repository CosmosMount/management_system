import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";
import {
  normalizeSearchText,
  searchTerms,
} from "@/lib/search/normalize-search-text";

export const ADMIN_ACCOUNT_SEARCH_CANDIDATE_LIMIT = 501;

export const adminAccountSearchCandidateSelect = {
  id: true,
  createdAt: true,
  person: { select: { displayName: true, avatar: true } },
  identities: {
    where: { provider: "FEISHU" as const, tenantId: "default" },
    orderBy: [
      { createdAt: "asc" as const },
      { id: "asc" as const },
    ],
    select: { openId: true, unionId: true },
  },
  reimbursementUser: {
    select: { name: true, email: true, openId: true, avatar: true },
  },
} satisfies Prisma.AccountSelect;

export type AdminAccountSearchCandidate = Prisma.AccountGetPayload<{
  select: typeof adminAccountSearchCandidateSelect;
}>;

export async function findRankedAdminAccountCandidates({
  where,
  query,
}: {
  where: Prisma.AccountWhereInput;
  query: string;
}) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return { items: [], hasMoreByQuery: false };

  const directSearchConditions = searchTerms(normalizedQuery).map(
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
    where: { AND: [where, ...directSearchConditions] },
    orderBy: [{ person: { displayName: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
    take: ADMIN_ACCOUNT_SEARCH_CANDIDATE_LIMIT,
    select: adminAccountSearchCandidateSelect,
  });
  const fallbackCandidates =
    directCandidates.length < 50
      ? await prisma.account.findMany({
          where,
          orderBy: [
            { person: { displayName: "asc" } },
            { createdAt: "asc" },
            { id: "asc" },
          ],
          take: ADMIN_ACCOUNT_SEARCH_CANDIDATE_LIMIT,
          select: adminAccountSearchCandidateSelect,
        })
      : [];
  const candidates = [
    ...new Map(
      [...directCandidates, ...fallbackCandidates].map((account) => [
        account.id,
        account,
      ]),
    ).values(),
  ];
  const ranked = rankFuzzyMatches(
    candidates,
    normalizedQuery,
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
    compareAdminAccountCandidates,
  );

  return {
    items: ranked.map(({ item }) => item),
    hasMoreByQuery:
      directCandidates.length === ADMIN_ACCOUNT_SEARCH_CANDIDATE_LIMIT ||
      fallbackCandidates.length === ADMIN_ACCOUNT_SEARCH_CANDIDATE_LIMIT,
  };
}

export function compareAdminAccountCandidates(
  left: AdminAccountSearchCandidate,
  right: AdminAccountSearchCandidate,
) {
  return (
    adminAccountDisplayName(left).localeCompare(
      adminAccountDisplayName(right),
      "zh-CN",
    ) || left.id.localeCompare(right.id)
  );
}

export function adminAccountDisplayName(account: {
  person: { displayName: string } | null;
  reimbursementUser: { name: string } | null;
}) {
  return account.person?.displayName || account.reimbursementUser?.name || "未知用户";
}
