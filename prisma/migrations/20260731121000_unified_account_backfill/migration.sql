-- Abort instead of guessing when one Feishu identity points at multiple accounts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User" u
    JOIN "AccountIdentity" i
      ON i."provider" = 'FEISHU'
      AND i."tenantId" = 'default'
      AND (
        i."openId" = u."openId"
        OR (u."unionId" IS NOT NULL AND i."unionId" = u."unionId")
      )
    GROUP BY u.id
    HAVING count(DISTINCT i."accountId") > 1
  ) THEN
    RAISE EXCEPTION '统一账号迁移失败：飞书身份关联了多个 Account，请先运行预检并处理冲突';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "User" u
    JOIN "AccountIdentity" i
      ON i."provider" = 'FEISHU'
      AND i."tenantId" = 'default'
      AND (
        i."openId" = u."openId"
        OR (u."unionId" IS NOT NULL AND i."unionId" = u."unionId")
      )
    GROUP BY u.id
    HAVING count(DISTINCT i.id) > 1
  ) THEN
    RAISE EXCEPTION '统一账号迁移失败：同一飞书用户命中多个 AccountIdentity，请先运行预检并处理冲突';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "UserRole" r
    LEFT JOIN "User" u ON u."openId" = r."openId"
    WHERE u.id IS NULL
  ) THEN
    RAISE EXCEPTION '统一账号迁移失败：存在无法关联 User 的 UserRole';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SystemRoleAssignment"
    WHERE "revokedAt" IS NULL
      AND "role" = 'TEAM_ADMINISTRATOR'
      AND length(btrim("team")) > 0
      AND length(btrim("techGroup")) > 0
  ) THEN
    RAISE EXCEPTION '统一账号迁移失败：存在同时包含车组和技术组的 TEAM_ADMINISTRATOR，请先显式拆分范围';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SystemRoleAssignment"
    WHERE "revokedAt" IS NULL
      AND role = 'TEAM_ADMINISTRATOR'
      AND NOT (
        (team IN ('英雄', '工程', '步兵', '哨兵', '无人机', '飞镖', '雷达', '通用') AND "techGroup" = '')
        OR (team = '' AND "techGroup" IN ('机械', '硬件', '电控', '算法', '宣运', '通用'))
      )
  ) THEN
    RAISE EXCEPTION '统一账号迁移失败：TEAM_ADMINISTRATOR 的车组或技术组范围无效';
  END IF;

  IF EXISTS (SELECT 1 FROM "User")
    AND NOT EXISTS (SELECT 1 FROM "UserRole" WHERE role = 'SUPER_ADMIN') THEN
    RAISE EXCEPTION '统一账号迁移失败：至少需要一名旧报销 SUPER_ADMIN';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "UserRole"
    GROUP BY "openId", role, team, "techGroup"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '统一账号迁移失败：存在重复报销角色';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "UserRole"
    WHERE NOT (
      (role = 'SUPER_ADMIN' AND team = '' AND "techGroup" = '')
      OR (role IN ('TEAM_ADMIN', 'FINANCE') AND team IN ('英雄', '工程', '步兵', '哨兵', '无人机', '飞镖', '雷达', '通用') AND "techGroup" = '')
      OR (role IN ('TECH_GROUP_ADMIN', 'TEACHER') AND team = '' AND "techGroup" IN ('机械', '硬件', '电控', '算法', '宣运', '通用'))
    )
  ) THEN
    RAISE EXCEPTION '统一账号迁移失败：存在非法报销角色范围';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "SystemRoleAssignment"
    WHERE "revokedAt" IS NULL
    GROUP BY "accountId", role, team, "techGroup"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '统一账号迁移失败：存在重复项目角色';
  END IF;
END $$;

CREATE TEMP TABLE "_UnifiedUserAccountMap" (
  "userId" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL UNIQUE,
  "created" BOOLEAN NOT NULL
) ON COMMIT DROP;

INSERT INTO "_UnifiedUserAccountMap" ("userId", "accountId", "created")
SELECT u.id, min(i."accountId"), false
FROM "User" u
JOIN "AccountIdentity" i
  ON i."provider" = 'FEISHU'
  AND i."tenantId" = 'default'
  AND (
    i."openId" = u."openId"
    OR (u."unionId" IS NOT NULL AND i."unionId" = u."unionId")
  )
