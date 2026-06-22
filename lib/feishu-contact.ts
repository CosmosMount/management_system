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
  name?: string;
  avatar?: {
    avatar_72?: string;
    avatar_origin?: string;
  };
};

export type FeishuContactUser = {
  openId: string;
  name: string;
  avatar: string | null;
};

async function feishuGet<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
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
  if (body.code !== 0 || !body.data) {
    throw new Error(body.msg ?? `飞书通讯录 API 失败: ${path}`);
  }
  return body.data;
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
  do {
    const page = await fetchPage(pageToken);
    items.push(...page.items);
    if (!page.has_more) break;
    pageToken = page.page_token ?? "";
  } while (pageToken);
  return items;
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
  return paginate<UserItem>(async (pageToken) => {
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
  }).then((items) =>
    items
      .filter((u): u is UserItem & { open_id: string } => !!u.open_id)
      .map((u) => ({
        openId: u.open_id,
        name: u.name?.trim() || "未知用户",
        avatar: u.avatar?.avatar_72 ?? u.avatar?.avatar_origin ?? null,
      })),
  );
}

/** 从飞书通讯录拉取全部成员（去重） */
export async function fetchAllFeishuContactUsers(): Promise<FeishuContactUser[]> {
  const departmentIds = await listAllDepartmentIds();
  const byOpenId = new Map<string, FeishuContactUser>();

  for (const departmentId of departmentIds) {
    const users = await listUsersInDepartment(departmentId);
    for (const user of users) {
      const existing = byOpenId.get(user.openId);
      if (!existing) {
        byOpenId.set(user.openId, user);
        continue;
      }
      if (existing.name === "未知用户" && user.name !== "未知用户") {
        byOpenId.set(user.openId, user);
      }
    }
  }

  return [...byOpenId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "zh-CN"),
  );
}
