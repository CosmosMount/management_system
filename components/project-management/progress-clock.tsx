"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const ProgressClockContext = createContext<number | null>(null);

function useClock(initialNowMs: number, enabled: boolean) {
  const [nowMs, setNowMs] = useState(initialNowMs);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.visibilityState === "visible") setNowMs(Date.now());
    };
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled]);
  return nowMs;
}

export function ProgressClockProvider({ initialNowMs, children }: { initialNowMs: number; children: ReactNode }) {
  const nowMs = useClock(initialNowMs, true);
  return <ProgressClockContext.Provider value={nowMs}>{children}</ProgressClockContext.Provider>;
}

export function useProgressNow() {
  return useContext(ProgressClockContext);
}

export function useCanvasNow(generatedAt: string) {
  const sharedNowMs = useProgressNow();
  const initialNowMs = Date.parse(generatedAt);
  const localNowMs = useClock(Number.isFinite(initialNowMs) ? initialNowMs : 0, sharedNowMs === null);
  return sharedNowMs ?? localNowMs;
}
