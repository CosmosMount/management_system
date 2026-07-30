import type { RefinementCtx, ZodIssue } from "zod";

export const structuredProjectManagementValidationCodes = [
  "PLAN_CHRONOLOGY_INVALID",
  "ASSOCIATION_INVALID",
  "QUERY_LIMIT_EXCEEDED",
] as const;

export type StructuredProjectManagementValidationCode =
  (typeof structuredProjectManagementValidationCodes)[number];

const PROJECT_MANAGEMENT_ERROR_CODE_PARAM = "projectManagementErrorCode";
const PROJECT_MANAGEMENT_ISSUE_IDENTITY_PARAM =
  "projectManagementStructuredIssueIdentity";
const PROJECT_MANAGEMENT_ISSUE_IDENTITY = Symbol(
  "project-management-structured-validation-issue",
);

export function addStructuredProjectManagementIssue({
  ctx,
  code,
  message,
  path,
}: {
  ctx: RefinementCtx;
  code: StructuredProjectManagementValidationCode;
  message: string;
  path?: PropertyKey[];
}) {
  ctx.addIssue({
    code: "custom",
    message,
    ...(path ? { path } : {}),
    params: {
      [PROJECT_MANAGEMENT_ERROR_CODE_PARAM]: code,
      [PROJECT_MANAGEMENT_ISSUE_IDENTITY_PARAM]:
        PROJECT_MANAGEMENT_ISSUE_IDENTITY,
    },
  });
}

export function structuredProjectManagementCodeFromZodIssue(
  issue: ZodIssue,
): StructuredProjectManagementValidationCode | null {
  if (issue.code !== "custom") return null;
  if (
    issue.params?.[PROJECT_MANAGEMENT_ISSUE_IDENTITY_PARAM] !==
    PROJECT_MANAGEMENT_ISSUE_IDENTITY
  ) {
    return null;
  }
  const value = issue.params?.[PROJECT_MANAGEMENT_ERROR_CODE_PARAM];
  return structuredProjectManagementValidationCodes.find(
    (code) => code === value,
  ) ?? null;
}
