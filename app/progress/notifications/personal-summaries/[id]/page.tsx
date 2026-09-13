import { notFound } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { getPersonalSummary } from "@/lib/project-management/application/personal-summary-service";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { formatDateTime } from "@/lib/project-management/labels";
import { getProgressActorOrRedirect } from "../../../_auth";

export default async function PersonalSummaryPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const summary = await getPersonalSummary(actor, { id }).catch((error: unknown) => {
    if (["NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"].includes(toProjectManagementServiceError(error).code)) notFound();
    throw error;
  });
  return <>
    <PageCommandBar title="个人进度总结" />
    <section className="mx-auto w-full min-w-0 max-w-[96rem] space-y-4 p-6">
      <p className="text-sm">生成时间：{formatDateTime(summary.run.startedAt)}（上海时间）</p>
      <pre aria-label="完整个人总结内容" className="whitespace-pre-wrap rounded-lg border bg-card p-4 text-sm [overflow-wrap:anywhere]">{summary.markdown}</pre>
    </section>
  </>;
}
