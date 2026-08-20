"use client";

import type { ReactNode } from "react";
import {
  ClipboardCheck,
  ClipboardList,
  FilePlus2,
  Hammer,
  LayoutDashboard,
  ShoppingCart,
} from "lucide-react";
import {
  ManagementShell,
  type ManagementNavigationItem,
} from "@/components/management-shell";
import { routes } from "@/lib/routes";

const ORDER_DETAIL_PATH = /^\/procurement\/[0-9a-f-]{36}(?:\/edit)?$/i;

function procurementNavigationItems(
  canWrite: boolean,
): ManagementNavigationItem[] {
  return [
    {
      href: routes.procurement.dashboard,
      label: "采购看板",
      icon: LayoutDashboard,
      match: (pathname) => pathname === routes.procurement.dashboard,
    },
    {
      href: routes.procurement.pending,
      label: "待办与最近",
      icon: ClipboardCheck,
      match: (pathname) => pathname === routes.procurement.pending,
    },
    ...(canWrite
      ? [
          {
            href: routes.procurement.new,
            label: "新建申请",
            icon: FilePlus2,
            match: (pathname: string) => pathname === routes.procurement.new,
          },
        ]
      : []),
    {
      href: routes.procurement.list,
      label: "订单列表",
      icon: ClipboardList,
      match: (pathname) =>
        pathname === routes.procurement.list ||
        ORDER_DETAIL_PATH.test(pathname),
    },
    ...(canWrite
      ? [
          {
            href: routes.procurement.workshopFee,
            label: "工坊加工费",
            icon: Hammer,
            match: (pathname: string) =>
              pathname === routes.procurement.workshopFee,
          },
        ]
      : []),
  ];
}

export function ProcurementShell({
  canWrite,
  children,
}: {
  canWrite: boolean;
  children: ReactNode;
}) {
  return (
    <ManagementShell
      title="采购管理"
      icon={ShoppingCart}
      navigationItems={procurementNavigationItems(canWrite)}
      testIdPrefix="procurement"
    >
      {children}
    </ManagementShell>
  );
}
