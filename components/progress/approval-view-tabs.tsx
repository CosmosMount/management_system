"use client";

import Link from "next/link";
import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

type Props = {
  activeView: "pending" | "submitted";
};

const tabs = [
  { key: "pending" as const, label: "待我审批" },
  { key: "submitted" as const, label: "我的申请" },
];

export function ApprovalViewTabs({ activeView }: Props) {
  const tabRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLAnchorElement>, index: number) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + offset + tabs.length) % tabs.length;
    tabRefs.current[nextIndex]?.click();
  }

  return (
    <div
      role="tablist"
      aria-label="审批看板分类"
      className="mb-6 grid min-w-0 gap-2 sm:grid-cols-2"
    >
      {tabs.map((tab, index) => {
        const active = tab.key === activeView;
        return (
          <Link
            key={tab.key}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            href={`/progress/approvals?view=${tab.key}`}
            role="tab"
            id={`approval-${tab.key}-tab`}
            aria-controls={`approval-${tab.key}-panel`}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={(event) => handleKeyDown(event, index)}
            data-testid={`progress-approval-${tab.key}-tab`}
            className={cn(
              "flex h-10 items-center justify-center rounded-lg border px-3 text-sm font-medium transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background hover:bg-muted",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
