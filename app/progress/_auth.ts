import { redirect } from "next/navigation";
import {
  getCurrentProjectManagementActor,
  type ProjectManagementActor,
} from "@/lib/project-management/identity";

export async function getProgressActorOrRedirect(): Promise<ProjectManagementActor> {
  const actor = await getCurrentProjectManagementActor().catch((error) => {
    if (
      error instanceof Error &&
      (error.message === "请重新登录" || error.message.includes("登录"))
    ) {
      redirect("/login");
    }
    throw error;
  });
  return actor;
}
