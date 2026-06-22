/** 解析订单中 JSON 存储的文件路径列表 */
export function parseFilePaths(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}

export function serializeFilePaths(paths: string[]): string {
  return JSON.stringify(paths);
}

/** 合并旧单字段 invoicePath 与 invoicePaths */
export function resolveInvoicePaths(
  invoicePaths: string,
  legacyInvoicePath: string | null | undefined,
): string[] {
  const paths = parseFilePaths(invoicePaths);
  if (paths.length > 0) return paths;
  if (legacyInvoicePath) return [legacyInvoicePath];
  return [];
}

export function fileNameFromPath(filePath: string): string {
  const parts = filePath.split("/");
  const name = parts[parts.length - 1] ?? filePath;
  return name.replace(/^(invoice|list|screenshot)-\d+/, (m) => m) || name;
}

export function displayFileName(filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath;
  const match = name.match(/^(invoice|list|screenshot)-(\d+)(.*)$/);
  if (match) {
    const label =
      match[1] === "invoice"
        ? "发票"
        : match[1] === "list"
          ? "清单"
          : "截图";
    return `${label}${match[3] || ""}`;
  }
  return name;
}

export type OrderAttachmentGroups = {
  invoices: string[];
  listDoc: string | null;
  screenshot: string | null;
};

export function groupOrderAttachments(order: {
  invoicePaths: string;
  invoicePath?: string | null;
  listDocPath: string | null;
  screenshotPath: string | null;
}): OrderAttachmentGroups {
  return {
    invoices: resolveInvoicePaths(order.invoicePaths, order.invoicePath),
    listDoc: order.listDocPath,
    screenshot: order.screenshotPath,
  };
}

export function hasReimbursementAttachments(groups: OrderAttachmentGroups): boolean {
  return (
    groups.invoices.length > 0 ||
    !!groups.listDoc ||
    !!groups.screenshot
  );
}
