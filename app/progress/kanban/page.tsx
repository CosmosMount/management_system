import { redirect } from "next/navigation";
import { PersonTimelineFilter } from "@/components/project-management/person-timeline-filter";
import { ResourcePlannerCanvasClient } from "@/components/project-management/resource-planner-canvas-client";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { timeCanvasDataToModel } from "@/components/project-management/time-canvas/adapter";
import type { TimeCanvasZoom } from "@/components/project-management/time-canvas/types";
import { toProjectManagementServiceError } from "@/lib/project-management/application/errors";
import {
  getActorPersonOption,
  resolvePeopleOptionsByIds,
} from "@/lib/project-management/queries/option-queries";
import { getPersonTimelinePageData } from "@/lib/project-management/queries/time-canvas-queries";
import { routes } from "@/lib/routes";
import { getProgressActorOrRedirect } from "../_auth";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ProgressKanbanPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const actor = await getProgressActorOrRedirect();
  const params = (await searchParams) ?? {};
  const requestedPersonId = firstParam(params.people);
  const hasDuplicatePersonParams = Array.isArray(params.people);
  const actorPerson = await getActorPersonOption(actor);
  let selectedPerson = actorPerson;
  let personError = firstParam(params.personError) === "1";

  if (requestedPersonId && isUuid(requestedPersonId)) {
    if (requestedPersonId.toLowerCase() !== actor.personId) {
      const [resolvedPerson] = await resolvePeopleOptionsByIds({
        actor,
        input: {
          scope: { purpose: "VISIBLE" },
          ids: [requestedPersonId.toLowerCase()],
        },
      });
      if (resolvedPerson?.status === "ACTIVE") selectedPerson = resolvedPerson;
      else personError = true;
    }
  } else if (requestedPersonId) {
    personError = true;
  }

  if (
    hasDuplicatePersonParams ||
    requestedPersonId.toLowerCase() !== selectedPerson.id ||
    !isUuid(requestedPersonId)
  ) {
    redirect(kanbanHref({
      personId: selectedPerson.id,
      centerMs: parseCenter(firstParam(params.center)) ?? undefined,
      scale: parseScale(firstParam(params.scale)),
      personError,
    }));
  }

  const requestedCenter = parseCenter(firstParam(params.center)) ?? undefined;
  const requestedScale = parseScale(firstParam(params.scale));
  const timelineResult = await getPersonTimelinePageData({
    actor,
    input: { personId: selectedPerson.id },
    preferredCenterMs: requestedCenter,
    load: { mode: "INITIAL" },
  })
    .then((data) => ({ ok: true as const, data }))
    .catch((error: unknown) => {
      const mapped = toProjectManagementServiceError(error);
      return {
        ok: false as const,
        code: mapped.code,
        message: mapped.message,
      };
    });

  if (
    !timelineResult.ok &&
    timelineResult.code === "NOT_FOUND" &&
    selectedPerson.id !== actor.personId
  ) {
    redirect(kanbanHref({
      personId: actor.personId,
      centerMs: requestedCenter,
      scale: requestedScale,
      personError: true,
    }));
  }

  const baseModel = timelineResult.ok
    ? timeCanvasDataToModel(timelineResult.data.data, "TASK_WORKBENCH")
    : null;
  const model = timelineResult.ok && baseModel
    ? {
        ...baseModel,
        contentRange: timelineResult.data.contentRange,
        fullRange: timelineResult.data.fullRange,
        rangeClipped: timelineResult.data.rangeClipped,
        loadedRanges: [timelineResult.data.loadedRange],
        loadedLeafBlockCounts: [timelineResult.data.leafBlockCount],
        failedRanges: timelineResult.data.failedRanges,
      }
    : null;
  const resolvedCenter = timelineResult.ok
    ? timelineResult.data.resolvedCenterMs
    : requestedCenter;

  return (
    <>
      <PageCommandBar
        title="人员时间线"
        description="选择人员，查看其参与任务的计划与个人投入时间线。"
      />
      <div className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <PersonTimelineFilter
          key={selectedPerson.id}
          selectedPerson={selectedPerson}
        />

        {personError && (
          <p
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            role="status"
          >
            所选人员不存在、已停用或当前不可查看，已切换为当前用户。
          </p>
        )}

        {model ? (
          <ResourcePlannerCanvasClient
            initialModel={model}
            peopleOptions={[selectedPerson]}
            taskOptions={timelineResult.ok ? timelineResult.data.tasks : []}
            defaultPersonId={selectedPerson.id}
            initialZoom={requestedScale}
            initialCenterMs={resolvedCenter}
            mode="PERSONAL_TIMELINE"
            allowCreate={false}
            readOnly
            persistViewportInUrl
            adaptiveBlockQuery={{
              kind: "PERSON_TIMELINE",
              preferredCenterMs: resolvedCenter ?? 0,
              personId: selectedPerson.id,
            }}
          />
        ) : (
          <div
            className="rounded-md border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive"
            role="alert"
          >
            人员时间线加载失败：
            {timelineResult.ok ? "未知错误" : timelineResult.message}
          </div>
        )}
      </div>
    </>
  );
}

function kanbanHref({
  personId,
  centerMs,
  scale,
  personError = false,
}: {
  personId: string;
  centerMs?: number;
  scale?: TimeCanvasZoom;
  personError?: boolean;
}) {
  const search = new URLSearchParams({ people: personId });
  if (Number.isFinite(centerMs)) {
    search.set("center", new Date(centerMs!).toISOString());
  }
  if (scale) search.set("scale", scale.toLowerCase());
  if (personError) search.set("personError", "1");
  return `${routes.progress.kanban}?${search.toString()}`;
}

function parseCenter(value: string) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseScale(value: string): TimeCanvasZoom | undefined {
  const normalized = value.toUpperCase();
  return normalized === "WEEK" ||
      normalized === "MONTH" ||
      normalized === "QUARTER" ||
      normalized === "YEAR"
    ? normalized
    : undefined;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
