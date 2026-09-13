import Link from "next/link";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { buttonVariants } from "@/components/ui/button";
import { MeetingFilterForm } from "@/components/project-management/meetings/meeting-filter-form";
import { MeetingTemplateBrowser } from "@/components/project-management/meetings/meeting-template-browser";
import { listMeetingTemplates } from "@/lib/project-management/meetings/template-service";
import { listMeetings } from "@/lib/project-management/meetings/service";
import { canManageMeetings } from "@/lib/project-management/meetings/permissions";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { formatDateTime } from "@/lib/project-management/labels";
import { routes } from "@/lib/routes";
import { getProgressActorOrRedirect } from "../_auth";

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await getProgressActorOrRedirect();
  const params = await searchParams;
  const templates = canManageMeetings(actor) ? await listMeetingTemplates(actor)
    .then((data) => ({ data, error: "" }))
    .catch((error: unknown) => ({ data: null, error: toProjectManagementServiceError(error).message })) : null;
  const filters: Record<string, string> = {};
  const keys = ["q", "personId", "dateFrom", "dateTo", "period", "projectId", "taskId", "mine", "sort"];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value) filters[key] = value;
  }
  const query = filters.q ?? "";
  const invalidParameters = [...keys, "cursor"].some((key) => Array.isArray(params[key])) || (filters.mine !== undefined && filters.mine !== "1");
  const cursor = typeof params.cursor === "string" && params.cursor ? params.cursor : undefined;
  const result = invalidParameters ? { data: null, error: "筛选参数不正确，请重置筛选后重试" } : await listMeetings({
    query, personId: filters.personId, dateFrom: filters.dateFrom, dateTo: filters.dateTo,
    period: filters.period, projectId: filters.projectId, taskId: filters.taskId,
    mine: filters.mine === "1", sort: filters.sort, cursor,
  }, actor).then((data) => ({ data, error: "" })).catch((error: unknown) => ({ data: null, error: toProjectManagementServiceError(error).message }));
  return <>
    <PageCommandBar title="会议" actions={canManageMeetings(actor) && <Link className={buttonVariants()} href={routes.progress.meetingNew}>创建会议</Link>} />
    <main className="mx-auto min-w-0 max-w-[96rem] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <MeetingFilterForm key={JSON.stringify([filters, cursor])} initialValues={filters} />
      {params.templateSaved === "1" && <p role="status" className="text-sm text-primary">会议模板已保存</p>}
      <div className={templates ? "grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "min-w-0"}>
      <div className="min-w-0 space-y-4">
      {templates && <h2 className="text-lg font-semibold">会议记录</h2>}
      {result.error && <p role="alert" className="text-destructive">{result.error} <Link href={routes.progress.meetings} className="underline">重新加载列表</Link></p>}
      {result.data?.items.length === 0 && <p role="status">{Object.keys(filters).length ? "没有符合条件的会议" : "暂无会议记录"}</p>}
      {!!result.data?.items.length && <section aria-label="会议列表" className="min-w-0 overflow-hidden rounded-xl border bg-card">
        <div className="grid gap-3 border-b bg-muted/25 px-4 py-4 text-sm font-medium text-muted-foreground md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(12rem,1.5fr)_8rem]">
          <span>会议主题</span><span>参与人</span><span>工作区间</span><span>更新时间</span>
        </div>
        {result.data?.items.map((meeting) => <article key={meeting.id} className="grid min-w-0 gap-3 border-b px-4 py-4 text-sm last:border-b-0 hover:bg-muted/10 md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(12rem,1.5fr)_8rem] md:items-center">
          <Link href={routes.progress.meetingDetail(meeting.id)} className="min-w-0 break-words text-lg font-semibold text-primary underline-offset-4 hover:underline [overflow-wrap:anywhere]">{meeting.topic}</Link>
          <p className="min-w-0 break-words [overflow-wrap:anywhere]">{meeting.participants.map((person) => person.displayName).join("、") || "暂无参与人"}</p>
          <p className="text-muted-foreground">{formatDateTime(meeting.rangeStart)} 至 {formatDateTime(meeting.rangeEnd)}</p>
          <p className="text-muted-foreground">{formatDateTime(meeting.updatedAt)}</p>
        </article>)}
      </section>}
      {result.data?.nextCursor && <Link className={buttonVariants({ variant: "outline" })} href={`${routes.progress.meetings}?${new URLSearchParams({ ...filters, cursor: result.data.nextCursor })}`}>下一页会议</Link>}
      </div>
      {templates && <MeetingTemplateBrowser key={JSON.stringify(templates)} initialData={templates.data} initialError={templates.error} />}
      </div>
    </main>
  </>;
}
