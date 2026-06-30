import { headers } from "next/headers";
import {
  appOriginFromHeaders,
  defaultAppOrigin,
  resolveAppOrigin,
  type NotificationContext,
} from "@/lib/app-origin";

export async function getRequestAppOrigin(): Promise<string> {
  const requestHeaders = await headers();
  const origin = appOriginFromHeaders(requestHeaders);

  return origin ? resolveAppOrigin(origin) : defaultAppOrigin();
}

export async function getNotificationContext(): Promise<NotificationContext> {
  return { appOrigin: await getRequestAppOrigin() };
}

/** 无 HTTP 请求上下文时（长连接、定时任务）使用环境变量中的正式站点地址 */
export function getDefaultNotificationContext(): NotificationContext {
  return { appOrigin: defaultAppOrigin() };
}
