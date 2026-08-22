import { notFound } from "next/navigation";
import { FeishuSyncActionFixtureClient } from "@/components/admin/feishu-sync-action-fixture-client";
import { isControlledPlaywrightServer } from "@/lib/playwright-fixture-guard";

export default function FeishuSyncActionFixturesPage() {
  if (!isControlledPlaywrightServer()) notFound();
  return (
    <FeishuSyncActionFixtureClient />
  );
}
