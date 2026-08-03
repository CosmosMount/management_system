import { Prisma } from "@prisma/client";
import { z, ZodError } from "zod";
import {
  ProjectManagementAuthorizationError,
} from "@/lib/project-management/authorization";
import { ProjectManagementIdentityError } from "@/lib/project-management/identity";
import {
  structuredProjectManagementCodeFromZodIssue,
  type StructuredProjectManagementValidationCode,
} from "@/lib/project-management/validations/issues";

export const PROJECT_MANAGEMENT_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "VALIDATION_ERROR",
  "STATE_CONFLICT",
  "PLAN_VERSION_CONFLICT",
  "PLAN_CHRONOLOGY_INVALID",
  "STALE_TASK",
  "STALE_SEGMENT",
  "ASSOCIATION_INVALID",
  "QUERY_LIMIT_EXCEEDED",
  "NOT_FOUND",
  "DUPLICATE_OPERATION",
  "INTERNAL_ERROR",
] as const;

export type ProjectManagementErrorCode =
  (typeof PROJECT_MANAGEMENT_ERROR_CODES)[number];

export type ProjectManagementFieldErrors = Record<string, string[]>;

const authoritativeTimestampSchema = z
  .string({ message: "权威对象时间格式不正确" })
  .datetime({ offset: true, message: "权威对象时间格式不正确" });

export const staleTaskAuthoritativeDtoSchema = z
  .object({
    kind: z.literal("TASK"),
    id: z.string().uuid(),
    lockVersion: z.number().int().min(0),
    updatedAt: authoritativeTimestampSchema,
  })
  .strict();

export const staleSegmentAuthoritativeDtoSchema = z
  .object({
    kind: z.literal("SEGMENT"),
    id: z.string().uuid(),
    updatedAt: authoritativeTimestampSchema,
    versionToken: authoritativeTimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.versionToken !== value.updatedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["versionToken"],
        message: "Segment 版本令牌必须等于 updatedAt",
      });
    }
  });

export type StaleTaskAuthoritativeDto = z.infer<
  typeof staleTaskAuthoritativeDtoSchema
>;
export type StaleSegmentAuthoritativeDto = z.infer<
  typeof staleSegmentAuthoritativeDtoSchema
>;
export type ProjectManagementAuthoritativeDto =
  | StaleTaskAuthoritativeDto
  | StaleSegmentAuthoritativeDto;

type AuthoritativeTimestampSource = string | Date;

export type StaleTaskAuthoritativeSource = Readonly<{
  id: string;
  lockVersion: number;
  updatedAt: AuthoritativeTimestampSource;
}>;

export type StaleSegmentAuthoritativeSource = Readonly<{
  id: string;
  updatedAt: AuthoritativeTimestampSource;
}>;

