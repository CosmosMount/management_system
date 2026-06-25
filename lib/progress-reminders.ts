import {
  type Prisma,
  type ProgressReminderKind,
  type Project,
  type ProjectOwner,
  type ProjectStage,
  type Task,
  type TaskAssignee,
  type TaskSubmission,
} from "@prisma/client";
import { enqueueProgressNotification } from "@/lib/notification-outbox";
import { getOpenIdsByRole } from "@/lib/permissions";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import type { NotificationContext } from "@/lib/app-origin";

const TIME_ZONE = "Asia/Shanghai";
const ACTIVE_TASK_STATUSES = ["TODO", "IN_PROGRESS", "PENDING_ACCEPTANCE"] as const;
const REMINDER_KIND = {
  TASK_OVERDUE: "TASK_OVERDUE",
  TASK_DUE_SOON: "TASK_DUE_SOON",
  TASK_PENDING_ACCEPTANCE_STALE: "TASK_PENDING_ACCEPTANCE_STALE",
  WEEKLY_REPORT_MISSING: "WEEKLY_REPORT_MISSING",
  TASK_STALE_ACTIVITY: "TASK_STALE_ACTIVITY",
  STAGE_STALE_OR_DUE_SOON: "STAGE_STALE_OR_DUE_SOON",
} as const satisfies Record<string, ProgressReminderKind>;

type ReminderParamDefinition = {
  key: string;
  label: string;
  min: number;
  max: number;
  unit: string;
};

type ReminderDefinition = {
  kind: ProgressReminderKind;
  label: string;
  description: string;
  defaultEnabled: boolean;
  defaultScheduleTime: string;
  defaultParams: Record<string, number>;
  paramDefinitions: ReminderParamDefinition[];
};

export type ProgressReminderRuleView = {
  kind: ProgressReminderKind;
  label: string;
  description: string;
  enabled: boolean;
  scheduleTime: string;
  params: Record<string, number>;
  paramDefinitions: ReminderParamDefinition[];
  lastRunAt: string | null;
  updatedAt: string | null;
};

export type ProgressReminderRuleUpdate = {
  kind: ProgressReminderKind;
  enabled: boolean;
  scheduleTime: string;
  params: Record<string, number>;
};

export type ProgressReminderScanResult = {
  rulesRun: number;
  queued: number;
  skipped?: boolean;
};

type ReminderRecipientConfig = {
  assignees: boolean;
  projectOwners: boolean;
  stageOwners: boolean;
  managers: boolean;
};

type ReminderEnqueueResult = {
  created: boolean;
  recipientCount: number;
};

