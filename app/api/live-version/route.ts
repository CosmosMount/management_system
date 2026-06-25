import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getLiveVersion,
  isLiveVersionScope,
} from "@/lib/live-version";
import { isSuperAdmin } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await auth();
  const userOpenId = session?.user?.openId;
  if (!userOpenId) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const scope = request.nextUrl.searchParams.get("scope") ?? "";
  if (!isLiveVersionScope(scope)) {
    return NextResponse.json({ error: "scope 无效" }, { status: 400 });
  }

  const resourceId = request.nextUrl.searchParams.get("resourceId") ?? undefined;
  const mine = request.nextUrl.searchParams.get("mine") === "1";
  const version = await getLiveVersion({
    scope,
    resourceId,
    userOpenId,
    isSuperAdmin: await isSuperAdmin(userOpenId),
    mine,
  });

  return NextResponse.json(
    { version },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
