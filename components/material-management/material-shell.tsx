"use client";

import type { ReactNode } from "react";
import { PackagePlus, PackageSearch } from "lucide-react";
import {
  ManagementShell,
  type ManagementNavigationItem,
} from "@/components/management-shell";
import { routes } from "@/lib/routes";

function materialNavigationItems(canWrite: boolean): ManagementNavigationItem[] {
  return [
    {
      href: routes.materials.root,
      label: "物资台账",
      icon: PackageSearch,
      match: (pathname) =>
        pathname === routes.materials.root ||
        (pathname.startsWith(`${routes.materials.root}/`) &&
          pathname !== routes.materials.new),
    },
    ...(canWrite
      ? [
          {
            href: routes.materials.new,
            label: "登记物资",
            icon: PackagePlus,
            match: (pathname: string) => pathname === routes.materials.new,
          },
        ]
      : []),
  ];
}

export function MaterialShell({
  canWrite,
  children,
}: {
  canWrite: boolean;
  children: ReactNode;
}) {
  return (
    <ManagementShell
      title="物资管理"
      icon={PackageSearch}
      navigationItems={materialNavigationItems(canWrite)}
      testIdPrefix="material-management"
    >
      {children}
    </ManagementShell>
  );
}