GROUP BY u.id;

INSERT INTO "_UnifiedUserAccountMap" ("userId", "accountId", "created")
SELECT u.id, gen_random_uuid()::text, true
FROM "User" u
WHERE NOT EXISTS (
  SELECT 1 FROM "_UnifiedUserAccountMap" m WHERE m."userId" = u.id
);

INSERT INTO "Account" (id, status, "lastLoginAt", "createdAt", "updatedAt")
SELECT m."accountId", 'ACTIVE', u."createdAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "_UnifiedUserAccountMap" m
JOIN "User" u ON u.id = m."userId"
WHERE m.created;

INSERT INTO "Person" (id, "accountId", "displayName", avatar, status, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, m."accountId", u.name, u.avatar, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "_UnifiedUserAccountMap" m
JOIN "User" u ON u.id = m."userId"
WHERE NOT EXISTS (
  SELECT 1 FROM "Person" p WHERE p."accountId" = m."accountId"
);

INSERT INTO "AccountIdentity" (
  id, "accountId", provider, "providerSubject", "tenantId", "openId", "unionId", metadata, "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  m."accountId",
  'FEISHU',
  COALESCE(u."unionId", 'open:' || u."openId"),
  'default',
  u."openId",
  u."unionId",
  jsonb_build_object('source', 'unified-account-migration'),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_UnifiedUserAccountMap" m
JOIN "User" u ON u.id = m."userId"
WHERE m.created;

UPDATE "User" u
SET "accountId" = m."accountId"
FROM "_UnifiedUserAccountMap" m
WHERE m."userId" = u.id;

UPDATE "UserRole" r
SET "accountId" = u."accountId"
FROM "User" u
WHERE u."openId" = r."openId";

-- Capture every active legacy row before revocation so each retired grant has
-- a complete MIGRATION audit record, including roles that are not mapped.
CREATE TEMP TABLE "_UnifiedLegacySystemRoles" ON COMMIT DROP AS
SELECT id, "accountId", role::text AS role, team, "techGroup"
FROM "SystemRoleAssignment"
WHERE "revokedAt" IS NULL
  AND role IN ('SYSTEM_ADMINISTRATOR', 'TEAM_ADMINISTRATOR', 'RESOURCE_MANAGER', 'AUDITOR');

CREATE TEMP TABLE "_UnifiedLegacyReimbursementSuperAdmins" ON COMMIT DROP AS
SELECT id
FROM "UserRole"
WHERE "revokedAt" IS NULL AND role = 'SUPER_ADMIN';

-- Existing procurement super administrators become the cross-domain super administrators.
INSERT INTO "SystemRoleAssignment" (
  id, "accountId", role, team, "techGroup", "grantedByAccountId", "revokedByAccountId", "revokedAt", "createdAt"
)
SELECT gen_random_uuid()::text, r."accountId", 'SUPER_ADMINISTRATOR', '', '', NULL, NULL, NULL, CURRENT_TIMESTAMP
FROM "UserRole" r
WHERE r.role = 'SUPER_ADMIN'
  AND r."revokedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "SystemRoleAssignment" s
    WHERE s."accountId" = r."accountId"
      AND s.role = 'SUPER_ADMINISTRATOR'
      AND s."revokedAt" IS NULL
  );

-- A legacy project system administrator keeps project-wide rights, without gaining reimbursement rights.
INSERT INTO "SystemRoleAssignment" (
  id, "accountId", role, team, "techGroup", "grantedByAccountId", "revokedByAccountId", "revokedAt", "createdAt"
)
SELECT gen_random_uuid()::text, s."accountId", 'PROJECT_ADMINISTRATOR', '', '', s."grantedByAccountId", NULL, NULL, CURRENT_TIMESTAMP
FROM "SystemRoleAssignment" s
WHERE s.role = 'SYSTEM_ADMINISTRATOR'
  AND s."revokedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "SystemRoleAssignment" active
    WHERE active."accountId" = s."accountId"
      AND active.role = 'SUPER_ADMINISTRATOR'
      AND active."revokedAt" IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM "SystemRoleAssignment" active
    WHERE active."accountId" = s."accountId"
      AND active.role = 'PROJECT_ADMINISTRATOR'
      AND active."revokedAt" IS NULL
  );

