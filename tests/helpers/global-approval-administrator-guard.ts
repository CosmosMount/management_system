import { prisma } from "../../lib/prisma";

const GUARDED_TABLE_TRIGGERS = [
  ["Account", "Account_usable_global_administrator_update_guard_v2"],
  ["Account", "Account_usable_global_administrator_delete_guard_v2"],
  [
    "AccountIdentity",
    "AccountIdentity_usable_global_administrator_update_guard_v2",
  ],
  [
    "AccountIdentity",
    "AccountIdentity_usable_global_administrator_delete_guard_v2",
  ],
  [
    "SystemRoleAssignment",
    "SystemRoleAssignment_global_administrator_update_guard_v2",
  ],
  [
    "SystemRoleAssignment",
    "SystemRoleAssignment_global_administrator_delete_guard_v2",
  ],
] as const;

/**
 * Isolated regression tests use this only to exercise application-level
 * fail-closed behavior for a database state that production now prevents.
 */
export async function withGlobalApprovalAdministratorGuardDisabled<T>(
  run: () => Promise<T>,
): Promise<T> {
  await setGuardState("DISABLE");
  try {
    return await run();
  } finally {
    await setGuardState("ENABLE");
  }
}

async function setGuardState(state: "DISABLE" | "ENABLE") {
  await prisma.$transaction(async (tx) => {
    for (const [table, trigger] of GUARDED_TABLE_TRIGGERS) {
      await tx.$executeRawUnsafe(
        `ALTER TABLE "${table}" ${state} TRIGGER "${trigger}"`,
      );
    }
  });
}
