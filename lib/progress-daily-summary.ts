import type {
  Importance,
  Prisma,
  ProgressDailySummarySetting,
  ProjectStatus,
  TaskStatus,
  Urgency,
} from "@prisma/client";
import { enqueueProgressNotification } from "@/lib/notification-outbox";
import { collectProjectNotificationRecipients } from "@/lib/progress-project-notifications";
import { collectTaskNotificationRecipients } from "@/lib/progress-task-notifications";
import { getProjectOwnerNames } from "@/lib/progress-project-owners";
import { getTaskAssigneeNames } from "@/lib/progress-assignees";
import { getTaskTechGroups } from "@/lib/progress-task-tech-groups";
import {
  importanceLabels,
  projectStatusLabels,
  stageStatusLabels,
  taskStatusLabels,
  urgencyLabels,
} from "@/lib/progress-labels";
import { getDefaultNotificationContext } from "@/lib/request-origin";
import { routes } from "@/lib/routes";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { NotificationContext } from "@/lib/app-origin";

const TIME_ZONE = "Asia/Shanghai";
const ACTIVE_PROJECT_STATUSES = [
  "ESTABLISHING",
  "ESTABLISHMENT_REJECTED",
  "NOT_STARTED",
  "IN_PROGRESS",
] as const satisfies ProjectStatus[];
const ACTIVE_TASK_STATUSES = [
  "TODO",
  "IN_PROGRESS",
  "PENDING_ACCEPTANCE",
] as const satisfies TaskStatus[];
const DDL_LOOKAHEAD_DAYS = 7;
const DAILY_SUMMARY_SETTING_ID = "default";
const DEFAULT_DAILY_SUMMARY_SCHEDULE_TIME = "19:00";
const SCHEDULE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const projectSummaryInclude = {
  owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
  participants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
  followPreferences: true,
  stages: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  },
  tasks: {
    where: { deletedAt: null },
    include: {
      assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  },
} satisfies Prisma.ProjectInclude;

const taskSummaryInclude = {
  assignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
  techGroups: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
  followPreferences: true,
  stage: {
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  },
  project: { include: projectSummaryInclude },
} satisfies Prisma.TaskInclude;

type LoadedProject = Prisma.ProjectGetPayload<{
  include: typeof projectSummaryInclude;
}>;
type LoadedTask = Prisma.TaskGetPayload<{ include: typeof taskSummaryInclude }>;

export type ProgressDailySummaryResult = {
  summaryDate: string;
  recipients: number;
  queued: number;
  skipped: number;
};

type RunProgressDailySummariesOptions = {
  now?: Date;
  context?: NotificationContext;
  recipientOpenIds?: string[];
};

type ProgressDailySummaryCollection = {
  summaries: Map<string, MutableSummary>;
  userNames: Map<string, string>;
};

export type ProgressDailySummarySettingView = {
  enabled: boolean;
  scheduleTime: string;
  lastRunAt: string | null;
  updatedAt: string | null;
};

export type ProgressDailySummaryScheduleRunResult =
  | {
      ran: false;
      reason: "disabled" | "not_due" | "already_ran";
      summaryDate: string;
      scheduleTime: string;
      lastRunAt: string | null;
    }
  | ({
      ran: true;
      scheduleTime: string;
      lastRunAt: string | null;
    } & ProgressDailySummaryResult);

export type ProgressDailySummaryTestResult = {
  summaryDate: string;
  eventKey: string;
  created: boolean;
};

type MutableSummary = {
  openId: string;
  taskItems: Map<string, ProgressDailySummaryTaskItem>;
  projectItems: Map<string, ProgressDailySummaryProjectItem>;
  ddlItems: Map<string, ProgressDailySummaryDdlItem>;
};

export type ProgressDailySummaryTaskItem = {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  stageName: string;
  status: TaskStatus;
  statusLabel: string;
  assigneeNames: string;
  taskTechGroups: string[];
  urgency: Urgency;
  urgencyLabel: string;
  importance: Importance;
  importanceLabel: string;
  dueAt: string;
  dueLabel: string;
  isOverdue: boolean;
  riskNote: string;
  needsWeeklyReport: boolean;
  linkPath: string;
};