export const PROGRESS_REMINDER_DEFINITIONS: ReminderDefinition[] = [
  {
    kind: REMINDER_KIND.TASK_OVERDUE,
    label: "任务逾期",
    description: "任务已超过截止时间且仍未结束时提醒。",
    defaultEnabled: true,
    defaultScheduleTime: "09:00",
    defaultParams: { cooldownHours: 24 },
    paramDefinitions: [
      { key: "cooldownHours", label: "同任务提醒冷却", min: 1, max: 168, unit: "小时" },
    ],
  },
  {
    kind: REMINDER_KIND.TASK_DUE_SOON,
    label: "任务临期",
    description: "任务将在指定天数内截止且仍未提交验收时提醒。",
    defaultEnabled: true,
    defaultScheduleTime: "09:00",
    defaultParams: { dueSoonDays: 2, cooldownHours: 24 },
    paramDefinitions: [
      { key: "dueSoonDays", label: "截止前提醒", min: 1, max: 30, unit: "天" },
      { key: "cooldownHours", label: "同任务提醒冷却", min: 1, max: 168, unit: "小时" },
    ],
  },
  {
    kind: REMINDER_KIND.TASK_PENDING_ACCEPTANCE_STALE,
    label: "待验收停留",
    description: "任务提交交付后长时间未验收时提醒。",
    defaultEnabled: true,
    defaultScheduleTime: "09:00",
    defaultParams: { pendingDays: 2, cooldownHours: 24 },
    paramDefinitions: [
      { key: "pendingDays", label: "待验收超过", min: 1, max: 30, unit: "天" },
      { key: "cooldownHours", label: "同任务提醒冷却", min: 1, max: 168, unit: "小时" },
    ],
  },
  {
    kind: REMINDER_KIND.WEEKLY_REPORT_MISSING,
    label: "周报未交",
    description: "要求周报的活跃任务在每周指定时间后仍未提交本周周报时提醒。",
    defaultEnabled: true,
    defaultScheduleTime: "18:00",
    defaultParams: { weekday: 5, cooldownHours: 24 },
    paramDefinitions: [
      { key: "weekday", label: "每周提醒日", min: 1, max: 7, unit: "周一=1" },
      { key: "cooldownHours", label: "同任务提醒冷却", min: 1, max: 168, unit: "小时" },
    ],
  },
  {
    kind: REMINDER_KIND.TASK_STALE_ACTIVITY,
    label: "任务长期无动态",
    description: "活跃任务长时间没有进度动态时提醒。",
    defaultEnabled: true,
    defaultScheduleTime: "09:00",
    defaultParams: { staleDays: 5, cooldownHours: 24 },
    paramDefinitions: [
      { key: "staleDays", label: "无动态超过", min: 1, max: 60, unit: "天" },
      { key: "cooldownHours", label: "同任务提醒冷却", min: 1, max: 168, unit: "小时" },
    ],
  },
  {
    kind: REMINDER_KIND.STAGE_STALE_OR_DUE_SOON,
    label: "当前阶段临期/停滞",
    description: "进行中阶段临近截止或长时间没有阶段动态时提醒。",
    defaultEnabled: true,
    defaultScheduleTime: "09:00",
    defaultParams: { dueSoonDays: 3, staleDays: 5, cooldownHours: 24 },
    paramDefinitions: [
      { key: "dueSoonDays", label: "截止前提醒", min: 1, max: 30, unit: "天" },
      { key: "staleDays", label: "无动态超过", min: 1, max: 60, unit: "天" },
      { key: "cooldownHours", label: "同阶段提醒冷却", min: 1, max: 168, unit: "小时" },
    ],
  },
];

const definitionByKind = new Map(
  PROGRESS_REMINDER_DEFINITIONS.map((definition) => [
    definition.kind,
    definition,
  ]),
);
let progressReminderScanRunning = false;

export function isProgressReminderKind(value: string): value is ProgressReminderKind {
  return definitionByKind.has(value as ProgressReminderKind);
}

export async function getProgressReminderRuleViews(): Promise<
  ProgressReminderRuleView[]
> {
  const records = await prisma.progressReminderRule.findMany();
  const byKind = new Map(records.map((record) => [record.kind, record]));

  return PROGRESS_REMINDER_DEFINITIONS.map((definition) => {
    const record = byKind.get(definition.kind);
    return {
      kind: definition.kind,
      label: definition.label,
      description: definition.description,
      enabled: record?.enabled ?? definition.defaultEnabled,
      scheduleTime: normalizeScheduleTime(
        record?.scheduleTime ?? definition.defaultScheduleTime,
        definition.defaultScheduleTime,
      ),
      params: sanitizeParams(definition, parseJsonRecord(record?.paramsJson)),
      paramDefinitions: definition.paramDefinitions,
      lastRunAt: record?.lastRunAt?.toISOString() ?? null,
      updatedAt: record?.updatedAt?.toISOString() ?? null,
    };
  });
}

export async function saveProgressReminderRules(
  rules: ProgressReminderRuleUpdate[],
) {
  for (const rule of rules) {
    const definition = definitionByKind.get(rule.kind);
    if (!definition) continue;
    const params = sanitizeParams(definition, rule.params);
    await prisma.progressReminderRule.upsert({
      where: { kind: rule.kind },
      create: {
        kind: rule.kind,
        enabled: !!rule.enabled,
        scheduleTime: normalizeScheduleTime(
          rule.scheduleTime,
          definition.defaultScheduleTime,
        ),
        paramsJson: JSON.stringify(params),
        recipientConfigJson: JSON.stringify(defaultRecipientConfig()),
      },
      update: {
        enabled: !!rule.enabled,
        scheduleTime: normalizeScheduleTime(
          rule.scheduleTime,
          definition.defaultScheduleTime,
        ),
        paramsJson: JSON.stringify(params),
      },
    });
  }
}

