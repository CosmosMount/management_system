import { customFetch } from "next-auth";
import { feishuCustomFetch } from "@/lib/feishu-auth";
import {
  buildAppUrl,
  isAllowedAppOrigin,
  parseAppUrl,
  resolveAppOrigin,
} from "@/lib/app-origin";
import type { NextAuthConfig } from "next-auth";

const FEISHU_SCOPES = "contact:user.base:readonly";

const feishuProvider = {
  id: "feishu",
  name: "飞书",
  type: "oauth" as const,
  clientId: process.env.FEISHU_APP_ID,
  clientSecret: process.env.FEISHU_APP_SECRET,
  // Auth.js v5 忽略 token.request，需用 customFetch 拦截 token 交换
  [customFetch]: feishuCustomFetch,
  checks: ["state"] as ("state" | "pkce" | "none")[],
  authorization: {
    url: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    params: {
      client_id: process.env.FEISHU_APP_ID,
      response_type: "code",
      scope: FEISHU_SCOPES,
    },
  },
  token: {
    url: "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token",
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
          union_id?: string;
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
    union_id?: string;
    name: string;
    avatar_url?: string;
  }) {
    return {
      id: profile.open_id,
      name: profile.name,
      image: profile.avatar_url,
      openId: profile.open_id,
      unionId: profile.union_id,
    };
  },
};

export const authConfig = {
  providers: [feishuProvider],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async redirect({ url, baseUrl }) {
      const base = resolveAppOrigin(baseUrl);

      if (url.startsWith("/")) {
        return buildAppUrl(url, base);
      }

      const target = parseAppUrl(url);
      if (!target || !isAllowedAppOrigin(target.origin)) {
        return buildAppUrl("/", base);
      }

      return target.toString();
    },
    async jwt({ token, user }) {
      if (user?.openId) {
        token.openId = user.openId;
      }
      if (user?.unionId) {
        token.unionId = user.unionId;
      }
      return token;
    },
    async session({ session, token }) {
      const openId =
        (token.openId as string | undefined) ?? token.sub ?? undefined;
      if (openId) {
        session.user.openId = openId;
        session.user.id = openId;
      }
      return session;
    },
  },
  trustHost: true,
} satisfies NextAuthConfig;
