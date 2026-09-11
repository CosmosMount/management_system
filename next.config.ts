import type { NextConfig } from "next";
import { FRONTEND_VERSION } from "./lib/frontend-version";

const configuredDevOrigins = [
  process.env.LAN_HOST,
  ...(process.env.ALLOWED_DEV_ORIGINS?.split(",").map((s) => s.trim()) ?? []),
].filter((origin): origin is string => Boolean(origin));

const nextConfig: NextConfig = {
  deploymentId: FRONTEND_VERSION.replaceAll(".", "-"),

  // The controlled Playwright runner may coexist with a developer server in
  // this workspace. A runner-owned build directory prevents Next.js locks and
  // generated state from crossing those two isolated processes.
  distDir: process.env.PLAYWRIGHT_DB_OWNERSHIP_TOKEN
    ? ".next-playwright"
    : ".next",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "s1-imfile.feishucdn.com",
        pathname: "/static-resource/**",
      },
      {
        protocol: "https",
        hostname: "s3-imfile.feishucdn.com",
        pathname: "/static-resource/**",
      },
    ],
  },
  async redirects() {
    return [
      { source: "/apply", destination: "/procurement/new", permanent: true },
      { source: "/orders", destination: "/procurement/list", permanent: true },
      { source: "/orders/:id/edit", destination: "/procurement/:id/edit", permanent: true },
      { source: "/orders/:id", destination: "/procurement/:id", permanent: true },
      { source: "/dashboard", destination: "/procurement/dashboard", permanent: true },
    ];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb",
    },
    proxyClientMaxBodySize: "100mb",
  },
  // 允许局域网 IP/域名访问 dev 资源（如从手机访问 http://<本机IP>:3000）
  allowedDevOrigins: Array.from(
    new Set([
      ...configuredDevOrigins,
      "localhost",
      "127.0.0.1",
    ]),
  ),
};

export default nextConfig;