export async function seedDefaultProgressReminderRules() {
  for (const definition of PROGRESS_REMINDER_DEFINITIONS) {
    await prisma.progressReminderRule.upsert({
      where: { kind: definition.kind },
      create: {
        kind: definition.kind,
        enabled: definition.defaultEnabled,
        scheduleTime: definition.defaultScheduleTime,
        paramsJson: JSON.stringify(definition.defaultParams),
        recipientConfigJson: JSON.stringify(defaultRecipientConfig()),
      },
      update: {},
    });
  }
}

export async function runDueProgressReminderRules({
  force = false,
  now = new Date(),
  context,
}: {
  force?: boolean;
  now?: Date;
  context?: NotificationContext;
} = {}): Promise<ProgressReminderScanResult> {
  if (progressReminderScanRunning) {
    return { rulesRun: 0, queued: 0, skipped: true };
  }

  progressReminderScanRunning = true;
  try {
    await seedDefaultProgressReminderRules();
    const rules = await prisma.progressReminderRule.findMany();
    let rulesRun = 0;
    let queued = 0;

    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (!force && !isRuleDue(rule.scheduleTime, rule.lastRunAt, now)) continue;
      const definition = definitionByKind.get(rule.kind);
      if (!definition) continue;

      const params = sanitizeParams(definition, parseJsonRecord(rule.paramsJson));
      const recipientConfig = sanitizeRecipientConfig(
        parseJsonRecord(rule.recipientConfigJson),
      );
      const result = await runReminderRule(
        rule.kind,
        params,
        recipientConfig,
        now,
        context,
      );
      rulesRun++;
      queued += result;
      await prisma.progressReminderRule.update({
        where: { id: rule.id },
        data: { lastRunAt: now },
      });
    }

    return { rulesRun, queued };
  } finally {
    progressReminderScanRunning = false;
  }
}

export async function sendManualProjectReminder({
  projectId,
  actorName,
  message,
  context,
}: {
  projectId: string;
  actorName: string;
  message?: string;
  context?: NotificationContext;
}): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      stages: { orderBy: { sortOrder: "asc" } },
      tasks: {
        where: { deletedAt: null },
        include: { assignees: true },
      },
    },
  });
  if (!project) throw new Error("项目不存在");

  const currentStage =
    project.stages.find((stage) =>
      ["IN_PROGRESS", "PENDING_ACCEPTANCE"].includes(stage.status),
    ) ?? project.stages.find((stage) => stage.status === "NOT_STARTED");
  const unfinishedTasks = project.tasks.filter((task) =>
    ACTIVE_TASK_STATUSES.includes(task.status as (typeof ACTIVE_TASK_STATUSES)[number]),
  );
  const overdueTasks = unfinishedTasks.filter((task) => task.isOverdue).length;
  const pendingTasks = unfinishedTasks.filter(
    (task) => task.status === "PENDING_ACCEPTANCE",
  ).length;
  const recipientOpenIds = await collectProjectRecipientOpenIds(
    project,
    defaultRecipientConfig(),
  );
  const reason = [
    currentStage ? `当前阶段：${currentStage.name}` : "当前阶段：未配置",
    `未完成任务：${unfinishedTasks.length}`,
    `逾期任务：${overdueTasks}`,
    `待验收任务：${pendingTasks}`,
  ].join("\n");

  const queued = await enqueueReminder({
    eventKey: `progress:manual_reminder:PROJECT:${project.id}:${minuteBucket(new Date())}`,
    targetType: "PROJECT",
    targetId: project.id,
    projectId: project.id,
    projectName: project.name,
    title: "项目催促",
    reason,
    actorName,
    message,
    recipientOpenIds,
    linkPath: routes.progress.project(project.id),
    context,
  });
  if (queued.recipientCount === 0) throw new Error("没有可通知的收件人");
  if (!queued.created) throw new Error("该项目刚刚已经催促过，请稍后再试");
  return queued.created;
}

