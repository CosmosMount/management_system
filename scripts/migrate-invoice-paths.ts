import "dotenv/config";
import { prisma } from "../lib/prisma";
import { serializeFilePaths } from "../lib/order-attachments";

/** 将旧 invoicePath 迁移到 invoicePaths JSON 数组 */
async function main() {
  const orders = await prisma.$queryRaw<
    { id: string; invoicePath: string | null; invoicePaths: string }[]
  >`SELECT id, invoicePath, invoicePaths FROM PurchaseOrder WHERE invoicePath IS NOT NULL AND invoicePath != ''`;

  let count = 0;
  for (const order of orders) {
    const current = order.invoicePaths?.trim();
    if (current && current !== "[]") continue;
    if (!order.invoicePath) continue;

    await prisma.purchaseOrder.update({
      where: { id: order.id },
      data: {
        invoicePaths: serializeFilePaths([order.invoicePath]),
      },
    });
    count++;
  }

  console.log(`已迁移 ${count} 条订单的 invoicePath → invoicePaths`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
