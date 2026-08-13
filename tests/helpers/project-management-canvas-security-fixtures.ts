import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { toProjectManagementServiceError, type ProjectManagementErrorCode } from "../../lib/project-management/application/errors";
import type { ProjectManagementActor, ProjectManagementSystemRoleRecord } from "../../lib/project-management/identity";
import { getTimeCanvasData } from "../../lib/project-management/queries/time-canvas-queries";

export const RANGE_START = "2026-08-10T00:00:00.000Z";

export const RANGE_END = "2026-08-12T00:00:00.000Z";

export async function createAccountPerson(
  displayName: string,
  status: "ACTIVE" | "INACTIVE" = "ACTIVE",
) {
  const openId = `ou_s2_canvas_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      person: { create: { displayName, status } },
      identities: {
        create: {
          provider: "FEISHU",
          providerSubject: openId,
          tenantId: "default",
          openId,
        },
      },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { account, person: account.person, openId };
}

export async function createTask({
  ownerAccountId,
  title,
  team,
  techGroup,
  members,
  plannedStartAt = atHour(8),
  status = "ACTIVE",
}: {
  ownerAccountId: string;
  title: string;
  team: string;
  techGroup: string;
  members: Array<{ personId: string; role: TaskMemberRoleInput }>;
  plannedStartAt?: Date | null;
  status?: TaskStatusInput;
}) {
  const taskId = randomUUID();
  const planVersionId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.create({
      data: {
        id: taskId,
        title,
        team,
        techGroup,
        status,
        currentPlanVersionId: planVersionId,
        createdByAccountId: ownerAccountId,
        startedAt: atHour(8),
        archivedAt: status === "ARCHIVED" ? atHour(19) : null,
      },
    });
    await tx.taskPlanVersion.create({
      data: {
        id: planVersionId,
        taskId,
        versionNo: 1,
        status: "CURRENT",
        plannedStartAt,
        reason: "S2 canvas query fixture",
        createdByAccountId: ownerAccountId,
        activatedAt: atHour(8),
      },
    });
    await tx.taskMember.createMany({
      data: members.map((member) => ({
        taskId,
        personId: member.personId,
        role: member.role,
        createdByAccountId: ownerAccountId,
      })),
    });
  });
  const milestone = await prisma.taskNode.create({
    data: {
      taskId,
      type: "MILESTONE",
      status: "ACTIVE",
      businessDescription: "S2 查询 Milestone",
      createdByAccountId: ownerAccountId,
      milestone: {
        create: {
          goal: `${title} 当前节点`,
          completionCriteria: "查询测试通过",
          expectedCompletedAt: atHour(18),
          reviewRequirements: "提交自动化证据",
        },
      },
    },
  });
  await prisma.planVersionNode.create({
    data: { planVersionId, nodeId: milestone.id, sequence: 1 },
  });
  await prisma.task.update({
    where: { id: taskId },
    data: { activeMilestoneNodeId: milestone.id },
  });
  return { taskId, planVersionId, milestoneNodeId: milestone.id };
}

export async function createSegment({
  id,
  accountId,
  personId,
  taskId = null,
  type = "PLANNED",
  status = type === "ACTUAL" ? "CONFIRMED" : "PLANNED",
  startAt,
  endAt,
  content = "S2 查询 Segment",
  priority = "MEDIUM",
}: {
  id?: string;
  accountId: string;
  personId: string;
  taskId?: string | null;
  type?: "PLANNED" | "ACTUAL";
  status?:
    | "PLANNED"
    | "IN_PROGRESS"
    | "PENDING_CONFIRMATION"
    | "CONFIRMED"
    | "CANCELLED";
  startAt: Date;
  endAt: Date;
  content?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}) {
  return prisma.workSegment.create({
    data: {
      ...(id ? { id } : {}),
      personId,
      type,
      status,
      startAt,
      endAt,
      content,
      priority,
      taskId,
      createdByAccountId: accountId,
      updatedByAccountId: accountId,
    },
  });
}

export async function createTaskOptionFixtures({
  ownerAccountId,
  ownerPersonId,
  titlePrefix,
  count,
  withTerminationNodes = false,
}: {
  ownerAccountId: string;
  ownerPersonId: string;
  titlePrefix: string;
  count: number;
  withTerminationNodes?: boolean;
}): Promise<string[]> {
  const records = Array.from({ length: count }, (_, index) => ({
    taskId: randomUUID(),
    planVersionId: randomUUID(),
    nodeId: randomUUID(),
    title: `${titlePrefix} ${String(index).padStart(2, "0")}`,
  }));
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.createMany({
      data: records.map((record) => ({
        id: record.taskId,
        title: record.title,
        team: "英雄",
        techGroup: "电控",
        status: "ACTIVE",
        currentPlanVersionId: record.planVersionId,
        createdByAccountId: ownerAccountId,
        startedAt: atHour(8),
      })),
    });
    await tx.taskPlanVersion.createMany({
      data: records.map((record) => ({
        id: record.planVersionId,
        taskId: record.taskId,
        versionNo: 1,
        status: "CURRENT",
        plannedStartAt: atHour(8),
        reason: "S2 option cursor fixture",
        createdByAccountId: ownerAccountId,
        activatedAt: atHour(8),
      })),
    });
    if (withTerminationNodes) {
      await tx.taskNode.createMany({
        data: records.map((record) => ({
          id: record.nodeId,
          taskId: record.taskId,
          type: "TERMINATION" as const,
          status: "ACTIVE" as const,
          businessDescription: "资源计划游标 Terminal",
          createdByAccountId: ownerAccountId,
        })),
      });
      await tx.terminationNode.createMany({
        data: records.map((record, index) => ({
          nodeId: record.nodeId,
          name: `Terminal ${String(index).padStart(2, "0")}`,
          plannedOutcomeCriteria: "完成资源计划游标验证",
          plannedAt: atHour(9),
        })),
      });
      await tx.planVersionNode.createMany({
        data: records.map((record) => ({
          planVersionId: record.planVersionId,
          nodeId: record.nodeId,
          sequence: 1,
        })),
      });
    }
    await tx.taskMember.createMany({
      data: records.map((record) => ({
        taskId: record.taskId,
        personId: ownerPersonId,
        role: "OWNER" as const,
        createdByAccountId: ownerAccountId,
      })),
    });
  });
  return records.map((record) => record.taskId);
}

export function rewriteResourcePlanCursor(cursor: string, id: string) {
  const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as
    Record<string, unknown>;
  payload.id = id;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function resourcePlanCursorId(cursor: string) {
  const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    id?: unknown;
  };
  if (typeof payload.id !== "string") throw new Error("资源计划测试游标缺少 ID");
  return payload.id;
}

export async function createAnchorTaskBatch({
  ownerAccountId,
  ownerPersonId,
  targetPersonId,
  titlePrefix,
  taskCount,
  nodesPerTask,
}: {
  ownerAccountId: string;
  ownerPersonId: string;
  targetPersonId: string;
  titlePrefix: string;
  taskCount: number;
  nodesPerTask: number;
}) {
  const tasks = Array.from({ length: taskCount }, (_, taskIndex) => ({
    id: randomUUID(),
    planVersionId: randomUUID(),
    title: `${titlePrefix} ${String(taskIndex).padStart(3, "0")} ${randomUUID()}`,
  }));
  const nodes = tasks.flatMap((task) =>
    Array.from({ length: nodesPerTask }, (_, nodeIndex) => ({
      id: randomUUID(),
      taskId: task.id,
      planVersionId: task.planVersionId,
      sequence: nodeIndex + 1,
      businessDescription: `${task.title} Node ${nodeIndex + 1}`,
    })),
  );
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.createMany({
      data: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        team: "英雄",
        techGroup: "电控",
        status: "ACTIVE" as const,
        currentPlanVersionId: task.planVersionId,
        createdByAccountId: ownerAccountId,
        startedAt: atHour(8),
      })),
    });
    await tx.taskPlanVersion.createMany({
      data: tasks.map((task) => ({
        id: task.planVersionId,
        taskId: task.id,
        versionNo: 1,
        status: "CURRENT" as const,
        reason: "S2 anchor complexity fixture",
        createdByAccountId: ownerAccountId,
        activatedAt: atHour(8),
      })),
    });
    await tx.taskMember.createMany({
      data: tasks.flatMap((task) => [
        {
          taskId: task.id,
          personId: ownerPersonId,
          role: "OWNER" as const,
          createdByAccountId: ownerAccountId,
        },
        {
          taskId: task.id,
          personId: targetPersonId,
          role: "PARTICIPANT" as const,
          createdByAccountId: ownerAccountId,
        },
      ]),
    });
    await tx.workSegment.createMany({
      data: tasks.map((task) => ({
        id: randomUUID(),
        personId: targetPersonId,
        type: "PLANNED" as const,
        status: "PLANNED" as const,
        startAt: atHour(9),
        endAt: atHour(10),
        content: `${task.title} anchor candidate`,
        priority: "LOW" as const,
        taskId: task.id,
        createdByAccountId: ownerAccountId,
      })),
    });
    for (let offset = 0; offset < nodes.length; offset += 1_000) {
      const chunk = nodes.slice(offset, offset + 1_000);
      await tx.taskNode.createMany({
        data: chunk.map((node) => ({
          id: node.id,
          taskId: node.taskId,
          type: "MILESTONE" as const,
          status: "PENDING" as const,
          businessDescription: node.businessDescription,
          createdByAccountId: ownerAccountId,
        })),
      });
      await tx.planVersionNode.createMany({
        data: chunk.map((node) => ({
          planVersionId: node.planVersionId,
          nodeId: node.id,
          sequence: node.sequence,
        })),
      });
    }
  });
}

export async function createSegmentsInChunks(
  rows: Prisma.WorkSegmentCreateManyInput[],
) {
  for (let offset = 0; offset < rows.length; offset += 1_000) {
    await prisma.workSegment.createMany({
      data: rows.slice(offset, offset + 1_000),
    });
  }
}

export function actor(
  input: Awaited<ReturnType<typeof createAccountPerson>>,
  systemRoles: ProjectManagementSystemRoleRecord[] = [],
): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles,
  };
}

export function systemAdministratorRole(): ProjectManagementSystemRoleRecord {
  return { role: "PROJECT_ADMINISTRATOR", team: "", techGroup: "" };
}

export function scopedRole(
  role: "GROUP_LEADER",
  team: string,
  techGroup: string,
): ProjectManagementSystemRoleRecord {
  return { role, team, techGroup: team ? "" : techGroup };
}

export async function grantScopedRole(
  accountId: string,
  role: "GROUP_LEADER",
  team: string,
  techGroup: string,
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team,
      techGroup: team ? "" : techGroup,
      grantedByAccountId: accountId,
      revokedAt: new Date(),
    },
  });
}

export function canvasInput(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    rangeStart: RANGE_START,
    rangeEnd: RANGE_END,
    includeTaskAnchors: true,
    includeActual: true,
    includeBusyBlocks: false,
    ...overrides,
  };
}

export function atHour(hour: number): Date {
  const integerHour = Math.trunc(hour);
  const minute = Math.round((hour - integerHour) * 60);
  return new Date(Date.UTC(2026, 7, 10, integerHour, minute));
}

export async function expectErrorCode(
  promise: Promise<unknown>,
  code: ProjectManagementErrorCode,
) {
  await expect(
    promise.catch((error) => toProjectManagementServiceError(error).code),
  ).resolves.toBe(code);
}

export async function serviceErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return toProjectManagementServiceError(error);
  }
  throw new Error("预期服务调用失败，但调用成功");
}

export function fullSegmentIds(
  data: Awaited<ReturnType<typeof getTimeCanvasData>>,
): string[] {
  return data.segments.flatMap((segment) =>
    segment.kind === "SEGMENT" ? [segment.id] : [],
  );
}

export function rowCanCreate(
  data: Awaited<ReturnType<typeof getTimeCanvasData>>,
  rowId: string,
): boolean | undefined {
  return data.rows.find((row) => row.id === rowId)?.capabilities.canCreateSegment;
}

export type TaskMemberRoleInput = "OWNER" | "PARTICIPANT";

export type TaskStatusInput =
  | "DRAFT"
  | "ACTIVE"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMEOUT"
  | "ARCHIVED";
