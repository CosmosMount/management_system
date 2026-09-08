import { notFound, redirect } from "next/navigation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { ProjectFormClient } from "@/components/project-management/project-form-client";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { getProjectDetail } from "@/lib/project-management/queries/project-queries";
import { routes } from "@/lib/routes";
import { isSystemAdministrator } from "@/lib/project-management/authorization";
import { getProgressActorOrRedirect } from "../../../_auth";

export default async function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await getProgressActorOrRedirect();
  const { id } = await params;
  const project = await getProjectDetail({ actor, projectId: id }).catch((error) => { if (toProjectManagementServiceError(error).code === "NOT_FOUND") notFound(); throw error; });
  if (!project.permissions.canEdit && !project.permissions.canResubmit) notFound();
  if (project.status !== "DRAFT" && project.status !== "ACTIVE") redirect(routes.progress.projectDetail(id));
  const latestRequest = project.requests[0];
  const requestedTasks = latestRequest?.tasks ?? [];
  const protectedOwnerId = !isSystemAdministrator(actor) && project.members.some((member) => member.personId === actor.personId && member.role === "OWNER") ? actor.personId : undefined;
  return <><PageCommandBar title={project.status === "DRAFT" ? "修改并重新提交" : "编辑项目"} description={project.status === "DRAFT" ? "保留同一项目和历史轮次，修改后重新进入审批。" : "修改项目基本信息与成员。"} /><ProjectFormClient mode={project.status === "DRAFT" ? "draft" : "active"} protectedOwnerId={protectedOwnerId} project={{ id: project.id, name: project.name, description: project.description, avatarPath: project.avatarPath, lockVersion: project.lockVersion, members: project.members.map(({ personId, role }) => ({ personId, role })), memberOptions: project.members.map((member) => ({ id: member.personId, displayName: member.displayName, avatar: member.avatar, status: member.status, accountBinding: "BOUND" as const })), requestedTaskIds: requestedTasks.map((task) => task.id) }} /></>;
}
