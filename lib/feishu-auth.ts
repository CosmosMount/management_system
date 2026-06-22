export async function getFeishuAppAccessToken(): Promise<string> {
  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: process.env.FEISHU_APP_ID,
        app_secret: process.env.FEISHU_APP_SECRET,
      }),
    },
  );
  const data = (await res.json()) as {
    code?: number;
    msg?: string;
    app_access_token?: string;
    tenant_access_token?: string;
  };

  if (!data.app_access_token) {
    throw new Error(data.msg ?? "获取飞书 app_access_token 失败");
  }
  return data.app_access_token;
}

/** 发消息 Open API 使用 tenant_access_token */
export async function getFeishuTenantAccessToken(): Promise<string> {
  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: process.env.FEISHU_APP_ID,
        app_secret: process.env.FEISHU_APP_SECRET,
      }),
    },
  );
  const data = (await res.json()) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    app_access_token?: string;
  };

  const token = data.tenant_access_token ?? data.app_access_token;
  if (!token) {
    throw new Error(data.msg ?? "获取飞书 tenant_access_token 失败");
  }
  return token;
}

function extractCodeFromBody(body: RequestInit["body"]): string | null {
  if (!body) return null;
  if (body instanceof URLSearchParams) {
    return body.get("code");
  }
  if (typeof body === "string") {
    return new URLSearchParams(body).get("code");
  }
  return null;
}

export const feishuCustomFetch: typeof fetch = async (input, init) => {
  const url = String(input);

  if (url.includes("authen/v1/oidc/access_token")) {
    const code = extractCodeFromBody(init?.body);
    if (!code) {
      return fetch(input, init);
    }

    const appAccessToken = await getFeishuAppAccessToken();
    const tokenRes = await fetch(
      "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${appAccessToken}`,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
        }),
      },
    );
    const tokenData = (await tokenRes.json()) as {
      code: number;
      msg?: string;
      data?: {
        access_token: string;
        expires_in?: number;
        refresh_token?: string;
        scope?: string;
      };
    };

    if (tokenData.code !== 0 || !tokenData.data?.access_token) {
      return Response.json(
        {
          error: "invalid_grant",
          error_description: tokenData.msg ?? "飞书 user_access_token 获取失败",
        },
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    return Response.json({
      access_token: tokenData.data.access_token,
      token_type: "Bearer",
      expires_in: tokenData.data.expires_in,
      refresh_token: tokenData.data.refresh_token,
      scope: tokenData.data.scope,
    });
  }

  return fetch(input, init);
};
