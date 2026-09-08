"use client";

import type { ReactNode } from "react";
import {
  Bell,
  CalendarRange,
  FolderKanban,
  Users,
  LayoutDashboard,
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

export function projectNavigationItems(
  unreadCount: number,
): ManagementNavigationItem[] {
  return [
    {
      href: routes.progress.root,
      label: "工作台",
      group: "工作空间",
      icon: LayoutDashboard,
      match: (pathname) => pathname === routes.progress.root,
    },
    {
      href: routes.progress.projects,
      label: "项目",
      group: "工作空间",
      icon: FolderKanban,
      match: (pathname) =>
        pathname === routes.progress.projects ||
        pathname.startsWith(`${routes.progress.projects}/`),
    },
    {
      href: routes.progress.tasks,
      label: "任务",
      group: "工作空间",
      icon: LayoutList,
      match: (pathname) =>
        pathname === routes.progress.tasks ||
        pathname.startsWith(`${routes.progress.tasks}/`),
    },
    {
      href: routes.progress.approvals,
      label: "待办与审批",
      group: "工作空间",
      icon: ListChecks,
      match: (pathname) => pathname === routes.progress.approvals,
    },
    {
      href: routes.progress.resources,
      label: "资源计划",
      group: "团队排期",
      icon: CalendarRange,
      match: (pathname) => pathname === routes.progress.resources,
    },
    {
      href: routes.progress.kanban,
      label: "人员时间线",
      group: "团队排期",
      icon: Users,
      match: (pathname) => pathname === routes.progress.kanban,
    },
    {
      href: routes.progress.notifications,
      label: "通知",
      group: "消息中心",
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
