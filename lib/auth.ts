import NextAuth from "next-auth";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/lib/auth.config";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      image?: string | null;
      openId: string;
      unionId?: string | null;
    };
  }

  interface User {
    openId?: string;
    unionId?: string;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user }) {
      if (!user.openId) return false;
      await prisma.user.upsert({
        where: { openId: user.openId },
        update: {
          name: user.name ?? "未知用户",
          avatar: user.image ?? null,
          unionId: user.unionId ?? undefined,
        },
        create: {
          openId: user.openId,
          unionId: user.unionId ?? null,
          name: user.name ?? "未知用户",
          avatar: user.image ?? null,
        },
      });
      return true;
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
      session.user.unionId = token.unionId as string | undefined;
      return session;
    },
  },
});
