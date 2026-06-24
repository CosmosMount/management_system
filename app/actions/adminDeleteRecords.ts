"use server";

import { revalidatePath } from "next/cache";
import { ProjectStatus, TaskStatus } from "@prisma/client";
import { removeOrderUploads } from "@/lib/file-upload";
import { prisma } from "@/lib/prisma";
import { requireSuperAdmin } from "@/lib/permissions";
import { routes } from "@/lib/routes";

export async function deletePurchaseOrder(orderId: string) {
  await requireSuperAdmin();

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    select: { id: true },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  await prisma.purchaseOrder.delete({ where: { id: orderId } });
  await removeOrderUploads(orderId).catch(() => {});

  revalidatePath("/");
  revalidatePath(routes.procurement.root);
  revalidatePath(routes.procurement.list);
  revalidatePath(routes.procurement.dashboard);
  revalidatePath(routes.procurement.detail(orderId));
}

export async function deleteArchivedProject(projectId: string) {
  await requireSuperAdmin();

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, status: true },
  });
  if (!project) {
    throw new Error("项目不存在");
  }
  if (
    project.status !== ProjectStatus.COMPLETED &&
    project.status !== ProjectStatus.CANCELED
  ) {
    throw new Error("仅可删除已完成或已取消的项目");
  }

  await prisma.project.delete({ where: { id: projectId } });

  revalidatePath(routes.progress.root);
  revalidatePath(routes.progress.archive);
  revalidatePath(routes.progress.dashboard);
  revalidatePath(routes.progress.project(projectId));
}

export async function deleteArchivedTask(taskId: string) {
  await requireSuperAdmin();

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, status: true },
  });
  if (!task) {
    throw new Error("任务不存在");
  }
  if (task.status !== TaskStatus.ARCHIVED) {
    throw new Error("仅可删除已归档的任务");
  }

  await prisma.task.delete({ where: { id: taskId } });

  revalidatePath(routes.progress.root);
  revalidatePath(routes.progress.archive);
  revalidatePath(routes.progress.task(taskId));
  revalidatePath(routes.progress.project(task.projectId));
}
