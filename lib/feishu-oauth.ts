export function getFeishuRedirectUri(): string {
  const base = process.env.AUTH_URL ?? "http://localhost:3000";
  const normalized = base.replace(/\/$/, "");
  return `${normalized}/api/auth/callback/feishu`;
}
