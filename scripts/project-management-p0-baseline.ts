import "dotenv/config";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

const BUSINESS_TIMEZONE = "Asia/Shanghai";

const PROTECTED_TABLES = [
  "User",
  "UserRole",
  "ProcurementBudgetPool",
  "PurchaseOrder",
  "PurchaseItem",
  "ProcessingVendor",
  "Feedback",
  "FeedbackMessage",
  "FeedbackAttachment",
  "FileAsset",
  "ProcurementFeishuCard",
  "NotificationOutbox",
  "NotificationOutboxRecipient",
] as const;

type ProtectedTable = (typeof PROTECTED_TABLES)[number];

const LEGACY_TABLE_NAMES = [
  "ApprovalChecklistConfirmation",
  "ApprovalRecord",
  "TaskSubmission",
  "TaskAcceptanceChecklistItem",
  "WeeklyReport",
  "TaskTechGroup",
  "TaskDeletionRequest",
  "TaskDdlChangeRequest",
  "TaskRiskRecord",
  "TaskAssignee",
  "TaskFollowPreference",
  "TaskCreationRequest",
  "ProjectCreationRequest",
  "ProgressActivityLog",
  "ProjectStageOwner",
  "ProjectStageRiskRecord",
  "ProjectDdlChangeRequest",
  "ProjectFollowPreference",
  "ProjectComment",
  "ProjectStage",
  "ProjectOwner",
  "ProjectParticipant",
  "ProjectTemplateStage",
  "ProjectTemplate",
  "AcceptanceChecklistTemplate",
  "ProgressReminderRule",
  "ProgressDailySummarySchedule",
  "ProgressDailySummarySetting",
  "ProgressApprovalReminderDelivery",
  "ProgressApprovalReminderSetting",
];

const LEGACY_TASK_SIGNATURE_COLUMNS = [
  "projectId",
  "stageId",
  "assigneeOpenId",
  "assigneeName",
  "dueAt",
  "isOverdue",
  "needsOfflineConfirmation",
  "needsWeeklyReport",
] as const;

const LEGACY_ENUM_FEATURE_SIGNATURES = [
  {
    enumName: "ProjectStatus",
    featureLabels: "CANCELED",
  },
  {
    enumName: "TaskStatus",
    featureLabels: "TODO,PENDING_ACCEPTANCE,PROJECT_CANCELED",
  },
  {
    enumName: "TaskDeletionRequestStatus",
    featureLabels: "PENDING,APPROVED,REJECTED",
  },
  {
    enumName: "TaskCreationRequestStatus",
    featureLabels: "PENDING,APPROVED,REJECTED",
  },
  {
    enumName: "ProjectCreationRequestStatus",
    featureLabels: "PENDING,APPROVED,REJECTED",
  },
  {
    enumName: "ProjectDdlChangeRequestType",
    featureLabels: "CASCADE_EXTENSION,SINGLE_STAGE_ADJUSTMENT",
  },
  {
    enumName: "ProjectDdlChangeRequestStatus",
    featureLabels: "PENDING,APPROVED,REJECTED",
  },
  {
    enumName: "TaskDdlChangeRequestStatus",
    featureLabels: "PENDING,APPROVED,REJECTED",
  },
  {
    enumName: "TaskRiskStatus",
    featureLabels: "ACTIVE,RESOLVED",
  },
  {
    enumName: "TaskRiskSource",
    featureLabels: "MANUAL,WEEKLY",
  },
  {
    enumName: "TaskCategory",
    featureLabels: "TEST,ASSEMBLY,RND,DEBUG,REVIEW_DRAWING,ITERATION",
  },
  {
    enumName: "Urgency",
    featureLabels: "HIGH,MEDIUM,LOW",
  },
  {
    enumName: "Importance",
    featureLabels: "HIGH,MEDIUM,LOW",
  },
  {
    enumName: "SubmissionType",
    featureLabels: "DELIVERY,STAGE",
  },
  {
    enumName: "StageStatus",
    featureLabels: "NOT_STARTED,IN_PROGRESS,PENDING_ACCEPTANCE,COMPLETED",
  },
  {
    enumName: "ApprovalDecision",
    featureLabels: "APPROVED,REJECTED",
  },
  {
    enumName: "ProgressReminderKind",
    featureLabels:
      "TASK_OVERDUE,TASK_DUE_SOON,TASK_PENDING_ACCEPTANCE_STALE,WEEKLY_REPORT_MISSING,TASK_STALE_ACTIVITY,STAGE_STALE_OR_DUE_SOON",
  },
  {
    enumName: "ProgressApprovalKind",
    featureLabels:
      "PROJECT_ESTABLISHMENT,STAGE_ACCEPTANCE,PROJECT_BATCH_DDL,PROJECT_STAGE_DDL,TASK_CREATION,TASK_DELETION,TASK_DDL,TASK_ACCEPTANCE",
  },
  {
    enumName: "ProgressFollowPreferenceState",
    featureLabels: "FOLLOWING,MUTED",
  },
] as const;

