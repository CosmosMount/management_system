import { ActionInbox } from "@/components/project-management/action-inbox";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { getActionInbox } from "@/lib/project-management/queries/action-inbox-queries";
import { getProgressActorOrRedirect } from "../_auth";

export default async function ProgressApprovalsPage() {
  const actor = await getProgressActorOrRedirect();
  const inbox = await getActionInbox({ actor, limit: 200 });
  return (
    <>
      <PageCommandBar
        title="待办与审批"
        description="按严重度和逾期时间汇总投入确认、里程碑验收、计划修订审核、任务结束申请与关联复核。"
      />
      <div className="mx-auto w-full min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
        <ActionInbox items={inbox.items} />
      </div>
    </>
  );
}
