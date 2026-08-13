"use client";

import { useCallback, useMemo, useState } from "react";
import type {
  AdminAccountRow,
  AdminResponsibilityAssignment,
} from "@/components/admin/account-types";
import { AccountHistoryDialog } from "@/components/admin/account-history-dialog";
import { AccountsAndRolesCard } from "@/components/admin/accounts-list-card";
import type { AccountFiltersValue } from "@/components/admin/accounts-contract";
import {
  TeamResponsibilitiesCard,
  TechGroupResponsibilitiesCard,
} from "@/components/admin/responsibility-cards";
import { useAccountMutation } from "@/components/admin/use-account-mutation";

export function AccountsPanel({
  accounts,
  responsibilities,
  page,
  pageSize,
  total,
  hasMoreByQuery,
  filters,
}: {
  accounts: AdminAccountRow[];
  responsibilities: AdminResponsibilityAssignment[];
  page: number;
  pageSize: number;
  total: number;
  hasMoreByQuery: boolean;
  filters: AccountFiltersValue;
}) {
  const { pending, run } = useAccountMutation();
  const [visibleResponsibilities, setVisibleResponsibilities] =
    useState(responsibilities);
  const [historyAccountId, setHistoryAccountId] = useState<string | null>(null);
  const historyAccount = useMemo(
    () => accounts.find((account) => account.id === historyAccountId) ?? null,
    [accounts, historyAccountId],
  );

  const showResponsibility = useCallback(
    (responsibility: AdminResponsibilityAssignment) => {
      setVisibleResponsibilities((current) => [
        ...current.filter((entry) => entry.id !== responsibility.id),
        responsibility,
      ]);
    },
    [],
  );
  const hideResponsibility = useCallback((assignmentId: string) => {
    setVisibleResponsibilities((current) =>
      current.filter((entry) => entry.id !== assignmentId),
    );
  }, []);

  return (
    <div className="min-w-0 space-y-6">
      <TeamResponsibilitiesCard
        responsibilities={visibleResponsibilities}
        pending={pending}
        run={run}
        onAdd={showResponsibility}
        onRemove={hideResponsibility}
      />
      <TechGroupResponsibilitiesCard
        responsibilities={visibleResponsibilities}
        pending={pending}
        run={run}
        onAdd={showResponsibility}
        onRemove={hideResponsibility}
      />
      <AccountsAndRolesCard
        accounts={accounts}
        page={page}
        pageSize={pageSize}
        total={total}
        hasMoreByQuery={hasMoreByQuery}
        filters={filters}
        pending={pending}
        run={run}
        onResponsibilityAdd={showResponsibility}
        onResponsibilityRemove={hideResponsibility}
        onShowHistory={setHistoryAccountId}
      />
      <AccountHistoryDialog
        account={historyAccount}
        open={historyAccount !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryAccountId(null);
        }}
      />
    </div>
  );
}
