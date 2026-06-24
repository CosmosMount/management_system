import type { NextConfig } from "next";

const configuredDevOrigins = [
  process.env.LAN_HOST,
  ...(process.env.ALLOWED_DEV_ORIGINS?.split(",").map((s) => s.trim()) ?? []),
].filter((origin): origin is string => Boolean(origin));

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "1gb",
    },
    proxyClientMaxBodySize: "1gb",
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
