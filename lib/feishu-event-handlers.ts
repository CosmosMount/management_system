import * as Lark from "@larksuiteoapi/node-sdk";
import { cardToast } from "@/lib/feishu-card-response";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { handleFeishuCardAction } from "@/lib/feishu-card-action-handler";
import { logger } from "@/lib/logger";

export function createFeishuEventDispatcher(options?: {
  encryptKey?: string;
  verificationToken?: string;
  botKind?: FeishuBotKind;
}): Lark.EventDispatcher {
  const dispatcher = new Lark.EventDispatcher({
    encryptKey: options?.encryptKey ?? process.env.FEISHU_EVENT_ENCRYPT_KEY,
    verificationToken:
      options?.verificationToken ?? process.env.FEISHU_VERIFICATION_TOKEN,
    loggerLevel: Lark.LoggerLevel.info,
  });

  return dispatcher.register({
    "card.action.trigger": async (
      data: Parameters<typeof handleFeishuCardAction>[0],
    ) => {
      try {
        logger.info("feishu.ws.card_action.received", {
          module: "feishu-ws",
          action: "card.action.trigger",
          botKind: options?.botKind ?? "notification",
          operatorOpenId: data.operator?.open_id,
          actionName: data.action?.name,
          actionTag: data.action?.tag,
        });
        const result = await handleFeishuCardAction(data, {
          botKind: options?.botKind,
        });
        logger.info("feishu.ws.card_action.completed", {
          module: "feishu-ws",
          action: "card.action.trigger",
          botKind: options?.botKind ?? "notification",
          operatorOpenId: data.operator?.open_id,
          result: "success",
        });
        return result;
      } catch (error) {
        logger.error("feishu.ws.card_action.failed", {
          module: "feishu-ws",
          action: "card.action.trigger",
          botKind: options?.botKind ?? "notification",
          operatorOpenId: data.operator?.open_id,
          error,
        });
        return cardToast(
          "error",
          error instanceof Error ? error.message : "操作失败",
        );
      }
    },
    "im.message.receive_v1": async (data: {
      message?: { message_id?: string };
    }) => {
      const messageId = data?.message?.message_id ?? "unknown";
      logger.info("feishu.ws.message.received", {
        module: "feishu-ws",
        action: "im.message.receive_v1",
        botKind: options?.botKind ?? "notification",
        messageId,
      });
    },
    "im.chat.access_event.bot_p2p_chat_entered_v1": async (data: {
      operator_id?: { open_id?: string };
    }) => {
      const openId = data?.operator_id?.open_id ?? "unknown";
      logger.info("feishu.ws.p2p_chat_entered", {
        module: "feishu-ws",
        action: "im.chat.access_event.bot_p2p_chat_entered_v1",
        botKind: options?.botKind ?? "notification",
        operatorOpenId: openId,
      });
    },
    "application.bot.menu_v6": async (data: {
      operator?: { open_id?: string };
      event_key?: string;
    }) => {
      logger.info("feishu.ws.menu.received", {
        module: "feishu-ws",
        action: "application.bot.menu_v6",
        botKind: options?.botKind ?? "notification",
        operatorOpenId: data?.operator?.open_id,
        eventKey: data?.event_key,
      });
      return cardToast("info", "请打开系统处理待办");
    },
  });
}
