import { middlewareAuth } from "@/lib/auth-edge";
import {
  appOriginFromHostHeaders,
  buildAppUrl,
  isAllowedAppOrigin,
} from "@/lib/app-origin";
import { isControlledPlaywrightServer } from "@/lib/playwright-fixture-guard";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";

const authMiddleware = middlewareAuth(async (req) => {
  const { pathname } = req.nextUrl;
  const isPlaywrightSyncFixture =
    pathname === "/feishu-sync-action-fixtures" &&
    isControlledPlaywrightServer();
  const isLoggedIn = !!req.auth;
  const isPublic =
    pathname === "/login" ||
    pathname === "/api/frontend-version" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    isPlaywrightSyncFixture;

  if (isPublic) {
    if (isLoggedIn && pathname === "/login") {
      return NextResponse.redirect(new URL("/", req.nextUrl));
    }
    return NextResponse.next();
  }

  if (!isLoggedIn) {
    const detail = /^\/progress\/(projects|tasks|meetings)\/([^/]+)$/.exec(pathname);
    const isDocumentRead =
      (req.method === "GET" || req.method === "HEAD") &&
      !req.headers.has("rsc") &&
      !req.headers.has("next-router-prefetch") &&
      !req.headers.has("next-action") &&
      !req.headers.get("purpose")?.includes("prefetch") &&
      !req.headers.get("sec-purpose")?.includes("prefetch");
    if (detail && !["new", "templates"].includes(detail[2]) && isDocumentRead) {
      // 由 next.config.ts 的相对路径重写处理，避免 Auth.js 域名或 localhost 归一化引入外部转发。
      const headers = new Headers(req.headers);
      headers.set("x-pnx-progress-preview", "1");
      return NextResponse.next({ request: { headers } });
    }

    if (pathname === "/api/live-version") {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }

    if (pathname.startsWith("/api/project-management/")) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "UNAUTHENTICATED", message: "请先登录" },
        },
        {
          status: 401,
          headers: { "Cache-Control": "no-store, max-age=0" },
        },
      );
    }

    const loginUrl = new URL("/login", req.nextUrl);
    const returnPath = `${req.nextUrl.pathname}${req.nextUrl.search}`;
    loginUrl.searchParams.set("callbackUrl", returnPath);
    return NextResponse.redirect(loginUrl);
  }

  // 已登录请求不可通过伪造标记切换到公开预览，包括带此标记的 Server Action。
  if (req.headers.has("x-pnx-progress-preview")) {
    const headers = new Headers(req.headers);
    headers.delete("x-pnx-progress-preview");
    return NextResponse.next({ request: { headers } });
  }
  return NextResponse.next();
});

export default function proxy(req: NextRequest, event: NextFetchEvent) {
  const origin = appOriginFromHostHeaders(req.headers);

  if (!origin || !isAllowedAppOrigin(origin)) {
    const returnPath = `${req.nextUrl.pathname}${req.nextUrl.search}`;
    return NextResponse.redirect(buildAppUrl(returnPath));
  }

  return authMiddleware(
    req,
    event as unknown as Parameters<typeof authMiddleware>[1],
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
