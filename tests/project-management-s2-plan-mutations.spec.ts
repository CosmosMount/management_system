import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type {
  ProjectManagementSystemRole,
  TaskMemberRole,
  WorkSegmentStatus,
  WorkSegmentType,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  approveRevision,
  confirmTermination,
  createRevisionDraft,
  createTaskDraft,
  reviewMilestone,
  submitMilestoneForReview,
  submitRevision,
} from "../lib/project-management/application/lifecycle-service";
import {
  batchCreatePlannedSegments,
  cancelPlannedSegment,
  createActualSegment,
  createWorkSegment,
  relinkPlannedSegment,
  updateWorkSegment,
} from "../lib/project-management/application/segment-service";
import {
  replaceTaskDraftMembers,
  replaceTaskDraftPlan,
  replaceTaskMembers,
  replaceTaskTags,
  updateTaskDraftMetadata,
  updateTaskMetadata,
} from "../lib/project-management/application/task-mutation-service";
import { toProjectManagementServiceError } from "../lib/project-management/application/errors";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import { absoluteDateTimeSchema } from "../lib/project-management/validations/lifecycle";
import {
  cleanupBarrierResources,
  connectDatabaseClient,
  startBarrierOperations,
  throwBarrierErrors,
} from "./helpers/database-barrier";

