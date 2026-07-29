import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { getUnreadInAppNotificationCount } from "@/lib/project-management/queries/notification-queries";
import {
  listResourceConflicts,
  listWorkSegments,
} from "@/lib/project-management/queries/resource-queries";
import { listTasks } from "@/lib/project-management/queries/task-queries";

export async function getProjectManagementOverview(actor: ProjectManagementActor) {
  const now = new Date();
  const nextSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
  const [
    activeTasks,
    upcomingSegments,
    pendingConfirmations,
    openConflicts,
    unreadNotificationCount,
  ] = await Promise.all([
    listTasks({
      actor,
      input: { status: "ACTIVE", mine: true, limit: 8 },
    }),
    listWorkSegments({
      actor,
      input: {
        personId: actor.personId,
        startAt: now,
        endAt: nextSevenDays,
        limit: 8,
      },
    }),
    listWorkSegments({
      actor,
      input: {
        personId: actor.personId,
        type: "PLANNED",
        status: "PENDING_CONFIRMATION",
        limit: 8,
      },
    }),
    listResourceConflicts({
      actor,
      input: {
        personId: actor.personId,
        status: "OPEN",
        limit: 8,
      },
    }),
    getUnreadInAppNotificationCount(actor),
  ]);

  return {
    activeTasks: activeTasks.items,
    upcomingSegments: upcomingSegments.items,
    pendingConfirmations: pendingConfirmations.items,
    openConflicts: openConflicts.items,
    unreadNotificationCount,
  };
}
