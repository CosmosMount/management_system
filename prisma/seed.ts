import "dotenv/config";
import { UserRoleType } from "@prisma/client";
import { prisma } from "../lib/prisma";

/**
 * 将下方 openId 替换为实际飞书用户的 open_id 后执行: npm run db:seed
 */
const seedRoles: { openId: string; role: UserRoleType }[] = [
  { openId: "ou_tech_placeholder", role: UserRoleType.TECH },
  { openId: "ou_857a80572f2753f38ed8588deed2ff6c", role: UserRoleType.TECH },
  { openId: "ou_teacher_placeholder", role: UserRoleType.TEACHER },
  { openId: "ou_finance_placeholder", role: UserRoleType.FINANCE },
];

async function main() {
  for (const entry of seedRoles) {
    await prisma.userRole.upsert({
      where: { openId: entry.openId },
      update: { role: entry.role },
      create: entry,
    });
  }
  console.log("UserRole seed 完成，请替换为真实 open_id");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
