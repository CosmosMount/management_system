import { getFeishuTenantAccessToken } from "@/lib/feishu-auth";

const FEISHU_API = "https://open.feishu.cn/open-apis";

type FeishuResponse<T> = {
  code: number;
  msg?: string;
  data?: T;
};

type DepartmentItem = {
  open_department_id?: string;
  department_id?: string;
};

type UserItem = {
  open_id?: string;
  union_id?: string;
  name?: string;
  status?: {
    is_resigned?: boolean;
  };
  avatar?: {
    avatar_72?: string;
    avatar_origin?: string;
  };
};

export type FeishuContactUser = {
  openId: string;
  unionId: string | null;
  name: string;
  avatar: string | null;
  isActive: boolean;
};

export class FeishuContactRequestError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`飞书通讯录 API 请求失败 (${path}): ${detail}`, { cause });
    this.name = "FeishuContactRequestError";
  }
}

async function feishuGet<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  try {
    const token = await getFeishuTenantAccessToken();
    const url = new URL(`${FEISHU_API}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });

    const body = (await res.json()) as FeishuResponse<T>;
    if (!res.ok || body.code !== 0 || !body.data) {
      throw new Error(
        `HTTP ${res.status}, code ${body.code}: ${body.msg ?? "响应缺少 data"}`,
      );
    }
    return body.data;
  } catch (error) {
    if (error instanceof FeishuContactRequestError) throw error;
    throw new FeishuContactRequestError(path, error);
  }
}

async function paginate<T>(
  fetchPage: (pageToken: string) => Promise<{
    items: T[];
    has_more: boolean;
    page_token?: string;
  }>,
): Promise<T[]> {
  const items: T[] = [];
  let pageToken = "";
  const seenPageTokens = new Set<string>();
  while (true) {
    const page = await fetchPage(pageToken);
    items.push(...page.items);
    if (!page.has_more) break;
    const nextPageToken = page.page_token?.trim() ?? "";
    if (!nextPageToken) {
      throw new Error("飞书通讯录分页未完成：缺少下一页标记");
    }
    if (seenPageTokens.has(nextPageToken)) {
      throw new Error("飞书通讯录分页未完成：下一页标记重复");
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  return items;
}

/** 验证应用通讯录授权范围确实覆盖根部门，而非仅覆盖部分可见部门。 */
async function listAuthorizedDepartmentIds(): Promise<string[]> {
  return paginate<string>(async (pageToken) => {
    const params: Record<string, string> = {
      department_id_type: "open_department_id",
      user_id_type: "open_id",
      page_size: "100",
    };
    if (pageToken) params.page_token = pageToken;
    const data = await feishuGet<{
      department_ids?: string[];
      has_more: boolean;
      page_token?: string;
    }>("/contact/v3/scopes", params);
    return {
      items: data.department_ids ?? [],
      has_more: data.has_more,
      page_token: data.page_token,
    };
  });
}

/**
 * 飞书的“全部成员”授权会在 `/scopes` 返回根部门下的一级部门，
 * 但不会返回虚拟根 ID `0`。官方接口约束规定：应用身份只有在通讯录范围为
 * “全部成员”时才能读取根部门，因此直接读取根部门可作为完整授权证明。
 */
async function assertRootDepartmentAccessible(): Promise<void> {
  const data = await feishuGet<{ department?: DepartmentItem }>(
    "/contact/v3/departments/0",
    { department_id_type: "open_department_id" },
  );
  const root = data.department;
  if (!root || !(root.open_department_id ?? root.department_id)) {
    throw new Error(
      "飞书通讯录授权范围未覆盖根部门，已停止同步以避免误停未授权部门成员",
    );
  }
}

/** 获取企业全部部门 ID（含根部门 0） */
async function listAllDepartmentIds(): Promise<string[]> {
  const ids = new Set<string>(["0"]);

  const departments = await paginate<DepartmentItem>(async (pageToken) => {
    const params: Record<string, string> = {
      department_id_type: "open_department_id",
      fetch_child: "true",
      page_size: "50",
    };
    if (pageToken) params.page_token = pageToken;

    const data = await feishuGet<{
      items?: DepartmentItem[];
      has_more: boolean;
      page_token?: string;
    }>("/contact/v3/departments/0/children", params);

    return {
      items: data.items ?? [],
      has_more: data.has_more,
      page_token: data.page_token,
    };
  });

  for (const dept of departments) {
    const id = dept.open_department_id ?? dept.department_id;
    if (id) ids.add(id);
  }

  return [...ids];
}

async function listUsersInDepartment(
  departmentId: string,
): Promise<FeishuContactUser[]> {
  const items = await paginate<UserItem>(async (pageToken) => {
    const params: Record<string, string> = {
      department_id: departmentId,
      department_id_type: "open_department_id",
      user_id_type: "open_id",
      page_size: "50",
    };
    if (pageToken) params.page_token = pageToken;

    const data = await feishuGet<{
      items?: UserItem[];
      has_more: boolean;
      page_token?: string;
    }>("/contact/v3/users/find_by_department", params);

    return {
      items: data.items ?? [],
      has_more: data.has_more,
      page_token: data.page_token,
    };
  });
  if (items.some((user) => !user.open_id?.trim())) {
    throw new Error(
      `飞书部门 ${departmentId} 返回了缺少 openId 的成员，已停止同步`,
    );
  }
  return items.map((user) => ({
    openId: user.open_id!.trim(),
    unionId: user.union_id ?? null,
    name: user.name?.trim() || "未知用户",
    avatar: user.avatar?.avatar_72 ?? user.avatar?.avatar_origin ?? null,
    isActive: user.status?.is_resigned !== true,
  }));
}

export type FeishuContactSnapshot = {
  contacts: FeishuContactUser[];
  departmentCount: number;
  authorizedDepartmentCount: number;
  includesRootDepartment: boolean;
};

/** 从飞书通讯录拉取已验证授权范围和完整分页的成员快照。 */
export async function fetchAllFeishuContactUsers(): Promise<FeishuContactSnapshot> {
  const authorizedDepartmentIds = await listAuthorizedDepartmentIds();
  if (!authorizedDepartmentIds.includes("0")) {
    await assertRootDepartmentAccessible();
  }
  const includesRootDepartment = true;
  const departmentIds = await listAllDepartmentIds();
  const contacts: FeishuContactUser[] = [];

  for (const departmentId of departmentIds) {
    contacts.push(...(await listUsersInDepartment(departmentId)));
  }

  return {
    contacts: mergeFeishuContactUsers(contacts),
    departmentCount: departmentIds.length,
    authorizedDepartmentCount: authorizedDepartmentIds.length,
    includesRootDepartment,
  };
}

export function mergeFeishuContactUsers(
  contacts: Iterable<FeishuContactUser>,
): FeishuContactUser[] {
  const byOpenId = new Map<string, FeishuContactUser>();

  for (const user of contacts) {
    const existing = byOpenId.get(user.openId);
    if (!existing) {
      byOpenId.set(user.openId, user);
      continue;
    }
    byOpenId.set(user.openId, {
      ...existing,
      name: existing.name === "未知用户" ? user.name : existing.name,
      avatar: user.avatar ?? existing.avatar,
      unionId: user.unionId ?? existing.unionId,
      // 同一成员可能属于多个部门；任一记录标记离职都不能被另一条覆盖。
      isActive: existing.isActive && user.isActive,
    });
  }

  return [...byOpenId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "zh-CN"),
  );
}
