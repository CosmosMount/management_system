import type { UserRoleType } from "@prisma/client";
import type { ComponentType } from "react";

export type AdminUser = {
  id: string;
  openId: string;
  name: string;
  email: string | null;
  avatar: string | null;
  createdAt: string;
};

export type AdminRole = {
  id: string;
  openId: string;
  role: UserRoleType;
  team: string;
  techGroup: string;
};

export type AdminIcon = ComponentType<{ className?: string }>;