export async function sendManualTaskReminder({
  taskId,
  actorName,
  message,
  context,
}: {
  taskId: string;
  actorName: string;
  message?: string;
  context?: NotificationContext;
}): Promise<boolean> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      assignees: true,
      stage: true,
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
    },
  });
  if (!task || task.deletedAt) throw new Error("任务不存在");

  const recipientOpenIds = await collectTaskRecipientOpenIds(
    task,
    defaultRecipientConfig(),
  );
  const reason = [
    `任务状态：${task.status}`,
    `所属阶段：${task.stage?.name ?? "无阶段"}`,
    `截止时间：${task.dueAt.toLocaleString("zh-CN")}`,
    task.isOverdue ? "当前标记：已逾期" : null,
  ]
    .filter(Boolean)
    .join("\n");

  const queued = await enqueueReminder({
    eventKey: `progress:manual_reminder:TASK:${task.id}:${minuteBucket(new Date())}`,
    targetType: "TASK",
    targetId: task.id,
    taskId: task.id,
    projectId: task.projectId,
    projectName: task.project.name,
    taskTitle: task.title,
    stageName: task.stage?.name ?? "无阶段",
    title: "任务催促",
    reason,
    actorName,
    message,
    recipientOpenIds,
    linkPath: routes.progress.task(task.id),
    context,
  });
  if (queued.recipientCount === 0) throw new Error("没有可通知的收件人");
  if (!queued.created) throw new Error("该任务刚刚已经催促过，请稍后再试");
  return queued.created;
}

async function runReminderRule(
  kind: ProgressReminderKind,
  params: Record<string, number>,
  recipientConfig: ReminderRecipientConfig,
  now: Date,
  context?: NotificationContext,
): Promise<number> {
  switch (kind) {
    case REMINDER_KIND.TASK_OVERDUE:
      return enqueueTaskOverdueReminders(params, recipientConfig, now, context);
    case REMINDER_KIND.TASK_DUE_SOON:
      return enqueueTaskDueSoonReminders(params, recipientConfig, now, context);
    case REMINDER_KIND.TASK_PENDING_ACCEPTANCE_STALE:
      return enqueuePendingAcceptanceReminders(
        params,
        recipientConfig,
        now,
        context,
      );
    case REMINDER_KIND.WEEKLY_REPORT_MISSING:
      return enqueueWeeklyReportMissingReminders(
        params,
        recipientConfig,
        now,
        context,
      );
    case REMINDER_KIND.TASK_STALE_ACTIVITY:
      return enqueueTaskStaleActivityReminders(
        params,
        recipientConfig,
        now,
        context,
      );
    case REMINDER_KIND.STAGE_STALE_OR_DUE_SOON:
      return enqueueStageReminders(params, recipientConfig, now, context);
  }
}

async function enqueueTaskOverdueReminders(
  params: Record<string, number>,
  recipientConfig: ReminderRecipientConfig,
  now: Date,
  context?: NotificationContext,
): Promise<number> {
  const tasks = await findReminderTasks({
    dueAt: { lt: now },
    status: { in: [...ACTIVE_TASK_STATUSES] },
  });
  if (tasks.length > 0) {
    await prisma.task.updateMany({
      where: { id: { in: tasks.map((task) => task.id) }, isOverdue: false },
      data: { isOverdue: true },
    });
  }

  let queued = 0;
  for (const task of tasks) {
    queued += await enqueueTaskReminder({
      kind: REMINDER_KIND.TASK_OVERDUE,
      task,
      now,
      cooldownHours: params.cooldownHours,
      recipientConfig,
      title: "任务逾期提醒",
      reason: `任务已超过截止时间：${task.dueAt.toLocaleString("zh-CN")}`,
      context,
    });
  }
  return queued;
}

