import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { MeetingTemplateForm } from "@/components/project-management/meetings/meeting-template-form";
import { canManageMeetings } from "@/lib/project-management/meetings/permissions";
import { getProgressActorOrRedirect } from "../../../_auth";

export default async function NewMeetingTemplatePage() {
  const actor = await getProgressActorOrRedirect();
  return <><PageCommandBar title="创建会议模板" /><main className="mx-auto min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
    {canManageMeetings(actor) ? <MeetingTemplateForm /> : <p role="alert">只有全局超级管理员可以查看、使用或管理会议模板。</p>}
  </main></>;
}
