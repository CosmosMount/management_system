import { notFound } from "next/navigation";
import { ProcurementImportDialogFixtureClient } from "@/components/procurement-import-dialog-fixture-client";
import { isControlledPlaywrightServer } from "@/lib/playwright-fixture-guard";

export default function ProcurementImportDialogFixturePage() {
  if (!isControlledPlaywrightServer()) notFound();
  return <ProcurementImportDialogFixtureClient />;
}
