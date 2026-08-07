import { revalidatePath } from "next/cache";
import { routes } from "@/lib/routes";

export function revalidateProcurement(orderId?: string) {
  revalidatePath("/");
  revalidatePath(routes.procurement.root);
  revalidatePath(routes.procurement.list);
  revalidatePath(routes.procurement.dashboard);
  if (orderId) {
    revalidatePath(routes.procurement.detail(orderId));
    revalidatePath(routes.procurement.edit(orderId));
  }
}

export function revalidateAdmin() {
  revalidatePath(routes.admin.root);
  revalidatePath(routes.admin.system);
  revalidatePath(routes.admin.roles);
}

export function revalidateProjectManagement(taskId?: string, projectId?: string) {
  revalidatePath(routes.progress.root);
  revalidatePath(routes.progress.tasks);
  revalidatePath(routes.progress.projects);
  revalidatePath("/progress/approvals");
  revalidatePath(routes.progress.resources);
  revalidatePath(routes.progress.notifications);
  revalidatePath(routes.progress.approvals);
  revalidatePath(routes.progress.tags);
  if (taskId) {
    revalidatePath(`/progress/tasks/${taskId}`);
  }
  if (projectId) {
    revalidatePath(`/progress/projects/${projectId}`);
  }
}
