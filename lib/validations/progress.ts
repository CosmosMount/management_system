import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().min(1, "请输入项目名称"),
  description: z.string().optional(),
  team: z.enum(TEAM_OPTIONS, { message: "请选择车组" }),
  techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择技术组" }),
  ownerOpenId: z.string().min(1, "请选择项目负责人"),
  allowOwnerSelfApproval: z.boolean().default(false),
  template: z.enum(["real-car", "custom"]).default("real-car"),
  stages: z
    .array(
      z.object({
        name: z.string().min(1, "阶段名称不能为空"),
        goal: z.string().min(1, "请填写阶段目标"),
        ownerOpenId: z.string().min(1, "请选择阶段负责人"),
        dueAt: z.string().min(1, "请选择阶段 DDL"),
      }),
    )
    .min(1, "至少添加一个阶段"),
});

export const createTaskSchema = z.object({
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
  dueAt: z.string().min(1, "请选择截止时间"),
  needsOfflineConfirmation: z.boolean().default(false),
  needsWeeklyReport: z.boolean().default(false),
}).superRefine((value, ctx) => {
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
});

export const riskSyncSchema = z.object({
  taskId: z.string().min(1),
  riskNote: z.string().trim().min(1, "请填写风险说明").max(1000),
});

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type CreateTaskInput = z.input<typeof createTaskSchema>;
