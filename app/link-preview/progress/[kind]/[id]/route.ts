import { NextRequest, NextResponse } from "next/server";
import { appOriginFromHostHeaders, buildAppUrl } from "@/lib/app-origin";
import { logger } from "@/lib/logger";
import { renderProgressLinkPreviewHtml } from "@/lib/project-management/link-preview-html";
import { getPublicProgressLinkPreview } from "@/lib/project-management/queries/public-link-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ kind: string; id: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { kind, id } = await params;
  const returnPath = `/progress/${encodeURIComponent(kind)}/${encodeURIComponent(id)}${request.nextUrl.search}`;
  const detailUrl = buildAppUrl(returnPath, appOriginFromHostHeaders(request.headers));
  // Next.js 在代理前隐藏 Flight 请求头、重写后恢复；此处必须在查询名称前再次检查。
  if (request.headers.has("rsc") || request.headers.has("next-router-prefetch")) {
    const loginUrl = new URL("/login", detailUrl);
    const callbackUrl = new URL(detailUrl);
    if (callbackUrl.searchParams.has("_rsc")) callbackUrl.searchParams.delete("_rsc");
    loginUrl.searchParams.set("callbackUrl", `${callbackUrl.pathname}${callbackUrl.search}`);
    return NextResponse.redirect(loginUrl, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  }
  let preview = null;
  let unavailable = false;
  try {
    preview = await getPublicProgressLinkPreview(kind, id);
  } catch (error) {
    unavailable = true;
    logger.error("progress.link_preview.failed", { error });
  }
  return new Response(
    request.method === "HEAD" ? null : renderProgressLinkPreviewHtml({ preview, detailUrl, returnPath, unavailable }),
    {
      status: unavailable ? 503 : preview ? 200 : 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store, max-age=0",
        "Vary": "Cookie",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export const HEAD = GET;
