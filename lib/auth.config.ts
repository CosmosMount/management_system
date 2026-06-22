import type { NextAuthConfig } from "next-auth";

const feishuProvider = {
  id: "feishu",
  name: "飞书",
  type: "oauth" as const,
  authorization: {
    url: "https://open.feishu.cn/open-apis/authen/v1/authorize",
    params: {
      app_id: process.env.FEISHU_APP_ID,
    },
  },
  token: {
    url: "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token",
    async request({
      params,
      provider,
    }: {
      params: { code?: string };
      provider: { callbackUrl: string };
    }) {
      const res = await fetch(
        "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            client_id: process.env.FEISHU_APP_ID,
            client_secret: process.env.FEISHU_APP_SECRET,
            code: params.code,
            redirect_uri: provider.callbackUrl,
          }),
        },
      );
      const data = (await res.json()) as {
        code: number;
        msg?: string;
        data?: { access_token: string };
      };
      if (data.code !== 0 || !data.data?.access_token) {
        throw new Error(data.msg ?? "飞书 token 获取失败");
      }
      return {
        tokens: {
          access_token: data.data.access_token,
          token_type: "Bearer",
        },
      };
    },
  },
  userinfo: {
    url: "https://open.feishu.cn/open-apis/authen/v1/user_info",
    async request({ tokens }: { tokens: { access_token?: string } }) {
      const res = await fetch(
        "https://open.feishu.cn/open-apis/authen/v1/user_info",
        {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
          },
        },
      );
      const data = (await res.json()) as {
        code: number;
        msg?: string;
        data?: {
          open_id: string;
          name: string;
          avatar_url?: string;
        };
      };
      if (data.code !== 0 || !data.data) {
        throw new Error(data.msg ?? "飞书用户信息获取失败");
      }
      return data.data;
    },
  },
  profile(profile: {
    open_id: string;
    name: string;
    avatar_url?: string;
  }) {
    return {
      id: profile.open_id,
      name: profile.name,
      image: profile.avatar_url,
      openId: profile.open_id,
    };
  },
};

export const authConfig = {
  providers: [feishuProvider],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user?.openId) {
        token.openId = user.openId;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.openId) {
        session.user.openId = token.openId as string;
        session.user.id = token.sub ?? (token.openId as string);
      }
      return session;
    },
  },
  trustHost: true,
} satisfies NextAuthConfig;