export type ProgressDailySummaryProjectItem = {
  projectId: string;
  name: string;
  status: ProjectStatus;
  statusLabel: string;
  team: string;
  techGroup: string;
  ownerNames: string;
  currentStageName: string;
  currentStageStatusLabel: string;
  projectDueAt: string | null;
  projectDueLabel: string;
  activeTaskCount: number;
  overdueTaskCount: number;
  pendingAcceptanceTaskCount: number;
  riskCount: number;
  linkPath: string;
};

export type ProgressDailySummaryDdlItem = {
  kind: "PROJECT" | "STAGE" | "TASK";
  id: string;
  title: string;
  projectName: string;
  stageName?: string;
  dueAt: string;
  dueLabel: string;
  isOverdue: boolean;
  linkPath: string;
};

export async function getProgressDailySummarySetting(): Promise<ProgressDailySummarySettingView> {
  return toSettingView(await ensureProgressDailySummarySetting());
}

export async function saveProgressDailySummarySetting(input: {
  enabled: boolean;
  scheduleTime: string;
}): Promise<ProgressDailySummarySettingView> {
  const scheduleTime = normalizeScheduleTime(input.scheduleTime);
  const saved = await prisma.progressDailySummarySetting.upsert({
    where: { id: DAILY_SUMMARY_SETTING_ID },
    create: {
      id: DAILY_SUMMARY_SETTING_ID,
      enabled: input.enabled,
      scheduleTime,
    },
    update: {
      enabled: input.enabled,
      scheduleTime,
    },
  });
  return toSettingView(saved);
}

export async function runProgressDailySummariesIfDue(
  options: Pick<RunProgressDailySummariesOptions, "now" | "context"> = {},
): Promise<ProgressDailySummaryScheduleRunResult> {
  const now = options.now ?? new Date();
  const summaryDate = localDateKey(now);
  const setting = await ensureProgressDailySummarySetting();
  const scheduleTime = normalizeScheduleTime(setting.scheduleTime);
  const lastRunAt = setting.lastRunAt?.toISOString() ?? null;

  if (!setting.enabled) {
    return {
      ran: false,
      reason: "disabled",
      summaryDate,
      scheduleTime,
      lastRunAt,
    };
  }
  if (setting.lastRunAt && localDateKey(setting.lastRunAt) === summaryDate) {
    return {
      ran: false,
      reason: "already_ran",
      summaryDate,
      scheduleTime,
      lastRunAt,
    };
  }
  if (localTimeMinutes(now) < scheduleTimeMinutes(scheduleTime)) {
    return {
      ran: false,
      reason: "not_due",
      summaryDate,
      scheduleTime,
      lastRunAt,
    };
  }

  const result = await runProgressDailySummaries({
    now,
    context: options.context,
  });
  await prisma.progressDailySummarySetting.update({
    where: { id: DAILY_SUMMARY_SETTING_ID },
    data: { lastRunAt: now },
  });
  return {
    ran: true,
    scheduleTime,
    lastRunAt,
    ...result,
  };
}

export async function sendProgressDailySummaryTest({
  openId,
  now = new Date(),
  context = getDefaultNotificationContext(),
}: {
  openId: string;
  now?: Date;
  context?: NotificationContext;
}): Promise<ProgressDailySummaryTestResult> {
  const user = await prisma.user.findUnique({
    where: { openId },
    select: { openId: true, name: true },
  });
  if (!user) throw new Error("用户不存在，无法发送每日卡片测试");

  const summaryDate = localDateKey(now);
  const { summaries } = await collectDailySummaries({
    now,
    recipientFilter: new Set([user.openId]),
    ensureOpenIds: [user.openId],
  });
  const summary = summaries.get(user.openId) ?? ensureSummary(summaries, user.openId);
  const payload = buildSummaryPayload({
    summary,
    recipientName: user.name,
    summaryDate,
    now,
  });
  const eventKey = `progress:daily_summary:test:${user.openId}:${Date.now()}`;
  const result = await enqueueProgressNotification(eventKey, payload, context);
  return { summaryDate, eventKey, created: result.created };
}

