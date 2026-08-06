"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  ListChecks,
  Tags,
  LayoutList,
  Clock3,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type ProjectManagementShellProps = {
  unreadCount: number;
  children: ReactNode;
};

type NavigationItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  match(pathname: string): boolean;
  notification?: boolean;
};

const navigationItems: NavigationItem[] = [
  {
    href: routes.progress.root,
    label: "我的工作",
    icon: FolderKanban,
    match: (pathname) => pathname === routes.progress.root,
  },
  {
    href: routes.progress.projects,
    label: "Project",
    icon: FolderKanban,
    match: (pathname) =>
      pathname === routes.progress.projects ||
      pathname.startsWith(`${routes.progress.projects}/`),
  },
  {
    href: routes.progress.tasks,
    label: "Task",
    icon: LayoutList,
    match: (pathname) =>
      pathname === routes.progress.tasks ||
      pathname.startsWith(`${routes.progress.tasks}/`),
  },
  {
    href: routes.progress.myTimeline,
    label: "我的时间",
    icon: Clock3,
    match: (pathname) => pathname === routes.progress.myTimeline,
  },
  {
    href: routes.progress.resources,
    label: "资源计划",
    icon: CalendarRange,
    match: (pathname) => pathname === routes.progress.resources,
  },
  {
    href: routes.progress.approvals,
    label: "待办审批",
    icon: ListChecks,
    match: (pathname) => pathname === routes.progress.approvals,
  },
  {
    href: routes.progress.notifications,
    label: "通知",
    icon: Bell,
    match: (pathname) =>
      pathname === routes.progress.notifications ||
      pathname.startsWith(`${routes.progress.notifications}/`),
    notification: true,
  },
  {
    href: routes.progress.tags,
    label: "Tag",
    icon: Tags,
    match: (pathname) => pathname === routes.progress.tags,
  },
];

export function ProjectManagementShell({
  unreadCount,
  children,
}: ProjectManagementShellProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const currentLabel =
    navigationItems.find((item) => item.match(pathname))?.label ?? "项目管理";

  return (
    <div
      className="flex min-h-[calc(100dvh-3.5rem)] w-full min-w-0 max-w-full overflow-x-clip"
      data-testid="project-management-shell"
    >
      <aside
        aria-label="项目管理侧栏"
        className={cn(
          "pm-shell-motion sticky top-14 hidden h-[calc(100dvh-3.5rem)] shrink-0 flex-col border-r border-[var(--pm-shell-border)] bg-[var(--pm-sidebar-bg)] transition-[width] duration-150 md:flex",
          collapsed ? "w-16" : "w-56",
        )}
        data-state={collapsed ? "collapsed" : "expanded"}
        data-testid="project-management-sidebar"
      >
        <div className="flex h-16 shrink-0 items-center border-b border-[var(--pm-shell-border)] px-3">
          <FolderKanban
            className="size-5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <span
            className={cn(
              "ml-3 min-w-0 truncate font-semibold",
              collapsed && "sr-only",
            )}
          >
            项目管理
          </span>
        </div>

        <ProjectManagementNavigation
          pathname={pathname}
          unreadCount={unreadCount}
          collapsed={collapsed}
        />

        <div className="mt-auto border-t border-[var(--pm-shell-border)] p-3">
          <Button
            type="button"
            variant="ghost"
            className={cn("w-full", collapsed ? "px-0" : "justify-start")}
            aria-label={collapsed ? "展开项目管理导航" : "折叠项目管理导航"}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? (
              <ChevronRight aria-hidden="true" />
            ) : (
              <>
                <ChevronLeft aria-hidden="true" />
                <span>折叠导航</span>
              </>
            )}
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <ProjectManagementMobileNavigation
          key={pathname}
          pathname={pathname}
          currentLabel={currentLabel}
          unreadCount={unreadCount}
        />
        <main className="min-w-0 flex-1" id="project-management-content">
          {children}
        </main>
      </div>
    </div>
  );
}

function ProjectManagementNavigation({
  pathname,
  unreadCount,
  collapsed = false,
  onNavigate,
}: {
  pathname: string;
  unreadCount: number;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav
      aria-label="项目管理导航"
      className="min-w-0 space-y-1 overflow-y-auto p-2"
    >
      {navigationItems.map((item) => {
        const Icon = item.icon;
        const active = item.match(pathname);
        const accessibleLabel =
          item.notification && unreadCount > 0
            ? `${item.label}，${unreadCount} 条未读`
            : item.label;

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            aria-label={accessibleLabel}
            className={cn(
              "group relative flex h-10 min-w-0 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-[var(--pm-nav-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--pm-focus-ring)] motion-reduce:transition-none",
              active &&
                "bg-[var(--pm-nav-active-bg)] text-[var(--pm-nav-active-foreground)]",
              collapsed && "justify-center px-0",
            )}
            onClick={onNavigate}
            title={collapsed ? accessibleLabel : undefined}
          >
            {active && (
              <span
                className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary"
                aria-hidden="true"
              />
            )}
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className={cn("min-w-0 truncate", collapsed && "sr-only")}>
              {item.label}
            </span>
            {item.notification && unreadCount > 0 && (
              <Badge
                variant="secondary"
                className={cn(
                  "ml-auto max-w-14 px-1.5 py-0 text-xs tabular-nums",
                  collapsed &&
                    "absolute right-1 top-1 size-2 min-w-0 overflow-hidden rounded-full border-0 bg-primary p-0 text-transparent",
                )}
                aria-hidden="true"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </Badge>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function ProjectManagementMobileNavigation({
  pathname,
  currentLabel,
  unreadCount,
}: {
  pathname: string;
  currentLabel: string;
  unreadCount: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="sticky top-14 z-30 flex h-14 min-w-0 items-center gap-3 border-b border-[var(--pm-shell-border)] bg-[var(--pm-command-bar-bg)] px-4 md:hidden"
      data-testid="project-management-mobile-bar"
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="打开项目管理导航"
            >
              <Menu aria-hidden="true" />
            </Button>
          }
        />
        <DialogContent
          showCloseButton={false}
          className="inset-y-0 left-0 top-0 h-dvh w-[min(20rem,calc(100vw-2rem))] max-w-none translate-x-0 translate-y-0 content-start gap-0 rounded-none border-r border-[var(--pm-shell-border)] bg-[var(--pm-sidebar-bg)] p-0 motion-reduce:animate-none motion-reduce:transition-none data-open:slide-in-from-left data-closed:slide-out-to-left sm:max-w-none"
          data-testid="project-management-drawer"
        >
          <DialogHeader className="flex-row items-start justify-between gap-3 border-b border-[var(--pm-shell-border)] p-4 text-left">
            <div className="min-w-0">
              <DialogTitle>项目管理导航</DialogTitle>
              <DialogDescription className="mt-1">
                当前页面：{currentLabel}
              </DialogDescription>
            </div>
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="关闭项目管理导航"
                >
                  <X aria-hidden="true" />
                </Button>
              }
            />
          </DialogHeader>
          <ProjectManagementNavigation
            pathname={pathname}
            unreadCount={unreadCount}
            onNavigate={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">项目管理</p>
        <p className="truncate text-sm font-medium" title={currentLabel}>
          {currentLabel}
        </p>
      </div>
    </div>
  );
}
