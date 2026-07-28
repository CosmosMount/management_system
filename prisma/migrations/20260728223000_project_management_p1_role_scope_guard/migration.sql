-- Guard project-management role scopes that Prisma cannot express.
ALTER TABLE "SystemRoleAssignment"
  ADD CONSTRAINT "SystemRoleAssignment_scope_required_check"
    CHECK (
      ("role" = 'SYSTEM_ADMINISTRATOR' AND "team" = '' AND "techGroup" = '')
      OR "role" = 'AUDITOR'
      OR length(btrim("team")) > 0
      OR length(btrim("techGroup")) > 0
    );
