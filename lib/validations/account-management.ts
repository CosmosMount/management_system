import { z } from "zod";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";

export const accountProjectRoleSchema = z.enum([
  "SUPER_ADMINISTRATOR",
  "PROJECT_ADMINISTRATOR",
  "GROUP_LEADER",
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
    if (input.role !== "GROUP_LEADER") {
      if (input.team || input.techGroup) {
        ctx.addIssue({ code: "custom", message: "全局角色不能设置组织范围" });
      }
      return;
    }
    const hasTeam = Boolean(input.team);
    const hasTechGroup = Boolean(input.techGroup);
    if (hasTeam === hasTechGroup) {
      ctx.addIssue({ code: "custom", message: "组长必须且只能选择一个车组或技术组" });
      return;
    }
    if (input.team && !TEAM_OPTIONS.includes(input.team as never)) {
      ctx.addIssue({ code: "custom", path: ["team"], message: "车组范围无效" });
    }
    if (
      input.techGroup &&
      !TECH_GROUP_OPTIONS.includes(input.techGroup as never)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["techGroup"],
        message: "技术组范围无效",
      });
    }
  });

export const revokeRoleInputSchema = z.object({
  assignmentId: z.string().uuid("角色记录参数无效"),
});

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
