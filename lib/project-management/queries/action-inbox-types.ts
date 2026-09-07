import type { TaskNodeStatus, TaskNodeType } from "@prisma/client";
import type { ActionInboxStream } from "@/lib/project-management/queries/action-inbox-cursor";

export type ActionInboxKind =
  | "TASK_NEXT_NODE"
  | "MILESTONE_REVIEW"
  | "REVISION_REVIEW"
  | "PROJECT_ESTABLISHMENT"
  | "TERMINATION_REVIEW";

export type ActionInboxSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type ActionInboxItem = {
  id: string;
  kind: ActionInboxKind;
  title: string;
  summary: string;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  nodeId: string | null;
  nodeType: TaskNodeType | null;
  nodeStatus: TaskNodeStatus | null;
  relevantAt: string;
  timeLabel: string;
  severity: ActionInboxSeverity;
  href: string;
  actionLabel: string;
};

export type ActionInboxPage = {
  items: ActionInboxItem[];
  totalCount: number;
  criticalCount: number;
  nextCursor: string | null;
  generatedAt: string;
};

export type StreamItem = {
  stream: ActionInboxStream;
  rawId: string;
  relevantAt: Date;
  item: ActionInboxItem;
};
