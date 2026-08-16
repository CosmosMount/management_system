"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireGlobalSuperAdministrator } from "@/lib/account-authorization";
import {
  getGlobalTimeMarkerCollection,
  saveGlobalTimeMarkerCollection,
} from "@/lib/project-management/global-time-markers";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import { routes } from "@/lib/routes";

export async function listAdminGlobalTimeMarkers() {
  await requireGlobalSuperAdministrator();
  return getGlobalTimeMarkerCollection();
}

export async function saveAdminGlobalTimeMarkers(input: unknown) {
  const { context } = await requireGlobalSuperAdministrator();
  try {
    const result = await saveGlobalTimeMarkerCollection(context.accountId, input);
    revalidatePath(routes.admin.root);
    revalidatePath(routes.admin.timeMarkers);
    revalidatePath(routes.progress.root);
    revalidatePath(routes.progress.resources);
    revalidatePath(routes.progress.projects);
    revalidatePath(routes.progress.tasks);
    return result;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(error.issues[0]?.message ?? "关键时间点数据不正确");
    }
    const mapped = toProjectManagementServiceError(error);
    throw new Error(mapped.message);
  }
}
