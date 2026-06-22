import "dotenv/config";
import { UserRoleType } from "@prisma/client";
import { prisma } from "../lib/prisma";

/**
 * 配置说明：
 * 1. 让审批人先用飞书登录本系统一次
 * 2. npm run db:studio → User 表复制其 openId
 * 3. 填入下方数组后执行 npm run db:seed
 *
 * 切勿使用占位符或从其他应用复制的 open_id，否则会报 cross app 错误。
 */
const seedRoles: { openId: string; role: UserRoleType }[] = [
  // { openId: "ou_从User表复制", role: UserRoleType.TECH },
  // { openId: "ou_从User表复制", role: UserRoleType.TEACHER },
  // { openId: "ou_从User表复制", role: UserRoleType.FINANCE },
];

async function main() {
  if (seedRoles.length === 0) {
    console.log("seedRoles 为空，请在 prisma/seed.ts 填入 User 表中的 openId 后重试");
    return;
  }
  for (const entry of seedRoles) {
    await prisma.userRole.upsert({
      where: { openId: entry.openId },
      update: { role: entry.role },
      create: entry,
    });
  }
  console.log(`UserRole seed 完成，共 ${seedRoles.length} 条`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
