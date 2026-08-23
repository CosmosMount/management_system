import { expect, test, type Page } from "@playwright/test";
import {
  loginAsNormalUser,
  resolveNormalAuthMaterial,
} from "./helpers/functional-fixtures";

const spreadsheetMime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test("两个 Excel 导入弹窗都会忽略关闭或重选后的旧解析结果", async ({
  page,
  context,
  baseURL,
}) => {
  const auth = await resolveNormalAuthMaterial();
  await loginAsNormalUser(context, baseURL, auth);
  await page.goto("/procurement/import-dialog-fixtures");

  await verifyDialogRace(page, "打开预算导入", "导入采购预算池");
  await verifyDialogRace(page, "打开明细导入", "从 Excel 导入采购明细");
});

async function verifyDialogRace(
  page: Page,
  openButtonName: string,
  dialogName: string,
) {
  await page.getByRole("button", { name: openButtonName }).click();
  let dialog = page.getByRole("dialog", { name: dialogName });
  let input = dialog.locator('input[type="file"]');
  const visibleFileTrigger = dialog.getByRole("button", {
    name: /选择文件|重新选择|解析中…/,
  });
  await expect(visibleFileTrigger).not.toHaveAttribute("aria-invalid", "true");
  await input.setInputFiles(filePayload("invalid.txt"));
  await expect(visibleFileTrigger).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("alert").filter({ hasText: "仅支持 .xlsx 或 .xls 文件" })).toBeVisible();
  await input.setInputFiles(filePayload("slow-close.xlsx"));
  await expect(visibleFileTrigger).not.toHaveAttribute("aria-invalid", "true");
  await dialog.getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: openButtonName }).click();
  dialog = page.getByRole("dialog", { name: dialogName });
  await page.waitForTimeout(400);
  await expect(dialog.getByText("slow-close.xlsx")).toHaveCount(0);

  input = dialog.locator('input[type="file"]');
  await input.setInputFiles(filePayload("slow-old.xlsx"));
  await input.setInputFiles(filePayload("fast-current.xlsx"));
  await expect(dialog.getByText("fast-current.xlsx", { exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  await expect(dialog.getByText("fast-current.xlsx", { exact: true })).toBeVisible();
  await expect(dialog.getByText("slow-old.xlsx")).toHaveCount(0);

  await input.setInputFiles(filePayload("fast-old.xlsx"));
  await input.setInputFiles(filePayload("slow-current.xlsx"));
  await page.waitForTimeout(120);
  await expect(dialog.getByRole("button", { name: "解析中…" })).toBeDisabled();
  await expect(dialog.getByText("slow-current.xlsx", { exact: true })).toBeVisible();
  await expect(dialog.getByText("fast-old.xlsx")).toHaveCount(0);
  await dialog.getByRole("button", { name: "取消" }).click();
}

function filePayload(name: string) {
  return { name, mimeType: spreadsheetMime, buffer: Buffer.from("fixture") };
}
