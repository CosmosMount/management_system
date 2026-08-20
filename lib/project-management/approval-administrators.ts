import type { Prisma } from "@prisma/client";

type PrismaTx = Prisma.TransactionClient;

const GLOBAL_APPROVAL_ADMINISTRATOR_LOCK = 2_026_080_301;

export const ACTIVE_GLOBAL_APPROVAL_ADMINISTRATOR_REQUIRED =
  "至少保留一名全局管理员";
export const USABLE_GLOBAL_APPROVAL_ADMINISTRATOR_REQUIRED =
  "至少保留一名具有有效飞书身份的全局管理员";

export async function lockGlobalApprovalAdministratorSetTx(tx: PrismaTx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${GLOBAL_APPROVAL_ADMINISTRATOR_LOCK})`;
}

export async function activeGlobalApprovalAdministratorAccountIdsTx(
  tx: PrismaTx,
  input: {
    excludeAssignmentId?: string;
    excludeAccountId?: string;
    requireFeishuOpenId?: boolean;
  } = {},
) {
  const assignments = await tx.systemRoleAssignment.findMany({
    where: {
      role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] },
      team: "",
      techGroup: "",
      revokedAt: null,
      account: { person: { is: { status: "ACTIVE" } } },
      ...(input.excludeAssignmentId
        ? { id: { not: input.excludeAssignmentId } }
        : {}),
      ...(input.excludeAccountId
        ? { accountId: { not: input.excludeAccountId } }
        : {}),
    },
    select: {
      accountId: true,
      account: {
        select: {
          identities: {
            where: { provider: "FEISHU", tenantId: "default" },
            select: { openId: true },
          },
        },
      },
    },
    orderBy: [{ accountId: "asc" }, { id: "asc" }],
  });
  return [
    ...new Set(
      assignments
        .filter(
          (assignment) =>
            !input.requireFeishuOpenId ||
            assignment.account.identities.some((identity) =>
              Boolean(identity.openId?.trim()),
            ),
        )
        .map((assignment) => assignment.accountId),
    ),
  ];
}