export async function runProgressDailySummaries(
  options: RunProgressDailySummariesOptions = {},
): Promise<ProgressDailySummaryResult> {
  const now = options.now ?? new Date();
  const summaryDate = localDateKey(now);
  const context = options.context ?? getDefaultNotificationContext();
  const recipientFilter = new Set(options.recipientOpenIds?.filter(Boolean) ?? []);
  const { summaries, userNames } = await collectDailySummaries({
    now,
    recipientFilter,
  });
  let queued = 0;
  let skipped = 0;
  for (const summary of summaries.values()) {
    const payload = buildSummaryPayload({
      summary,
      recipientName: userNames.get(summary.openId) ?? "",
      summaryDate,
      now,
    });
    if (
      payload.overview.taskCount === 0 &&
      payload.overview.projectCount === 0 &&
      payload.overview.ddlCount === 0
    ) {
      skipped += 1;
      continue;
    }
    const result = await enqueueProgressNotification(
      `progress:daily_summary:${summary.openId}:${summaryDate}`,
      payload,
      context,
    );
    if (result.created) queued += 1;
    else skipped += 1;
  }

  logger.info("progress.daily_summary.completed", {
    module: "progress",
    action: "runProgressDailySummaries",
    summaryDate,
    recipients: summaries.size,
    queued,
    skipped,
  });

  return { summaryDate, recipients: summaries.size, queued, skipped };
}

async function collectDailySummaries({
  now,
  recipientFilter,
  ensureOpenIds = [],
}: {
  now: Date;
  recipientFilter: Set<string>;
  ensureOpenIds?: string[];
}): Promise<ProgressDailySummaryCollection> {
  const summaries = new Map<string, MutableSummary>();

  const [projects, tasks] = await Promise.all([
    loadActiveProjects(),
    loadActiveTasks(),
  ]);

  const projectRecipients = new Map<string, string[]>();
  for (const project of projects) {
    const recipients = await collectProjectNotificationRecipients(project);
    projectRecipients.set(project.id, recipients);
    const projectItem = buildProjectItem(project, now);
    const ddlItems = buildProjectDdlItems(project, now);
    for (const openId of recipients) {
      if (!shouldIncludeRecipient(openId, recipientFilter)) continue;
      const summary = ensureSummary(summaries, openId);
      summary.projectItems.set(projectItem.projectId, projectItem);
      for (const item of ddlItems) summary.ddlItems.set(item.id, item);
    }
  }

  for (const task of tasks) {
    const recipients = await collectTaskNotificationRecipients(task);
    const taskItem = buildTaskItem(task, now);
    const projectItem = buildProjectItem(task.project, now);
    const ddlItem = buildTaskDdlItem(taskItem);
    for (const openId of recipients) {
      if (!shouldIncludeRecipient(openId, recipientFilter)) continue;
      const summary = ensureSummary(summaries, openId);
      summary.taskItems.set(taskItem.taskId, taskItem);
      if (projectRecipients.get(task.projectId)?.includes(openId)) {
        summary.projectItems.set(projectItem.projectId, projectItem);
      }
      if (ddlItem) summary.ddlItems.set(ddlItem.id, ddlItem);
    }
  }

  for (const openId of ensureOpenIds) {
    if (shouldIncludeRecipient(openId, recipientFilter)) {
      ensureSummary(summaries, openId);
    }
  }

  const userNames = await loadUserNames([...summaries.keys()]);
  return { summaries, userNames };
}

async function ensureProgressDailySummarySetting(): Promise<ProgressDailySummarySetting> {
  return prisma.progressDailySummarySetting.upsert({
    where: { id: DAILY_SUMMARY_SETTING_ID },
    create: {
      id: DAILY_SUMMARY_SETTING_ID,
      enabled: true,
      scheduleTime: getDefaultDailySummaryScheduleTime(),
    },
    update: {},
  });
}

function toSettingView(
  setting: ProgressDailySummarySetting,
): ProgressDailySummarySettingView {
  return {
    enabled: setting.enabled,
    scheduleTime: normalizeScheduleTime(setting.scheduleTime),
    lastRunAt: setting.lastRunAt?.toISOString() ?? null,
    updatedAt: setting.updatedAt?.toISOString() ?? null,
  };
}

