import * as Lark from "@larksuiteoapi/node-sdk";
import { cardToast } from "@/lib/feishu-card-response";
import { handleFeishuCardAction } from "@/lib/feishu-card-action-handler";

export function createFeishuEventDispatcher(): Lark.EventDispatcher {
  const dispatcher = new Lark.EventDispatcher({
    encryptKey: process.env.FEISHU_EVENT_ENCRYPT_KEY,
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
    loggerLevel: Lark.LoggerLevel.info,
  });

  return dispatcher.register({
    "card.action.trigger": async (
      data: Parameters<typeof handleFeishuCardAction>[0],
    ) => {
      try {
        return await handleFeishuCardAction(data);
      } catch (error) {
        console.error("[feishu-ws] 卡片回调处理失败:", error);
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
      console.log(`[feishu-ws] 收到消息事件 message_id=${messageId}`);
    },
    "im.chat.access_event.bot_p2p_chat_entered_v1": async (data: {
      operator_id?: { open_id?: string };
    }) => {
      const openId = data?.operator_id?.open_id ?? "unknown";
      console.log(`[feishu-ws] 用户进入机器人会话 open_id=${openId}`);
    },
    "application.bot.menu_v6": async (data: {
      operator?: { open_id?: string };
      event_key?: string;
    }) => {
      console.log("[feishu-ws] 机器人菜单事件", {
        openId: data?.operator?.open_id,
        eventKey: data?.event_key,
      });
      return cardToast("info", "请打开系统处理待办");
    },
  });
}
