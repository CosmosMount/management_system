import {
  MAX_TASK_IMPORT_ROWS,
  normalizeTechGroupName,
  TEAM_OPTIONS,
  TECH_GROUP_OPTIONS,
} from "@/lib/constants";
import { z } from "zod";

const teamSchema = z
  .enum(TEAM_OPTIONS, { message: "请选择有效车组" })
  .optional()
  .or(z.literal(""));

const techGroupSchema = z.preprocess(
  normalizeTechGroupInput,
  z.enum(TECH_GROUP_OPTIONS, { message: "请选择有效技术组" }).optional().or(z.literal("")),
);

const taskTechGroupsSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.map((item) =>
          typeof item === "string" ? normalizeTechGroupName(item) : item,
        )
      : value,
  z.array(z.enum(TECH_GROUP_OPTIONS, { message: "请选择有效任务技术组" })).min(
    1,
    "请选择任务技术组",
  ),
);

function normalizeTechGroupInput(value: unknown) {
  return typeof value === "string" ? normalizeTechGroupName(value) : value;
}

const projectOwnerOpenIdsSchema = z.array(z.string()).optional();
const projectParticipantOpenIdsSchema = z.array(z.string()).optional();
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
  participantOpenIds: projectParticipantOpenIdsSchema,
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
        durationDays: z.coerce
          .number()
          .int("阶段耗时必须是整数")
          .min(1, "阶段耗时不能小于 1 天")
          .max(3650, "阶段耗时不能超过 3650 天"),
      }),
    )
    .min(1, "至少添加一个阶段"),
}).superRefine((value, ctx) => {
  validateProjectScopeAndOwners(value, ctx);
  const totalDurationDays = value.stages.reduce(
    (total, stage) => total + stage.durationDays,
    0,
  );
  if (totalDurationDays > 3650) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stages"],
      message: "项目阶段总耗时不能超过 3650 天",
    });
  }
});

export const projectEstablishmentReviewSchema = z
  .object({
    projectId: z.string().min(1, "立项项目不存在"),
    decision: z.enum(["APPROVED", "REJECTED"]),
    comment: z.string().trim().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "REJECTED" && !value.comment?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["comment"],
        message: "驳回立项时请填写审核意见",
      });
    }
  });

export const projectEstablishmentResubmitSchema = z.object({
  projectId: z.string().min(1, "立项项目不存在"),
  input: createProjectSchema,
});

export const projectTemplateStageSchema = z.object({
  name: z.string().trim().min(1, "阶段名称不能为空").max(100, "阶段名称不能超过 100 个字符"),
  goal: z.string().trim().min(1, "请填写阶段目标").max(1000, "阶段目标不能超过 1000 个字符"),
  durationDays: z.coerce
    .number()
    .int("阶段耗时必须是整数")
    .min(1, "阶段耗时不能小于 1 天")
    .max(3650, "阶段耗时不能超过 3650 天"),
});

const projectTemplateBaseSchema = z.object({
  name: z.string().trim().min(1, "请输入模板名称").max(100, "模板名称不能超过 100 个字符"),
  description: z.string().trim().max(1000, "模板描述不能超过 1000 个字符").optional(),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  stages: z.array(projectTemplateStageSchema).min(1, "至少添加一个阶段"),
}).superRefine((value, ctx) => {
  const totalDurationDays = value.stages.reduce(
    (total, stage) => total + stage.durationDays,
    0,
  );
  if (totalDurationDays > 3650) {
    ctx.addIssue({
      code: "custom",
      path: ["stages"],
      message: "模板总耗时不能超过 3650 天",
    });
  }
});

export const createProjectTemplateSchema = projectTemplateBaseSchema;

export const updateProjectTemplateSchema = projectTemplateBaseSchema.extend({
  templateId: z.string().min(1, "缺少模板 ID"),
});

export const projectTemplateIdSchema = z.object({
  templateId: z.string().min(1, "缺少模板 ID"),
});

export const deleteProjectTemplateSchema = projectTemplateIdSchema;

