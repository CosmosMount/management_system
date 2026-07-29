import Link from "next/link";
import type { ReactNode } from "react";
import {
  Bell,
  CalendarRange,
  FolderKanban,
  GitPullRequestArrow,
  LayoutList,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type ProgressShellProps = {
  title: string;
  subtitle?: string;
  unreadCount?: number;
  children: ReactNode;
};

const navItems = [
  { href: routes.progress.root, label: "我的工作", icon: FolderKanban },
  { href: routes.progress.tasks, label: "全部 Task", icon: LayoutList },
  { href: routes.progress.resources, label: "人员计划", icon: CalendarRange },
  {
    href: routes.progress.conflicts,
    label: "资源冲突",
    icon: GitPullRequestArrow,
  },
  { href: routes.progress.notifications, label: "站内通知", icon: Bell },
];

export function ProgressShell({
  title,
  subtitle,
  unreadCount = 0,
  children,
}: ProgressShellProps) {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">项目管理</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        <nav
          aria-label="项目管理导航"
          className="flex gap-2 overflow-x-auto pb-1 lg:pb-0"
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const isNotification = item.href === routes.progress.notifications;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span>{item.label}</span>
                {isNotification && unreadCount > 0 && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-xs">
                    {unreadCount}
                  </Badge>
                )}
              </Link>
            );
          })}
        </nav>
      </div>
      {children}
    </main>
  );
}
