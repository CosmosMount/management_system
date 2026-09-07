import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { taskReadableWhere } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { getUnreadInAppNotificationCount } from "@/lib/project-management/queries/notification-queries";
import { getTimeCanvasData } from "@/lib/project-management/queries/time-canvas-queries";
import { listTasks } from "@/lib/project-management/queries/task-queries";

const dashboardInputSchema = z
  .object({
    rangeStart: z.string().datetime({ offset: true }).optional(),
    rangeEnd: z.string().datetime({ offset: true }).optional(),
    taskLimit: z.number().int().min(1).max(50).optional().default(12),
  })
  .strict();

export async function getMyWorkDashboard({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input?: unknown;
}) {
  const parsed = dashboardInputSchema.parse(input ?? {});
  const now = new Date();
  const rangeStart = parsed.rangeStart ?? now.toISOString();
  const rangeEnd =
    parsed.rangeEnd ??
    new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString();
  const [activeTasks, activeTaskCount, personalTime, unreadNotificationCount] =
    await Promise.all([
      listTasks({
        actor,
        input: { status: "ACTIVE", mine: true, limit: parsed.taskLimit },
      }),
      prisma.task.count({
        where: {
          AND: [
            taskReadableWhere(actor),
            { status: "ACTIVE" },
            {
              members: {
                some: { personId: actor.personId, removedAt: null },
              },
            },
          ],
        },
      }),
      getTimeCanvasData({
        actor,
        input: {
          scope: { kind: "DASHBOARD" },
          rangeStart,
          rangeEnd,
          groupBy: "PERSON",
          includeTaskAnchors: true,
          includeBusyBlocks: false,
        },
      }),
      getUnreadInAppNotificationCount(actor),
    ]);

  return {
    activeTasks: activeTasks.items,
    activeTaskCount,
    personalTime,
    unreadNotificationCount,
    generatedAt: personalTime.generatedAt,
  };
}

export type MyWorkDashboard = Awaited<ReturnType<typeof getMyWorkDashboard>>;

export async function getMyWorkMetrics(actor: ProjectManagementActor) {
  const [activeTaskCount, unreadNotificationCount] = await Promise.all([
    prisma.task.count({
      where: {
        AND: [
          taskReadableWhere(actor),
          { status: "ACTIVE" },
          {
            members: {
              some: { personId: actor.personId, removedAt: null },
            },
          },
        ],
      },
    }),
    getUnreadInAppNotificationCount(actor),
  ]);
  return { activeTaskCount, unreadNotificationCount };
}
