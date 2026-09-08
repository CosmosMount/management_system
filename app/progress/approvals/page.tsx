import { ActionInbox } from "@/components/project-management/action-inbox";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { getActionInbox } from "@/lib/project-management/queries/action-inbox-queries";
import { getProgressActorOrRedirect } from "../_auth";

export default async function ProgressApprovalsPage() {
  const actor = await getProgressActorOrRedirect();
  const inbox = await getActionInbox({ actor, input: { limit: 50 } });
  return (
    <>
      <PageCommandBar
        title="待办与审批"
        description="先查看优先事项，再打开对应节点或审批详情处理。"
      />
      <section aria-label="待处理事项" className="mx-auto w-full min-w-0 max-w-[96rem] space-y-4 px-4 py-5 sm:px-6 lg:px-8">
        <details className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-ring">处理范围与顺序</summary>
          <p className="mt-2 text-muted-foreground">按全局优先级汇总当前节点、里程碑验收、计划修订、项目立项与任务结束审批。展开事项查看上下文，具体处理仍在对应节点或审批详情中完成。</p>
        </details>
        <ActionInbox initialPage={inbox} />
      </section>
    </>
  );
}
