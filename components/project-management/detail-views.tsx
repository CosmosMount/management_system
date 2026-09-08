"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const viewChangedEvent = "project-management-detail-view";
const DetailViewActiveContext = createContext(true);

export function useDetailViewActive() {
  return useContext(DetailViewActiveContext);
}

function subscribeToView(callback: () => void) {
  window.addEventListener("popstate", callback);
  window.addEventListener("hashchange", callback);
  window.addEventListener(viewChangedEvent, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener("hashchange", callback);
    window.removeEventListener(viewChangedEvent, callback);
  };
}

export function useDetailView({ initialView, views, hashViews }: {
  initialView: string;
  views: readonly string[];
  hashViews?: Record<string, string>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fallback = views.includes(initialView) ? initialView : views[0];
  const hash = useSyncExternalStore(subscribeToView, () => window.location.hash, () => "");
  const hashView = hashViews?.[hash];
  const requested = searchParams.get("section");
  const view = hashView && views.includes(hashView)
    ? hashView
    : requested && views.includes(requested) ? requested : fallback;
  const selectView = useCallback((value: string) => {
    if (!views.includes(value)) return;
    const url = new URL(window.location.href);
    url.searchParams.set("section", value);
    url.searchParams.delete("focus");
    url.hash = "";
    router.push(`${url.pathname}${url.search}`, { scroll: false });
  }, [router, views]);
  return { view, selectView };
}

export function DetailViewNavigation({ items, view, onSelect, label = "详情分区" }: {
  items: readonly { value: string; label: string }[];
  view: string;
  onSelect: (value: string) => void;
  label?: string;
}) {
  const searchParams = useSearchParams();
  return (
    <nav aria-label={label} className="flex min-w-0 flex-wrap gap-x-6 border-b border-border">
      {items.map((item) => {
        const query = new URLSearchParams(searchParams.toString());
        query.set("section", item.value);
        query.delete("focus");
        return (
          <a
            key={item.value}
            href={`?${query.toString()}`}
            aria-current={view === item.value ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-1 py-3 text-sm font-medium outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring",
              view === item.value ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onSelect(item.value);
            }}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}

export function DetailViewPanel({ value, view, children, className, testId }: {
  value: string;
  view: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const active = value === view;
  const panelRef = useRef<HTMLDivElement>(null);
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  useEffect(() => {
    if (!active || !window.location.hash) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(window.location.hash.slice(1));
      if (target && panelRef.current?.contains(target)) target.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);
  return (
    <div ref={panelRef} hidden={!active} style={active ? undefined : { display: "none" }} className={cn("min-w-0", className)} data-testid={testId}>
      <DetailViewActiveContext value={active}>{(active || visited) && children}</DetailViewActiveContext>
    </div>
  );
}
