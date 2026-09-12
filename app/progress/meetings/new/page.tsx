import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { MeetingForm } from "@/components/project-management/meetings/meeting-form";
import { canManageMeetings } from "@/lib/project-management/meetings/permissions";
import { getProgressActorOrRedirect } from "../../_auth";

export default async function NewMeetingPage() {
  const actor = await getProgressActorOrRedirect();
  return <><PageCommandBar title="创建会议" /><main className="mx-auto min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
    {canManageMeetings(actor) ? <MeetingForm /> : <p role="alert">只有全局超级管理员可以创建或修改会议。</p>}
  </main></>;
}
