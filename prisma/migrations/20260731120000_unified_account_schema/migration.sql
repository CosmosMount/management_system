-- Add the unified cross-domain and project roles without removing legacy values.
ALTER TYPE "ProjectManagementSystemRole" ADD VALUE IF NOT EXISTS 'SUPER_ADMINISTRATOR';
ALTER TYPE "ProjectManagementSystemRole" ADD VALUE IF NOT EXISTS 'PROJECT_ADMINISTRATOR';
ALTER TYPE "ProjectManagementSystemRole" ADD VALUE IF NOT EXISTS 'GROUP_LEADER';

ALTER TABLE "User"
  ADD COLUMN "accountId" TEXT;

ALTER TABLE "UserRole"
  ADD COLUMN "accountId" TEXT,
  ADD COLUMN "grantedByAccountId" TEXT,
  ADD COLUMN "revokedByAccountId" TEXT,
  ADD COLUMN "revokedAt" TIMESTAMPTZ(6),
  ADD COLUMN "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "SystemRoleAssignment"
  ADD COLUMN "revokedByAccountId" TEXT;

DROP INDEX "UserRole_openId_role_team_techGroup_key";

ALTER TABLE "SystemRoleAssignment"
  DROP CONSTRAINT "SystemRoleAssignment_scope_required_check",
  ADD CONSTRAINT "SystemRoleAssignment_scope_required_check"
    CHECK (
      "revokedAt" IS NOT NULL
      OR (
        "role" IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR', 'SYSTEM_ADMINISTRATOR')
        AND "team" = ''
        AND "techGroup" = ''
      )
      OR (
        "role" = 'GROUP_LEADER'
        AND (
          (length(btrim("team")) > 0 AND "techGroup" = '')
          OR ("team" = '' AND length(btrim("techGroup")) > 0)
        )
      )
      OR (
        "role" = 'AUDITOR'
        AND ("team" = '' OR length(btrim("team")) > 0)
        AND ("techGroup" = '' OR length(btrim("techGroup")) > 0)
      )
      OR (
        "role" IN ('TEAM_ADMINISTRATOR', 'RESOURCE_MANAGER')
        AND ("team" = '' OR length(btrim("team")) > 0)
        AND ("techGroup" = '' OR length(btrim("techGroup")) > 0)
        AND (length(btrim("team")) > 0 OR length(btrim("techGroup")) > 0)
      )
    );

CREATE UNIQUE INDEX "User_accountId_key" ON "User"("accountId");
CREATE INDEX "UserRole_accountId_role_idx" ON "UserRole"("accountId", "role");
CREATE INDEX "UserRole_openId_role_idx" ON "UserRole"("openId", "role");
CREATE INDEX "UserRole_revokedAt_idx" ON "UserRole"("revokedAt");
CREATE UNIQUE INDEX "UserRole_active_account_role_scope_key"
  ON "UserRole"("accountId", "role", "team", "techGroup")
  WHERE "revokedAt" IS NULL;
CREATE INDEX "SystemRoleAssignment_revokedByAccountId_idx"
  ON "SystemRoleAssignment"("revokedByAccountId");

ALTER TABLE "User"
  ADD CONSTRAINT "User_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UserRole"
  ADD CONSTRAINT "UserRole_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "UserRole_grantedByAccountId_fkey"
  FOREIGN KEY ("grantedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "UserRole_revokedByAccountId_fkey"
  FOREIGN KEY ("revokedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SystemRoleAssignment"
  ADD CONSTRAINT "SystemRoleAssignment_revokedByAccountId_fkey"
  FOREIGN KEY ("revokedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
