"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { activateTask } from "@/app/actions/project-management/tasks";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/routes";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function TaskDraftLeavePrompt({ taskId, lockVersion, enabled }: {
  taskId: string;
  lockVersion: number;
  enabled: boolean;
}) {
  const [destination, setDestination] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef(false);
  const bypassRef = useRef(false);
  const guardedRef = useRef(false);
  const searchParams = useSearchParams();

  useEffect(() => {
    const sourceUrl = window.location.href;
    const sourceState = window.history.state;
    if (enabled && !guardedRef.current) {
      if (window.history.state?.taskDraftLeaveGuard !== taskId) {
        window.history.replaceState({ ...window.history.state, taskDraftLeaveBase: taskId }, "", window.location.href);
        window.history.pushState({ ...window.history.state, taskDraftLeaveBase: null, taskDraftLeaveGuard: taskId }, "", window.location.href);
      }
      guardedRef.current = true;
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!enabled || bypassRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const interceptLink = (event: MouseEvent) => {
      if (!enabled || bypassRef.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.download || (link.target && link.target !== "_self")) return;
      const url = new URL(link.href, window.location.href);
      if (!["http:", "https:"].includes(url.protocol) || (url.origin === window.location.origin && url.pathname === window.location.pathname)) return;
      if (url.origin === window.location.origin && url.pathname === routes.progress.taskEdit(taskId)) return;
      event.preventDefault();
      event.stopPropagation();
      if (pendingRef.current) return;
      setError(null);
      setDestination(url.href);
    };
    const interceptHistory = (event: PopStateEvent) => {
      if (bypassRef.current || !guardedRef.current) return;
      if (window.history.state?.taskDraftLeaveBase !== taskId && window.location.pathname === new URL(sourceUrl).pathname) return;
      event.stopImmediatePropagation();
      if (!enabled) {
        guardedRef.current = false;
        window.history.back();
        return;
      }
      window.history.pushState({ ...sourceState, taskDraftLeaveBase: null, taskDraftLeaveGuard: taskId }, "", sourceUrl);
      if (!pendingRef.current) {
        setError(null);
        setDestination("back");
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", interceptHistory, true);
    document.addEventListener("click", interceptLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("popstate", interceptHistory, true);
      document.removeEventListener("click", interceptLink, true);
    };
  }, [enabled, taskId, searchParams]);

  const leave = () => {
    if (!destination) return;
    pendingRef.current = true;
    setBusy(true);
    bypassRef.current = true;
    if (destination === "back") {
      window.history.go(guardedRef.current ? -2 : -1);
    } else if (guardedRef.current) {
      window.addEventListener("popstate", () => window.location.replace(destination), { once: true });
      window.history.back();
    } else {
      window.location.assign(destination);
    }
  };
  const activateAndLeave = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await activateTask({ taskId, expectedLockVersion: lockVersion });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      leave();
    } catch {
      setError("激活结果暂时无法确认，请留在任务详情刷新查看最新状态。");
    } finally {
      if (!bypassRef.current) {
        pendingRef.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <Dialog open={enabled && destination !== null} onOpenChange={(open) => { if (!open && !pendingRef.current) setDestination(null); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>离开前激活任务？</DialogTitle>
          <DialogDescription>当前任务仍为草稿。是否立即激活后离开？激活后计划变更需通过计划修订。</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setDestination(null)}>留在当前页</Button>
          <Button variant="outline" disabled={busy} onClick={leave}>暂不激活，继续离开</Button>
          <Button disabled={busy} onClick={() => void activateAndLeave()}>{busy ? "正在激活…" : "激活并离开"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