const HASH_EXPRESSIONS: Record<ProtectedTable, string> = {
  User: `concat_ws('|', "id", md5("openId"), coalesce(md5("unionId"), ''), md5("name"), coalesce(md5("email"), ''), coalesce(md5("avatar"), ''), coalesce(md5("signaturePath"), ''))`,
  UserRole: `concat_ws('|', "id", md5("openId"), "role"::text, "team", "techGroup")`,
  ProcurementBudgetPool: `concat_ws('|', "id", md5("description"), "team", "techGroup", "period", "budgetAmount"::text, "sortOrder"::text, "lastAlertThreshold"::text)`,
  PurchaseOrder: `concat_ws('|', "id", "orderNo", "initiatorId", md5("initiatorName"), "team", "techGroup", "totalPrice"::text, "teamApproved"::text, "techGroupApproved"::text, coalesce(md5("teamApproverOpenId"), ''), coalesce(md5("techGroupApproverOpenId"), ''), md5("invoicePaths"), coalesce(md5("invoicePath"), ''), coalesce(md5("listDocPath"), ''), coalesce(md5("screenshotPath"), ''), "status"::text, "isWorkshopFee"::text, coalesce(md5("rejectionReason"), ''), coalesce(md5("rejectedByName"), ''))`,
  PurchaseItem: `concat_ws('|', "id", "orderId", md5("name"), md5("spec"), "itemKind"::text, md5("purchaseLink"), coalesce(md5("referenceImagePath"), ''), md5("processingVendor"), "quantity"::text, "unitPrice"::text, coalesce(md5("photoPath"), ''))`,
  ProcessingVendor: `concat_ws('|', "id", md5("name"))`,
  Feedback: `concat_ws('|', "id", md5("submitterOpenId"), md5("submitterName"), "status"::text)`,
  FeedbackMessage: `concat_ws('|', "id", "feedbackId", md5("authorOpenId"), md5("authorName"), md5("body"))`,
  FeedbackAttachment: `concat_ws('|', "id", "messageId", md5("path"), md5("fileName"), "mimeType", "size"::text, "sortOrder"::text)`,
  FileAsset: `concat_ws('|', "id", md5("publicPath"), md5("storagePath"), "kind"::text, "mimeType", "size"::text, coalesce("orderId", ''), coalesce("feedbackId", ''), coalesce(md5("signatureOwnerOpenId"), ''), coalesce(md5("ownerOpenId"), ''))`,
  ProcurementFeishuCard: `concat_ws('|', "id", "orderId", md5("openId"), md5("cardId"), "botKind", "cardStage", "sequence"::text)`,
  NotificationOutbox: `concat_ws('|', "id", md5("eventKey"), "channel", "botKind", "type", md5("payload"), "status"::text, "attempts"::text, md5("lastError"), coalesce(to_char("sentAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''))`,
  NotificationOutboxRecipient: `concat_ws('|', "id", "outboxId", md5("openId"), md5("receiveId"), md5("receiveIdType"), "status"::text, "attempts"::text, md5("lastError"), coalesce(to_char("sentAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''))`,
};

type CountHashRow = {
  rowCount: string;
  stableHash: string;
};

type CountRow = {
  count: string;
};

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function toNumber(value: string | number | bigint | null | undefined): number {
  return Number(value ?? 0);
}

