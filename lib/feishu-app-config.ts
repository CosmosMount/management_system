export type FeishuAppCredentials = {
  appId: string;
  appSecret: string;
};

export type FeishuBotKind = "notification" | "approval";

function readCredentials(
  appIdName: string,
  appSecretName: string,
): FeishuAppCredentials | null {
  const appId = process.env[appIdName]?.trim();
  const appSecret = process.env[appSecretName]?.trim();
  if (!appId && !appSecret) return null;
  if (!appId || !appSecret) {
    throw new Error(`请同时配置 ${appIdName} 和 ${appSecretName}`);
  }
  return { appId, appSecret };
}

export function getOAuthFeishuCredentials(): FeishuAppCredentials {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  }
  return { appId, appSecret };
}

/** 普通通知机器人；未单独配置时回退 OAuth 主应用。 */
export function getNotificationFeishuCredentials(): FeishuAppCredentials {
  return (
    readCredentials("FEISHU_NOTIFICATION_APP_ID", "FEISHU_NOTIFICATION_APP_SECRET") ??
    getOAuthFeishuCredentials()
  );
}

/** 审批通知机器人；未单独配置时回退普通通知机器人。 */
export function getApprovalFeishuCredentials(): FeishuAppCredentials {
  return (
    readCredentials("FEISHU_APPROVAL_APP_ID", "FEISHU_APPROVAL_APP_SECRET") ??
    getNotificationFeishuCredentials()
  );
}

export function getFeishuCredentialsByBotKind(
  botKind: FeishuBotKind,
): FeishuAppCredentials {
  return botKind === "approval"
    ? getApprovalFeishuCredentials()
    : getNotificationFeishuCredentials();
}

export function usesSeparateApprovalBot(): boolean {
  const approvalAppId = process.env.FEISHU_APPROVAL_APP_ID?.trim();
  const approvalAppSecret = process.env.FEISHU_APPROVAL_APP_SECRET?.trim();
  if (!approvalAppId || !approvalAppSecret) return false;

  const notificationAppId =
    process.env.FEISHU_NOTIFICATION_APP_ID?.trim() ||
    process.env.FEISHU_APP_ID?.trim();
  return approvalAppId !== notificationAppId;
}

/** 兼容旧命名：登录、通讯录与旧脚本仍使用 OAuth 主应用。 */
export function getProcurementFeishuCredentials(): FeishuAppCredentials {
  return getOAuthFeishuCredentials();
}
