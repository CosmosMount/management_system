import { cache } from "react";
import { redirect } from "next/navigation";
import {
  getCurrentProjectManagementActor,
  type ProjectManagementActor,
} from "@/lib/project-management/identity";

async function loadMaterialActorOrRedirect(
  callbackUrl = "/materials",
): Promise<ProjectManagementActor> {
  const actor = await getCurrentProjectManagementActor().catch((error) => {
    if (error instanceof Error && error.message.includes("登录")) {
      const search = new URLSearchParams({ callbackUrl });
      redirect(`/login?${search.toString()}`);
    }
    throw error;
  });
  return actor;
}

export const getMaterialActorOrRedirect = cache(loadMaterialActorOrRedirect);
