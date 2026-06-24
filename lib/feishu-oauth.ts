import { buildAppUrl } from "@/lib/app-origin";

export function getFeishuRedirectUri(): string {
  return buildAppUrl("/api/auth/callback/feishu");
}
