"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Crosshair, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  listAdminGlobalTimeMarkers,
  saveAdminGlobalTimeMarkers,
} from "@/app/actions/adminGlobalTimeMarkers";
import { TimeCanvas } from "@/components/project-management/time-canvas/time-canvas";
import type {
  TimeCanvasGlobalMarker,
  TimeCanvasModel,
} from "@/components/project-management/time-canvas/types";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getActionErrorMessage } from "@/lib/action-error-message";
import {
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "@/lib/project-management/date-time";
import type {
  GlobalTimeMarkerCollectionDto,
} from "@/lib/project-management/global-time-markers";
import {
  MAX_GLOBAL_TIME_MARKERS,
  MAX_GLOBAL_TIME_MARKER_NAME_LENGTH,
} from "@/lib/project-management/validations/global-time-markers";
import {
  clampLogicalRangeToThreeYears,
  contentTimeBounds,
  padShanghaiCalendarRange,
} from "@/components/project-management/time-canvas/time-math";

type DraftMarker = {
  id: string;
  name: string;
  markedAtLocal: string;
  versionToken: string | null;
};

export function AdminGlobalTimeMarkersPanel({
  initialCollection,
  initialNow,
}: {
  initialCollection: GlobalTimeMarkerCollectionDto;
  initialNow: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const historyGuardRef = useRef(false);
  const bypassHistoryRef = useRef(false);
  const bypassBeforeUnloadRef = useRef(false);
  const [drafts, setDrafts] = useState(() => draftsFromCollection(initialCollection));
  const [baselineVersion, setBaselineVersion] = useState(
    initialCollection.collectionVersion,
  );
  const [baselineSignature, setBaselineSignature] = useState(() =>
    draftSignature(draftsFromCollection(initialCollection)),
  );
  const [conflictCollection, setConflictCollection] =
    useState<GlobalTimeMarkerCollectionDto | null>(null);
  const [center, setCenter] = useState<{ atMs: number; revision: number } | null>(
    null,
  );
  const [validationRevealed, setValidationRevealed] = useState(false);
  const dirty = draftSignature(drafts) !== baselineSignature;
  const hasInvalidDraft = drafts.some((marker) =>
    !marker.name.trim() ||
    !Number.isFinite(
      Date.parse(shanghaiDateTimeLocalToIso(marker.markedAtLocal)),
    )
  );
  const externalConflict =
    initialCollection.collectionVersion !== baselineVersion ||
    (conflictCollection !== null &&
      conflictCollection.collectionVersion !== baselineVersion);

  useEffect(() => {
    if (!dirty) {
      if (historyGuardRef.current) {
        historyGuardRef.current = false;
        bypassHistoryRef.current = true;
        window.addEventListener(
          "popstate",
          () => {
            bypassHistoryRef.current = false;
          },
          { once: true },
        );
        window.history.back();
      }
      return;
    }
    if (!historyGuardRef.current) {
      window.history.pushState(
        { ...(window.history.state ?? {}), adminTimeMarkerGuard: true },
        "",
        window.location.href,
      );
      historyGuardRef.current = true;
    }
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (bypassBeforeUnloadRef.current) return;
      event.preventDefault();
    };
    const interceptLink = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank") {
        return;
      }
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.href === window.location.href) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (pending) {
        toast.info("正在保存关键时间点，请稍候");
        return;
      }
      if (!window.confirm("关键时间点还有未保存的修改，确认离开？")) return;
      const destination = `${url.pathname}${url.search}${url.hash}`;
      bypassBeforeUnloadRef.current = true;
      if (!historyGuardRef.current) {
        window.location.assign(destination);
        return;
      }
      window.addEventListener(
        "popstate",
        () => window.location.assign(destination),
        { once: true },
      );
      historyGuardRef.current = false;
      bypassHistoryRef.current = true;
      window.history.back();
    };
    const interceptHistory = () => {
      if (bypassHistoryRef.current) {
        bypassHistoryRef.current = false;
        return;
      }
      if (pending) {
        window.history.pushState(
          { ...(window.history.state ?? {}), adminTimeMarkerGuard: true },
          "",
          window.location.href,
        );
        historyGuardRef.current = true;
        toast.info("正在保存关键时间点，请稍候");
        return;
      }
      if (window.confirm("关键时间点还有未保存的修改，确认离开？")) {
        bypassBeforeUnloadRef.current = true;
        historyGuardRef.current = false;
        bypassHistoryRef.current = true;
        window.history.back();
        return;
      }
      window.history.pushState(
        { ...(window.history.state ?? {}), adminTimeMarkerGuard: true },
        "",
        window.location.href,
      );
      historyGuardRef.current = true;
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    window.addEventListener("popstate", interceptHistory);
    document.addEventListener("click", interceptLink, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      window.removeEventListener("popstate", interceptHistory);
      document.removeEventListener("click", interceptLink, true);
    };
  }, [dirty, pending]);

  const canvasModel = useMemo(
    () =>
      buildAdminMarkerCanvasModel(
        drafts,
        Date.parse(initialNow),
        center?.atMs,
        !pending,
      ),
    [center?.atMs, drafts, initialNow, pending],
  );

  function updateDraft(id: string, patch: Partial<DraftMarker>) {
    setDrafts((current) =>
      current.map((marker) =>
        marker.id === id ? { ...marker, ...patch } : marker,
      ),
    );
  }

  function addMarker() {
    if (drafts.length >= MAX_GLOBAL_TIME_MARKERS) {
      toast.error(`关键时间点不能超过 ${MAX_GLOBAL_TIME_MARKERS} 个`);
      return;
    }
    const id = crypto.randomUUID();
    const markedAtLocal = isoToShanghaiDateTimeLocal(new Date());
    setDrafts((current) => [
      ...current,
      { id, name: "", markedAtLocal, versionToken: null },
    ]);
    requestCenter(Date.parse(shanghaiDateTimeLocalToIso(markedAtLocal)));
  }

  function requestCenter(atMs: number) {
    if (!Number.isFinite(atMs)) return;
    setCenter((current) => ({ atMs, revision: (current?.revision ?? 0) + 1 }));
  }

  function discardAndReload() {
    const authoritative = conflictCollection ?? initialCollection;
    const next = draftsFromCollection(authoritative);
    setDrafts(next);
    setBaselineVersion(authoritative.collectionVersion);
    setBaselineSignature(draftSignature(next));
    setConflictCollection(null);
    setValidationRevealed(false);
    router.refresh();
  }

  function saveAll() {
    if (hasInvalidDraft) {
      setValidationRevealed(true);
      const invalid = drafts.find((marker) =>
        !marker.name.trim() ||
        !Number.isFinite(Date.parse(shanghaiDateTimeLocalToIso(marker.markedAtLocal))),
      );
      if (invalid) {
        const field = invalid.name.trim() ? "time" : "name";
        requestAnimationFrame(() => document.getElementById(`marker-${field}-${invalid.id}`)?.focus());
      }
      return;
    }
    startTransition(async () => {
      try {
        const result = await saveAdminGlobalTimeMarkers({
          expectedCollectionVersion: baselineVersion,
          markers: drafts.map((marker) => ({
            id: marker.id,
            name: marker.name,
            markedAt: shanghaiDateTimeLocalToIso(marker.markedAtLocal),
            versionToken: marker.versionToken,
          })),
        });
        const next = draftsFromCollection(result);
        setDrafts(next);
        setBaselineVersion(result.collectionVersion);
        setBaselineSignature(draftSignature(next));
        setConflictCollection(null);
        setValidationRevealed(false);
        toast.success("关键时间点已保存");
        router.refresh();
      } catch (error) {
        toast.error(getActionErrorMessage(error, "关键时间点保存失败"));
        try {
          const latest = await listAdminGlobalTimeMarkers();
          if (latest.collectionVersion !== baselineVersion) {
            setConflictCollection(latest);
          }
        } catch (refreshError) {
          toast.error(
            getActionErrorMessage(refreshError, "无法获取最新关键时间点"),
          );
        }
      }
    });
  }

  return (
    <div
      className="min-w-0 space-y-6"
      data-live-refresh-lock={dirty ? "true" : "false"}
      data-testid="admin-global-time-markers"
    >
      {externalConflict && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          role="alert"
        >
          <span className="min-w-0 flex-1">
            关键时间点已被其他管理员修改。当前草稿尚未覆盖服务端数据。
          </span>
          <Button type="button" size="sm" variant="outline" onClick={discardAndReload}>
            放弃草稿并重新加载
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>关键时间点时间线</CardTitle>
          <CardDescription>
            时间点会显示在全部项目管理时间线上。拖动只修改当前草稿，点击“保存全部”后才会生效；拖动按上海自然日调整，精确时分可在下方输入。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="min-w-0 overflow-hidden rounded-lg border border-border">
            <TimeCanvas
              mode="ADMIN_TIME_MARKERS"
              model={canvasModel}
              initialCenterMs={center?.atMs}
              initialCenterRevision={center?.revision ?? 0}
              display={{ showActual: false, showBusy: false, showInspector: false }}
              navigationRange={canvasModel.fullRange}
              onRequestCenter={requestCenter}
              interaction={pending
                ? undefined
                : {
                    onGlobalMarkerMove: ({ markerId, atMs }) => {
                      updateDraft(markerId, {
                        markedAtLocal: isoToShanghaiDateTimeLocal(new Date(atMs)),
                      });
                    },
                    onInvalidDrop: (message) => toast.error(message),
                  }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle>时间点设置</CardTitle>
            <CardDescription>
              已配置 {drafts.length}/{MAX_GLOBAL_TIME_MARKERS} 个。允许多个时间点使用相同日期。
            </CardDescription>
          </div>
          <Button type="button" size="sm" disabled={pending} onClick={addMarker}>
            <Plus aria-hidden="true" />新增时间点
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {drafts.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              尚未配置关键时间点。
            </p>
          ) : (
            <div className="space-y-3">
              {drafts.map((marker, index) => {
                const parsedAt = Date.parse(
                  shanghaiDateTimeLocalToIso(marker.markedAtLocal),
                );
                const nameInvalid = validationRevealed && marker.name.trim().length === 0;
                const timeInvalid = validationRevealed && !Number.isFinite(parsedAt);
                return (
                  <div
                    key={marker.id}
                    className="grid min-w-0 gap-3 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(13rem,0.65fr)_auto] md:items-end"
                    data-testid={`global-time-marker-editor-${marker.id}`}
                  >
                    <div className="min-w-0 space-y-1.5">
                      <Label htmlFor={`marker-name-${marker.id}`}>
                        名称 {index + 1}
                      </Label>
                      <Input
                        id={`marker-name-${marker.id}`}
                        value={marker.name}
                        maxLength={MAX_GLOBAL_TIME_MARKER_NAME_LENGTH}
                        aria-invalid={nameInvalid}
                        aria-describedby={nameInvalid ? `marker-name-${marker.id}-error` : undefined}
                        placeholder="例如：报名截止"
                        disabled={pending}
                        onFocus={() => requestCenter(parsedAt)}
                        onChange={(event) =>
                          updateDraft(marker.id, { name: event.target.value })
                        }
                      />
                      <FieldError id={`marker-name-${marker.id}-error`} messages={nameInvalid ? "请输入关键时间点名称" : undefined} className="text-xs" />
                    </div>
                    <div className="min-w-0 space-y-1.5">
                      <Label htmlFor={`marker-time-${marker.id}`}>时间（上海）</Label>
                      <Input
                        id={`marker-time-${marker.id}`}
                        type="datetime-local"
                        step={60}
                        value={marker.markedAtLocal}
                        aria-invalid={timeInvalid}
                        aria-describedby={timeInvalid ? `marker-time-${marker.id}-error` : undefined}
                        disabled={pending}
                        onFocus={() => requestCenter(parsedAt)}
                        onChange={(event) =>
                          updateDraft(marker.id, {
                            markedAtLocal: event.target.value,
                          })
                        }
                      />
                      <FieldError id={`marker-time-${marker.id}-error`} messages={timeInvalid ? "请选择关键时间点时间" : undefined} className="text-xs" />
                    </div>
                    <div className="flex flex-wrap gap-2 md:justify-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending || !Number.isFinite(parsedAt)}
                        onClick={() => requestCenter(parsedAt)}
                        aria-label={`在时间线定位 ${marker.name || `时间点 ${index + 1}`}`}
                      >
                        <Crosshair aria-hidden="true" />定位
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() =>
                          setDrafts((current) =>
                            current.filter((item) => item.id !== marker.id),
                          )
                        }
                        aria-label={`暂存删除 ${marker.name || `时间点 ${index + 1}`}`}
                      >
                        <Trash2 aria-hidden="true" />删除
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
            {dirty && <span className="mr-auto text-sm text-amber-700">有未保存修改</span>}
            <Button
              type="button"
              disabled={pending || !dirty}
              onClick={saveAll}
            >
              <Save aria-hidden="true" />
              {pending ? "正在保存…" : "保存全部"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function draftsFromCollection(
  collection: GlobalTimeMarkerCollectionDto,
): DraftMarker[] {
  return collection.markers.map((marker) => ({
    id: marker.id,
    name: marker.name,
    markedAtLocal: isoToShanghaiDateTimeLocal(marker.markedAt),
    versionToken: marker.versionToken,
  }));
}

function draftSignature(drafts: DraftMarker[]) {
  return JSON.stringify(
    drafts.map((marker) => [
      marker.id,
      marker.name,
      marker.markedAtLocal,
      marker.versionToken,
    ]),
  );
}

function buildAdminMarkerCanvasModel(
  drafts: DraftMarker[],
  initialNowMs: number,
  preferredCenterMs: number | undefined,
  editable: boolean,
): TimeCanvasModel {
  const globalMarkers: TimeCanvasGlobalMarker[] = drafts.flatMap((marker) => {
    const atMs = Date.parse(shanghaiDateTimeLocalToIso(marker.markedAtLocal));
    if (!Number.isFinite(atMs)) return [];
    return [{
      id: marker.id,
      label: marker.name.trim() || "未命名时间点",
      atMs,
      editable,
      versionToken: marker.versionToken,
    }];
  });
  const now = Number.isFinite(initialNowMs) ? initialNowMs : 0;
  const contentRange = contentTimeBounds([
    now,
    ...globalMarkers.map((marker) => marker.atMs),
  ]);
  const fullRange = padShanghaiCalendarRange(contentRange, 2, now);
  const logical = clampLogicalRangeToThreeYears(
    fullRange,
    Number.isFinite(preferredCenterMs) ? (preferredCenterMs ?? now) : now,
  );
  return {
    timezone: "Asia/Shanghai",
    range: logical.range,
    fullRange,
    contentRange,
    rangeClipped: logical.clipped,
    rows: [],
    anchors: [],
    globalMarkers,
    segments: [],
    generatedAt: new Date(now).toISOString(),
  };
}
