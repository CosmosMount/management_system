import type { Prisma } from "@prisma/client";
import { lockActiveProcurementUserTx } from "@/lib/active-account";
import { prisma } from "@/lib/prisma";

export async function deletePurchaseOrderAsSuperAdministrator(
  actorOpenId: string,
  orderId: string,
): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    await lockActiveProcurementUserTx(tx, actorOpenId);
    await assertSuperAdministratorTx(tx, actorOpenId);

    const order = await tx.purchaseOrder.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) throw new Error("订单不存在");

    const assets = await tx.fileAsset.findMany({
      where: { orderId },
      select: { publicPath: true },
    });
    await tx.purchaseOrder.delete({ where: { id: orderId } });
    return assets.map((asset) => asset.publicPath);
  });
}

async function assertSuperAdministratorTx(
  tx: Prisma.TransactionClient,
  openId: string,
) {
  const assignment = await tx.systemRoleAssignment.findFirst({
    where: {
      role: "SUPER_ADMINISTRATOR",
      team: "",
      techGroup: "",
      revokedAt: null,
      account: {
        identities: {
          some: {
            provider: "FEISHU",
            tenantId: "default",
            openId,
          },
        },
        person: { is: { status: "ACTIVE" } },
      },
    },
    select: { id: true },
  });
  if (!assignment) throw new Error("无管理权限");
}
