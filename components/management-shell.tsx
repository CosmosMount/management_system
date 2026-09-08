"use client";

import { Fragment, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
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
import { cn } from "@/lib/utils";

export type ManagementNavigationItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  match(pathname: string): boolean;
  badgeCount?: number;
  group?: string;
};

type ManagementShellProps = {
  title: string;
  icon: LucideIcon;
  navigationItems: ManagementNavigationItem[];
  testIdPrefix: string;
  children: ReactNode;
};

export function ManagementShell({
  title,
  icon: ShellIcon,
  navigationItems,
  testIdPrefix,
  children,
}: ManagementShellProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const currentLabel =
    navigationItems.find((item) => item.match(pathname))?.label ?? title;

  return (
    <div
      className="flex min-h-[calc(100dvh-3.5rem)] w-full min-w-0 max-w-full overflow-x-clip"
      data-testid={`${testIdPrefix}-shell`}
    >
      <aside
        aria-label={`${title}侧栏`}
        className={cn(
          "pm-shell-motion sticky top-14 hidden h-[calc(100dvh-3.5rem)] shrink-0 flex-col border-r border-[var(--pm-shell-border)] bg-[var(--pm-sidebar-bg)] transition-[width] duration-150 md:flex",
          collapsed ? "w-16" : "w-56",
        )}
        data-state={collapsed ? "collapsed" : "expanded"}
        data-testid={`${testIdPrefix}-sidebar`}
      >
        <div className="flex h-16 shrink-0 items-center border-b border-[var(--pm-shell-border)] px-3">
          <ShellIcon
            className="size-5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <span
            className={cn(
              "ml-3 min-w-0 truncate font-semibold",
              collapsed && "sr-only",
            )}
          >
            {title}
          </span>
        </div>

        <ManagementNavigation
          title={title}
          pathname={pathname}
          navigationItems={navigationItems}
          collapsed={collapsed}
        />

        <div className="mt-auto border-t border-[var(--pm-shell-border)] p-3">
          <Button
            type="button"
            variant="ghost"
            className={cn("w-full", collapsed ? "px-0" : "justify-start")}
            aria-label={collapsed ? `展开${title}导航` : `折叠${title}导航`}
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
        <ManagementMobileNavigation
          key={pathname}
          title={title}
          pathname={pathname}
          currentLabel={currentLabel}
          navigationItems={navigationItems}
          testIdPrefix={testIdPrefix}
        />
        <main className="min-w-0 flex-1" id={`${testIdPrefix}-content`}>
          {children}
        </main>
      </div>
    </div>
  );
}

function ManagementNavigation({
  title,
  pathname,
  navigationItems,
  collapsed = false,
  onNavigate,
}: {
  title: string;
  pathname: string;
  navigationItems: ManagementNavigationItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav
      aria-label={`${title}导航`}
      className="min-w-0 space-y-1 overflow-y-auto p-2"
    >
      {navigationItems.map((item, index) => {
        const Icon = item.icon;
        const active = item.match(pathname);
        const badgeCount = item.badgeCount ?? 0;
        const accessibleLabel =
          badgeCount > 0
            ? `${item.label}，${badgeCount} 条未读`
            : item.label;

        return (
          <Fragment key={item.href}>
            {item.group && item.group !== navigationItems[index - 1]?.group && (
              <div className={cn("px-3 pb-2 pt-5 first:pt-3", collapsed && "px-1")}>
                <p className={cn("text-xs font-medium text-muted-foreground", collapsed && "sr-only")}>
                  {item.group}
                </p>
                {collapsed && <div className="border-t border-border" aria-hidden="true" />}
              </div>
            )}
          <Link
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
            {badgeCount > 0 && (
              <Badge
                variant="secondary"
                className={cn(
                  "ml-auto max-w-14 px-1.5 py-0 text-xs tabular-nums",
                  collapsed &&
                    "absolute right-1 top-1 size-2 min-w-0 overflow-hidden rounded-full border-0 bg-primary p-0 text-transparent",
                )}
                aria-hidden="true"
              >
                {badgeCount > 99 ? "99+" : badgeCount}
              </Badge>
            )}
          </Link>
          </Fragment>
        );
      })}
    </nav>
  );
}

function ManagementMobileNavigation({
  title,
  pathname,
  currentLabel,
  navigationItems,
  testIdPrefix,
}: {
  title: string;
  pathname: string;
  currentLabel: string;
  navigationItems: ManagementNavigationItem[];
  testIdPrefix: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="sticky top-14 z-30 flex h-14 min-w-0 items-center gap-3 border-b border-[var(--pm-shell-border)] bg-[var(--pm-command-bar-bg)] px-4 md:hidden"
      data-testid={`${testIdPrefix}-mobile-bar`}
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`打开${title}导航`}
            >
              <Menu aria-hidden="true" />
            </Button>
          }
        />
        <DialogContent
          showCloseButton={false}
          className="inset-y-0 left-0 top-0 flex h-dvh w-[min(20rem,calc(100vw-2rem))] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-r border-[var(--pm-shell-border)] bg-[var(--pm-sidebar-bg)] p-0 motion-reduce:animate-none motion-reduce:transition-none data-open:slide-in-from-left data-closed:slide-out-to-left sm:max-w-none"
          data-testid={`${testIdPrefix}-drawer`}
        >
          <DialogHeader className="shrink-0 flex-row items-start justify-between gap-3 border-b border-[var(--pm-shell-border)] p-4 text-left">
            <div className="min-w-0">
              <DialogTitle>{title}导航</DialogTitle>
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
                  aria-label={`关闭${title}导航`}
                >
                  <X aria-hidden="true" />
                </Button>
              }
            />
          </DialogHeader>
          <ManagementNavigation
            title={title}
            pathname={pathname}
            navigationItems={navigationItems}
            onNavigate={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{title}</p>
        <p className="truncate text-sm font-medium" title={currentLabel}>
          {currentLabel}
        </p>
      </div>
    </div>
  );
}
