import "dotenv/config";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createFeishuEventDispatcher } from "../lib/feishu-event-handlers";
import {
  getFeishuCredentialsByBotKind,
  type FeishuBotKind,
} from "../lib/feishu-app-config";

function resolveWsBotKind(): FeishuBotKind {
  const raw = process.env.FEISHU_WS_BOT_KIND?.trim();
  if (!raw) return "notification";
  if (raw === "notification" || raw === "approval") return raw;
  throw new Error("FEISHU_WS_BOT_KIND 只能是 notification 或 approval");
}

function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function resolveEventConfig(botKind: FeishuBotKind): {
  encryptKey?: string;
  verificationToken?: string;
} {
  const prefix = botKind === "approval" ? "FEISHU_APPROVAL" : "FEISHU_NOTIFICATION";
  return {
    encryptKey:
      optionalEnv(`${prefix}_EVENT_ENCRYPT_KEY`) ??
      optionalEnv("FEISHU_EVENT_ENCRYPT_KEY"),
    verificationToken:
      optionalEnv(`${prefix}_VERIFICATION_TOKEN`) ??
      optionalEnv("FEISHU_VERIFICATION_TOKEN"),
  };
}

async function main() {
  const botKind = resolveWsBotKind();
  const credentials = getFeishuCredentialsByBotKind(botKind);

  const wsClient = new Lark.WSClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
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
    eventDispatcher: createFeishuEventDispatcher({
      ...resolveEventConfig(botKind),
      botKind,
    }),
  });

  console.log(
    `[feishu-ws] ${botKind} 机器人长连接已建立。现在可在飞书开放平台「事件与回调」选择「使用长连接接收事件」并保存。`,
  );
}

main().catch((error) => {
  console.error("[feishu-ws] 启动失败:", error);
  process.exit(1);
});
