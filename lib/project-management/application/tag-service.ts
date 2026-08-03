import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { assertAuthorized, isSystemAdministrator } from "@/lib/project-management/authorization";
import {
  notFoundError,
  staleTaskError,
} from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

const idSchema = z.string().uuid("Tag ID 格式不正确");
const tagFieldsSchema = z.object({
  name: z.string().trim().min(1, "Tag 名称不能为空").max(40, "Tag 名称不能超过 40 字"),
  color: z
    .string()
    .trim()
    .regex(/^(?:#[0-9a-fA-F]{6})?$/, "颜色必须是六位十六进制色值")
    .default(""),
  description: z.string().trim().max(300, "说明不能超过 300 字").default(""),
});

const updateTagSchema = tagFieldsSchema.extend({
  tagId: idSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});

const tagTransitionSchema = z.object({
  tagId: idSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});

export async function createTag(actor: ProjectManagementActor, input: unknown) {
  const parsed = tagFieldsSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshActorTx(tx, actor);
    assertAuthorized({
      actor: refreshedActor,
      action: "tag.create",
      resource: { type: "tag" },
    });
    const tag = await tx.tag.create({
      data: { ...parsed, createdByAccountId: refreshedActor.accountId },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "tag.created",
      entityType: "Tag",
      entityId: tag.id,
      after: tagSnapshot(tag),
    });
    return serializeTag(tag, { taskCount: 0, segmentCount: 0 });
  });
}

export async function updateTag(actor: ProjectManagementActor, input: unknown) {
  const parsed = updateTagSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshActorTx(tx, actor);
    const current = await tx.tag.findUnique({ where: { id: parsed.tagId } });
    if (!current) throw notFoundError();
    assertTagMutation(refreshedActor, current.createdByAccountId, "tag.update");
    const result = await tx.tag.updateMany({
      where: { id: current.id, updatedAt: new Date(parsed.expectedUpdatedAt) },
      data: { name: parsed.name, color: parsed.color, description: parsed.description },
    });
    if (result.count === 0) throw staleTagError();
    const tag = await tx.tag.findUniqueOrThrow({ where: { id: current.id } });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "tag.updated",
      entityType: "Tag",
      entityId: tag.id,
      before: tagSnapshot(current),
      after: tagSnapshot(tag),
    });
    return serializeTag(tag);
  });
}

export async function setTagArchived(
  actor: ProjectManagementActor,
  input: unknown,
  archived: boolean,
) {
  const parsed = tagTransitionSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshActorTx(tx, actor);
    const current = await tx.tag.findUnique({ where: { id: parsed.tagId } });
    if (!current) throw notFoundError();
    assertTagMutation(refreshedActor, current.createdByAccountId, "tag.update");
    if (Boolean(current.archivedAt) === archived) {
      return serializeTag(current);
    }
    const result = await tx.tag.updateMany({
      where: { id: current.id, updatedAt: new Date(parsed.expectedUpdatedAt) },
      data: { archivedAt: archived ? new Date() : null },
    });
    if (result.count === 0) throw staleTagError();
    const tag = await tx.tag.findUniqueOrThrow({ where: { id: current.id } });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: archived ? "tag.archived" : "tag.restored",
      entityType: "Tag",
      entityId: tag.id,
      before: tagSnapshot(current),
      after: tagSnapshot(tag),
    });
    return serializeTag(tag);
  });
}

export async function deleteTag(actor: ProjectManagementActor, input: unknown) {
  const parsed = tagTransitionSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshActorTx(tx, actor);
    const current = await tx.tag.findUnique({
      where: { id: parsed.tagId },
      include: { _count: { select: { taskTags: true, segmentTags: true } } },
    });
    if (!current) throw notFoundError();
    assertTagMutation(refreshedActor, current.createdByAccountId, "tag.delete");
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "tag.deleted",
      entityType: "Tag",
      entityId: current.id,
      before: {
        ...tagSnapshot(current),
        taskAssociationCount: current._count.taskTags,
        segmentAssociationCount: current._count.segmentTags,
      },
      reason: "删除仅移除分类关联，不删除 Task 或投入记录",
    });
    const deleted = await tx.tag.deleteMany({
      where: {
        id: current.id,
        updatedAt: new Date(parsed.expectedUpdatedAt),
      },
    });
    if (deleted.count === 0) throw staleTagError();
    return {
      tagId: current.id,
      removedTaskAssociationCount: current._count.taskTags,
      removedSegmentAssociationCount: current._count.segmentTags,
    };
  });
}

async function refreshActorTx(
  tx: Prisma.TransactionClient,
  actor: ProjectManagementActor,
): Promise<ProjectManagementActor> {
  const systemRoles = await tx.systemRoleAssignment.findMany({
    where: { accountId: actor.accountId, revokedAt: null },
    select: { role: true, team: true, techGroup: true },
  });
  return { ...actor, systemRoles };
}

function assertTagMutation(
  actor: ProjectManagementActor,
  createdByAccountId: string,
  action: "tag.update" | "tag.delete",
) {
  if (isSystemAdministrator(actor)) return;
  assertAuthorized({
    actor,
    action,
    resource: { type: "tag", createdByAccountId },
  });
}

function staleTagError() {
  return staleTaskError(undefined, "Tag 已被他人修改，请刷新后重试");
}

function tagSnapshot(tag: {
  name: string;
  color: string;
  description: string;
  archivedAt: Date | null;
}) {
  return {
    name: tag.name,
    color: tag.color,
    description: tag.description,
    archivedAt: tag.archivedAt?.toISOString() ?? null,
  };
}

function serializeTag(
  tag: {
    id: string;
    name: string;
    color: string;
    description: string;
    createdByAccountId: string;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  counts?: { taskCount?: number; segmentCount?: number },
) {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    description: tag.description,
    createdByAccountId: tag.createdByAccountId,
    archivedAt: tag.archivedAt?.toISOString() ?? null,
    createdAt: tag.createdAt.toISOString(),
    updatedAt: tag.updatedAt.toISOString(),
    taskCount: counts?.taskCount ?? 0,
    segmentCount: counts?.segmentCount ?? 0,
  };
}