export const projectTemplateEnabledSchema = z.object({
  templateId: z.string().min(1, "缺少模板 ID"),
  enabled: z.boolean(),
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

const taskEditableBaseSchema = z.object({
  projectId: z.string().min(1),
  stageId: z.string().optional().or(z.literal("")),
  title: z.string().min(1, "请输入任务目标"),
  goal: z.string().optional(),
  taskTechGroups: taskTechGroupsSchema,
  urgency: z.enum(["HIGH", "MEDIUM", "LOW"]),
  importance: z.enum(["HIGH", "MEDIUM", "LOW"]),
  assigneeOpenId: z.string().optional(),
  assigneeOpenIds: z.array(z.string()).optional(),
  metrics: z.string().min(1, "请填写指标"),
  needsOfflineConfirmation: z.boolean().default(false),
  needsWeeklyReport: z.boolean().default(false),
  acceptanceChecklistItems: acceptanceChecklistItemsSchema,
});

export const createTaskSchema = taskEditableBaseSchema.extend({
  dueAt: dateTimeStringSchema("请选择截止时间"),
}).superRefine((value, ctx) => {
  validateTaskAssignees(value, ctx);
});

export const batchTaskImportSchema = z.object({
  projectId: z.string().min(1, "缺少项目 ID"),
  defaultStageId: z.string().min(1, "请选择项目阶段"),
  mode: z.enum(["create", "request"]),
  tasks: z
    .array(
      taskEditableBaseSchema.omit({ projectId: true }).extend({
        importId: z.string().optional(),
        stageId: z.string().optional().or(z.literal("")),
        dueAt: dateTimeStringSchema("请选择截止时间"),
        needsOfflineConfirmation: z.boolean().default(false),
        ignored: z.boolean().optional(),
      }),
    )
    .min(1, "至少导入 1 条任务")
    .max(MAX_TASK_IMPORT_ROWS, `单次最多导入 ${MAX_TASK_IMPORT_ROWS} 条任务`),
});

export const updateTaskSchema = taskEditableBaseSchema.extend({
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
  content: z.string().trim().min(1, "请填写风险说明").max(1000),
});

export const projectStageRiskSyncSchema = z.object({
  stageId: z.string().min(1),
  content: z.string().trim().min(1, "请填写风险说明").max(1000),
});

export const taskRiskResolveSchema = z.object({
  riskId: z.string().min(1),
  resolveNote: z
    .string()
    .trim()
    .min(1, "请填写风险解除说明")
    .max(1000, "风险解除说明不能超过 1000 个字符"),
});

export const projectStageRiskResolveSchema = z.object({
  riskId: z.string().min(1),
  resolveNote: z
    .string()
    .trim()
    .min(1, "请填写风险取消说明")
    .max(1000, "风险取消说明不能超过 1000 个字符"),
});

export const taskDdlChangeRequestSchema = z.object({
  taskId: z.string().min(1),
  newDueAt: dateTimeStringSchema("请选择新的最晚完成时间"),
  reason: z
    .string()
    .trim()
    .min(1, "请填写修改原因")
    .max(1000, "修改原因不能超过 1000 个字符"),
});

export const taskDdlChangeReviewSchema = z
  .object({
    requestId: z.string().min(1),
    decision: z.enum(["APPROVED", "REJECTED"]),
    comment: z
      .string()
      .trim()
      .max(1000, "审核意见不能超过 1000 个字符")
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "REJECTED" && !value.comment?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["comment"],
        message: "驳回 DDL 修改申请时请填写审核意见",
      });
    }
  });

export const taskDeletionRequestSchema = z.object({
  taskId: z.string().min(1),
  reason: z
    .string()
    .trim()
    .min(1, "请填写删除原因")
    .max(1000, "删除原因不能超过 1000 个字符"),
});

export const taskDirectDeleteSchema = taskDeletionRequestSchema;

export const taskDeletionReviewSchema = z
  .object({
    requestId: z.string().min(1),
    decision: z.enum(["APPROVED", "REJECTED"]),
    comment: z
      .string()
      .trim()
      .max(1000, "审核意见不能超过 1000 个字符")
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "REJECTED" && !value.comment?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["comment"],
        message: "驳回删除申请时请填写审核意见",
      });
    }
  });

export const taskCreationReviewSchema = z
  .object({
    requestId: z.string().min(1),
    decision: z.enum(["APPROVED", "REJECTED"]),
    comment: z
      .string()
      .trim()
      .max(1000, "审核意见不能超过 1000 个字符")
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === "REJECTED" && !value.comment?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["comment"],
        message: "驳回任务申请时请填写审核意见",
      });
    }
  });

const rollbackReasonSchema = z
  .string()
  .trim()
  .min(1, "请填写操作原因")
  .max(1000, "操作原因不能超过 1000 个字符");

const ddlChangeReasonSchema = z
  .string()
  .trim()
  .min(1, "请填写 DDL 变更原因")
  .max(1000, "DDL 变更原因不能超过 1000 个字符");

const reviewCommentRequiredSchema = z
  .string()
  .trim()
  .min(1, "请填写审批意见")
  .max(1000, "审批意见不能超过 1000 个字符");

export const projectStageRollbackSchema = z.object({
  projectId: z.string().min(1),
  reason: rollbackReasonSchema,
});

export const taskRestartSchema = z.object({
  taskId: z.string().min(1),
  reason: rollbackReasonSchema,
});

export const projectStageBatchDdlChangeRequestSchema = z.object({
  projectId: z.string().min(1),
  stageId: z.string().min(1),
  direction: z.enum(["DELAY", "ADVANCE"]).default("DELAY"),
  reason: ddlChangeReasonSchema,
  durationDays: z.coerce
    .number()
    .int("调整时长必须是整数天")
    .min(1, "调整时长至少 1 天")
    .max(365, "调整时长不能超过 365 天"),
  isBenign: z.boolean().default(false),
});

export const projectStageExtensionRequestSchema =
  projectStageBatchDdlChangeRequestSchema.extend({
    direction: z.literal("DELAY").default("DELAY"),
  });

export const projectStageBatchDdlChangeReviewSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["APPROVED", "REJECTED"]),
  comment: reviewCommentRequiredSchema,
  finalIsBenign: z.boolean().optional(),
});

export const projectStageExtensionReviewSchema =
  projectStageBatchDdlChangeReviewSchema;

export const projectStageDueDateChangeRequestSchema = z.object({
  projectId: z.string().min(1),
  stageId: z.string().min(1),
  proposedDueAt: dateTimeStringSchema("请选择新的阶段 DDL"),
  reason: ddlChangeReasonSchema,
});

export const projectStageDueDateChangeReviewSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["APPROVED", "REJECTED"]),
  comment: reviewCommentRequiredSchema,
});

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type ParsedCreateProjectInput = z.output<typeof createProjectSchema>;
export type UpdateProjectInput = z.input<typeof updateProjectSchema>;
export type CreateTaskInput = z.input<typeof createTaskSchema>;
export type BatchTaskImportInput = z.input<typeof batchTaskImportSchema>;
export type UpdateTaskInput = z.input<typeof updateTaskSchema>;
export type CreateProjectTemplateInput = z.input<typeof createProjectTemplateSchema>;
export type UpdateProjectTemplateInput = z.input<typeof updateProjectTemplateSchema>;
