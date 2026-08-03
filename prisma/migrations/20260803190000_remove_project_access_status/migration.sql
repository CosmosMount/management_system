-- Removing project-level account disabling restores project entry for every
-- previously disabled account. Record that security-relevant transition before
-- dropping the source column; this migration intentionally sends no notification.
BEGIN;

INSERT INTO "DomainAuditEvent" (
  id,
  action,
  "entityType",
  "entityId",
  before,
  after,
  reason,
  "requestId",
  source,
  "schemaVersion",
  "createdAt"
)
SELECT
  'migration:remove-project-access-status:' || account.id,
  'account.project_access.removed',
  'Account',
  account.id,
  jsonb_build_object('projectAccessStatus', 'DISABLED'),
  jsonb_build_object('projectAccessStatus', NULL, 'projectAccessRestored', true),
  '项目访问禁用机制已移除；账号恢复项目入口；不发送用户通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "Account" account
WHERE account."projectAccessStatus" = 'DISABLED'
ON CONFLICT (id) DO NOTHING;

ALTER TABLE "Account" DROP COLUMN "projectAccessStatus";
DROP TYPE "AccountStatus";

COMMIT;
