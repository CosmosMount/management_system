-- Avoid serializing ordinary logins and unrelated account/identity updates.
-- Only changes that can remove a usable administrator enqueue the permanent
-- deferred invariant check.
DROP TRIGGER IF EXISTS "Account_usable_global_administrator_guard_v2"
ON "Account";

DROP TRIGGER IF EXISTS "AccountIdentity_usable_global_administrator_guard_v2"
ON "AccountIdentity";

CREATE CONSTRAINT TRIGGER "Account_usable_global_administrator_update_guard_v2"
AFTER UPDATE ON "Account"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."projectAccessStatus" IS DISTINCT FROM NEW."projectAccessStatus")
EXECUTE FUNCTION "assert_usable_global_approval_administrator_v2"();

CREATE CONSTRAINT TRIGGER "Account_usable_global_administrator_delete_guard_v2"
AFTER DELETE ON "Account"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_usable_global_approval_administrator_v2"();

CREATE CONSTRAINT TRIGGER "AccountIdentity_usable_global_administrator_update_guard_v2"
AFTER UPDATE ON "AccountIdentity"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD."accountId" IS DISTINCT FROM NEW."accountId"
  OR OLD.provider IS DISTINCT FROM NEW.provider
  OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
  OR OLD."openId" IS DISTINCT FROM NEW."openId"
)
EXECUTE FUNCTION "assert_usable_global_approval_administrator_v2"();

CREATE CONSTRAINT TRIGGER "AccountIdentity_usable_global_administrator_delete_guard_v2"
AFTER DELETE ON "AccountIdentity"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD.provider = 'FEISHU'
  AND OLD."tenantId" = 'default'
  AND length(btrim(coalesce(OLD."openId", ''))) > 0
)
EXECUTE FUNCTION "assert_usable_global_approval_administrator_v2"();
