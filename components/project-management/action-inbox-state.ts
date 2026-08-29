import type { ProjectManagementActionFailure } from "@/lib/project-management/application/action-result";
import type {
  ActionInboxItem,
  ActionInboxPage,
} from "@/lib/project-management/queries/action-inbox-queries";

export type ActionInboxLoadMode = "APPEND" | "REPLACE";
export type ActionInboxLoadRecovery = "RETRY_CURSOR" | "RELOAD_QUEUE";

export function actionInboxLoadRecovery(
  mode: ActionInboxLoadMode,
  error: ProjectManagementActionFailure["error"],
): ActionInboxLoadRecovery {
  if (mode === "REPLACE") return "RELOAD_QUEUE";
  const cursorErrors = error.fieldErrors?.cursor;
  return error.code === "VALIDATION_ERROR" && cursorErrors?.some(Boolean)
    ? "RELOAD_QUEUE"
    : "RETRY_CURSOR";
}

export function appendActionInboxPage(
  current: ActionInboxPage,
  incoming: ActionInboxPage,
): ActionInboxPage {
  return {
    ...current,
    items: mergeUniqueItems(current.items, incoming.items),
    nextCursor: incoming.nextCursor,
  };
}

function mergeUniqueItems(
  current: ActionInboxItem[],
  incoming: ActionInboxItem[],
) {
  const seen = new Set(current.map((item) => item.id));
  const added = incoming.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return [...current, ...added];
}
