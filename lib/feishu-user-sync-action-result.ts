import { ZodError } from "zod";
import { FeishuContactRequestError } from "@/lib/feishu-contact";
import { ProjectManagementIdentityError } from "@/lib/project-management/identity";

export const FEISHU_USER_SYNC_FAILURE_CODES = [
  "INVALID_INPUT",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "FEISHU_UNAVAILABLE",
  "SNAPSHOT_INVALID",
  "IDENTITY_CONFLICT",
  "SYNC_REJECTED",
  "INTERNAL_ERROR",
] as const;

export type FeishuUserSyncFailureCode =
  (typeof FEISHU_USER_SYNC_FAILURE_CODES)[number];

export type FeishuUserSyncActionFailure = {
  code: FeishuUserSyncFailureCode;
  message: string;
};

const SNAPSHOT_ERROR_MESSAGES = new Map<string, string>([
  [
    "飞书通讯录授权范围未覆盖根部门，已停止同步以避免误停未授权部门成员",
    "飞书通讯录授权范围未覆盖根部门，已取消同步。请在飞书开放平台授权全部部门后重试。",
  ],
  [
    "飞书通讯录未返回任何用户，请检查应用通讯录权限范围",
    "飞书通讯录未返回任何在职成员，已取消同步。请检查应用的通讯录权限与授权范围。",
  ],
  [
    "飞书通讯录快照未通过完整性校验，已停止同步",
    "飞书通讯录数据不完整，已取消同步。请检查授权范围后重试。",
  ],
  [
    "通讯录结果中没有在职的全局管理员，请先确认应用权限范围或移交管理员角色",
    "同步结果中没有在职的全局管理员，已取消同步。请检查授权范围或先移交管理员角色。",
  ],
]);

/** Server Action 只返回经过白名单映射的文案，完整异常保留在服务端结构化日志中。 */
export function toFeishuUserSyncActionFailure(
  error: unknown,
): FeishuUserSyncActionFailure {
  if (error instanceof ZodError) {
    return {
      code: "INVALID_INPUT",
      message: "同步确认信息无效，请重新发起同步。",
    };
  }

  if (error instanceof ProjectManagementIdentityError) {
    return error.code === "IDENTITY_CONFLICT"
      ? {
          code: "IDENTITY_CONFLICT",
          message:
            "检测到飞书身份与现有账号冲突，已取消同步。请联系管理员查看服务端日志并处理账号关联。",
        }
      : {
          code: "SNAPSHOT_INVALID",
          message: "飞书成员身份数据不完整，已取消同步。请检查通讯录资料后重试。",
        };
  }

  if (error instanceof FeishuContactRequestError) {
    return {
      code: "FEISHU_UNAVAILABLE",
      message:
        "无法读取飞书通讯录，请检查应用凭证、通讯录权限和网络连接后重试。",
    };
  }

  const message = error instanceof Error ? error.message.trim() : "";
  if (message === "未登录") {
    return {
      code: "UNAUTHENTICATED",
      message: "登录状态已失效，请重新登录后再同步。",
    };
  }
  if (
    message === "无管理权限" ||
    message.startsWith("同步操作人已失去超级管理员权限") ||
    message.startsWith("确认操作人已失去超级管理员权限")
  ) {
    return {
      code: "FORBIDDEN",
      message: "当前账号已无同步权限，请刷新页面或重新登录。",
    };
  }

  const snapshotMessage = SNAPSHOT_ERROR_MESSAGES.get(message);
  if (snapshotMessage) {
    return { code: "SNAPSHOT_INVALID", message: snapshotMessage };
  }
  if (
    message.startsWith("飞书通讯录分页未完成") ||
    message.startsWith("飞书通讯录返回了缺少 openId") ||
    message.startsWith("飞书部门 ") ||
    message === "同步事务只能接收非空的在职成员快照"
  ) {
    return {
      code: "SNAPSHOT_INVALID",
      message: "飞书通讯录数据不完整，已取消同步。请稍后重试。",
    };
  }
  if (
    message.startsWith("获取飞书 tenant_access_token 失败") ||
    message.startsWith("飞书通讯录 API 失败")
  ) {
    return {
      code: "FEISHU_UNAVAILABLE",
      message:
        "无法读取飞书通讯录，请检查应用凭证、通讯录权限和网络连接后重试。",
    };
  }

  if (message.includes("通讯录") && message.includes("已停止同步")) {
    return {
      code: "SYNC_REJECTED",
      message: "通讯录安全校验未通过，已取消同步。请检查授权范围后重试。",
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message:
      "通讯录同步未完成，请稍后重试；如持续失败，请联系管理员查看服务端日志。",
  };
}
