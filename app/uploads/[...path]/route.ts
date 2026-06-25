import { serveUploadFile } from "@/lib/serve-upload";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const { path: segments } = await context.params;
    const download = new URL(request.url).searchParams.get("download") === "1";
    return await serveUploadFile(segments, { download });
  } catch (err) {
    console.error("[uploads] serve failed:", err);
    const message =
      process.env.NODE_ENV === "development" && err instanceof Error
        ? err.message
        : "Upload serving failed";
    return new Response(message, { status: 500 });
  }
}
