import type { FeedbackStatus } from "@prisma/client";

export const feedbackStatusLabels: Record<FeedbackStatus, string> = {
  OPEN: "开放",
  IN_PROGRESS: "处理中",
  CLOSED: "已关闭",
};

export const feedbackStatusTone: Record<
  FeedbackStatus,
  "blue" | "orange" | "green"
> = {
  OPEN: "blue",
  IN_PROGRESS: "orange",
  CLOSED: "green",
};
