"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { projectNavigationItems } from "./project-management-shell";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type PageCommandBarProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  sectionLabel?: string;
  testId?: string;
};

export function PageCommandBar({
  title,
  description,
  actions,
  sectionLabel = "项目管理",
  testId = "project-management-command-bar",
}: PageCommandBarProps) {
  const pathname = usePathname();
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [expandedTitle, setExpandedTitle] = useState<string | null>(null);
  const [overflowingTitle, setOverflowingTitle] = useState<string | null>(null);
  const titleExpanded = expandedTitle === title;
  useEffect(() => {
    const element = titleRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const styles = getComputedStyle(element);
      const lineHeight = Number.parseFloat(styles.lineHeight);
      setOverflowingTitle(element.scrollHeight > lineHeight * 2 + 1 ? title : null);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [title]);
  const section = sectionLabel === "项目管理"
    ? projectNavigationItems(0).find((item) => item.match(pathname))
    : undefined;
  const isDetail = section && pathname !== section.href;
  const locationLabel = pathname.startsWith(`${routes.progress.meetings}/templates/`)
    ? pathname.endsWith("/new") ? "创建会议模板" : "编辑会议模板"
    : pathname.includes("/revisions/")
    ? "计划修订"
    : pathname.endsWith("/edit")
      ? "编辑"
      : pathname.endsWith("/new")
        ? section?.href === routes.progress.projects ? "提交立项" : section?.href === routes.progress.meetings ? "创建会议" : "新建任务"
        : "详情";

  return (
    <header
      className="border-b border-[var(--pm-shell-border)] bg-card"
      data-testid={testId}
    >
      <div className="mx-auto flex min-h-16 w-full min-w-0 max-w-[96rem] flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-start lg:justify-between lg:px-8">
        <div className="min-w-0 flex-1">
          {section ? (
            <nav aria-label="面包屑" className="mb-2 text-xs text-muted-foreground">
              <ol className="flex flex-wrap items-center gap-1.5">
                <li><Link href={routes.progress.root} className="rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">{sectionLabel}</Link></li>
                <li aria-hidden="true"><ChevronRight className="size-3" /></li>
                <li>
                  {isDetail ? (
                    <Link href={section.href} className="rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">{section.label}</Link>
                  ) : <span aria-current="page">{section.label}</span>}
                </li>
                {isDetail && <><li aria-hidden="true"><ChevronRight className="size-3" /></li><li aria-current="page">{locationLabel}</li></>}
              </ol>
            </nav>
          ) : (
            <p className="text-xs font-medium tracking-wide text-muted-foreground">{sectionLabel}</p>
          )}
          <h1
            ref={titleRef}
            id={titleId}
            className={cn("mt-0.5 min-w-0 break-words text-xl font-semibold tracking-tight text-foreground [overflow-wrap:anywhere] sm:text-2xl", !titleExpanded && "line-clamp-2")}
            title={title}
          >
            {title}
          </h1>
          {(overflowingTitle === title || titleExpanded) && (
            <button
              type="button"
              className="mt-1 rounded-sm py-1 text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              aria-controls={titleId}
              aria-expanded={titleExpanded}
              onClick={() => setExpandedTitle(titleExpanded ? null : title)}
            >
              {titleExpanded ? "收起完整标题" : "展开完整标题"}
            </button>
          )}
          {description && (
            <p className="mt-1 max-w-4xl break-words text-sm leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 lg:max-w-[45%]">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}
