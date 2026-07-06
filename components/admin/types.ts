import type {
  NotificationOutboxStatus,
  ProgressReminderKind,
  UserRoleType,
} from "@prisma/client";
import type { ComponentType } from "react";

export type AdminUser = {
  id: string;
  openId: string;
  name: string;
  email: string | null;
  avatar: string | null;
  createdAt: string;
};

export type AdminRole = {
  id: string;
  openId: string;
  role: UserRoleType;
  team: string;
  techGroup: string;
};

export type AdminAcceptanceChecklistTemplate = {
  id: string;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminProgressReminderParamDefinition = {
  key: string;
  label: string;
  min: number;
  max: number;
  unit: string;
};

export type AdminProgressReminderRule = {
  kind: ProgressReminderKind;
  label: string;
  description: string;
  enabled: boolean;
  scheduleTime: string;
  params: Record<string, number>;
  paramDefinitions: AdminProgressReminderParamDefinition[];
  lastRunAt: string | null;
  updatedAt: string | null;
};

export type AdminReminderOutbox = {
  id: string;
  type: string;
  eventKey: string;
  sourceLabel?: string;
  recipientSummary?: string;
  status: NotificationOutboxStatus;
  attempts: number;
  lastError: string;
  createdAt: string;
  sentAt: string | null;
};

export type AdminProgressDailySummarySetting = {
  enabled: boolean;
  scheduleTime: string;
  lastRunAt: string | null;
  updatedAt: string | null;
};

export type AdminDailySummaryUserOption = {
  openId: string;
  name: string;
  email: string | null;
  avatar: string | null;
};

export type AdminProjectTemplateStage = {
  id: string;
  name: string;
  goal: string;
  durationDays: number;
  sortOrder: number;
};

export type AdminProjectTemplate = {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  stages: AdminProjectTemplateStage[];
};

export type AdminIcon = ComponentType<{ className?: string }>;
