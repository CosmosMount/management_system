import { auth } from "@/lib/auth";
import {
  getLiveVersion,
  type LiveVersionScope,
} from "@/lib/live-version";
import { isSuperAdmin } from "@/lib/permissions";

export async function getCurrentUserLiveVersion(
  scope: LiveVersionScope,
  resourceId?: string,
  options?: { mine?: boolean },
): Promise<string | undefined> {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  if (!userOpenId) {
    return undefined;
  }

  return getLiveVersion({
    scope,
    resourceId,
    userOpenId,
    isSuperAdmin: await isSuperAdmin(userOpenId),
    mine: options?.mine ?? false,
  });
}
