import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import {
  getGlobalTimeMarkerCollection,
  saveGlobalTimeMarkerCollection,
} from "../lib/project-management/global-time-markers";
import { toProjectManagementServiceError } from "../lib/project-management/application/errors";
import { saveGlobalTimeMarkersInputSchema } from "../lib/project-management/validations/global-time-markers";
import {
  createAccountPerson,
  grantRole,
} from "./helpers/project-management-ui-fixtures";

test.describe("global time markers", () => {
  test("super administrators atomically save, audit and soft-delete markers without notifications", async () => {
    const administrator = await createAccountPerson(
      `关键时间点超级管理员 ${randomUUID()}`,
    );
    const projectAdministrator = await createAccountPerson(
      `关键时间点项目管理员 ${randomUUID()}`,
    );
    await prisma.systemRoleAssignment.create({
      data: {
        accountId: administrator.account.id,
        role: "SUPER_ADMINISTRATOR",
      },
    });
    await grantRole(projectAdministrator.account.id, "PROJECT_ADMINISTRATOR");

    const original = await getGlobalTimeMarkerCollection();
    const notificationCountsBefore = await notificationCounts();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const sharedTime = "2026-09-18T02:30:00.000Z";

    try {
    await expect(
      saveGlobalTimeMarkerCollection(projectAdministrator.account.id, {
        expectedCollectionVersion: original.collectionVersion,
        markers: original.markers,
      }),
    ).rejects.toThrow("无管理权限");

    const created = await saveGlobalTimeMarkerCollection(
      administrator.account.id,
      {
        expectedCollectionVersion: original.collectionVersion,
        markers: [
          ...original.markers,
          {
            id: firstId,
            name: "报名截止",
            markedAt: sharedTime,
            versionToken: null,
          },
          {
            id: secondId,
            name: "技术检查",
            markedAt: sharedTime,
            versionToken: null,
          },
        ],
      },
    );
    const createdIds = new Set<string>([firstId, secondId]);
    expect(created.markers.filter((marker) => createdIds.has(marker.id)))
      .toHaveLength(2);

    const first = created.markers.find((marker) => marker.id === firstId);
    if (!first) throw new Error("创建结果缺少第一个关键时间点");
    const updateInput = {
      expectedCollectionVersion: created.collectionVersion,
      markers: created.markers
        .filter((marker) => marker.id !== secondId)
        .map((marker) =>
          marker.id === firstId
            ? {
                ...marker,
                name: "报名截止（调整）",
                markedAt: "2026-09-19T02:30:00.000Z",
              }
            : marker,
        ),
    };
    const updated = await saveGlobalTimeMarkerCollection(
      administrator.account.id,
      updateInput,
    );
    expect(updated.markers.find((marker) => marker.id === firstId)).toMatchObject({
      name: "报名截止（调整）",
      markedAt: "2026-09-19T02:30:00.000Z",
    });
    expect(updated.markers.some((marker) => marker.id === secondId)).toBe(false);

    const auditsBeforeReplay = await prisma.domainAuditEvent.count({
      where: { entityId: { in: [firstId, secondId] } },
    });
    const replay = await saveGlobalTimeMarkerCollection(
      administrator.account.id,
      updateInput,
    );
    expect(replay.collectionVersion).toBe(updated.collectionVersion);
    await expect(
      prisma.domainAuditEvent.count({
        where: { entityId: { in: [firstId, secondId] } },
      }),
    ).resolves.toBe(auditsBeforeReplay);

    await expect(
      saveGlobalTimeMarkerCollection(administrator.account.id, {
        expectedCollectionVersion: created.collectionVersion,
        markers: created.markers.map((marker) =>
          marker.id === firstId ? { ...marker, name: "并发旧草稿" } : marker,
        ),
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });

    const persistedDeleted = await prisma.globalTimeMarker.findUniqueOrThrow({
      where: { id: secondId },
    });
    expect(persistedDeleted.deletedAt).not.toBeNull();
    const actions = await prisma.domainAuditEvent.findMany({
      where: { entityId: { in: [firstId, secondId] } },
      orderBy: { createdAt: "asc" },
      select: { action: true, actorAccountId: true },
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        { action: "pm.global_time_marker.create", actorAccountId: administrator.account.id },
        { action: "pm.global_time_marker.update", actorAccountId: administrator.account.id },
        { action: "pm.global_time_marker.delete", actorAccountId: administrator.account.id },
      ]),
    );
    expect(await notificationCounts()).toEqual(notificationCountsBefore);
    } finally {
      const current = await getGlobalTimeMarkerCollection();
      const currentById = new Map(
        current.markers.map((marker) => [marker.id, marker]),
      );
      await saveGlobalTimeMarkerCollection(administrator.account.id, {
        expectedCollectionVersion: current.collectionVersion,
        markers: original.markers.map((marker) => ({
          ...marker,
          versionToken:
            currentById.get(marker.id)?.versionToken ?? marker.versionToken,
        })),
      });
    }
  });

  test("invalid marker payloads return stable validation errors", async () => {
    const administrator = await createAccountPerson(
      `关键时间点验证管理员 ${randomUUID()}`,
    );
    await prisma.systemRoleAssignment.create({
      data: {
        accountId: administrator.account.id,
        role: "SUPER_ADMINISTRATOR",
      },
    });
    const current = await getGlobalTimeMarkerCollection();
    const error = await saveGlobalTimeMarkerCollection(administrator.account.id, {
      expectedCollectionVersion: current.collectionVersion,
      markers: [{
        id: randomUUID(),
        name: " ",
        markedAt: "not-a-date",
        versionToken: null,
      }],
    }).catch((caught: unknown) => toProjectManagementServiceError(caught));
    expect(error).toMatchObject({ code: "VALIDATION_ERROR" });

    const validMarkers = Array.from({ length: 200 }, (_, index) => ({
      id: randomUUID(),
      name: index === 0 ? "长".repeat(100) : `边界时间点 ${index + 1}`,
      markedAt: "2026-09-18T02:30:00.000Z",
      versionToken: null,
    }));
    expect(saveGlobalTimeMarkersInputSchema.safeParse({
      expectedCollectionVersion: current.collectionVersion,
      markers: validMarkers,
    }).success).toBe(true);
    expect(saveGlobalTimeMarkersInputSchema.safeParse({
      expectedCollectionVersion: current.collectionVersion,
      markers: [
        ...validMarkers,
        {
          id: randomUUID(),
          name: "第 201 个",
          markedAt: "2026-09-18T02:30:00.000Z",
          versionToken: null,
        },
      ],
    }).success).toBe(false);
    expect(saveGlobalTimeMarkersInputSchema.safeParse({
      expectedCollectionVersion: current.collectionVersion,
      markers: [{ ...validMarkers[0]!, name: "超".repeat(101) }],
    }).success).toBe(false);
    expect(saveGlobalTimeMarkersInputSchema.safeParse({
      expectedCollectionVersion: current.collectionVersion,
      markers: [validMarkers[0]!, validMarkers[0]!],
    }).success).toBe(false);
    expect(saveGlobalTimeMarkersInputSchema.safeParse({
      expectedCollectionVersion: current.collectionVersion,
      markers: [{
        ...validMarkers[0]!,
        markedAt: "9999-12-31T23:59:59.999Z",
      }],
    }).success).toBe(false);

    await expect(
      prisma.globalTimeMarker.create({
        data: { name: " ", markedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`
        INSERT INTO "GlobalTimeMarker" (
          "id", "name", "markedAt", "updatedAt"
        ) VALUES (
          ${randomUUID()}, '数据库有限时间约束', 'infinity'::timestamptz, NOW()
        )
      `,
    ).rejects.toThrow();
    await expect(
      prisma.globalTimeMarker.create({
        data: {
          name: "数据库日期上限约束",
          markedAt: new Date("9999-12-31T23:59:59.999Z"),
        },
      }),
    ).rejects.toThrow();
  });

  test("停用超级管理员不能保存全局关键时间点", async () => {
    const administrator = await createAccountPerson(
      `停用关键时间点管理员 ${randomUUID()}`,
    );
    await prisma.systemRoleAssignment.create({
      data: {
        accountId: administrator.account.id,
        role: "SUPER_ADMINISTRATOR",
      },
    });
    await prisma.person.update({
      where: { id: administrator.person.id },
      data: { status: "INACTIVE" },
    });
    const current = await getGlobalTimeMarkerCollection();
    const markerId = randomUUID();

    await expect(
      saveGlobalTimeMarkerCollection(administrator.account.id, {
        expectedCollectionVersion: current.collectionVersion,
        markers: [
          ...current.markers,
          {
            id: markerId,
            name: "停用人员不得创建",
            markedAt: "2026-09-18T02:30:00.000Z",
            versionToken: null,
          },
        ],
      }),
    ).rejects.toThrow("人员已停用，无法执行此操作");
    await expect(
      prisma.globalTimeMarker.findUnique({ where: { id: markerId } }),
    ).resolves.toBeNull();
  });
});

async function notificationCounts() {
  const [inApp, outbox, recipients] = await Promise.all([
    prisma.inAppNotification.count(),
    prisma.notificationOutbox.count(),
    prisma.notificationOutboxRecipient.count(),
  ]);
  return { inApp, outbox, recipients };
}
