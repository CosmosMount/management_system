"use client";

import { useEffect, useRef } from "react";

export function useMeetingUnsavedChanges(dirty: boolean, message: string) {
  const saved = useRef(false);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (dirty && !saved.current) event.preventDefault(); }
    function interceptLink(event: MouseEvent) {
      if (!dirty || saved.current || event.defaultPrevented || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (target && !window.confirm(message)) { event.preventDefault(); event.stopPropagation(); }
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", interceptLink, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", interceptLink, true); };
  }, [dirty, message]);
  return saved;
}
