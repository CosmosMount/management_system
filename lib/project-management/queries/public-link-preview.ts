import { prisma } from "@/lib/prisma";
import { idSchema } from "@/lib/project-management/validations/lifecycle";

export type PublicProgressLinkPreview = {
  kind: "projects" | "tasks" | "meetings";
  name: string;
};

/** 名称是显式公开字段；不可复用会加载完整业务数据的详情查询。 */
export async function getPublicProgressLinkPreview(
  kind: string,
  id: string,
): Promise<PublicProgressLinkPreview | null> {
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return null;
  const where = { id: parsedId.data, deletedAt: null };
  if (kind === "projects") {
    const project = await prisma.project.findFirst({ where, select: { name: true } });
    return project ? { kind, name: project.name } : null;
  }
  if (kind === "tasks") {
    const task = await prisma.task.findFirst({ where, select: { title: true } });
    return task ? { kind, name: task.title } : null;
  }
  if (kind === "meetings") {
    const meeting = await prisma.meetingRecord.findUnique({ where: { id: parsedId.data }, select: { topic: true } });
    return meeting ? { kind, name: meeting.topic } : null;
  }
  return null;
}
