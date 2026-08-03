import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  approveRevision,
  cancelRevision,
  confirmTermination,
  createRevisionDraft,
  createTaskDraft,
  rejectRevision,
  reviewMilestone,
  submitMilestoneForReview,
  submitRevision,
  updateRevisionDraft,
} from "../lib/project-management/application/lifecycle-service";
import {
  toProjectManagementServiceError,
} from "../lib/project-management/application/errors";
import {
  comparePlanVersions,
  getPlanVersion,
  getTaskWorkspace,
  listTaskPlanVersions,
} from "../lib/project-management/queries/task-queries";
import { getActorPersonOption } from "../lib/project-management/queries/option-queries";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import { updateNotificationPreference } from "../lib/project-management/application/notification-preference-service";
import { getTaskLifecycleViews } from "../lib/project-management/queries/task-lifecycle-queries";
import {
  milestoneDraftSchema,
  submitMilestoneReviewInputSchema,
  terminationDraftSchema,
  taskWorkspaceQueryInputSchema,
} from "../lib/project-management/validations/lifecycle";
import { withGlobalApprovalAdministratorGuardDisabled } from "./helpers/global-approval-administrator-guard";

test.describe("project management P2/P3 task lifecycle services", () => {
  test("Lifecycle validation returns Chinese messages for UUID and disabled file evidence errors", async () => {
    const missingUuid = taskWorkspaceQueryInputSchema.safeParse({});
    expect(missingUuid.success).toBe(false);
    if (!missingUuid.success) {
      expect(issueMessages(missingUuid.error.issues)).toContain(
        "对象 ID 格式不正确",
      );
    }

    const invalidUuidType = taskWorkspaceQueryInputSchema.safeParse({
      taskId: 123,
    });
    expect(invalidUuidType.success).toBe(false);
    if (!invalidUuidType.success) {
      expect(issueMessages(invalidUuidType.error.issues).join(" ")).not.toContain(
        "Invalid input",
      );
      expect(issueMessages(invalidUuidType.error.issues)).toContain(
        "对象 ID 格式不正确",
      );
    }

    const fileEvidence = submitMilestoneReviewInputSchema.safeParse({
      milestoneNodeId: randomUUID(),
      idempotencyKey: `review-file-schema-${randomUUID()}`,
      evidences: [{ kind: "FILE" }],
    });
    expect(fileEvidence.success).toBe(false);
    if (!fileEvidence.success) {
      expect(issueMessages(fileEvidence.error.issues).join(" ")).toContain(
        "文件证据暂未启用",
      );
    }

    const nullMilestoneDate = milestoneDraftSchema.safeParse({
      goal: "日期校验",
      completionCriteria: "不能用 null",
      expectedCompletedAt: null,
      reviewRequirements: "提交证据",
    });
    expect(nullMilestoneDate.success).toBe(false);
    if (!nullMilestoneDate.success) {
      expect(issueMessages(nullMilestoneDate.error.issues)).toContain(
        "请选择有效的预期完成时间",
      );
    }
    for (const invalidDate of ["123", "0", "2026-02-31"]) {
      const invalidMilestoneDate = milestoneDraftSchema.safeParse({
        goal: "日期校验",
        completionCriteria: "不能宽松解析",
        expectedCompletedAt: invalidDate,
        reviewRequirements: "提交证据",
      });
      expect(invalidMilestoneDate.success).toBe(false);
      if (!invalidMilestoneDate.success) {
        expect(issueMessages(invalidMilestoneDate.error.issues)).toContain(
          "请选择有效的预期完成时间",
        );
      }
    }
    const isoMilestoneDate = milestoneDraftSchema.safeParse({
      goal: "日期校验",
      completionCriteria: "接受严格 ISO",
      expectedCompletedAt: "2026-08-01T10:00:00.000Z",
      reviewRequirements: "提交证据",
    });
    expect(isoMilestoneDate.success).toBe(true);

    const nullTerminationDate = terminationDraftSchema.safeParse({
      plannedOutcomeCriteria: "结束条件",
      plannedAt: null,
    });
    expect(nullTerminationDate.success).toBe(false);
    if (!nullTerminationDate.success) {
      expect(issueMessages(nullTerminationDate.error.issues)).toContain(
        "请选择有效的计划结束时间",
      );
    }
  });

  test("Task draft creation is open to unified accounts, idempotent and globally readable", async () => {
    const admin = await createAccountPerson("生命周期 Team Admin");
    const owner = await createAccountPerson("生命周期 Owner");
    const member = await createAccountPerson("生命周期 Member");
    const reviewer = await createAccountPerson("生命周期 Reviewer");
    const outsider = await createAccountPerson("生命周期 Outsider");
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
    const tag = await prisma.tag.create({
      data: {
        name: `生命周期标签-${randomUUID()}`,
        color: "#2563eb",
        createdByAccountId: admin.account.id,
      },
    });
    const related = await createTaskDraft(
      actor(admin),
      taskDraftInput({
        ownerPersonId: owner.person.id,
        memberPersonId: member.person.id,
        reviewerPersonId: reviewer.person.id,
        idempotencyKey: `related-task-${randomUUID()}`,
      }),
    );
    const draftInput = {
      ...taskDraftInput({
        ownerPersonId: owner.person.id,
        memberPersonId: member.person.id,
        reviewerPersonId: reviewer.person.id,
        tagIds: [tag.id],
        idempotencyKey: `task-draft-${randomUUID()}`,
      }),
      relatedTaskId: related.taskId,
    };

    const legacyIdempotencyKey = `task-draft-legacy-page-${randomUUID()}`;
    const legacyPageError = await captureServiceError(
      createTaskDraft(actor(admin), {
        ...draftInput,
        idempotencyKey: legacyIdempotencyKey,
        revisionApprovalMode: "REVIEW_REQUIRED",
        allowSelfReview: false,
      }),
    );
    expect(legacyPageError).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "页面版本已过期，请刷新页面后重试；本地草稿会继续保留",
    });
    expect(
      await prisma.taskPlanVersion.count({
        where: { idempotencyKey: legacyIdempotencyKey },
      }),
    ).toBe(0);

    const outsiderCreated = await createTaskDraft(actor(outsider), {
      ...draftInput,
      idempotencyKey: `task-draft-outsider-${randomUUID()}`,
    });
    expect(outsiderCreated.status).toBe("DRAFT");
    await expect(
      prisma.taskMember.findFirstOrThrow({
        where: {
          taskId: outsiderCreated.taskId,
          personId: outsider.person.id,
          removedAt: null,
        },
        select: { role: true },
      }),
    ).resolves.toEqual({ role: "OWNER" });

    const created = await createTaskDraft(actor(admin), draftInput);
    expect(created).toMatchObject({ created: true, status: "DRAFT" });

    const repeated = await createTaskDraft(actor(admin), draftInput);
    expect(repeated).toMatchObject({
      created: false,
      taskId: created.taskId,
      currentPlanVersionId: created.currentPlanVersionId,
    });
    await expectServiceError(
      createTaskDraft(actor(admin), {
        ...draftInput,
        title: "同 key 不同内容",
      }),
      "STATE_CONFLICT",
    );
    const concurrentDraftInput = taskDraftInput({
      ownerPersonId: owner.person.id,
      memberPersonId: member.person.id,
      reviewerPersonId: reviewer.person.id,
      tagIds: [tag.id],
      idempotencyKey: `task-draft-race-${randomUUID()}`,
    });
    const concurrentCreates = await Promise.all([
      createTaskDraft(actor(admin), concurrentDraftInput),
      createTaskDraft(actor(admin), concurrentDraftInput),
    ]);
    expect(new Set(concurrentCreates.map((entry) => entry.taskId)).size).toBe(1);
    expect(concurrentCreates.filter((entry) => entry.created)).toHaveLength(1);

    const planNodes = await prisma.planVersionNode.findMany({
      where: { planVersionId: created.currentPlanVersionId },
      include: { node: true },
      orderBy: { sequence: "asc" },
    });
    expect(planNodes.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(planNodes.map((entry) => entry.node.type)).toEqual([
      "MILESTONE",
      "MILESTONE",
      "TERMINATION",
    ]);
    expect(planNodes.map((entry) => entry.node.status)).toEqual([
      "PENDING",
      "PENDING",
      "PENDING",
    ]);
    await expect(
      prisma.$executeRaw`
        UPDATE "TaskPlanVersion"
        SET "idempotencyKey" = '   '
        WHERE "id" = ${created.currentPlanVersionId}
      `,
    ).rejects.toThrow();

    const assignedPayload = await expectProjectManagementOutbox(
      `pm:task:assigned:${created.taskId}:v1:feishu`,
      {
        type: "task_assigned",
        botKind: "notification",
        purpose: "notification",
      },
    );
    expect(assignedPayload.payloadVersion).toBe(1);
    expect(assignedPayload.recipientOpenIds).toEqual(
      expect.arrayContaining([owner.openId, member.openId, reviewer.openId]),
    );
    const inAppNotification =
      await prisma.inAppNotification.findFirstOrThrow({
        where: {
          eventKey: {
            startsWith: `pm:task:assigned:${created.taskId}:v1:inapp:`,
          },
        },
        select: { payload: true },
      });
    expect(jsonRecord(inAppNotification.payload).recipientOpenIds).toEqual([]);
    expect(
      await prisma.domainAuditEvent.count({
        where: { taskId: created.taskId, action: "pm.task.create" },
      }),
    ).toBe(1);

    const workspace = await getTaskWorkspace({
      actor: actor(owner),
      taskId: created.taskId,
    });
    expect(workspace.task.title).toBe(draftInput.title);
    expect(workspace.task.relatedTaskId).toBe(related.taskId);
    expect(workspace.currentPlan.plannedStartAt).toBe(draftInput.plannedStartAt);
    expect(workspace.currentPlan.nodes).toHaveLength(3);
    const planSummary = await getPlanVersion({
      actor: actor(owner),
      planVersionId: created.currentPlanVersionId,
    });
    expect(planSummary.plannedStartAt).toBe(draftInput.plannedStartAt);
    const planHistory = await listTaskPlanVersions({
      actor: actor(owner),
      taskId: created.taskId,
    });
    expect(planHistory[0]?.plannedStartAt).toBe(draftInput.plannedStartAt);

    await prisma.taskPlanVersion.update({
      where: { id: created.currentPlanVersionId },
      data: { plannedStartAt: null },
    });
    expect(
      (
        await getTaskWorkspace({
          actor: actor(owner),
          taskId: created.taskId,
        })
      ).currentPlan.plannedStartAt,
    ).toBeNull();
    expect(
      (
        await getPlanVersion({
          actor: actor(owner),
          planVersionId: created.currentPlanVersionId,
        })
      ).plannedStartAt,
    ).toBeNull();
    expect(
      (
        await listTaskPlanVersions({
          actor: actor(owner),
          taskId: created.taskId,
        })
      )[0]?.plannedStartAt,
    ).toBeNull();
    expect(
      (
        await getTaskWorkspace({
          actor: actor(outsider),
          taskId: created.taskId,
        })
      ).task.id,
    ).toBe(created.taskId);
  });

  test("an inactive Person account remains readable and can become Owner only as the Task creator", async () => {
    const inactiveCreator = await createAccountPerson(
      "生命周期停用人员创建者",
    );
    await prisma.person.update({
      where: { id: inactiveCreator.person.id },
      data: { status: "INACTIVE" },
    });
    await expect(getActorPersonOption(actor(inactiveCreator))).resolves.toMatchObject({
      id: inactiveCreator.person.id,
      status: "INACTIVE",
      accountBinding: "BOUND",
    });

    const input = {
      ...taskDraftInput({
        ownerPersonId: inactiveCreator.person.id,
        memberPersonId: inactiveCreator.person.id,
        reviewerPersonId: inactiveCreator.person.id,
        idempotencyKey: `inactive-creator-${randomUUID()}`,
      }),
      members: [
        { personId: inactiveCreator.person.id, role: "OWNER" as const },
      ],
    };
    const created = await createTaskDraft(actor(inactiveCreator), input);
    await expect(
      prisma.taskMember.findFirstOrThrow({
        where: {
          taskId: created.taskId,
          personId: inactiveCreator.person.id,
          removedAt: null,
        },
        select: { role: true },
      }),
    ).resolves.toEqual({ role: "OWNER" });
    await expect(
      getTaskWorkspace({
        actor: actor(inactiveCreator),
        taskId: created.taskId,
      }),
    ).resolves.toMatchObject({ task: { id: created.taskId } });

    const activeCreator = await createAccountPerson("生命周期活跃创建者");
    const rejected = await captureServiceError(
      createTaskDraft(actor(activeCreator), {
        ...input,
        idempotencyKey: `inactive-non-creator-${randomUUID()}`,
        members: [
          { personId: activeCreator.person.id, role: "OWNER" },
          { personId: inactiveCreator.person.id, role: "PARTICIPANT" },
        ],
      }),
    );
    expect(rejected).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "成员不存在或已停用",
    });
  });

  test("Task activation sets the first active milestone and rejects stale or concurrent activation", async () => {
    const fixture = await createDraftFixture();
    const draftPlan = await prisma.taskPlanVersion.findUniqueOrThrow({
      where: { id: fixture.currentPlanVersionId },
      select: { snapshotHash: true },
    });
    expect(draftPlan.snapshotHash).not.toBe("");

    const activated = await activateTask(actor(fixture.owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 0,
    });
    expect(activated).toMatchObject({
      status: "ACTIVE",
      lockVersion: 1,
    });
    expect(activated.activeMilestoneNodeId).toBeTruthy();
    const nodes = await currentPlanNodes(fixture.taskId);
    expect(nodes[0]?.node.status).toBe("ACTIVE");
    expect(nodes[1]?.node.status).toBe("PENDING");
    const activatedPlan = await prisma.taskPlanVersion.findUniqueOrThrow({
      where: { id: fixture.currentPlanVersionId },
      select: { snapshotHash: true },
    });
    expect(activatedPlan.snapshotHash).toBe(draftPlan.snapshotHash);
    expect(
      await prisma.domainAuditEvent.count({
        where: { taskId: fixture.taskId, action: "pm.task.activate" },
      }),
    ).toBe(1);

    await expectServiceError(
      activateTask(actor(fixture.owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
      }),
      "STATE_CONFLICT",
    );

    const concurrent = await createDraftFixture();
    const attempts = await Promise.allSettled([
      activateTask(actor(concurrent.owner), {
        taskId: concurrent.taskId,
        expectedLockVersion: 0,
      }),
      activateTask(actor(concurrent.owner), {
        taskId: concurrent.taskId,
        expectedLockVersion: 0,
      }),
    ]);
    expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((entry) => entry.status === "rejected")).toHaveLength(1);
  });

  test("Task activation honors ordinary Feishu preference while retaining in-app notification", async () => {
    const fixture = await createDraftFixture();
    await updateNotificationPreference(actor(fixture.owner), {
      category: "TASK",
      feishuEnabled: false,
    });

    const activated = await activateTask(actor(fixture.owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 0,
    });
    const eventKey = `pm:task:activated:${fixture.taskId}:${activated.lockVersion}`;
    const inApp = await prisma.inAppNotification.findUniqueOrThrow({
      where: { eventKey: `${eventKey}:inapp:${fixture.owner.account.id}` },
    });
    expect(jsonRecord(inApp.payload)).toMatchObject({
      context: { taskStatus: "ACTIVE" },
    });
    const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey: `${eventKey}:feishu` },
    });
    const payload = jsonRecord(JSON.parse(outbox.payload));
    expect(payload).toMatchObject({
      context: { taskStatus: "ACTIVE" },
      recipientOpenIds: expect.arrayContaining([
        fixture.member.openId,
        fixture.reviewer.openId,
      ]),
    });
    expect(payload.recipientOpenIds).not.toContain(fixture.owner.openId);
  });

  test("Milestone Review supports text and link evidence, blocks file evidence, and advances only on approval", async () => {
    const fixture = await createActivatedFixture();
    const activeNode = await firstCurrentMilestone(fixture.taskId);

    const fileEvidenceError = await captureServiceError(
      submitMilestoneForReview(actor(fixture.member), {
        milestoneNodeId: activeNode.nodeId,
        idempotencyKey: `review-file-${randomUUID()}`,
        evidences: [{ kind: "FILE", fileAssetId: randomUUID() }],
      }),
    );
    expect(fileEvidenceError.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(fileEvidenceError.fieldErrors)).toContain(
      "文件证据暂未启用",
    );
    const missingFileAssetError = await captureServiceError(
      submitMilestoneForReview(actor(fixture.member), {
        milestoneNodeId: activeNode.nodeId,
        idempotencyKey: `review-file-missing-${randomUUID()}`,
        evidences: [{ kind: "FILE" }],
      }),
    );
    expect(missingFileAssetError.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(missingFileAssetError.fieldErrors)).toContain(
      "文件证据暂未启用",
    );

    const reviewIdempotencyKey = `review-${randomUUID()}`;
    const submitted = await submitMilestoneForReview(actor(fixture.member), {
      milestoneNodeId: activeNode.nodeId,
      idempotencyKey: reviewIdempotencyKey,
      evidences: [
        { kind: "TEXT", note: "已完成联调" },
        { kind: "LINK", externalUrl: "https://example.com/evidence" },
      ],
    });
    expect(submitted).toMatchObject({
      created: true,
      result: "PENDING",
      milestoneNodeId: activeNode.nodeId,
    });
    const duplicatePending = await submitMilestoneForReview(
      actor(fixture.member),
      {
        milestoneNodeId: activeNode.nodeId,
        idempotencyKey: `review-duplicate-${randomUUID()}`,
        evidences: [{ kind: "TEXT", note: "重复提交待处理验收" }],
      },
    );
    expect(duplicatePending).toMatchObject({
      created: false,
      reviewId: submitted.reviewId,
    });
    const reviewSubmittedPayload = await expectProjectManagementOutbox(
      `pm:milestone:review_submitted:${submitted.reviewId}:feishu`,
      {
        type: "milestone_review_submitted",
        botKind: "approval",
        purpose: "approval_request",
      },
    );
    expect(reviewSubmittedPayload.payloadVersion).toBe(1);
    expect(reviewSubmittedPayload.recipientOpenIds).toEqual(
      expect.arrayContaining([fixture.reviewer.openId, fixture.admin.openId]),
    );
    expect(
      await prisma.domainAuditEvent.count({
        where: { taskId: fixture.taskId, action: "pm.milestone.review.submit" },
      }),
    ).toBe(1);
    const repeated = await submitMilestoneForReview(actor(fixture.member), {
      milestoneNodeId: activeNode.nodeId,
      idempotencyKey: reviewIdempotencyKey,
      evidences: [{ kind: "TEXT", note: "重复点击" }],
    });
    expect(repeated).toMatchObject({
      created: false,
      reviewId: submitted.reviewId,
    });

    await expectServiceError(
      reviewMilestone(actor(fixture.member), {
        reviewId: submitted.reviewId,
        result: "APPROVED",
      }),
      "FORBIDDEN",
    );

    const approved = await reviewMilestone(actor(fixture.reviewer), {
      reviewId: submitted.reviewId,
      result: "APPROVED",
      comment: "通过",
    });
    expect(approved.result).toBe("APPROVED");
    expect(approved.activeMilestoneNodeId).not.toBe(activeNode.nodeId);
    const advancedNodes = await currentPlanNodes(fixture.taskId);
    expect(advancedNodes[0]?.node.status).toBe("COMPLETED");
    expect(advancedNodes[1]?.node.status).toBe("ACTIVE");
    await expectProjectManagementOutbox(
      `pm:milestone:review_result:${submitted.reviewId}:APPROVED:feishu`,
      {
        type: "milestone_review_result",
        botKind: "notification",
        purpose: "notification",
      },
    );

    const secondReview = await submitMilestoneForReview(actor(fixture.member), {
      milestoneNodeId: advancedNodes[1]?.nodeId,
      idempotencyKey: `review-reject-${randomUUID()}`,
      evidences: [{ kind: "TEXT", note: "第二阶段证据" }],
    });
    const rejected = await reviewMilestone(actor(fixture.reviewer), {
      reviewId: secondReview.reviewId,
      result: "REJECTED",
      comment: "还需要补充数据",
    });
    expect(rejected.activeMilestoneNodeId).toBe(advancedNodes[1]?.nodeId);
    expect((await currentPlanNodes(fixture.taskId))[1]?.node.status).toBe("ACTIVE");
  });

  test("Milestone Review concurrent decisions only persist one result", async () => {
    const fixture = await createActivatedFixture();
    const activeNode = await firstCurrentMilestone(fixture.taskId);
    const submitted = await submitMilestoneForReview(actor(fixture.member), {
      milestoneNodeId: activeNode.nodeId,
      idempotencyKey: `review-race-${randomUUID()}`,
      evidences: [{ kind: "TEXT", note: "并发验收证据" }],
    });

    const decisions = await Promise.allSettled([
      reviewMilestone(actor(fixture.reviewer), {
        reviewId: submitted.reviewId,
        result: "APPROVED",
        comment: "通过",
      }),
      reviewMilestone(actor(fixture.admin), {
        reviewId: submitted.reviewId,
        result: "REJECTED",
        comment: "不同意",
      }),
    ]);
    const fulfilled = decisions.filter(
      (entry): entry is PromiseFulfilledResult<
        Awaited<ReturnType<typeof reviewMilestone>>
      > => entry.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(1);
    expect(decisions.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const persistedReview = await prisma.milestoneReview.findUniqueOrThrow({
      where: { id: submitted.reviewId },
      select: { result: true },
    });
    expect(persistedReview.result).toBe(fulfilled[0]?.value.result);
  });

  test("Revision draft, submit, reject and cancel preserve the current plan", async () => {
    const fixture = await createActivatedFixture();
    const activeNode = await firstCurrentMilestone(fixture.taskId);
    const revision = await createRevisionDraft(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      revisedFromNodeId: activeNode.nodeId,
      reason: "计划需要调整",
      replacementMilestones: [
        milestoneInput("调整后 Milestone", "完成新目标", 4),
      ],
      plannedStartAt: new Date(
        Date.UTC(2026, 6, 31, 10, 0, 0),
      ).toISOString(),
      termination: terminationInput(8),
      idempotencyKey: `revision-reject-${randomUUID()}`,
    });
    expect(revision).toMatchObject({ created: true, status: "DRAFT" });
    await expect(
      prisma.$executeRaw`
        UPDATE "RevisionNode"
        SET "baseTaskLockVersion" = -1
        WHERE "id" = ${revision.revisionNodeId}
      `,
    ).rejects.toThrow();

    const submitted = await submitRevision(actor(fixture.owner), {
      revisionNodeId: revision.revisionNodeId,
      comment: "请审批",
    });
    expect(submitted.status).toBe("PENDING_APPROVAL");

    await expectServiceError(
      rejectRevision(actor(fixture.owner), {
        revisionNodeId: revision.revisionNodeId,
        comment: "自己不能审自己的修订",
      }),
      "FORBIDDEN",
    );
    const rejected = await rejectRevision(actor(fixture.reviewer), {
      revisionNodeId: revision.revisionNodeId,
      comment: "拆分不够清楚",
    });
    expect(rejected.status).toBe("REJECTED");
    const targetAfterReject = await prisma.taskPlanVersion.findUniqueOrThrow({
      where: { id: revision.targetPlanVersionId ?? "" },
      select: { status: true },
    });
    expect(targetAfterReject.status).toBe("DRAFT");

    const cancelled = await cancelRevision(actor(fixture.owner), {
      revisionNodeId: revision.revisionNodeId,
      comment: "重新整理后再提交",
    });
    expect(cancelled.status).toBe("CANCELLED");
    const targetAfterCancel = await prisma.taskPlanVersion.findUniqueOrThrow({
      where: { id: revision.targetPlanVersionId ?? "" },
      select: { status: true },
    });
    expect(targetAfterCancel.status).toBe("ABANDONED");
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: fixture.taskId },
      select: { currentPlanVersionId: true, activeMilestoneNodeId: true },
    });
    expect(task.currentPlanVersionId).toBe(fixture.currentPlanVersionId);
    expect(task.activeMilestoneNodeId).toBe(activeNode.nodeId);
  });

  test("Revision Draft replace enforces ownership, stale and association safety with auditable atomic updates", async () => {
    const fixture = await createActivatedFixture();
    const lead = await createAccountPerson("生命周期 Revision Lead");
    await prisma.taskMember.create({
      data: {
        taskId: fixture.taskId,
        personId: lead.person.id,
        role: "PARTICIPANT",
        createdByAccountId: fixture.owner.account.id,
      },
    });
    const activeNode = await firstCurrentMilestone(fixture.taskId);
    const revision = await createRevisionDraft(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      revisedFromNodeId: activeNode.nodeId,
      reason: "Revision Draft replace 初始计划",
      replacementMilestones: [milestoneInput("候选节点 A", "候选条件 A", 4)],
      plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
      termination: terminationInput(8),
      idempotencyKey: `revision-update-${randomUUID()}`,
    });
    const targetPlanVersionId = revision.targetPlanVersionId ?? "";
    const targetBefore = await revisionTargetSnapshot(targetPlanVersionId);
    const replacementNode = targetBefore.nodes.find(
      (entry) => entry.node.type === "MILESTONE" && !entry.isCarryForward,
    );
    if (!replacementNode) throw new Error("测试候选计划缺少可替换 Milestone");
    const validUpdate = {
      revisionNodeId: revision.revisionNodeId,
      expectedTargetPlanUpdatedAt: targetBefore.updatedAt.toISOString(),
      reason: "Revision Draft replace 已编辑",
      plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
      replacementMilestones: [
        {
          ...milestoneInput("候选节点 B", "候选条件 B", 5),
          businessDescription: "候选节点 B 的业务说明",
        },
        {
          ...milestoneInput("候选节点 C", "候选条件 C", 6),
          businessDescription: "候选节点 C 的业务说明",
        },
      ],
      termination: {
        ...terminationInput(9),
        businessDescription: "候选结束业务说明",
      },
    };

    await prisma.domainAuditEvent.createMany({
      data: [
        {
          taskId: fixture.taskId,
          action: "pm.test.system_historical",
          entityType: "Task",
          entityId: fixture.taskId,
          source: "CRON",
          createdAt: new Date("2020-01-01T00:00:00.000Z"),
        },
        {
          taskId: fixture.taskId,
          actorAccountId: lead.account.id,
          actorPersonId: lead.person.id,
          action: "pm.test.lead_historical",
          entityType: "Task",
          entityId: fixture.taskId,
          createdAt: new Date("2020-01-02T00:00:00.000Z"),
        },
      ],
    });

    const leadView = await getTaskLifecycleViews({
      actor: actor(lead),
      taskId: fixture.taskId,
      auditLimit: 1,
    });
    expect(leadView.revisions[0]?.capabilities).toMatchObject({
      canEdit: false,
      canSubmit: false,
    });
    expect(leadView.auditFilterOptions.eventTypes).toEqual(
      expect.arrayContaining([
        "pm.test.system_historical",
        "pm.test.lead_historical",
      ]),
    );
    expect(leadView.auditFilterOptions.actors).toEqual(
      expect.arrayContaining([
        { value: "SYSTEM", label: "系统" },
        { value: lead.person.id, label: lead.person.displayName },
      ]),
    );
    const ownerView = await getTaskLifecycleViews({
      actor: actor(fixture.owner),
      taskId: fixture.taskId,
    });
    expect(ownerView.revisions[0]?.capabilities.canEdit).toBe(true);
    await expectServiceError(
      updateRevisionDraft(actor(lead), validUpdate),
      "FORBIDDEN",
    );
    expect(await revisionTargetSnapshot(targetPlanVersionId)).toEqual(targetBefore);

    await expectServiceError(
      updateRevisionDraft(actor(fixture.owner), {
        ...validUpdate,
        expectedTargetPlanUpdatedAt: new Date(0).toISOString(),
      }),
      "PLAN_VERSION_CONFLICT",
    );
    expect(await revisionTargetSnapshot(targetPlanVersionId)).toEqual(targetBefore);

    await expectServiceError(
      updateRevisionDraft(actor(fixture.owner), {
        ...validUpdate,
        replacementMilestones: [],
      }),
      "PLAN_CHRONOLOGY_INVALID",
    );
    expect(await revisionTargetSnapshot(targetPlanVersionId)).toEqual(targetBefore);

    const associatedSegment = await prisma.workSegment.create({
      data: {
        personId: fixture.member.person.id,
        type: "PLANNED",
        status: "PLANNED",
        startAt: new Date("2026-08-04T01:00:00.000Z"),
        endAt: new Date("2026-08-04T02:00:00.000Z"),
        content: "候选计划关联保护",
        taskId: fixture.taskId,
        nodeId: replacementNode.nodeId,
        createdByAccountId: fixture.owner.account.id,
      },
    });
    await expectServiceError(
      updateRevisionDraft(actor(fixture.owner), validUpdate),
      "STATE_CONFLICT",
    );
    expect(await revisionTargetSnapshot(targetPlanVersionId)).toEqual(targetBefore);
    await prisma.workSegment.delete({ where: { id: associatedSegment.id } });

    const targetBeforeLateFailure = await revisionTargetSnapshot(targetPlanVersionId);
    const functionName = `test_revision_rollback_${randomUUID().replaceAll("-", "")}`;
    const triggerName = `test_revision_rollback_${randomUUID().replaceAll("-", "")}`;
    await prisma.$executeRaw(Prisma.sql`
      CREATE FUNCTION ${Prisma.raw(`"${functionName}"`)}() RETURNS trigger AS $$
      BEGIN
        IF NEW."businessDescription" = 'S6_FORCE_LATE_ROLLBACK' THEN
          RAISE EXCEPTION 'forced revision late rollback';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRaw(Prisma.sql`
      CREATE TRIGGER ${Prisma.raw(`"${triggerName}"`)}
      BEFORE INSERT ON "TaskNode"
      FOR EACH ROW EXECUTE FUNCTION ${Prisma.raw(`"${functionName}"`)}()
    `);
    try {
      await expect(
        updateRevisionDraft(actor(fixture.owner), {
          ...validUpdate,
          replacementMilestones: [
            {
              ...validUpdate.replacementMilestones[0],
              businessDescription: "S6_FORCE_LATE_ROLLBACK",
            },
          ],
        }),
      ).rejects.toThrow(/forced revision late rollback/);
    } finally {
      await prisma.$executeRaw(Prisma.sql`
        DROP TRIGGER ${Prisma.raw(`"${triggerName}"`)} ON "TaskNode"
      `);
      await prisma.$executeRaw(Prisma.sql`
        DROP FUNCTION ${Prisma.raw(`"${functionName}"`)}()
      `);
    }
    expect(await revisionTargetSnapshot(targetPlanVersionId)).toEqual(
      targetBeforeLateFailure,
    );

    await prisma.revisionNode.update({
      where: { id: revision.revisionNodeId },
      data: {
        status: "REJECTED",
        submittedAt: new Date("2026-07-30T00:00:00.000Z"),
        reviewedAt: new Date("2026-07-30T01:00:00.000Z"),
        reviewedByAccountId: fixture.owner.account.id,
        reviewComment: "请修改后重提",
      },
    });

    const updated = await updateRevisionDraft(actor(fixture.owner), validUpdate);
    expect(updated.status).toBe("DRAFT");
    await expect(
      prisma.revisionNode.findUniqueOrThrow({
        where: { id: revision.revisionNodeId },
        select: {
          submittedAt: true,
          reviewedAt: true,
          reviewedByAccountId: true,
          reviewComment: true,
        },
      }),
    ).resolves.toEqual({
      submittedAt: null,
      reviewedAt: null,
      reviewedByAccountId: null,
      reviewComment: "",
    });
    const targetAfter = await revisionTargetSnapshot(targetPlanVersionId);
    expect(targetAfter.updatedAt.getTime()).toBeGreaterThan(targetBefore.updatedAt.getTime());
    expect(
      targetAfter.nodes.flatMap((entry) => entry.node.milestone?.goal ?? []),
    ).toEqual(["候选节点 B", "候选节点 C"]);
    expect(
      targetAfter.nodes.flatMap((entry) =>
        entry.node.milestone ? [entry.node.businessDescription] : [],
      ),
    ).toEqual(["候选节点 B 的业务说明", "候选节点 C 的业务说明"]);
    expect(
      targetAfter.nodes.find((entry) => entry.node.type === "TERMINATION")?.node
        .businessDescription,
    ).toBe("候选结束业务说明");
    const updateAudits = await prisma.domainAuditEvent.findMany({
      where: {
        taskId: fixture.taskId,
        entityId: revision.revisionNodeId,
        action: "pm.revision.draft.update",
      },
      select: { before: true, after: true },
    });
    expect(updateAudits).toHaveLength(1);
    const auditBefore = jsonRecord(updateAudits[0]?.before);
    const auditAfter = jsonRecord(updateAudits[0]?.after);
    expect(jsonRecord(auditBefore.plan).snapshotHash).toBe(targetBefore.snapshotHash);
    expect(jsonRecord(auditAfter.plan).snapshotHash).toBe(targetAfter.snapshotHash);
    expect(jsonRecord(auditAfter.changes).added).toEqual(expect.any(Array));
    expect(jsonRecord(auditAfter.changes).removed).toEqual(expect.any(Array));

    await expectServiceError(
      updateRevisionDraft(actor(fixture.owner), validUpdate),
      "PLAN_VERSION_CONFLICT",
    );
    await expect(
      prisma.domainAuditEvent.count({
        where: {
          taskId: fixture.taskId,
          entityId: revision.revisionNodeId,
          action: "pm.revision.draft.update",
        },
      }),
    ).resolves.toBe(1);
  });

  test("Revision approval atomically switches Current Plan and invalidates planned segments", async () => {
    const fixture = await createActivatedFixture();
    const activeNode = await firstCurrentMilestone(fixture.taskId);
    const planned = await prisma.workSegment.create({
      data: {
        personId: fixture.member.person.id,
        type: "PLANNED",
        status: "PLANNED",
        startAt: new Date("2026-08-01T01:00:00.000Z"),
        endAt: new Date("2026-08-01T03:00:00.000Z"),
        content: "旧节点计划投入",
        taskId: fixture.taskId,
        nodeId: activeNode.nodeId,
        createdByAccountId: fixture.owner.account.id,
      },
    });
    const overlappingPlanned = await prisma.workSegment.create({
      data: {
        personId: fixture.member.person.id,
        type: "PLANNED",
        status: "PLANNED",
        startAt: new Date("2026-08-01T02:00:00.000Z"),
        endAt: new Date("2026-08-01T04:00:00.000Z"),
        content: "其他计划投入",
        createdByAccountId: fixture.owner.account.id,
      },
    });
    const confirmedPlanned = await prisma.workSegment.create({
      data: {
        personId: fixture.member.person.id,
        type: "PLANNED",
        status: "CONFIRMED",
        startAt: new Date("2026-08-01T04:00:00.000Z"),
        endAt: new Date("2026-08-01T05:00:00.000Z"),
        content: "已确认旧节点计划投入",
        taskId: fixture.taskId,
        nodeId: activeNode.nodeId,
        createdByAccountId: fixture.owner.account.id,
      },
    });
    const cancelledPlanned = await prisma.workSegment.create({
      data: {
        personId: fixture.member.person.id,
        type: "PLANNED",
        status: "CANCELLED",
        startAt: new Date("2026-08-01T05:00:00.000Z"),
        endAt: new Date("2026-08-01T06:00:00.000Z"),
        content: "已取消旧节点计划投入",
        taskId: fixture.taskId,
        nodeId: activeNode.nodeId,
        createdByAccountId: fixture.owner.account.id,
      },
    });

    const revision = await createRevisionDraft(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      revisedFromNodeId: activeNode.nodeId,
      reason: "当前目标变更",
      replacementMilestones: [
        milestoneInput("新的当前 Milestone", "完成替代目标", 5),
      ],
      plannedStartAt: new Date(
        Date.UTC(2026, 6, 31, 11, 0, 0),
      ).toISOString(),
      termination: terminationInput(9),
      idempotencyKey: `revision-apply-${randomUUID()}`,
    });
    await submitRevision(actor(fixture.owner), {
      revisionNodeId: revision.revisionNodeId,
      comment: "请审批",
    });
    const revisionPendingPayload = await expectProjectManagementOutbox(
      `pm:revision:pending_review:${revision.revisionNodeId}:feishu`,
      {
        type: "revision_pending_review",
        botKind: "approval",
        purpose: "approval_request",
      },
    );
    expect(revisionPendingPayload.payloadVersion).toBe(1);
    const applied = await approveRevision(actor(fixture.reviewer), {
      revisionNodeId: revision.revisionNodeId,
      comment: "同意调整",
    });
    expect(applied.status).toBe("EFFECTIVE");
    expect(applied.currentPlanVersionId).toBe(revision.targetPlanVersionId);
    const plans = await prisma.taskPlanVersion.findMany({
      where: { taskId: fixture.taskId },
      select: { id: true, status: true },
      orderBy: { versionNo: "asc" },
    });
    expect(plans).toEqual([
      { id: fixture.currentPlanVersionId, status: "HISTORICAL" },
      { id: revision.targetPlanVersionId, status: "CURRENT" },
    ]);
    const oldNode = await prisma.taskNode.findUniqueOrThrow({
      where: { id: activeNode.nodeId },
      select: { status: true },
    });
    expect(oldNode.status).toBe("REVISED");
    const updatedSegment = await prisma.workSegment.findUniqueOrThrow({
      where: { id: planned.id },
      select: { associationNeedsReview: true },
    });
    expect(updatedSegment.associationNeedsReview).toBe(true);
    expect(
      await prisma.workSegment.findUniqueOrThrow({
        where: { id: overlappingPlanned.id },
        select: { associationNeedsReview: true },
      }),
    ).toEqual({ associationNeedsReview: false });
    await prisma.workSegmentChange.findFirstOrThrow({
      where: {
        segmentId: planned.id,
        action: "UPDATE",
        reason: "Revision 生效后原关联节点失效",
      },
    });
    await prisma.domainAuditEvent.findFirstOrThrow({
      where: {
        entityType: "WorkSegment",
        entityId: planned.id,
        action: "pm.segment.update",
      },
    });
    const terminalSegments = await prisma.workSegment.findMany({
      where: { id: { in: [confirmedPlanned.id, cancelledPlanned.id] } },
      select: { id: true, associationNeedsReview: true },
      orderBy: { id: "asc" },
    });
    expect(terminalSegments.map((segment) => segment.associationNeedsReview)).toEqual([
      false,
      false,
    ]);
    const revisionAppliedPayload = await expectProjectManagementOutbox(
      `pm:revision:applied:${revision.revisionNodeId}:feishu`,
      {
        type: "revision_applied",
        botKind: "notification",
        purpose: "notification",
      },
    );
    expect(jsonRecord(revisionAppliedPayload.context).currentPlanVersionId).toBe(
      revision.targetPlanVersionId,
    );
    expect(revisionAppliedPayload.recipientOpenIds).toContain(
      fixture.owner.openId,
    );
    expect(revisionAppliedPayload.recipientOpenIds).not.toContain(
      fixture.member.openId,
    );
    expect(revisionAppliedPayload.recipientOpenIds).not.toContain(
      fixture.reviewer.openId,
    );
    const associationInvalidatedPayload = await expectProjectManagementOutbox(
      `pm:segment:association_invalidated:${revision.revisionNodeId}:feishu`,
      {
        type: "segment_association_invalidated",
        botKind: "notification",
        purpose: "notification",
      },
    );
    expect(associationInvalidatedPayload.actorName).toBe(
      fixture.reviewer.person.displayName,
    );
    expect(
      jsonRecord(associationInvalidatedPayload.context).currentPlanVersionId,
    ).toBe(revision.targetPlanVersionId);
    expect(
      jsonRecord(associationInvalidatedPayload.context).currentPlanVersionId,
    ).not.toBe(fixture.currentPlanVersionId);
    expect(associationInvalidatedPayload.recipientOpenIds).toEqual([
      fixture.member.openId,
    ]);
    const associationInvalidatedInApp =
      await prisma.inAppNotification.findUniqueOrThrow({
        where: {
          eventKey: `pm:segment:association_invalidated:${revision.revisionNodeId}:inapp:${fixture.member.account.id}`,
        },
        select: { payload: true },
      });
    expect(
      jsonRecord(jsonRecord(associationInvalidatedInApp.payload).context)
        .currentPlanVersionId,
    ).toBe(revision.targetPlanVersionId);
    expect(
      jsonRecord(associationInvalidatedInApp.payload).actorName,
    ).toBe(fixture.reviewer.person.displayName);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: `pm:segment:association_invalidated:${revision.revisionNodeId}:feishu`,
          type: "segment_association_invalidated",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.domainAuditEvent.count({
        where: { taskId: fixture.taskId, action: "pm.revision.apply" },
      }),
    ).toBe(1);

    const diff = await comparePlanVersions({
      actor: actor(fixture.owner),
      fromPlanVersionId: fixture.currentPlanVersionId,
      toPlanVersionId: applied.currentPlanVersionId,
    });
    expect(diff.added.length).toBeGreaterThan(0);
    expect(diff.planChanges.plannedStartAt).toEqual({
      before: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
      after: new Date(Date.UTC(2026, 6, 31, 11, 0, 0)).toISOString(),
    });
    const planHistory = await listTaskPlanVersions({
      actor: actor(fixture.owner),
      taskId: fixture.taskId,
    });
    expect(planHistory.map((plan) => plan.id)).toEqual(
      expect.arrayContaining([
        fixture.currentPlanVersionId,
        applied.currentPlanVersionId,
      ]),
    );
    const outsider = await createAccountPerson("生命周期 Plan Outsider");
    expect(
      (
        await getPlanVersion({
          actor: actor(outsider),
          planVersionId: applied.currentPlanVersionId,
        })
      ).id,
    ).toBe(applied.currentPlanVersionId);
    expect(
      await listTaskPlanVersions({
        actor: actor(outsider),
        taskId: fixture.taskId,
      }),
    ).toHaveLength(2);
    expect(
      (
        await comparePlanVersions({
          actor: actor(outsider),
          fromPlanVersionId: fixture.currentPlanVersionId,
          toPlanVersionId: applied.currentPlanVersionId,
        })
      ).added.length,
    ).toBeGreaterThan(0);

    await expectServiceError(
      createRevisionDraft(actor(fixture.owner), {
        taskId: fixture.taskId,
        basePlanVersionId: fixture.currentPlanVersionId,
        baseTaskLockVersion: 1,
        revisedFromNodeId: activeNode.nodeId,
        reason: "基线已过期",
        replacementMilestones: [
          milestoneInput("过期修订", "不会生效", 6),
        ],
        plannedStartAt: new Date(
          Date.UTC(2026, 6, 31, 10, 0, 0),
        ).toISOString(),
        termination: terminationInput(10),
        idempotencyKey: `revision-stale-${randomUUID()}`,
      }),
      "PLAN_VERSION_CONFLICT",
    );
  });

  test("Revision concurrent approval and rejection cannot overwrite each other", async () => {
    const fixture = await createActivatedFixture();
    const activeNode = await firstCurrentMilestone(fixture.taskId);
    const revision = await createRevisionDraft(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      revisedFromNodeId: activeNode.nodeId,
      reason: "并发审批测试",
      replacementMilestones: [
        milestoneInput("并发后计划", "只有一个审批结果", 5),
      ],
      plannedStartAt: new Date(
        Date.UTC(2026, 6, 31, 10, 0, 0),
      ).toISOString(),
      termination: terminationInput(9),
      idempotencyKey: `revision-race-${randomUUID()}`,
    });
    await submitRevision(actor(fixture.owner), {
      revisionNodeId: revision.revisionNodeId,
      comment: "请审批",
    });

    const decisions = await Promise.allSettled([
      approveRevision(actor(fixture.reviewer), {
        revisionNodeId: revision.revisionNodeId,
        comment: "同意",
      }),
      rejectRevision(actor(fixture.admin), {
        revisionNodeId: revision.revisionNodeId,
        comment: "不同意",
      }),
    ]);
    const fulfilled = decisions.filter(
      (entry): entry is PromiseFulfilledResult<
        Awaited<ReturnType<typeof approveRevision | typeof rejectRevision>>
      > => entry.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(1);
    expect(decisions.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const persistedRevision = await prisma.revisionNode.findUniqueOrThrow({
      where: { id: revision.revisionNodeId },
      select: { status: true, targetPlanVersion: { select: { id: true } } },
    });
    expect(persistedRevision.status).toBe(fulfilled[0]?.value.status);
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: fixture.taskId },
      select: { currentPlanVersionId: true },
    });
    if (persistedRevision.status === "EFFECTIVE") {
      expect(task.currentPlanVersionId).toBe(revision.targetPlanVersionId);
    } else {
      expect(task.currentPlanVersionId).toBe(fixture.currentPlanVersionId);
    }
  });

  test("Revision always waits for approval and a global administrator may self-approve", async () => {
    const fixture = await createActivatedFixture();
    const activeNode = await firstCurrentMilestone(fixture.taskId);
    const revision = await createRevisionDraft(actor(fixture.admin), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      revisedFromNodeId: activeNode.nodeId,
      reason: "Owner 直接调整",
      replacementMilestones: [
        milestoneInput("Owner 新计划", "完成 Owner 目标", 3),
      ],
      plannedStartAt: new Date(
        Date.UTC(2026, 6, 31, 10, 0, 0),
      ).toISOString(),
      termination: terminationInput(7),
      idempotencyKey: `revision-direct-${randomUUID()}`,
    });
    const submitted = await submitRevision(actor(fixture.admin), {
      revisionNodeId: revision.revisionNodeId,
      comment: "提交后显式自审",
    });
    expect(submitted.status).toBe("PENDING_APPROVAL");
    expect(submitted.currentPlanVersionId).toBe(fixture.currentPlanVersionId);
    const approved = await approveRevision(actor(fixture.admin), {
      revisionNodeId: revision.revisionNodeId,
      comment: "管理员自审通过",
    });
    expect(approved.status).toBe("EFFECTIVE");
    expect(approved.currentPlanVersionId).toBe(revision.targetPlanVersionId);
  });

  test("Termination enforces success prerequisites and supports early failed/cancelled/timeout outcomes", async () => {
    const successFixture = await createActivatedFixture();
    const successNodes = await currentPlanNodes(successFixture.taskId);
    await expectServiceError(
      confirmTermination(actor(successFixture.owner), {
        taskId: successFixture.taskId,
        terminationNodeId: successNodes[2]?.nodeId,
        outcome: "SUCCESS",
        reason: "",
        summary: "不能提前成功",
        expectedLockVersion: 1,
      }),
      "STATE_CONFLICT",
    );

    for (const outcome of ["FAILED", "CANCELLED", "TIMEOUT"] as const) {
      const fixture = await createActivatedFixture();
      const nodes = await currentPlanNodes(fixture.taskId);
      const before = await prisma.task.findUniqueOrThrow({
        where: { id: fixture.taskId },
        select: { lockVersion: true },
      });
      const terminated = await confirmTermination(actor(fixture.owner), {
        taskId: fixture.taskId,
        terminationNodeId: nodes[2]?.nodeId,
        outcome,
        reason: `${outcome} 原因`,
        summary: `${outcome} 总结`,
        expectedLockVersion: before.lockVersion,
      });
      expect(terminated.status).toBe(
        outcome === "FAILED"
          ? "FAILED"
          : outcome === "CANCELLED"
            ? "CANCELLED"
            : "TIMEOUT",
      );
      const afterNodes = await currentPlanNodes(fixture.taskId);
      expect(afterNodes[0]?.node.status).toBe("CANCELLED");
      expect(afterNodes[1]?.node.status).toBe("CANCELLED");
      await expectProjectManagementOutbox(
        `pm:task:terminated:${nodes[2]?.nodeId}:feishu`,
        {
          type: "task_terminated",
          botKind: "notification",
          purpose: "notification",
        },
      );
      const repeated = await confirmTermination(actor(fixture.owner), {
        taskId: fixture.taskId,
        terminationNodeId: nodes[2]?.nodeId,
        outcome,
        reason: `${outcome} 原因`,
        summary: `${outcome} 总结`,
        expectedLockVersion: before.lockVersion,
      });
      expect(repeated.outcome).toBe(outcome);
      await expectServiceError(
        confirmTermination(actor(fixture.owner), {
          taskId: fixture.taskId,
          terminationNodeId: nodes[2]?.nodeId,
          outcome: "SUCCESS",
          reason: "",
          summary: "不同结果不能重复确认",
          expectedLockVersion: before.lockVersion,
        }),
        "STATE_CONFLICT",
      );
    }

    const reviewerCancelFixture = await createActivatedFixture();
    const reviewerCancelNodes = await currentPlanNodes(
      reviewerCancelFixture.taskId,
    );
    const reviewerCancelTask = await prisma.task.findUniqueOrThrow({
      where: { id: reviewerCancelFixture.taskId },
      select: { lockVersion: true },
    });
    const reviewerCancelled = await confirmTermination(
      actor(reviewerCancelFixture.reviewer),
      {
        taskId: reviewerCancelFixture.taskId,
        terminationNodeId: reviewerCancelNodes[2]?.nodeId,
        outcome: "CANCELLED",
        reason: "Reviewer 确认取消",
        summary: "Reviewer 可执行结束确认",
        expectedLockVersion: reviewerCancelTask.lockVersion,
      },
    );
    expect(reviewerCancelled.status).toBe("CANCELLED");

    const completedFixture = await createActivatedFixture(1);
    const activeNode = await firstCurrentMilestone(completedFixture.taskId);
    const review = await submitMilestoneForReview(actor(completedFixture.member), {
      milestoneNodeId: activeNode.nodeId,
      idempotencyKey: `review-before-success-${randomUUID()}`,
      evidences: [{ kind: "TEXT", note: "单 Milestone 已完成" }],
    });
    const approved = await reviewMilestone(actor(completedFixture.reviewer), {
      reviewId: review.reviewId,
      result: "APPROVED",
      comment: "通过",
    });
    expect(approved.activeMilestoneNodeId).toBeNull();
    const terminationNode = (await currentPlanNodes(completedFixture.taskId))[1];
    const taskBeforeSuccess = await prisma.task.findUniqueOrThrow({
      where: { id: completedFixture.taskId },
      select: { lockVersion: true },
    });
    const success = await confirmTermination(actor(completedFixture.owner), {
      taskId: completedFixture.taskId,
      terminationNodeId: terminationNode?.nodeId,
      outcome: "SUCCESS",
      reason: "",
      summary: "达到结束条件",
      expectedLockVersion: taskBeforeSuccess.lockVersion,
    });
    expect(success.status).toBe("COMPLETED");
  });

  test("没有可用全局审批人或有效飞书身份时提交审批整事务回滚", async () => {
    const fixture = await createActivatedFixture();
    const activeNode = await firstCurrentMilestone(fixture.taskId);
    const revision = await createRevisionDraft(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: fixture.lockVersion,
      revisedFromNodeId: activeNode.nodeId,
      reason: "审批人可达性门禁",
      replacementMilestones: [
        milestoneInput("审批人恢复后再提交", "审批链路可达", 4),
      ],
      plannedStartAt: new Date(
        Date.UTC(2026, 6, 31, 10, 0, 0),
      ).toISOString(),
      termination: terminationInput(8),
      idempotencyKey: `revision-approver-guard-${randomUUID()}`,
    });
    const activeAssignments = await prisma.systemRoleAssignment.findMany({
      where: {
        role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] },
        team: "",
        techGroup: "",
        revokedAt: null,
      },
      select: { id: true },
    });
    const reviewKey = `review-approver-guard-${randomUUID()}`;
    await withGlobalApprovalAdministratorGuardDisabled(async () => {
      try {
        await prisma.systemRoleAssignment.updateMany({
          where: { id: { in: activeAssignments.map((item) => item.id) } },
          data: { revokedAt: new Date() },
        });
        const milestoneError = await captureServiceError(
          submitMilestoneForReview(actor(fixture.member), {
            milestoneNodeId: activeNode.nodeId,
            idempotencyKey: reviewKey,
            evidences: [{ kind: "TEXT", note: "没有审批人时不得落库" }],
          }),
        );
        expect(milestoneError).toMatchObject({
          code: "STATE_CONFLICT",
          message: expect.stringContaining(
            "至少保留一名全局管理员",
          ),
        });
        const revisionError = await captureServiceError(
          submitRevision(actor(fixture.owner), {
            revisionNodeId: revision.revisionNodeId,
            comment: "没有审批人时不得进入待审批",
          }),
        );
        expect(revisionError).toMatchObject({
          code: "STATE_CONFLICT",
          message: expect.stringContaining(
            "至少保留一名全局管理员",
          ),
        });
      } finally {
        await prisma.systemRoleAssignment.updateMany({
          where: { id: { in: activeAssignments.map((item) => item.id) } },
          data: { revokedAt: null, revokedByAccountId: null },
        });
      }
    });

    const administratorIdentities = await prisma.accountIdentity.findMany({
      where: {
        provider: "FEISHU",
        tenantId: "default",
        account: {
          systemRoles: {
            some: {
              role: {
                in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"],
              },
              team: "",
              techGroup: "",
              revokedAt: null,
            },
          },
        },
      },
      select: { id: true, openId: true },
    });
    await withGlobalApprovalAdministratorGuardDisabled(async () => {
      try {
        await prisma.$transaction(
          administratorIdentities.map((identity, index) =>
            prisma.accountIdentity.update({
              where: { id: identity.id },
              data: { openId: " ".repeat(index + 1) },
            }),
          ),
        );
        const error = await captureServiceError(
          submitRevision(actor(fixture.owner), {
            revisionNodeId: revision.revisionNodeId,
            comment: "没有可达飞书身份时不得进入待审批",
          }),
        );
        expect(error).toMatchObject({
          code: "STATE_CONFLICT",
          message: expect.stringContaining("有效飞书身份"),
        });
      } finally {
        await prisma.$transaction(
          administratorIdentities.map((identity) =>
            prisma.accountIdentity.update({
              where: { id: identity.id },
              data: { openId: identity.openId },
            }),
          ),
        );
      }
    });

    await expect(
      prisma.milestoneReview.count({
        where: { milestoneNodeId: activeNode.nodeId, idempotencyKey: reviewKey },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.revisionNode.findUniqueOrThrow({
        where: { id: revision.revisionNodeId },
        select: { status: true, submittedAt: true },
      }),
    ).resolves.toEqual({ status: "DRAFT", submittedAt: null });
  });
});

async function createActivatedFixture(milestoneCount = 2) {
  const fixture = await createDraftFixture(milestoneCount);
  const activated = await activateTask(actor(fixture.owner), {
    taskId: fixture.taskId,
    expectedLockVersion: 0,
  });
  return { ...fixture, lockVersion: activated.lockVersion };
}

async function createDraftFixture(milestoneCount = 2) {
  const admin = await createAccountPerson("生命周期 Admin");
  const owner = await createAccountPerson("生命周期 Owner");
  const member = await createAccountPerson("生命周期 Member");
  const reviewer = await createAccountPerson("生命周期 Reviewer");
  await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
  await grantRole(reviewer.account.id, "SUPER_ADMINISTRATOR");
  const input = taskDraftInput({
    ownerPersonId: owner.person.id,
    memberPersonId: member.person.id,
    reviewerPersonId: reviewer.person.id,
    idempotencyKey: `task-${randomUUID()}`,
    milestoneCount,
  });
  const created = await createTaskDraft(actor(admin), input);
  return {
    admin,
    owner,
    member,
    reviewer,
    taskId: created.taskId,
    currentPlanVersionId: created.currentPlanVersionId,
  };
}

function taskDraftInput({
  ownerPersonId,
  memberPersonId,
  reviewerPersonId,
  idempotencyKey,
  tagIds = [],
  milestoneCount = 2,
}: {
  ownerPersonId: string;
  memberPersonId: string;
  reviewerPersonId: string;
  idempotencyKey: string;
  tagIds?: string[];
  milestoneCount?: number;
}) {
  return {
    title: `生命周期 Task ${randomUUID()}`,
    description: "服务端生命周期测试",
    team: "英雄",
    techGroup: "电控",
    priority: "HIGH",
    tagIds,
    members: [
      { personId: ownerPersonId, role: "OWNER" },
      { personId: memberPersonId, role: "PARTICIPANT" },
      { personId: reviewerPersonId, role: "PARTICIPANT" },
    ],
    milestones: Array.from({ length: milestoneCount }, (_, index) =>
      milestoneInput(
        `Milestone ${index + 1}`,
        `完成条件 ${index + 1}`,
        index + 1,
      ),
    ),
    plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
    termination: terminationInput(milestoneCount + 3),
    idempotencyKey,
  };
}

function milestoneInput(goal: string, criteria: string, daysFromBase: number) {
  return {
    goal,
    completionCriteria: criteria,
    expectedCompletedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    reviewRequirements: "提交文本或链接证据",
    businessDescription: goal,
  };
}

function terminationInput(daysFromBase: number) {
  return {
    plannedOutcomeCriteria: "所有 Milestone 完成并完成总结",
    plannedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    businessDescription: "结束确认",
  };
}

async function currentPlanNodes(taskId: string) {
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { currentPlanVersionId: true },
  });
  return prisma.planVersionNode.findMany({
    where: { planVersionId: task.currentPlanVersionId },
    include: {
      node: {
        include: {
          milestone: true,
          revision: true,
          termination: true,
        },
      },
    },
    orderBy: { sequence: "asc" },
  });
}

async function revisionTargetSnapshot(planVersionId: string) {
  return prisma.taskPlanVersion.findUniqueOrThrow({
    where: { id: planVersionId },
    select: {
      updatedAt: true,
      snapshotHash: true,
      nodes: {
        include: {
          node: {
            include: {
              milestone: true,
              revision: true,
              termination: true,
            },
          },
        },
        orderBy: { sequence: "asc" },
      },
    },
  });
}

async function firstCurrentMilestone(taskId: string) {
  const nodes = await currentPlanNodes(taskId);
  const active = nodes.find(
    (entry) =>
      entry.node.type === "MILESTONE" && entry.node.status === "ACTIVE",
  );
  if (!active) throw new Error("测试数据缺少 Active Milestone");
  return active;
}

async function createAccountPerson(displayName: string) {
  const openId = `ou_pm_lifecycle_${randomUUID()}`;
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
      person: {
        create: {
          displayName,
          status: "ACTIVE",
        },
      },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { account, person: account.person, openId };
}

async function grantRole(
  accountId: string,
  role: "SUPER_ADMINISTRATOR" | "PROJECT_ADMINISTRATOR",
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team: "",
      techGroup: "",
    },
  });
}

function actor(input: Awaited<ReturnType<typeof createAccountPerson>>): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles: [],
  };
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: ReturnType<typeof toProjectManagementServiceError>["code"],
) {
  await expect(
    promise.catch((error) => toProjectManagementServiceError(error).code),
  ).resolves.toBe(code);
}

async function captureServiceError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return toProjectManagementServiceError(error);
  }
  throw new Error("测试期望服务错误，但操作成功了");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("测试期望 JSON object payload");
}

function issueMessages(issues: Array<{ message: string }>) {
  return issues.map((issue) => issue.message);
}

async function expectProjectManagementOutbox(
  eventKey: string,
  expected: {
    type: string;
    botKind: string;
    purpose: "notification" | "approval_request";
  },
) {
  const row = await prisma.notificationOutbox.findUniqueOrThrow({
    where: { eventKey },
    select: {
      channel: true,
      type: true,
      botKind: true,
      payload: true,
    },
  });
  expect(row.channel).toBe("project-management");
  expect(row.type).toBe(expected.type);
  expect(row.botKind).toBe(expected.botKind);
  const payload = jsonRecord(JSON.parse(row.payload));
  expect(payload.kind).toBe(expected.type);
  expect(payload.purpose).toBe(expected.purpose);
  return payload;
}
