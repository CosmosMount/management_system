import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import type { ProjectManagementActor } from "../../lib/project-management/identity";

export async function createPaginationActor(
  displayName: string,
): Promise<ProjectManagementActor> {
  const openId = `ou_pagination_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: { create: { displayName, status: "ACTIVE" } },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return {
    accountId: account.id,
    personId: account.person.id,
    openId,
    unionId: null,
    systemRoles: [],
  };
}

export async function grantPaginationAdministrator(accountId: string) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role: "SUPER_ADMINISTRATOR",
      team: "",
      techGroup: "",
    },
  });
}

export async function createPaginationTaskRows(input: {
  accountId: string;
  personId: string;
  rows: Array<{
    id: string;
    status: "ACTIVE" | "DRAFT";
    title: string;
    updatedAt: Date;
  }>;
}) {
  await prisma.$transaction(async (tx) => {
    for (const row of input.rows) {
      const planVersionId = randomUUID();
      await tx.$executeRaw`
        INSERT INTO "Task" (
          "id", "title", "status", "currentPlanVersionId",
          "createdByAccountId", "createdAt", "updatedAt"
        ) VALUES (
          ${row.id}, ${row.title}, ${row.status}::"TaskStatus", ${planVersionId},
          ${input.accountId}, ${row.updatedAt}, ${row.updatedAt}
        )
      `;
      await tx.$executeRaw`
        INSERT INTO "TaskPlanVersion" (
          "id", "taskId", "versionNo", "status", "createdByAccountId",
          "createdAt", "updatedAt"
        ) VALUES (
          ${planVersionId}, ${row.id}, 1, 'CURRENT'::"PlanVersionStatus",
          ${input.accountId}, ${row.updatedAt}, ${row.updatedAt}
        )
      `;
      await tx.taskMember.create({
        data: {
          taskId: row.id,
          personId: input.personId,
          role: "OWNER",
          createdByAccountId: input.accountId,
        },
      });
    }
  });
}
