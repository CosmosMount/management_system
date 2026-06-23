"use client";

import { useEffect } from "react";

type Props = {
  focus?: string | null;
  fromNotify?: boolean;
};

function resolveFocusTarget(focus?: string | null): string | null {
  if (focus === "approval" || focus === "upload" || focus === "confirm") {
    return focus;
  }
  if (typeof window !== "undefined") {
    const hash = window.location.hash.replace("#", "");
    if (hash === "approval" || hash === "upload" || hash === "confirm") {
      return hash;
    }
  }
  return null;
}

/** 根据 URL ?focus= / #hash 滚动到订单详情对应操作区 */
export function OrderPageFocus({ focus, fromNotify }: Props) {
  useEffect(() => {
    const target = resolveFocusTarget(focus);
    if (!target && !fromNotify) return;

    const id = target ?? "approval";

    function scrollToTarget() {
      const el = document.getElementById(id);
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("ring-2", "ring-primary/40", "rounded-lg");
      window.setTimeout(() => {
        el.classList.remove("ring-2", "ring-primary/40", "rounded-lg");
      }, 2500);
      return true;
    }

    if (scrollToTarget()) return;

    const retry = window.setTimeout(() => {
      scrollToTarget();
    }, 300);
    return () => window.clearTimeout(retry);
  }, [focus, fromNotify]);

  return null;
}
