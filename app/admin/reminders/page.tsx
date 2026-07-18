import { RemindersPanel } from "@/components/admin/reminders-panel";
import { getProgressDailySummarySetting } from "@/lib/progress-daily-summary";
import { getProgressApprovalReminderSetting } from "@/lib/progress-approval-reminder-settings";
import { getProgressReminderRuleViews } from "@/lib/progress-reminders";
import { prisma } from "@/lib/prisma";

export default async function AdminRemindersPage() {
  const [
    progressReminderRules,
    progressReminderOutbox,
    progressDailySummarySetting,
    progressDailySummaryOutbox,
    progressApprovalReminderSetting,
    users,
  ] = await Promise.all([
    getProgressReminderRuleViews(),
    prisma.notificationOutbox.findMany({
      where: { channel: "progress", type: "progress_reminder" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    }),
    getProgressDailySummarySetting(),
    prisma.notificationOutbox.findMany({
      where: { channel: "progress", type: "progress_daily_summary" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    }),
    getProgressApprovalReminderSetting(),
    prisma.user.findMany({
      orderBy: [{ name: "asc" }, { openId: "asc" }],
      select: { openId: true, name: true, email: true, avatar: true },
    }),
  ]);

  return (
    <RemindersPanel
      progressReminderRules={progressReminderRules}
      progressReminderOutbox={progressReminderOutbox.map((row) => ({
        id: row.id,
        type: row.type,
        eventKey: row.eventKey,
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      }))}
      progressDailySummarySetting={progressDailySummarySetting}
      progressApprovalReminderSetting={progressApprovalReminderSetting}
      progressDailySummaryOutbox={progressDailySummaryOutbox.map((row) => {
        const metadata = readDailySummaryOutboxMetadata(
          row.eventKey,
          row.payload,
        );
        return {
          id: row.id,
          type: row.type,
          eventKey: row.eventKey,
          sourceLabel: metadata.sourceLabel,
          recipientSummary: metadata.recipientSummary,
          status: row.status,
          attempts: row.attempts,
          lastError: row.lastError,
          createdAt: row.createdAt.toISOString(),
          sentAt: row.sentAt?.toISOString() ?? null,
        };
      })}
      users={users}
    />
  );
}

function readDailySummaryOutboxMetadata(
  eventKey: string,
  rawPayload: string,
): { sourceLabel: string; recipientSummary: string } {
  const sourceLabel = eventKey.startsWith("progress:daily_summary:test:")
    ? "测试发送"
    : "正式发送";
  try {
    const parsed = JSON.parse(rawPayload) as {
      payload?: {
        recipientName?: unknown;
        recipientOpenIds?: unknown;
      };
    };
    const payload = parsed.payload;
    const recipientName =
      typeof payload?.recipientName === "string"
        ? payload.recipientName.trim()
        : "";
    const recipientOpenIds = Array.isArray(payload?.recipientOpenIds)
      ? payload.recipientOpenIds.filter(
          (openId): openId is string => typeof openId === "string" && !!openId,
        )
      : [];
    return {
      sourceLabel,
      recipientSummary:
        recipientName || recipientOpenIds.join("、") || "未记录收件人",
    };
  } catch {
    return { sourceLabel, recipientSummary: "无法解析收件人" };
  }
}
