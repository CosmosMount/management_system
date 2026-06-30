export type FeishuAppCredentials = {
  appId: string;
  appSecret: string;
};

export function getProcurementFeishuCredentials(): FeishuAppCredentials {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  }
  return { appId, appSecret };
}

/** 项目通知机器人；未配置时回退到采购/OAuth 同一应用 */
export function getProgressFeishuCredentials(): FeishuAppCredentials {
  const appId =
    process.env.FEISHU_PROGRESS_APP_ID?.trim() ||
    process.env.FEISHU_APP_ID?.trim();
  const appSecret =
    process.env.FEISHU_PROGRESS_APP_SECRET?.trim() ||
    process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error(
      "缺少 FEISHU_PROGRESS_APP_ID / FEISHU_PROGRESS_APP_SECRET（或未配置 FEISHU_APP_ID）",
    );
  }
  return { appId, appSecret };
}

export function usesSeparateProgressBot(): boolean {
  return Boolean(
    process.env.FEISHU_PROGRESS_APP_ID?.trim() &&
      process.env.FEISHU_PROGRESS_APP_SECRET?.trim(),
  );
}
