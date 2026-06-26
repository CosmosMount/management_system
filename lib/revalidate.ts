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

export function revalidateProgress(projectId?: string, taskId?: string) {
  revalidatePath(routes.progress.root);
  revalidatePath(routes.progress.list);
  revalidatePath(routes.progress.dashboard);
  revalidatePath(routes.progress.archive);
  if (projectId) {
    revalidatePath(routes.progress.project(projectId));
  }
  if (taskId) {
    revalidatePath(routes.progress.task(taskId));
  }
}

export function revalidateAdmin() {
  revalidatePath(routes.admin.root);
  revalidatePath(routes.admin.system);
  revalidatePath(routes.admin.roles);
  revalidatePath(routes.admin.reminders);
  revalidatePath(routes.admin.projectTemplates);
  revalidatePath(routes.admin.acceptance);
}
