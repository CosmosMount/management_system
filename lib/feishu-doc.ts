import { getFeishuTenantAccessToken } from "@/lib/feishu-auth";

const FEISHU_API = "https://open.feishu.cn/open-apis";

export type ParsedFeishuDoc = {
  fileToken: string;
  fileType: string;
};

type FeishuResponse<T> = {
  code: number;
  msg?: string;
  data?: T;
};

type ViewRecordItem = {
  viewer_id?: string;
  last_view_time?: string;
};

/**
 * 从飞书文档 URL 解析 file_token 与 file_type。
 * 支持 docx/doc/sheets/bitable/wiki 等常见链接。
 */
export function parseFeishuDocUrl(url: string): ParsedFeishuDoc | null {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname;
    if (!host.includes("feishu.cn") && !host.includes("larksuite.com")) {
      return null;
    }

    const pathname = parsed.pathname;

    const patterns: { regex: RegExp; type: string }[] = [
      { regex: /\/docx\/([a-zA-Z0-9]+)/, type: "docx" },
      { regex: /\/docs\/([a-zA-Z0-9]+)/, type: "doc" },
      { regex: /\/sheets\/([a-zA-Z0-9]+)/, type: "sheet" },
      { regex: /\/base\/([a-zA-Z0-9]+)/, type: "bitable" },
      { regex: /\/wiki\/([a-zA-Z0-9]+)/, type: "wiki" },
      { regex: /\/file\/([a-zA-Z0-9]+)/, type: "file" },
    ];

    for (const { regex, type } of patterns) {
      const match = pathname.match(regex);
      if (match?.[1]) {
        return { fileToken: match[1], fileType: type };
      }
    }

    const tokenParam = parsed.searchParams.get("token");
    if (tokenParam) {
      return { fileToken: tokenParam, fileType: "docx" };
    }

    return null;
  } catch {
    return null;
  }
}

async function feishuGet<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const token = await getFeishuTenantAccessToken();
  const url = new URL(`${FEISHU_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const body = (await res.json()) as FeishuResponse<T>;
  if (body.code !== 0) {
    throw new Error(body.msg ?? `飞书 API 失败: ${path}`);
  }
  if (!body.data) {
    throw new Error(`飞书 API 无数据: ${path}`);
  }
  return body.data;
}

async function listAllViewRecords(
  fileToken: string,
  fileType: string,
): Promise<ViewRecordItem[]> {
  const items: ViewRecordItem[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = {
      file_type: fileType,
      page_size: "50",
    };
    if (pageToken) params.page_token = pageToken;

    const data = await feishuGet<{
      items?: ViewRecordItem[];
      has_more?: boolean;
      page_token?: string;
    }>(`/drive/v1/files/${fileToken}/view_records`, params);

    if (data.items) items.push(...data.items);
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);

  return items;
}

/**
 * 校验指定用户是否已阅读文档（last_view_time 在 submittedAfter 之后）。
 */
export async function hasUserViewedDoc(
  fileToken: string,
  fileType: string,
  viewerOpenId: string,
  submittedAfter?: Date,
): Promise<boolean> {
  const records = await listAllViewRecords(fileToken, fileType);
  const record = records.find((r) => r.viewer_id === viewerOpenId);
  if (!record?.last_view_time) return false;

  if (!submittedAfter) return true;

  const viewTime = Number(record.last_view_time) * 1000;
  return viewTime >= submittedAfter.getTime() - 60_000;
}

/** 从 URL 校验审批人是否已阅读 */
export async function verifyApproverReadDoc(
  feishuDocUrl: string,
  approverOpenId: string,
  submittedAfter?: Date,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = parseFeishuDocUrl(feishuDocUrl);
  if (!parsed) {
    return { ok: false, error: "无法解析飞书文档链接，请检查 URL 格式" };
  }

  try {
    const viewed = await hasUserViewedDoc(
      parsed.fileToken,
      parsed.fileType,
      approverOpenId,
      submittedAfter,
    );
    if (!viewed) {
      return {
        ok: false,
        error: "请先在飞书客户端打开该文档，等待数分钟后刷新阅读状态再审批",
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "查询文档访问记录失败，请确认应用已添加文档权限",
    };
  }
}