async function enqueueTaskDueSoonReminders(
  params: Record<string, number>,
  recipientConfig: ReminderRecipientConfig,
  now: Date,
  context?: NotificationContext,
): Promise<number> {
  const dueSoonAt = addDays(now, params.dueSoonDays);
  const tasks = await findReminderTasks({
    dueAt: { gte: now, lte: dueSoonAt },
    status: { in: ["TODO", "IN_PROGRESS"] },
  });

  let queued = 0;
  for (const task of tasks) {
    queued += await enqueueTaskReminder({
      kind: REMINDER_KIND.TASK_DUE_SOON,
      task,
      now,
      cooldownHours: params.cooldownHours,
      recipientConfig,
      title: "任务临期提醒",
      reason: `任务将在 ${params.dueSoonDays} 天内截止：${task.dueAt.toLocaleString("zh-CN")}`,
      context,
    });
  }
  return queued;
}

async function enqueuePendingAcceptanceReminders(
  params: Record<string, number>,
  recipientConfig: ReminderRecipientConfig,
  now: Date,
  context?: NotificationContext,
): Promise<number> {
  const cutoff = addDays(now, -params.pendingDays);
  const tasks = await findReminderTasks(
    { status: "PENDING_ACCEPTANCE" },
    {
      submissions: {
        where: { type: "DELIVERY" },
        orderBy: { submittedAt: "desc" },
        take: 1,
      },
    },
  );

  let queued = 0;
  for (const task of tasks) {
    const latestSubmission = (task.submissions ?? [])[0];
    if (!latestSubmission || latestSubmission.submittedAt > cutoff) continue;
    queued += await enqueueTaskReminder({
      kind: REMINDER_KIND.TASK_PENDING_ACCEPTANCE_STALE,
      task,
      now,
      cooldownHours: params.cooldownHours,
      recipientConfig,
      title: "任务待验收提醒",
      reason: `任务已提交验收超过 ${params.pendingDays} 天，请及时处理。`,
      context,
    });
  }
  return queued;
}

async function enqueueWeeklyReportMissingReminders(
  params: Record<string, number>,
  recipientConfig: ReminderRecipientConfig,
  now: Date,
  context?: NotificationContext,
): Promise<number> {
  if (!isWeeklyReminderWindow(now, params.weekday)) return 0;
  const weekStart = getWeekStart(now);
  const tasks = await findReminderTasks(
    {
      needsWeeklyReport: true,
      status: { in: [...ACTIVE_TASK_STATUSES] },
    },
    {
      weeklyReports: {
        where: { weekStart },
        take: 1,
      },
    },
  );

  let queued = 0;
  for (const task of tasks) {
    if ((task.weeklyReports ?? []).length > 0) continue;
    queued += await enqueueTaskReminder({
      kind: REMINDER_KIND.WEEKLY_REPORT_MISSING,
      task,
      now,
      cooldownHours: params.cooldownHours,
      recipientConfig,
      eventKey: weeklyReminderEventKey(
        REMINDER_KIND.WEEKLY_REPORT_MISSING,
        task.id,
        weekStart,
      ),
      title: "周报未交提醒",
      reason: "该任务本周尚未提交进度周报。",
      context,
    });
  }
  return queued;
}

