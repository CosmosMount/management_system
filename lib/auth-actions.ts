import { Auth, raw, skipCSRFCheck } from "@auth/core";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { authConfig } from "@/lib/auth.config";
import {
  AUTH_ORIGIN_COOKIE,
  authOriginCookieOptions,
} from "@/lib/auth-origin-cookie";
import { getRequestAppOrigin } from "@/lib/request-origin";

export async function signInFeishu(redirectTo: string): Promise<never> {
  const origin = await getRequestAppOrigin();
  const originUrl = new URL(origin);
  const requestHeaders = new Headers(await headers());

  requestHeaders.set("Content-Type", "application/x-www-form-urlencoded");
  requestHeaders.set("host", originUrl.host);
  requestHeaders.set("x-forwarded-host", originUrl.host);
  requestHeaders.set("x-forwarded-proto", originUrl.protocol.replace(":", ""));

  const req = new Request(`${origin}/api/auth/signin/feishu`, {
    method: "POST",
    headers: requestHeaders,
    body: new URLSearchParams({ callbackUrl: redirectTo }),
  });
  const res = await Auth(req, {
    ...authConfig,
    basePath: "/api/auth",
    raw,
    secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
    skipCSRFCheck,
  });
  const cookieJar = await cookies();

  cookieJar.set(
    AUTH_ORIGIN_COOKIE,
    origin,
    authOriginCookieOptions(originUrl),
  );

  for (const cookie of res?.cookies ?? []) {
    cookieJar.set(cookie.name, cookie.value, cookie.options);
  }

  const redirectUrl =
    res instanceof Response ? res.headers.get("Location") : res.redirect;
  redirect(redirectUrl ?? `${origin}/api/auth/signin/feishu`);
}
