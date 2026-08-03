import { notFound } from "next/navigation";
import {
  createEmptyTimeCanvasFixture,
  createTimeCanvasFixture,
} from "@/components/project-management/time-canvas/fixtures";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import type { TimeCanvasMode } from "@/components/project-management/time-canvas/types";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";

const modes = new Set<TimeCanvasMode>([
  "TASK_COMPOSER",
  "TASK_WORKBENCH",
  "RESOURCE_PLANNER",
  "PERSONAL_TIMELINE",
]);

export default async function TimeCanvasFixturePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isControlledPlaywrightServer()) notFound();
  const params = (await searchParams) ?? {};
  const requestedMode = single(params.mode);
  const mode = modes.has(requestedMode as TimeCanvasMode)
    ? (requestedMode as TimeCanvasMode)
    : "RESOURCE_PLANNER";
  const model = single(params.empty) === "1"
    ? createEmptyTimeCanvasFixture()
    : createTimeCanvasFixture(mode);

  return (
    <>
      <PageCommandBar
        title="TimeCanvas 受控验收夹具"
        description="仅在 runner-owned Playwright 隔离数据库和通知禁发环境中可访问。"
      />
      <main className="mx-auto w-full min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-background">
          <TimeCanvas
            mode={mode}
            model={model}
            display={{
              showActual: true,
              showBusy: true,
              showInspector: true,
            }}
            emptyMessage="受控空数据验收状态"
          />
        </div>
      </main>
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

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
