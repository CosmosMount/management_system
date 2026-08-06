import { z } from "zod";
import { idSchema } from "@/lib/project-management/validations/lifecycle";

const requiredText = (message: string, max: number) =>
  z.string({ message }).trim().min(1, message).max(max, "内容过长");

const projectMemberSchema = z
  .object({
    personId: idSchema,
    role: z.enum(["OWNER", "PARTICIPANT"], { message: "成员角色不正确" }),
  })
  .strict();

const projectMembersSchema = z
  .array(projectMemberSchema, { message: "成员列表格式不正确" })
  .min(1, "至少需要一名 Project 负责人")
  .max(100, "Project 成员不能超过 100 人")
  .superRefine((members, ctx) => {
    if (members.filter((member) => member.role === "OWNER").length < 1) {
      ctx.addIssue({ code: "custom", message: "至少需要一名 Project 负责人" });
    }
    if (members.filter((member) => member.role === "OWNER").length > 50) {
      ctx.addIssue({ code: "custom", message: "Project 负责人不能超过 50 人" });
    }
    if (members.filter((member) => member.role === "PARTICIPANT").length > 50) {
      ctx.addIssue({ code: "custom", message: "Project 参与人员不能超过 50 人" });
    }
    const ids = members.map((member) => member.personId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "同一人员只能有一个 Project 角色" });
    }
  });

const requestedTaskIdsSchema = z
  .array(idSchema, { message: "Task 列表格式不正确" })
  .max(50, "一次最多选择 50 个 Task")
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "不能重复选择同一个 Task" });
    }
  });

const projectFields = {
  name: requiredText("请输入 Project 名称", 200),
  description: requiredText("请输入 Project 内容", 8_000),
  avatarPath: z.string().trim().max(500).nullable().optional().default(null),
  members: projectMembersSchema,
} as const;

export const createProjectInputSchema = z
  .object({
    ...projectFields,
    requestedTaskIds: requestedTaskIdsSchema.default([]),
    idempotencyKey: z.string().trim().min(8, "请求键不正确").max(200),
  })
  .strict();

export const resubmitProjectInputSchema = z
  .object({
    projectId: idSchema,
    expectedLockVersion: z.number().int().min(0),
    ...projectFields,
    requestedTaskIds: requestedTaskIdsSchema.default([]),
    idempotencyKey: z.string().trim().min(8, "请求键不正确").max(200),
  })
  .strict();

export const updateProjectInputSchema = z
  .object({
    projectId: idSchema,
    expectedLockVersion: z.number().int().min(0),
    ...projectFields,
  })
  .strict();

export const reviewProjectEstablishmentInputSchema = z
  .object({
    projectId: idSchema,
    requestId: idSchema,
    expectedLockVersion: z.number().int().min(0),
    decision: z.enum(["APPROVE", "REJECT"]),
    comment: z.string().trim().max(2_000, "审批意见过长").default(""),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.decision === "REJECT" && !input.comment) {
      ctx.addIssue({ code: "custom", path: ["comment"], message: "请输入驳回意见" });
    }
  });

export const projectLifecycleInputSchema = z
  .object({
    projectId: idSchema,
    expectedLockVersion: z.number().int().min(0),
  })
  .strict();

export const updateTaskProjectInputSchema = z
  .object({
    taskId: idSchema,
    expectedLockVersion: z.number().int().min(0),
    projectId: idSchema.nullable(),
  })
  .strict();

export const searchActiveProjectOptionsInputSchema = z.object({
  query: z.string().trim().max(200).optional().default(""),
  cursor: idSchema.nullable().optional().default(null),
  limit: z.number().int().min(1).max(50).optional().default(50),
}).strict();

export const resolveActiveProjectOptionsInputSchema = z.object({
  ids: z.array(idSchema).max(50, "一次最多解析 50 个 Project"),
}).strict();

export type ProjectMemberInput = z.infer<typeof projectMemberSchema>;
