// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { TaskMemberRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { activateTask, createRevision, createTaskDraft, reviewTermination, submitTerminationForReview } from "../lib/project-management/application/lifecycle-service";
import { batchCreatePlannedSegments, createActualSegment, createWorkSegment, updateWorkSegment } from "../lib/project-management/application/segment-service";
import { updateActiveTask } from "../lib/project-management/application/task-mutation-service";
import { getTaskWorkspace } from "../lib/project-management/queries/task-queries";

import {
  actor,
  approveCurrentMilestone,
  createAccountPerson,
  createDraft,
  currentPlan,
  currentTask,
  expectServiceError,
  grantRole,
  iso,
  jsonRecord,
  milestoneInput,
  mutationSideEffectCounts,
  segmentAssociationSideEffectSnapshot,
  segmentCreateInput,
  taskDraftInput,
  terminationInput,
  uniqueWhitespaceOpenId,
  updateActiveMetadataThroughCurrentInterface,
  updateDraftMetadataThroughCurrentInterface,
  updateDraftPlanThroughCurrentInterface,
  updateTaskMembersThroughCurrentInterface,
} from "./helpers/project-management-plan-mutation-fixtures";

test.describe("project management plan mutations project-management-plan-mutations-active", () => {
  test("Active metadata and members keep history, audit changes and enqueue guarded operator-accurate notifications", async () => {
      expect(process.env.NOTIFICATION_DELIVERY_DISABLED).toBe("true");
      expect(new URL(process.env.DATABASE_URL ?? "").pathname).toMatch(/_test$/);
      const admin = await createAccountPerson("S2 Active Admin");
      const owner = await createAccountPerson("S2 Active Owner");
      const reviewer = await createAccountPerson("S2 Active Reviewer");
      const member = await createAccountPerson("S2 Active Member");
      const newcomer = await createAccountPerson("S2 Active Newcomer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({
        creator: admin,
        owner,
        reviewer,
        extraMembers: [{ personId: member.person.id, role: "PARTICIPANT" }],
      });
      const activated = await activateTask(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
      });
      expect(activated.lockVersion).toBe(1);

      await expectServiceError(
        updateDraftMetadataThroughCurrentInterface(actor(owner), {
          taskId: fixture.taskId,
          expectedLockVersion: 1,
          title: "Draft-only metadata",
          description: "",
          team: "英雄",
          techGroup: "电控",
          priority: "HIGH",
          relatedTaskId: null,
        }),
        "STATE_CONFLICT",
      );
      await expectServiceError(
        updateDraftPlanThroughCurrentInterface(actor(owner), {
          taskId: fixture.taskId,
          planVersionId: fixture.currentPlanVersionId,
          expectedLockVersion: 1,
          plannedStartAt: iso(2026, 8, 1),
          milestones: [
            {
              clientKey: "active-task-cannot-replace-plan",
              ...milestoneInput("Active-only reject", 3),
            },
          ],
          termination: {
            clientKey: "active-task-cannot-replace-termination",
            ...terminationInput(8),
          },
        }),
        "STATE_CONFLICT",
      );

      const membersResult = await updateTaskMembersThroughCurrentInterface(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 1,
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: member.person.id, role: "PARTICIPANT" },
          { personId: newcomer.person.id, role: "PARTICIPANT" },
        ],
      });
      expect(membersResult.lockVersion).toBe(2);
      const activeMembers = await prisma.taskMember.findMany({
        where: { taskId: fixture.taskId, removedAt: null },
        select: { personId: true, role: true },
      });
      expect(activeMembers).toEqual(
        expect.arrayContaining([
          { personId: owner.person.id, role: "OWNER" },
          { personId: member.person.id, role: "PARTICIPANT" },
          { personId: newcomer.person.id, role: "PARTICIPANT" },
        ]),
      );
      expect(
        await prisma.taskMember.count({
          where: { taskId: fixture.taskId, removedAt: { not: null } },
        }),
      ).toBe(1);

      const memberOutbox = await prisma.notificationOutbox.findMany({
        where: {
          eventKey: { startsWith: `pm:task:member_changed:${fixture.taskId}:2:` },
        },
      });
      expect(memberOutbox).toHaveLength(2);
      for (const row of memberOutbox) {
        const payload = jsonRecord(JSON.parse(row.payload));
        expect(row).toMatchObject({
          channel: "project-management",
          type: "task_assigned",
          botKind: "notification",
        });
        expect(payload).toMatchObject({
          kind: "task_assigned",
          purpose: "notification",
          mandatory: true,
          actorName: admin.person.displayName === owner.person.displayName
            ? admin.person.displayName
            : owner.person.displayName,
          taskTitle: expect.any(String),
        });
        expect(String(payload.summary)).toContain(owner.person.displayName);
        const context = jsonRecord(payload.context);
        expect(context.result).toBe("SUCCESS");
        expect(String(payload.summary)).not.toContain("成员关系");
        if (context.changeKind === "ADDED") {
          expect(String(payload.summary)).toContain("已将你加入任务");
        } else if (context.changeKind === "REMOVED") {
          expect(String(payload.summary)).toContain("已将你移出任务");
        } else {
          expect(String(payload.summary)).toContain("已调整你在任务");
        }
      }
      expect(
        await prisma.inAppNotification.count({
          where: {
            eventKey: {
              startsWith: `pm:task:member_changed:${fixture.taskId}:2:`,
            },
          },
        }),
      ).toBe(2);
      expect(
        await prisma.notificationOutbox.count({
          where: { eventKey: `pm:task:${fixture.taskId}:updated:2:feishu` },
        }),
      ).toBe(0);

      const metadataResult = await updateActiveMetadataThroughCurrentInterface(actor(admin), {
        taskId: fixture.taskId,
        expectedLockVersion: 2,
        title: "Active metadata updated",
        description: "计划语义未改变",
        team: "英雄",
        techGroup: "电控",
        priority: "LOW",
        relatedTaskId: null,
      });
      expect(metadataResult.lockVersion).toBe(3);
      const metadataEventKey = `pm:task:${fixture.taskId}:updated:3`;
      const metadataOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey: `${metadataEventKey}:feishu` },
      });
      const metadataPayload = jsonRecord(JSON.parse(metadataOutbox.payload));
      expect(metadataOutbox).toMatchObject({
        type: "task_updated",
        channel: "project-management",
        botKind: "notification",
      });
      expect(metadataPayload).toMatchObject({
        kind: "task_updated",
        purpose: "notification",
        mandatory: false,
        actorName: admin.person.displayName,
        taskId: fixture.taskId,
        taskTitle: "Active metadata updated",
        linkPath: `/progress/tasks/${fixture.taskId}`,
      });
      expect(String(metadataPayload.summary)).toContain(
        "任务名称、任务内容、优先级",
      );
      expect(String(metadataPayload.summary)).not.toContain("计划语义未改变");
      expect(
        (metadataPayload.recipientOpenIds as string[]).slice().sort(),
      ).toEqual(
        [admin, owner, member, newcomer]
          .map((recipient) => recipient.openId)
          .sort(),
      );
      const metadataRecipients = await prisma.inAppNotification.findMany({
        where: { eventKey: { startsWith: `${metadataEventKey}:inapp:` } },
        select: { recipientAccountId: true },
      });
      expect(metadataRecipients.map((row) => row.recipientAccountId).sort()).toEqual(
        [admin, owner, member, newcomer]
          .map((recipient) => recipient.account.id)
          .sort(),
      );
      expect(
        await prisma.domainAuditEvent.count({
          where: {
            taskId: fixture.taskId,
            action: {
              in: [
                "pm.task.members.replace",
                "pm.task.metadata.update",
              ],
            },
          },
        }),
      ).toBe(2);

      const beforeStale = await mutationSideEffectCounts(fixture.taskId);
      await expectServiceError(
        updateTaskMembersThroughCurrentInterface(actor(owner), {
          taskId: fixture.taskId,
          expectedLockVersion: 2,
          members: membersResult.members,
        }),
        "STALE_TASK",
        { expectedCurrentLockVersion: 3 },
      );
      expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(beforeStale);
      const noOpResult = await updateTaskMembersThroughCurrentInterface(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 3,
        members: membersResult.members,
      });
      expect(noOpResult).toMatchObject({
        lockVersion: 3,
        members: membersResult.members,
      });
      expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(beforeStale);
    });

  test("Project-only Task updates keep the specialized event without task_updated", async () => {
      const admin = await createAccountPerson("S2 Project-only Admin");
      const owner = await createAccountPerson("S2 Project-only Owner");
      const reviewer = await createAccountPerson("S2 Project-only Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const project = await prisma.project.create({
        data: {
          name: "S2 Project-only Target",
          description: "仅验证 Task 所属项目变化",
          status: "ACTIVE",
          requesterAccountId: admin.account.id,
          members: {
            create: {
              personId: owner.person.id,
              role: "OWNER",
              createdByAccountId: admin.account.id,
            },
          },
        },
      });

      const draft = await createDraft({ creator: admin, owner, reviewer });
      const draftTask = await currentTask(draft.taskId);
      const draftResult = await updateDraftMetadataThroughCurrentInterface(actor(owner), {
        taskId: draft.taskId,
        expectedLockVersion: draftTask.lockVersion,
        title: draftTask.title,
        description: draftTask.description,
        team: draftTask.team as "英雄" | "工程",
        techGroup: draftTask.techGroup as "电控" | "机械",
        priority: draftTask.priority,
        relatedTaskId: draftTask.relatedTaskId,
        projectId: project.id,
      });
      expect(draftResult.lockVersion).toBe(1);
      expect(
        await prisma.notificationOutbox.count({
          where: { eventKey: `pm:task:${draft.taskId}:updated:1:feishu` },
        }),
      ).toBe(0);
      const draftProjectEvent = await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey: `pm:task:${draft.taskId}:project:1:feishu` },
      });
      expect(draftProjectEvent.type).toBe("project_task_changed");

      const active = await createDraft({ creator: admin, owner, reviewer });
      await activateTask(actor(owner), {
        taskId: active.taskId,
        expectedLockVersion: 0,
      });
      const activeTask = await currentTask(active.taskId);
      const activeResult = await updateActiveMetadataThroughCurrentInterface(actor(owner), {
        taskId: active.taskId,
        expectedLockVersion: activeTask.lockVersion,
        title: activeTask.title,
        description: activeTask.description,
        team: activeTask.team as "英雄" | "工程",
        techGroup: activeTask.techGroup as "电控" | "机械",
        priority: activeTask.priority,
        relatedTaskId: activeTask.relatedTaskId,
        projectId: project.id,
      });
      expect(activeResult.lockVersion).toBe(2);
      expect(
        await prisma.notificationOutbox.count({
          where: { eventKey: `pm:task:${active.taskId}:updated:2:feishu` },
        }),
      ).toBe(0);
      const activeProjectEvent = await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey: `pm:task:${active.taskId}:project:2:feishu` },
      });
      expect(activeProjectEvent.type).toBe("project_task_changed");
    });

  test("Active Task unified save is atomic and increments the lock once", async () => {
      const admin = await createAccountPerson("S2 Unified Active Admin");
      const owner = await createAccountPerson("S2 Unified Active Owner");
      const reviewer = await createAccountPerson("S2 Unified Active Reviewer");
      const newcomer = await createAccountPerson("S2 Unified Active Newcomer");
      const inactive = await createAccountPerson("S2 Unified Active Inactive");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({
        creator: admin,
        owner,
        reviewer,
      });
      await activateTask(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
      });

      const result = await updateActiveTask(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 1,
        metadata: {
          title: "统一保存后的 Active Task",
          description: "基本信息和成员一次提交",
          team: "英雄",
          techGroup: "电控",
          priority: "LOW",
          relatedTaskId: null,
        },
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: reviewer.person.id, role: "PARTICIPANT" },
          { personId: newcomer.person.id, role: "PARTICIPANT" },
        ],
      });
      expect(result).toMatchObject({
        lockVersion: 2,
        members: expect.arrayContaining([
          { personId: newcomer.person.id, role: "PARTICIPANT" },
        ]),
      });
      expect(
        await prisma.task.findUniqueOrThrow({
          where: { id: fixture.taskId },
          select: {
            title: true,
            description: true,
            priority: true,
            lockVersion: true,
            members: {
              where: { removedAt: null },
              select: { personId: true, role: true },
            },
          },
        }),
      ).toMatchObject({
        title: "统一保存后的 Active Task",
        description: "基本信息和成员一次提交",
        priority: "LOW",
        lockVersion: 2,
        members: expect.arrayContaining([
          { personId: owner.person.id, role: "OWNER" },
          { personId: newcomer.person.id, role: "PARTICIPANT" },
        ]),
      });
      expect(
        await prisma.domainAuditEvent.count({
          where: {
            taskId: fixture.taskId,
            action: {
              in: [
                "pm.task.metadata.update",
                "pm.task.members.replace",
              ],
            },
          },
        }),
      ).toBe(2);

      const unifiedAudits = await prisma.domainAuditEvent.findMany({
        where: {
          taskId: fixture.taskId,
          action: {
            in: [
              "pm.task.metadata.update",
              "pm.task.members.replace",
            ],
          },
        },
      });
      expect(unifiedAudits.map((audit) => audit.action).sort()).toEqual([
        "pm.task.members.replace",
        "pm.task.metadata.update",
      ]);
      for (const audit of unifiedAudits) {
        expect(jsonRecord(audit.after).lockVersion).toBe(2);
      }
      expect(
        jsonRecord(
          unifiedAudits.find((audit) => audit.action === "pm.task.metadata.update")
            ?.after,
        ),
      ).toMatchObject({
        title: "统一保存后的 Active Task",
        priority: "LOW",
      });
      expect(
        jsonRecord(
          unifiedAudits.find((audit) => audit.action === "pm.task.members.replace")
            ?.after,
        ).members,
      ).toEqual(
        expect.arrayContaining([
          { personId: newcomer.person.id, role: "PARTICIPANT" },
        ]),
      );

      const memberEventPrefix = `pm:task:member_changed:${fixture.taskId}:2:`;
      const memberOutboxes = await prisma.notificationOutbox.findMany({
        where: { eventKey: { startsWith: memberEventPrefix } },
      });
      expect(memberOutboxes).toHaveLength(1);
      expect(memberOutboxes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventKey: `${memberEventPrefix}${newcomer.person.id}:feishu`,
            type: "task_assigned",
            botKind: "notification",
          }),
        ]),
      );
      expect(
        memberOutboxes.map((outbox) =>
          jsonRecord(JSON.parse(outbox.payload)),
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "task_assigned",
            linkPath: `/progress/tasks/${fixture.taskId}`,
            purpose: "notification",
            mandatory: true,
            actorName: owner.person.displayName,
            context: expect.objectContaining({
              changeKind: "ADDED",
              affectedPersonId: newcomer.person.id,
            }),
          }),
        ]),
      );
      const taskUpdateEventKey = `pm:task:${fixture.taskId}:updated:2`;
      const taskUpdateOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey: `${taskUpdateEventKey}:feishu` },
      });
      expect(taskUpdateOutbox).toMatchObject({
        type: "task_updated",
        channel: "project-management",
        botKind: "notification",
      });
      const taskUpdatePayload = jsonRecord(JSON.parse(taskUpdateOutbox.payload));
      expect(taskUpdatePayload).toMatchObject({
        kind: "task_updated",
        mandatory: false,
        taskId: fixture.taskId,
        linkPath: `/progress/tasks/${fixture.taskId}`,
      });
      expect(String(taskUpdatePayload.summary)).toContain(
        "任务名称、任务内容、优先级",
      );
      const taskUpdateNotifications = await prisma.inAppNotification.findMany({
        where: { eventKey: { startsWith: `${taskUpdateEventKey}:inapp:` } },
        select: { recipientAccountId: true },
      });
      expect(
        taskUpdateNotifications.map((row) => row.recipientAccountId).sort(),
      ).toEqual(
        [owner, reviewer, newcomer]
          .map((recipient) => recipient.account.id)
          .sort(),
      );
      const memberNotifications = await prisma.inAppNotification.findMany({
        where: { eventKey: { startsWith: memberEventPrefix } },
        select: { recipientAccountId: true, linkPath: true },
      });
      expect(memberNotifications).toEqual([
        {
          recipientAccountId: newcomer.account.id,
          linkPath: `/progress/tasks/${fixture.taskId}`,
        },
      ]);

      const unchangedInput = {
        taskId: fixture.taskId,
        expectedLockVersion: 2,
        metadata: {
          title: "统一保存后的 Active Task",
          description: "基本信息和成员一次提交",
          team: "英雄" as const,
          techGroup: "电控" as const,
          priority: "LOW" as const,
          relatedTaskId: null,
        },
        members: [
          { personId: owner.person.id, role: "OWNER" as const },
          { personId: reviewer.person.id, role: "PARTICIPANT" as const },
          { personId: newcomer.person.id, role: "PARTICIPANT" as const },
        ],
      };
      const beforeUnchangedSave = await mutationSideEffectCounts(fixture.taskId);
      expect(await updateActiveTask(actor(owner), unchangedInput)).toMatchObject({
        lockVersion: 2,
      });
      expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(
        beforeUnchangedSave,
      );

      const participantResult = await updateActiveTask(actor(reviewer), {
        taskId: fixture.taskId,
        expectedLockVersion: 2,
        metadata: {
          ...unchangedInput.metadata,
          description: "Participant 可统一保存元数据",
          priority: "MEDIUM",
        },
      });
      expect(participantResult).toMatchObject({
        lockVersion: 3,
      });

      const beforeForbiddenMembers = await mutationSideEffectCounts(fixture.taskId);
      await expectServiceError(
        updateActiveTask(actor(reviewer), {
          taskId: fixture.taskId,
          expectedLockVersion: 3,
          members: [
            { personId: owner.person.id, role: "OWNER" },
            { personId: reviewer.person.id, role: "PARTICIPANT" },
          ],
        }),
        "FORBIDDEN",
      );
      expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(
        beforeForbiddenMembers,
      );

      await prisma.person.update({
        where: { id: inactive.person.id },
        data: { status: "INACTIVE" },
      });
      const beforeFailure = await mutationSideEffectCounts(fixture.taskId);
      await expectServiceError(
        updateActiveTask(actor(owner), {
          taskId: fixture.taskId,
          expectedLockVersion: 3,
          metadata: {
            title: "不应部分保存的标题",
            description: "应随成员校验失败完整回滚",
            team: "英雄",
            techGroup: "电控",
            priority: "HIGH",
            relatedTaskId: null,
          },
          members: [
            { personId: owner.person.id, role: "OWNER" },
            { personId: inactive.person.id, role: "PARTICIPANT" },
          ],
        }),
        "VALIDATION_ERROR",
      );
      expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(beforeFailure);
      expect(
        await prisma.task.findUniqueOrThrow({
          where: { id: fixture.taskId },
          select: { title: true, priority: true, lockVersion: true },
        }),
      ).toEqual({
        title: "统一保存后的 Active Task",
        priority: "MEDIUM",
        lockVersion: 3,
      });
    });

  test("Draft and Active member replacements reject every invalid member set without writes", async () => {
      const admin = await createAccountPerson("S2 Invalid Members Admin");
      const owner = await createAccountPerson("S2 Invalid Members Owner");
      const reviewer = await createAccountPerson("S2 Invalid Members Reviewer");
      const inactive = await createAccountPerson("S2 Invalid Members Inactive");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      await prisma.person.update({
        where: { id: inactive.person.id },
        data: { status: "INACTIVE" },
      });

      for (const requiredStatus of ["DRAFT", "ACTIVE"] as const) {
        const fixture = await createDraft({ creator: admin, owner, reviewer });
        if (requiredStatus === "ACTIVE") {
          await activateTask(actor(owner), {
            taskId: fixture.taskId,
            expectedLockVersion: 0,
          });
        }
        const task = await currentTask(fixture.taskId);
        const invalidSets: Array<Array<{ personId: string; role: TaskMemberRole }>> = [
          [
            { personId: owner.person.id, role: "OWNER" },
            { personId: reviewer.person.id, role: "PARTICIPANT" },
            { personId: reviewer.person.id, role: "PARTICIPANT" },
          ],
          [
            { personId: owner.person.id, role: "OWNER" },
            { personId: inactive.person.id, role: "PARTICIPANT" },
          ],
        ];
        if (requiredStatus === "ACTIVE") {
          invalidSets.unshift([
            { personId: reviewer.person.id, role: "PARTICIPANT" },
          ]);
        }
        for (const members of invalidSets) {
          const before = await mutationSideEffectCounts(fixture.taskId);
          await expectServiceError(
            requiredStatus === "DRAFT"
              ? updateTaskMembersThroughCurrentInterface(actor(owner), {
                  taskId: fixture.taskId,
                  expectedLockVersion: task.lockVersion,
                  members,
                })
              : updateTaskMembersThroughCurrentInterface(actor(owner), {
                  taskId: fixture.taskId,
                  expectedLockVersion: task.lockVersion,
                  members,
                }),
            "VALIDATION_ERROR",
          );
          expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(before);
        }
      }
    });

  test("mandatory Active member events use only non-empty default-tenant Feishu identities", async () => {
      expect(process.env.NOTIFICATION_DELIVERY_DISABLED).toBe("true");
      const admin = await createAccountPerson("S2 Missing Recipient Admin");
      const owner = await createAccountPerson("S2 Missing Recipient Owner");
      const reviewer = await createAccountPerson("S2 Missing Recipient Reviewer");
      const inactive = await createAccountPerson("S2 Missing Recipient Inactive");
      const wrongTenant = await createAccountPerson("S2 Wrong Tenant Recipient");
      const firstBlankThenValid = await createAccountPerson(
        "S2 First Blank Then Valid Recipient",
      );
      const bound = await createAccountPerson("S2 Bound Recipient");
      const emptyOpenId = await createAccountPerson("S2 Empty OpenId Recipient");
      const missingIdentity = await createAccountPerson(
        "S2 Missing Identity Recipient",
      );
      const noAccountPerson = await prisma.person.create({
        data: {
          displayName: "S2 Missing Recipient No Account",
          status: "ACTIVE",
        },
      });
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({
        creator: admin,
        owner,
        reviewer,
        extraMembers: [
          { personId: inactive.person.id, role: "PARTICIPANT" },
          { personId: wrongTenant.person.id, role: "PARTICIPANT" },
          { personId: firstBlankThenValid.person.id, role: "PARTICIPANT" },
          { personId: bound.person.id, role: "PARTICIPANT" },
          { personId: emptyOpenId.person.id, role: "PARTICIPANT" },
          { personId: missingIdentity.person.id, role: "PARTICIPANT" },
          { personId: noAccountPerson.id, role: "PARTICIPANT" },
        ],
      });
      await activateTask(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
      });
      await prisma.person.update({
        where: { id: inactive.person.id },
        data: { status: "INACTIVE" },
      });
      await prisma.accountIdentity.deleteMany({
        where: { accountId: wrongTenant.account.id },
      });
      const wrongTenantOpenId = `ou_wrong_tenant_${randomUUID()}`;
      await prisma.accountIdentity.create({
        data: {
          accountId: wrongTenant.account.id,
          provider: "FEISHU",
          tenantId: "other-tenant",
          providerSubject: `open:${wrongTenantOpenId}`,
          openId: wrongTenantOpenId,
        },
      });
      await prisma.accountIdentity.updateMany({
        where: { accountId: firstBlankThenValid.account.id, tenantId: "default" },
        data: { openId: uniqueWhitespaceOpenId(firstBlankThenValid.account.id) },
      });
      const laterValidOpenId = `ou_later_valid_${randomUUID()}`;
      await prisma.accountIdentity.create({
        data: {
          accountId: firstBlankThenValid.account.id,
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${laterValidOpenId}`,
          openId: `  ${laterValidOpenId}  `,
        },
      });
      await prisma.accountIdentity.updateMany({
        where: { accountId: emptyOpenId.account.id, tenantId: "default" },
        data: { openId: uniqueWhitespaceOpenId(emptyOpenId.account.id) },
      });
      await prisma.accountIdentity.deleteMany({
        where: { accountId: missingIdentity.account.id },
      });

      const result = await updateTaskMembersThroughCurrentInterface(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 1,
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: reviewer.person.id, role: "PARTICIPANT" },
        ],
      });
      expect(result.lockVersion).toBe(2);
      const outboxes = await prisma.notificationOutbox.findMany({
        where: {
          eventKey: { startsWith: `pm:task:member_changed:${fixture.taskId}:2:` },
        },
        orderBy: { eventKey: "asc" },
      });
      expect(outboxes).toHaveLength(7);
      const payloadByPersonId = new Map<string, Record<string, unknown>>();
      for (const outbox of outboxes) {
        expect(outbox).toMatchObject({
          status: "PENDING",
          channel: "project-management",
          botKind: "notification",
        });
        const payload = jsonRecord(JSON.parse(outbox.payload));
        expect(payload).toMatchObject({
          mandatory: true,
          purpose: "notification",
        });
        expect(JSON.stringify(payload)).not.toContain(wrongTenantOpenId);
        const context = jsonRecord(payload.context);
        payloadByPersonId.set(String(context.affectedPersonId), payload);
      }
      expect(payloadByPersonId.get(inactive.person.id)).toMatchObject({
        recipientOpenIds: [],
        context: { recipientResolution: "PERSON_INACTIVE" },
      });
      expect(payloadByPersonId.get(noAccountPerson.id)).toMatchObject({
        recipientOpenIds: [],
        context: { recipientResolution: "ACCOUNT_MISSING" },
      });
      expect(payloadByPersonId.get(bound.person.id)).toMatchObject({
        recipientOpenIds: [bound.openId],
        context: { recipientResolution: "RESOLVED" },
      });
      expect(payloadByPersonId.get(wrongTenant.person.id)).toMatchObject({
        recipientOpenIds: [],
        context: { recipientResolution: "DEFAULT_FEISHU_IDENTITY_MISSING" },
      });
      expect(payloadByPersonId.get(missingIdentity.person.id)).toMatchObject({
        recipientOpenIds: [],
        context: { recipientResolution: "DEFAULT_FEISHU_IDENTITY_MISSING" },
      });
      expect(payloadByPersonId.get(emptyOpenId.person.id)).toMatchObject({
        recipientOpenIds: [],
        context: { recipientResolution: "FEISHU_OPEN_ID_MISSING" },
      });
      expect(payloadByPersonId.get(firstBlankThenValid.person.id)).toMatchObject({
        recipientOpenIds: [laterValidOpenId],
        context: { recipientResolution: "RESOLVED" },
      });
      const inAppRows = await prisma.inAppNotification.findMany({
        where: {
          eventKey: {
            startsWith: `pm:task:member_changed:${fixture.taskId}:2:`,
          },
        },
        select: { recipientAccountId: true },
      });
      expect(inAppRows.map((row) => row.recipientAccountId).sort()).toEqual(
        [
          bound.account.id,
          wrongTenant.account.id,
          firstBlankThenValid.account.id,
          emptyOpenId.account.id,
          missingIdentity.account.id,
        ].sort(),
      );
      expect(
        await prisma.notificationOutboxRecipient.count({
          where: { outboxId: { in: outboxes.map((outbox) => outbox.id) } },
        }),
      ).toBe(0);
    });

  test("prospective Segment Task references distinguish missing IDs from visible Tasks that reject non-member writes", async () => {
      const admin = await createAccountPerson("S2 Segment Oracle Admin");
      const hiddenOwner = await createAccountPerson("S2 Segment Oracle Hidden Owner");
      const hiddenReviewer = await createAccountPerson(
        "S2 Segment Oracle Hidden Reviewer",
      );
      const operator = await createAccountPerson("S2 Segment Oracle Operator");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const hidden = await createDraft({
        creator: admin,
        owner: hiddenOwner,
        reviewer: hiddenReviewer,
        title: "S2 hidden association target",
      });
      const updateBase = await createWorkSegment(actor(operator), {
        ...segmentCreateInput(operator.person.id, "oracle update base"),
        type: "PLANNED",
      });
      const reloadedUpdate = await prisma.workSegment.findUniqueOrThrow({
        where: { id: updateBase.segment.id },
      });

      const cases: Array<{
        name: string;
        invoke: (taskId: string) => Promise<unknown>;
      }> = [
        {
          name: "single Planned",
          invoke: (taskId) =>
            createWorkSegment(actor(operator), {
              ...segmentCreateInput(operator.person.id, "oracle single", 5),
              type: "PLANNED",
              taskId,
            }),
        },
        {
          name: "batch Planned",
          invoke: (taskId) =>
            batchCreatePlannedSegments(actor(operator), {
              segments: [
                {
                  ...segmentCreateInput(operator.person.id, "oracle batch", 7),
                  type: "PLANNED",
                  taskId,
                },
              ],
            }),
        },
        {
          name: "Actual",
          invoke: (taskId) =>
            createActualSegment(actor(operator), {
              ...segmentCreateInput(operator.person.id, "oracle actual", 9),
              taskId,
              actualOutput: "oracle actual output",
              sources: [],
            }),
        },
        {
          name: "update",
          invoke: (taskId) =>
            updateWorkSegment(actor(operator), {
              segmentId: reloadedUpdate.id,
              expectedUpdatedAt: reloadedUpdate.updatedAt,
              taskId,
              reason: "oracle update",
            }),
        },
      ];

      for (const associationCase of cases) {
        for (const target of [
          {
            taskId: randomUUID(),
            expectedCode: "NOT_FOUND" as const,
          },
          {
            taskId: hidden.taskId,
            expectedCode: "ASSOCIATION_INVALID" as const,
          },
        ]) {
          const before = await segmentAssociationSideEffectSnapshot([
            updateBase.segment.id,
          ]);
          await expectServiceError(
            associationCase.invoke(target.taskId),
            target.expectedCode,
          );
          expect(
            await segmentAssociationSideEffectSnapshot([updateBase.segment.id]),
            associationCase.name,
          ).toEqual(before);
        }
      }
    });

  test("legacy Active chronology remains readable and closable but cannot enter a non-strict Revision target", async () => {
      const admin = await createAccountPerson("S2 Legacy Repair Admin");
      const owner = await createAccountPerson("S2 Legacy Repair Owner");
      const reviewer = await createAccountPerson("S2 Legacy Repair Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const legacyInput = taskDraftInput({
        ownerPersonId: owner.person.id,
        reviewerPersonId: reviewer.person.id,
        title: "S2 legacy carried prefix repair",
      });
      legacyInput.milestones = [
        milestoneInput("Legacy M1", 2),
        milestoneInput("Legacy M2", 4),
        milestoneInput("Legacy M3", 6),
      ];
      const legacy = await createTaskDraft(actor(admin), legacyInput);
      await activateTask(actor(owner), {
        taskId: legacy.taskId,
        expectedLockVersion: 0,
      });
      await approveCurrentMilestone(legacy.taskId, owner, admin, "legacy-1");
      await approveCurrentMilestone(legacy.taskId, owner, admin, "legacy-2");
      const legacyPlan = await currentPlan(legacy.taskId);
      const carriedMilestones = legacyPlan.nodes.filter(
        (entry) => entry.node.type === "MILESTONE" && entry.node.status === "COMPLETED",
      );
      const active = legacyPlan.nodes.find(
        (entry) => entry.node.type === "MILESTONE" && entry.node.status === "ACTIVE",
      );
      if (carriedMilestones.length !== 2 || !active) {
        throw new Error("缺少 legacy carried prefix");
      }
      await prisma.taskPlanVersion.update({
        where: { id: legacy.currentPlanVersionId },
        data: { plannedStartAt: null },
      });
      await prisma.milestoneNode.update({
        where: { nodeId: carriedMilestones[0]?.nodeId },
        data: { expectedCompletedAt: new Date(iso(2026, 8, 4)) },
      });
      await prisma.milestoneNode.update({
        where: { nodeId: carriedMilestones[1]?.nodeId },
        data: { expectedCompletedAt: new Date(iso(2026, 8, 2)) },
      });
      const legacyWorkspace = await getTaskWorkspace({
        actor: actor(owner),
        taskId: legacy.taskId,
      });
      expect(legacyWorkspace.currentPlan.chronologyCompatibilityIssues.length).toBeGreaterThan(0);
      const legacyTask = await currentTask(legacy.taskId);
      await expectServiceError(
        createRevision(actor(owner), {
          taskId: legacy.taskId,
          basePlanVersionId: legacy.currentPlanVersionId,
          baseTaskLockVersion: legacyTask.lockVersion,
          reason: "修复 legacy Current chronology",
          description: "修复 legacy Current chronology",
          revisionAt: iso(2026, 8, 2),
          replacementMilestones: [milestoneInput("Repaired M3", 6)],
          termination: terminationInput(8),
          idempotencyKey: `s2-legacy-repair-${randomUUID()}`,
        }),
        "PLAN_CHRONOLOGY_INVALID",
      );

      const closeFixture = await createDraft({
        creator: admin,
        owner: await createAccountPerson("S2 Legacy Close Owner"),
        reviewer,
        title: "S2 legacy termination",
      });
      await activateTask(actor(closeFixture.owner), {
        taskId: closeFixture.taskId,
        expectedLockVersion: 0,
      });
      const closePlan = await currentPlan(closeFixture.taskId);
      const closeMilestones = closePlan.nodes.filter(
        (entry) => entry.node.milestone,
      );
      const closeTermination = closePlan.nodes.at(-1);
      if (closeMilestones.length !== 2 || !closeTermination?.node.termination) {
        throw new Error("缺少 legacy termination fixture");
      }
      await prisma.taskPlanVersion.update({
        where: { id: closeFixture.currentPlanVersionId },
        data: { plannedStartAt: null },
      });
      await prisma.milestoneNode.update({
        where: { nodeId: closeMilestones[0]?.nodeId },
        data: { expectedCompletedAt: new Date(iso(2026, 8, 5)) },
      });
      await prisma.milestoneNode.update({
        where: { nodeId: closeMilestones[1]?.nodeId },
        data: { expectedCompletedAt: new Date(iso(2026, 8, 3)) },
      });
      const terminationReview = await submitTerminationForReview(
        actor(closeFixture.owner),
        {
          terminationNodeId: closeTermination.nodeId,
          outcome: "FAILED",
          reason: "legacy 计划无法继续，安全结束",
          summary: "保留历史后结束",
          idempotencyKey: `legacy-termination-${randomUUID()}`,
        },
      );
      expect(
        await reviewTermination(actor(admin), {
          reviewId: terminationReview.reviewId,
          result: "APPROVED",
          comment: "同意安全结束 legacy 计划",
        }),
      ).toMatchObject({ taskStatus: "FAILED", outcome: "FAILED" });
    });
});
