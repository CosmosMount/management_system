import { middlewareAuth } from "@/lib/auth-edge";
import {
  appOriginFromHostHeaders,
  buildAppUrl,
  isAllowedAppOrigin,
} from "@/lib/app-origin";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";

const authMiddleware = middlewareAuth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth;
  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/uploads") ||
    pathname === "/favicon.ico";

  if (isPublic) {
    if (isLoggedIn && pathname === "/login") {
      return NextResponse.redirect(new URL("/", req.nextUrl));
    }
    return NextResponse.next();
  }

  if (!isLoggedIn) {
    const loginUrl = new URL("/login", req.nextUrl);
    const returnPath = `${req.nextUrl.pathname}${req.nextUrl.search}`;
    loginUrl.searchParams.set("callbackUrl", returnPath);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export default function middleware(req: NextRequest, event: NextFetchEvent) {
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
