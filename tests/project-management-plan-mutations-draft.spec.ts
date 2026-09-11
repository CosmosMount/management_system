// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { activateTask, approveRevision, createRevision, createTaskDraft, reviewMilestone, submitMilestoneForReview } from "../lib/project-management/application/lifecycle-service";
import { updateTaskDraft } from "../lib/project-management/application/task-mutation-service";
import { absoluteDateTimeSchema } from "../lib/project-management/validations/lifecycle";
import { expectedProjectManagementRecipients } from "./helpers/project-management-notification-recipients";

import {
  UUID_PATTERN,
  actor,
  createAccountPerson,
  createDraft,
  createSegmentReference,
  currentPlan,
  currentTask,
  draftPlanReplaceInput,
  expectServiceError,
  fixtureMembers,
  grantRole,
  iso,
  jsonRecord,
  milestoneInput,
  mutationSideEffectCounts,
  planById,
  planMilestoneReplacement,
  planTerminationReplacement,
  relatedTaskReferenceSideEffectSnapshot,
  taskDraftInput,
  terminationInput,
  updateActiveMetadataThroughCurrentInterface,
  updateDraftMetadataThroughCurrentInterface,
  updateDraftPlanThroughCurrentInterface,
  updateTaskMembersThroughCurrentInterface,
} from "./helpers/project-management-plan-mutation-fixtures";

