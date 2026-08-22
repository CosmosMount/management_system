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
