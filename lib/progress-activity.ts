import { prisma } from "@/lib/prisma";

export async function logProgressActivity(input: {
  projectId?: string;
  taskId?: string;
  action: string;
  actorOpenId: string;
  actorName: string;
  payload?: Record<string, unknown>;
}) {
  await prisma.progressActivityLog.create({
    data: {
      projectId: input.projectId,
      taskId: input.taskId,
      action: input.action,
      actorOpenId: input.actorOpenId,
      actorName: input.actorName,
      payload: JSON.stringify(input.payload ?? {}),
    },
  });
}

export async function getUserByOpenId(openId: string) {
  return prisma.user.findUnique({ where: { openId } });
}

export async function requireSessionUser(openId: string | undefined) {
  if (!openId) throw new Error("未登录");
  const user = await getUserByOpenId(openId);
  if (!user) throw new Error("用户不存在");
  return user;
}
