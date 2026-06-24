"use client";

import {
  deleteArchivedProject,
  deleteArchivedTask,
  deletePurchaseOrder,
} from "@/app/actions/adminDeleteRecords";
import { AdminDeleteRecordButton } from "@/components/admin-delete-record-button";
import type { ProjectStatus, TaskStatus } from "@prisma/client";
import { isSuperAdmin, type UserRoleRecord } from "@/lib/permissions-client";
import { routes } from "@/lib/routes";

type PurchaseOrderDeleteProps = {
  orderId: string;
  userRoles: UserRoleRecord[];
  redirectTo?: string;
};

export function PurchaseOrderDeleteButton({
  orderId,
  userRoles,
  redirectTo = routes.procurement.list,
}: PurchaseOrderDeleteProps) {
  if (!isSuperAdmin(userRoles)) return null;

  return (
    <AdminDeleteRecordButton
      title="删除采购订单"
      description="将永久删除该订单、明细及已上传附件，此操作不可恢复。"
      onConfirm={() => deletePurchaseOrder(orderId)}
      redirectTo={redirectTo}
    />
  );
}

type ArchivedProjectDeleteProps = {
  projectId: string;
  status: ProjectStatus;
  isSuperAdmin: boolean;
  redirectTo?: string;
};

export function ArchivedProjectDeleteButton({
  projectId,
  status,
  isSuperAdmin: admin,
  redirectTo = routes.progress.archive,
}: ArchivedProjectDeleteProps) {
  if (!admin) return null;
  if (status !== "COMPLETED" && status !== "CANCELED") return null;

  return (
    <AdminDeleteRecordButton
      title="删除已结束项目"
      description="将永久删除该项目及其阶段、任务、提交记录与活动日志，此操作不可恢复。"
      onConfirm={() => deleteArchivedProject(projectId)}
      redirectTo={redirectTo}
    />
  );
}

type ArchivedTaskDeleteProps = {
  taskId: string;
  status: TaskStatus;
  isSuperAdmin: boolean;
  redirectTo?: string;
};

export function ArchivedTaskDeleteButton({
  taskId,
  status,
  isSuperAdmin: admin,
  redirectTo = routes.progress.archive,
}: ArchivedTaskDeleteProps) {
  if (!admin) return null;
  if (status !== "ARCHIVED") return null;

  return (
    <AdminDeleteRecordButton
      title="删除已归档任务"
      description="将永久删除该任务及其交付、周报与活动日志，此操作不可恢复。"
      onConfirm={() => deleteArchivedTask(taskId)}
      redirectTo={redirectTo}
    />
  );
}

type PurchaseOrderDeleteByAdminProps = {
  orderId: string;
  isSuperAdmin: boolean;
  redirectTo?: string;
};

export function PurchaseOrderDeleteByAdminButton({
  orderId,
  isSuperAdmin: admin,
  redirectTo = routes.procurement.list,
}: PurchaseOrderDeleteByAdminProps) {
  if (!admin) return null;

  return (
    <AdminDeleteRecordButton
      title="删除采购订单"
      description="将永久删除该订单、明细及已上传附件，此操作不可恢复。"
      onConfirm={() => deletePurchaseOrder(orderId)}
      redirectTo={redirectTo}
    />
  );
}
