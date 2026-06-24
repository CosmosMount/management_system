"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { LiveVersionScope } from "@/lib/live-version";

type LiveAutoRefreshProps = {
  scope: LiveVersionScope;
  resourceId?: string;
  initialVersion?: string;
  intervalMs?: number;
  disabled?: boolean;
  pauseWhenEditing?: boolean;
};

const DEFAULT_INTERVAL_MS = 6000;

function isEditingOrDialogOpen(): boolean {
  if (typeof document === "undefined") return false;

  if (document.querySelector("[data-live-refresh-lock='true']")) {
    return true;
  }
  if (document.querySelector("[role='dialog']")) {
    return true;
  }
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return false;
  }

  return !!active.closest(
    "input, textarea, select, [contenteditable='true'], form",
  );
}

function buildVersionUrl(scope: LiveVersionScope, resourceId?: string): string {
  const params = new URLSearchParams({ scope });
  if (resourceId) {
    params.set("resourceId", resourceId);
  }
  return `/api/live-version?${params.toString()}`;
}

export function LiveAutoRefresh({
  scope,
  resourceId,
  initialVersion,
  intervalMs = DEFAULT_INTERVAL_MS,
  disabled = false,
  pauseWhenEditing = true,
}: LiveAutoRefreshProps) {
  const router = useRouter();
  const currentVersionRef = useRef<string | null>(null);
  const pendingVersionRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    currentVersionRef.current = initialVersion ?? null;
    pendingVersionRef.current = null;
    inFlightRef.current = false;

    if (disabled) {
      return () => {
        mountedRef.current = false;
      };
    }

    const url = buildVersionUrl(scope, resourceId);

    async function poll() {
      if (!mountedRef.current || inFlightRef.current) return;
      if (document.visibilityState !== "visible") return;

      if (
        pauseWhenEditing &&
        pendingVersionRef.current &&
        isEditingOrDialogOpen()
      ) {
        return;
      }

      if (pauseWhenEditing && pendingVersionRef.current) {
        currentVersionRef.current = pendingVersionRef.current;
        pendingVersionRef.current = null;
        router.refresh();
        return;
      }

      inFlightRef.current = true;
      try {
        const response = await fetch(url, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) return;
        if (response.redirected) return;
        if (!response.headers.get("content-type")?.includes("application/json")) {
          return;
        }
        const payload = (await response.json()) as { version?: string };
        if (!mountedRef.current) return;
        const nextVersion = payload.version;
        if (!nextVersion) return;

        if (!currentVersionRef.current) {
          currentVersionRef.current = nextVersion;
          return;
        }
        if (nextVersion === currentVersionRef.current) {
          pendingVersionRef.current = null;
          return;
        }

        if (pauseWhenEditing && isEditingOrDialogOpen()) {
          pendingVersionRef.current = nextVersion;
          return;
        }

        currentVersionRef.current = nextVersion;
        pendingVersionRef.current = null;
        router.refresh();
      } catch (error) {
        if (process.env.NODE_ENV === "development") {
          console.debug("[live-refresh] polling failed", error);
        }
      } finally {
        inFlightRef.current = false;
      }
    }

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, intervalMs);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    disabled,
    initialVersion,
    intervalMs,
    pauseWhenEditing,
    resourceId,
    router,
    scope,
  ]);

  return null;
}
