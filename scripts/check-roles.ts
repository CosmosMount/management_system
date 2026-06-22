import "dotenv/config";
import { prisma } from "../lib/prisma";

async function main() {
  const users = await prisma.user.findMany();
  console.log("=== User ===");
  for (const u of users) {
    console.log(`${u.name}\t${u.openId}`);
  }

  const roles = await prisma.$queryRaw<
    { id: string; openId: string; role: string; team: string; techGroup: string }[]
  >`SELECT id, openId, role, team, techGroup FROM UserRole`;

  console.log("\n=== UserRole (raw) ===");
  for (const r of roles) {
    console.log(
      `${r.role}\topenId=${r.openId}\tteam=${r.team}\ttechGroup=${r.techGroup}`,
    );
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
