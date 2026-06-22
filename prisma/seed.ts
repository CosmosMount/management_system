import "dotenv/config";
import { UserRoleType } from "@prisma/client";
import { prisma } from "../lib/prisma";

/**
 * 配置说明：
 * 1. 自己先用飞书登录本系统一次
 * 2. npm run db:studio → User 表复制其 openId
 * 3. 填入下方 SUPER_ADMIN 后执行 npm run db:seed
 * 4. 登录后访问 /admin 可视化管理其他角色
 */
const seedRoles: {
  openId: string;
  role: UserRoleType;
  team?: string;
  techGroup?: string;
}[] = [
  { openId: "ou_9b67061d0974037132da5550530c44ca", role: UserRoleType.SUPER_ADMIN },
  // { openId: "ou_从User表复制", role: UserRoleType.TEACHER },
  // { openId: "ou_从User表复制", role: UserRoleType.TEAM_ADMIN, team: "英雄" },
  { openId: "ou_9b67061d0974037132da5550530c44ca", role: UserRoleType.TECH_GROUP_ADMIN, techGroup: "电控" },
  
];

async function main() {
  if (seedRoles.length === 0) {
    console.log(
      "seedRoles 为空，请在 prisma/seed.ts 填入 User 表中的 openId 后重试",
    );
    return;
  }
  for (const entry of seedRoles) {
    const team = entry.team ?? "";
    const techGroup = entry.techGroup ?? "";
    await prisma.userRole.upsert({
      where: {
        openId_role_team_techGroup: {
          openId: entry.openId,
          role: entry.role,
          team,
          techGroup,
        },
      },
      update: {},
      create: {
        openId: entry.openId,
        role: entry.role,
        team,
        techGroup,
      },
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
