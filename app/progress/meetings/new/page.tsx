import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { MeetingForm } from "@/components/project-management/meetings/meeting-form";
import { getMeetingTemplate } from "@/lib/project-management/meetings/template-service";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { canManageMeetings } from "@/lib/project-management/meetings/permissions";
import { getProgressActorOrRedirect } from "../../_auth";

export default async function NewMeetingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await getProgressActorOrRedirect();
  const { templateId } = await searchParams;
  const result = templateId !== undefined && canManageMeetings(actor)
    ? await getMeetingTemplate(actor, { templateId }).then((selection) => ({ selection, error: "" }))
      .catch((error: unknown) => ({ selection: undefined, error: `模板未填充：${toProjectManagementServiceError(error).message}。请重新选择模板，或直接填写创建会议。` }))
    : { selection: undefined, error: "" };
  return <><PageCommandBar title="创建会议" /><main className="mx-auto min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
    {canManageMeetings(actor) ? <MeetingForm initialTemplate={result.selection} templateError={result.error} /> : <p role="alert">只有全局超级管理员可以创建或修改会议。</p>}
  </main></>;
}
