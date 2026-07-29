import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { ProgressShell } from "@/components/project-management/progress-shell";
import { ResourceTimelineClient } from "@/components/project-management/resource-timeline-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getUnreadInAppNotificationCount } from "@/lib/project-management/queries/notification-queries";
import {
  listTimelinePeople,
  listWorkSegments,
} from "@/lib/project-management/queries/resource-queries";
import { listTasks } from "@/lib/project-management/queries/task-queries";
import { getProgressActorOrRedirect } from "../_auth";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProgressResourcesPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const startAt = parseDateParam(firstParam(params.start), startOfToday());
  const endAt = parseDateParam(
    firstParam(params.end),
    new Date(startAt.getTime() + 7 * 24 * 60 * 60 * 1_000),
  );
  const taskId = uuidOrUndefined(firstParam(params.taskId));
  const personId = uuidOrUndefined(firstParam(params.personId));

  const [segments, people, tasks, unreadCount] = await Promise.all([
    listWorkSegments({
      actor,
      input: {
        startAt,
        endAt,
        taskId,
        personId,
        limit: 100,
      },
    }),
    listTimelinePeople({ actor }),
    listTasks({ actor, input: { status: "ACTIVE", limit: 100 } }),
    getUnreadInAppNotificationCount(actor),
  ]);

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressShell
          title="人员计划"
          subtitle="查看计划与实际投入，处理确认、移动、拆分、合并和取消。"
          unreadCount={unreadCount}
        >
          <form className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-[180px_180px_1fr_auto]">
            <Input
              name="start"
              type="date"
              defaultValue={toDateInput(startAt)}
              aria-label="开始日期"
            />
            <Input
              name="end"
              type="date"
              defaultValue={toDateInput(endAt)}
              aria-label="结束日期"
            />
            <select
              name="personId"
              defaultValue={personId ?? ""}
              aria-label="人员筛选"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            >
              <option value="">全部可见人员</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
            {taskId && <input type="hidden" name="taskId" value={taskId} />}
            <Button type="submit">刷新范围</Button>
          </form>
          <ResourceTimelineClient
            segments={segments.items}
            people={people}
            tasks={tasks.items.map((task) => ({
              id: task.id,
              title: task.title,
              activeNodeId: task.activeMilestone?.nodeId ?? null,
            }))}
            defaultPersonId={actor.personId}
            rangeStart={startAt.toISOString()}
            rangeEnd={new Date(startAt.getTime() + 60 * 60 * 1_000).toISOString()}
          />
        </ProgressShell>
      </PageShell>
    </>
  );
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function parseDateParam(value: string, fallback: Date) {
  if (!value) return fallback;
  const parsed = new Date(`${value}T00:00:00.000+08:00`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function startOfToday() {
  const now = new Date();
  return new Date(`${formatShanghaiDate(now)}T00:00:00.000+08:00`);
}

function toDateInput(value: Date) {
  return formatShanghaiDate(value);
}

function uuidOrUndefined(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
    ? value
    : undefined;
}

function formatShanghaiDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}
