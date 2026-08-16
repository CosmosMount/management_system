import { createHash } from "node:crypto";
import type { GlobalTimeMarker, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { stateConflictError } from "@/lib/project-management/application/errors";
import type { GlobalTimeMarkerDto } from "@/lib/project-management/types/time-canvas";
import { saveGlobalTimeMarkersInputSchema } from "@/lib/project-management/validations/global-time-markers";

const GLOBAL_TIME_MARKER_MUTATION_LOCK = "project-management:global-time-markers";

export type GlobalTimeMarkerCollectionDto = {
  markers: GlobalTimeMarkerDto[];
  collectionVersion: string;
};

const activeMarkerOrder = [
  { markedAt: "asc" as const },
  { id: "asc" as const },
];

export async function listGlobalTimeMarkers(): Promise<GlobalTimeMarkerDto[]> {
  const markers = await prisma.globalTimeMarker.findMany({
    where: { deletedAt: null },
    orderBy: activeMarkerOrder,
  });
  return markers.map(serializeGlobalTimeMarker);
}

export async function getGlobalTimeMarkerCollection(): Promise<GlobalTimeMarkerCollectionDto> {
  const markers = await listGlobalTimeMarkers();
  return {
    markers,
    collectionVersion: globalTimeMarkerCollectionVersion(markers),
  };
}

export async function saveGlobalTimeMarkerCollection(
  actorAccountId: string,
  input: unknown,
): Promise<GlobalTimeMarkerCollectionDto> {
  const parsed = saveGlobalTimeMarkersInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${GLOBAL_TIME_MARKER_MUTATION_LOCK})
      )
    `;
    await assertSuperAdministratorTx(tx, actorAccountId);

    const current = await tx.globalTimeMarker.findMany({
      where: { deletedAt: null },
      orderBy: activeMarkerOrder,
    });
    const currentDtos = current.map(serializeGlobalTimeMarker);
    const currentVersion = globalTimeMarkerCollectionVersion(currentDtos);

    if (currentVersion !== parsed.expectedCollectionVersion) {
      if (desiredSnapshotMatchesCurrent(parsed.markers, currentDtos)) {
        return { markers: currentDtos, collectionVersion: currentVersion };
      }
      throw stateConflictError("关键时间点已被其他管理员修改，请重新加载后再保存");
    }

    const currentById = new Map(current.map((marker) => [marker.id, marker]));
    const desiredIds = new Set(parsed.markers.map((marker) => marker.id));

    for (const marker of current) {
      if (desiredIds.has(marker.id)) continue;
      const deletedAt = new Date();
      await tx.globalTimeMarker.update({
        where: { id: marker.id },
        data: { deletedAt },
      });
      await createDomainAuditEventTx(tx, {
        actorAccountId,
        action: "pm.global_time_marker.delete",
        entityType: "GlobalTimeMarker",
        entityId: marker.id,
        before: markerAuditSnapshot(marker),
        after: { deletedAt: deletedAt.toISOString() },
        reason: "超级管理员通过关键时间点后台删除全局时间标记",
      });
    }

    for (const desired of parsed.markers) {
      const existing = currentById.get(desired.id);
      if (!existing) {
        if (desired.versionToken !== null) {
          throw stateConflictError("新增关键时间点携带了无效版本，请重新加载后再试");
        }
        const previouslyUsed = await tx.globalTimeMarker.findUnique({
          where: { id: desired.id },
          select: { id: true },
        });
        if (previouslyUsed) {
          throw stateConflictError("关键时间点标识已被使用，请重新添加后再保存");
        }
        const created = await tx.globalTimeMarker.create({
          data: {
            id: desired.id,
            name: desired.name,
            markedAt: new Date(desired.markedAt),
          },
        });
        await createDomainAuditEventTx(tx, {
          actorAccountId,
          action: "pm.global_time_marker.create",
          entityType: "GlobalTimeMarker",
          entityId: created.id,
          after: markerAuditSnapshot(created),
          reason: "超级管理员通过关键时间点后台创建全局时间标记",
        });
        continue;
      }

      if (desired.versionToken !== existing.updatedAt.toISOString()) {
        throw stateConflictError("关键时间点版本已变化，请重新加载后再保存");
      }
      const desiredMarkedAt = new Date(desired.markedAt);
      if (
        desired.name === existing.name &&
        desiredMarkedAt.getTime() === existing.markedAt.getTime()
      ) {
        continue;
      }
      const updated = await tx.globalTimeMarker.update({
        where: { id: existing.id },
        data: { name: desired.name, markedAt: desiredMarkedAt },
      });
      await createDomainAuditEventTx(tx, {
        actorAccountId,
        action: "pm.global_time_marker.update",
        entityType: "GlobalTimeMarker",
        entityId: updated.id,
        before: markerAuditSnapshot(existing),
        after: markerAuditSnapshot(updated),
        reason: "超级管理员通过关键时间点后台更新全局时间标记",
      });
    }

    const saved = await tx.globalTimeMarker.findMany({
      where: { deletedAt: null },
      orderBy: activeMarkerOrder,
    });
    const markers = saved.map(serializeGlobalTimeMarker);
    return {
      markers,
      collectionVersion: globalTimeMarkerCollectionVersion(markers),
    };
  });
}

async function assertSuperAdministratorTx(
  tx: Prisma.TransactionClient,
  actorAccountId: string,
) {
  const assignment = await tx.systemRoleAssignment.findFirst({
    where: {
      accountId: actorAccountId,
      role: "SUPER_ADMINISTRATOR",
      team: "",
      techGroup: "",
      revokedAt: null,
    },
    select: { id: true },
  });
  if (!assignment) throw new Error("无管理权限");
}

function serializeGlobalTimeMarker(marker: GlobalTimeMarker): GlobalTimeMarkerDto {
  const updatedAt = marker.updatedAt.toISOString();
  return {
    id: marker.id,
    name: marker.name,
    markedAt: marker.markedAt.toISOString(),
    updatedAt,
    versionToken: updatedAt,
  };
}

function globalTimeMarkerCollectionVersion(markers: GlobalTimeMarkerDto[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        markers.map((marker) => ({ id: marker.id, updatedAt: marker.updatedAt })),
      ),
    )
    .digest("hex");
}

function desiredSnapshotMatchesCurrent(
  desired: Array<{
    id: string;
    name: string;
    markedAt: string;
    versionToken: string | null;
  }>,
  current: GlobalTimeMarkerDto[],
) {
  if (desired.length !== current.length) return false;
  const currentById = new Map(current.map((marker) => [marker.id, marker]));
  return desired.every((marker) => {
    const persisted = currentById.get(marker.id);
    return Boolean(
      persisted &&
        persisted.name === marker.name &&
        Date.parse(persisted.markedAt) === Date.parse(marker.markedAt),
    );
  });
}

function markerAuditSnapshot(marker: Pick<GlobalTimeMarker, "name" | "markedAt">) {
  return { name: marker.name, markedAt: marker.markedAt.toISOString() };
}
