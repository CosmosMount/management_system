import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type PrismaClientLike = Prisma.TransactionClient | typeof prisma;

export async function lockFeishuContactSyncTx(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"feishu-contact-sync"}))`;
}

function normalizedOpenIds(openIds: Iterable<string>): string[] {
  return [
    ...new Set(
      [...openIds].map((openId) => openId.trim()).filter(Boolean),
    ),
  ];
}

/** 只保留当前仍绑定在职 Person 的飞书身份，并保持调用方顺序。 */
export async function filterActiveFeishuOpenIds(
  openIds: Iterable<string>,
  client: PrismaClientLike = prisma,
): Promise<string[]> {
  const normalized = normalizedOpenIds(openIds);
  if (normalized.length === 0) return [];
  const identities = await client.accountIdentity.findMany({
    where: {
      provider: "FEISHU",
      tenantId: "default",
      openId: { in: normalized },
      account: { person: { is: { status: "ACTIVE" } } },
    },
    select: { openId: true },
  });
  const active = new Set(
    identities.flatMap((identity) =>
      identity.openId ? [identity.openId] : [],
    ),
  );
  return normalized.filter((openId) => active.has(openId));
}

export async function requireActiveProcurementUser(
  openId: string,
  client: PrismaClientLike = prisma,
): Promise<void> {
  if (!(await isActiveFeishuOpenId(openId, client))) {
    throw new Error("人员已停用，无法执行采购操作");
  }
}

/**
 * 在采购写事务中锁定操作者的 Person 行并复核在职状态。
 *
 * 通讯录同步更新同一行，因此两类事务会按提交顺序串行化：同步先提交时
 * 采购写会看到 INACTIVE，采购写先提交时同步会等待该写入完成后再停用。
 */
async function lockActiveFeishuUserTx(
  tx: Prisma.TransactionClient,
  openId: string,
  inactiveMessage: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT person."status"::text AS "status"
    FROM "Person" AS person
    INNER JOIN "Account" AS account
      ON account."id" = person."accountId"
    INNER JOIN "AccountIdentity" AS identity
      ON identity."accountId" = account."id"
    WHERE identity."provider" = 'FEISHU'
      AND identity."tenantId" = 'default'
      AND identity."openId" = ${openId}
    FOR UPDATE OF person
  `;
  if (rows.length !== 1 || rows[0]?.status !== "ACTIVE") {
    throw new Error(inactiveMessage);
  }
}

export async function lockActiveProcurementUserTx(
  tx: Prisma.TransactionClient,
  openId: string,
): Promise<void> {
  return lockActiveFeishuUserTx(
    tx,
    openId,
    "人员已停用，无法执行采购操作",
  );
}

export async function lockActiveFeedbackUserTx(
  tx: Prisma.TransactionClient,
  openId: string,
): Promise<void> {
  return lockActiveFeishuUserTx(tx, openId, "人员已停用，无法提交反馈");
}

export async function isActiveFeishuOpenId(
  openId: string,
  client: PrismaClientLike = prisma,
): Promise<boolean> {
  return (await filterActiveFeishuOpenIds([openId], client)).length === 1;
}
