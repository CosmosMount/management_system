import { serveUploadFile } from "@/lib/serve-upload";
import { logger } from "@/lib/logger";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

export async function GET(request: Request, context: RouteContext) {
  let pathSegmentCount = 0;
  try {
    const { path: segments } = await context.params;
    pathSegmentCount = segments.length;
    const download = new URL(request.url).searchParams.get("download") === "1";
    return await serveUploadFile(segments, { download });
  } catch (err) {
    logger.error("uploads.serve.failed", {
      module: "uploads",
      action: "serveUploadFile",
      pathSegmentCount,
      error: err,
    });
    const message =
      process.env.NODE_ENV === "development" && err instanceof Error
        ? err.message
        : "Upload serving failed";
    return new Response(message, { status: 500 });
  }
}
