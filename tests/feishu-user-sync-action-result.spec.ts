// @playwright-project ui
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { FeishuContactRequestError } from "../lib/feishu-contact";
import { toFeishuUserSyncActionFailure } from "../lib/feishu-user-sync-action-result";
import { ProjectManagementIdentityError } from "../lib/project-management/identity";
import { prisma } from "../lib/prisma";
import {
  loginAsAdminUser,
  loginAsOtherUser,
  prepareFunctionalFixtures,
  resolveNormalAuthMaterial,
} from "./helpers/functional-fixtures";


test("通讯录 Server Action 将飞书请求失败映射为安全可操作文案", () => {
  const secretDetail = "HTTP 403 token=should-not-reach-client";
  const failure = toFeishuUserSyncActionFailure(
    new FeishuContactRequestError(
      "/contact/v3/scopes",
      new Error(secretDetail),
    ),
  );

  expect(failure).toEqual({
    code: "FEISHU_UNAVAILABLE",
    message:
      "无法读取飞书通讯录，请检查应用凭证、通讯录权限和网络连接后重试。",
  });
  expect(failure.message).not.toContain(secretDetail);
});

test("通讯录 Server Action 保留授权范围与身份冲突的安全失败语义", () => {
  expect(
    toFeishuUserSyncActionFailure(
      new Error(
        "飞书通讯录授权范围未覆盖根部门，已停止同步以避免误停未授权部门成员",
      ),
    ),
  ).toEqual({
    code: "SNAPSHOT_INVALID",
    message:
      "飞书通讯录授权范围未覆盖根部门，已取消同步。请在飞书开放平台授权全部部门后重试。",
  });

  expect(
    toFeishuUserSyncActionFailure(
      new ProjectManagementIdentityError(
        "IDENTITY_CONFLICT",
        "飞书身份冲突 openId=internal-id",
      ),
    ),
  ).toEqual({
    code: "IDENTITY_CONFLICT",
    message:
      "检测到飞书身份与现有账号冲突，已取消同步。请联系管理员查看服务端日志并处理账号关联。",
  });
});

test("通讯录 Server Action 不向客户端透传未知异常和无效确认载荷", () => {
  const internalFailure = toFeishuUserSyncActionFailure(
    new Error("database_url=postgresql://secret@internal.example/db"),
  );
  expect(internalFailure.code).toBe("INTERNAL_ERROR");
  expect(internalFailure.message).not.toContain("postgresql");
  expect(internalFailure.message).not.toContain("secret");

  let validationError: unknown;
  try {
    z.string().uuid().parse("invalid-confirmation-token");
  } catch (error) {
    validationError = error;
  }
  expect(toFeishuUserSyncActionFailure(validationError)).toEqual({
    code: "INVALID_INPUT",
    message: "同步确认信息无效，请重新发起同步。",
  });
});

test("通讯录 Server Action 直接调用执行会话鉴权且拒绝路径零写入", async ({
  page,
  context,
  baseURL,
}) => {
  await prepareFunctionalFixtures(await resolveNormalAuthMaterial());
  const readWriteCounts = () =>
    prisma.$transaction([
      prisma.account.count(),
      prisma.accountIdentity.count(),
      prisma.person.count(),
      prisma.user.count(),
      prisma.systemRoleAssignment.count(),
      prisma.domainAuditEvent.count(),
    ]);
  const before = await readWriteCounts();

  await loginAsOtherUser(context, baseURL);
  await page.goto("/feishu-sync-action-fixtures", {
    waitUntil: "networkidle",
  });
  await context.clearCookies();
  await page.getByRole("button", { name: "调用飞书通讯录同步" }).click();
  await expect(page.getByLabel("飞书通讯录同步调用结果")).toHaveText(
    "UNAUTHENTICATED",
  );

  await loginAsOtherUser(context, baseURL);
  await page.goto("/feishu-sync-action-fixtures", {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "调用飞书通讯录同步" }).click();
  await expect(page.getByLabel("飞书通讯录同步调用结果")).toHaveText(
    "FORBIDDEN",
  );
  await expect(readWriteCounts()).resolves.toEqual(before);

  await loginAsAdminUser(context, baseURL);
  await page.goto("/feishu-sync-action-fixtures", {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "调用飞书通讯录同步" }).click();
  await expect(page.getByLabel("飞书通讯录同步调用结果")).toHaveText(
    "FEISHU_UNAVAILABLE",
  );
});
