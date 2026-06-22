import type { NextConfig } from "next";

const lanHost = process.env.LAN_HOST ?? "10.7.165.65";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb",
    },
    proxyClientMaxBodySize: "100mb",
  },
  // 允许局域网 IP 访问 dev 资源（如从手机访问 http://10.7.165.65:3000）
  allowedDevOrigins: [
    lanHost,
    "localhost",
    "127.0.0.1",
    ...(process.env.ALLOWED_DEV_ORIGINS?.split(",").map((s) => s.trim()) ??
      []),
  ],
};

export default nextConfig;
