import "dotenv/config";
import { buildProcurementNotificationCard } from "@/lib/feishu-procurement-card";
import { sendFeishuDirectMessage } from "@/lib/feishu-message";
import { mapOrderItems } from "@/lib/feishu";
import { prisma } from "@/lib/prisma";
import { writeFileSync } from "fs";

function canSendFeishu(): boolean {
  return (
    process.env.CONFIRM_SEND_FEISHU === "true" &&
    process.env.NOTIFICATION_DELIVERY_DISABLED !== "true"
  );
}

async function sendCard(openId: string, card: Record<string, unknown>, label: string) {
  const content = JSON.stringify(card);

  console.log(`\n========== ${label} ==========`);
  console.log("card JSON (first 2000 chars):");
  console.log(content.slice(0, 2000));
  if (content.length > 2000) console.log(`... (${content.length} chars total)`);

  const result = await sendFeishuDirectMessage({
    recipientOpenId: openId,
    botKind: "notification",
    purpose: "notification",
    message: { type: "interactive", card },
    logContext: { action: "debugFeishuCard", channel: "debug" },
  });
  console.log("发送结果:", JSON.stringify(result, null, 2));
  return result;
}

function minimalCallbackCard(orderId: string) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: "plain_text", content: "【测试】审批按钮" },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**测试单号**：${orderId}\n若能看到下方三个按钮，说明回调格式正确。`,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "通过" },
            type: "primary",
            value: {
              action: "procurement_approve_management",
              orderId,
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "驳回终止" },
            type: "danger",
            value: {
              action: "procurement_reject_terminate",
              orderId,
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "退回修改" },
            type: "default",
            value: {
              action: "procurement_reject_resubmit",
              orderId,
            },
          },
        ],
      },
    ],
  };
}

async function createAndSendCardKit(
  openId: string,
  card: Record<string, unknown>,
  label: string,
) {
  console.log(`\n========== ${label} (cardkit) ==========`);
  const result = await sendFeishuDirectMessage({
    recipientOpenId: openId,
    botKind: "notification",
    purpose: "notification",
    message: { type: "cardkit", card },
    logContext: { action: "debugFeishuCardKit", channel: "debug" },
  });
  console.log("发送结果:", JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const openId = process.argv[2];
  const orderId = process.argv[3];
  if (!openId || !orderId) {
    throw new Error(
      "用法: tsx scripts/debug-feishu-card.ts <openId> <orderId>。默认 dry-run；真实发送需设置 CONFIRM_SEND_FEISHU=true。",
    );
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) throw new Error("订单不存在");

  const cardV2 = {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: "plain_text", content: "【测试2.0】审批按钮" },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `**测试单号**：${order.orderNo}\n卡片 JSON 2.0 + behaviors`,
        },
        {
          tag: "column_set",
          flex_mode: "flow",
          columns: [
            {
              tag: "column",
              width: "auto",
              elements: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "通过" },
                  type: "primary",
                  behaviors: [
                    {
                      type: "callback",
                      value: {
                        action: "procurement_approve_management",
                        orderId: order.id,
                      },
                    },
                  ],
                },
              ],
            },
            {
              tag: "column",
              width: "auto",
              elements: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "驳回终止" },
                  type: "danger",
                  behaviors: [
                    {
                      type: "callback",
                      value: {
                        action: "procurement_reject_terminate",
                        orderId: order.id,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const fullCard = buildProcurementNotificationCard(
    {
      id: order.id,
      orderNo: order.orderNo,
      initiatorName: order.initiatorName,
      totalPrice: order.totalPrice,
      status: order.status,
      team: order.team,
      techGroup: order.techGroup,
      items: mapOrderItems(order.items),
    },
    { detailFocus: "approval" },
  );

  writeFileSync(
    "/tmp/feishu-card-full.json",
    JSON.stringify(fullCard, null, 2),
  );
  console.log("完整卡片已写入 /tmp/feishu-card-full.json");

  if (!canSendFeishu()) {
    console.log(
      "[debug-feishu-card] dry-run：不会发送飞书消息。若确需发送，设置 CONFIRM_SEND_FEISHU=true 且不要设置 NOTIFICATION_DELIVERY_DISABLED=true。",
    );
    console.log(`目标 openId=${openId} orderNo=${order.orderNo} id=${order.id}`);
    return;
  }

  await sendCard(openId, minimalCallbackCard(order.id), "v1 value 测试卡");
  await sendCard(openId, cardV2, "v2 behaviors 直接发");
  await createAndSendCardKit(openId, cardV2, "v2 behaviors cardkit");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
