import { logger } from "@/lib/logger";
import {
  ProjectManagementServiceError,
  toProjectManagementServiceError,
  type ProjectManagementErrorCode,
  type ProjectManagementFieldErrors,
} from "@/lib/project-management/application/errors";

export type ProjectManagementActionSuccess<T> = {
  ok: true;
  data: T;
};

export type ProjectManagementActionFailure = {
  ok: false;
  error: {
    code: ProjectManagementErrorCode;
    message: string;
    fieldErrors?: ProjectManagementFieldErrors;
  };
};

export type ProjectManagementActionResult<T> =
  | ProjectManagementActionSuccess<T>
  | ProjectManagementActionFailure;

export type ProjectManagementActionLogContext = {
  setActorAccountId: (accountId: string | null | undefined) => void;
  setTaskId: (taskId: string | null | undefined) => void;
};

export async function runProjectManagementAction<T>({
  event,
  action,
  actorAccountId,
  taskId,
  callback,
}: {
  event: string;
  action: string;
  actorAccountId?: string | null;
  taskId?: string | null;
  callback: (context: ProjectManagementActionLogContext) => Promise<T>;
}): Promise<ProjectManagementActionResult<T>> {
  const startedAt = Date.now();
  let logActorAccountId = actorAccountId ?? null;
  let logTaskId = taskId ?? null;
  const context: ProjectManagementActionLogContext = {
    setActorAccountId(nextActorAccountId) {
      logActorAccountId = nextActorAccountId ?? null;
    },
    setTaskId(nextTaskId) {
      logTaskId = nextTaskId ?? null;
    },
  };
  try {
    const data = await callback(context);
    logger.audit(event, {
      module: "project-management",
      action,
      actorAccountId: logActorAccountId ?? undefined,
      taskId: logTaskId ?? undefined,
      durationMs: Date.now() - startedAt,
      result: "success",
    });
    return { ok: true, data };
  } catch (error) {
    const mapped = toProjectManagementServiceError(error);
    logger[mapped.code === "INTERNAL_ERROR" ? "error" : "warn"](event, {
      module: "project-management",
      action,
      actorAccountId: logActorAccountId ?? undefined,
      taskId: logTaskId ?? undefined,
      durationMs: Date.now() - startedAt,
      result: "failure",
      errorCode: mapped.code,
      errorMessage: mapped.message,
      error: mapped.code === "INTERNAL_ERROR" ? error : undefined,
    });
    return { ok: false, error: serializeServiceError(mapped) };
  }
}

function serializeServiceError(error: ProjectManagementServiceError) {
  return {
    code: error.code,
    message: error.message,
    ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
  };
}