INSERT INTO "SystemRoleAssignment" (
  id, "accountId", role, team, "techGroup", "grantedByAccountId", "revokedByAccountId", "revokedAt", "createdAt"
)
SELECT gen_random_uuid()::text, s."accountId", 'GROUP_LEADER', s.team, s."techGroup", s."grantedByAccountId", NULL, NULL, CURRENT_TIMESTAMP
FROM "SystemRoleAssignment" s
WHERE s.role = 'TEAM_ADMINISTRATOR'
  AND s."revokedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "SystemRoleAssignment" active
    WHERE active."accountId" = s."accountId"
      AND active.role = 'GROUP_LEADER'
      AND active.team = s.team
      AND active."techGroup" = s."techGroup"
      AND active."revokedAt" IS NULL
  );

-- Keep legacy rows as immutable history while removing them from active authorization.
UPDATE "SystemRoleAssignment"
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "revokedAt" IS NULL
  AND role IN ('SYSTEM_ADMINISTRATOR', 'TEAM_ADMINISTRATOR', 'RESOURCE_MANAGER', 'AUDITOR');

UPDATE "UserRole"
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "revokedAt" IS NULL AND role = 'SUPER_ADMIN';

INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", before, after, reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:unified-account:role:' || s.id,
  'account.role.migrated',
  'SystemRoleAssignment',
  s.id,
  jsonb_build_object('source', 'legacy-project-or-reimbursement-role'),
  jsonb_build_object('role', s.role, 'team', s.team, 'techGroup', s."techGroup", 'active', true),
  '统一账号角色迁移；不发送用户通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "SystemRoleAssignment" s
WHERE s.role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR', 'GROUP_LEADER')
  AND s."revokedAt" IS NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", before, after, reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:unified-account:legacy-system-role:' || legacy_role.id,
  'account.legacy_role.revoked',
  'SystemRoleAssignment',
  legacy_role.id,
  jsonb_build_object(
    'role', legacy_role.role,
    'team', legacy_role.team,
    'techGroup', legacy_role."techGroup",
    'active', true
  ),
  jsonb_build_object(
    'role', legacy_role.role,
    'team', legacy_role.team,
    'techGroup', legacy_role."techGroup",
    'active', false,
    'revokedAt', current_assignment."revokedAt"
  ),
  '旧项目角色已退役；不发送用户通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "_UnifiedLegacySystemRoles" legacy_role
JOIN "SystemRoleAssignment" current_assignment
  ON current_assignment.id = legacy_role.id
ON CONFLICT (id) DO NOTHING;

INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", before, after, reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:unified-account:legacy-reimbursement-role:' || r.id,
  'account.legacy_role.revoked',
  'UserRole',
  r.id,
  jsonb_build_object('role', r.role, 'team', r.team, 'techGroup', r."techGroup", 'active', true),
  jsonb_build_object('active', false, 'revokedAt', r."revokedAt"),
  '旧报销超级管理员已迁为统一超级管理员；不发送用户通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "UserRole" r
WHERE r.role = 'SUPER_ADMIN' AND r."revokedAt" IS NOT NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", before, after, reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:unified-account:account:' || m."accountId",
  'account.role.migrated',
  'Account',
  m."accountId",
  jsonb_build_object('source', 'legacy-account-roles'),
  jsonb_build_object('status', 'MIGRATED'),
  '统一账号与权限迁移；不发送用户通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "_UnifiedUserAccountMap" m
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  added_accounts integer;
  mapped_roles integer;
  revoked_roles integer;
  skipped_users integer;
BEGIN
  SELECT count(*) INTO added_accounts
  FROM "_UnifiedUserAccountMap" WHERE created;
  SELECT count(*) INTO mapped_roles
  FROM "SystemRoleAssignment"
  WHERE "revokedAt" IS NULL
    AND role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR', 'GROUP_LEADER');
  SELECT
    (SELECT count(*) FROM "_UnifiedLegacySystemRoles") +
    (SELECT count(*) FROM "_UnifiedLegacyReimbursementSuperAdmins")
  INTO revoked_roles;
  SELECT count(*) INTO skipped_users
  FROM "_UnifiedUserAccountMap" WHERE NOT created;
  RAISE NOTICE
    'unified_account_migration_report added=%, mapped_active=%, revoked=%, conflicts=0, skipped=%',
    added_accounts, mapped_roles, revoked_roles, skipped_users;
END $$;
