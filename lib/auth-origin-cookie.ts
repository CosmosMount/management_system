import { parseAppUrl } from "@/lib/app-origin";

export const AUTH_ORIGIN_COOKIE = "pnx-auth-origin";

export function parseAuthOriginCookie(value?: string | null): URL | null {
  return parseAppUrl(value);
}

export function authOriginCookieOptions(origin: URL) {
  return {
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/",
    sameSite: "lax" as const,
    secure: origin.protocol === "https:",
  };
}