test.describe("project management plan mutations project-management-plan-mutations-draft", () => {
  test("public absolute date-time boundary accepts only offset strings", async () => {
      const schema = absoluteDateTimeSchema("请选择带时区的时间");
      expect(schema.safeParse(new Date("2026-08-01T10:00:00.000Z")).success).toBe(
        false,
      );
      expect(schema.safeParse("2026-08-01T10:00:00").success).toBe(false);
      const parsed = schema.parse("2026-08-01T18:00:00+08:00");
      expect(parsed.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    });

  test("create persists planned start and globally readable related Task with chronology-safe hashes", async () => {
      const admin = await createAccountPerson("S2 System Admin");
      const owner = await createAccountPerson("S2 Create Owner");
      const reviewer = await createAccountPerson("S2 Create Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");

      const related = await createDraft({
        creator: admin,
        owner,
        reviewer,
        title: "可见关联 Task",
      });
      const input = taskDraftInput({
        ownerPersonId: owner.person.id,
        reviewerPersonId: reviewer.person.id,
        title: "计划字段持久化 Task",
        relatedTaskId: related.taskId,
      });
      const created = await createTaskDraft(actor(admin), input);

      const [task, plan, audit] = await Promise.all([
        prisma.task.findUniqueOrThrow({ where: { id: created.taskId } }),
        prisma.taskPlanVersion.findUniqueOrThrow({
          where: { id: created.currentPlanVersionId },
        }),
        prisma.domainAuditEvent.findFirstOrThrow({
          where: { taskId: created.taskId, action: "pm.task.create" },
        }),
      ]);
      expect(task).toMatchObject({
        relatedTaskId: related.taskId,
      });
      expect(plan.plannedStartAt?.toISOString()).toBe(input.plannedStartAt);
      expect(plan.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
      expect(jsonRecord(audit.after)).toMatchObject({
        plannedStartAt: input.plannedStartAt,
        relatedTaskId: related.taskId,
      });

      await expectServiceError(
        createTaskDraft(actor(admin), {
          ...input,
          plannedStartAt: iso(2026, 7, 31),
        }),
        "STATE_CONFLICT",
      );

      const teamAdmin = await createAccountPerson("S2 Team Admin");
      const teamOwner = await createAccountPerson("S2 Team Owner");
      const ordinaryCreated = await createTaskDraft(
        actor(teamAdmin),
        taskDraftInput({
          ownerPersonId: teamOwner.person.id,
          reviewerPersonId: reviewer.person.id,
          title: "退役组长按普通账号创建 Task",
        }),
      );
      await expect(
        prisma.taskMember.count({
          where: {
            taskId: ordinaryCreated.taskId,
            personId: teamAdmin.person.id,
            removedAt: null,
          },
        }),
      ).resolves.toBe(0);

      const hidden = await createDraft({
        creator: admin,
        owner,
        reviewer,
        title: "跨组织关联 Task",
        team: "工程",
        techGroup: "机械",
      });
      const crossGroupCreated = await createTaskDraft(
        actor(teamAdmin),
        taskDraftInput({
          ownerPersonId: teamOwner.person.id,
          reviewerPersonId: reviewer.person.id,
          title: "全局可见关联",
          relatedTaskId: hidden.taskId,
        }),
      );
      expect(
        await prisma.task.findUniqueOrThrow({
          where: { id: crossGroupCreated.taskId },
          select: { relatedTaskId: true },
        }),
      ).toEqual({ relatedTaskId: hidden.taskId });

      const invalidChronology = taskDraftInput({
        ownerPersonId: teamOwner.person.id,
        reviewerPersonId: reviewer.person.id,
        title: "非法时间顺序",
      });
      invalidChronology.milestones[1] = {
        ...invalidChronology.milestones[1],
        expectedCompletedAt: iso(2026, 8, 1),
      };
      invalidChronology.milestones[0] = {
        ...invalidChronology.milestones[0],
        expectedCompletedAt: iso(2026, 8, 2),
      };
      await expectServiceError(
        createTaskDraft(actor(teamAdmin), invalidChronology),
        "PLAN_CHRONOLOGY_INVALID",
      );
    });

  test("related Task references reject deleted or missing IDs but accept every readable live Task", async () => {
      expect(process.env.NOTIFICATION_DELIVERY_DISABLED).toBe("true");
      expect(new URL(process.env.DATABASE_URL ?? "").pathname).toMatch(/_test$/);

      const admin = await createAccountPerson("S2 Related Reference Admin");
      const scopedAdmin = await createAccountPerson(
        "S2 Related Reference Scoped Admin",
      );
      const owner = await createAccountPerson("S2 Related Reference Owner");
      const reviewer = await createAccountPerson("S2 Related Reference Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");

      const hiddenRelated = await createDraft({
        creator: admin,
        owner,
        reviewer,
        title: "跨权限域真实关联 Task",
        team: "工程",
        techGroup: "机械",
      });
      const draftTarget = await createDraft({
        creator: scopedAdmin,
        owner,
        reviewer,
        title: "relatedTaskId Draft 目标",
      });
      const activeTarget = await createDraft({
        creator: scopedAdmin,
        owner,
        reviewer,
        title: "relatedTaskId Active 目标",
        extraMembers: [
          { personId: scopedAdmin.person.id, role: "PARTICIPANT" },
        ],
      });
      await activateTask(actor(owner), {
        taskId: activeTarget.taskId,
        expectedLockVersion: 0,
      });
      const createAttemptKeys = [
        `s2-related-missing-${randomUUID()}`,
        `s2-related-visible-${randomUUID()}`,
      ];
      expect(new Set(createAttemptKeys).size).toBe(2);

      const cases = [
        {
          name: "createTaskDraft",
          snapshotTaskIds: [hiddenRelated.taskId],
          includeGlobalCounts: true,
          invoke: (relatedTaskId: string, attemptIndex: number) =>
            createTaskDraft(
              actor(scopedAdmin),
              {
                ...taskDraftInput({
                  ownerPersonId: owner.person.id,
                  reviewerPersonId: reviewer.person.id,
                  title: "拒绝写入的 relatedTaskId 新建 payload",
                }),
                relatedTaskId,
                idempotencyKey: createAttemptKeys[attemptIndex],
              },
            ),
        },
        {
          name: "updateDraftMetadataThroughCurrentInterface",
          snapshotTaskIds: [draftTarget.taskId, hiddenRelated.taskId],
          includeGlobalCounts: false,
          invoke: (relatedTaskId: string) =>
            updateDraftMetadataThroughCurrentInterface(actor(scopedAdmin), {
              taskId: draftTarget.taskId,
              expectedLockVersion: 0,
              title: "拒绝写入的 Draft 元数据差异",
              description: "该 payload 会改变标题、描述、优先级、审批模式和 Tag",
              team: "英雄",
              techGroup: "电控",
              priority: "CRITICAL",
              relatedTaskId,
            }),
        },
        {
          name: "updateActiveMetadataThroughCurrentInterface",
          snapshotTaskIds: [activeTarget.taskId, hiddenRelated.taskId],
          includeGlobalCounts: false,
          invoke: (relatedTaskId: string) =>
            updateActiveMetadataThroughCurrentInterface(actor(scopedAdmin), {
              taskId: activeTarget.taskId,
              expectedLockVersion: 1,
              title: "拒绝写入的 Active 元数据差异",
              description: "该 payload 会改变标题、描述、优先级和审批模式",
              team: "英雄",
              techGroup: "电控",
              priority: "LOW",
              relatedTaskId,
            }),
        },
      ] as const;

      for (const mutationCase of cases) {
        const missingRelatedTaskId = randomUUID();
        expect(
          await prisma.task.findUnique({ where: { id: missingRelatedTaskId } }),
        ).toBeNull();
        expect(
          await prisma.task.findUnique({ where: { id: hiddenRelated.taskId } }),
        ).toMatchObject({ team: "工程", techGroup: "机械" });

        const before = await relatedTaskReferenceSideEffectSnapshot(
          mutationCase.snapshotTaskIds,
          mutationCase.includeGlobalCounts,
        );
        const error = await expectServiceError(
          mutationCase.invoke(missingRelatedTaskId, 0),
          "NOT_FOUND",
        );
        expect({ code: error.code, message: error.message }).toEqual({
          code: "NOT_FOUND",
          message: "对象不存在或无权查看",
        });
        expect(
          await relatedTaskReferenceSideEffectSnapshot(
            mutationCase.snapshotTaskIds,
            mutationCase.includeGlobalCounts,
          ),
        ).toEqual(before);

        await expect(mutationCase.invoke(hiddenRelated.taskId, 1)).resolves.toBeTruthy();
      }
      await expect(
        prisma.task.findMany({
          where: { id: { in: [draftTarget.taskId, activeTarget.taskId] } },
          select: { relatedTaskId: true },
        }),
      ).resolves.toEqual([
        { relatedTaskId: hiddenRelated.taskId },
        { relatedTaskId: hiddenRelated.taskId },
      ]);
    });

  test("Draft metadata and members enforce state, write permission, lock, multiple Owners and one role per person", async () => {
      const admin = await createAccountPerson("S2 Draft Admin");
      const owner = await createAccountPerson("S2 Draft Owner");
      const reviewer = await createAccountPerson("S2 Draft Reviewer");
      const member = await createAccountPerson("S2 Draft Member");
      const outsider = await createAccountPerson("S2 Draft Outsider");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({ creator: admin, owner, reviewer });

      await expectServiceError(
        updateActiveMetadataThroughCurrentInterface(actor(owner), {
          taskId: fixture.taskId,
          expectedLockVersion: 0,
          title: "Active-only metadata",
          description: "",
          team: "英雄",
          techGroup: "电控",
          priority: "HIGH",
          relatedTaskId: null,
        }),
        "STATE_CONFLICT",
      );
      const taskUpdateEventPrefix = `pm:task:${fixture.taskId}:updated:`;
      const beforeTaskUpdateOutboxCount = await prisma.notificationOutbox.count({
        where: { eventKey: { startsWith: taskUpdateEventPrefix } },
      });
      const metadata = await updateDraftMetadataThroughCurrentInterface(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
        title: "更新后的 Draft Task",
        description: "Draft metadata",
        team: "英雄",
        techGroup: "电控",
        priority: "CRITICAL",
        relatedTaskId: null,
      });
      expect(metadata).toMatchObject({ lockVersion: 1 });

      const ownerMetadata = await updateDraftMetadataThroughCurrentInterface(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 1,
        title: "负责人继续编辑",
        description: "",
        team: "英雄",
        techGroup: "电控",
        priority: "HIGH",
        relatedTaskId: null,
      });
      expect(ownerMetadata.lockVersion).toBe(2);

      const adminMetadata = await updateDraftMetadataThroughCurrentInterface(actor(admin), {
        taskId: fixture.taskId,
        expectedLockVersion: 2,
        title: "管理员编辑元数据",
        description: "管理员写权限审计",
        team: "英雄",
        techGroup: "电控",
        priority: "HIGH",
        relatedTaskId: null,
      });
      expect(adminMetadata.lockVersion).toBe(3);

      await expectServiceError(
        updateDraftMetadataThroughCurrentInterface(actor(owner), {
          taskId: fixture.taskId,
          expectedLockVersion: 1,
          title: "stale",
          description: "",
          team: "英雄",
          techGroup: "电控",
          priority: "HIGH",
          relatedTaskId: null,
        }),
        "STALE_TASK",
        { expectedCurrentLockVersion: 3 },
      );
      await expectServiceError(
        updateDraftMetadataThroughCurrentInterface(actor(outsider), {
          taskId: fixture.taskId,
          expectedLockVersion: 3,
          title: "非成员不可写",
          description: "",
          team: "英雄",
          techGroup: "电控",
          priority: "HIGH",
          relatedTaskId: null,
        }),
        "FORBIDDEN",
      );

      const multipleOwners = await updateTaskMembersThroughCurrentInterface(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 3,
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: reviewer.person.id, role: "OWNER" },
        ],
      });
      expect(multipleOwners.lockVersion).toBe(4);
      await expectServiceError(
        updateTaskMembersThroughCurrentInterface(actor(owner), {
          taskId: fixture.taskId,
          expectedLockVersion: 4,
          members: [
            { personId: owner.person.id, role: "OWNER" },
            { personId: reviewer.person.id, role: "PARTICIPANT" },
            { personId: reviewer.person.id, role: "PARTICIPANT" },
          ],
        }),
        "VALIDATION_ERROR",
      );
      await prisma.person.update({
        where: { id: outsider.person.id },
        data: { status: "INACTIVE" },
      });
      await expectServiceError(
        updateTaskMembersThroughCurrentInterface(actor(owner), {
          taskId: fixture.taskId,
          expectedLockVersion: 4,
          members: [
            { personId: owner.person.id, role: "OWNER" },
            { personId: reviewer.person.id, role: "PARTICIPANT" },
            { personId: outsider.person.id, role: "PARTICIPANT" },
          ],
        }),
        "VALIDATION_ERROR",
      );
      expect((await currentTask(fixture.taskId)).lockVersion).toBe(4);
      const members = await updateTaskMembersThroughCurrentInterface(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 4,
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: reviewer.person.id, role: "PARTICIPANT" },
          { personId: member.person.id, role: "PARTICIPANT" },
        ],
      });
      expect(members.lockVersion).toBe(5);
      expect(members.members).toEqual(
        expect.arrayContaining([
          { personId: owner.person.id, role: "OWNER" },
          { personId: reviewer.person.id, role: "PARTICIPANT" },
        ]),
      );
      expect(
        await prisma.notificationOutbox.count({
          where: { eventKey: { startsWith: taskUpdateEventPrefix } },
        }),
      ).toBe(beforeTaskUpdateOutboxCount + 3);
      expect(
        await prisma.domainAuditEvent.count({
          where: {
            taskId: fixture.taskId,
            action: {
              in: [
                "pm.task.draft.update",
              ],
            },
          },
        }),
      ).toBe(5);

    });

  test("Draft plan replace preserves node IDs, maps client keys stably and hashes plannedStartAt", async () => {
      const admin = await createAccountPerson("S2 Plan Admin");
      const owner = await createAccountPerson("S2 Plan Owner");
      const reviewer = await createAccountPerson("S2 Plan Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({ creator: admin, owner, reviewer });
      const original = await currentPlan(fixture.taskId);
      const originalHash = original.snapshotHash;
      const originalFirst = original.nodes[0];
      const originalTermination = original.nodes.at(-1);
      if (!originalFirst?.node.milestone || !originalTermination?.node.termination) {
        throw new Error("测试计划结构不完整");
      }

      const replacement = await updateDraftPlanThroughCurrentInterface(actor(owner), {
        taskId: fixture.taskId,
        planVersionId: fixture.currentPlanVersionId,
        expectedLockVersion: 0,
        plannedStartAt: iso(2026, 7, 31),
        milestones: [
          {
            nodeId: originalFirst.nodeId,
            goal: "保留的 M1",
            completionCriteria: "保留 ID 并更新内容",
            expectedCompletedAt: iso(2026, 8, 2),
            reviewRequirements: "文本证据",
            businessDescription: "保留节点",
          },
          {
            clientKey: "composer-new-m2",
            goal: "新 M2",
            completionCriteria: "新节点完成",
            expectedCompletedAt: iso(2026, 8, 3),
            reviewRequirements: "文本证据",
            businessDescription: "严格递增排序",
          },
        ],
        termination: {
          nodeId: originalTermination.nodeId,
          name: "Terminal",
          plannedOutcomeCriteria: "计划完成",
          plannedAt: iso(2026, 8, 4),
          businessDescription: "保留结束节点",
        },
      });
      const mappedNodeId = replacement.nodeMappings.find(
        (mapping) => mapping.clientKey === "composer-new-m2",
      )?.nodeId;
      expect(mappedNodeId).toMatch(UUID_PATTERN);
      expect(replacement.nodes.map((node) => node.nodeId)).toEqual([
        originalFirst.nodeId,
        mappedNodeId,
        originalTermination.nodeId,
      ]);
      expect(replacement.snapshotHash).not.toBe(originalHash);
      expect(
        await prisma.taskNode.findUnique({
          where: { id: original.nodes[1]?.nodeId ?? "" },
        }),
      ).toBeNull();

      const stableMapping = await updateDraftPlanThroughCurrentInterface(actor(owner), {
        taskId: fixture.taskId,
        planVersionId: fixture.currentPlanVersionId,
        expectedLockVersion: 1,
        plannedStartAt: iso(2026, 7, 30),
        milestones: [
          {
            nodeId: originalFirst.nodeId,
            goal: "保留的 M1",
            completionCriteria: "保留 ID 并更新内容",
            expectedCompletedAt: iso(2026, 8, 2),
            reviewRequirements: "文本证据",
            businessDescription: "保留节点",
          },
          {
            clientKey: "composer-new-m2",
            goal: "新 M2",
            completionCriteria: "新节点完成",
            expectedCompletedAt: iso(2026, 8, 3),
            reviewRequirements: "文本证据",
            businessDescription: "严格递增排序",
          },
        ],
        termination: {
          nodeId: originalTermination.nodeId,
          name: "Terminal",
          plannedOutcomeCriteria: "计划完成",
          plannedAt: iso(2026, 8, 4),
          businessDescription: "保留结束节点",
        },
      });
      expect(stableMapping.nodeMappings).toEqual([
        { clientKey: "composer-new-m2", nodeId: mappedNodeId },
      ]);
      expect(stableMapping.snapshotHash).not.toBe(replacement.snapshotHash);

      const countsBeforeInvalid = await mutationSideEffectCounts(fixture.taskId);
      await expectServiceError(
        updateDraftPlanThroughCurrentInterface(actor(owner), {
          taskId: fixture.taskId,
          planVersionId: fixture.currentPlanVersionId,
          expectedLockVersion: 2,
          plannedStartAt: iso(2026, 8, 1),
          milestones: [
            {
              nodeId: originalFirst.nodeId,
              goal: "逆序 1",
              completionCriteria: "不写入",
              expectedCompletedAt: iso(2026, 8, 3),
              reviewRequirements: "证据",
              businessDescription: "",
            },
            {
              nodeId: mappedNodeId,
              goal: "逆序 2",
              completionCriteria: "不写入",
              expectedCompletedAt: iso(2026, 8, 2),
              reviewRequirements: "证据",
              businessDescription: "",
            },
          ],
          termination: {
            nodeId: originalTermination.nodeId,
            name: "Terminal",
            plannedOutcomeCriteria: "结束",
            plannedAt: iso(2026, 8, 4),
            businessDescription: "",
          },
        }),
        "PLAN_CHRONOLOGY_INVALID",
      );
      expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(
        countsBeforeInvalid,
      );
    });

  test("unified Draft update is atomic, permission-aware and increments the Task lock once", async () => {
      const admin = await createAccountPerson("S2 Unified Draft Admin");
      const owner = await createAccountPerson("S2 Unified Draft Owner");
      const participant = await createAccountPerson("S2 Unified Draft Participant");
      const addedMember = await createAccountPerson("S2 Unified Draft Added Member");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({
        creator: admin,
        owner,
        reviewer: participant,
      });
      const planInput = await draftPlanReplaceInput(fixture, 0);
      const beforeSnapshot = await mutationSideEffectCounts(fixture.taskId);

      const updated = await updateTaskDraft(actor(owner), {
        ...planInput,
        title: "统一保存后的 Draft Task",
        description: "元数据、成员与计划处于同一事务",
        team: "工程",
        techGroup: "机械",
        priority: "CRITICAL",
        relatedTaskId: null,
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: participant.person.id, role: "PARTICIPANT" },
          { personId: addedMember.person.id, role: "PARTICIPANT" },
        ],
        milestones: [
          ...planInput.milestones.map((milestone, index) => ({
            ...milestone,
            goal: index === 0 ? "统一更新既有节点" : milestone.goal,
          })),
          {
            clientKey: "unified-draft-new-node",
            goal: "统一新增节点",
            completionCriteria: "同一事务创建稳定节点",
            expectedCompletedAt: iso(2026, 8, 6),
            reviewRequirements: "检查节点映射",
            businessDescription: "统一编辑页新增",
          },
        ],
      });

      expect(updated).toMatchObject({
        taskId: fixture.taskId,
        lockVersion: 1,
      });
      expect(updated.nodeMappings).toEqual([
        expect.objectContaining({ clientKey: "unified-draft-new-node" }),
      ]);
      expect(updated.members).toEqual(
        expect.arrayContaining([
          { personId: addedMember.person.id, role: "PARTICIPANT" },
        ]),
      );
      const persisted = await mutationSideEffectCounts(fixture.taskId);
      expect(persisted).toMatchObject({
        lockVersion: 1,
        taskMetadata: {
          title: "统一保存后的 Draft Task",
          team: "工程",
          techGroup: "机械",
          priority: "CRITICAL",
        },
      });
      expect(
        persisted.memberRows.some(
          (member) =>
            member.personId === addedMember.person.id &&
            member.role === "PARTICIPANT" &&
            member.removedAt === null,
        ),
      ).toBe(true);
      const existingFirstNodeId =
        "nodeId" in planInput.milestones[0]!
          ? planInput.milestones[0]!.nodeId
          : null;
      const mappedNodeId = updated.nodeMappings[0]?.nodeId;
      expect(existingFirstNodeId).toBeTruthy();
      expect(mappedNodeId).toMatch(UUID_PATTERN);
      expect(persisted.nodeContent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: existingFirstNodeId,
            milestone: expect.objectContaining({ goal: "统一更新既有节点" }),
          }),
          expect.objectContaining({
            nodeId: mappedNodeId,
            milestone: expect.objectContaining({ goal: "统一新增节点" }),
          }),
        ]),
      );
      expect(persisted.snapshotHash).toBe(updated.snapshotHash);
      const updateEventKey = `pm:task:${fixture.taskId}:updated:1`;
      const updateOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey: `${updateEventKey}:feishu` },
      });
      expect(updateOutbox).toMatchObject({
        type: "task_updated",
        channel: "project-management",
        botKind: "notification",
      });
      const updatePayload = jsonRecord(JSON.parse(updateOutbox.payload));
      expect(updatePayload).toMatchObject({
        kind: "task_updated",
        purpose: "notification",
        mandatory: false,
        taskId: fixture.taskId,
        taskTitle: "统一保存后的 Draft Task",
        linkPath: `/progress/tasks/${fixture.taskId}`,
      });
      expect(String(updatePayload.summary)).toContain(
        "任务名称、任务内容、车组、技术组、优先级",
      );
      expect(String(updatePayload.summary)).not.toContain(
        "元数据、成员与计划处于同一事务",
      );
      const expectedRecipients = await expectedProjectManagementRecipients([owner, participant, addedMember], "TASK");
      expect((updatePayload.recipientOpenIds as string[]).slice().sort()).toEqual(expectedRecipients.openIds);
      const updateNotifications = await prisma.inAppNotification.findMany({
        where: { eventKey: { startsWith: `${updateEventKey}:inapp:` } },
        select: { recipientAccountId: true, linkPath: true },
      });
      expect(updateNotifications.map((notification) => notification.recipientAccountId).sort()).toEqual(expectedRecipients.accountIds);
      expect(updateNotifications).toEqual(
        expect.arrayContaining(
          [owner, participant, addedMember].map((recipient) => ({
            recipientAccountId: recipient.account.id,
            linkPath: `/progress/tasks/${fixture.taskId}`,
          })),
        ),
      );
      const audit = await prisma.domainAuditEvent.findFirstOrThrow({
        where: { taskId: fixture.taskId, action: "pm.task.draft.update" },
      });
      expect(jsonRecord(audit.before)).toMatchObject({
        metadata: expect.objectContaining({
          title: beforeSnapshot.taskMetadata.title,
        }),
        members: expect.any(Array),
        plan: expect.objectContaining({
          snapshotHash: beforeSnapshot.snapshotHash,
        }),
        lockVersion: 0,
      });
      expect(jsonRecord(audit.after)).toMatchObject({
        metadata: expect.objectContaining({
          title: "统一保存后的 Draft Task",
        }),
        lockVersion: 1,
        members: expect.arrayContaining([
          { personId: addedMember.person.id, role: "PARTICIPANT" },
        ]),
        plan: expect.objectContaining({ snapshotHash: updated.snapshotHash }),
        planChanges: {
          added: { totalCount: 1 },
          removed: { totalCount: 0 },
          fieldChanges: expect.objectContaining({ nodeCount: 1 }),
        },
      });

      const beforeForbidden = await mutationSideEffectCounts(fixture.taskId);
      const participantPlanInput = await draftPlanReplaceInput(fixture, 1);
      await expectServiceError(
        updateTaskDraft(actor(participant), {
          ...participantPlanInput,
          title: "参与人伪造成员编辑",
          description: "必须被拒绝",
          team: "工程",
          techGroup: "机械",
          priority: "HIGH",
          relatedTaskId: null,
          members: fixtureMembers(fixture),
        }),
        "FORBIDDEN",
      );
      expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(
        beforeForbidden,
      );

      const participantUpdated = await updateTaskDraft(actor(participant), {
        ...participantPlanInput,
        title: "参与人统一更新 Draft",
        description: "成员未随请求提交",
        team: "工程",
        techGroup: "机械",
        priority: "HIGH",
        relatedTaskId: null,
        milestones: participantPlanInput.milestones.map((milestone, index) => ({
          ...milestone,
          goal: index === 0 ? "参与人更新计划" : milestone.goal,
        })),
      });
      expect(participantUpdated.lockVersion).toBe(2);
      expect(participantUpdated.members).toEqual(updated.members);
      expect((await currentTask(fixture.taskId)).lockVersion).toBe(2);

      await createSegmentReference({
        taskId: fixture.taskId,
        personId: addedMember.person.id,
        accountId: owner.account.id,
      });
      const constrainedInput = await draftPlanReplaceInput(fixture, 2);
      const unifiedConstrainedInput = {
        ...constrainedInput,
        title: "约束失败不得写入元数据",
        description: "统一事务完整回滚",
        team: "英雄" as const,
        techGroup: "电控" as const,
        priority: "LOW" as const,
        relatedTaskId: null,
        members: updated.members,
      };

      for (const [input, code] of [
        [
          { ...unifiedConstrainedInput, planVersionId: randomUUID() },
          "STATE_CONFLICT",
        ],
        [
          {
            ...unifiedConstrainedInput,
            members: updated.members.filter(
              (member) => member.personId !== addedMember.person.id,
            ),
          },
          "VALIDATION_ERROR",
        ],
      ] as const) {
        const beforeRejected = await mutationSideEffectCounts(fixture.taskId);
        await expectServiceError(updateTaskDraft(actor(owner), input), code);
        expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(
          beforeRejected,
        );
      }
    });

  test("Draft plan replace audit stays bounded and excludes 200-node plan prose", async () => {
      const admin = await createAccountPerson("S2 Bounded Audit Admin");
      const owner = await createAccountPerson("S2 Bounded Audit Owner");
      const reviewer = await createAccountPerson("S2 Bounded Audit Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({ creator: admin, owner, reviewer });
      const sensitiveNeedle = `S2_AUDIT_PROSE_${randomUUID()}`;
      const longText = `${sensitiveNeedle}-${"长文本".repeat(550)}`;

      await updateDraftPlanThroughCurrentInterface(actor(owner), {
        taskId: fixture.taskId,
        planVersionId: fixture.currentPlanVersionId,
        expectedLockVersion: 0,
        plannedStartAt: iso(2026, 8, 1),
        milestones: Array.from({ length: 200 }, (_, index) => ({
          clientKey: `bounded-audit-milestone-${index}`,
          goal: `${longText}-${index}`,
          completionCriteria: `${longText}-criteria-${index}`,
          expectedCompletedAt: iso(2026, 8, index + 2),
          reviewRequirements: `${longText}-review-${index}`,
          businessDescription: `${longText}-business-${index}`,
        })),
        termination: {
          clientKey: "bounded-audit-termination",
          name: "终".repeat(200),
          plannedOutcomeCriteria: `${longText}-termination-criteria`,
          plannedAt: iso(2026, 8, 205),
          businessDescription: `${longText}-termination-business`,
        },
      });

      const audit = await prisma.domainAuditEvent.findFirstOrThrow({
        where: {
          taskId: fixture.taskId,
          action: "pm.task.draft.update",
        },
        orderBy: { createdAt: "desc" },
      });
      const auditJson = JSON.stringify({ before: audit.before, after: audit.after });
      expect(auditJson).not.toContain(sensitiveNeedle);
      expect(Buffer.byteLength(auditJson, "utf8")).toBeLessThan(100_000);
      expect(jsonRecord(jsonRecord(audit.before).plan)).toMatchObject({
        snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        plannedStartAt: iso(2026, 8, 1),
        nodeCount: 3,
      });
      expect(jsonRecord(jsonRecord(audit.after).plan)).toMatchObject({
        snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        plannedStartAt: iso(2026, 8, 1),
        nodeCount: 201,
      });
      expect(jsonRecord(audit.after).planChanges).toMatchObject({
          added: { totalCount: 201, truncated: false },
          removed: { totalCount: 3, truncated: false },
      });
    });

  test("Draft plan replace treats random and foreign nodeId identically and only clientKey creates", async () => {
      const admin = await createAccountPerson("S2 Node Identity Admin");
      const owner = await createAccountPerson("S2 Node Identity Owner");
      const reviewer = await createAccountPerson("S2 Node Identity Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({ creator: admin, owner, reviewer });
      const foreign = await createDraft({
        creator: admin,
        owner: await createAccountPerson("S2 Foreign Node Owner"),
        reviewer,
      });
      const foreignNodeId = (await currentPlan(foreign.taskId)).nodes[0]?.nodeId;
      if (!foreignNodeId) throw new Error("缺少外部节点");

      const errors = [];
      for (const rawNodeId of [randomUUID(), foreignNodeId]) {
        const before = await mutationSideEffectCounts(fixture.taskId);
        errors.push(
          await expectServiceError(
            updateDraftPlanThroughCurrentInterface(
              actor(owner),
              await draftPlanReplaceInput(fixture, 0, {
                firstMilestoneNodeId: rawNodeId,
              }),
            ),
            "ASSOCIATION_INVALID",
          ),
        );
        expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(before);
      }
      expect(errors.map((error) => error.message)).toEqual([
        "计划节点不属于当前 Task 草稿计划",
        "计划节点不属于当前 Task 草稿计划",
      ]);

      const created = await updateDraftPlanThroughCurrentInterface(
        actor(owner),
        await draftPlanReplaceInput(fixture, 0, {
          firstMilestoneClientKey: "only-client-key-creates",
        }),
      );
      expect(created.nodeMappings).toEqual([
        expect.objectContaining({ clientKey: "only-client-key-creates" }),
      ]);
    });

  test("Draft plan replace may delete a Node while Task-associated Segments remain intact", async () => {
      const admin = await createAccountPerson("S2 Task-only Segment Admin");
      const owner = await createAccountPerson("S2 Task-only Segment Owner");
      const reviewer = await createAccountPerson("S2 Task-only Segment Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({ creator: admin, owner, reviewer });
      const plan = await currentPlan(fixture.taskId);
      const retained = plan.nodes[0];
      const removed = plan.nodes[1];
      const termination = plan.nodes.at(-1);
      if (!retained?.node.milestone || !removed || !termination?.node.termination) {
        throw new Error("测试计划结构不完整");
      }
      const segment = await prisma.workSegment.create({
        data: {
          personId: owner.person.id,
          startAt: new Date("2026-08-02T09:00:00.000Z"),
          endAt: new Date("2026-08-02T10:00:00.000Z"),
          content: "仅关联 Task 的投入",
          taskId: fixture.taskId,
          createdByAccountId: admin.account.id,
        },
      });

      await updateDraftPlanThroughCurrentInterface(actor(owner), {
        taskId: fixture.taskId,
        planVersionId: fixture.currentPlanVersionId,
        expectedLockVersion: 0,
        plannedStartAt: iso(2026, 8, 1),
        milestones: [planMilestoneReplacement(retained)],
        termination: planTerminationReplacement(termination),
      });

      expect(
        await prisma.taskNode.findUnique({ where: { id: removed.nodeId } }),
      ).toBeNull();
      await expect(
        prisma.workSegment.findUniqueOrThrow({ where: { id: segment.id } }),
      ).resolves.toMatchObject({ taskId: fixture.taskId, deletedAt: null });
    });

  test("Revision validates marker bounds and approval cannot bypass authoritative chronology", async () => {
      const admin = await createAccountPerson("S2 Revision Admin");
      const owner = await createAccountPerson("S2 Revision Owner");
      const reviewer = await createAccountPerson("S2 Revision Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({ creator: admin, owner, reviewer });
      await activateTask(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
      });
      const firstNode = (await currentPlan(fixture.taskId)).nodes[0];
      if (!firstNode?.node.milestone) throw new Error("缺少首个 Milestone");
      const review = await submitMilestoneForReview(actor(owner), {
        milestoneNodeId: firstNode.nodeId,
        idempotencyKey: `s2-review-${randomUUID()}`,
        evidences: [{ kind: "TEXT", note: "完成首个阶段" }],
      });
      await reviewMilestone(actor(admin), {
        reviewId: review.reviewId,
        result: "APPROVED",
        comment: "通过",
      });
      const task = await currentTask(fixture.taskId);
      const current = await currentPlan(fixture.taskId);
      const activeEntry = current.nodes.find(
        (entry) => entry.node.status === "ACTIVE",
      );
      if (!activeEntry) throw new Error("缺少 Active 计划节点");

      const planCountBefore = await prisma.taskPlanVersion.count({
        where: { taskId: fixture.taskId },
      });
      await expectServiceError(
        createRevision(actor(owner), {
          taskId: fixture.taskId,
          basePlanVersionId: current.id,
          baseTaskLockVersion: task.lockVersion,
          reason: "Revision 时间早于已完成 Milestone",
          description: "Revision 时间早于已完成 Milestone",
          revisionAt: iso(2026, 8, 1),
          replacementMilestones: [milestoneInput("修订 M2", 6)],
          termination: terminationInput(8),
          idempotencyKey: `s2-revision-invalid-${randomUUID()}`,
        }),
        "PLAN_CHRONOLOGY_INVALID",
      );
      expect(
        await prisma.taskPlanVersion.count({ where: { taskId: fixture.taskId } }),
      ).toBe(planCountBefore);

      const revision = await createRevision(actor(owner), {
        taskId: fixture.taskId,
        basePlanVersionId: current.id,
        baseTaskLockVersion: task.lockVersion,
        reason: "合法完整修订",
        description: "合法完整修订",
        revisionAt: iso(2026, 8, 2),
        replacementMilestones: [milestoneInput("修订 M2", 6)],
        termination: terminationInput(8),
        idempotencyKey: `s2-revision-valid-${randomUUID()}`,
      });
      const targetPlan = await prisma.taskPlanVersion.findUniqueOrThrow({
        where: { id: revision.targetPlanVersionId ?? "" },
      });
      expect(targetPlan.plannedStartAt?.toISOString()).toBe(iso(2026, 8, 1));
      expect(targetPlan.snapshotHash).toMatch(/^[a-f0-9]{64}$/);

      await prisma.taskPlanVersion.update({
        where: { id: targetPlan.id },
        data: { plannedStartAt: null },
      });
      await expectServiceError(
        approveRevision(actor(admin), {
          revisionNodeId: revision.revisionNodeId,
          comment: "审批不得绕过 chronology",
        }),
        "PLAN_CHRONOLOGY_INVALID",
      );

      await prisma.taskPlanVersion.update({
        where: { id: targetPlan.id },
        data: { plannedStartAt: new Date(iso(2026, 8, 1)) },
      });
      await prisma.taskPlanVersion.update({
        where: { id: targetPlan.id },
        data: { plannedStartAt: new Date(iso(2026, 7, 31)) },
      });
      await expectServiceError(
        approveRevision(actor(admin), {
          revisionNodeId: revision.revisionNodeId,
          comment: "候选计划不得改变 Start",
        }),
        "PLAN_VERSION_CONFLICT",
      );
      expect(
        await prisma.task.findUniqueOrThrow({
          where: { id: fixture.taskId },
          select: { currentPlanVersionId: true, lockVersion: true },
        }),
      ).toEqual({
        currentPlanVersionId: current.id,
        lockVersion: task.lockVersion,
      });
      expect(
        await prisma.revisionNode.findUniqueOrThrow({
          where: { id: revision.revisionNodeId },
          select: { status: true },
        }),
      ).toEqual({ status: "PENDING_APPROVAL" });
      await prisma.taskPlanVersion.update({
        where: { id: targetPlan.id },
        data: { plannedStartAt: new Date(iso(2026, 8, 1)) },
      });
      const targetTermination = await prisma.terminationNode.findFirstOrThrow({
        where: {
          node: {
            planVersionEntries: { some: { planVersionId: targetPlan.id } },
          },
        },
      });
      const validTerminationAt = targetTermination.plannedAt;
      await prisma.terminationNode.update({
        where: { id: targetTermination.id },
        data: { plannedAt: new Date(iso(2026, 8, 1)) },
      });
      await expectServiceError(
        approveRevision(actor(admin), {
          revisionNodeId: revision.revisionNodeId,
          comment: "apply 也必须重新校验",
        }),
        "PLAN_CHRONOLOGY_INVALID",
      );
      expect(
        await prisma.revisionNode.findUniqueOrThrow({
          where: { id: revision.revisionNodeId },
          select: { status: true },
        }),
      ).toEqual({ status: "PENDING_APPROVAL" });
      await prisma.terminationNode.update({
        where: { id: targetTermination.id },
        data: { plannedAt: validTerminationAt },
      });
      const applied = await approveRevision(actor(admin), {
        revisionNodeId: revision.revisionNodeId,
        comment: "合法生效",
      });
      expect(applied).toMatchObject({
        status: "EFFECTIVE",
        currentPlanVersionId: targetPlan.id,
      });

      const appliedTask = await currentTask(fixture.taskId);
      const appliedPlan = await currentPlan(fixture.taskId);
      const planCountAfterApply = await prisma.taskPlanVersion.count({
        where: { taskId: fixture.taskId },
      });
      await expectServiceError(
        createRevision(actor(owner), {
          taskId: fixture.taskId,
          basePlanVersionId: appliedPlan.id,
          baseTaskLockVersion: appliedTask.lockVersion,
          reason: "不得早于上一条有效 Revision",
          description: "不得早于上一条有效 Revision",
          revisionAt: iso(2026, 8, 1),
          replacementMilestones: [milestoneInput("再次修订 M2", 7)],
          termination: terminationInput(9),
          idempotencyKey: `s2-revision-before-effective-${randomUUID()}`,
        }),
        "PLAN_CHRONOLOGY_INVALID",
      );
      expect(
        await prisma.taskPlanVersion.count({ where: { taskId: fixture.taskId } }),
      ).toBe(planCountAfterApply);

      const sameTimeRevision = await createRevision(actor(owner), {
        taskId: fixture.taskId,
        basePlanVersionId: appliedPlan.id,
        baseTaskLockVersion: appliedTask.lockVersion,
        reason: "与上一条有效 Revision 同刻",
        description: "与上一条有效 Revision 同刻",
        revisionAt: iso(2026, 8, 2),
        replacementMilestones: [milestoneInput("同刻后的 M2", 7)],
        termination: terminationInput(9),
        idempotencyKey: `s2-revision-same-effective-${randomUUID()}`,
      });
      const sameTimeTarget = await planById(
        sameTimeRevision.targetPlanVersionId ?? "",
      );
      expect(
        sameTimeTarget.nodes
          .filter((entry) => entry.isCarryForward)
          .map((entry) => entry.node.type),
      ).toEqual(["MILESTONE", "REVISION"]);

      const legacyDraft = await createDraft({
        creator: admin,
        owner: await createAccountPerson("S2 Legacy Draft Owner"),
        reviewer,
      });
      await prisma.taskPlanVersion.update({
        where: { id: legacyDraft.currentPlanVersionId },
        data: { plannedStartAt: null },
      });
      await expectServiceError(
        activateTask(actor(legacyDraft.owner), {
          taskId: legacyDraft.taskId,
          expectedLockVersion: 0,
        }),
        "PLAN_CHRONOLOGY_INVALID",
      );
    });
});
