import "dotenv/config";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createFeishuEventDispatcher } from "../lib/feishu-event-handlers";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

async function main() {
  const appId = requireEnv("FEISHU_APP_ID");
  const appSecret = requireEnv("FEISHU_APP_SECRET");

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  const shutdown = (signal: string) => {
    console.log(`[feishu-ws] 收到 ${signal}，正在关闭长连接…`);
    wsClient.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await wsClient.start({
    eventDispatcher: createFeishuEventDispatcher(),
  });

  console.log(
    "[feishu-ws] 长连接已建立。现在可在飞书开放平台「事件与回调」选择「使用长连接接收事件」并保存。",
  );
}

main().catch((error) => {
  console.error("[feishu-ws] 启动失败:", error);
  process.exit(1);
});
