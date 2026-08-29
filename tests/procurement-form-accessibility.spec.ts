// @playwright-project ui
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
  const team = page.getByLabel("车组");
  const itemName = page.getByLabel("物品名称");
  await expect(team).not.toHaveAttribute("aria-invalid", "true");
  await expect(itemName).not.toHaveAttribute("aria-invalid", "true");
  const neutralBorderColor = await itemName.evaluate(
    (element) => getComputedStyle(element).borderColor,
  );
  await page.getByRole("button", { name: "提交申请" }).click();

  await expect(team).toHaveAttribute("aria-invalid", "true");
  await expect(team).toBeFocused();
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
  await expect
    .poll(() => itemName.evaluate((element) => getComputedStyle(element).borderColor))
    .not.toBe(neutralBorderColor);
  await itemName.fill("已修正的物品名称");
  await expect(itemName).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert").filter({ hasText: "请输入物品名称" })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
});

test("电子签名空提交会标记并聚焦文件输入", async ({
  page,
  context,
  baseURL,
}) => {
  const auth = await resolveNormalAuthMaterial();
  await ensureNormalUserSignature(auth);
  await loginAsNormalUser(context, baseURL, auth);
  await page.goto("/profile");

  const signatureInput = page.getByLabel("上传新签名（PNG/JPG，≤2MB）");
  await expect(signatureInput).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "更新签名" }).click();
  await expect(signatureInput).toHaveAttribute("aria-invalid", "true");
  await expect(signatureInput).toBeFocused();
  await expect(page.getByRole("alert").filter({ hasText: "请选择新的签名图片" })).toBeVisible();
  await signatureInput.setInputFiles({
    name: "signature.png",
    mimeType: "image/png",
    buffer: Buffer.from("not-uploaded-during-validation-test"),
  });
  await expect(signatureInput).not.toHaveAttribute("aria-invalid", "true");
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
