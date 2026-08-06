import { NextResponse } from "next/server";
import { dispatchCanvasQueryRequest } from "@/lib/project-management/application/canvas-query-dispatcher";
import type { ProjectManagementActionResult } from "@/lib/project-management/application/action-result";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Authentication still runs before the strict dispatcher maps this to a
    // stable validation error; raw JSON parser details are never returned.
  }
  return noStoreJson(await dispatchCanvasQueryRequest(body));
}

function noStoreJson<T>(result: ProjectManagementActionResult<T>) {
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
