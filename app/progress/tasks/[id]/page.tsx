import { notFound } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/page-shell";
import { ProgressShell } from "@/components/project-management/progress-shell";
import { TaskWorkbench } from "@/components/project-management/task-workbench";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { getUnreadInAppNotificationCount } from "@/lib/project-management/queries/notification-queries";
import { listWorkSegments } from "@/lib/project-management/queries/resource-queries";
import { getTaskWorkspace } from "@/lib/project-management/queries/task-queries";
import { getProgressActorOrRedirect } from "../../_auth";

export default async function ProgressTaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const workspace = await getTaskWorkspace({ actor, taskId: id }).catch((error) => {
    const mapped = toProjectManagementServiceError(error);
    if (mapped.code === "NOT_FOUND") notFound();
    throw error;
  });
  const [segments, unreadCount] = await Promise.all([
    listWorkSegments({ actor, input: { taskId: id, limit: 50 } }),
    getUnreadInAppNotificationCount(actor),
  ]);

  return (
    <>
      <AppHeader />
      <PageShell>
        <ProgressShell
          title={workspace.task.title}
          subtitle="Task 工作台：查看元数据、当前计划、成员权限和关联人员投入。"
          unreadCount={unreadCount}
        >
          <TaskWorkbench workspace={workspace} segments={segments.items} />
        </ProgressShell>
      </PageShell>
    </>
  );
}
