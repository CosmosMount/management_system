import { notFound } from "next/navigation";
import { ProcessingVendorHookFixtureClient } from "@/components/processing-vendor-hook-fixture-client";
import { isControlledPlaywrightServer } from "@/lib/playwright-fixture-guard";

export default function ProcessingVendorHookFixturesPage() {
  if (!isControlledPlaywrightServer()) notFound();
  return <ProcessingVendorHookFixtureClient />;
}