async function loadActiveProjects(): Promise<LoadedProject[]> {
  return prisma.project.findMany({
    where: { status: { in: [...ACTIVE_PROJECT_STATUSES] } },
    include: projectSummaryInclude,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
}

async function loadActiveTasks(): Promise<LoadedTask[]> {
  return prisma.task.findMany({
    where: {
      deletedAt: null,
      status: { in: [...ACTIVE_TASK_STATUSES] },
      project: { status: { notIn: ["COMPLETED", "CANCELED"] } },
    },
    include: taskSummaryInclude,
    orderBy: [{ dueAt: "asc" }, { updatedAt: "desc" }],
  });
}

async function loadUserNames(openIds: string[]): Promise<Map<string, string>> {
  if (openIds.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { openId: { in: openIds } },
    select: { openId: true, name: true },
  });
  return new Map(users.map((user) => [user.openId, user.name]));
}

function ensureSummary(
  summaries: Map<string, MutableSummary>,
  openId: string,
): MutableSummary {
  let summary = summaries.get(openId);
  if (!summary) {
    summary = {
      openId,
      taskItems: new Map(),
      projectItems: new Map(),
      ddlItems: new Map(),
    };
    summaries.set(openId, summary);
  }
  return summary;
}

function buildSummaryPayload({
  summary,
  recipientName,
  summaryDate,
  now,
}: {
  summary: MutableSummary;
  recipientName: string;
  summaryDate: string;
  now: Date;
}) {
  const tasks = [...summary.taskItems.values()].sort(compareTaskItems);
  const projects = [...summary.projectItems.values()].sort(compareProjectItems);
  const ddlItems = [...summary.ddlItems.values()].sort(compareDdlItems);
  const overdueTaskCount = tasks.filter((task) => task.isOverdue).length;
  const pendingAcceptanceTaskCount = tasks.filter(
    (task) => task.status === "PENDING_ACCEPTANCE",
  ).length;
  const riskTaskCount = tasks.filter((task) => task.riskNote).length;
  const overdueDdlCount = ddlItems.filter((item) => item.isOverdue).length;

  return {
    type: "progress_daily_summary" as const,
    summaryDate,
    generatedAt: now.toISOString(),
    recipientOpenIds: [summary.openId],
    recipientName,
    overview: {
      taskCount: tasks.length,
      projectCount: projects.length,
      ddlCount: ddlItems.length,
      overdueTaskCount,
      pendingAcceptanceTaskCount,
      riskTaskCount,
      overdueDdlCount,
    },
    tasks,
    taskTotalCount: tasks.length,
    projects,
    projectTotalCount: projects.length,
    ddlItems,
    ddlTotalCount: ddlItems.length,
    linkPath: routes.progress.root,
    approvalsLinkPath: routes.progress.approvals,
  };
}

function buildTaskItem(
  task: LoadedTask,
  now: Date,
): ProgressDailySummaryTaskItem {
  const due = buildDueLabel(task.dueAt, now);
  return {
    taskId: task.id,
    title: task.title,
    projectId: task.projectId,
    projectName: task.project.name,
    stageName: task.stage?.name ?? "无阶段",
    status: task.status,
    statusLabel: taskStatusLabels[task.status],
    assigneeNames: getTaskAssigneeNames(task),
    taskTechGroups: getTaskTechGroups(task),
    urgency: task.urgency,
    urgencyLabel: urgencyLabels[task.urgency],
    importance: task.importance,
    importanceLabel: importanceLabels[task.importance],
    dueAt: task.dueAt.toISOString(),
    dueLabel: due.label,
    isOverdue: due.isOverdue,
    riskNote: task.riskNote,
    needsWeeklyReport: task.needsWeeklyReport,
    linkPath: routes.progress.task(task.id),
  };
}

function buildProjectItem(
  project: LoadedProject,
  now: Date,
): ProgressDailySummaryProjectItem {
  const currentStage = getCurrentStage(project);
  const projectDueAt = getProjectDueAt(project);
  const due = projectDueAt
    ? buildDueLabel(projectDueAt, now)
    : { label: "未设置", isOverdue: false, withinLookahead: false };
  const activeTasks = project.tasks.filter((task) =>
    ACTIVE_TASK_STATUSES.includes(task.status as (typeof ACTIVE_TASK_STATUSES)[number]),
  );
  return {
    projectId: project.id,
    name: project.name,
    status: project.status,
    statusLabel: projectStatusLabels[project.status],
    team: project.team,
    techGroup: project.techGroup,
    ownerNames: getProjectOwnerNames(project),
    currentStageName: currentStage?.name ?? "未配置",
    currentStageStatusLabel: currentStage
      ? stageStatusLabels[currentStage.status]
      : "未配置",
    projectDueAt: projectDueAt?.toISOString() ?? null,
    projectDueLabel: due.label,
    activeTaskCount: activeTasks.length,
    overdueTaskCount: activeTasks.filter((task) => task.dueAt < now).length,
    pendingAcceptanceTaskCount: activeTasks.filter(
      (task) => task.status === "PENDING_ACCEPTANCE",
    ).length,
    riskCount:
      project.stages.filter((stage) => stage.riskNote).length +
      activeTasks.filter((task) => task.riskNote).length,
    linkPath: routes.progress.project(project.id),
  };
}

function buildTaskDdlItem(
  task: ProgressDailySummaryTaskItem,
): ProgressDailySummaryDdlItem | null {
  if (!isImportantDueLabel(task.dueLabel)) return null;
  return {
    kind: "TASK",
    id: `task:${task.taskId}`,
    title: task.title,
    projectName: task.projectName,
    stageName: task.stageName,
    dueAt: task.dueAt,
    dueLabel: task.dueLabel,
    isOverdue: task.isOverdue,
    linkPath: task.linkPath,
  };
}

function buildProjectDdlItems(
  project: LoadedProject,
  now: Date,
): ProgressDailySummaryDdlItem[] {
  const items: ProgressDailySummaryDdlItem[] = [];
  const projectDueAt = getProjectDueAt(project);
  if (projectDueAt) {
    const due = buildDueLabel(projectDueAt, now);
    if (due.withinLookahead || due.isOverdue) {
      items.push({
        kind: "PROJECT",
        id: `project:${project.id}`,
        title: `${project.name} 项目 DDL`,
        projectName: project.name,
        dueAt: projectDueAt.toISOString(),
        dueLabel: due.label,
        isOverdue: due.isOverdue,
        linkPath: routes.progress.project(project.id),
      });
    }
  }

  for (const stage of project.stages) {
    if (!stage.dueAt || stage.status === "COMPLETED") continue;
    const due = buildDueLabel(stage.dueAt, now);
    if (!due.withinLookahead && !due.isOverdue) continue;
    items.push({
      kind: "STAGE",
      id: `stage:${stage.id}`,
      title: stage.name,
      projectName: project.name,
      stageName: stage.name,
      dueAt: stage.dueAt.toISOString(),
      dueLabel: due.label,
      isOverdue: due.isOverdue,
      linkPath: routes.progress.projectStage(project.id, stage.id),
    });
  }
  return items;
}

function getCurrentStage(project: LoadedProject) {
  return (
    project.stages.find((stage) => stage.status === "IN_PROGRESS") ??
    project.stages.find((stage) => stage.status === "PENDING_ACCEPTANCE") ??
    project.stages.find((stage) => stage.status === "NOT_STARTED") ??
    project.stages[project.stages.length - 1] ??
    null
  );
}

function getProjectDueAt(project: LoadedProject): Date | null {
  const stagesWithDueAt = project.stages.filter((stage) => !!stage.dueAt);
  return stagesWithDueAt[stagesWithDueAt.length - 1]?.dueAt ?? null;
}

function compareTaskItems(
  left: ProgressDailySummaryTaskItem,
  right: ProgressDailySummaryTaskItem,
) {
  return (
    Number(right.isOverdue) - Number(left.isOverdue) ||
    taskStatusPriority(left.status) - taskStatusPriority(right.status) ||
    new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime() ||
    urgencyPriority(left.urgency) - urgencyPriority(right.urgency) ||
    importancePriority(left.importance) - importancePriority(right.importance)
  );
}

function compareProjectItems(
  left: ProgressDailySummaryProjectItem,
  right: ProgressDailySummaryProjectItem,
) {
  return (
    projectStatusPriority(left.status) - projectStatusPriority(right.status) ||
    right.overdueTaskCount - left.overdueTaskCount ||
    right.pendingAcceptanceTaskCount - left.pendingAcceptanceTaskCount ||
    (left.projectDueAt ? new Date(left.projectDueAt).getTime() : Infinity) -
      (right.projectDueAt ? new Date(right.projectDueAt).getTime() : Infinity)
  );
}

function compareDdlItems(
  left: ProgressDailySummaryDdlItem,
  right: ProgressDailySummaryDdlItem,
) {
  return (
    Number(right.isOverdue) - Number(left.isOverdue) ||
    new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime()
  );
}

function taskStatusPriority(status: TaskStatus): number {
  const priorities: Partial<Record<TaskStatus, number>> = {
    PENDING_ACCEPTANCE: 0,
    IN_PROGRESS: 1,
    TODO: 2,
  };
  return priorities[status] ?? 9;
}

function projectStatusPriority(status: ProjectStatus): number {
  const priorities: Partial<Record<ProjectStatus, number>> = {
    IN_PROGRESS: 0,
    NOT_STARTED: 1,
    ESTABLISHING: 2,
    ESTABLISHMENT_REJECTED: 3,
  };
  return priorities[status] ?? 9;
}

function urgencyPriority(value: Urgency): number {
  return { HIGH: 0, MEDIUM: 1, LOW: 2 }[value];
}

function importancePriority(value: Importance): number {
  return { HIGH: 0, MEDIUM: 1, LOW: 2 }[value];
}

function shouldIncludeRecipient(openId: string, filter: Set<string>): boolean {
  return !!openId && (filter.size === 0 || filter.has(openId));
}

function normalizeScheduleTime(value: string): string {
  const trimmed = value.trim();
  return SCHEDULE_TIME_PATTERN.test(trimmed)
    ? trimmed
    : DEFAULT_DAILY_SUMMARY_SCHEDULE_TIME;
}

function getDefaultDailySummaryScheduleTime(): string {
  return (
    parseLegacyDailySummaryCron(process.env.PROGRESS_DAILY_SUMMARY_CRON) ??
    DEFAULT_DAILY_SUMMARY_SCHEDULE_TIME
  );
}

function parseLegacyDailySummaryCron(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] =
    trimmed.split(/\s+/);
  if (rest.length > 0 || dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
    return null;
  }
  if (!/^\d{1,2}$/.test(hour ?? "") || !/^\d{1,2}$/.test(minute ?? "")) {
    return null;
  }
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  if (
    !Number.isInteger(hourNumber) ||
    !Number.isInteger(minuteNumber) ||
    hourNumber < 0 ||
    hourNumber > 23 ||
    minuteNumber < 0 ||
    minuteNumber > 59
  ) {
    return null;
  }
  return `${String(hourNumber).padStart(2, "0")}:${String(minuteNumber).padStart(
    2,
    "0",
  )}`;
}

