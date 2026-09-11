import { NextRequest, NextResponse } from "next/server";
import { appOriginFromHostHeaders } from "@/lib/app-origin";
import { FRONTEND_VERSION } from "@/lib/frontend-version";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ version: FRONTEND_VERSION }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

export async function POST(request: NextRequest) {
  const origin = appOriginFromHostHeaders(request.headers);
  if (!origin || request.headers.get("origin") !== origin || request.headers.get("x-frontend-version-refresh") !== "1") {
    return NextResponse.json({ error: "请从当前站点刷新页面" }, { status: 403, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
  return NextResponse.json({ version: FRONTEND_VERSION }, {
    headers: { "Cache-Control": "no-store, max-age=0", "Clear-Site-Data": '"cache"' },
  });
}
