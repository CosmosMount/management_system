import { APP_NAME } from "@/lib/branding";
import type { PublicProgressLinkPreview } from "@/lib/project-management/queries/public-link-preview";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    };
    return entities[character];
  });
}

export function renderProgressLinkPreviewHtml({
  preview,
  detailUrl,
  returnPath,
  unavailable = false,
}: {
  preview: PublicProgressLinkPreview | null;
  detailUrl: string;
  returnPath: string;
  unavailable?: boolean;
}): string {
  const kindLabel = preview ? { projects: "项目", tasks: "任务", meetings: "会议" }[preview.kind] : "";
  const heading = preview?.name ?? (unavailable ? "暂时无法获取预览" : "项目、任务或会议不存在");
  const title = preview ? `${kindLabel}：${preview.name} | ${APP_NAME}` : `${heading} | ${APP_NAME}`;
  const description = preview
    ? `登录后查看${kindLabel}详情`
    : unavailable ? "请稍后重试。" : "链接无效或内容已删除。";
  const loginUrl = `/login?${new URLSearchParams({ callbackUrl: returnPath })}`;

  // Route Handler 一次返回完整 head，抓取器无需识别 UA 或执行 JavaScript。
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(APP_NAME)}">
<meta property="og:url" content="${escapeHtml(detailUrl)}">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f8fafc;color:#0f172a;font-family:system-ui,sans-serif}
main{width:100%;max-width:480px;min-width:0;padding:32px;border:1px solid #e2e8f0;border-radius:16px;background:#fff;box-shadow:0 8px 24px #0f172a08;overflow-wrap:anywhere}
.brand,p{color:#475569;font-size:14px;line-height:1.6}.brand{margin-top:0}h1{font-size:24px;line-height:1.4;margin:16px 0}
a{display:block;margin-top:24px;padding:12px 16px;border-radius:8px;background:#0f172a;color:#fff;text-align:center;text-decoration:none;font-size:16px}
a:hover{background:#334155}a:focus-visible{outline:3px solid #2563eb;outline-offset:4px}
@media(max-width:400px){body{padding:16px}main{padding:24px}}
</style>
</head>
<body><main aria-labelledby="preview-title">
<p class="brand">${escapeHtml(APP_NAME)}${preview ? ` · ${kindLabel}` : ""}</p>
<h1 id="preview-title">${escapeHtml(heading)}</h1>
<p>${escapeHtml(description)}</p>
${preview ? `<a id="preview-login" href="${escapeHtml(loginUrl)}">登录查看详情</a>
<script>
// 锚点不会随 HTTP 请求发送；只增强登录回跳，不影响无脚本预览。
function preservePreviewHash(){
  var link=document.getElementById("preview-login");
  var url=new URL(link.href);
  var target=url.searchParams.get("callbackUrl").split("#")[0];
  url.searchParams.set("callbackUrl",target+window.location.hash);
  link.href=url.pathname+url.search;
}
preservePreviewHash();
window.addEventListener("hashchange",preservePreviewHash);
</script>` : ""}
</main></body></html>`;
}
