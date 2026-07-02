type CardToastResponse = {
  toast: {
    type: "success" | "error" | "info";
    content: string;
    i18n: { zh_cn: string; en_us: string };
  };
};

export function cardToast(
  type: "success" | "error" | "info",
  content: string,
): CardToastResponse {
  return {
    toast: {
      type,
      content,
      i18n: {
        zh_cn: content,
        en_us: content,
      },
    },
  };
}

/** 卡片回调：toast + 可选更新卡片（按钮变为只读） */
export function cardActionResponse(
  type: "success" | "error" | "info",
  content: string,
  card?: Record<string, unknown>,
): CardToastResponse & {
  card?: { type: "raw"; data: Record<string, unknown> };
} {
  const response = cardToast(type, content);
  if (!card) return response;
  return {
    ...response,
    card: {
      type: "raw",
      data: card,
    },
  };
}
