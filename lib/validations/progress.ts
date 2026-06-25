import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import { z } from "zod";

const teamSchema = z
  .enum(TEAM_OPTIONS, { message: "请选择有效车组" })
  .optional()
  .or(z.literal(""));

const techGroupSchema = z
  .enum(TECH_GROUP_OPTIONS, { message: "请选择有效技术组" })
  .optional()
  .or(z.literal(""));

const projectOwnerOpenIdsSchema = z.array(z.string()).optional();
export const MAX_ACCEPTANCE_CHECKLIST_ITEMS = 20;
export const MAX_ACCEPTANCE_CHECKLIST_ITEM_LENGTH = 200;

const acceptanceChecklistItemSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "验收条例不能为空")
    .max(
      MAX_ACCEPTANCE_CHECKLIST_ITEM_LENGTH,
      `验收条例不能超过 ${MAX_ACCEPTANCE_CHECKLIST_ITEM_LENGTH} 个字符`,
    ),
});

const acceptanceChecklistItemsSchema = z
  .array(acceptanceChecklistItemSchema)
  .max(
    MAX_ACCEPTANCE_CHECKLIST_ITEMS,
    `验收条例最多 ${MAX_ACCEPTANCE_CHECKLIST_ITEMS} 条`,
  )
  .optional();

const dateTimeStringSchema = (message: string) =>
  z.string().min(1, message).refine(
    (value) => !Number.isNaN(new Date(value).getTime()),
    "请输入有效时间",
  );

function validateProjectScopeAndOwners(
  value: { team?: string; techGroup?: string; ownerOpenId?: string; ownerOpenIds?: string[] },
  ctx: z.RefinementCtx,
) {
  const ownerOpenIds =
    value.ownerOpenIds?.filter(Boolean) ??
    (value.ownerOpenId ? [value.ownerOpenId] : []);
  if (ownerOpenIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["ownerOpenIds"],
      message: "请选择项目负责人",
    });
  }
  if (!value.team && !value.techGroup) {
    ctx.addIssue({
      code: "custom",
      path: ["team"],
      message: "车组和技术组至少选择一个",
    });
  }
}

const projectBaseSchema = z.object({
  name: z.string().min(1, "请输入项目名称"),
  description: z.string().optional(),
  team: teamSchema,
  techGroup: techGroupSchema,
  ownerOpenId: z.string().optional(),
  ownerOpenIds: projectOwnerOpenIdsSchema,
  allowOwnerSelfApproval: z.boolean().default(false),
});

export const createProjectSchema = projectBaseSchema.extend({
  template: z.enum(["real-car", "custom"]).default("real-car"),
  stages: z
    .array(
      z.object({
        name: z.string().min(1, "阶段名称不能为空"),
        goal: z.string().min(1, "请填写阶段目标"),
        ownerOpenId: z.string().min(1, "请选择阶段负责人"),
        dueAt: dateTimeStringSchema("请选择阶段 DDL"),
      }),
    )
    .min(1, "至少添加一个阶段"),
}).superRefine((value, ctx) => {
  validateProjectScopeAndOwners(value, ctx);
});

export const updateProjectSchema = projectBaseSchema.extend({
  projectId: z.string().min(1),
  expectedUpdatedAt: z.string().min(1, "缺少项目版本信息"),
}).superRefine((value, ctx) => {
  validateProjectScopeAndOwners(value, ctx);
});

function validateTaskAssignees(
  value: { assigneeOpenId?: string; assigneeOpenIds?: string[] },
  ctx: z.RefinementCtx,
) {
  const assigneeOpenIds =
    value.assigneeOpenIds?.filter(Boolean) ??
    (value.assigneeOpenId ? [value.assigneeOpenId] : []);
  if (assigneeOpenIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["assigneeOpenIds"],
      message: "请选择负责人",
    });
  }
}

const taskBaseSchema = z.object({
  projectId: z.string().min(1),
  stageId: z.string().optional().or(z.literal("")),
  title: z.string().min(1, "请输入任务目标"),
  goal: z.string().optional(),
  category: z.enum([
    "TEST",
    "ASSEMBLY",
    "RND",
    "DEBUG",
    "REVIEW_DRAWING",
    "ITERATION",
  ]),
  urgency: z.enum(["HIGH", "MEDIUM", "LOW"]),
  importance: z.enum(["HIGH", "MEDIUM", "LOW"]),
  assigneeOpenId: z.string().optional(),
  assigneeOpenIds: z.array(z.string()).optional(),
  metrics: z.string().min(1, "请填写指标"),
  dueAt: dateTimeStringSchema("请选择截止时间"),
  needsOfflineConfirmation: z.boolean().default(false),
  needsWeeklyReport: z.boolean().default(false),
  acceptanceChecklistItems: acceptanceChecklistItemsSchema,
});

export const createTaskSchema = taskBaseSchema.superRefine((value, ctx) => {
  validateTaskAssignees(value, ctx);
});

export const updateTaskSchema = taskBaseSchema.extend({
  taskId: z.string().min(1),
  expectedUpdatedAt: z.string().min(1, "缺少任务版本信息"),
}).superRefine((value, ctx) => {
  validateTaskAssignees(value, ctx);
});

export const submitDeliverySchema = z.object({
  taskId: z.string().min(1),
  feishuDocUrl: z.string().url("请输入有效的飞书文档链接"),
  keyDataUrl: z.string().url("请输入有效的关键数据链接"),
  note: z.string().optional(),
  failureReason: z.string().optional(),
});

export const submitWeeklyReportSchema = z.object({
  taskId: z.string().min(1),
  progress: z.string().min(1, "请填写本周进度"),
  risks: z.string().optional(),
  nextPlan: z.string().optional(),
  feishuDocUrl: z.string().url().optional().or(z.literal("")),
});

export const stageSubmitSchema = z.object({
  projectId: z.string().min(1),
  stageId: z.string().min(1),
  evidenceUrl: z.string().url("请输入有效的文档或归档链接"),
  note: z.string().optional(),
});

export const approvalSchema = z.object({
  submissionId: z.string().min(1),
  comment: z.string().optional(),
  offlineConfirmed: z.boolean().default(false),
  checkedChecklistItemIds: z.array(z.string()).optional(),
});

export const riskSyncSchema = z.object({
  taskId: z.string().min(1),
  riskNote: z.string().trim().min(1, "请填写风险说明").max(1000),
});

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type UpdateProjectInput = z.input<typeof updateProjectSchema>;
export type CreateTaskInput = z.input<typeof createTaskSchema>;
export type UpdateTaskInput = z.input<typeof updateTaskSchema>;