export class ProjectManagementServiceError extends Error {
  constructor(
    readonly code: ProjectManagementErrorCode,
    message: string,
    readonly fieldErrors?: ProjectManagementFieldErrors,
    readonly current?: ProjectManagementAuthoritativeDto,
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

export function planChronologyInvalidError(
  message = "计划时间顺序不正确",
  fieldErrors?: ProjectManagementFieldErrors,
) {
  return new ProjectManagementServiceError(
    "PLAN_CHRONOLOGY_INVALID",
    message,
    fieldErrors,
  );
}

export function staleTaskError(
  current?: StaleTaskAuthoritativeSource,
  message = "Task 已被他人修改，请刷新后重试",
) {
  return new ProjectManagementServiceError(
    "STALE_TASK",
    message,
    undefined,
    current ? serializeStaleTaskAuthoritativeDto(current) : undefined,
  );
}

export function staleSegmentError(
  current?: StaleSegmentAuthoritativeSource,
  message = "投入记录已被他人修改，请刷新后重试",
) {
  return new ProjectManagementServiceError(
    "STALE_SEGMENT",
    message,
    undefined,
    current ? serializeStaleSegmentAuthoritativeDto(current) : undefined,
  );
}

export function associationInvalidError(
  message = "Task、Node 或 Segment 关联不合法",
  fieldErrors?: ProjectManagementFieldErrors,
) {
  return new ProjectManagementServiceError(
    "ASSOCIATION_INVALID",
    message,
    fieldErrors,
  );
}

export function queryLimitExceededError(
  message = "查询范围或结果数量超过上限，请缩小范围后重试",
) {
  return new ProjectManagementServiceError("QUERY_LIMIT_EXCEEDED", message);
}

export function duplicateOperationError(message = "此操作已处理") {
  return new ProjectManagementServiceError("DUPLICATE_OPERATION", message);
}

export function toProjectManagementServiceError(
  error: unknown,
): ProjectManagementServiceError {
  if (error instanceof ProjectManagementServiceError) return error;

  if (error instanceof ZodError) {
    const structuredCode = structuredCodeForZodError(error);
    if (structuredCode) {
      return new ProjectManagementServiceError(
        structuredCode,
        structuredValidationMessage(structuredCode),
        flattenZodFieldErrors(error),
      );
    }
    return validationError("输入内容不符合要求", flattenZodFieldErrors(error));
  }

  if (error instanceof ProjectManagementAuthorizationError) {
    return new ProjectManagementServiceError("FORBIDDEN", error.message);
  }

  if (error instanceof ProjectManagementIdentityError) {
    if (error.code === "UNAUTHENTICATED") {
      return new ProjectManagementServiceError("UNAUTHENTICATED", error.message);
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

export function serializeStaleTaskAuthoritativeDto(
  source: StaleTaskAuthoritativeSource,
): StaleTaskAuthoritativeDto | undefined {
  const result = staleTaskAuthoritativeDtoSchema.safeParse({
    kind: "TASK",
    id: source.id,
    lockVersion: source.lockVersion,
    updatedAt: serializeAuthoritativeTimestamp(source.updatedAt),
  });
  return result.success ? result.data : undefined;
}

export function serializeStaleSegmentAuthoritativeDto(
  source: StaleSegmentAuthoritativeSource,
): StaleSegmentAuthoritativeDto | undefined {
  const updatedAt = serializeAuthoritativeTimestamp(source.updatedAt);
  const result = staleSegmentAuthoritativeDtoSchema.safeParse({
    kind: "SEGMENT",
    id: source.id,
    updatedAt,
    versionToken: updatedAt,
  });
  return result.success ? result.data : undefined;
}

export function serializeProjectManagementAuthoritativeDtoForServiceError(
  error: ProjectManagementServiceError,
): ProjectManagementAuthoritativeDto | undefined {
  try {
    const source = error.current;
    if (source === undefined) return undefined;
    if (typeof source !== "object" || source === null) return undefined;
    switch (error.code) {
      case "STALE_TASK":
        if (source.kind !== "TASK") return undefined;
        return serializeStaleTaskAuthoritativeDto(source);
      case "STALE_SEGMENT":
        if (source.kind !== "SEGMENT") return undefined;
        return serializeStaleSegmentAuthoritativeDto(source);
      default:
        return undefined;
    }
  } catch {
    // Invalid authoritative snapshots must not replace the original stable error.
    return undefined;
  }
}

function serializeAuthoritativeTimestamp(
  value: AuthoritativeTimestampSource,
): string | Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return value;
  return value.toISOString();
}

function structuredCodeForZodError(
  error: ZodError,
): StructuredProjectManagementValidationCode | null {
  const codes = error.issues.map(structuredProjectManagementCodeFromZodIssue);
  if (codes.some((code) => code === null)) return null;
  const uniqueCodes = new Set(codes);
  return uniqueCodes.size === 1 ? (codes[0] ?? null) : null;
}

function structuredValidationMessage(
  code: StructuredProjectManagementValidationCode,
) {
  switch (code) {
    case "PLAN_CHRONOLOGY_INVALID":
      return "计划时间顺序不正确";
    case "ASSOCIATION_INVALID":
      return "Task、Node 或 Segment 关联不合法";
    case "QUERY_LIMIT_EXCEEDED":
      return "查询范围或结果数量超过上限，请缩小范围后重试";
  }
}

function flattenZodFieldErrors(error: ZodError): ProjectManagementFieldErrors {
  const fieldErrors: ProjectManagementFieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message];
  }
  return fieldErrors;
}
