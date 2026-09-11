// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Prisma, ProjectManagementNotificationCategory } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { createProjectManagementEventNotificationsTx } from "../lib/project-management/application/notification-utils";
import type { ProjectManagementNotificationPayload } from "../lib/project-management/notifications/contract";

const EVENT_CASES: Array<[ProjectManagementNotificationPayload["kind"], ProjectManagementNotificationCategory]> = [
  ["task_assigned", "TASK"],
  ["task_updated", "TASK"],
  ["task_activated", "TASK"],
  ["task_deleted", "TASK"],
  ["task_terminated", "TASK"],
  ["milestone_due", "MILESTONE"],
  ["milestone_overdue", "MILESTONE"],
  ["milestone_review_submitted", "REVIEW"],
  ["milestone_review_result", "REVIEW"],
  ["termination_review_submitted", "REVIEW"],
  ["termination_review_result", "REVIEW"],
  ["revision_pending_review", "REVISION"],
  ["revision_result", "REVISION"],
  ["revision_applied", "REVISION"],
  ["revision_cancelled", "REVISION"],
  ["project_establishment_submitted", "PROJECT"],
  ["project_establishment_result", "PROJECT"],
  ["project_member_added", "PROJECT"],
  ["project_updated", "PROJECT"],
  ["project_task_changed", "PROJECT"],
  ["project_completed", "PROJECT"],
  ["project_deleted", "PROJECT"],
  ["risk_created", "TASK"],
  ["risk_resolved", "PROJECT"],
  ["comment_created", "TASK"],
];

