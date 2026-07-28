import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import {
  ProjectManagementAuthorizationError,
} from "@/lib/project-management/authorization";
import { ProjectManagementIdentityError } from "@/lib/project-management/identity";

export const PROJECT_MANAGEMENT_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "VALIDATION_ERROR",
  "STATE_CONFLICT",
  "PLAN_VERSION_CONFLICT",
  "NOT_FOUND",
  "DUPLICATE_OPERATION",
  "INTERNAL_ERROR",
] as const;

export type ProjectManagementErrorCode =
  (typeof PROJECT_MANAGEMENT_ERROR_CODES)[number];

export type ProjectManagementFieldErrors = Record<string, string[]>;

export class ProjectManagementServiceError extends Error {
  constructor(
    readonly code: ProjectManagementErrorCode,
    message: string,
    readonly fieldErrors?: ProjectManagementFieldErrors,
  ) {
    super(message);
    this.name = "ProjectManagementServiceError";
  }
}

export function validationError(
  message: string,
  fieldErrors?: ProjectManagementFieldErrors,
): ProjectManagementServiceError {
  return new ProjectManagementServiceError(
    "VALIDATION_ERROR",
    message,
    fieldErrors,
  );
}

export function notFoundError(): ProjectManagementServiceError {
  return new ProjectManagementServiceError(
    "NOT_FOUND",
    "对象不存在或无权查看",
  );
}

export function stateConflictError(message = "当前状态已变化，请刷新后重试") {
  return new ProjectManagementServiceError("STATE_CONFLICT", message);
}

export function planVersionConflictError(
  message = "计划已被他人修订，请比较后重新操作",
) {
  return new ProjectManagementServiceError("PLAN_VERSION_CONFLICT", message);
}

export function duplicateOperationError(message = "此操作已处理") {
  return new ProjectManagementServiceError("DUPLICATE_OPERATION", message);
}

export function toProjectManagementServiceError(
  error: unknown,
): ProjectManagementServiceError {
  if (error instanceof ProjectManagementServiceError) return error;

  if (error instanceof ZodError) {
    return validationError("输入内容不符合要求", flattenZodFieldErrors(error));
  }

  if (error instanceof ProjectManagementAuthorizationError) {
    return new ProjectManagementServiceError("FORBIDDEN", error.message);
  }

  if (error instanceof ProjectManagementIdentityError) {
    if (error.code === "UNAUTHENTICATED") {
      return new ProjectManagementServiceError("UNAUTHENTICATED", error.message);
    }
    if (error.code === "ACCOUNT_DISABLED") {
      return new ProjectManagementServiceError("FORBIDDEN", error.message);
    }
    return new ProjectManagementServiceError("VALIDATION_ERROR", error.message);
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return duplicateOperationError();
    }
    if (error.code === "P2025") {
      return notFoundError();
    }
  }

  return new ProjectManagementServiceError(
    "INTERNAL_ERROR",
    "操作失败，请稍后重试",
  );
}

function flattenZodFieldErrors(error: ZodError): ProjectManagementFieldErrors {
  const fieldErrors: ProjectManagementFieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message];
  }
  return fieldErrors;
}
