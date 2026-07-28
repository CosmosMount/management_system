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

export function revalidateProjectManagement(taskId?: string) {
  revalidatePath(routes.progress.root);
  revalidatePath("/progress/tasks");
  revalidatePath("/progress/approvals");
  revalidatePath("/progress/notifications");
  if (taskId) {
    revalidatePath(`/progress/tasks/${taskId}`);
  }
}
