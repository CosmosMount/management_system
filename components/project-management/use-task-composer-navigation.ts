"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

export const TASK_COMPOSER_HISTORY_BACK = "__HISTORY_BACK__";

export function useTaskComposerNavigation({
  cleanDraftCleanupError,
  currentFingerprint,
  dirty,
  router,
  setBaselineFingerprint,
  setStatusMessage,
  storageBusy,
  submitting,
}: {
  cleanDraftCleanupError: boolean;
  currentFingerprint: string;
  dirty: boolean;
  router: { replace: (destination: string) => void };
  setBaselineFingerprint: Dispatch<SetStateAction<string>>;
  setStatusMessage: Dispatch<SetStateAction<string>>;
  storageBusy: boolean;
  submitting: boolean;
}) {
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  const [historyGuardActive, setHistoryGuardActive] = useState(false);
  const historyGuardRef = useRef(false);
  const bypassPopStateRef = useRef(false);
  const bypassBeforeUnloadRef = useRef(false);
  const wasDirtyRef = useRef(false);
  const preserveDraftOnNavigationRef = useRef(false);

  const replaceAfterCollapsingHistoryGuard = useCallback(
    (destination: string) => {
      setPendingNavigation(null);
      setBaselineFingerprint(currentFingerprint);
      if (!historyGuardRef.current) {
        setHistoryGuardActive(false);
        router.replace(destination);
        return;
      }
      const finishNavigation = () => {
        historyGuardRef.current = false;
        setHistoryGuardActive(false);
        bypassBeforeUnloadRef.current = true;
        window.location.replace(destination);
      };
      window.addEventListener("popstate", finishNavigation, { once: true });
      bypassPopStateRef.current = true;
      window.history.back();
    },
    [currentFingerprint, router, setBaselineFingerprint],
  );

  useEffect(() => {
    if ((!dirty && !historyGuardActive) || submitting) return;
    if (dirty && !historyGuardRef.current) {
      const currentHistoryState = window.history.state as {
        taskComposerGuard?: boolean;
      } | null;
      if (currentHistoryState?.taskComposerGuard !== true) {
        window.history.pushState(
          { ...(currentHistoryState ?? {}), taskComposerGuard: true },
          "",
          window.location.href,
        );
      }
      historyGuardRef.current = true;
      setHistoryGuardActive(true);
    }
    const shouldBlockUnload =
      dirty ||
      storageBusy ||
      cleanDraftCleanupError ||
      (wasDirtyRef.current && !preserveDraftOnNavigationRef.current);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (bypassBeforeUnloadRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const interceptLinks = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      const url = new URL(link.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        url.href === window.location.href
      ) {
        return;
      }
      event.preventDefault();
      if (
        storageBusy ||
        cleanDraftCleanupError ||
        (!dirty &&
          wasDirtyRef.current &&
          !preserveDraftOnNavigationRef.current)
      ) {
        setStatusMessage("请先等待或重试清理旧本地草稿。");
        return;
      }
      const destination = `${url.pathname}${url.search}${url.hash}`;
      if (dirty) {
        setPendingNavigation(destination);
      } else {
        replaceAfterCollapsingHistoryGuard(destination);
      }
    };
    const interceptHistory = () => {
      if (bypassPopStateRef.current) {
        bypassPopStateRef.current = false;
        return;
      }
      if (
        storageBusy ||
        cleanDraftCleanupError ||
        (!dirty &&
          wasDirtyRef.current &&
          !preserveDraftOnNavigationRef.current)
      ) {
        window.history.pushState(
          { ...(window.history.state ?? {}), taskComposerGuard: true },
          "",
          window.location.href,
        );
        historyGuardRef.current = true;
        setStatusMessage("请先等待或重试清理旧本地草稿。");
        return;
      }
      if (!dirty) {
        historyGuardRef.current = false;
        setHistoryGuardActive(false);
        bypassPopStateRef.current = true;
        window.history.back();
        return;
      }
      window.history.pushState(
        { ...(window.history.state ?? {}), taskComposerGuard: true },
        "",
        window.location.href,
      );
      historyGuardRef.current = true;
      setPendingNavigation(TASK_COMPOSER_HISTORY_BACK);
    };
    if (shouldBlockUnload) window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("popstate", interceptHistory);
    document.addEventListener("click", interceptLinks, true);
    return () => {
      if (shouldBlockUnload) {
        window.removeEventListener("beforeunload", beforeUnload);
      }
      window.removeEventListener("popstate", interceptHistory);
      document.removeEventListener("click", interceptLinks, true);
    };
  }, [
    cleanDraftCleanupError,
    dirty,
    historyGuardActive,
    replaceAfterCollapsingHistoryGuard,
    setStatusMessage,
    storageBusy,
    submitting,
  ]);

  return {
    bypassBeforeUnloadRef,
    bypassPopStateRef,
    historyGuardRef,
    pendingNavigation,
    preserveDraftOnNavigationRef,
    replaceAfterCollapsingHistoryGuard,
    setPendingNavigation,
    setHistoryGuardActive,
    wasDirtyRef,
  };
}
