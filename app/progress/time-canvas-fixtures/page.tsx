import { notFound } from "next/navigation";
import {
  createEmptyTimeCanvasFixture,
  createRowHeaderTimeCanvasFixture,
  createTimeCanvasFixture,
} from "@/components/project-management/time-canvas/fixtures";
import { ObservedTimeCanvasFixture } from "@/components/project-management/time-canvas/observed-fixture";
import { RowHeaderTimeCanvasFixture } from "@/components/project-management/time-canvas/row-header-fixture";
import { DAY_MS } from "@/components/project-management/time-canvas/time-math";
import type {
  TimeCanvasMode,
  TimeCanvasZoom,
} from "@/components/project-management/time-canvas/types";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { listGlobalTimeMarkers } from "@/lib/project-management/global-time-markers";

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
  const baseModel = single(params.empty) === "1"
    ? createEmptyTimeCanvasFixture()
    : createTimeCanvasFixture(mode);
  const sizedModel = single(params.long) === "1"
    ? {
        ...baseModel,
        range: {
          startMs: baseModel.range.startMs,
          endMs: baseModel.range.startMs + 3 * 366 * DAY_MS,
        },
      }
    : baseModel;
  const model = single(params.globalMarkers) === "1"
    ? {
        ...sizedModel,
        globalMarkers: (await listGlobalTimeMarkers()).map((marker) => ({
          id: marker.id,
          label: marker.name,
          atMs: Date.parse(marker.markedAt),
          editable: false,
          versionToken: marker.versionToken,
        })),
      }
    : sizedModel;
  const initialZoom = parseZoom(single(params.scale));

  return (
    <>
      <PageCommandBar
        title="TimeCanvas 受控验收夹具"
        description="仅在 runner-owned Playwright 隔离数据库和通知禁发环境中可访问。"
      />
      <main className="mx-auto w-full min-w-0 max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-background">
          {single(params.rowHeaders) === "1" ? (
            <RowHeaderTimeCanvasFixture model={createRowHeaderTimeCanvasFixture()} />
          ) : (
            <ObservedTimeCanvasFixture
              mode={mode}
              model={model}
              initialZoom={initialZoom}
            />
          )}
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

function parseZoom(value: string | undefined): TimeCanvasZoom | undefined {
  const normalized = value?.toUpperCase();
  return normalized === "WEEK" ||
    normalized === "MONTH" ||
    normalized === "QUARTER" ||
    normalized === "YEAR"
    ? normalized
    : undefined;
}
