import { notFound } from "next/navigation";
import { EntityPickerFixtureClient } from "@/components/entity-picker/fixtures/entity-picker-fixture-client";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";

export default function EntityPickerFixturePage() {
  if (!isControlledPlaywrightServer()) notFound();

  return (
    <>
      <PageCommandBar
        title="实体选择器受控验收夹具"
        description="仅在 runner-owned Playwright 隔离数据库和通知禁发环境中可访问。"
      />
      <EntityPickerFixtureClient />
    </>
  );
}

function isControlledPlaywrightServer() {
  if (
    process.env.NOTIFICATION_DELIVERY_DISABLED !== "true" ||
    !process.env.PLAYWRIGHT_DB_OWNERSHIP_TOKEN?.trim()
  ) {
    return false;
  }
  try {
    const databaseName = new URL(process.env.DATABASE_URL ?? "").pathname
      .slice(1)
      .split("?")[0];
    return Boolean(databaseName?.endsWith("_test"));
  } catch {
    return false;
  }
}