async function enqueueTaskStaleActivityReminders(
  params: Record<string, number>,
  recipientConfig: ReminderRecipientConfig,
  now: Date,
  context?: NotificationContext,
): Promise<number> {
  const cutoff = addDays(now, -params.staleDays);
  const tasks = await findReminderTasks(
    { status: { in: [...ACTIVE_TASK_STATUSES] } },
    {
      activityLogs: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  );

  let queued = 0;
  for (const task of tasks) {
    const lastActivity = (task.activityLogs ?? [])[0]?.createdAt ?? task.createdAt;
    if (lastActivity > cutoff) continue;
    queued += await enqueueTaskReminder({
      kind: REMINDER_KIND.TASK_STALE_ACTIVITY,
      task,
      now,
      cooldownHours: params.cooldownHours,
      recipientConfig,
      title: "任务长期无动态提醒",
      reason: `任务超过 ${params.staleDays} 天没有进度动态。`,
      context,
    });
  }
  return queued;
}

async function enqueueStageReminders(
  params: Record<string, number>,
  recipientConfig: ReminderRecipientConfig,
  now: Date,
  context?: NotificationContext,
): Promise<number> {
  const dueSoonAt = addDays(now, params.dueSoonDays);
  const staleCutoff = addDays(now, -params.staleDays);
  const stages = await prisma.projectStage.findMany({
    where: {
      status: { in: ["IN_PROGRESS", "PENDING_ACCEPTANCE"] },
      project: { status: "IN_PROGRESS" },
    },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          tasks: {
            where: { deletedAt: null },
            include: { assignees: true },
          },
        },
      },
    },
  });

  let queued = 0;
  for (const stage of stages) {
    const reasons: string[] = [];
    if (stage.dueAt && stage.dueAt >= now && stage.dueAt <= dueSoonAt) {
      reasons.push(
        `阶段将在 ${params.dueSoonDays} 天内截止：${stage.dueAt.toLocaleString("zh-CN")}`,
      );
    }
    const recentStageActivity = await prisma.progressActivityLog.findFirst({
      where: {
        projectId: stage.projectId,
        payload: { contains: `"stageId":"${stage.id}"` },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const lastActivity = recentStageActivity?.createdAt ?? stage.updatedAt;
    if (lastActivity <= staleCutoff) {
      reasons.push(`阶段超过 ${params.staleDays} 天没有阶段动态。`);
    }
    if (reasons.length === 0) continue;

    const recipientOpenIds = await collectStageRecipientOpenIds(
      stage,
      recipientConfig,
    );
    const enqueued = await enqueueReminder({
      eventKey: reminderEventKey(
        REMINDER_KIND.STAGE_STALE_OR_DUE_SOON,
        stage.id,
        now,
        params.cooldownHours,
      ),
      targetType: "PROJECT",
      targetId: stage.projectId,
      projectId: stage.projectId,
      projectName: stage.project.name,
      stageName: stage.name,
      title: "项目阶段提醒",
      reason: reasons.join("\n"),
      recipientOpenIds,
      linkPath: routes.progress.projectStage(stage.projectId, stage.id),
      context,
    });
    if (enqueued.created) queued++;
  }
  return queued;
}

type ReminderTask = Task & {
  project: Project & { owners: ProjectOwner[] };
  stage: ProjectStage | null;
  assignees: TaskAssignee[];
  submissions?: TaskSubmission[];
  weeklyReports?: Array<{ id: string }>;
  activityLogs?: Array<{ createdAt: Date }>;
};

async function findReminderTasks(
  where: Prisma.TaskWhereInput,
  extraInclude: Prisma.TaskInclude = {},
): Promise<ReminderTask[]> {
  const tasks = await prisma.task.findMany({
    where: {
      deletedAt: null,
      project: { status: { notIn: ["COMPLETED", "CANCELED"] } },
      ...where,
    },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      stage: true,
      assignees: true,
      ...extraInclude,
    },
    orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
  });
  return tasks as unknown as ReminderTask[];
}

async function enqueueTaskReminder({
  kind,
  task,
  now,
  cooldownHours,
  recipientConfig,
  eventKey,
  title,
  reason,
  context,
}: {
  kind: ProgressReminderKind;
  task: ReminderTask;
  now: Date;
  cooldownHours: number;
  recipientConfig: ReminderRecipientConfig;
  eventKey?: string;
  title: string;
  reason: string;
  context?: NotificationContext;
}): Promise<number> {
  const recipientOpenIds = await collectTaskRecipientOpenIds(task, recipientConfig);
  const queued = await enqueueReminder({
    eventKey: eventKey ?? reminderEventKey(kind, task.id, now, cooldownHours),
    targetType: "TASK",
    targetId: task.id,
    taskId: task.id,
    projectId: task.projectId,
    projectName: task.project.name,
    taskTitle: task.title,
    stageName: task.stage?.name ?? "无阶段",
    title,
    reason,
    recipientOpenIds,
    linkPath: routes.progress.task(task.id),
    context,
  });
  return queued.created ? 1 : 0;
}

async function enqueueReminder({
  eventKey,
  targetType,
  targetId,
  projectId,
  taskId,
  projectName,
  taskTitle,
  stageName,
  title,
  reason,
  actorName,
  message,
  recipientOpenIds,
  linkPath,
  context,
}: {
  eventKey: string;
  targetType: "PROJECT" | "TASK";
  targetId: string;
  projectId?: string;
  taskId?: string;
  projectName: string;
  taskTitle?: string;
  stageName?: string;
  title: string;
  reason: string;
  actorName?: string;
  message?: string;
  recipientOpenIds: string[];
  linkPath: string;
  context?: NotificationContext;
}): Promise<ReminderEnqueueResult> {
  const uniqueOpenIds = [...new Set(recipientOpenIds.filter(Boolean))];
  if (uniqueOpenIds.length === 0) {
    return { created: false, recipientCount: 0 };
  }

  const result = await enqueueProgressNotification(
    eventKey,
    {
      type: "progress_reminder",
      targetType,
      targetId,
      projectId,
      taskId,
      projectName,
      taskTitle,
      stageName,
      title,
      reason,
      actorName,
      message,
      recipientOpenIds: uniqueOpenIds,
      linkPath,
    },
    context,
  );
  return { created: result.created, recipientCount: uniqueOpenIds.length };
}

async function collectTaskRecipientOpenIds(
  task: Task & {
    project: Project & { owners: ProjectOwner[] };
    stage?: ProjectStage | null;
    assignees: TaskAssignee[];
  },
  config: ReminderRecipientConfig,
): Promise<string[]> {
  const openIds: string[] = [];
  if (config.assignees) {
    openIds.push(...getTaskAssigneeOpenIds(task));
  }
  if (config.projectOwners) {
    openIds.push(...getProjectOwnerOpenIds(task.project));
  }
  if (config.stageOwners && task.stage?.ownerOpenId) {
    openIds.push(task.stage.ownerOpenId);
  }
  if (config.managers) {
    openIds.push(
      ...(await roleOpenIds({ team: task.team, techGroup: task.techGroup })),
    );
  }
  return openIds;
}

async function collectProjectRecipientOpenIds(
  project: Project & {
    owners: ProjectOwner[];
    stages: ProjectStage[];
    tasks: Array<Task & { assignees: TaskAssignee[] }>;
  },
  config: ReminderRecipientConfig,
): Promise<string[]> {
  const activeTasks = project.tasks.filter((task) =>
    ACTIVE_TASK_STATUSES.includes(task.status as (typeof ACTIVE_TASK_STATUSES)[number]),
  );
  const openIds: string[] = [];
  if (config.projectOwners) {
    openIds.push(...getProjectOwnerOpenIds(project));
  }
  if (config.stageOwners) {
    openIds.push(...project.stages.map((stage) => stage.ownerOpenId).filter(Boolean));
  }
  if (config.assignees) {
    openIds.push(...activeTasks.flatMap((task) => getTaskAssigneeOpenIds(task)));
  }
  if (config.managers) {
    openIds.push(
      ...(await roleOpenIds({ team: project.team, techGroup: project.techGroup })),
    );
  }
  return [
    ...new Set(openIds.filter(Boolean)),
  ];
}

async function collectStageRecipientOpenIds(
  stage: ProjectStage & {
    project: Project & {
      owners: ProjectOwner[];
      tasks: Array<Task & { assignees: TaskAssignee[] }>;
    };
  },
  config: ReminderRecipientConfig,
): Promise<string[]> {
  const stageTasks = stage.project.tasks.filter(
    (task) =>
      task.stageId === stage.id &&
      ACTIVE_TASK_STATUSES.includes(
        task.status as (typeof ACTIVE_TASK_STATUSES)[number],
      ),
  );
  const openIds: string[] = [];
  if (config.stageOwners && stage.ownerOpenId) {
    openIds.push(stage.ownerOpenId);
  }
  if (config.projectOwners) {
    openIds.push(...getProjectOwnerOpenIds(stage.project));
  }
  if (config.assignees) {
    openIds.push(...stageTasks.flatMap((task) => getTaskAssigneeOpenIds(task)));
  }
  if (config.managers) {
    openIds.push(
      ...(await roleOpenIds({
        team: stage.project.team,
        techGroup: stage.project.techGroup,
      })),
    );
  }
  return [...new Set(openIds.filter(Boolean))];
}

async function roleOpenIds(scope: { team: string; techGroup: string }) {
  const roleSets = await Promise.all([
    getOpenIdsByRole("TEAM_ADMIN", scope),
    getOpenIdsByRole("TECH_GROUP_ADMIN", scope),
    getOpenIdsByRole("PROJECT_MANAGER", scope),
    getOpenIdsByRole("SUPER_ADMIN", scope),
  ]);
  return roleSets.flat();
}

function sanitizeParams(
  definition: ReminderDefinition,
  value?: Record<string, unknown> | null,
): Record<string, number> {
  return Object.fromEntries(
    definition.paramDefinitions.map((param) => {
      const raw = Number(value?.[param.key] ?? definition.defaultParams[param.key]);
      const normalized = Number.isFinite(raw) ? Math.round(raw) : param.min;
      return [param.key, Math.min(param.max, Math.max(param.min, normalized))];
    }),
  );
}

function parseJsonRecord(value?: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sanitizeRecipientConfig(
  value?: Record<string, unknown> | null,
): ReminderRecipientConfig {
  const defaults = defaultRecipientConfig();
  return {
    assignees:
      typeof value?.assignees === "boolean" ? value.assignees : defaults.assignees,
    projectOwners:
      typeof value?.projectOwners === "boolean"
        ? value.projectOwners
        : defaults.projectOwners,
    stageOwners:
      typeof value?.stageOwners === "boolean"
        ? value.stageOwners
        : defaults.stageOwners,
    managers:
      typeof value?.managers === "boolean" ? value.managers : defaults.managers,
  };
}

function defaultRecipientConfig(): ReminderRecipientConfig {
  return {
    assignees: true,
    projectOwners: true,
    stageOwners: true,
    managers: true,
  };
}

function normalizeScheduleTime(value: string, fallback: string): string {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function isRuleDue(scheduleTime: string, lastRunAt: Date | null, now: Date) {
  if (!isAfterScheduleTime(now, scheduleTime)) return false;
  if (!lastRunAt) return true;
  return localDateKey(lastRunAt) !== localDateKey(now);
}

function isAfterScheduleTime(now: Date, scheduleTime: string) {
  const [hour, minute] = scheduleTime.split(":").map(Number);
  const parts = localDateParts(now);
  return parts.hour > hour || (parts.hour === hour && parts.minute >= minute);
}

function isWeeklyReminderWindow(now: Date, weekday: number) {
  const localWeekday = localDateParts(now).weekday;
  return localWeekday === weekday;
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
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const weekdayText = byType.get("weekday") ?? "Mon";
  return {
    year: Number(byType.get("year")),
    month: Number(byType.get("month")),
    day: Number(byType.get("day")),
    hour: Number(byType.get("hour")),
    minute: Number(byType.get("minute")),
    weekday:
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
        weekdayText,
      ) + 1,
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function getWeekStart(date = new Date()): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function reminderEventKey(
  kind: ProgressReminderKind,
  targetId: string,
  now: Date,
  cooldownHours: number,
) {
  const bucketMs = cooldownHours * 60 * 60 * 1000;
  const bucket = Math.floor(now.getTime() / bucketMs);
  return `progress:reminder:${kind}:${targetId}:${bucket}`;
}

function weeklyReminderEventKey(
  kind: ProgressReminderKind,
  targetId: string,
  weekStart: Date,
) {
  return `progress:reminder:${kind}:${targetId}:week:${localDateKey(weekStart)}`;
}

function minuteBucket(date: Date) {
  const parts = localDateParts(date);
  return `${localDateKey(date)}-${String(parts.hour).padStart(2, "0")}${String(
    parts.minute,
  ).padStart(2, "0")}`;
}
