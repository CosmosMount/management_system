import "dotenv/config";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createFeishuEventDispatcher } from "../lib/feishu-event-handlers";
import {
  getFeishuCredentialsByBotKind,
  type FeishuBotKind,
} from "../lib/feishu-app-config";
import { logger, withScriptLogging } from "../lib/logger";

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
  const eventConfig = resolveEventConfig(botKind);

  const wsClient = new Lark.WSClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  const shutdown = (signal: string) => {
    logger.info("feishu.ws.shutdown", {
      module: "feishu-ws",
      action: "shutdown",
      botKind,
      signal,
    });
    wsClient.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await wsClient.start({
    eventDispatcher: createFeishuEventDispatcher({
      ...eventConfig,
      botKind,
    }),
  });

  logger.info("feishu.ws.started", {
    module: "feishu-ws",
    action: "start",
    botKind,
    hasEncryptKey: Boolean(eventConfig.encryptKey),
    hasVerificationToken: Boolean(eventConfig.verificationToken),
  });
}

withScriptLogging("feishu-ws", main).catch((error) => {
  logger.error("feishu.ws.start.failed", {
    module: "feishu-ws",
    action: "start",
    error,
  });
  process.exit(1);
});
