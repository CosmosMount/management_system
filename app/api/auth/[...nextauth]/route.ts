import { handlers } from "@/lib/auth";
import {
  AUTH_ORIGIN_COOKIE,
  parseAuthOriginCookie,
} from "@/lib/auth-origin-cookie";
import { isAllowedAppOrigin } from "@/lib/app-origin";
import { NextRequest } from "next/server";

function withStoredOrigin(request: NextRequest): NextRequest {
  const rawCookie = request.cookies.get(AUTH_ORIGIN_COOKIE)?.value;
  const origin = parseAuthOriginCookie(rawCookie);

  if (!origin || !isAllowedAppOrigin(origin.origin)) return request;

  const headers = new Headers(request.headers);
  headers.set("host", origin.host);
  headers.set("x-forwarded-host", origin.host);
  headers.set("x-forwarded-proto", origin.protocol.replace(":", ""));

  const url = new URL(request.url);
  url.protocol = origin.protocol;
  url.host = origin.host;

  return new NextRequest(url, {
    body: request.body,
    duplex: request.body ? "half" : undefined,
    headers,
    method: request.method,
  });
}

export function GET(request: NextRequest) {
  return handlers.GET(withStoredOrigin(request));
}

export function POST(request: NextRequest) {
  return handlers.POST(withStoredOrigin(request));
}
