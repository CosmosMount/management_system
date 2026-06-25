import type { OrderStatus, ProjectStatus, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type ProfileOrderRow = {
  id: string;
  orderNo: string;
  team: string;
  techGroup: string;
  totalPrice: number;
  status: OrderStatus;
  updatedAt: string;
  isActive: boolean;
};

export type ProfileProjectRow = {
  id: string;
  name: string;
  team: string;
  techGroup: string;
  status: ProjectStatus;
  updatedAt: string;
  isActive: boolean;
};

export type ProfileTaskRow = {
  id: string;
  title: string;
  projectName: string;
  status: TaskStatus;
  isOverdue: boolean;
  updatedAt: string;
  isActive: boolean;
};

export type UserProfileRecords = {
  orders: ProfileOrderRow[];
  projects: ProfileProjectRow[];
  tasks: ProfileTaskRow[];
};

const ACTIVE_ORDER_STATUSES = new Set<OrderStatus>([
  "DRAFT",
  "MANAGEMENT_REVIEW",
  "TEACHER_REVIEW",
  "PENDING_APPLICANT_DOCS",
  "PENDING_FINANCE_REVIEW",
  "PENDING_APPLICANT_CONFIRM",
]);

const ACTIVE_PROJECT_STATUSES = new Set<ProjectStatus>([
  "NOT_STARTED",
  "IN_PROGRESS",
]);

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  "TODO",
  "IN_PROGRESS",
  "PENDING_ACCEPTANCE",
]);

function sortActiveFirst<T extends { isActive: boolean; updatedAt: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.isActive !== b.isActive) {
      return a.isActive ? -1 : 1;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export async function getUserProfileRecords(
  openId: string,
): Promise<UserProfileRecords> {
  const [orders, projects, tasks] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: { initiator: { openId } },
      select: {
        id: true,
        orderNo: true,
        team: true,
        techGroup: true,
        totalPrice: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.project.findMany({
      where: {
        OR: [{ ownerOpenId: openId }, { owners: { some: { openId } } }],
      },
      select: {
        id: true,
        name: true,
        team: true,
        techGroup: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.task.findMany({
      where: {
        deletedAt: null,
        OR: [{ assigneeOpenId: openId }, { assignees: { some: { openId } } }],
      },
      select: {
        id: true,
        title: true,
        status: true,
        isOverdue: true,
        updatedAt: true,
        project: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  return {
    orders: sortActiveFirst(
      orders.map((order) => ({
        ...order,
        updatedAt: order.updatedAt.toISOString(),
        isActive: ACTIVE_ORDER_STATUSES.has(order.status),
      })),
    ),
    projects: sortActiveFirst(
      projects.map((project) => ({
        ...project,
        updatedAt: project.updatedAt.toISOString(),
        isActive: ACTIVE_PROJECT_STATUSES.has(project.status),
      })),
    ),
    tasks: sortActiveFirst(
      tasks.map((task) => ({
        id: task.id,
        title: task.title,
        projectName: task.project.name,
        status: task.status,
        isOverdue: task.isOverdue,
        updatedAt: task.updatedAt.toISOString(),
        isActive: ACTIVE_TASK_STATUSES.has(task.status),
      })),
    ),
  };
}
