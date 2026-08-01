-- Make the Account flag's project-only meaning explicit without changing its values.
ALTER TABLE "Account" RENAME COLUMN "status" TO "projectAccessStatus";

-- Backfill has linked every reimbursement User. Keep future writes from
-- reintroducing users outside the unified account model.
ALTER TABLE "User" ALTER COLUMN "accountId" SET NOT NULL;

-- Legacy project roles remain queryable history, but cannot be active assignments.
ALTER TABLE "SystemRoleAssignment"
  DROP CONSTRAINT "SystemRoleAssignment_scope_required_check",
  ADD CONSTRAINT "SystemRoleAssignment_scope_required_check"
    CHECK (
      "revokedAt" IS NOT NULL
      OR (
        "role" IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
        AND "team" = ''
        AND "techGroup" = ''
      )
      OR (
        "role" = 'GROUP_LEADER'
        AND (
          (length(btrim("team")) > 0 AND "techGroup" = '')
          OR ("team" = '' AND length(btrim("techGroup")) > 0)
        )
        AND ("team" = '' OR "team" IN ('英雄', '工程', '步兵', '哨兵', '无人机', '飞镖', '雷达', '通用'))
        AND ("techGroup" = '' OR "techGroup" IN ('机械', '硬件', '电控', '算法', '宣运', '通用'))
      )
    );

-- Active reimbursement assignments always belong to an Account and keep the
-- existing team/technical-group scope semantics. Legacy SUPER_ADMIN rows are
-- valid only after revocation.
ALTER TABLE "UserRole"
  ADD CONSTRAINT "UserRole_active_scope_check"
    CHECK (
      "revokedAt" IS NOT NULL
      OR (
        "accountId" IS NOT NULL
        AND (
          (
            "role" IN ('TEAM_ADMIN', 'FINANCE')
            AND "team" IN ('英雄', '工程', '步兵', '哨兵', '无人机', '飞镖', '雷达', '通用')
            AND "techGroup" = ''
          )
          OR (
            "role" IN ('TECH_GROUP_ADMIN', 'TEACHER')
            AND "team" = ''
            AND "techGroup" IN ('机械', '硬件', '电控', '算法', '宣运', '通用')
          )
        )
      )
    );
