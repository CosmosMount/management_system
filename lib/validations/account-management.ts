import { z } from "zod";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";

export const accountProjectRoleSchema = z.enum([
  "SUPER_ADMINISTRATOR",
  "PROJECT_ADMINISTRATOR",
]);

export const reimbursementRoleSchema = z.enum([
  "TEAM_ADMIN",
  "TECH_GROUP_ADMIN",
  "TEACHER",
  "FINANCE",
]);

const scopeFields = {
  team: z.string().trim().optional().default(""),
  techGroup: z.string().trim().optional().default(""),
};

export const grantAccountRoleInputSchema = z
  .object({
    targetAccountId: z.string().uuid("账号参数无效"),
    role: accountProjectRoleSchema,
    ...scopeFields,
  })
  .superRefine((input, ctx) => {
    if (input.team || input.techGroup) {
      ctx.addIssue({ code: "custom", message: "全局角色不能设置组织范围" });
    }
  });

export const revokeRoleInputSchema = z.object({
  assignmentId: z.string().uuid("角色记录参数无效"),
});

export const adminAccountOptionPurposeSchema = z.enum([
  "ALL",
  "REIMBURSEMENT",
]);

export const searchAdminAccountOptionsInputSchema = z
  .object({
    purpose: adminAccountOptionPurposeSchema,
    query: z.string().trim().max(100, "搜索关键词过长").optional().default(""),
    cursor: z.string().trim().max(1000, "分页参数无效").optional(),
    limit: z.number().int().min(1).max(50, "每页最多返回 50 个账号").default(50),
  })
  .strict();

export const resolveAdminAccountOptionsInputSchema = z
  .object({
    purpose: adminAccountOptionPurposeSchema,
    ids: z.array(z.string().uuid("账号参数无效")).max(50, "一次最多解析 50 个账号"),
  })
  .strict();

export const updateTeacherEmailInputSchema = z
  .object({
    accountId: z.string().uuid("账号参数无效"),
    email: z.string().trim().max(254, "邮箱长度不能超过 254 个字符"),
  })
  .strict();

export const assignReimbursementRoleInputSchema = z
  .object({
    targetAccountId: z.string().uuid("账号参数无效"),
    role: reimbursementRoleSchema,
    ...scopeFields,
  })
  .superRefine((input, ctx) => {
    const teamScoped = input.role === "TEAM_ADMIN" || input.role === "FINANCE";
    const techScoped =
      input.role === "TECH_GROUP_ADMIN" || input.role === "TEACHER";
    if (teamScoped) {
      if (!input.team || input.techGroup) {
        ctx.addIssue({ code: "custom", message: "该报销角色必须且只能指定车组" });
      } else if (!TEAM_OPTIONS.includes(input.team as never)) {
        ctx.addIssue({ code: "custom", path: ["team"], message: "车组范围无效" });
      }
    }
    if (techScoped) {
      if (!input.techGroup || input.team) {
        ctx.addIssue({ code: "custom", message: "该报销角色必须且只能指定技术组" });
      } else if (!TECH_GROUP_OPTIONS.includes(input.techGroup as never)) {
        ctx.addIssue({
          code: "custom",
          path: ["techGroup"],
          message: "技术组范围无效",
        });
      }
    }
  });

export type GrantAccountRoleInput = z.infer<typeof grantAccountRoleInputSchema>;
export type AssignReimbursementRoleInput = z.infer<
  typeof assignReimbursementRoleInputSchema
>;
