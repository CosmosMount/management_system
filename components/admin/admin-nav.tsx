"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BellRing,
  ClipboardCheck,
  FolderKanban,
  LayoutDashboard,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

const adminNavItems = [
  { href: routes.admin.root, label: "概览", icon: LayoutDashboard },
  { href: routes.admin.system, label: "系统同步", icon: RefreshCw },
  { href: routes.admin.roles, label: "用户与角色", icon: ShieldCheck },
  { href: routes.admin.budgetPools, label: "采购预算池", icon: Wallet },
  { href: routes.admin.reminders, label: "进度提醒", icon: BellRing },
  { href: routes.admin.projectTemplates, label: "项目模板", icon: FolderKanban },
  { href: routes.admin.acceptance, label: "验收条例", icon: ClipboardCheck },
] as const;

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-7">
      {adminNavItems.map((item) => {
        const Icon = item.icon;
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex h-10 min-w-0 items-center justify-center gap-2 rounded-lg border bg-background px-3 text-sm font-medium transition-colors hover:border-primary/30 hover:bg-muted",
              active && "border-primary/40 bg-primary/10 text-primary",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
