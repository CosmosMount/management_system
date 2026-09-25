"use client";

import { useCallback, useEffect, useState, type TransitionStartFunction } from "react";
import {
  getWorkSegment,
  listWorkSegmentChanges,
} from "@/app/actions/project-management/segments";
import type { SegmentChange } from "@/components/project-management/resource-planner-panels";
import type { TimeCanvasModel, TimeCanvasRange } from "@/components/project-management/time-canvas/types";
import type { WorkSegmentDetail } from "@/lib/project-management/queries/resource-queries";

type LoadState = "IDLE" | "LOADING" | "READY" | "ERROR";

export function useResourcePlannerInspector({
  segmentId,
  segment,
  isPending,
  startTransition,
}: {
  segmentId: string | null;
  segment: TimeCanvasModel["segments"][number] | null;
  isPending: boolean;
  startTransition: TransitionStartFunction;
}) {
  const [detail, setDetail] = useState<WorkSegmentDetail | null>(null);
  const [detailRange, setDetailRange] = useState<TimeCanvasRange | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("IDLE");
  const [detailError, setDetailError] = useState("");
  const [detailRetryToken, setDetailRetryToken] = useState(0);
  const [changes, setChanges] = useState<SegmentChange[]>([]);
  const [changesCursor, setChangesCursor] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState<LoadState>(segmentId ? "LOADING" : "IDLE");
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyRetryToken, setHistoryRetryToken] = useState(0);

  const reset = useCallback((hasSegment: boolean) => {
    setDetail(null);
    setDetailRange(null);
    setDetailError("");
    setDetailState(hasSegment ? "LOADING" : "IDLE");
    setChanges([]);
    setChangesCursor(null);
    setHistoryState(hasSegment ? "LOADING" : "IDLE");
    setHistoryLoadingMore(false);
    setHistoryError("");
  }, []);

  const refreshStale = useCallback(() => {
    reset(true);
    setDetailRetryToken((current) => current + 1);
    setHistoryRetryToken((current) => current + 1);
  }, [reset]);

  useEffect(() => {
    if (!segmentId || !segment || segment.visibility !== "FULL") return;
    let active = true;
    void getWorkSegment({ segmentId })
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setDetail(null);
          setDetailError(result.error.message);
          setDetailState("ERROR");
          return;
        }
        setDetail(result.data);
        setDetailRange({
          startMs: Date.parse(result.data.startAt),
          endMs: Date.parse(result.data.endAt),
        });
        setDetailState("READY");
      })
      .catch(() => {
        if (!active) return;
        setDetail(null);
        setDetailError("网络异常，请稍后重试。");
        setDetailState("ERROR");
      });
    return () => { active = false; };
  }, [detailRetryToken, segment, segmentId]);

  useEffect(() => {
    if (!segmentId || !segment || segment.visibility !== "FULL") return;
    let active = true;
    void listWorkSegmentChanges({ segmentId, limit: 20 })
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setChanges([]);
          setChangesCursor(null);
          setHistoryState("ERROR");
          setHistoryError(result.error.message);
          return;
        }
        setChanges(result.data.items);
        setChangesCursor(result.data.nextCursor);
        setHistoryState("READY");
        setHistoryError("");
      })
      .catch(() => {
        if (!active) return;
        setChanges([]);
        setChangesCursor(null);
        setHistoryState("ERROR");
        setHistoryError("网络异常，请稍后重试。");
      });
    return () => { active = false; };
  }, [historyRetryToken, segment, segmentId]);

  const loadMoreChanges = useCallback(() => {
    if (!segmentId || !changesCursor || isPending || historyLoadingMore) return;
    setHistoryLoadingMore(true);
    setHistoryError("");
    startTransition(async () => {
      try {
        const result = await listWorkSegmentChanges({
          segmentId,
          cursor: changesCursor,
          limit: 20,
        });
        if (!result.ok) {
          setHistoryState("ERROR");
          setHistoryError(result.error.message);
          return;
        }
        setChanges((current) => {
          const seen = new Set(current.map((change) => change.key));
          return [...current, ...result.data.items.filter((change) => !seen.has(change.key))];
        });
        setChangesCursor(result.data.nextCursor);
        setHistoryState("READY");
      } catch {
        setHistoryState("ERROR");
        setHistoryError("网络异常，请稍后重试。");
      } finally {
        setHistoryLoadingMore(false);
      }
    });
  }, [changesCursor, historyLoadingMore, isPending, segmentId, startTransition]);

  const retryDetail = useCallback(() => {
    setDetailError("");
    setDetailState("LOADING");
    setDetailRetryToken((current) => current + 1);
  }, []);

  const retryHistory = useCallback(() => {
    if (changes.length > 0 && changesCursor) {
      loadMoreChanges();
      return;
    }
    setHistoryState("LOADING");
    setHistoryError("");
    setHistoryRetryToken((current) => current + 1);
  }, [changes.length, changesCursor, loadMoreChanges]);

  return {
    detail,
    detailRange,
    detailState,
    detailError,
    changes,
    historyState,
    historyLoadingMore,
    historyError,
    hasMoreChanges: Boolean(changesCursor),
    reset,
    refreshStale,
    loadMoreChanges,
    retryDetail,
    retryHistory,
    setDetailRange,
  };
}
