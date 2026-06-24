"use server";

import { auth } from "@/lib/auth";
import { requireSessionUser } from "@/lib/progress-activity";
import { prisma } from "@/lib/prisma";

const ACTIVITY_HISTORY_PAGE_SIZE = 20;

type ActivityLogRow = {
  id: string;
  action: string;
  taskId: string | null;
  actorName: string;
  payload: string;
  createdAt: Date;
};

export type SerializedActivityLog = {
  id: string;
  action: string;
  taskId: string | null;
  actorName: string;
  payload: string;
  createdAt: string;
};

export type ActivityLogPage = {
  logs: SerializedActivityLog[];
  hasMore: boolean;
};

export async function loadMoreProjectActivityLogs(
  projectId: string,
  cursorId?: string,
): Promise<ActivityLogPage> {
  await requireLoggedInUser();
  const rows = await prisma.progressActivityLog.findMany({
    where: { projectId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    take: ACTIVITY_HISTORY_PAGE_SIZE + 1,
  });

  return serializeActivityPage(rows);
}

export async function loadMoreTaskActivityLogs(
  taskId: string,
  cursorId?: string,
): Promise<ActivityLogPage> {
  await requireLoggedInUser();
  const rows = await prisma.progressActivityLog.findMany({
    where: { taskId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    take: ACTIVITY_HISTORY_PAGE_SIZE + 1,
  });

  return serializeActivityPage(rows);
}

async function requireLoggedInUser() {
  const session = await auth();
  await requireSessionUser(session?.user?.openId);
}

function serializeActivityPage(rows: ActivityLogRow[]): ActivityLogPage {
  const pageRows = rows.slice(0, ACTIVITY_HISTORY_PAGE_SIZE);
  return {
    logs: pageRows.map((row) => ({
      id: row.id,
      action: row.action,
      taskId: row.taskId,
      actorName: row.actorName,
      payload: row.payload,
      createdAt: row.createdAt.toISOString(),
    })),
    hasMore: rows.length > ACTIVITY_HISTORY_PAGE_SIZE,
  };
}
