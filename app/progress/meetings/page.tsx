import Link from "next/link";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { listMeetings } from "@/lib/project-management/meetings/service";
import { canManageMeetings } from "@/lib/project-management/meetings/permissions";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { formatDateTime } from "@/lib/project-management/labels";
import { routes } from "@/lib/routes";
import { getProgressActorOrRedirect } from "../_auth";

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await getProgressActorOrRedirect();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  const result = await listMeetings({ query, cursor }).then((data) => ({ data, error: "" })).catch((error: unknown) => ({ data: null, error: toProjectManagementServiceError(error).message }));
  return <>
    <PageCommandBar title="会议" actions={canManageMeetings(actor) && <Link className={buttonVariants()} href={routes.progress.meetingNew}>创建会议</Link>} />
    <main className="mx-auto min-w-0 max-w-[96rem] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <form action={routes.progress.meetings} className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-2"><Label htmlFor="meeting-search">搜索会议主题</Label><Input id="meeting-search" name="q" defaultValue={query} maxLength={200} /></div>
        <Button type="submit" variant="outline">搜索</Button>
      </form>
      {result.error && <p role="alert" className="text-destructive">{result.error} <Link href={routes.progress.meetings} className="underline">重新加载列表</Link></p>}
      {result.data?.items.length === 0 && <p role="status">{query ? "没有符合条件的会议" : "暂无会议记录"}</p>}
      <ul className="space-y-3">
        {result.data?.items.map((meeting) => <li key={meeting.id} className="min-w-0 rounded-lg border bg-card p-4">
          <Link href={routes.progress.meetingDetail(meeting.id)} className="break-words font-medium text-primary underline-offset-4 hover:underline [overflow-wrap:anywhere]">{meeting.topic}</Link>
          <p className="mt-2 break-words text-sm [overflow-wrap:anywhere]">参与人：{meeting.participants.map((person) => person.displayName).join("、")}</p>
          <p className="mt-2 text-sm text-muted-foreground">工作区间：{formatDateTime(meeting.rangeStart)} 至 {formatDateTime(meeting.rangeEnd)}</p>
          <p className="mt-1 text-xs text-muted-foreground">更新于 {formatDateTime(meeting.updatedAt)}</p>
        </li>)}
      </ul>
      {result.data?.nextCursor && <Link className={buttonVariants({ variant: "outline" })} href={`${routes.progress.meetings}?${new URLSearchParams({ q: query, cursor: result.data.nextCursor })}`}>下一页会议</Link>}
    </main>
  </>;
}
