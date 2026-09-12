import { MeetingExportButton } from "@/components/project-management/meetings/meeting-export-button";
import { MeetingWorkSegmentReminder } from "@/components/project-management/meetings/meeting-work-segment-reminder";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { MeetingTimeline } from "@/components/project-management/meetings/meeting-timeline";
import { buttonVariants } from "@/components/ui/button";
import { getMeeting } from "@/lib/project-management/meetings/service";
import { canManageMeetings } from "@/lib/project-management/meetings/permissions";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { idSchema } from "@/lib/project-management/validations/lifecycle";
import { formatDateTime } from "@/lib/project-management/labels";
import { routes } from "@/lib/routes";
import { getProgressActorOrRedirect } from "../../_auth";

export default async function MeetingPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();
  const meeting = await getMeeting({ meetingId: id }).catch((error: unknown) => {
    if (toProjectManagementServiceError(error).code === "NOT_FOUND") notFound();
    throw error;
  });
  const saved = (await searchParams).saved === "1";
  return <>
    <PageCommandBar title={`会议纪要：${meeting.topic}`} actions={<div className="flex flex-wrap gap-2">{canManageMeetings(actor) && <Link href={routes.progress.meetingEdit(id)} className={buttonVariants({ variant: "outline" })}>编辑</Link>}<MeetingExportButton meetingId={id} /></div>} />
    <main className="mx-auto min-w-0 max-w-[96rem] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {saved && <p role="status">会议已保存，所有登录用户均可查看。</p>}
      <section className="min-w-0 rounded-xl border bg-card p-6" aria-label="会议基本信息">
        <h2 className="mb-5 text-xl font-semibold">会议基本信息</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <p className="break-words text-sm"><span className="text-muted-foreground">参与人：</span>{meeting.participants.map((person) => `${person.displayName}${person.status === "INACTIVE" ? "（已停用）" : ""}`).join("、")}</p>
          <p className="text-sm"><span className="text-muted-foreground">工作区间：</span>{formatDateTime(meeting.rangeStart)} 至 {formatDateTime(meeting.rangeEnd)}（北京时间）</p>
          <p className="text-sm"><span className="text-muted-foreground">更新时间：</span>{formatDateTime(meeting.updatedAt)}</p>
        </div>
      </section>
      <section className="min-w-0 rounded-xl border bg-card p-6" aria-labelledby="meeting-timeline-heading">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 id="meeting-timeline-heading" className="text-xl font-semibold">相关任务进度</h2>{actor.isActive && meeting.participants.some((person) => person.id === actor.personId) && <MeetingWorkSegmentReminder meetingId={id} />}</div>
        <MeetingTimeline source={{ kind: "SAVED", meetingId: id, rangeStart: meeting.rangeStart, rangeEnd: meeting.rangeEnd }} />
      </section>
      <section aria-labelledby="meeting-content-heading" className="min-w-0 rounded-xl border bg-card p-6">
        <h2 id="meeting-content-heading" className="mb-3 text-xl font-semibold">会议内容</h2>
        <div className="min-h-32 rounded-lg border border-input px-3 py-3 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]" aria-label="会议内容">{meeting.minutes || <span className="text-muted-foreground">暂未填写会议内容</span>}</div>
      </section>
    </main>
  </>;
}
