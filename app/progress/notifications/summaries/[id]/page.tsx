import Link from "next/link";
import { notFound } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { buttonVariants } from "@/components/ui/button";
import { getAdminGlobalSummaryRun } from "@/lib/project-management/application/admin-global-summary-service";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { formatDateTime } from "@/lib/project-management/labels";
import { getProgressActorOrRedirect } from "../../../_auth";

export default async function AdminSummaryPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const run = await getAdminGlobalSummaryRun(actor, { id }).catch((error: unknown) => {
    if (["NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"].includes(toProjectManagementServiceError(error).code)) notFound();
    throw error;
  });
  return <>
    <PageCommandBar title="管理员全局进度总结" actions={<Link href="/progress/notifications?view=settings" className={buttonVariants({ variant: "outline" })}>返回总结设置</Link>} />
    <section className="mx-auto w-full min-w-0 max-w-[96rem] space-y-4 p-6">
      <p className="text-sm">生成时间：{formatDateTime(run.startedAt)}（上海时间） · {run.status === "SUCCEEDED" ? "生成成功" : "生成失败"}</p>
      {run.errorMessage && <p role="alert">{run.errorMessage}</p>}
      <pre aria-label="完整总结内容" className="whitespace-pre-wrap rounded-lg border bg-card p-4 text-sm [overflow-wrap:anywhere]">{run.markdown || "无总结内容。"}</pre>
    </section>
  </>;
}
