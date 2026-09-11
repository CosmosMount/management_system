// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { updateProject } from "../lib/project-management/application/project-service";
import { expectedProjectManagementRecipients } from "./helpers/project-management-notification-recipients";
import {
  actor,
  createAccountPerson,
  expectServiceError,
  jsonRecord,
  serviceOutcomeCodes,
} from "./helpers/project-management-plan-mutation-fixtures";

test.describe("project management project update notifications", () => {
  test("Active Project update sends one aggregate event to requester, actor, before/after members and super administrators", async () => {
    expect(process.env.NOTIFICATION_DELIVERY_DISABLED).toBe("true");
    expect(new URL(process.env.DATABASE_URL ?? "").pathname).toMatch(/_test$/);

    const requester = await createAccountPerson("Project Update Requester");
    const owner = await createAccountPerson("Project Update Owner");
    const removedMember = await createAccountPerson("Project Update Removed");
    const addedMember = await createAccountPerson("Project Update Added");
    const outsider = await createAccountPerson("Project Update Outsider");
    const project = await prisma.project.create({
      data: {
        name: "更新前项目",
        description: "更新前项目内容",
        status: "ACTIVE",
        requesterAccountId: requester.account.id,
        members: {
          create: [
            {
              personId: owner.person.id,
              role: "OWNER",
              createdByAccountId: requester.account.id,
            },
            {
              personId: removedMember.person.id,
              role: "PARTICIPANT",
              createdByAccountId: requester.account.id,
            },
          ],
        },
      },
    });
    const avatarPath = `/uploads/project-avatars/${randomUUID()}.webp`;
    await prisma.fileAsset.create({
      data: {
        publicPath: avatarPath,
        storagePath: `/tmp/${randomUUID()}.webp`,
        kind: "PROJECT_AVATAR",
        mimeType: "image/webp",
        size: 128,
        ownerOpenId: owner.openId,
      },
    });
    const sensitiveDescription = `不应进入消息正文 ${randomUUID()}`;
    const requestedMembers = [
      { personId: owner.person.id, role: "OWNER" as const },
      { personId: addedMember.person.id, role: "PARTICIPANT" as const },
    ];

    const administrator = await createAccountPerson("Project Update Super Administrator");
    const administratorRole = await prisma.systemRoleAssignment.create({
      data: { accountId: administrator.account.id, role: "SUPER_ADMINISTRATOR" },
    });
    const updated = await updateProject(actor(owner), {
      projectId: project.id,
      expectedLockVersion: 0,
      name: "更新后项目",
      description: sensitiveDescription,
      avatarPath,
      members: requestedMembers,
    }).finally(async () => {
      await prisma.systemRoleAssignment.update({
        where: { id: administratorRole.id },
        data: { revokedAt: new Date() },
      });
    });
    expect(updated.lockVersion).toBe(1);

    const eventKey = `pm:project:${project.id}:updated:1`;
    const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey: `${eventKey}:feishu` },
    });
    expect(outbox).toMatchObject({
      type: "project_updated",
      channel: "project-management",
      botKind: "notification",
    });
    const payload = jsonRecord(JSON.parse(outbox.payload));
    expect(payload).toMatchObject({
      kind: "project_updated",
      purpose: "notification",
      mandatory: false,
      actorName: owner.person.displayName,
      projectId: project.id,
      projectName: "更新后项目",
      linkPath: `/progress/projects/${project.id}`,
    });
    expect(String(payload.summary)).toContain(
      "项目名称、项目内容、项目头像、项目成员",
    );
    expect(String(payload.summary)).not.toContain(sensitiveDescription);
    expect(JSON.stringify(payload)).not.toContain(avatarPath);
    expect(JSON.stringify(payload)).not.toContain(removedMember.person.id);
    expect(JSON.stringify(payload)).not.toContain(addedMember.person.id);
    const expectedRecipients = await expectedProjectManagementRecipients(
      [requester, owner, removedMember, addedMember, administrator], "PROJECT",
    );
    expect((payload.recipientOpenIds as string[]).slice().sort()).toEqual(expectedRecipients.openIds);

    const notifications = await prisma.inAppNotification.findMany({
      where: { eventKey: { startsWith: `${eventKey}:inapp:` } },
      select: { recipientAccountId: true, linkPath: true },
    });
    expect(notifications.map((notification) => notification.recipientAccountId).sort()).toEqual(expectedRecipients.accountIds);
    expect(notifications).toEqual(
      expect.arrayContaining(
        [requester, owner, removedMember, addedMember, administrator].map((recipient) => ({
          recipientAccountId: recipient.account.id,
          linkPath: `/progress/projects/${project.id}`,
        })),
      ),
    );
    expect(
      await prisma.notificationOutbox.count({
        where: { eventKey: { startsWith: `pm:project:${project.id}:member:` } },
      }),
    ).toBe(0);
    expect(
      await prisma.projectMember.findMany({
        where: { projectId: project.id, removedAt: null },
        select: { personId: true, role: true },
        orderBy: { personId: "asc" },
      }),
    ).toEqual(
      requestedMembers
        .map((member) => ({ personId: member.personId, role: member.role }))
        .sort((left, right) => left.personId.localeCompare(right.personId)),
    );

    const noOp = await updateProject(actor(owner), {
      projectId: project.id,
      expectedLockVersion: 1,
      name: "更新后项目",
      description: sensitiveDescription,
      avatarPath,
      members: requestedMembers,
    });
    expect(noOp.lockVersion).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: { eventKey: { startsWith: `pm:project:${project.id}:updated:` } },
      }),
    ).toBe(1);

    await expectServiceError(
      updateProject(actor(outsider), {
        projectId: project.id,
        expectedLockVersion: 1,
        name: "无权修改",
        description: sensitiveDescription,
        avatarPath,
        members: requestedMembers,
      }),
      "FORBIDDEN",
    );
    expect(
      await prisma.notificationOutbox.count({
        where: { eventKey: { startsWith: `pm:project:${project.id}:updated:` } },
      }),
    ).toBe(1);
  });

  test("concurrent Project updates increment once and enqueue project_updated exactly once", async () => {
    expect(process.env.NOTIFICATION_DELIVERY_DISABLED).toBe("true");
    expect(new URL(process.env.DATABASE_URL ?? "").pathname).toMatch(/_test$/);

    const requester = await createAccountPerson("Project Update Concurrent Requester");
    const owner = await createAccountPerson("Project Update Concurrent Owner");
    const project = await prisma.project.create({
      data: {
        name: "并发更新前项目",
        description: "并发更新前内容",
        status: "ACTIVE",
        requesterAccountId: requester.account.id,
        members: {
          create: {
            personId: owner.person.id,
            role: "OWNER",
            createdByAccountId: requester.account.id,
          },
        },
      },
    });
    const updateInput = {
      projectId: project.id,
      expectedLockVersion: 0,
      name: "并发更新后项目",
      description: "并发更新后内容",
      avatarPath: null,
      members: [{ personId: owner.person.id, role: "OWNER" as const }],
    };

    const outcomes = await Promise.allSettled([
      updateProject(actor(owner), updateInput),
      updateProject(actor(owner), updateInput),
    ]);
    expect(serviceOutcomeCodes(outcomes)).toEqual(["OK", "STATE_CONFLICT"]);

    expect(
      await prisma.project.findUniqueOrThrow({
        where: { id: project.id },
        select: { name: true, description: true, lockVersion: true },
      }),
    ).toEqual({
      name: "并发更新后项目",
      description: "并发更新后内容",
      lockVersion: 1,
    });
    const eventKeyPrefix = `pm:project:${project.id}:updated:`;
    expect(
      await prisma.notificationOutbox.count({
        where: {
          type: "project_updated",
          eventKey: { startsWith: eventKeyPrefix },
        },
      }),
    ).toBe(1);
    expect(
      await prisma.inAppNotification.count({
        where: { eventKey: { startsWith: eventKeyPrefix } },
      }),
    ).toBe((await expectedProjectManagementRecipients([requester, owner], "PROJECT")).accountIds.length);
  });
});
