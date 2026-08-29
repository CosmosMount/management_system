// @playwright-project node-db
import { expect, test } from "@playwright/test";
import nextConfig from "../next.config";

test("Next Image 精确放行飞书 s3 静态头像路径", () => {
  expect(nextConfig.images?.remotePatterns).toContainEqual({
    protocol: "https",
    hostname: "s3-imfile.feishucdn.com",
    pathname: "/static-resource/**",
  });
});
