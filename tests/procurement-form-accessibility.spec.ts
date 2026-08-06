import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import {
  loginAsNormalUser,
  resolveNormalAuthMaterial,
} from "./helpers/functional-fixtures";

test("采购表单字段错误与标签保持可访问关联", async ({
  page,
  context,
  baseURL,
}) => {
  const auth = await resolveNormalAuthMaterial();
  await ensureNormalUserSignature(auth);
  await loginAsNormalUser(context, baseURL, auth);
  await page.goto("/procurement/new");
  await page.getByRole("button", { name: "提交申请" }).click();

  await expect(page.getByLabel("车组")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("技术组")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByLabel("物品名称")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByLabel("规格")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert").filter({ hasText: "请输入物品名称" })).toBeVisible();
});

async function ensureNormalUserSignature(user: {
  openId: string;
  name: string;
}) {
  const identity = await resolveFeishuIdentityForUser(user);
  await prisma.user.upsert({
    where: { openId: user.openId },
    update: { signaturePath: "/uploads/playwright/accessibility-signature.png" },
    create: {
      accountId: identity.account.id,
      openId: user.openId,
      name: user.name,
      signaturePath: "/uploads/playwright/accessibility-signature.png",
    },
  });
}

test("工坊表单缺少图片时显示字段错误并聚焦上传控件", async ({
  page,
  context,
  baseURL,
}) => {
  const auth = await resolveNormalAuthMaterial();
  await loginAsNormalUser(context, baseURL, auth);
  await page.goto("/procurement/workshop-fee");
  await page.getByLabel("车组").click();
  await page.getByRole("option", { name: "英雄" }).click();
  await page.getByLabel("费用名称").fill("图片校验测试");
  await page.getByLabel("说明").fill("测试说明");
  await page.getByLabel("加工商").click();
  await page.getByRole("option", { name: /添加加工商/ }).click();
  await page.locator("#processing-vendor-name").fill(`测试加工商-${Date.now()}`);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("button", { name: "提交并计入汇总" }).click();

  const imageInput = page.getByLabel("图片");
  await expect(imageInput).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert").filter({ hasText: "请上传加工费图片" })).toBeVisible();
  await expect(imageInput).toBeFocused();
});
