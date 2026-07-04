import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type LogContext = {
  requestId?: string;
  actorOpenId?: string;
  actorName?: string;
  module?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
};

const storage = new AsyncLocalStorage<LogContext>();

export function createRequestId(): string {
  return randomUUID();
}

export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

export function withLogContext<T>(context: LogContext, callback: () => T): T {
  const parent = getLogContext();
  return storage.run(
    {
      ...parent,
      ...context,
      requestId: context.requestId ?? parent.requestId ?? createRequestId(),
    },
    callback,
  );
}

export function updateLogContext(context: LogContext): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, context);
}
