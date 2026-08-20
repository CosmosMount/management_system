import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  adminAccountDisplayName,
  adminAccountSearchCandidateSelect,
  findRankedAdminAccountCandidates,
  type AdminAccountSearchCandidate,
} from "@/lib/admin-account-search";
import { prisma } from "@/lib/prisma";
import { normalizeSearchText } from "@/lib/search/normalize-search-text";

export type AdminAccountOptionPurpose = "ALL" | "REIMBURSEMENT";

export type AdminAccountOptionRecord = {
  id: string;
  displayName: string;
  avatar: string | null;
  openId: string | null;
  email: string | null;
  reimbursementReady: boolean;
};

type AccountOptionCursor = {
  v: 1;
  purpose: AdminAccountOptionPurpose;
  id: string;
};

const accountOptionCursorSchema = z
  .object({
    v: z.literal(1),
    purpose: z.enum(["ALL", "REIMBURSEMENT"]),
    id: z.string().uuid(),
  })
  .strict();

export async function searchAdminAccountOptionPage(input: {
  purpose: AdminAccountOptionPurpose;
  query: string;
  cursor?: string;
  limit: number;
}) {
  const where = accountOptionWhere(input.purpose);
  const query = normalizeSearchText(input.query);
  if (query) {
    if (input.cursor) throw new Error("关键词搜索不支持分页，请继续缩小范围");
    const result = await findRankedAdminAccountCandidates({ where, query });
    return {
      items: result.items.slice(0, input.limit).map(accountOption),
      nextCursor: null,
      hasMoreByQuery:
        result.hasMoreByQuery || result.items.length > input.limit,
    };
  }

  const cursorId = await parseAndValidateCursor(
    input.cursor,
    input.purpose,
    where,
  );
  const rows = await prisma.account.findMany({
    where,
    select: adminAccountSearchCandidateSelect,
    orderBy: [
      { person: { displayName: "asc" } },
      { createdAt: "asc" },
      { id: "asc" },
    ],
    take: input.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const items = rows.slice(0, input.limit);
  return {
    items: items.map(accountOption),
    nextCursor:
      rows.length > input.limit && items.at(-1)
        ? encodeCursor({ v: 1, purpose: input.purpose, id: items.at(-1)!.id })
        : null,
    hasMoreByQuery: false,
  };
}

export async function resolveAdminAccountOptionRecords(input: {
  purpose: AdminAccountOptionPurpose;
  ids: string[];
}) {
  if (input.ids.length === 0) return [];
  const rows = await prisma.account.findMany({
    where: {
      AND: [accountOptionWhere(input.purpose), { id: { in: input.ids } }],
    },
    select: adminAccountSearchCandidateSelect,
  });
  const byId = new Map(rows.map((row) => [row.id, accountOption(row)]));
  return input.ids.flatMap((id) => {
    const option = byId.get(id);
    return option ? [option] : [];
  });
}

function accountOptionWhere(
  purpose: AdminAccountOptionPurpose,
): Prisma.AccountWhereInput {
  const activePerson: Prisma.AccountWhereInput = {
    person: { is: { status: "ACTIVE" } },
  };
  return purpose === "REIMBURSEMENT"
    ? { AND: [activePerson, { reimbursementUser: { isNot: null } }] }
    : activePerson;
}

function accountOption(
  account: AdminAccountSearchCandidate,
): AdminAccountOptionRecord {
  const identity = account.identities[0];
  return {
    id: account.id,
    displayName: adminAccountDisplayName(account),
    avatar: account.person?.avatar ?? account.reimbursementUser?.avatar ?? null,
    openId: identity?.openId ?? account.reimbursementUser?.openId ?? null,
    email: account.reimbursementUser?.email ?? null,
    reimbursementReady: account.reimbursementUser !== null,
  };
}

async function parseAndValidateCursor(
  value: string | undefined,
  purpose: AdminAccountOptionPurpose,
  where: Prisma.AccountWhereInput,
) {
  if (!value) return undefined;
  let cursor: AccountOptionCursor;
  try {
    cursor = accountOptionCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new Error("分页参数无效");
  }
  if (cursor.purpose !== purpose) throw new Error("分页参数无效");
  const exists = await prisma.account.findFirst({
    where: { AND: [where, { id: cursor.id }] },
    select: { id: true },
  });
  if (!exists) throw new Error("分页参数已失效，请重新打开选择器");
  return cursor.id;
}

function encodeCursor(cursor: AccountOptionCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