test.describe("project management S2 plan and Task mutation services", () => {
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
      sameDayMilestones: true,
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
        plannedStartAt: iso(2026, 8, 2),
      }),
      "STATE_CONFLICT",
    );

    const teamAdmin = await createAccountPerson("S2 Team Admin");
    const teamOwner = await createAccountPerson("S2 Team Owner");
    await grantRole(teamAdmin.account.id, "GROUP_LEADER", {
      team: "英雄",
      techGroup: "电控",
    });
    const ordinaryCreated = await createTaskDraft(
      actor(teamAdmin),
      taskDraftInput({
        ownerPersonId: teamOwner.person.id,
        reviewerPersonId: reviewer.person.id,
        title: "退役组长按普通账号创建 Task",
      }),
    );
    await expect(
      prisma.taskMember.findFirstOrThrow({
        where: {
          taskId: ordinaryCreated.taskId,
          personId: teamAdmin.person.id,
          removedAt: null,
        },
        select: { role: true },
      }),
    ).resolves.toEqual({ role: "OWNER" });

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
    await grantRole(scopedAdmin.account.id, "GROUP_LEADER", {
      team: "英雄",
      techGroup: "电控",
    });

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
    });
    await activateTask(actor(owner), {
      taskId: activeTarget.taskId,
      expectedLockVersion: 0,
    });
    const replacementTag = await createTag(
      scopedAdmin.account.id,
      "Related Reference Replacement Tag",
    );
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
        name: "updateTaskDraftMetadata",
        snapshotTaskIds: [draftTarget.taskId, hiddenRelated.taskId],
        includeGlobalCounts: false,
        invoke: (relatedTaskId: string) =>
          updateTaskDraftMetadata(actor(scopedAdmin), {
            taskId: draftTarget.taskId,
            expectedLockVersion: 0,
            title: "拒绝写入的 Draft 元数据差异",
            description: "该 payload 会改变标题、描述、优先级、审批模式和 Tag",
            team: "英雄",
            techGroup: "电控",
            priority: "CRITICAL",
            relatedTaskId,
            tagIds: [replacementTag.id],
          }),
      },
      {
        name: "updateTaskMetadata",
        snapshotTaskIds: [activeTarget.taskId, hiddenRelated.taskId],
        includeGlobalCounts: false,
        invoke: (relatedTaskId: string) =>
          updateTaskMetadata(actor(scopedAdmin), {
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
    const tag = await createTag(admin.account.id, "Draft Tag");
    const fixture = await createDraft({ creator: admin, owner, reviewer });

    await expectServiceError(
      updateTaskMetadata(actor(owner), {
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
    await expectServiceError(
      replaceTaskMembers(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: reviewer.person.id, role: "PARTICIPANT" },
        ],
      }),
      "STATE_CONFLICT",
    );

    const beforeOutboxCount = await prisma.notificationOutbox.count();
    const metadata = await updateTaskDraftMetadata(actor(owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 0,
      title: "更新后的 Draft Task",
      description: "Draft metadata",
      team: "英雄",
      techGroup: "电控",
      priority: "CRITICAL",
      relatedTaskId: null,
      tagIds: [tag.id],
    });
    expect(metadata).toMatchObject({ lockVersion: 1, tagIds: [tag.id] });

    const ownerMetadata = await updateTaskDraftMetadata(actor(owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 1,
      title: "负责人继续编辑",
      description: "",
      team: "英雄",
      techGroup: "电控",
      priority: "HIGH",
      relatedTaskId: null,
      tagIds: [tag.id],
    });
    expect(ownerMetadata.lockVersion).toBe(2);

    const adminMetadata = await updateTaskDraftMetadata(actor(admin), {
      taskId: fixture.taskId,
      expectedLockVersion: 2,
      title: "管理员编辑元数据",
      description: "管理员写权限审计",
      team: "英雄",
      techGroup: "电控",
      priority: "HIGH",
      relatedTaskId: null,
      tagIds: [tag.id],
    });
    expect(adminMetadata.lockVersion).toBe(3);

    await expectServiceError(
      updateTaskDraftMetadata(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 1,
        title: "stale",
        description: "",
        team: "英雄",
        techGroup: "电控",
        priority: "HIGH",
        relatedTaskId: null,
        tagIds: [tag.id],
      }),
      "STALE_TASK",
      { expectedCurrentLockVersion: 3 },
    );
    await expectServiceError(
      updateTaskDraftMetadata(actor(outsider), {
        taskId: fixture.taskId,
        expectedLockVersion: 3,
        title: "非成员不可写",
        description: "",
        team: "英雄",
        techGroup: "电控",
        priority: "HIGH",
        relatedTaskId: null,
        tagIds: [],
      }),
      "FORBIDDEN",
    );

    const multipleOwners = await replaceTaskDraftMembers(actor(owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 3,
      members: [
        { personId: owner.person.id, role: "OWNER" },
        { personId: reviewer.person.id, role: "OWNER" },
      ],
    });
    expect(multipleOwners.lockVersion).toBe(4);
    await expectServiceError(
      replaceTaskDraftMembers(actor(owner), {
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
      replaceTaskDraftMembers(actor(owner), {
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
    const members = await replaceTaskDraftMembers(actor(owner), {
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
    expect(await prisma.notificationOutbox.count()).toBe(beforeOutboxCount);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          taskId: fixture.taskId,
          action: {
            in: [
              "pm.task.draft_metadata.update",
              "pm.task.draft_members.replace",
            ],
          },
        },
      }),
    ).toBe(5);

    await expectServiceError(
      replaceTaskTags(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 5,
        tagIds: [],
      }),
      "STATE_CONFLICT",
    );
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

    const replacement = await replaceTaskDraftPlan(actor(owner), {
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
          expectedCompletedAt: iso(2026, 8, 2),
          reviewRequirements: "文本证据",
          businessDescription: "同日排序",
        },
      ],
      termination: {
        nodeId: originalTermination.nodeId,
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

    const stableMapping = await replaceTaskDraftPlan(actor(owner), {
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
          expectedCompletedAt: iso(2026, 8, 2),
          reviewRequirements: "文本证据",
          businessDescription: "同日排序",
        },
      ],
      termination: {
        nodeId: originalTermination.nodeId,
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
      replaceTaskDraftPlan(actor(owner), {
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

  test("Draft plan replace audit stays bounded and excludes 200-node plan prose", async () => {
    const admin = await createAccountPerson("S2 Bounded Audit Admin");
    const owner = await createAccountPerson("S2 Bounded Audit Owner");
    const reviewer = await createAccountPerson("S2 Bounded Audit Reviewer");
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
    const fixture = await createDraft({ creator: admin, owner, reviewer });
    const sensitiveNeedle = `S2_AUDIT_PROSE_${randomUUID()}`;
    const longText = `${sensitiveNeedle}-${"长文本".repeat(550)}`;

    await replaceTaskDraftPlan(actor(owner), {
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
        plannedOutcomeCriteria: `${longText}-termination-criteria`,
        plannedAt: iso(2026, 8, 205),
        businessDescription: `${longText}-termination-business`,
      },
    });

    const audit = await prisma.domainAuditEvent.findFirstOrThrow({
      where: {
        taskId: fixture.taskId,
        action: "pm.task.draft_plan.replace",
      },
      orderBy: { createdAt: "desc" },
    });
    const auditJson = JSON.stringify({ before: audit.before, after: audit.after });
    expect(auditJson).not.toContain(sensitiveNeedle);
    expect(Buffer.byteLength(auditJson, "utf8")).toBeLessThan(100_000);
    expect(jsonRecord(audit.before)).toMatchObject({
      snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      plannedStartAt: iso(2026, 8, 1),
      nodeCount: 3,
    });
    expect(jsonRecord(audit.after)).toMatchObject({
      snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      plannedStartAt: iso(2026, 8, 1),
      nodeCount: 201,
      changes: {
        added: { totalCount: 201, truncated: false },
        removed: { totalCount: 3, truncated: false },
      },
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
          replaceTaskDraftPlan(
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

    const created = await replaceTaskDraftPlan(
      actor(owner),
      await draftPlanReplaceInput(fixture, 0, {
        firstMilestoneClientKey: "only-client-key-creates",
      }),
    );
    expect(created.nodeMappings).toEqual([
      expect.objectContaining({ clientKey: "only-client-key-creates" }),
    ]);
  });

  test("all six mutation actions enforce visible authorization, lifecycle and stale matrices with zero rejected effects", async () => {
    const admin = await createAccountPerson("S2 Matrix Admin");
    const owner = await createAccountPerson("S2 Matrix Owner");
    const reviewer = await createAccountPerson("S2 Matrix Reviewer");
    const viewer = await createAccountPerson("S2 Matrix Viewer");
    const outsider = await createAccountPerson("S2 Matrix Outsider");
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");

    const fixtures = new Map<string, Awaited<ReturnType<typeof createDraft>>>();
    for (const status of [
      "DRAFT",
      "ACTIVE",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
      "ARCHIVED",
    ] as const) {
      const fixture = await createDraft({
        creator: admin,
        owner,
        reviewer,
        title: `S2 matrix ${status}`,
      });
      if (status !== "DRAFT") {
        await activateTask(actor(owner), {
          taskId: fixture.taskId,
          expectedLockVersion: 0,
        });
        if (status !== "ACTIVE") {
          await prisma.task.update({
            where: { id: fixture.taskId },
            data: { status },
          });
        }
      }
      fixtures.set(status, fixture);
    }

    for (const mutationCase of MUTATION_ACTION_CASES) {
      const allowedFixture = fixtures.get(mutationCase.requiredStatus);
      if (!allowedFixture) throw new Error("缺少 mutation 状态 fixture");
      const allowedTask = await currentTask(allowedFixture.taskId);
      const beforeUnauthorized = await mutationSideEffectCounts(
        allowedFixture.taskId,
      );
      await expectServiceError(
        invokeMutationAction(
          mutationCase.name,
          actor(viewer),
          allowedFixture,
          allowedTask.lockVersion,
        ),
        "FORBIDDEN",
      );
      expect(await mutationSideEffectCounts(allowedFixture.taskId)).toEqual(
        beforeUnauthorized,
      );

      await expectServiceError(
        invokeMutationAction(
          mutationCase.name,
          actor(outsider),
          allowedFixture,
          allowedTask.lockVersion,
        ),
        "FORBIDDEN",
      );
      expect(await mutationSideEffectCounts(allowedFixture.taskId)).toEqual(
        beforeUnauthorized,
      );

      await expectServiceError(
        invokeMutationAction(
          mutationCase.name,
          actor(owner),
          allowedFixture,
          allowedTask.lockVersion + 1,
        ),
        "STALE_TASK",
        { expectedCurrentLockVersion: allowedTask.lockVersion },
      );
      expect(await mutationSideEffectCounts(allowedFixture.taskId)).toEqual(
        beforeUnauthorized,
      );

      for (const [status, fixture] of fixtures) {
        if (status === mutationCase.requiredStatus) continue;
        const task = await currentTask(fixture.taskId);
        const before = await mutationSideEffectCounts(fixture.taskId);
        await expectServiceError(
          invokeMutationAction(
            mutationCase.name,
            actor(owner),
            fixture,
            task.lockVersion,
          ),
          "STATE_CONFLICT",
        );
        expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(before);
      }
    }
  });

  test("all six mutation actions serialize the same lock version exactly once", async () => {
    const admin = await createAccountPerson("S2 Exactly Once Admin");
    const owner = await createAccountPerson("S2 Exactly Once Owner");
    const reviewer = await createAccountPerson("S2 Exactly Once Reviewer");
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");

    for (const mutationCase of MUTATION_ACTION_CASES) {
      const initialTag = await createTag(
        admin.account.id,
        `S2 exactly once tag ${mutationCase.name}`,
      );
      let requestedMembers: Array<{
        personId: string;
        role: TaskMemberRole;
      }> | undefined;
      let expectedChangedPeople: AccountPerson[] = [];
      const extraMembers: Array<{
        personId: string;
        role: TaskMemberRole;
      }> = [];
      if (mutationCase.name === "replaceTaskMembers") {
        const removed = await createAccountPerson("S2 Concurrent Removed");
        const added = await createAccountPerson("S2 Concurrent Added");
        extraMembers.push({ personId: removed.person.id, role: "PARTICIPANT" });
        requestedMembers = [
          { personId: owner.person.id, role: "OWNER" },
          { personId: reviewer.person.id, role: "PARTICIPANT" },
          { personId: added.person.id, role: "PARTICIPANT" },
        ];
        expectedChangedPeople = [admin, removed, added];
      }
      const fixture = await createDraft({
        creator: admin,
        owner,
        reviewer,
        title: `S2 exactly once ${mutationCase.name}`,
        extraMembers,
        tagIds: [initialTag.id],
      });
      if (mutationCase.requiredStatus === "ACTIVE") {
        await activateTask(actor(owner), {
          taskId: fixture.taskId,
          expectedLockVersion: 0,
        });
      }
      const beforeTask = await currentTask(fixture.taskId);
      const beforeSnapshot = await mutationSideEffectCounts(fixture.taskId);
      const auditBefore = await prisma.domainAuditEvent.count({
        where: { taskId: fixture.taskId, action: mutationCase.auditAction },
      });
      const outcomes = await runBehindTaskLockBarrier(fixture.taskId, [
        () =>
          invokeMutationAction(
            mutationCase.name,
            actor(owner),
            fixture,
            beforeTask.lockVersion,
            { members: requestedMembers },
          ),
        () =>
          invokeMutationAction(
            mutationCase.name,
            actor(owner),
            fixture,
            beforeTask.lockVersion,
            { members: requestedMembers },
          ),
      ]);
      expect(serviceOutcomeCodes(outcomes)).toEqual(["OK", "STALE_TASK"]);
      expect((await currentTask(fixture.taskId)).lockVersion).toBe(
        beforeTask.lockVersion + 1,
      );
      expect(
        await prisma.domainAuditEvent.count({
          where: { taskId: fixture.taskId, action: mutationCase.auditAction },
        }),
      ).toBe(auditBefore + 1);
      const afterSnapshot = await mutationSideEffectCounts(fixture.taskId);
      expectMutationBusinessEffect(
        mutationCase.name,
        beforeSnapshot,
        afterSnapshot,
      );
      if (mutationCase.name === "replaceTaskMembers") {
        const eventPrefix = `pm:task:member_changed:${fixture.taskId}:${beforeTask.lockVersion + 1}:`;
        const outboxes = await prisma.notificationOutbox.findMany({
          where: { eventKey: { startsWith: eventPrefix } },
        });
        expect(outboxes).toHaveLength(expectedChangedPeople.length);
        expect(
          outboxes
            .map((row) =>
              String(
                jsonRecord(jsonRecord(JSON.parse(row.payload)).context)
                  .affectedPersonId,
              ),
            )
            .sort(),
        ).toEqual(expectedChangedPeople.map((person) => person.person.id).sort());
        const inAppRows = await prisma.inAppNotification.findMany({
          where: { eventKey: { startsWith: eventPrefix } },
          select: { recipientAccountId: true },
        });
        expect(inAppRows.map((row) => row.recipientAccountId).sort()).toEqual(
          expectedChangedPeople.map((person) => person.account.id).sort(),
        );
      }
    }
  });

  test("all six mutation actions roll back business, audit, lock and notifications on a controlled late failure", async () => {
    const admin = await createAccountPerson("S2 Late Failure Admin");
    const owner = await createAccountPerson("S2 Late Failure Owner");
    const reviewer = await createAccountPerson("S2 Late Failure Reviewer");
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
    const fixtures: Array<{
      mutationCase: (typeof MUTATION_ACTION_CASES)[number];
      fixture: Awaited<ReturnType<typeof createDraft>>;
    }> = [];
    for (const mutationCase of MUTATION_ACTION_CASES) {
      const initialTag = await createTag(
        admin.account.id,
        `S2 late failure tag ${mutationCase.name}`,
      );
      const fixture = await createDraft({
        creator: admin,
        owner,
        reviewer,
        title: `S2 late failure ${mutationCase.name}`,
        tagIds: [initialTag.id],
      });
      if (mutationCase.requiredStatus === "ACTIVE") {
        await activateTask(actor(owner), {
          taskId: fixture.taskId,
          expectedLockVersion: 0,
        });
      }
      fixtures.push({ mutationCase, fixture });
    }

    await installControlledAuditFailureTrigger();
    try {
      for (const { mutationCase, fixture } of fixtures) {
        const task = await currentTask(fixture.taskId);
        const before = await mutationSideEffectCounts(fixture.taskId);
        await expect(
          invokeMutationAction(
            mutationCase.name,
            actor(owner),
            fixture,
            task.lockVersion,
          ),
        ).rejects.toThrow("s2 controlled late audit failure");
        expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(before);
      }
    } finally {
      await removeControlledAuditFailureTrigger();
    }
  });

  test("Active member replacement rolls back after InApp write when outbox insertion fails", async () => {
    const admin = await createAccountPerson("S2 Outbox Rollback Admin");
    const owner = await createAccountPerson("S2 Outbox Rollback Owner");
    const reviewer = await createAccountPerson("S2 Outbox Rollback Reviewer");
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
    const fixture = await createDraft({ creator: admin, owner, reviewer });
    await activateTask(actor(owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 0,
    });
    const before = await mutationSideEffectCounts(fixture.taskId);

    await installControlledMemberOutboxFailureTrigger();
    try {
      await expect(
        replaceTaskMembers(actor(owner), {
          taskId: fixture.taskId,
          expectedLockVersion: 1,
          members: [
            { personId: owner.person.id, role: "OWNER" },
            { personId: reviewer.person.id, role: "PARTICIPANT" },
          ],
        }),
      ).rejects.toThrow("s2 controlled outbox failure after inapp");
    } finally {
      await removeControlledMemberOutboxFailureTrigger();
    }
    expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(before);
  });

  test("Draft plan replace refuses every historical Segment reference without partial effects", async () => {
    const cases: Array<{
      name: string;
      createReference: (input: SegmentReferenceFixture) => Promise<void>;
    }> = [
      ...(
        [
          "PLANNED",
          "IN_PROGRESS",
          "PENDING_CONFIRMATION",
          "CONFIRMED",
          "CANCELLED",
        ] as WorkSegmentStatus[]
      ).map((status) => ({
        name: `Planned ${status}`,
        createReference: (input: SegmentReferenceFixture) =>
          createSegmentReference({ ...input, type: "PLANNED", status }),
      })),
      {
        name: "soft-deleted Actual",
        createReference: (input) =>
          createSegmentReference({
            ...input,
            type: "ACTUAL",
            status: "CONFIRMED",
            deletedAt: new Date(),
          }),
      },
      {
        name: "associationNeedsReview",
        createReference: (input) =>
          createSegmentReference({
            ...input,
            type: "PLANNED",
            status: "PLANNED",
            associationNeedsReview: true,
          }),
      },
      {
        name: "historical Planned to Actual source",
        createReference: createSourceHistoryReference,
      },
    ];

    for (const segmentCase of cases) {
      const admin = await createAccountPerson(`S2 Ref Admin ${segmentCase.name}`);
      const owner = await createAccountPerson(`S2 Ref Owner ${segmentCase.name}`);
      const reviewer = await createAccountPerson(
        `S2 Ref Reviewer ${segmentCase.name}`,
      );
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({ creator: admin, owner, reviewer });
      const plan = await currentPlan(fixture.taskId);
      const retained = plan.nodes[0];
      const referenced = plan.nodes[1];
      const termination = plan.nodes.at(-1);
      if (!retained?.node.milestone || !referenced || !termination?.node.termination) {
        throw new Error(`测试计划结构不完整：${segmentCase.name}`);
      }
      await segmentCase.createReference({
        taskId: fixture.taskId,
        nodeId: referenced.nodeId,
        personId: owner.person.id,
        accountId: admin.account.id,
      });
      const before = await mutationSideEffectCounts(fixture.taskId);

      await expectServiceError(
        replaceTaskDraftPlan(actor(owner), {
          taskId: fixture.taskId,
          planVersionId: fixture.currentPlanVersionId,
          expectedLockVersion: 0,
          plannedStartAt: iso(2026, 8, 1),
          milestones: [
            {
              nodeId: retained.nodeId,
              goal: retained.node.milestone.goal,
              completionCriteria:
                retained.node.milestone.completionCriteria,
              expectedCompletedAt:
                retained.node.milestone.expectedCompletedAt.toISOString(),
              reviewRequirements:
                retained.node.milestone.reviewRequirements,
              businessDescription: retained.node.businessDescription,
            },
          ],
          termination: {
            nodeId: termination.nodeId,
            plannedOutcomeCriteria:
              termination.node.termination.plannedOutcomeCriteria,
            plannedAt: termination.node.termination.plannedAt.toISOString(),
            businessDescription: termination.node.businessDescription,
          },
        }),
        "ASSOCIATION_INVALID",
      );
      expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(before);
      expect(
        await prisma.taskNode.findUnique({ where: { id: referenced.nodeId } }),
      ).not.toBeNull();
    }
  });

  test("Active metadata, members and tags keep history, audit all changes and enqueue guarded operator-accurate notifications", async () => {
    expect(process.env.NOTIFICATION_DELIVERY_DISABLED).toBe("true");
    expect(new URL(process.env.DATABASE_URL ?? "").pathname).toMatch(/_test$/);
    const admin = await createAccountPerson("S2 Active Admin");
    const owner = await createAccountPerson("S2 Active Owner");
    const reviewer = await createAccountPerson("S2 Active Reviewer");
    const member = await createAccountPerson("S2 Active Member");
    const newcomer = await createAccountPerson("S2 Active Newcomer");
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
    const firstTag = await createTag(admin.account.id, "Active Tag A");
    const secondTag = await createTag(admin.account.id, "Active Tag B");
    const fixture = await createDraft({
      creator: admin,
      owner,
      reviewer,
      extraMembers: [{ personId: member.person.id, role: "PARTICIPANT" }],
      tagIds: [firstTag.id],
    });
    const activated = await activateTask(actor(owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 0,
    });
    expect(activated.lockVersion).toBe(1);

    await expectServiceError(
      updateTaskDraftMetadata(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 1,
        title: "Draft-only metadata",
        description: "",
        team: "英雄",
        techGroup: "电控",
        priority: "HIGH",
        relatedTaskId: null,
        tagIds: [firstTag.id],
      }),
      "STATE_CONFLICT",
    );
    await expectServiceError(
      replaceTaskDraftPlan(actor(owner), {
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

    const membersResult = await replaceTaskMembers(actor(owner), {
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
    ).toBe(2);

    const memberOutbox = await prisma.notificationOutbox.findMany({
      where: {
        eventKey: { startsWith: `pm:task:member_changed:${fixture.taskId}:2:` },
      },
    });
    expect(memberOutbox).toHaveLength(3);
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
      expect(jsonRecord(payload.context).result).toBe("SUCCESS");
    }
    expect(
      await prisma.inAppNotification.count({
        where: {
          eventKey: {
            startsWith: `pm:task:member_changed:${fixture.taskId}:2:`,
          },
        },
      }),
    ).toBe(3);

    const outboxBeforeTags = await prisma.notificationOutbox.count();
    const tagsResult = await replaceTaskTags(actor(owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 2,
      tagIds: [secondTag.id],
    });
    expect(tagsResult).toMatchObject({
      lockVersion: 3,
      tagIds: [secondTag.id],
    });
    expect(await prisma.notificationOutbox.count()).toBe(outboxBeforeTags);

    const metadataResult = await updateTaskMetadata(actor(admin), {
      taskId: fixture.taskId,
      expectedLockVersion: 3,
      title: "Active metadata updated",
      description: "计划语义未改变",
      team: "英雄",
      techGroup: "电控",
      priority: "LOW",
      relatedTaskId: null,
    });
    expect(metadataResult.lockVersion).toBe(4);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          taskId: fixture.taskId,
          action: {
            in: [
              "pm.task.members.replace",
              "pm.task.tags.replace",
              "pm.task.metadata.update",
            ],
          },
        },
      }),
    ).toBe(3);

    const beforeStale = await mutationSideEffectCounts(fixture.taskId);
    await expectServiceError(
      replaceTaskMembers(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 3,
        members: membersResult.members,
      }),
      "STALE_TASK",
      { expectedCurrentLockVersion: 4 },
    );
    expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(beforeStale);
    await expectServiceError(
      replaceTaskDraftMembers(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 4,
        members: membersResult.members,
      }),
      "STATE_CONFLICT",
    );
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
        [{ personId: reviewer.person.id, role: "PARTICIPANT" }],
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
      for (const members of invalidSets) {
        const before = await mutationSideEffectCounts(fixture.taskId);
        await expectServiceError(
          requiredStatus === "DRAFT"
            ? replaceTaskDraftMembers(actor(owner), {
                taskId: fixture.taskId,
                expectedLockVersion: task.lockVersion,
                members,
              })
            : replaceTaskMembers(actor(owner), {
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

    const result = await replaceTaskMembers(actor(owner), {
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
    expect(outboxes).toHaveLength(8);
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
    expect(payloadByPersonId.get(admin.person.id)).toMatchObject({
      recipientOpenIds: [admin.openId],
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
        inactive.account.id,
        bound.account.id,
        wrongTenant.account.id,
        firstBlankThenValid.account.id,
        admin.account.id,
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

  test("Task association lock orders Segment writer and Draft replace without deadlock or silent nodeId nulling", async () => {
    expect(new URL(process.env.DATABASE_URL ?? "").pathname).toMatch(/_test$/);
    const admin = await createAccountPerson("S2 Association Lock Admin");
    const owner = await createAccountPerson("S2 Association Lock Owner");
    const reviewer = await createAccountPerson("S2 Association Lock Reviewer");
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");

    for (const first of ["WRITER", "REPLACE"] as const) {
      const fixture = await createDraft({
        creator: admin,
        owner,
        reviewer,
        title: `S2 association order ${first}`,
      });
      const plan = await currentPlan(fixture.taskId);
      const retained = plan.nodes[0];
      const removed = plan.nodes[1];
      const termination = plan.nodes.at(-1);
      if (!retained?.node.milestone || !removed || !termination?.node.termination) {
        throw new Error("缺少关联锁测试计划节点");
      }
      const writer = () =>
        createWorkSegment(actor(owner), {
          personId: owner.person.id,
          type: "PLANNED",
          startAt: new Date("2026-08-03T01:00:00.000Z"),
          endAt: new Date("2026-08-03T02:00:00.000Z"),
          content: `association writer ${first}`,
          taskId: fixture.taskId,
          nodeId: removed.nodeId,
        });
      const replace = () =>
        replaceTaskDraftPlan(actor(owner), {
          taskId: fixture.taskId,
          planVersionId: fixture.currentPlanVersionId,
          expectedLockVersion: 0,
          plannedStartAt: iso(2026, 8, 1),
          milestones: [planMilestoneReplacement(retained)],
          termination: planTerminationReplacement(termination),
        });
      const operations = first === "WRITER" ? [writer, replace] : [replace, writer];
      const outcomes = await runTaskAssociationLockChain(
        fixture.taskId,
        operations[0],
        operations[1],
      );
      const codes = serviceOutcomeCodes(outcomes);
      if (first === "WRITER") {
        expect(codes).toEqual(["ASSOCIATION_INVALID", "OK"]);
        const segment = await prisma.workSegment.findFirstOrThrow({
          where: { taskId: fixture.taskId, content: `association writer ${first}` },
        });
        expect(segment.nodeId).toBe(removed.nodeId);
        expect(await prisma.taskNode.findUnique({ where: { id: removed.nodeId } })).not.toBeNull();
      } else {
        expect(codes).toEqual(["ASSOCIATION_INVALID", "OK"]);
        expect(
          await prisma.workSegment.count({
            where: { taskId: fixture.taskId, content: `association writer ${first}` },
          }),
        ).toBe(0);
        expect(await prisma.taskNode.findUnique({ where: { id: removed.nodeId } })).toBeNull();
      }
      expect(
        await prisma.workSegment.count({
          where: { taskId: fixture.taskId, nodeId: null },
        }),
      ).toBe(0);
    }
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
    const hiddenNodeId = (await currentPlan(hidden.taskId)).nodes[0]?.nodeId;
    if (!hiddenNodeId) throw new Error("缺少隐藏 Task 节点");

    const updateBase = await createWorkSegment(actor(operator), {
      ...segmentCreateInput(operator.person.id, "oracle update base"),
      type: "PLANNED",
    });
    const relinkBase = await createWorkSegment(actor(operator), {
      ...segmentCreateInput(operator.person.id, "oracle relink base", 3),
      type: "PLANNED",
    });
    await prisma.workSegment.update({
      where: { id: updateBase.segment.id },
      data: { associationNeedsReview: true },
    });
    await prisma.workSegment.update({
      where: { id: relinkBase.segment.id },
      data: { associationNeedsReview: true },
    });
    const reloadedRelink = await prisma.workSegment.findUniqueOrThrow({
      where: { id: relinkBase.segment.id },
    });
    const reloadedUpdate = await prisma.workSegment.findUniqueOrThrow({
      where: { id: updateBase.segment.id },
    });

    const cases: Array<{
      name: string;
      invoke: (taskId: string, nodeId: string) => Promise<unknown>;
    }> = [
      {
        name: "single Planned",
        invoke: (taskId, nodeId) =>
          createWorkSegment(actor(operator), {
            ...segmentCreateInput(operator.person.id, "oracle single", 5),
            type: "PLANNED",
            taskId,
            nodeId,
          }),
      },
      {
        name: "batch Planned",
        invoke: (taskId, nodeId) =>
          batchCreatePlannedSegments(actor(operator), {
            segments: [
              {
                ...segmentCreateInput(operator.person.id, "oracle batch", 7),
                type: "PLANNED",
                taskId,
                nodeId,
              },
            ],
          }),
      },
      {
        name: "Actual",
        invoke: (taskId, nodeId) =>
          createActualSegment(actor(operator), {
            ...segmentCreateInput(operator.person.id, "oracle actual", 9),
            taskId,
            nodeId,
            actualOutput: "oracle actual output",
            completionPercent: 100,
            sources: [],
          }),
      },
      {
        name: "update",
        invoke: (taskId, nodeId) =>
          updateWorkSegment(actor(operator), {
            segmentId: reloadedUpdate.id,
            expectedUpdatedAt: reloadedUpdate.updatedAt,
            associationIntent: "RELINK",
            taskId,
            nodeId,
            reason: "oracle update",
          }),
      },
      {
        name: "relink",
        invoke: (taskId, nodeId) =>
          relinkPlannedSegment(actor(operator), {
            segmentId: reloadedRelink.id,
            expectedUpdatedAt: reloadedRelink.updatedAt,
            taskId,
            nodeId,
            reason: "oracle relink",
          }),
      },
    ];

    for (const associationCase of cases) {
      for (const target of [
        {
          taskId: randomUUID(),
          nodeId: randomUUID(),
          expectedCode: "NOT_FOUND" as const,
        },
        {
          taskId: hidden.taskId,
          nodeId: hiddenNodeId,
          expectedCode: "ASSOCIATION_INVALID" as const,
        },
      ]) {
        const before = await segmentAssociationSideEffectSnapshot([
          updateBase.segment.id,
          reloadedRelink.id,
        ]);
        await expectServiceError(
          associationCase.invoke(target.taskId, target.nodeId),
          target.expectedCode,
        );
        expect(
          await segmentAssociationSideEffectSnapshot([
            updateBase.segment.id,
            reloadedRelink.id,
          ]),
          associationCase.name,
        ).toEqual(before);
      }
    }
  });

  test("Revision notification excludes a Segment cancelled while the apply waits for its row lock", async () => {
    expect(process.env.NOTIFICATION_DELIVERY_DISABLED).toBe("true");
    expect(new URL(process.env.DATABASE_URL ?? "").pathname).toMatch(/_test$/);

    const admin = await createAccountPerson("S2 Revision Cancel Race Admin");
    const owner = await createAccountPerson("S2 Revision Cancel Race Owner");
    const reviewer = await createAccountPerson(
      "S2 Revision Cancel Race Reviewer",
    );
    const member = await createAccountPerson("S2 Revision Cancel Race Member");
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
    const fixture = await createDraft({
      creator: admin,
      owner,
      reviewer,
      title: "S2 Revision cancellation serialization",
      extraMembers: [{ personId: member.person.id, role: "PARTICIPANT" }],
    });
    await activateTask(actor(owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 0,
    });
    const current = await currentPlan(fixture.taskId);
    const revisedFrom = current.nodes.find(
      (entry) => entry.node.status === "ACTIVE",
    );
    if (!revisedFrom) throw new Error("缺少 Revision 并发测试起点");

    const cancelledCandidate = await createWorkSegment(actor(member), {
      ...segmentCreateInput(member.person.id, "Revision 等待期间取消", 11),
      type: "PLANNED",
      taskId: fixture.taskId,
      nodeId: revisedFrom.nodeId,
    });
    const retainedCandidate = await createWorkSegment(actor(member), {
      ...segmentCreateInput(member.person.id, "Revision 仍需关联复核", 13),
      type: "PLANNED",
      taskId: fixture.taskId,
      nodeId: revisedFrom.nodeId,
    });
    const taskBeforeRevision = await currentTask(fixture.taskId);
    const revision = await createRevisionDraft(actor(owner), {
      taskId: fixture.taskId,
      basePlanVersionId: current.id,
      baseTaskLockVersion: taskBeforeRevision.lockVersion,
      revisedFromNodeId: revisedFrom.nodeId,
      reason: "验证取消与 Revision 生效串行化",
      plannedStartAt: iso(2026, 8, 1),
      replacementMilestones: [milestoneInput("并发后的替代节点", 6)],
      termination: terminationInput(8),
      idempotencyKey: `s2-revision-cancel-race-${randomUUID()}`,
    });
    await submitRevision(actor(owner), {
      revisionNodeId: revision.revisionNodeId,
      comment: "提交并发回归 Revision",
    });

    const outcomes = await runCancellationBeforeRevisionBehindSegmentLock(
      cancelledCandidate.segment.id,
      () =>
        cancelPlannedSegment(actor(member), {
          segmentId: cancelledCandidate.segment.id,
          expectedUpdatedAt: cancelledCandidate.segment.updatedAt,
          reason: "Revision 生效前取消",
        }),
      () =>
        approveRevision(actor(admin), {
          revisionNodeId: revision.revisionNodeId,
          comment: "取消完成后批准 Revision",
        }),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
    }

    const persistedSegments = await prisma.workSegment.findMany({
      where: {
        id: {
          in: [
            cancelledCandidate.segment.id,
            retainedCandidate.segment.id,
          ],
        },
      },
      select: { id: true, status: true, associationNeedsReview: true },
    });
    expect(
      persistedSegments.find(
        (segment) => segment.id === cancelledCandidate.segment.id,
      ),
    ).toMatchObject({ status: "CANCELLED", associationNeedsReview: false });
    expect(
      persistedSegments.find(
        (segment) => segment.id === retainedCandidate.segment.id,
      ),
    ).toMatchObject({ status: "PLANNED", associationNeedsReview: true });
    expect(
      await prisma.workSegmentChange.count({
        where: {
          segmentId: cancelledCandidate.segment.id,
          reason: "Revision 生效后原关联节点失效",
        },
      }),
    ).toBe(0);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "WorkSegment",
          entityId: cancelledCandidate.segment.id,
          action: "pm.segment.update",
          reason: "Revision 生效后原关联节点失效",
        },
      }),
    ).toBe(0);

    const associationOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: {
        eventKey: `pm:segment:association_invalidated:${revision.revisionNodeId}:feishu`,
      },
      select: { payload: true },
    });
    const payload = jsonRecord(JSON.parse(associationOutbox.payload));
    expect(jsonRecord(payload.context).affectedSegmentIds).toEqual([
      retainedCandidate.segment.id,
    ]);
    expect(payload.summary).toContain("1 条 Planned Segment");
  });

  test("Revision validates the authoritative carried prefix and submit cannot bypass missing plannedStartAt", async () => {
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
    const revisedFrom = current.nodes.find(
      (entry) => entry.node.status === "ACTIVE",
    );
    if (!revisedFrom) throw new Error("缺少修订起点");

    const planCountBefore = await prisma.taskPlanVersion.count({
      where: { taskId: fixture.taskId },
    });
    await expectServiceError(
      createRevisionDraft(actor(owner), {
        taskId: fixture.taskId,
        basePlanVersionId: current.id,
        baseTaskLockVersion: task.lockVersion,
        revisedFromNodeId: revisedFrom.nodeId,
        reason: "非法抬高计划起点",
        plannedStartAt: iso(2026, 8, 3),
        replacementMilestones: [milestoneInput("修订 M2", 6)],
        termination: terminationInput(8),
        idempotencyKey: `s2-revision-invalid-${randomUUID()}`,
      }),
      "PLAN_CHRONOLOGY_INVALID",
    );
    expect(
      await prisma.taskPlanVersion.count({ where: { taskId: fixture.taskId } }),
    ).toBe(planCountBefore);

    const revision = await createRevisionDraft(actor(owner), {
      taskId: fixture.taskId,
      basePlanVersionId: current.id,
      baseTaskLockVersion: task.lockVersion,
      revisedFromNodeId: revisedFrom.nodeId,
      reason: "合法完整修订",
      plannedStartAt: iso(2026, 8, 1),
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
    const auditBeforeSubmit = await prisma.domainAuditEvent.count({
      where: { taskId: fixture.taskId, action: "pm.revision.submit" },
    });
    await expectServiceError(
      submitRevision(actor(owner), {
        revisionNodeId: revision.revisionNodeId,
        comment: "不得绕过 chronology",
      }),
      "PLAN_CHRONOLOGY_INVALID",
    );
    expect(
      await prisma.domainAuditEvent.count({
        where: { taskId: fixture.taskId, action: "pm.revision.submit" },
      }),
    ).toBe(auditBeforeSubmit);

    await prisma.taskPlanVersion.update({
      where: { id: targetPlan.id },
      data: { plannedStartAt: new Date(iso(2026, 8, 1)) },
    });
    const submitted = await submitRevision(actor(owner), {
      revisionNodeId: revision.revisionNodeId,
      comment: "提交合法修订",
    });
    expect(submitted.status).toBe("PENDING_APPROVAL");
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

  test("legacy Active chronology can be repaired by Revision or closed by Termination while target validation remains strict", async () => {
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
    const legacyTask = await currentTask(legacy.taskId);
    const revision = await createRevisionDraft(actor(owner), {
      taskId: legacy.taskId,
      basePlanVersionId: legacy.currentPlanVersionId,
      baseTaskLockVersion: legacyTask.lockVersion,
      revisedFromNodeId: active.nodeId,
      reason: "修复 legacy Current chronology",
      plannedStartAt: iso(2026, 8, 1),
      replacementMilestones: [milestoneInput("Repaired M3", 6)],
      termination: terminationInput(8),
      idempotencyKey: `s2-legacy-repair-${randomUUID()}`,
    });
    expect(
      await submitRevision(actor(owner), {
        revisionNodeId: revision.revisionNodeId,
        comment: "提交 legacy 修复",
      }),
    ).toMatchObject({ status: "PENDING_APPROVAL" });
    expect(
      await approveRevision(actor(admin), {
        revisionNodeId: revision.revisionNodeId,
        comment: "应用 legacy 修复",
      }),
    ).toMatchObject({ status: "EFFECTIVE" });

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
    expect(
      await confirmTermination(actor(closeFixture.owner), {
        taskId: closeFixture.taskId,
        terminationNodeId: closeTermination.nodeId,
        outcome: "FAILED",
        reason: "legacy 计划无法继续，安全结束",
        summary: "保留历史后结束",
        expectedLockVersion: 1,
      }),
    ).toMatchObject({ status: "FAILED", outcome: "FAILED" });
  });
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MUTATION_ACTION_CASES = [
  {
    name: "updateTaskDraftMetadata",
    requiredStatus: "DRAFT",
    auditAction: "pm.task.draft_metadata.update",
  },
  {
    name: "replaceTaskDraftMembers",
    requiredStatus: "DRAFT",
    auditAction: "pm.task.draft_members.replace",
  },
  {
    name: "replaceTaskDraftPlan",
    requiredStatus: "DRAFT",
    auditAction: "pm.task.draft_plan.replace",
  },
  {
    name: "updateTaskMetadata",
    requiredStatus: "ACTIVE",
    auditAction: "pm.task.metadata.update",
  },
  {
    name: "replaceTaskMembers",
    requiredStatus: "ACTIVE",
    auditAction: "pm.task.members.replace",
  },
  {
    name: "replaceTaskTags",
    requiredStatus: "ACTIVE",
    auditAction: "pm.task.tags.replace",
  },
] as const;

type AccountPerson = Awaited<ReturnType<typeof createAccountPerson>>;
type DraftFixture = Awaited<ReturnType<typeof createDraft>>;
type MutationActionName = (typeof MUTATION_ACTION_CASES)[number]["name"];
type PlanEntryFixture = Awaited<ReturnType<typeof currentPlan>>["nodes"][number];

async function invokeMutationAction(
  name: MutationActionName,
  inputActor: ProjectManagementActor,
  fixture: DraftFixture,
  expectedLockVersion: number,
  options: {
    members?: Array<{ personId: string; role: TaskMemberRole }>;
  } = {},
) {
  if (name === "updateTaskDraftMetadata") {
    return updateTaskDraftMetadata(inputActor, {
      taskId: fixture.taskId,
      expectedLockVersion,
      title: `S2 mutation ${name}`,
      description: "mutation matrix",
      team: "英雄",
      techGroup: "电控",
      priority: "HIGH",
      relatedTaskId: null,
      tagIds: [],
    });
  }
  if (name === "replaceTaskDraftMembers") {
    return replaceTaskDraftMembers(inputActor, {
      taskId: fixture.taskId,
      expectedLockVersion,
      members: options.members ?? fixtureMembers(fixture),
    });
  }
  if (name === "replaceTaskDraftPlan") {
    const planInput = await draftPlanReplaceInput(fixture, expectedLockVersion);
    const firstMilestone = planInput.milestones[0];
    if (!firstMilestone) throw new Error("缺少 mutation Milestone");
    firstMilestone.goal = `${firstMilestone.goal}（mutation）`;
    return replaceTaskDraftPlan(inputActor, planInput);
  }
  if (name === "updateTaskMetadata") {
    return updateTaskMetadata(inputActor, {
      taskId: fixture.taskId,
      expectedLockVersion,
      title: `S2 mutation ${name}`,
      description: "mutation matrix",
      team: "英雄",
      techGroup: "电控",
      priority: "HIGH",
      relatedTaskId: null,
    });
  }
  if (name === "replaceTaskMembers") {
    return replaceTaskMembers(inputActor, {
      taskId: fixture.taskId,
      expectedLockVersion,
      members: options.members ?? fixtureMembers(fixture),
    });
  }
  return replaceTaskTags(inputActor, {
    taskId: fixture.taskId,
    expectedLockVersion,
    tagIds: [],
  });
}

function fixtureMembers(fixture: DraftFixture) {
  return [
    { personId: fixture.owner.person.id, role: "OWNER" as const },
    { personId: fixture.reviewer.person.id, role: "PARTICIPANT" as const },
  ];
}

async function draftPlanReplaceInput(
  fixture: DraftFixture,
  expectedLockVersion: number,
  options: {
    firstMilestoneNodeId?: string;
    firstMilestoneClientKey?: string;
  } = {},
) {
  const plan = await currentPlan(fixture.taskId);
  const milestones = plan.nodes.filter((entry) => entry.node.milestone);
  const termination = plan.nodes.at(-1);
  if (milestones.length === 0 || !termination?.node.termination) {
    throw new Error("缺少 Draft plan replace fixture");
  }
  return {
    taskId: fixture.taskId,
    planVersionId: fixture.currentPlanVersionId,
    expectedLockVersion,
    plannedStartAt: plan.plannedStartAt?.toISOString() ?? iso(2026, 8, 1),
    milestones: milestones.map((entry, index) => ({
      ...(index === 0 && options.firstMilestoneClientKey
        ? { clientKey: options.firstMilestoneClientKey }
        : {
            nodeId:
              index === 0 && options.firstMilestoneNodeId
                ? options.firstMilestoneNodeId
                : entry.nodeId,
          }),
      ...planMilestoneReplacementFields(entry),
    })),
    termination: planTerminationReplacement(termination),
  };
}

function planMilestoneReplacement(entry: PlanEntryFixture) {
  return {
    nodeId: entry.nodeId,
    ...planMilestoneReplacementFields(entry),
  };
}

function planMilestoneReplacementFields(entry: PlanEntryFixture) {
  if (!entry.node.milestone) throw new Error("计划节点不是 Milestone");
  return {
    goal: entry.node.milestone.goal,
    completionCriteria: entry.node.milestone.completionCriteria,
    expectedCompletedAt: entry.node.milestone.expectedCompletedAt.toISOString(),
    reviewRequirements: entry.node.milestone.reviewRequirements,
    businessDescription: entry.node.businessDescription,
  };
}

function planTerminationReplacement(entry: PlanEntryFixture) {
  if (!entry.node.termination) throw new Error("计划节点不是 Termination");
  return {
    nodeId: entry.nodeId,
    plannedOutcomeCriteria: entry.node.termination.plannedOutcomeCriteria,
    plannedAt: entry.node.termination.plannedAt.toISOString(),
    businessDescription: entry.node.businessDescription,
  };
}

async function createDraft(input: {
  creator: AccountPerson;
  owner: AccountPerson;
  reviewer: AccountPerson;
  title?: string;
  team?: "英雄" | "工程";
  techGroup?: "电控" | "机械";
  extraMembers?: Array<{ personId: string; role: TaskMemberRole }>;
  tagIds?: string[];
}) {
  const created = await createTaskDraft(
    actor(input.creator),
    taskDraftInput({
      ownerPersonId: input.owner.person.id,
      reviewerPersonId: input.reviewer.person.id,
      title: input.title,
      team: input.team,
      techGroup: input.techGroup,
      extraMembers: input.extraMembers,
      tagIds: input.tagIds,
    }),
  );
  return { ...created, owner: input.owner, reviewer: input.reviewer };
}

function taskDraftInput(input: {
  ownerPersonId: string;
  reviewerPersonId: string;
  title?: string;
  team?: "英雄" | "工程";
  techGroup?: "电控" | "机械";
  relatedTaskId?: string | null;
  sameDayMilestones?: boolean;
  extraMembers?: Array<{ personId: string; role: TaskMemberRole }>;
  tagIds?: string[];
}) {
  return {
    title: input.title ?? `S2 Task ${randomUUID()}`,
    description: "S2 plan mutations regression",
    team: input.team ?? "英雄",
    techGroup: input.techGroup ?? "电控",
    priority: "HIGH" as const,
    tagIds: input.tagIds ?? [],
    members: [
      { personId: input.ownerPersonId, role: "OWNER" as const },
      { personId: input.reviewerPersonId, role: "PARTICIPANT" as const },
      ...(input.extraMembers ?? []),
    ],
    plannedStartAt: iso(2026, 8, 1),
    milestones: [
      milestoneInput("M1", 2),
      milestoneInput("M2", input.sameDayMilestones ? 2 : 4),
    ],
    termination: terminationInput(8),
    relatedTaskId: input.relatedTaskId ?? null,
    idempotencyKey: `s2-task-${randomUUID()}`,
  };
}

function milestoneInput(goal: string, day: number) {
  return {
    goal,
    completionCriteria: `${goal} 完成条件`,
    expectedCompletedAt: iso(2026, 8, day),
    reviewRequirements: "提交文本证据",
    businessDescription: `${goal} 业务说明`,
  };
}

function terminationInput(day: number) {
  return {
    plannedOutcomeCriteria: "完成全部目标",
    plannedAt: iso(2026, 8, day),
    businessDescription: "结束确认",
  };
}

function iso(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day, 10, 0, 0)).toISOString();
}

function uniqueWhitespaceOpenId(seed: string) {
  return [...seed.replaceAll("-", "")]
    .map((character) =>
      " ".repeat(Number.parseInt(character, 16) + 1),
    )
    .join("\t");
}

async function createAccountPerson(displayName: string) {
  const openId = `ou_s2_plan_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: { create: { displayName, status: "ACTIVE" } },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { account, person: account.person, openId };
}

async function grantRole(
  accountId: string,
  role: ProjectManagementSystemRole,
  scope: { team: string; techGroup: string } = { team: "", techGroup: "" },
) {
  const isGlobalAdministrator =
    role === "SUPER_ADMINISTRATOR" || role === "PROJECT_ADMINISTRATOR";
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team: isGlobalAdministrator ? "" : scope.team,
      techGroup: isGlobalAdministrator
        ? ""
        : role === "GROUP_LEADER" && scope.team
          ? ""
          : scope.techGroup,
      revokedAt: isGlobalAdministrator ? null : new Date(),
    },
  });
}

function actor(input: AccountPerson): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles: [],
  };
}

async function currentTask(taskId: string) {
  return prisma.task.findUniqueOrThrow({ where: { id: taskId } });
}

async function currentPlan(taskId: string) {
  return prisma.taskPlanVersion.findFirstOrThrow({
    where: { task: { id: taskId }, status: "CURRENT" },
    include: {
      nodes: {
        include: {
          node: {
            include: { milestone: true, revision: true, termination: true },
          },
        },
        orderBy: { sequence: "asc" },
      },
    },
  });
}

async function createTag(accountId: string, prefix: string) {
  return prisma.tag.create({
    data: {
      name: `${prefix}-${randomUUID()}`,
      color: "#2563eb",
      createdByAccountId: accountId,
    },
  });
}

type SegmentReferenceFixture = {
  taskId: string;
  nodeId: string;
  personId: string;
  accountId: string;
};

async function createSegmentReference(
  input: SegmentReferenceFixture & {
    type: WorkSegmentType;
    status: WorkSegmentStatus;
    deletedAt?: Date;
    associationNeedsReview?: boolean;
  },
) {
  await prisma.workSegment.create({
    data: {
      personId: input.personId,
      type: input.type,
      status: input.status,
      startAt: new Date("2026-08-02T09:00:00.000Z"),
      endAt: new Date("2026-08-02T10:00:00.000Z"),
      content: `S2 reference ${input.type}/${input.status}`,
      taskId: input.taskId,
      nodeId: input.nodeId,
      associationNeedsReview: input.associationNeedsReview ?? false,
      deletedAt: input.deletedAt,
      createdByAccountId: input.accountId,
    },
  });
}

async function createSourceHistoryReference(input: SegmentReferenceFixture) {
  const planned = await prisma.workSegment.create({
    data: {
      personId: input.personId,
      type: "PLANNED",
      status: "CANCELLED",
      startAt: new Date("2026-08-02T09:00:00.000Z"),
      endAt: new Date("2026-08-02T10:00:00.000Z"),
      content: "历史 Planned 来源",
      taskId: input.taskId,
      nodeId: input.nodeId,
      createdByAccountId: input.accountId,
    },
  });
  const actual = await prisma.workSegment.create({
    data: {
      personId: input.personId,
      type: "ACTUAL",
      status: "CONFIRMED",
      startAt: planned.startAt,
      endAt: planned.endAt,
      content: "Actual 历史来源",
      taskId: input.taskId,
      nodeId: null,
      createdByAccountId: input.accountId,
    },
  });
  await prisma.workSegmentSource.create({
    data: {
      plannedSegmentId: planned.id,
      actualSegmentId: actual.id,
      coveredStartAt: planned.startAt,
      coveredEndAt: planned.endAt,
      createdByAccountId: input.accountId,
    },
  });
}

async function mutationSideEffectCounts(taskId: string) {
  const task = await currentTask(taskId);
  const plan = await currentPlan(taskId);
  return {
    lockVersion: task.lockVersion,
    updatedAt: task.updatedAt.toISOString(),
    taskMetadata: {
      title: task.title,
      description: task.description,
      team: task.team,
      techGroup: task.techGroup,
      priority: task.priority,
      relatedTaskId: task.relatedTaskId,
      status: task.status,
    },
    taskTagIds: (
      await prisma.taskTag.findMany({
        where: { taskId },
        select: { tagId: true },
        orderBy: { tagId: "asc" },
      })
    ).map((entry) => entry.tagId),
    memberRows: (
      await prisma.taskMember.findMany({
        where: { taskId },
        orderBy: { id: "asc" },
      })
    ).map((member) => ({
      id: member.id,
      personId: member.personId,
      role: member.role,
      removedAt: member.removedAt?.toISOString() ?? null,
      createdByAccountId: member.createdByAccountId,
      createdAt: member.createdAt.toISOString(),
    })),
    planUpdatedAt: plan.updatedAt.toISOString(),
    plannedStartAt: plan.plannedStartAt?.toISOString() ?? null,
    snapshotHash: plan.snapshotHash,
    planNodeCount: plan.nodes.length,
    nodeContent: plan.nodes.map((entry) => ({
      nodeId: entry.nodeId,
      sequence: entry.sequence,
      isCarryForward: entry.isCarryForward,
      type: entry.node.type,
      status: entry.node.status,
      deletedAt: entry.node.deletedAt?.toISOString() ?? null,
      businessDescription: entry.node.businessDescription,
      milestone: entry.node.milestone
        ? {
            goal: entry.node.milestone.goal,
            completionCriteria: entry.node.milestone.completionCriteria,
            expectedCompletedAt:
              entry.node.milestone.expectedCompletedAt.toISOString(),
            reviewRequirements: entry.node.milestone.reviewRequirements,
          }
        : null,
      termination: entry.node.termination
        ? {
            plannedOutcomeCriteria:
              entry.node.termination.plannedOutcomeCriteria,
            plannedAt: entry.node.termination.plannedAt.toISOString(),
          }
        : null,
    })),
    taskNodeRows: await prisma.taskNode.findMany({
      where: { taskId },
      select: {
        id: true,
        type: true,
        status: true,
        businessDescription: true,
        deletedAt: true,
      },
      orderBy: { id: "asc" },
    }),
    auditCount: await prisma.domainAuditEvent.count({ where: { taskId } }),
    auditRows: await prisma.domainAuditEvent.findMany({
      where: { taskId },
      select: { id: true, action: true, before: true, after: true, reason: true },
      orderBy: { id: "asc" },
    }),
    notificationRows: await prisma.inAppNotification.findMany({
      where: { taskId },
      select: {
        id: true,
        eventKey: true,
        recipientAccountId: true,
        payload: true,
      },
      orderBy: { id: "asc" },
    }),
    outboxRows: await prisma.notificationOutbox.findMany({
      where: { eventKey: { contains: taskId } },
      select: { id: true, eventKey: true, payload: true, status: true },
      orderBy: { id: "asc" },
    }),
  };
}

async function relatedTaskReferenceSideEffectSnapshot(
  taskIds: readonly string[],
  includeGlobalCounts: boolean,
) {
  const normalizedTaskIds = [...new Set(taskIds)].sort();
  const outboxWhere = {
    OR: normalizedTaskIds.map((taskId) => ({
      eventKey: { contains: taskId },
    })),
  };
  const [
    tasks,
    planVersions,
    planVersionNodes,
    taskNodes,
    taskMembers,
    taskTags,
    auditEvents,
    inAppNotifications,
    notificationOutboxes,
    globalCounts,
  ] = await Promise.all([
    prisma.task.findMany({
      where: { id: { in: normalizedTaskIds } },
      orderBy: { id: "asc" },
    }),
    prisma.taskPlanVersion.findMany({
      where: { taskId: { in: normalizedTaskIds } },
      orderBy: { id: "asc" },
    }),
    prisma.planVersionNode.findMany({
      where: { planVersion: { taskId: { in: normalizedTaskIds } } },
      orderBy: { id: "asc" },
    }),
    prisma.taskNode.findMany({
      where: { taskId: { in: normalizedTaskIds } },
      include: {
        milestone: true,
        revision: true,
        termination: true,
      },
      orderBy: { id: "asc" },
    }),
    prisma.taskMember.findMany({
      where: { taskId: { in: normalizedTaskIds } },
      orderBy: { id: "asc" },
    }),
    prisma.taskTag.findMany({
      where: { taskId: { in: normalizedTaskIds } },
      orderBy: { id: "asc" },
    }),
    prisma.domainAuditEvent.findMany({
      where: { taskId: { in: normalizedTaskIds } },
      orderBy: { id: "asc" },
    }),
    prisma.inAppNotification.findMany({
      where: { taskId: { in: normalizedTaskIds } },
      orderBy: { id: "asc" },
    }),
    prisma.notificationOutbox.findMany({
      where: outboxWhere,
      include: { recipients: { orderBy: { id: "asc" } } },
      orderBy: { id: "asc" },
    }),
    includeGlobalCounts
      ? relatedTaskReferenceGlobalCounts()
      : Promise.resolve(undefined),
  ]);

  return {
    tasks,
    planVersions,
    planVersionNodes,
    taskNodes,
    taskMembers,
    taskTags,
    auditEvents,
    inAppNotifications,
    notificationOutboxes,
    globalCounts,
  };
}

async function relatedTaskReferenceGlobalCounts() {
  const [
    tasks,
    planVersions,
    planVersionNodes,
    taskNodes,
    milestoneNodes,
    revisionNodes,
    terminationNodes,
    taskMembers,
    taskTags,
    auditEvents,
    inAppNotifications,
    notificationOutboxes,
    notificationOutboxRecipients,
  ] = await Promise.all([
    prisma.task.count(),
    prisma.taskPlanVersion.count(),
    prisma.planVersionNode.count(),
    prisma.taskNode.count(),
    prisma.milestoneNode.count(),
    prisma.revisionNode.count(),
    prisma.terminationNode.count(),
    prisma.taskMember.count(),
    prisma.taskTag.count(),
    prisma.domainAuditEvent.count(),
    prisma.inAppNotification.count(),
    prisma.notificationOutbox.count(),
    prisma.notificationOutboxRecipient.count(),
  ]);
  return {
    tasks,
    planVersions,
    planVersionNodes,
    taskNodes,
    milestoneNodes,
    revisionNodes,
    terminationNodes,
    taskMembers,
    taskTags,
    auditEvents,
    inAppNotifications,
    notificationOutboxes,
    notificationOutboxRecipients,
  };
}

type MutationSideEffectSnapshot = Awaited<
  ReturnType<typeof mutationSideEffectCounts>
>;

function expectMutationBusinessEffect(
  name: MutationActionName,
  before: MutationSideEffectSnapshot,
  after: MutationSideEffectSnapshot,
) {
  if (name === "updateTaskDraftMetadata" || name === "updateTaskMetadata") {
    expect(after.taskMetadata).not.toEqual(before.taskMetadata);
    return;
  }
  if (name === "replaceTaskDraftMembers" || name === "replaceTaskMembers") {
    expect(after.memberRows).not.toEqual(before.memberRows);
    return;
  }
  if (name === "replaceTaskDraftPlan") {
    expect(after.nodeContent).not.toEqual(before.nodeContent);
    return;
  }
  expect(after.taskTagIds).not.toEqual(before.taskTagIds);
}

async function segmentAssociationSideEffectSnapshot(segmentIds: string[]) {
  return {
    segmentCount: await prisma.workSegment.count(),
    changeCount: await prisma.workSegmentChange.count(),
    sourceCount: await prisma.workSegmentSource.count(),
    auditCount: await prisma.domainAuditEvent.count(),
    notificationCount: await prisma.inAppNotification.count(),
    outboxCount: await prisma.notificationOutbox.count(),
    segments: await prisma.workSegment.findMany({
      where: { id: { in: segmentIds } },
      orderBy: { id: "asc" },
    }),
    changes: await prisma.workSegmentChange.findMany({
      where: { segmentId: { in: segmentIds } },
      orderBy: { id: "asc" },
    }),
  };
}

function segmentCreateInput(personId: string, content: string, hour = 1) {
  return {
    personId,
    startAt: new Date(Date.UTC(2026, 7, 20, hour, 0, 0)),
    endAt: new Date(Date.UTC(2026, 7, 20, hour + 1, 0, 0)),
    content,
    role: "DEVELOPER" as const,
    priority: "MEDIUM" as const,
    tagIds: [],
  };
}

async function expectServiceError(
  promise: Promise<unknown>,
  expectedCode: ReturnType<typeof toProjectManagementServiceError>["code"],
  options?: { expectedCurrentLockVersion?: number },
) {
  try {
    await promise;
  } catch (error) {
    const mapped = toProjectManagementServiceError(error);
    expect(mapped.code).toBe(expectedCode);
    if (options?.expectedCurrentLockVersion !== undefined) {
      expect(mapped.current).toMatchObject({
        kind: "TASK",
        lockVersion: options.expectedCurrentLockVersion,
      });
    }
    return mapped;
  }
  throw new Error(`测试期望 ${expectedCode}，但操作成功`);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("测试期望 JSON object");
}

async function approveCurrentMilestone(
  taskId: string,
  owner: AccountPerson,
  reviewer: AccountPerson,
  suffix: string,
) {
  const current = await currentPlan(taskId);
  const milestone = current.nodes.find(
    (entry) => entry.node.type === "MILESTONE" && entry.node.status === "ACTIVE",
  );
  if (!milestone) throw new Error("缺少 Active Milestone");
  const review = await submitMilestoneForReview(actor(owner), {
    milestoneNodeId: milestone.nodeId,
    idempotencyKey: `s2-${suffix}-${randomUUID()}`,
    evidences: [{ kind: "TEXT", note: `完成 ${suffix}` }],
  });
  await reviewMilestone(actor(reviewer), {
    reviewId: review.reviewId,
    result: "APPROVED",
    comment: `通过 ${suffix}`,
  });
}

function serviceOutcomeCodes(outcomes: PromiseSettledResult<unknown>[]) {
  return outcomes
    .map((outcome) =>
      outcome.status === "fulfilled"
        ? "OK"
        : toProjectManagementServiceError(outcome.reason).code,
    )
    .sort();
}

async function installControlledAuditFailureTrigger() {
  await removeControlledAuditFailureTrigger();
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "test_s2_controlled_audit_failure"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 's2 controlled late audit failure';
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "test_s2_controlled_audit_failure"
    BEFORE INSERT ON "DomainAuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "test_s2_controlled_audit_failure"()
  `);
}

async function removeControlledAuditFailureTrigger() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS "test_s2_controlled_audit_failure"
    ON "DomainAuditEvent"
  `);
  await prisma.$executeRawUnsafe(`
    DROP FUNCTION IF EXISTS "test_s2_controlled_audit_failure"()
  `);
}

async function installControlledMemberOutboxFailureTrigger() {
  await removeControlledMemberOutboxFailureTrigger();
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "test_s2_controlled_member_outbox_failure"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW."eventKey" LIKE 'pm:task:member_changed:%' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM "InAppNotification"
          WHERE "eventKey" LIKE
            replace(NEW."eventKey", ':feishu', '') || ':inapp:%'
        ) THEN
          RAISE EXCEPTION 's2 inapp was not written before outbox';
        END IF;
        RAISE EXCEPTION 's2 controlled outbox failure after inapp';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "test_s2_controlled_member_outbox_failure"
    BEFORE INSERT ON "NotificationOutbox"
    FOR EACH ROW
    EXECUTE FUNCTION "test_s2_controlled_member_outbox_failure"()
  `);
}

async function removeControlledMemberOutboxFailureTrigger() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS "test_s2_controlled_member_outbox_failure"
    ON "NotificationOutbox"
  `);
  await prisma.$executeRawUnsafe(`
    DROP FUNCTION IF EXISTS "test_s2_controlled_member_outbox_failure"()
  `);
}

async function runBehindTaskLockBarrier(
  taskId: string,
  operations: [() => Promise<unknown>, () => Promise<unknown>],
) {
  return runTaskLockBarrier(taskId, operations, false);
}

async function runCancellationBeforeRevisionBehindSegmentLock(
  segmentId: string,
  cancelOperation: () => Promise<unknown>,
  revisionOperation: () => Promise<unknown>,
) {
  let locker: Client | undefined;
  let observer: Client | undefined;
  let transactionMayBeOpen = false;
  let released = false;
  const pending: Promise<unknown>[] = [];
  let pendingSettlement: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let pendingBackendPids: number[] = [];
  let pendingHandled = false;
  let result: PromiseSettledResult<unknown>[] | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    locker = await connectDatabaseClient("s2-revision-segment-locker");
    observer = await connectDatabaseClient("s2-revision-segment-observer");
    transactionMayBeOpen = true;
    const lockerPid = await lockWorkSegmentRow(locker, segmentId);

    const cancellation = startBarrierOperations([cancelOperation]).pending[0];
    if (!cancellation) throw new Error("Segment 取消操作未启动");
    pending.push(cancellation);
    pendingSettlement = Promise.allSettled(pending);
    await waitForTaskLockBlockers(observer, lockerPid, 1);

    const revision = startBarrierOperations([revisionOperation]).pending[0];
    if (!revision) throw new Error("Revision 生效操作未启动");
    pending.push(revision);
    pendingSettlement = Promise.allSettled(pending);
    pendingBackendPids = await waitForTaskLockBlockers(observer, lockerPid, 2);
    if (new Set(pendingBackendPids).size < 2) {
      throw new Error("取消与 Revision 未使用独立 PostgreSQL backend");
    }

    await locker.query("COMMIT");
    released = true;
    result = await pendingSettlement;
    pendingHandled = true;
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }
  const cleanupErrors = await cleanupBarrierResources({
    locker,
    observer,
    rollbackRequired: Boolean(locker && transactionMayBeOpen && !released),
    pendingSettlement,
    pendingBackendPids,
    pendingHandled,
    primaryError,
  });
  throwBarrierErrors(hasPrimaryError, primaryError, cleanupErrors);
  if (!result) throw new Error("取消与 Revision barrier 未返回结果");
  return result;
}

async function runTaskAssociationLockChain(
  taskId: string,
  firstOperation: () => Promise<unknown>,
  secondOperation: () => Promise<unknown>,
) {
  return runTaskLockBarrier(
    taskId,
    [firstOperation, secondOperation],
    true,
  );
}

async function runTaskLockBarrier(
  taskId: string,
  operations: [() => Promise<unknown>, () => Promise<unknown>],
  ordered: boolean,
) {
  let locker: Client | undefined;
  let observer: Client | undefined;
  let transactionMayBeOpen = false;
  let released = false;
  let pending: Promise<unknown>[] = [];
  let pendingSettlement: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let pendingBackendPids: number[] = [];
  let pendingHandled = false;
  let result: PromiseSettledResult<unknown>[] | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    locker = await connectDatabaseClient("s2-task-locker");
    observer = await connectDatabaseClient("s2-task-observer");
    transactionMayBeOpen = true;
    const lockerPid = await lockTaskRow(locker, taskId);
    if (ordered) {
      const first = startBarrierOperations([operations[0]]).pending[0];
      if (!first) throw new Error("首个 Task lock operation 未启动");
      pending.push(first);
      await waitForTaskLockBlockers(observer, lockerPid, 1);
      const second = startBarrierOperations([operations[1]]).pending[0];
      if (!second) throw new Error("第二个 Task lock operation 未启动");
      pending.push(second);
    } else {
      pending = startBarrierOperations(operations).pending;
    }
    pendingSettlement = Promise.allSettled(pending);
    pendingBackendPids = await waitForTaskLockBlockers(observer, lockerPid, 2);
    if (new Set(pendingBackendPids).size < 2) {
      throw new Error("两个 Task mutation 未使用独立 PostgreSQL backend");
    }
    await locker.query("COMMIT");
    released = true;
    result = await pendingSettlement;
    pendingHandled = true;
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }
  const cleanupErrors = await cleanupBarrierResources({
    locker,
    observer,
    rollbackRequired: Boolean(locker && transactionMayBeOpen && !released),
    pendingSettlement,
    pendingBackendPids,
    pendingHandled,
    primaryError,
  });
  throwBarrierErrors(hasPrimaryError, primaryError, cleanupErrors);
  if (!result) throw new Error("Task lock barrier 未返回结果");
  return result;
}

async function lockTaskRow(client: Client, taskId: string) {
  await client.query("BEGIN");
  const identity = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = identity.rows[0]?.pid;
  if (!pid) throw new Error("无法取得 Task locker backend pid");
  await client.query('SELECT "id" FROM "Task" WHERE "id" = $1 FOR UPDATE', [
    taskId,
  ]);
  return pid;
}

async function lockWorkSegmentRow(client: Client, segmentId: string) {
  await client.query("BEGIN");
  const identity = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = identity.rows[0]?.pid;
  if (!pid) throw new Error("无法取得 WorkSegment locker backend pid");
  await client.query(
    'SELECT "id" FROM "WorkSegment" WHERE "id" = $1 FOR UPDATE',
    [segmentId],
  );
  return pid;
}

async function waitForTaskLockBlockers(
  observer: Client,
  blockerPid: number,
  expectedCount: number,
) {
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    const result = await observer.query<{ pid: number }>(
      `WITH RECURSIVE "blocked"("pid") AS (
         SELECT "activity"."pid"
         FROM "pg_stat_activity" AS "activity"
         WHERE $1::int = ANY(pg_blocking_pids("activity"."pid"))
         UNION
         SELECT "activity"."pid"
         FROM "pg_stat_activity" AS "activity"
         JOIN "blocked" AS "blocker"
           ON "blocker"."pid" = ANY(pg_blocking_pids("activity"."pid"))
       )
       SELECT "pid" FROM "blocked" ORDER BY "pid" ASC`,
      [blockerPid],
    );
    const pids = [...new Set(result.rows.map((row) => row.pid))];
    if (pids.length >= expectedCount) return pids;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`未观察到 ${expectedCount} 个 Task lock waiter`);
}
