import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { projectReadableWhere, taskReadableWhere } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { z } from "zod";

export async function getManagementOverview(actor: ProjectManagementActor, cursor?: string) {
  const where: Prisma.RiskRecordWhereInput = {
    status: "ACTIVE",
    OR: [
      { project: { is: projectReadableWhere(actor) } },
      { task: { is: taskReadableWhere(actor) } },
    ],
  };
  const cursorId = z.string().uuid().safeParse(cursor);
  const anchor = cursorId.success
    ? await prisma.riskRecord.findFirst({ where: { AND: [where, { id: cursorId.data }] }, select: { id: true } })
    : null;
  const [riskCount, activeProjectCount, activeTaskCount, risks] = await Promise.all([
    prisma.riskRecord.count({ where }),
    prisma.project.count({ where: { AND: [projectReadableWhere(actor), { status: "ACTIVE" }] } }),
    prisma.task.count({ where: { AND: [taskReadableWhere(actor), { status: "ACTIVE" }] } }),
    prisma.riskRecord.findMany({
      where,
      ...(anchor ? { cursor: { id: anchor.id }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 13,
      select: {
        id: true, content: true, createdAt: true, createdByName: true,
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true } },
      },
    }),
  ]);
  return { riskCount, activeProjectCount, activeTaskCount, risks: risks.slice(0, 12), nextCursor: risks.length > 12 ? risks[11].id : null, cursorInvalid: Boolean(cursor && !anchor) };
}
