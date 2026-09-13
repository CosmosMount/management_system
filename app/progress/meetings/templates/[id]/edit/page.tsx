import Link from "next/link";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { MeetingTemplateForm } from "@/components/project-management/meetings/meeting-template-form";
import { getMeetingTemplate } from "@/lib/project-management/meetings/template-service";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { routes } from "@/lib/routes";
import { getProgressActorOrRedirect } from "../../../../_auth";

export default async function EditMeetingTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const result = await getMeetingTemplate(actor, { templateId: id })
    .then((selection) => ({ selection, error: "" }))
    .catch((error: unknown) => ({ selection: null, error: toProjectManagementServiceError(error).message }));
  return <><PageCommandBar title="编辑会议模板" /><main className="mx-auto min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
    {result.selection ? <MeetingTemplateForm selection={result.selection} /> : <p role="alert">{result.error} <Link className="underline" href={routes.progress.meetings}>返回会议列表</Link></p>}
  </main></>;
}
