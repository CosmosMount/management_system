import { Prisma, type AuditSource } from "@prisma/client";

export const PROJECT_MANAGEMENT_AUDIT_SCHEMA_VERSION = 1;

export type ProjectManagementAuditInput = {
  actorAccountId?: string | null;
  actorPersonId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  taskId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  reason?: string;
  requestId?: string;
  source?: AuditSource;
  schemaVersion?: number;
};

const SENSITIVE_AUDIT_KEY_PATTERN =
  /(token|secret|password|cookie|authorization|credential|appSecret|storagePath|publicPath|filePath|path)$/i;

export async function createDomainAuditEventTx(
  tx: Prisma.TransactionClient,
  input: ProjectManagementAuditInput,
) {
  return tx.domainAuditEvent.create({
    data: {
      actorAccountId: input.actorAccountId ?? null,
      actorPersonId: input.actorPersonId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      taskId: input.taskId ?? null,
      before: sanitizeAuditJson(input.before),
      after: sanitizeAuditJson(input.after),
      reason: input.reason ?? "",
      requestId: input.requestId ?? "",
      source: input.source ?? "WEB",
      schemaVersion:
        input.schemaVersion ?? PROJECT_MANAGEMENT_AUDIT_SCHEMA_VERSION,
    },
  });
}

function sanitizeAuditJson(
  value: Prisma.InputJsonValue | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return sanitizeAuditJsonValue(value) as Prisma.InputJsonValue;
}

function sanitizeAuditJsonValue(
  value: Prisma.InputJsonValue | null,
): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeAuditJsonValue(item),
    ) as Prisma.InputJsonArray;
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_AUDIT_KEY_PATTERN.test(key)
          ? "[REDACTED]"
          : sanitizeAuditJsonValue(item as Prisma.InputJsonValue | null),
      ]),
    ) as Prisma.InputJsonObject;
  }
  return value;
}
