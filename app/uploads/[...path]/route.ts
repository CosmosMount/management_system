import { serveUploadFile } from "@/lib/serve-upload";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { path: segments } = await context.params;
  const download = new URL(request.url).searchParams.get("download") === "1";
  return serveUploadFile(segments, { download });
}
