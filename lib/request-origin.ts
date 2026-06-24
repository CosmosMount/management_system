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
