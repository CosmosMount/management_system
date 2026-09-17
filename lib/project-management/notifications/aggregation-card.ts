import { buildAppUrl } from "@/lib/app-origin";
import type { ProjectManagementNotificationPayload } from "@/lib/project-management/notifications/contract";
import {
  normalizeProjectManagementNotificationText,
  projectManagementContextLines,
  projectManagementEntityLabel,
} from "@/lib/project-management/notifications/user-facing-copy";

export function buildProjectManagementAggregatedCard(
  items: Array<{
    payload: ProjectManagementNotificationPayload;
    createdAt: Date;
  }>,
  category: string,
) {
  const visibleItems = items.slice(0, 10);
  const hiddenCount = items.length - visibleItems.length;
  const elements: Array<Record<string, unknown>> = visibleItems.map(
    ({ payload, createdAt }, index) => {
      const title = normalizeProjectManagementNotificationText(payload.title, {
        field: "title",
        kind: payload.kind,
        taskTitle: payload.taskTitle,
        projectName: payload.projectName,
        actorName: payload.actorName,
        context: payload.context,
      });
      const summary = normalizeProjectManagementNotificationText(
        payload.summary || payload.title,
        {
          field: "summary",
          kind: payload.kind,
          taskTitle: payload.taskTitle,
          projectName: payload.projectName,
          actorName: payload.actorName,
          context: payload.context,
        },
      );
      const target = [
        payload.projectName ? `项目：${truncate(payload.projectName, 40)}` : null,
        payload.taskTitle ? `任务：${truncate(payload.taskTitle, 40)}` : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join("；");
      const context = projectManagementContextLines(payload.context)
        .slice(0, 2)
        .map(({ label, value }) => `${label}：${truncate(value, 60)}`);
      return {
        tag: "div",
        text: {
          tag: "plain_text",
          content: [
            `${index + 1}. ${truncate(title, 60)}`,
            `操作人：${truncate(payload.actorName || "系统", 40)}`,
            target || `相关事项：${projectManagementEntityLabel(payload.entityType)}`,
            `通知内容：${truncate(summary, 100)}`,
            ...context,
            `通知时间：${formatCardDate(createdAt)}`,
          ].join("\n"),
        },
      };
    },
  );
  if (hiddenCount > 0) {
    elements.push({
      tag: "div",
      text: {
        tag: "plain_text",
        content: `另有 ${hiddenCount} 条通知未在卡片中展开，请进入通知中心查看全部。`,
      },
    });
  }
  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "查看全部通知" },
        url: buildAppUrl("/progress/notifications", items[0]?.payload.appOrigin),
        type: "default",
      },
    ],
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `${projectManagementCategoryLabel(category)}通知汇总（${items.length} 条）`,
      },
      template: "green",
    },
    elements,
  };
}

function projectManagementCategoryLabel(category: string) {
  const labels: Record<string, string> = {
    PROJECT: "项目",
    TASK: "任务",
    MILESTONE: "里程碑",
    REVIEW: "验收",
    REVISION: "计划修订",
    WORK_SEGMENT: "投入记录",
    ACCOUNT_SECURITY: "账号安全",
  };
  return labels[category] ?? "项目管理";
}

function truncate(value: string, maxLength: number) {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function formatCardDate(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
