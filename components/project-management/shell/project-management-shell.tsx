"use client";

import type { ReactNode } from "react";
import {
  Bell,
  CalendarRange,
  FolderKanban,
  LayoutList,
  ListChecks,
} from "lucide-react";
import {
  ManagementShell,
  type ManagementNavigationItem,
} from "@/components/management-shell";
import { routes } from "@/lib/routes";

type ProjectManagementShellProps = {
  unreadCount: number;
  children: ReactNode;
};

function projectNavigationItems(
  unreadCount: number,
): ManagementNavigationItem[] {
  return [
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
      badgeCount: unreadCount,
    },
  ];
}

export function ProjectManagementShell({
  unreadCount,
  children,
}: ProjectManagementShellProps) {
  return (
    <ManagementShell
      title="项目管理"
      icon={FolderKanban}
      navigationItems={projectNavigationItems(unreadCount)}
      testIdPrefix="project-management"
    >
      {children}
    </ManagementShell>
  );
}
