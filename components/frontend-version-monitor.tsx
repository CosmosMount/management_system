"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  FRONTEND_VERSION, FRONTEND_VERSION_QUERY, FRONTEND_RELOAD_STORAGE_KEY,
  frontendReloadBlocked, frontendReloadUrl, isFrontendVersion,
} from "@/lib/frontend-version";

function hasActiveWork() {
  return !!document.querySelector('[data-live-refresh-lock="true"], [role="dialog"], [role="alertdialog"], [aria-busy="true"]') ||
    !!document.activeElement?.closest("input, textarea, select, [contenteditable='true'], form");
}

export function FrontendVersionMonitor() {
  const pathname = usePathname();
  const loadedVersion = useRef(FRONTEND_VERSION);
  const hasInteraction = useRef(false);
  const interactionRevision = useRef(0);
  const checkRef = useRef<() => Promise<void>>(async () => {});
  const refreshRef = useRef<(version: string) => Promise<void>>(async () => {});
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    hasInteraction.current = false;
  }, [pathname]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const controllers = new Set<AbortController>();
    const interactionEvents = ["input", "change", "submit", "click", "pointerdown", "drop"];
    function markInteraction(event: Event) {
      if (!(event.target instanceof Element) || event.target.closest("[data-frontend-version-controls]")) return;
      if (event.type !== "click" || event.target.closest("button, [role='button'], [role='checkbox'], [role='radio'], [role='switch']")) {
        hasInteraction.current = true;
        interactionRevision.current += 1;
      }
    }
    async function requestVersion(refresh: boolean) {
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetch(`/api/frontend-version?t=${Date.now()}`, {
          method: refresh ? "POST" : "GET",
          cache: "no-store", credentials: "same-origin", signal: controller.signal,
          headers: refresh ? { "x-frontend-version-refresh": "1" } : undefined,
        });
        if (!response.ok || response.redirected || !response.headers.get("content-type")?.includes("application/json")) throw new Error("版本检查暂不可用");
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== "object" || !("version" in payload) || !isFrontendVersion(payload.version)) throw new Error("版本信息无效");
        return payload.version;
      } finally {
        window.clearTimeout(timeout);
        controllers.delete(controller);
      }
    }
    async function refresh(version: string, manual = false) {
      if (inFlight) return;
      inFlight = true;
      const startedAtRevision = interactionRevision.current;
      setRefreshing(true);
      try {
        const confirmedVersion = await requestVersion(true);
        if (!active) return;
        if (confirmedVersion !== version) {
          setPendingVersion(confirmedVersion);
          setMessage("服务器版本正在切换，请稍后再试。");
          return;
        }
        if (interactionRevision.current !== startedAtRevision || (!manual && (document.visibilityState !== "visible" || hasInteraction.current || hasActiveWork()))) {
          setMessage("更新期间检测到操作，已暂停刷新。请先保存内容，再刷新更新。");
          return;
        }
        try { sessionStorage.setItem(FRONTEND_RELOAD_STORAGE_KEY, String(Date.now())); } catch { setMessage("浏览器未允许记录刷新状态，将使用页面版本标记防止重复刷新。"); }
        window.location.replace(frontendReloadUrl(window.location.href, version));
      } catch {
        if (active) setMessage("更新暂不可用，当前页面和输入已保留，请稍后重试。");
      } finally {
        inFlight = false;
        if (active) setRefreshing(false);
      }
    }
    async function check() {
      if (!active || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      let nextVersion: string;
      try {
        nextVersion = await requestVersion(false);
      } catch {
        if (active) setMessage("暂时无法检查更新，请稍后重试。");
        return;
      } finally {
        inFlight = false;
      }
      if (!active) return;
      if (document.visibilityState !== "visible") return;
      if (nextVersion === loadedVersion.current) {
        setPendingVersion(null);
        setMessage("");
        const url = new URL(window.location.href);
        if (url.searchParams.get(FRONTEND_VERSION_QUERY) === loadedVersion.current) {
          url.searchParams.delete(FRONTEND_VERSION_QUERY);
          window.history.replaceState(window.history.state, "", url.toString());
        }
        return;
      }
      setPendingVersion(nextVersion);
      let lastReloadAt: string | null = null;
      try { lastReloadAt = sessionStorage.getItem(FRONTEND_RELOAD_STORAGE_KEY); } catch { lastReloadAt = null; }
      if (frontendReloadBlocked(window.location.href, nextVersion, lastReloadAt, Date.now())) {
        setMessage("已尝试更新，当前页面仍是旧版本。已停止自动重刷，请稍后手动重试。");
      } else if (hasInteraction.current || hasActiveWork()) {
        setMessage("有新版本。为保留当前操作，请先保存内容，再刷新更新。");
      } else {
        await refresh(nextVersion);
      }
    }
    checkRef.current = check;
    refreshRef.current = (version) => refresh(version, true);
    const checkOnReturn = () => { void check(); };
    for (const event of interactionEvents) document.addEventListener(event, markInteraction, true);
    window.addEventListener("focus", checkOnReturn);
    window.addEventListener("pageshow", checkOnReturn);
    document.addEventListener("visibilitychange", checkOnReturn);
    const interval = window.setInterval(checkOnReturn, 60_000);
    void check();
    return () => {
      active = false;
      for (const controller of controllers) controller.abort();
      for (const event of interactionEvents) document.removeEventListener(event, markInteraction, true);
      window.removeEventListener("focus", checkOnReturn);
      window.removeEventListener("pageshow", checkOnReturn);
      document.removeEventListener("visibilitychange", checkOnReturn);
      window.clearInterval(interval);
    };
  }, []);

  return <>
    <footer data-frontend-version-controls className="fixed bottom-1 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center justify-center gap-3 rounded border bg-background/95 px-2 py-1 text-xs text-muted-foreground shadow-sm" aria-label="前端版本">
      <span>前端 v{FRONTEND_VERSION}</span>
      <button type="button" disabled={refreshing} onClick={() => { setDismissedVersion(null); void checkRef.current(); }} className="rounded hover:text-primary focus-visible:outline-2 focus-visible:outline-ring" title={message || "检查前端资源更新"}>检查更新</button>
    </footer>
    {pendingVersion && pendingVersion !== dismissedVersion && <div role="status" data-frontend-version-controls className="fixed right-4 bottom-4 z-60 max-w-[min(26rem,calc(100vw-2rem))] space-y-2 rounded-xl border bg-popover p-4 text-sm text-popover-foreground shadow-lg">
      <p className="font-medium">前端新版本 v{pendingVersion}</p>
      <p>{message || "正在更新前端资源…"}</p>
      <button type="button" disabled={refreshing} className="rounded-lg bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => {
        if ((hasInteraction.current || hasActiveWork()) && !window.confirm("刷新将重新加载页面，请确认已保存当前内容。是否继续？")) return;
        void refreshRef.current(pendingVersion);
      }}>{refreshing ? "正在更新…" : "刷新到新版本"}</button>
      <button type="button" disabled={refreshing} className="ml-3 rounded px-2 py-2 text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setDismissedVersion(pendingVersion)}>稍后更新</button>
    </div>}
  </>;
}
