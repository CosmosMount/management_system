import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().min(1, "请输入项目名称"),
  description: z.string().optional(),
  team: z.enum(TEAM_OPTIONS, { message: "请选择车组" }),
  techGroup: z.enum(TECH_GROUP_OPTIONS, { message: "请选择技术组" }),
  milestones: z
    .array(z.object({ name: z.string().min(1, "里程碑名称不能为空") }))
    .min(1, "至少添加一个验收节点"),
});

export const createTaskSchema = z.object({
  projectId: z.string().min(1),
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
  assigneeOpenId: z.string().min(1, "请选择负责人"),
  metrics: z.string().min(1, "请填写指标"),
  dueAt: z.string().min(1, "请选择截止时间"),
});

export const submitDeliverySchema = z.object({
  taskId: z.string().min(1),
  feishuDocUrl: z.string().url("请输入有效的飞书文档链接"),
  videoUrl: z.string().url().optional().or(z.literal("")),
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

export const milestoneSubmitSchema = z.object({
  projectId: z.string().min(1),
  milestoneId: z.string().min(1),
  feishuDocUrl: z.string().url("请输入有效的飞书文档链接"),
  note: z.string().optional(),
});

export const approvalSchema = z.object({
  submissionId: z.string().min(1),
  comment: z.string().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
