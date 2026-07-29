import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { ConflictCenterClient } from "@/components/project-management/conflict-center-client";
import { ProgressShell } from "@/components/project-management/progress-shell";
import { Button } from "@/components/ui/button";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { conflictStatusLabels } from "@/lib/project-management/labels";
import { getUnreadInAppNotificationCount } from "@/lib/project-management/queries/notification-queries";
import {
  getResourceConflict,
  listResourceConflicts,
} from "@/lib/project-management/queries/resource-queries";
import { getProgressActorOrRedirect } from "../../_auth";

type SearchParams = Record<string, string | string[] | undefined>;

const conflictStatusValues = ["OPEN", "ACKNOWLEDGED", "RESOLVED", "IGNORED"] as const;

export default async function ProgressConflictsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const status = firstParam(params.status);
  const conflictId = uuidOrUndefined(firstParam(params.conflictId));
  const [conflicts, unreadCount] = await Promise.all([
    listResourceConflicts({
      actor,
      input: {
        status: conflictStatusValues.includes(
          status as (typeof conflictStatusValues)[number],
        )
          ? (status as (typeof conflictStatusValues)[number])
          : "OPEN",
        limit: 50,
      },
    }),
    getUnreadInAppNotificationCount(actor),
  ]);
  const selectedConflict = conflictId
    ? await getResourceConflict({ actor, input: { conflictId } }).catch((error) => {
        const mapped = toProjectManagementServiceError(error);
        if (mapped.code === "NOT_FOUND") notFound();
        throw error;
      })
    : conflicts.items[0] ?? null;

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressShell
          title="资源冲突"
          subtitle="查看冲突解释，确认已知、忽略、解决或应用服务端建议。"
          unreadCount={unreadCount}
        >
          <form className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4">
            <select
              name="status"
              defaultValue={status || "OPEN"}
              aria-label="冲突状态"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            >
              {conflictStatusValues.map((value) => (
                <option key={value} value={value}>
                  {conflictStatusLabels[value]}
                </option>
              ))}
            </select>
            <Button type="submit">筛选</Button>
          </form>
          <ConflictCenterClient
            conflicts={conflicts.items}
            selectedConflict={selectedConflict}
          />
        </ProgressShell>
      </PageShell>
    </>
  );
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function uuidOrUndefined(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
    ? value
    : undefined;
}
