import { notFound } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { TaskWorkbench } from "@/components/project-management/task-workbench";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
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
  const segments = await listWorkSegments({
    actor,
    input: { taskId: id, limit: 50 },
  });

  return (
    <>
      <PageCommandBar
        title={workspace.task.title}
        description="Task 工作台：查看元数据、当前计划、成员权限和关联人员投入。"
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <TaskWorkbench workspace={workspace} segments={segments.items} />
      </div>
    </>
  );
}