async function protectedTableBaseline(table: ProtectedTable) {
  const rows = await prisma.$queryRawUnsafe<CountHashRow[]>(
    `
      SELECT
        COUNT(*)::text AS "rowCount",
        COALESCE(
          md5(string_agg(${HASH_EXPRESSIONS[table]}, E'\\n' ORDER BY "id")),
          ''
        ) AS "stableHash"
      FROM ${quoteIdentifier(table)}
    `,
  );
  const row = rows[0];
  return {
    rowCount: toNumber(row?.rowCount),
    stableHash: row?.stableHash ?? "",
  };
}

async function main() {
  const protectedTables = Object.fromEntries(
    await Promise.all(
      PROTECTED_TABLES.map(async (table) => [
        table,
        await protectedTableBaseline(table),
      ]),
    ),
  );

  const databaseRows = await prisma.$queryRaw<Array<{ databaseName: string }>>`
    SELECT current_database() AS "databaseName"
  `;

  const legacyTables = await prisma.$queryRaw<Array<{ tableName: string }>>`
    SELECT table_name AS "tableName"
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (
        table_name IN (${Prisma.join(LEGACY_TABLE_NAMES)})
        OR table_name LIKE 'Pm%'
      )
    ORDER BY table_name
  `;

  const legacyTaskSignatureTables = await prisma.$queryRaw<
    Array<{ tableName: string; matchedColumns: string }>
  >`
    SELECT
      table_name AS "tableName",
      string_agg(column_name, ',' ORDER BY column_name) AS "matchedColumns"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Task'
      AND column_name IN (${Prisma.join(LEGACY_TASK_SIGNATURE_COLUMNS)})
    GROUP BY table_name
    HAVING COUNT(DISTINCT column_name) = ${LEGACY_TASK_SIGNATURE_COLUMNS.length}
  `;

  const legacyTableFindings = [
    ...legacyTables.map((row) => ({
      tableName: row.tableName,
      reason: "legacy_table_name",
      matchedColumns: [] as string[],
    })),
    ...legacyTaskSignatureTables.map((row) => ({
      tableName: row.tableName,
      reason: "legacy_task_signature",
      matchedColumns: row.matchedColumns.split(",").filter(Boolean),
    })),
  ];

  const legacyEnumSignatures = await prisma.$queryRaw<
    Array<{ enumName: string; actualLabels: string; featureLabels: string }>
  >`
    WITH expected(enum_name, feature_labels) AS (
      VALUES ${Prisma.join(
        LEGACY_ENUM_FEATURE_SIGNATURES.map((signature) =>
          Prisma.sql`(${signature.enumName}, ${signature.featureLabels})`,
        ),
      )}
    ),
    actual AS (
      SELECT
        pg_type.typname AS enum_name,
        string_agg(pg_enum.enumlabel, ',' ORDER BY pg_enum.enumsortorder)
          AS actual_labels
      FROM pg_type
      JOIN pg_enum ON pg_enum.enumtypid = pg_type.oid
      GROUP BY pg_type.typname
    )
    SELECT
      expected.enum_name AS "enumName",
      actual.actual_labels AS "actualLabels",
      expected.feature_labels AS "featureLabels"
    FROM expected
    JOIN actual ON actual.enum_name = expected.enum_name
    WHERE
      string_to_array(expected.feature_labels, ',')
        <@ string_to_array(actual.actual_labels, ',')
    ORDER BY expected.enum_name
  `;

  const abandonedPmEnums = await prisma.$queryRaw<Array<{ enumName: string }>>`
    SELECT typname AS "enumName"
    FROM pg_type
    WHERE typname LIKE 'Pm%'
    ORDER BY typname
  `;

  const legacyEnumFindings = [
    ...legacyEnumSignatures.map((row) => ({
      enumName: row.enumName,
      reason: "legacy_enum_signature",
      actualLabels: row.actualLabels.split(",").filter(Boolean),
      featureLabels: row.featureLabels.split(",").filter(Boolean),
    })),
    ...abandonedPmEnums.map((row) => ({
      enumName: row.enumName,
      reason: "abandoned_pm_enum",
      actualLabels: [] as string[],
      featureLabels: [] as string[],
    })),
  ];

  const progressOutboxRows = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::text AS count
    FROM "NotificationOutbox"
    WHERE "channel" = 'progress'
  `;

  const projectManagerRoleRows = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*)::text AS count
    FROM "UserRole"
    WHERE "role"::text = 'PROJECT_MANAGER'
  `;

  const forbiddenLegacyColumns = await prisma.$queryRaw<
    Array<{ tableName: string; columnName: string }>
  >`
    SELECT table_name AS "tableName", column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        column_name ILIKE 'legacysource%'
        OR column_name ILIKE 'migrationneedsreview%'
        OR table_name ILIKE '%migrationmap%'
      )
    ORDER BY table_name, column_name
  `;

  const userRoleCounts = await prisma.$queryRaw<
    Array<{ role: string; rowCount: string }>
  >`
    SELECT "role"::text AS role, COUNT(*)::text AS "rowCount"
    FROM "UserRole"
    GROUP BY "role"
    ORDER BY "role"::text
  `;

  const outboxCounts = await prisma.$queryRaw<
    Array<{ channel: string; status: string; rowCount: string }>
  >`
    SELECT "channel", "status"::text AS status, COUNT(*)::text AS "rowCount"
    FROM "NotificationOutbox"
    GROUP BY "channel", "status"
    ORDER BY "channel", "status"::text
  `;

  const fileAssetKindCounts = await prisma.$queryRaw<
    Array<{ kind: string; rowCount: string }>
  >`
    SELECT "kind"::text AS kind, COUNT(*)::text AS "rowCount"
    FROM "FileAsset"
    GROUP BY "kind"
    ORDER BY "kind"::text
  `;

  const purchaseOrderStatusCounts = await prisma.$queryRaw<
    Array<{ status: string; rowCount: string }>
  >`
    SELECT "status"::text AS status, COUNT(*)::text AS "rowCount"
    FROM "PurchaseOrder"
    GROUP BY "status"
    ORDER BY "status"::text
  `;

  const feedbackStatusCounts = await prisma.$queryRaw<
    Array<{ status: string; rowCount: string }>
  >`
    SELECT "status"::text AS status, COUNT(*)::text AS "rowCount"
    FROM "Feedback"
    GROUP BY "status"
    ORDER BY "status"::text
  `;

  const foreignKeys = await prisma.$queryRaw<
    Array<{
      tableName: string;
      columnName: string;
      foreignTableName: string;
      foreignColumnName: string;
      deleteRule: string;
      updateRule: string;
    }>
  >`
    SELECT
      tc.table_name AS "tableName",
      kcu.column_name AS "columnName",
      ccu.table_name AS "foreignTableName",
      ccu.column_name AS "foreignColumnName",
      rc.delete_rule AS "deleteRule",
      rc.update_rule AS "updateRule"
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name IN (${Prisma.join(PROTECTED_TABLES)})
    ORDER BY tc.table_name, kcu.column_name
  `;

  const report = {
    generatedAt: new Date().toISOString(),
    businessTimezone: BUSINESS_TIMEZONE,
    database: {
      name: databaseRows[0]?.databaseName ?? "",
    },
    protectedTables,
    summaries: {
      userRoles: userRoleCounts.map((row) => ({
        role: row.role,
        rowCount: toNumber(row.rowCount),
      })),
      outbox: outboxCounts.map((row) => ({
        channel: row.channel,
        status: row.status,
        rowCount: toNumber(row.rowCount),
      })),
      fileAssets: fileAssetKindCounts.map((row) => ({
        kind: row.kind,
        rowCount: toNumber(row.rowCount),
      })),
      purchaseOrders: purchaseOrderStatusCounts.map((row) => ({
        status: row.status,
        rowCount: toNumber(row.rowCount),
      })),
      feedback: feedbackStatusCounts.map((row) => ({
        status: row.status,
        rowCount: toNumber(row.rowCount),
      })),
    },
    safetyChecks: {
      legacyTableCount: legacyTableFindings.length,
      legacyTables: legacyTableFindings.map((finding) => finding.tableName),
      legacyTableFindings,
      legacyEnumCount: legacyEnumFindings.length,
      legacyEnums: legacyEnumFindings.map((finding) => finding.enumName),
      legacyEnumFindings,
      progressOutboxRows: toNumber(progressOutboxRows[0]?.count),
      projectManagerRoleRows: toNumber(projectManagerRoleRows[0]?.count),
      forbiddenLegacyColumns,
    },
    foreignKeys,
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pm:p0-baseline] failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
