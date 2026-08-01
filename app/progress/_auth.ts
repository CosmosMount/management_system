import { cache } from "react";
import { redirect } from "next/navigation";
import {
  getCurrentProjectManagementActor,
  ProjectManagementIdentityError,
  type ProjectManagementActor,
} from "@/lib/project-management/identity";
import { getUnreadInAppNotificationCount } from "@/lib/project-management/queries/notification-queries";

async function loadProgressActorOrRedirect(): Promise<ProjectManagementActor> {
  const actor = await getCurrentProjectManagementActor().catch((error) => {
    if (
      error instanceof ProjectManagementIdentityError &&
      error.code === "ACCOUNT_DISABLED"
    ) {
      redirect("/project-access-disabled");
    }
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

/** Layout 与 page 在同一 RSC 请求中共享身份解析，避免重复读取身份与角色。 */
export const getProgressActorOrRedirect = cache(loadProgressActorOrRedirect);

/** 未读数由模块 Shell 统一读取；通知页复用同一请求内结果。 */
export const getProgressUnreadNotificationCount = cache(async () => {
  const actor = await getProgressActorOrRedirect();
  return getUnreadInAppNotificationCount(actor);
});
