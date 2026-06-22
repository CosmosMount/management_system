import "dotenv/config";
import { prisma } from "../lib/prisma";

/** 将旧订单状态迁移到新流程（schema 升级后执行一次） */
async function main() {
  const mappings: Record<string, string> = {
    TECH_REVIEW: "MANAGEMENT_REVIEW",
    TECH_GROUP_REVIEW: "MANAGEMENT_REVIEW",
    PENDING_REIMBURSE: "PENDING_APPLICANT_DOCS",
    REIMBURSING: "PENDING_FINANCE_REVIEW",
  };

  for (const [from, to] of Object.entries(mappings)) {
    const count = await prisma.$executeRawUnsafe(
      `UPDATE PurchaseOrder SET status = ? WHERE status = ?`,
      to,
      from,
    );
    if (count > 0) {
      console.log(`已迁移 ${from} → ${to}: ${count} 条`);
    }
  }

  await prisma.$executeRawUnsafe(
    `UPDATE PurchaseOrder SET teamApproved = 1, techGroupApproved = 1 WHERE status NOT IN ('DRAFT', 'MANAGEMENT_REVIEW', 'COMPLETED')`,
  );

  console.log("订单状态迁移完成");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
