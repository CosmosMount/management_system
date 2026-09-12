import { notFound } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { MeetingForm } from "@/components/project-management/meetings/meeting-form";
import { getMeeting } from "@/lib/project-management/meetings/service";
import { canManageMeetings } from "@/lib/project-management/meetings/permissions";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { idSchema } from "@/lib/project-management/validations/lifecycle";
import { getProgressActorOrRedirect } from "../../../_auth";

export default async function EditMeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getProgressActorOrRedirect();
  if (!canManageMeetings(actor)) return <p role="alert" className="p-6">只有全局超级管理员可以创建或修改会议。</p>;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();
  const meeting = await getMeeting({ meetingId: id }).catch((error: unknown) => {
    if (toProjectManagementServiceError(error).code === "NOT_FOUND") notFound();
    throw error;
  });
  return <><PageCommandBar title="编辑会议" /><main className="mx-auto min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8"><MeetingForm key={meeting.version} meeting={meeting} /></main></>;
}