function scheduleTimeMinutes(value: string): number {
  const [hour = "19", minute = "00"] = normalizeScheduleTime(value).split(":");
  return Number(hour) * 60 + Number(minute);
}

function localTimeMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return Number(byType.get("hour")) * 60 + Number(byType.get("minute"));
}

function buildDueLabel(date: Date, now: Date) {
  const diff = localDayNumber(date) - localDayNumber(now);
  const isOverdue = date.getTime() < now.getTime();
  const withinLookahead = diff >= 0 && diff <= DDL_LOOKAHEAD_DAYS;
  if (diff < 0) {
    return {
      label: `逾期 ${Math.abs(diff)} 天`,
      isOverdue,
      withinLookahead,
    };
  }
  if (diff === 0) {
    return {
      label: isOverdue ? "今日已逾期" : "今天截止",
      isOverdue,
      withinLookahead,
    };
  }
  if (diff === 1) return { label: "明天截止", isOverdue, withinLookahead };
  return { label: `${diff} 天后截止`, isOverdue, withinLookahead };
}

function isImportantDueLabel(label: string): boolean {
  if (label.startsWith("逾期")) return true;
  if (label === "今日已逾期" || label === "今天截止" || label === "明天截止") {
    return true;
  }
  const match = /^(\d+) 天后截止$/.exec(label);
  return match ? Number(match[1]) <= DDL_LOOKAHEAD_DAYS : false;
}

function localDayNumber(date: Date): number {
  const parts = localDateParts(date);
  return Math.floor(
    Date.UTC(parts.year, parts.month - 1, parts.day) / (24 * 60 * 60 * 1000),
  );
}

function localDateKey(date: Date): string {
  const parts = localDateParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(
    parts.day,
  ).padStart(2, "0")}`;
}

function localDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.get("year")),
    month: Number(byType.get("month")),
    day: Number(byType.get("day")),
  };
}