async function withRollback(run: (tx: Prisma.TransactionClient) => Promise<void>) {
  expect(process.env.NOTIFICATION_DELIVERY_DISABLED).toBe("true");
  const rollback = new Error("rollback notification test fixtures");
  try {
    await prisma.$transaction(async (tx) => {
      await run(tx);
      throw rollback;
    }, { timeout: 30_000 });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function createRecipient(tx: Prisma.TransactionClient, options: {
  role?: "SUPER_ADMINISTRATOR" | "PROJECT_ADMINISTRATOR";
  team?: string;
  techGroup?: string;
  revoked?: boolean;
  inactive?: boolean;
  withoutIdentity?: boolean;
} = {}) {
  const openId = `ou_notification_${randomUUID()}`;
  const account = await tx.account.create({
    data: {
      person: { create: { displayName: "通知回归账号", status: options.inactive ? "INACTIVE" : "ACTIVE" } },
      identities: options.withoutIdentity ? undefined : {
        create: { provider: "FEISHU", tenantId: "default", providerSubject: `open:${openId}`, openId },
      },
      systemRoles: options.role ? {
        create: {
          role: options.role,
          team: options.team ?? "",
          techGroup: options.techGroup ?? "",
          revokedAt: options.revoked ? new Date() : null,
        },
      } : undefined,
    },
  });
  return { accountId: account.id, openId: options.withoutIdentity ? null : openId };
}

function eventInput(kind: ProjectManagementNotificationPayload["kind"], category: ProjectManagementNotificationCategory) {
  return {
    kind, category, eventKey: `pm:super-admin-test:${randomUUID()}`,
    actorName: "测试操作人", title: "项目通知", summary: "测试项目事件",
    entityType: "Task", entityId: randomUUID(), mandatory: false, recipients: [],
  };
}

test("all current project/task events append super administrators, preserve original recipients and deduplicate replays", async () => {
  await withRollback(async (tx) => {
    const original = await createRecipient(tx);
    const administrator = await createRecipient(tx, { role: "SUPER_ADMINISTRATOR" });
    const secondAdministrator = await createRecipient(tx, { role: "SUPER_ADMINISTRATOR" });
    await tx.systemRoleAssignment.create({ data: { accountId: administrator.accountId, role: "PROJECT_ADMINISTRATOR" } });
    for (const [kind, category] of EVENT_CASES) {
      const input = { ...eventInput(kind, category), recipients: [original, administrator, administrator] };
      await createProjectManagementEventNotificationsTx(tx, input);
      await createProjectManagementEventNotificationsTx(tx, input);
      const notifications = await tx.inAppNotification.findMany({ where: { eventKey: { startsWith: `${input.eventKey}:inapp:` } } });
      for (const recipient of [original, administrator, secondAdministrator]) {
        expect(notifications.filter((notification) => notification.recipientAccountId === recipient.accountId), kind).toHaveLength(1);
      }
      const outboxes = await tx.notificationOutbox.findMany({ where: { eventKey: `${input.eventKey}:feishu` } });
      expect(outboxes, kind).toHaveLength(1);
      const payload = JSON.parse(outboxes[0].payload) as ProjectManagementNotificationPayload;
      for (const recipient of [original, administrator, secondAdministrator]) {
        expect(payload.recipientOpenIds.filter((openId) => openId === recipient.openId), kind).toHaveLength(1);
      }
      const approval = ["milestone_review_submitted", "termination_review_submitted", "revision_pending_review", "project_establishment_submitted"].includes(kind);
      expect(outboxes[0].botKind).toBe(approval ? "approval" : "notification");
      expect(payload.purpose).toBe(approval ? "approval_request" : "notification");
    }
  });
});

test("super administrator eligibility and preferences apply even without original recipients", async () => {
  await withRollback(async (tx) => {
    const administrator = await createRecipient(tx, { role: "SUPER_ADMINISTRATOR" });
    const withoutIdentity = await createRecipient(tx, { role: "SUPER_ADMINISTRATOR", withoutIdentity: true });
    const excluded = [
      await createRecipient(tx, { role: "PROJECT_ADMINISTRATOR" }),
      await createRecipient(tx, { role: "SUPER_ADMINISTRATOR", revoked: true }),
      await createRecipient(tx, { role: "SUPER_ADMINISTRATOR", inactive: true }),
      await createRecipient(tx, { role: "SUPER_ADMINISTRATOR", team: "英雄", revoked: true }),
      await createRecipient(tx, { role: "SUPER_ADMINISTRATOR", techGroup: "电控", revoked: true }),
    ];
    await tx.notificationPreference.create({ data: { accountId: administrator.accountId, category: "TASK", channel: "FEISHU", enabled: false } });
    for (const mandatory of [false, true]) {
      const input = { ...eventInput("task_updated", "TASK"), mandatory };
      await createProjectManagementEventNotificationsTx(tx, input);
      const notifications = await tx.inAppNotification.findMany({ where: { eventKey: { startsWith: `${input.eventKey}:inapp:` } } });
      const accountIds = notifications.map((notification) => notification.recipientAccountId);
      expect(accountIds).toEqual(expect.arrayContaining([administrator.accountId, withoutIdentity.accountId]));
      for (const recipient of excluded) expect(accountIds).not.toContain(recipient.accountId);
      const outbox = await tx.notificationOutbox.findUnique({ where: { eventKey: `${input.eventKey}:feishu` } });
      const openIds = outbox ? (JSON.parse(outbox.payload) as ProjectManagementNotificationPayload).recipientOpenIds : [];
      expect(openIds.includes(administrator.openId!)).toBe(mandatory);
      for (const recipient of excluded) expect(openIds).not.toContain(recipient.openId);
    }
    await tx.systemRoleAssignment.updateMany({ where: { accountId: administrator.accountId }, data: { revokedAt: new Date() } });
    const input = eventInput("task_updated", "TASK");
    await createProjectManagementEventNotificationsTx(tx, input);
    expect(await tx.inAppNotification.count({ where: { eventKey: `${input.eventKey}:inapp:${administrator.accountId}` } })).toBe(0);
  });
});

test("account security and legacy revision-created events do not subscribe super administrators", async () => {
  await withRollback(async (tx) => {
    const administrator = await createRecipient(tx, { role: "SUPER_ADMINISTRATOR" });
    const original = await createRecipient(tx);
    for (const [kind, category] of [["account_security", "ACCOUNT_SECURITY"], ["revision_created", "REVISION"]] as const) {
      const input = { ...eventInput(kind, category), recipients: [original] };
      await createProjectManagementEventNotificationsTx(tx, input);
      const notifications = await tx.inAppNotification.findMany({ where: { eventKey: { startsWith: `${input.eventKey}:inapp:` } } });
      expect(notifications.map((notification) => notification.recipientAccountId)).toEqual([original.accountId]);
      const outbox = await tx.notificationOutbox.findUniqueOrThrow({ where: { eventKey: `${input.eventKey}:feishu` } });
      expect((JSON.parse(outbox.payload) as ProjectManagementNotificationPayload).recipientOpenIds).not.toContain(administrator.openId);
    }
  });
});

test("role grants only subscribe new events, not replays with outbox or in-app-only history", async () => {
  await withRollback(async (tx) => {
    const original = await createRecipient(tx);
    const administrator = await createRecipient(tx, { role: "SUPER_ADMINISTRATOR" });
    const laterAdministrator = await createRecipient(tx);
    const existingAdministrators = await tx.account.findMany({
      where: { person: { is: { status: "ACTIVE" } }, systemRoles: { some: { role: "SUPER_ADMINISTRATOR", team: "", techGroup: "", revokedAt: null } } },
      select: { id: true },
    });
    for (const accountId of [original.accountId, ...existingAdministrators.map((account) => account.id)]) {
      await tx.notificationPreference.upsert({
        where: { accountId_category_channel: { accountId, category: "PROJECT", channel: "FEISHU" } },
        create: { accountId, category: "PROJECT", channel: "FEISHU", enabled: false },
        update: { enabled: false },
      });
    }
    const inputs = [
      { ...eventInput("task_updated", "TASK"), recipients: [original] },
      { ...eventInput("project_updated", "PROJECT"), recipients: [original] },
    ];
    for (const input of inputs) await createProjectManagementEventNotificationsTx(tx, input);
    const previousOutbox = await tx.notificationOutbox.findUniqueOrThrow({ where: { eventKey: `${inputs[0].eventKey}:feishu` } });
    expect(await tx.notificationOutbox.count({ where: { eventKey: `${inputs[1].eventKey}:feishu` } })).toBe(0);
    await tx.systemRoleAssignment.create({ data: { accountId: laterAdministrator.accountId, role: "SUPER_ADMINISTRATOR" } });
    for (const input of inputs) {
      await createProjectManagementEventNotificationsTx(tx, input);
      expect(await tx.inAppNotification.count({ where: { eventKey: `${input.eventKey}:inapp:${laterAdministrator.accountId}` } })).toBe(0);
      expect(await tx.inAppNotification.count({ where: { eventKey: `${input.eventKey}:inapp:${administrator.accountId}` } })).toBe(1);
      const newInput = { ...input, eventKey: `pm:super-admin-test:${randomUUID()}` };
      await createProjectManagementEventNotificationsTx(tx, newInput);
      expect(await tx.inAppNotification.count({ where: { eventKey: `${newInput.eventKey}:inapp:${laterAdministrator.accountId}` } })).toBe(1);
      const newOutbox = await tx.notificationOutbox.findUniqueOrThrow({ where: { eventKey: `${newInput.eventKey}:feishu` } });
      expect((JSON.parse(newOutbox.payload) as ProjectManagementNotificationPayload).recipientOpenIds).toContain(laterAdministrator.openId);
    }
    expect((await tx.notificationOutbox.findUniqueOrThrow({ where: { id: previousOutbox.id } })).payload).toBe(previousOutbox.payload);
    expect(await tx.notificationOutbox.count({ where: { eventKey: `${inputs[1].eventKey}:feishu` } })).toBe(0);
  });
});
