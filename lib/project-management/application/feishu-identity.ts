import type { Prisma } from "@prisma/client";

export const DEFAULT_FEISHU_IDENTITY_WHERE = {
  provider: "FEISHU",
  tenantId: "default",
} satisfies Prisma.AccountIdentityWhereInput;

export const FEISHU_OPEN_IDENTITY_SELECT = {
  id: true,
  openId: true,
} satisfies Prisma.AccountIdentitySelect;

export const FEISHU_OPEN_IDENTITY_ORDER = [
  { createdAt: "asc" },
  { id: "asc" },
] satisfies Prisma.AccountIdentityOrderByWithRelationInput[];

export function firstNonEmptyFeishuOpenId(
  identities: Array<{ openId: string | null }>,
): string | null {
  return (
    identities
      .map((identity) => identity.openId?.trim() ?? "")
      .find(Boolean) ?? null
  );
}
