import "dotenv/config";
import { prisma } from "@/lib/prisma";

type CountRow = { count: bigint | number | string };
type RoleCountRow = { role: string; count: bigint | number | string };

function numberValue(value: bigint | number | string | undefined) {
  return Number(value ?? 0);
}

async function main() {
  const [
    zeroOwnerRows,
    duplicateMemberRows,
    activeRoleRows,
    conversionRows,
    segmentBackfillRows,
    orphanSegmentRows,
    activeGroupLeaderRows,
    taskRows,
    activeGlobalAdministratorRows,
    feishuReachableGlobalAdministratorRows,
    pendingMilestoneRows,
    pendingRevisionRows,
    legacyInAppRows,
    retryableLegacyOutboxRows,
  ] = await Promise.all([
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::bigint AS count
      FROM "Task" task
      WHERE NOT EXISTS (
        SELECT 1 FROM "TaskMember" member
        WHERE member."taskId" = task.id
          AND member."removedAt" IS NULL
          AND member.role = 'OWNER'
      )
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::bigint AS count FROM (
        SELECT "taskId", "personId"
        FROM "TaskMember"
        WHERE "removedAt" IS NULL
        GROUP BY "taskId", "personId"
        HAVING count(*) > 1
      ) duplicate_members
    `,
    prisma.$queryRaw<RoleCountRow[]>`
      SELECT role::text AS role, count(*)::bigint AS count
      FROM "TaskMember"
      WHERE "removedAt" IS NULL
      GROUP BY role
      ORDER BY role
    `,
    prisma.$queryRaw<RoleCountRow[]>`
      SELECT target_role AS role, count(*)::bigint AS count
      FROM (
        SELECT
          CASE
            WHEN bool_or(role::text = 'OWNER') THEN 'OWNER_RETAINED'
            WHEN bool_or(role::text IN ('PARTICIPANT', 'LEAD', 'MEMBER')) THEN 'PARTICIPANT_NORMALIZED'
            ELSE 'REVIEWER_VIEWER_ENDED'
          END AS target_role
        FROM "TaskMember"
        WHERE "removedAt" IS NULL
        GROUP BY "taskId", "personId"
      ) conversions
      GROUP BY target_role
      ORDER BY target_role
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::bigint AS count FROM (
        SELECT segment."taskId", segment."personId"
        FROM "WorkSegment" segment
        WHERE segment."deletedAt" IS NULL
          AND segment."taskId" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "TaskMember" member
            WHERE member."taskId" = segment."taskId"
              AND member."personId" = segment."personId"
              AND member."removedAt" IS NULL
          )
        GROUP BY segment."taskId", segment."personId"
      ) backfills
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::bigint AS count
      FROM "WorkSegment" segment
      LEFT JOIN "Task" task ON task.id = segment."taskId"
      LEFT JOIN "Person" person ON person.id = segment."personId"
      WHERE segment."deletedAt" IS NULL
        AND segment."taskId" IS NOT NULL
        AND (task.id IS NULL OR person.id IS NULL)
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::bigint AS count
      FROM "SystemRoleAssignment"
      WHERE role::text = 'GROUP_LEADER' AND "revokedAt" IS NULL
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::bigint AS count FROM "Task"
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(DISTINCT account.id)::bigint AS count
      FROM "Account" account
      JOIN "SystemRoleAssignment" assignment
        ON assignment."accountId" = account.id
      WHERE COALESCE(to_jsonb(account)->>'projectAccessStatus', 'ACTIVE') = 'ACTIVE'
        AND assignment."revokedAt" IS NULL
        AND assignment.role::text IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
        AND btrim(assignment.team) = ''
        AND btrim(assignment."techGroup") = ''
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(DISTINCT account.id)::bigint AS count
      FROM "Account" account
      JOIN "SystemRoleAssignment" assignment
        ON assignment."accountId" = account.id
      WHERE COALESCE(to_jsonb(account)->>'projectAccessStatus', 'ACTIVE') = 'ACTIVE'
        AND assignment."revokedAt" IS NULL
        AND assignment.role::text IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
        AND btrim(assignment.team) = ''
        AND btrim(assignment."techGroup") = ''
        AND EXISTS (
          SELECT 1
          FROM "AccountIdentity" identity
          WHERE identity."accountId" = account.id
            AND identity.provider = 'FEISHU'
            AND identity."tenantId" = 'default'
            AND length(btrim(coalesce(identity."openId", ''))) > 0
        )
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::bigint AS count
      FROM "MilestoneReview"
      WHERE result = 'PENDING' AND "revokedAt" IS NULL
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::bigint AS count
      FROM "RevisionNode"
      WHERE status = 'PENDING_APPROVAL'
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::bigint AS count
      FROM "InAppNotification"
      WHERE "eventKey" LIKE 'pm:milestone:review_submitted:%'
         OR "eventKey" LIKE 'pm:revision:pending_review:%'
    `,
    prisma.$queryRaw<CountRow[]>`
      SELECT count(*)::bigint AS count
      FROM "NotificationOutbox"
      WHERE status IN ('PENDING', 'PROCESSING', 'FAILED')
        AND (
          "eventKey" ~ '^pm:milestone:review_submitted:[0-9a-f-]+:feishu$'
          OR "eventKey" ~ '^pm:revision:pending_review:[0-9a-f-]+:feishu$'
        )
    `,
  ]);

  const taskCount = numberValue(taskRows[0]?.count);
  const requiresApprovalAdministrator =
    taskCount > 0 ||
    numberValue(pendingMilestoneRows[0]?.count) > 0 ||
    numberValue(pendingRevisionRows[0]?.count) > 0;

  const report = {
    zeroOwnerTasks: numberValue(zeroOwnerRows[0]?.count),
    duplicateActiveTaskPeople: numberValue(duplicateMemberRows[0]?.count),
    activeTaskMembersByRole: Object.fromEntries(
      activeRoleRows.map((row) => [row.role, numberValue(row.count)]),
    ),
    membershipConversions: Object.fromEntries(
      conversionRows.map((row) => [row.role, numberValue(row.count)]),
    ),
    segmentParticipantBackfills: numberValue(segmentBackfillRows[0]?.count),
    orphanTaskLinkedSegments: numberValue(orphanSegmentRows[0]?.count),
    activeGroupLeaderAssignments: numberValue(activeGroupLeaderRows[0]?.count),
    taskCount,
    activeGlobalAdministratorAccounts: numberValue(
      activeGlobalAdministratorRows[0]?.count,
    ),
    feishuReachableGlobalAdministratorAccounts: numberValue(
      feishuReachableGlobalAdministratorRows[0]?.count,
    ),
    pendingMilestoneReviews: numberValue(pendingMilestoneRows[0]?.count),
    pendingRevisions: numberValue(pendingRevisionRows[0]?.count),
    legacyApprovalInAppNotifications: numberValue(legacyInAppRows[0]?.count),
    retryableLegacyApprovalOutboxes: numberValue(
      retryableLegacyOutboxRows[0]?.count,
    ),
    ready:
      numberValue(zeroOwnerRows[0]?.count) === 0 &&
      numberValue(orphanSegmentRows[0]?.count) === 0 &&
      (!requiresApprovalAdministrator ||
        (numberValue(activeGlobalAdministratorRows[0]?.count) > 0 &&
          numberValue(feishuReachableGlobalAdministratorRows[0]?.count) > 0)),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
