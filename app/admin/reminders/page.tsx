import { RemindersPanel } from "@/components/admin/reminders-panel";
import { getProgressReminderRuleViews } from "@/lib/progress-reminders";
import { prisma } from "@/lib/prisma";

export default async function AdminRemindersPage() {
  const [progressReminderRules, progressReminderOutbox] = await Promise.all([
    getProgressReminderRuleViews(),
    prisma.notificationOutbox.findMany({
      where: { channel: "progress", type: "progress_reminder" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    }),
  ]);

  return (
    <RemindersPanel
      progressReminderRules={progressReminderRules}
      progressReminderOutbox={progressReminderOutbox.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      }))}
    />
  );
}
