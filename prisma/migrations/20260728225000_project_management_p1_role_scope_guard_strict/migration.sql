-- Tighten project-management role scope rules after the initial P1 guard.
ALTER TABLE "SystemRoleAssignment"
  DROP CONSTRAINT "SystemRoleAssignment_scope_required_check",
  ADD CONSTRAINT "SystemRoleAssignment_scope_required_check"
    CHECK (
      ("role" = 'SYSTEM_ADMINISTRATOR' AND "team" = '' AND "techGroup" = '')
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
