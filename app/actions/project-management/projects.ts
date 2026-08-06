"use server";

import { runProjectManagementAction, type ProjectManagementActionResult } from "@/lib/project-management/application/action-result";
import {
  completeProject as completeProjectService,
  createProject as createProjectService,
  deleteProject as deleteProjectService,
  resubmitProject as resubmitProjectService,
  reviewProjectEstablishment as reviewProjectEstablishmentService,
  updateProject as updateProjectService,
  updateTaskProject as updateTaskProjectService,
} from "@/lib/project-management/application/project-service";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { revalidateProjectManagement } from "@/lib/revalidate";
import { saveProjectAvatarDraft } from "@/lib/file-upload";
import { resolveActiveProjectOptions as resolveActiveProjectOptionsQuery, searchActiveProjectOptions as searchActiveProjectOptionsQuery, type ProjectOption, type ProjectOptionPage } from "@/lib/project-management/queries/project-queries";

export async function createProject(input: unknown) { return runProjectAction("pm.project.establishment.submit", "createProject", input, createProjectService); }
export async function resubmitProject(input: unknown) { return runProjectAction("pm.project.establishment.resubmit", "resubmitProject", input, resubmitProjectService); }
export async function reviewProjectEstablishment(input: unknown) { return runProjectAction("pm.project.establishment.review", "reviewProjectEstablishment", input, reviewProjectEstablishmentService); }
export async function updateProject(input: unknown) { return runProjectAction("pm.project.metadata.update", "updateProject", input, updateProjectService); }
export async function completeProject(input: unknown) { return runProjectAction("pm.project.complete", "completeProject", input, completeProjectService); }
export async function deleteProject(input: unknown) { return runProjectAction("pm.project.delete", "deleteProject", input, deleteProjectService); }
export async function updateTaskProject(input: unknown) { return runProjectAction("pm.task.project.update", "updateTaskProject", input, updateTaskProjectService); }
export async function searchActiveProjectOptions(input: unknown): Promise<ProjectManagementActionResult<ProjectOptionPage>> { return runProjectQueryAction("pm.project.options.search", "searchActiveProjectOptions", input, searchActiveProjectOptionsQuery); }
export async function resolveActiveProjectOptions(input: unknown): Promise<ProjectManagementActionResult<ProjectOption[]>> { return runProjectQueryAction("pm.project.options.resolve", "resolveActiveProjectOptions", input, resolveActiveProjectOptionsQuery); }

export async function uploadProjectAvatar(formData: FormData): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  try {
    const actor = await getCurrentProjectManagementActor();
    const file = formData.get("avatar");
    if (!(file instanceof File) || file.size === 0) return { ok: false, message: "请选择头像文件" };
    const path = await saveProjectAvatarDraft(actor.openId, file);
    return { ok: true, path };
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("Project 头像")
      ? error.message
      : "头像上传失败，请稍后重试";
    return { ok: false, message };
  }
}

async function runProjectAction<T>(event: string, action: string, input: unknown, service: (actor: Awaited<ReturnType<typeof getCurrentProjectManagementActor>>, input: unknown) => Promise<T>): Promise<ProjectManagementActionResult<T>> {
  return runProjectManagementAction({
    event,
    action,
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      const result = await service(actor, input);
      revalidateProjectManagement();
      return result;
    },
  });
}

async function runProjectQueryAction<T>(event: string, action: string, input: unknown, query: (input: unknown) => Promise<T>): Promise<ProjectManagementActionResult<T>> {
  return runProjectManagementAction({
    event,
    action,
    callback: async (log) => {
      const actor = await getCurrentProjectManagementActor();
      log.setActorAccountId(actor.accountId);
      return query(input);
    },
  });
}
