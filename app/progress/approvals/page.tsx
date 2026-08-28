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
        description="按全局优先级汇总投入确认、当前节点、里程碑验收、计划修订、项目立项与任务结束审批。"
      />
      <div className="mx-auto w-full min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
        <ActionInbox initialPage={inbox} />
      </div>
    </>
  );
}
