import "dotenv/config";
import { prisma } from "../lib/prisma";

/**
 * 清理 schema 升级后遗留的无效 UserRole（如 TECH、placeholder），
 * 避免 Prisma 读取枚举失败。清理后请执行 npm run db:seed。
 */
async function main() {
  const before = await prisma.$queryRaw<
    { role: string; openId: string }[]
  >`SELECT role, openId FROM UserRole`;

  console.log("清理前 UserRole 记录数:", before.length);
  for (const row of before) {
    console.log(`  - ${row.role} ${row.openId}`);
  }

  await prisma.$executeRaw`DELETE FROM UserRole`;
  console.log("\n已清空 UserRole 表。请接着执行: npm run db:seed");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
