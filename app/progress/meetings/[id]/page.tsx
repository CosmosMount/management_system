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
    <PageCommandBar title={meeting.topic} actions={<div className="flex flex-wrap gap-2">{canManageMeetings(actor) && <Link href={routes.progress.meetingEdit(id)} className={buttonVariants()}>编辑会议</Link>}<MeetingExportButton meetingId={id} /></div>} />
    <main className="mx-auto min-w-0 max-w-[96rem] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {saved && <p role="status">会议已保存，所有登录用户均可查看。</p>}
      <section className="min-w-0 space-y-2 rounded-lg border bg-card p-4" aria-label="会议基本信息">
        <p className="break-words [overflow-wrap:anywhere]">参与人：{meeting.participants.map((person) => `${person.displayName}${person.status === "INACTIVE" ? "（已停用）" : ""}`).join("、")}</p>
        <p>工作区间：{formatDateTime(meeting.rangeStart)} 至 {formatDateTime(meeting.rangeEnd)}（北京时间）</p>
        <p className="text-sm text-muted-foreground">更新于 {formatDateTime(meeting.updatedAt)}</p>
      </section>
      <section className="min-w-0 rounded-xl border bg-card p-6" aria-labelledby="meeting-timeline-heading">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 id="meeting-timeline-heading" className="text-xl font-semibold">相关任务进度</h2>{actor.isActive && meeting.participants.some((person) => person.id === actor.personId) && <MeetingWorkSegmentReminder meetingId={id} />}</div>
      <MeetingTimeline source={{ kind: "SAVED", meetingId: id, rangeStart: meeting.rangeStart, rangeEnd: meeting.rangeEnd }} />
      </section>
      <section aria-labelledby="meeting-minutes-heading" className="min-w-0 rounded-lg border bg-card p-4">
        <h2 id="meeting-minutes-heading" className="mb-3 text-lg font-semibold">会议纪要</h2>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{meeting.minutes || "暂未填写会议纪要"}</p>
      </section>
    </main>
  </>;
}
