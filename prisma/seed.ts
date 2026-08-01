import "dotenv/config";
import { prisma } from "../lib/prisma";

function cliValue(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
}

async function main() {
  const openId = cliValue("super-admin-open-id");
  if (!openId) {
    console.log(
      "未提供 --super-admin-open-id；如需初始化首位超级管理员，请先登录后执行 npm run db:seed -- --super-admin-open-id=<openId>",
    );
    return;
  }

  const user = await prisma.user.findUnique({
    where: { openId },
    select: { accountId: true },
  });
  if (!user?.accountId) {
    throw new Error("该飞书用户尚未建立统一账号，请先登录或同步通讯录");
  }

  const existing = await prisma.systemRoleAssignment.findFirst({
    where: {
      accountId: user.accountId,
      role: "SUPER_ADMINISTRATOR",
      team: "",
      techGroup: "",
      revokedAt: null,
    },
  });
  if (!existing) {
    await prisma.systemRoleAssignment.create({
      data: {
        accountId: user.accountId,
        role: "SUPER_ADMINISTRATOR",
      },
    });
  }
  console.log(existing ? "该账号已是超级管理员" : "超级管理员初始化完成");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
