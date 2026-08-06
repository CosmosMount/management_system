import "dotenv/config";
import type { UserRoleType } from "@prisma/client";
import { prisma } from "../lib/prisma";

type RoleScope = {
  id: string;
  role: UserRoleType;
  team: string;
  techGroup: string;
};

function hasValidScope(row: RoleScope): boolean {
  switch (row.role) {
    case "TEAM_ADMIN":
      return row.team.length > 0 && row.techGroup.length === 0;
    case "TECH_GROUP_ADMIN":
    case "TEACHER":
      return row.team.length === 0 && row.techGroup.length > 0;
    case "SUPER_ADMIN":
    case "FINANCE":
      return row.team.length === 0 && row.techGroup.length === 0;
  }
}

async function main() {
  const roles = await prisma.userRole.findMany({
    select: {
      id: true,
      role: true,
      team: true,
      techGroup: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const invalid = roles.filter((row) => !hasValidScope(row));

  console.log(`UserRole 只读校验：总计 ${roles.length}，异常 ${invalid.length}`);
  for (const row of invalid) {
    console.log(
      `  - id=${row.id.slice(0, 8)}… role=${row.role} team=${JSON.stringify(row.team)} techGroup=${JSON.stringify(row.techGroup)}`,
    );
  }
  if (invalid.length > 0) {
    throw new Error("发现作用域异常的报销角色；请通过账号权限后台或受审查的数据迁移逐条修复");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
