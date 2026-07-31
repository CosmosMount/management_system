import { z } from "zod";
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
  const [activeTasks, personalTime, unreadNotificationCount] =
    await Promise.all([
      listTasks({
        actor,
        input: { status: "ACTIVE", mine: true, limit: parsed.taskLimit },
      }),
      getTimeCanvasData({
        actor,
        input: {
          scope: { kind: "DASHBOARD" },
          rangeStart,
          rangeEnd,
          groupBy: "PERSON",
          includeTaskAnchors: true,
          includeActual: true,
          includeBusyBlocks: false,
          includeConflicts: true,
          rowLimit: 1,
        },
      }),
      getUnreadInAppNotificationCount(actor),
    ]);

  return {
    activeTasks: activeTasks.items,
    personalTime,
    pendingConfirmations: personalTime.segments.flatMap((segment) =>
      segment.kind === "SEGMENT" &&
      segment.type === "PLANNED" &&
      segment.status === "PENDING_CONFIRMATION" &&
      segment.personId === actor.personId
        ? [segment]
        : [],
    ),
    conflicts: personalTime.conflicts.filter(
      (conflict) =>
        conflict.visibility === "VISIBLE" ||
        conflict.capabilities.canAcknowledge ||
        conflict.capabilities.canResolve ||
        conflict.capabilities.canIgnore,
    ),
    unreadNotificationCount,
    generatedAt: personalTime.generatedAt,
  };
}

export type MyWorkDashboard = Awaited<ReturnType<typeof getMyWorkDashboard>>;
