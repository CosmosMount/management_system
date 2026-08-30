// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Prisma, type TerminationOutcome } from "@prisma/client";
import { Client } from "pg";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  approveRevision,
  cancelRevision,
  createRevision,
  createTaskDraft,
  deleteTaskDraft,
  rejectRevision,
  reviewMilestone,
  reviewTermination,
  submitMilestoneForReview,
  submitTerminationForReview,
  reviseRejectedRevision,
} from "../lib/project-management/application/lifecycle-service";
import { toProjectManagementServiceError } from "../lib/project-management/application/errors";
import {
  comparePlanVersions,
  getMilestoneCompletionDetails,
  getPlanVersion,
  getTaskWorkspace,
  listTasks,
  listTaskPlanVersions,
} from "../lib/project-management/queries/task-queries";
import {
  getActorPersonOption,
  listMyTaskOptions,
  searchTaskOptions,
} from "../lib/project-management/queries/option-queries";
import { getContentDrivenTimeCanvasData } from "../lib/project-management/queries/time-canvas-queries";
import { getActionInbox } from "../lib/project-management/queries/action-inbox-queries";
import { listInAppNotifications } from "../lib/project-management/queries/notification-queries";
import {
  getProjectManagementActorForFeishuUser,
  type ProjectManagementActor,
} from "../lib/project-management/identity";
import { updateNotificationPreference } from "../lib/project-management/application/notification-preference-service";
import { updateTaskProject } from "../lib/project-management/application/project-service";
import { firstNonEmptyFeishuOpenId } from "../lib/project-management/application/feishu-identity";
import { hashLifecycleRequest } from "../lib/project-management/application/lifecycle-plan-audit";
import {
  getRevisionComposerRecord,
  getTaskLifecycleViews,
} from "../lib/project-management/queries/task-lifecycle-queries";
import {
  createTaskDraftInputSchema,
  milestoneDraftSchema,
  submitMilestoneReviewInputSchema,
  terminationDraftSchema,
  taskWorkspaceQueryInputSchema,
} from "../lib/project-management/validations/lifecycle";
import { withGlobalApprovalAdministratorGuardDisabled } from "./helpers/global-approval-administrator-guard";
import { projectManagementNotificationChannel } from "../lib/notification-channels/project-management";
import { waitForDirectBlockers } from "./helpers/database-barrier";
import { updateTaskMembersThroughCurrentInterface } from "./helpers/project-management-plan-mutation-fixtures";

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
      name: "Terminal",
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

  test("Task draft creation is open to unified accounts, idempotent and globally readable", { tag: "@smoke" }, async () => {
    const admin = await createAccountPerson("生命周期 Team Admin");
    const owner = await createAccountPerson("生命周期 Owner");
    const member = await createAccountPerson("生命周期 Member");
    const reviewer = await createAccountPerson("生命周期 Reviewer");
    const outsider = await createAccountPerson("生命周期 Outsider");
    await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
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
      prisma.taskMember.count({
        where: {
          taskId: outsiderCreated.taskId,
          personId: outsider.person.id,
          removedAt: null,
        },
      }),
    ).resolves.toBe(0);

    const created = await createTaskDraft(actor(admin), draftInput);
    expect(created).toMatchObject({ created: true, status: "DRAFT" });

    const repeated = await createTaskDraft(actor(admin), draftInput);
    expect(repeated).toMatchObject({
      created: false,
      taskId: created.taskId,
      currentPlanVersionId: created.currentPlanVersionId,
    });
    await expect(
      prisma.taskPlanVersion.findUniqueOrThrow({
        where: { id: created.currentPlanVersionId },
        select: { creationRequestHash: true },
      }),
    ).resolves.toMatchObject({
      creationRequestHash: expect.stringMatching(/^v2:[a-f0-9]{64}$/),
    });
    const parsedDraftInput = createTaskDraftInputSchema.parse(draftInput);
    const legacyNormalizedInput = {
      ...parsedDraftInput,
      members: [
        ...parsedDraftInput.members,
        { personId: admin.person.id, role: "OWNER" as const },
      ],
    };
    const legacyRequestHash = hashLifecycleRequest(
      "task.create_draft",
      legacyNormalizedInput,
    );
    await prisma.taskPlanVersion.update({
      where: { id: created.currentPlanVersionId },
      data: { creationRequestHash: legacyRequestHash },
    });
    await prisma.taskMember.create({
      data: {
        taskId: created.taskId,
        personId: admin.person.id,
        role: "OWNER",
        createdByAccountId: admin.account.id,
      },
    });
    await expect(createTaskDraft(actor(admin), draftInput)).resolves.toMatchObject({
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
      idempotencyKey: `task-draft-race-${randomUUID()}`,
    });
    const concurrentCreates = await Promise.all([
      createTaskDraft(actor(admin), concurrentDraftInput),
      createTaskDraft(actor(admin), concurrentDraftInput),
    ]);
    expect(new Set(concurrentCreates.map((entry) => entry.taskId)).size).toBe(1);
    expect(concurrentCreates.filter((entry) => entry.created)).toHaveLength(1);

    const creatorRoleInput = {
      ...taskDraftInput({
        ownerPersonId: owner.person.id,
        memberPersonId: member.person.id,
        reviewerPersonId: reviewer.person.id,
        idempotencyKey: `task-draft-versioned-hash-${randomUUID()}`,
      }),
      members: [
        { personId: admin.person.id, role: "OWNER" as const },
        { personId: owner.person.id, role: "OWNER" as const },
      ],
    };
    await createTaskDraft(actor(admin), creatorRoleInput);
    await expectServiceError(
      createTaskDraft(actor(admin), {
        ...creatorRoleInput,
        members: [
          { personId: admin.person.id, role: "PARTICIPANT" },
          { personId: owner.person.id, role: "OWNER" },
        ],
      }),
      "STATE_CONFLICT",
    );

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
    expect(assignedPayload.linkPath).toBe(`/progress/tasks/${created.taskId}`);
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
        select: { linkPath: true, payload: true },
      });
    expect(inAppNotification.linkPath).toBe(`/progress/tasks/${created.taskId}`);
    expect(jsonRecord(inAppNotification.payload).linkPath).toBe(
      `/progress/tasks/${created.taskId}`,
    );
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

  test("Task drafts defer member completeness without implicitly assigning the creator", async () => {
    const guardAdmin = await createAccountPerson("生命周期空成员草稿守卫管理员");
    const creator = await createAccountPerson("生命周期空成员草稿创建者");
    const participant = await createAccountPerson("生命周期空成员草稿参与人");
    const outsider = await createAccountPerson("生命周期空成员草稿无权账号");
    await grantRole(guardAdmin.account.id, "PROJECT_ADMINISTRATOR");
    const input = {
      ...taskDraftInput({
        ownerPersonId: creator.person.id,
        memberPersonId: participant.person.id,
        reviewerPersonId: outsider.person.id,
        idempotencyKey: `memberless-draft-${randomUUID()}`,
      }),
      members: [],
    };

    const created = await createTaskDraft(actor(creator), input);
    expect(created).toMatchObject({ status: "DRAFT", lockVersion: 0 });
    await expect(
      prisma.taskMember.count({ where: { taskId: created.taskId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationOutbox.count({
        where: { eventKey: `pm:task:assigned:${created.taskId}:v1:feishu` },
      }),
    ).resolves.toBe(0);
    await expect(
      listTasks({
        actor: actor(creator),
        input: { mine: true, query: input.title },
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: created.taskId })],
    });
    await expect(
      listTasks({
        actor: actor(outsider),
        input: { mine: true, query: input.title },
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      searchTaskOptions({
        actor: actor(creator),
        input: { query: input.title, mine: true, limit: 50 },
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: created.taskId })],
    });
    await expect(
      listMyTaskOptions({
        actor: actor(creator),
        statuses: ["DRAFT"],
      }),
    ).resolves.toContainEqual(expect.objectContaining({ id: created.taskId }));
    await expect(
      searchTaskOptions({
        actor: actor(creator),
        input: {
          query: input.title,
          projectCandidates: true,
          limit: 50,
        },
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: created.taskId })],
    });
    await expect(
      searchTaskOptions({
        actor: actor(outsider),
        input: { query: input.title, mine: true, limit: 50 },
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      searchTaskOptions({
        actor: actor(outsider),
        input: {
          query: input.title,
          projectCandidates: true,
          limit: 50,
        },
      }),
    ).resolves.toMatchObject({ items: [] });

    const creatorCanvas = await getContentDrivenTimeCanvasData({
      actor: actor(creator),
      input: memberlessDraftCanvasInput(created.taskId),
      load: { mode: "INITIAL" },
    });
    const creatorAnchor = creatorCanvas.data.anchors.find(
      (anchor) => anchor.id === created.taskId,
    );
    expect(creatorAnchor).toMatchObject({
      capabilities: {
        canUpdateMetadata: true,
        canManageMembers: true,
        canActivate: true,
      },
    });
    expect(creatorAnchor?.nodes).not.toHaveLength(0);
    expect(
      creatorAnchor?.nodes.every((node) => node.capabilities.canEditDraft),
    ).toBe(true);
    const outsiderCanvas = await getContentDrivenTimeCanvasData({
      actor: actor(outsider),
      input: memberlessDraftCanvasInput(created.taskId),
      load: { mode: "INITIAL" },
    });
    const outsiderAnchor = outsiderCanvas.data.anchors.find(
      (anchor) => anchor.id === created.taskId,
    );
    expect(outsiderAnchor).toMatchObject({
      capabilities: {
        canUpdateMetadata: false,
        canManageMembers: false,
        canActivate: false,
      },
    });
    expect(
      outsiderAnchor?.nodes.every((node) => !node.capabilities.canEditDraft),
    ).toBe(true);

    const associationDraft = await createTaskDraft(actor(creator), {
      ...input,
      title: `生命周期零成员归属 Task ${randomUUID()}`,
      idempotencyKey: `memberless-project-${randomUUID()}`,
    });
    const targetProject = await prisma.project.create({
      data: {
        name: `生命周期零成员归属 Project ${randomUUID()}`,
        description: "验证草稿创建者可以修改 Project 归属",
        status: "ACTIVE",
        requesterAccountId: creator.account.id,
      },
    });
    await expect(
      updateTaskProject(actor(creator), {
        taskId: associationDraft.taskId,
        expectedLockVersion: 0,
        projectId: targetProject.id,
      }),
    ).resolves.toMatchObject({
      taskId: associationDraft.taskId,
      projectId: targetProject.id,
      lockVersion: 1,
    });
    await expect(
      updateTaskProject(actor(creator), {
        taskId: associationDraft.taskId,
        expectedLockVersion: 1,
        projectId: null,
      }),
    ).resolves.toMatchObject({
      taskId: associationDraft.taskId,
      projectId: null,
      lockVersion: 2,
    });

    const creatorWorkspace = await getTaskWorkspace({
      actor: actor(creator),
      taskId: created.taskId,
    });
    expect(creatorWorkspace.permissions).toMatchObject({
      canUpdateMetadata: true,
      canManageMembers: true,
      canActivate: true,
      canDeleteDraft: true,
    });
    const outsiderWorkspace = await getTaskWorkspace({
      actor: actor(outsider),
      taskId: created.taskId,
    });
    expect(outsiderWorkspace.permissions).toMatchObject({
      canUpdateMetadata: false,
      canManageMembers: false,
      canActivate: false,
      canDeleteDraft: false,
    });
    await expectServiceError(
      updateTaskMembersThroughCurrentInterface(actor(outsider), {
        taskId: created.taskId,
        expectedLockVersion: 0,
        members: [{ personId: participant.person.id, role: "PARTICIPANT" }],
      }),
      "FORBIDDEN",
    );

    const activationError = await captureServiceError(
      activateTask(actor(creator), {
        taskId: created.taskId,
        expectedLockVersion: 0,
      }),
    );
    expect(activationError).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "激活 Task 前至少需要一名有效负责人",
      fieldErrors: {
        members: ["激活 Task 前至少需要一名有效负责人"],
      },
    });
    await expect(
      prisma.task.findUniqueOrThrow({
        where: { id: created.taskId },
        select: { status: true, lockVersion: true },
      }),
    ).resolves.toEqual({ status: "DRAFT", lockVersion: 0 });
    await expect(
      prisma.domainAuditEvent.count({
        where: { taskId: created.taskId, action: "pm.task.activate" },
      }),
    ).resolves.toBe(0);

    const participantOnly = await updateTaskMembersThroughCurrentInterface(
      actor(creator),
      {
        taskId: created.taskId,
        expectedLockVersion: 0,
        members: [{ personId: participant.person.id, role: "PARTICIPANT" }],
      },
    );
    expect(participantOnly.lockVersion).toBe(1);
    expect(participantOnly.members).toEqual([
      { personId: participant.person.id, role: "PARTICIPANT" },
    ]);
    await expectProjectManagementOutbox(
      `pm:task:member_changed:${created.taskId}:1:${participant.person.id}:feishu`,
      {
        type: "task_assigned",
        botKind: "notification",
        purpose: "notification",
      },
    );
    await expect(
      prisma.taskMember.count({
        where: {
          taskId: created.taskId,
          personId: creator.person.id,
          removedAt: null,
        },
      }),
    ).resolves.toBe(0);

    const withOwner = await updateTaskMembersThroughCurrentInterface(
      actor(creator),
      {
        taskId: created.taskId,
        expectedLockVersion: 1,
        members: [{ personId: participant.person.id, role: "OWNER" }],
      },
    );
    expect(withOwner.lockVersion).toBe(2);
    await prisma.person.update({
      where: { id: participant.person.id },
      data: { status: "INACTIVE" },
    });
    const beforeInactiveOwnerActivation = await taskActivationSnapshot(
      created.taskId,
    );
    const inactiveOwnerActivationError = await captureServiceError(
      activateTask(actor(creator), {
        taskId: created.taskId,
        expectedLockVersion: 2,
      }),
    );
    expect(inactiveOwnerActivationError).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "激活 Task 前至少需要一名有效负责人",
      fieldErrors: {
        members: ["激活 Task 前至少需要一名有效负责人"],
      },
    });
    await expect(taskActivationSnapshot(created.taskId)).resolves.toEqual(
      beforeInactiveOwnerActivation,
    );
    await prisma.person.update({
      where: { id: participant.person.id },
      data: { status: "ACTIVE" },
    });
    const activated = await activateTask(actor(creator), {
      taskId: created.taskId,
      expectedLockVersion: 2,
    });
    expect(activated).toMatchObject({ status: "ACTIVE", lockVersion: 3 });

    const activatedCreatorWorkspace = await getTaskWorkspace({
      actor: actor(creator),
      taskId: created.taskId,
    });
    expect(activatedCreatorWorkspace.permissions).toMatchObject({
      canUpdateMetadata: false,
      canManageMembers: false,
      canActivate: false,
      canDeleteDraft: false,
    });
    await expect(
      listTasks({
        actor: actor(creator),
        input: { mine: true, query: input.title },
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      searchTaskOptions({
        actor: actor(creator),
        input: { query: input.title, mine: true, limit: 50 },
      }),
    ).resolves.toMatchObject({ items: [] });
    expect(
      (
        await listMyTaskOptions({
          actor: actor(creator),
          statuses: ["ACTIVE"],
        })
      ).map((task) => task.id),
    ).not.toContain(created.taskId);
    await expect(
      searchTaskOptions({
        actor: actor(creator),
        input: {
          query: input.title,
          projectCandidates: true,
          limit: 50,
        },
      }),
    ).resolves.toMatchObject({ items: [] });
    const activatedCreatorCanvas = await getContentDrivenTimeCanvasData({
      actor: actor(creator),
      input: memberlessDraftCanvasInput(created.taskId),
      load: { mode: "INITIAL" },
    });
    expect(
      activatedCreatorCanvas.data.anchors.find(
        (anchor) => anchor.id === created.taskId,
      ),
    ).toMatchObject({
      capabilities: {
        canUpdateMetadata: false,
        canManageMembers: false,
        canActivate: false,
      },
    });
  });

  test("an inactive Person account keeps historical reads but cannot create a Task", async () => {
    const guardAdmin = await createAccountPerson(
      "生命周期停用人员写保护管理员",
    );
    await grantRole(guardAdmin.account.id, "PROJECT_ADMINISTRATOR");
    const inactiveCreator = await createAccountPerson(
      "生命周期停用人员创建者",
    );
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
    await prisma.person.update({
      where: { id: inactiveCreator.person.id },
      data: { status: "INACTIVE" },
    });
    await expect(getActorPersonOption(actor(inactiveCreator))).resolves.toMatchObject({
      id: inactiveCreator.person.id,
      status: "INACTIVE",
      accountBinding: "BOUND",
    });
    const inactiveActor = await getProjectManagementActorForFeishuUser({
      openId: inactiveCreator.openId,
    });
    const inactiveWorkspace = await getTaskWorkspace({
      actor: inactiveActor,
      taskId: created.taskId,
    });
    expect(inactiveWorkspace).toMatchObject({
      task: { id: created.taskId },
      permissions: {
        canUpdateMetadata: false,
        canManageMembers: false,
        canActivate: false,
        canDeleteDraft: false,
        canCreateRevision: false,
        canSubmitMilestoneReview: false,
        canReviewMilestone: false,
        canSubmitTerminationReview: false,
        canReviewTermination: false,
        canViewHistory: true,
      },
    });
    await expectServiceError(
      createTaskDraft(actor(inactiveCreator), {
        ...input,
        idempotencyKey: `inactive-create-rejected-${randomUUID()}`,
      }),
      "FORBIDDEN",
    );

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

  test("Task activation sets the first active milestone and rejects stale or concurrent activation", { tag: "@smoke" }, async () => {
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

  test("Task activation rejects a future planned start without side effects", async () => {
    const fixture = await createDraftFixture(0);
    const plannedStartAt = new Date(Date.now() + 60 * 60 * 1_000);
    const plannedEndAt = new Date(plannedStartAt.getTime() + 60 * 60 * 1_000);
    const termination = await prisma.terminationNode.findFirstOrThrow({
      where: { node: { taskId: fixture.taskId } },
      select: { id: true },
    });
    await prisma.$transaction([
      prisma.taskPlanVersion.update({
        where: { id: fixture.currentPlanVersionId },
        data: { plannedStartAt },
      }),
      prisma.terminationNode.update({
        where: { id: termination.id },
        data: { plannedAt: plannedEndAt },
      }),
    ]);

    const rejected = await captureServiceError(
      activateTask(actor(fixture.owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
      }),
    );
    expect(rejected).toMatchObject({
      code: "STATE_CONFLICT",
      message: "计划开始时间尚未到达，不能激活 Task",
    });
    await expect(
      prisma.task.findUniqueOrThrow({
        where: { id: fixture.taskId },
        select: {
          status: true,
          lockVersion: true,
          startedAt: true,
          activeMilestoneNodeId: true,
          currentPlanVersion: { select: { activatedAt: true } },
          nodes: { select: { status: true } },
        },
      }),
    ).resolves.toEqual({
      status: "DRAFT",
      lockVersion: 0,
      startedAt: null,
      activeMilestoneNodeId: null,
      currentPlanVersion: { activatedAt: null },
      nodes: [{ status: "PENDING" }],
    });
    await expect(
      prisma.domainAuditEvent.count({
        where: { taskId: fixture.taskId, action: "pm.task.activate" },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.inAppNotification.count({
        where: { eventKey: { startsWith: `pm:task:activated:${fixture.taskId}:` } },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationOutbox.count({
        where: { eventKey: { startsWith: `pm:task:activated:${fixture.taskId}:` } },
      }),
    ).resolves.toBe(0);
  });

  test("only an Owner or global administrator can soft-delete an unactivated Task draft", async () => {
    const fixture = await createDraftFixture();

    await expectServiceError(
      deleteTaskDraft(actor(fixture.member), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
      }),
      "FORBIDDEN",
    );
    await expectServiceError(
      deleteTaskDraft(actor(fixture.owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 1,
      }),
      "STALE_TASK",
    );
    await expect(
      prisma.task.findUniqueOrThrow({
        where: { id: fixture.taskId },
        select: { deletedAt: true, lockVersion: true },
      }),
    ).resolves.toEqual({ deletedAt: null, lockVersion: 0 });
    await expect(
      prisma.domainAuditEvent.count({
        where: { taskId: fixture.taskId, action: "pm.task.draft.delete" },
      }),
    ).resolves.toBe(0);

    const deleted = await deleteTaskDraft(actor(fixture.owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 0,
    });
    expect(deleted).toMatchObject({ taskId: fixture.taskId, lockVersion: 1 });
    expect(Number.isNaN(Date.parse(deleted.deletedAt))).toBe(false);
    await expect(
      prisma.task.findUniqueOrThrow({
        where: { id: fixture.taskId },
        select: { deletedAt: true, lockVersion: true },
      }),
    ).resolves.toEqual({
      deletedAt: new Date(deleted.deletedAt),
      lockVersion: 1,
    });
    await expectServiceError(
      getTaskWorkspace({ actor: actor(fixture.owner), taskId: fixture.taskId }),
      "NOT_FOUND",
    );
    await expect(
      prisma.domainAuditEvent.count({
        where: { taskId: fixture.taskId, action: "pm.task.draft.delete" },
      }),
    ).resolves.toBe(1);
    const deletedPayload = await expectProjectManagementOutbox(
      `pm:task:deleted:${fixture.taskId}:1:feishu`,
      {
        type: "task_deleted",
        botKind: "notification",
        purpose: "notification",
      },
    );
    expect(deletedPayload.linkPath).toBe("/progress/tasks");
    await expectNotificationLinkPath(
      `pm:task:deleted:${fixture.taskId}:1:inapp:`,
      "/progress/tasks",
    );
    const notificationCenter = await listInAppNotifications({
      actor: actor(fixture.owner),
      input: { category: "TASK", limit: 100 },
    });
    expect(
      notificationCenter.items.find(
        (notification) =>
          notification.eventKey ===
          `pm:task:deleted:${fixture.taskId}:1:inapp:${fixture.owner.account.id}`,
      ),
    ).toMatchObject({
      taskId: fixture.taskId,
      taskTitle: null,
      linkPath: "/progress/tasks",
      entityAvailable: true,
    });
    expect(deletedPayload.recipientOpenIds).toEqual(
      expect.arrayContaining([
        fixture.owner.openId,
        fixture.member.openId,
        fixture.reviewer.openId,
      ]),
    );

    const activeFixture = await createDraftFixture();
    const activated = await activateTask(actor(activeFixture.owner), {
      taskId: activeFixture.taskId,
      expectedLockVersion: 0,
    });
    await expectServiceError(
      deleteTaskDraft(actor(activeFixture.admin), {
        taskId: activeFixture.taskId,
        expectedLockVersion: activated.lockVersion,
      }),
      "STATE_CONFLICT",
    );
    await expect(
      prisma.task.findUniqueOrThrow({
        where: { id: activeFixture.taskId },
        select: { status: true, deletedAt: true },
      }),
    ).resolves.toEqual({ status: "ACTIVE", deletedAt: null });
  });

  test("Task can activate directly into a named Terminal without Milestones", async () => {
    const fixture = await createDraftFixture(0, "最终验收");
    const terminalBeforeActivation = await prisma.terminationNode.findFirstOrThrow({
      where: { node: { taskId: fixture.taskId } },
      select: { nodeId: true, name: true, plannedAt: true },
    });
    expect(terminalBeforeActivation.name).toBe("最终验收");

    const activated = await activateTask(actor(fixture.owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 0,
    });
    expect(activated).toMatchObject({
      status: "ACTIVE",
      lockVersion: 1,
      activeMilestoneNodeId: null,
    });
    await expect(
      prisma.taskNode.findUniqueOrThrow({
        where: { id: terminalBeforeActivation.nodeId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "ACTIVE" });

    const workspace = await getTaskWorkspace({
      actor: actor(fixture.owner),
      taskId: fixture.taskId,
    });
    expect(workspace.currentPlan.nodes).toHaveLength(1);
    expect(workspace.currentPlan.nodes[0]?.termination).toMatchObject({
      name: "最终验收",
      plannedAt: terminalBeforeActivation.plannedAt.toISOString(),
    });
    const taskList = await listTasks({
      actor: actor(fixture.owner),
      input: { status: "ACTIVE", mine: true },
    });
    expect(
      taskList.items.find((task) => task.id === fixture.taskId)?.activeTermination,
    ).toEqual({
      nodeId: terminalBeforeActivation.nodeId,
      name: "最终验收",
      plannedAt: terminalBeforeActivation.plannedAt.toISOString(),
    });
    const activationOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: {
        eventKey: `pm:task:activated:${fixture.taskId}:1:feishu`,
      },
    });
    expect(
      String(jsonRecord(JSON.parse(activationOutbox.payload)).summary),
    ).toContain("最终验收");
    expect(jsonRecord(JSON.parse(activationOutbox.payload)).linkPath).toBe(
      `/progress/tasks/${fixture.taskId}`,
    );

    const terminated = await confirmTermination(actor(fixture.owner), {
      taskId: fixture.taskId,
      terminationNodeId: terminalBeforeActivation.nodeId,
      outcome: "SUCCESS",
      reason: "",
      summary: "零 Milestone Task 已完成",
      expectedLockVersion: 1,
    });
    expect(terminated).toMatchObject({
      status: "COMPLETED",
      activeMilestoneNodeId: null,
      outcome: "SUCCESS",
    });
    const terminationOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: {
        eventKey: `pm:task:terminated:${terminalBeforeActivation.nodeId}:feishu`,
      },
    });
    expect(
      String(jsonRecord(JSON.parse(terminationOutbox.payload)).summary),
    ).toContain("最终验收");
  });

  test("legacy Active Current Plans over 200 Milestones remain terminable", async () => {
    const fixture = await createActivatedFixture(200);
    const currentNodes = await currentPlanNodes(fixture.taskId);
    const terminationEntry = currentNodes.find(
      (entry) => entry.node.type === "TERMINATION",
    );
    if (!terminationEntry) throw new Error("测试计划缺少 Terminal");
    const legacyMilestoneNodeId = randomUUID();

    await prisma.$transaction(async (tx) => {
      await tx.planVersionNode.update({
        where: { id: terminationEntry.id },
        data: { sequence: 202 },
      });
      await tx.taskNode.create({
        data: {
          id: legacyMilestoneNodeId,
          taskId: fixture.taskId,
          type: "MILESTONE",
          status: "PENDING",
          businessDescription: "模拟旧版 Revision 合并产生的第 201 个节点",
          createdByAccountId: fixture.admin.account.id,
          milestone: {
            create: {
              goal: "历史节点 201",
              completionCriteria: "历史兼容",
              expectedCompletedAt: new Date(Date.UTC(2026, 7, 201, 10, 0, 0)),
              reviewRequirements: "不阻断历史计划结束",
            },
          },
        },
      });
      await tx.planVersionNode.create({
        data: {
          planVersionId: fixture.currentPlanVersionId,
          nodeId: legacyMilestoneNodeId,
          sequence: 201,
        },
      });
    });

    const terminated = await confirmTermination(actor(fixture.owner), {
      taskId: fixture.taskId,
      terminationNodeId: terminationEntry.nodeId,
      outcome: "CANCELLED",
      reason: "验证历史超限计划兼容",
      summary: "历史计划仍可正常结束",
      expectedLockVersion: 1,
    });
    expect(terminated).toMatchObject({
      status: "CANCELLED",
      outcome: "CANCELLED",
    });
    await expect(
      prisma.taskNode.findUniqueOrThrow({
        where: { id: legacyMilestoneNodeId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "CANCELLED" });
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
      linkPath: `/progress/tasks/${fixture.taskId}`,
      context: { taskStatus: "ACTIVE" },
    });
    expect(inApp.linkPath).toBe(`/progress/tasks/${fixture.taskId}`);
    const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey: `${eventKey}:feishu` },
    });
    const payload = jsonRecord(JSON.parse(outbox.payload));
    expect(payload).toMatchObject({
      linkPath: `/progress/tasks/${fixture.taskId}`,
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
    await expectServiceError(
      submitMilestoneForReview(actor(fixture.member), {
        milestoneNodeId: activeNode.nodeId,
        idempotencyKey: `review-duplicate-${randomUUID()}`,
        evidences: [{ kind: "TEXT", note: "重复提交待处理验收" }],
      }),
      "STATE_CONFLICT",
    );
    const reviewSubmittedPayload = await expectProjectManagementOutbox(
      `pm:milestone:review_submitted:${submitted.reviewId}:feishu`,
      {
        type: "milestone_review_submitted",
        botKind: "approval",
        purpose: "approval_request",
      },
    );
    expect(reviewSubmittedPayload.payloadVersion).toBe(1);
    expect(reviewSubmittedPayload.linkPath).toBe(
      `/progress/tasks/${fixture.taskId}`,
    );
    await expectNotificationLinkPath(
      `pm:milestone:review_submitted:${submitted.reviewId}:inapp:`,
      `/progress/tasks/${fixture.taskId}`,
    );
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
    });
    expect(approved.result).toBe("APPROVED");
    expect(approved.activeMilestoneNodeId).not.toBe(activeNode.nodeId);
    const advancedNodes = await currentPlanNodes(fixture.taskId);
    expect(advancedNodes[0]?.node.status).toBe("COMPLETED");
    expect(advancedNodes[1]?.node.status).toBe("ACTIVE");
    const secondMilestoneNodeId = advancedNodes[1]?.nodeId;
    if (!secondMilestoneNodeId) {
      throw new Error("测试计划缺少第二个 Milestone");
    }
    await expectServiceError(
      getMilestoneCompletionDetails({
        actor: actor(fixture.member),
        taskId: fixture.taskId,
        nodeId: secondMilestoneNodeId,
      }),
      "NOT_FOUND",
    );
    const otherTask = await createTaskDraft(
      actor(fixture.admin),
      taskDraftInput({
        ownerPersonId: fixture.owner.person.id,
        memberPersonId: fixture.member.person.id,
        reviewerPersonId: fixture.reviewer.person.id,
        idempotencyKey: `completion-details-other-task-${randomUUID()}`,
        milestoneCount: 1,
      }),
    );
    await expectServiceError(
      getMilestoneCompletionDetails({
        actor: actor(fixture.member),
        taskId: otherTask.taskId,
        nodeId: activeNode.nodeId,
      }),
      "NOT_FOUND",
    );
    const [
      persistedMilestone,
      completedWorkspace,
      completionDetails,
      historicalPlan,
    ] =
      await Promise.all([
        prisma.milestoneNode.findUniqueOrThrow({
          where: { nodeId: activeNode.nodeId },
          select: { completedAt: true },
        }),
        getTaskWorkspace({
          actor: actor(fixture.member),
          taskId: fixture.taskId,
        }),
        getMilestoneCompletionDetails({
          actor: actor(fixture.member),
          taskId: fixture.taskId,
          nodeId: activeNode.nodeId,
        }),
        getPlanVersion({
          actor: actor(fixture.member),
          planVersionId: fixture.currentPlanVersionId,
        }),
      ]);
    const completedMilestone = completedWorkspace.currentPlan.nodes.find(
      (node) => node.nodeId === activeNode.nodeId,
    )?.milestone;
    expect(persistedMilestone.completedAt).not.toBeNull();
    expect(completionDetails.completedAt).toBe(
      persistedMilestone.completedAt?.toISOString(),
    );
    expect(completionDetails.evidences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "TEXT",
          note: "已完成联调",
          externalUrl: null,
        }),
        expect.objectContaining({
          kind: "LINK",
          note: "",
          externalUrl: "https://example.com/evidence",
        }),
      ]),
    );
    expect(completionDetails.evidences).toHaveLength(2);
    expect(completedMilestone).not.toBeNull();
    expect(completedMilestone && "completionEvidences" in completedMilestone).toBe(
      false,
    );
    const historicalMilestone = historicalPlan.nodes.find(
      (node) => node.nodeId === activeNode.nodeId,
    )?.milestone;
    expect(historicalMilestone).not.toBeNull();
    expect(
      historicalMilestone && "completionEvidences" in historicalMilestone,
    ).toBe(false);
    await expectProjectManagementOutbox(
      `pm:milestone:review_result:${submitted.reviewId}:APPROVED:feishu`,
      {
        type: "milestone_review_result",
        botKind: "notification",
        purpose: "notification",
      },
    );
    const approvedNotification = await prisma.notificationOutbox.findUniqueOrThrow({
      where: {
        eventKey: `pm:milestone:review_result:${submitted.reviewId}:APPROVED:feishu`,
      },
      select: { payload: true },
    });
    expect(JSON.parse(approvedNotification.payload)).toMatchObject({
      summary: "验收结果：已通过",
      context: { summarySource: "SYSTEM_DEFAULT" },
    });
    await expect(
      submitMilestoneForReview(actor(fixture.member), {
        milestoneNodeId: activeNode.nodeId,
        idempotencyKey: reviewIdempotencyKey,
        evidences: [{ kind: "TEXT", note: "审批通过后的原请求键重放" }],
      }),
    ).resolves.toMatchObject({
      created: false,
      reviewId: submitted.reviewId,
      result: "APPROVED",
    });

    const secondReviewKey = `review-reject-${randomUUID()}`;
    const secondReview = await submitMilestoneForReview(actor(fixture.member), {
      milestoneNodeId: secondMilestoneNodeId,
      idempotencyKey: secondReviewKey,
      evidences: [{ kind: "TEXT", note: "第二阶段证据" }],
    });
    const rejected = await reviewMilestone(actor(fixture.reviewer), {
      reviewId: secondReview.reviewId,
      result: "REJECTED",
      comment: "还需要补充数据",
    });
    expect(rejected.activeMilestoneNodeId).toBe(secondMilestoneNodeId);
    expect((await currentPlanNodes(fixture.taskId))[1]?.node.status).toBe("ACTIVE");
    await expect(
      submitMilestoneForReview(actor(fixture.member), {
        milestoneNodeId: secondMilestoneNodeId,
        idempotencyKey: secondReviewKey,
        evidences: [{ kind: "TEXT", note: "终态记录的原请求键重放" }],
      }),
    ).resolves.toMatchObject({
      created: false,
      reviewId: secondReview.reviewId,
      result: "REJECTED",
    });
    expect(
      await prisma.milestoneReview.count({
        where: { milestoneNodeId: advancedNodes[1]?.node.milestone?.id },
      }),
    ).toBe(1);

    const finalReview = await submitMilestoneForReview(actor(fixture.member), {
      milestoneNodeId: secondMilestoneNodeId,
      idempotencyKey: `review-final-${randomUUID()}`,
      evidences: [
        {
          kind: "LINK",
          externalUrl: "https://example.com/final-second",
          sortOrder: 2,
        },
        { kind: "TEXT", note: "最终第二阶段证据", sortOrder: 1 },
      ],
    });
    await reviewMilestone(actor(fixture.reviewer), {
      reviewId: finalReview.reviewId,
      result: "APPROVED",
    });
    const finalDetails = await getMilestoneCompletionDetails({
      actor: actor(fixture.member),
      taskId: fixture.taskId,
      nodeId: secondMilestoneNodeId,
    });
    expect(
      finalDetails.evidences.map(({ kind, note, externalUrl }) => ({
        kind,
        note,
        externalUrl,
      })),
    ).toEqual([
      { kind: "TEXT", note: "最终第二阶段证据", externalUrl: null },
      {
        kind: "LINK",
        note: "",
        externalUrl: "https://example.com/final-second",
      },
    ]);
    expect(
      finalDetails.evidences.some((evidence) => evidence.note === "第二阶段证据"),
    ).toBe(false);
  });

  test("Task permits only one pending Milestone or Revision and blocks Termination until it is released", async () => {
    const fixture = await createActivatedFixture();
    const activeNode = await firstCurrentMilestone(fixture.taskId);
    const terminalNode = (await currentPlanNodes(fixture.taskId)).at(-1);
    if (!terminalNode?.node.termination) throw new Error("测试计划缺少 Terminal");
    const milestoneReview = await submitMilestoneForReview(actor(fixture.member), {
      milestoneNodeId: activeNode.nodeId,
      idempotencyKey: `single-gate-review-${randomUUID()}`,
      evidences: [{ kind: "TEXT", note: "先占用审批门禁" }],
    });
    const revisionInput = {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: fixture.lockVersion,
      reason: "单一审批门禁 Revision",
      description: "单一审批门禁 Revision 详细内容",
      revisionAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
      replacementMilestones: [
        milestoneInput("门禁后的 Revision Milestone", "Revision 条件", 4),
      ],
      termination: terminationInput(8),
      idempotencyKey: `single-gate-revision-${randomUUID()}`,
    };

    await expectServiceError(
      createRevision(actor(fixture.owner), revisionInput),
      "STATE_CONFLICT",
    );
    await expectServiceError(
      confirmTermination(actor(fixture.owner), {
        taskId: fixture.taskId,
        terminationNodeId: terminalNode.nodeId,
        outcome: "FAILED",
        reason: "审批期间不得结束",
        summary: "应被门禁阻止",
        expectedLockVersion: fixture.lockVersion,
      }),
      "STATE_CONFLICT",
    );
    expect(
      await prisma.revisionNode.count({ where: { node: { taskId: fixture.taskId } } }),
    ).toBe(0);

    await reviewMilestone(actor(fixture.reviewer), {
      reviewId: milestoneReview.reviewId,
      result: "REJECTED",
      comment: "释放门禁以发起 Revision",
    });
    const revision = await createRevision(actor(fixture.owner), revisionInput);
    expect(revision.status).toBe("PENDING_APPROVAL");

    await expectServiceError(
      submitMilestoneForReview(actor(fixture.member), {
        milestoneNodeId: activeNode.nodeId,
        idempotencyKey: `single-gate-review-blocked-${randomUUID()}`,
        evidences: [{ kind: "TEXT", note: "Revision 期间不得提交" }],
      }),
      "STATE_CONFLICT",
    );
    await expectServiceError(
      confirmTermination(actor(fixture.owner), {
        taskId: fixture.taskId,
        terminationNodeId: terminalNode.nodeId,
        outcome: "FAILED",
        reason: "Revision 期间不得结束",
        summary: "应被门禁阻止",
        expectedLockVersion: fixture.lockVersion,
      }),
      "STATE_CONFLICT",
    );

    await rejectRevision(actor(fixture.reviewer), {
      revisionNodeId: revision.revisionNodeId,
      comment: "释放门禁以重新提交 Milestone",
    });
    const secondMilestoneReview = await submitMilestoneForReview(
      actor(fixture.member),
      {
        milestoneNodeId: activeNode.nodeId,
        idempotencyKey: `single-gate-review-after-revision-${randomUUID()}`,
        evidences: [{ kind: "TEXT", note: "Revision 驳回后可提交" }],
      },
    );
    expect(secondMilestoneReview.created).toBe(true);
    const targetPlan = await prisma.taskPlanVersion.findUniqueOrThrow({
      where: { id: revision.targetPlanVersionId ?? "" },
      select: { updatedAt: true },
    });
    await expectServiceError(
      reviseRejectedRevision(actor(fixture.owner), {
        revisionNodeId: revision.revisionNodeId,
        expectedTargetPlanUpdatedAt: targetPlan.updatedAt.toISOString(),
        reason: "Milestone 待审批时不能重新送审",
        description: "Milestone 待审批时不能重新送审",
        revisionAt: revisionInput.revisionAt,
        replacementMilestones: revisionInput.replacementMilestones,
        termination: revisionInput.termination,
      }),
      "STATE_CONFLICT",
    );
    expect(
      await prisma.domainAuditEvent.count({
        where: { taskId: fixture.taskId, action: "pm.revision.resubmit" },
      }),
    ).toBe(0);
  });

  test("concurrent Milestone, Revision and Terminal operations allow exactly one winner", async () => {
    const fixture = await createActivatedFixture();
    const activeNode = await firstCurrentMilestone(fixture.taskId);
    const terminalNode = (await currentPlanNodes(fixture.taskId)).at(-1);
    if (!terminalNode?.node.termination)
      throw new Error("测试计划缺少 Terminal");
    const outcomes = await Promise.allSettled([
      submitMilestoneForReview(actor(fixture.member), {
        milestoneNodeId: activeNode.nodeId,
        idempotencyKey: `single-gate-race-review-${randomUUID()}`,
        evidences: [{ kind: "TEXT", note: "并发 Milestone" }],
      }),
      createRevision(actor(fixture.owner), {
        taskId: fixture.taskId,
        basePlanVersionId: fixture.currentPlanVersionId,
        baseTaskLockVersion: fixture.lockVersion,
        reason: "并发 Revision",
        description: "并发 Revision",
        revisionAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
        replacementMilestones: [
          milestoneInput("并发 Revision Milestone", "并发条件", 4),
        ],
        termination: terminationInput(8),
        idempotencyKey: `single-gate-race-revision-${randomUUID()}`,
      }),
      submitTerminationForReview(actor(fixture.owner), {
        terminationNodeId: terminalNode.nodeId,
        outcome: "FAILED",
        reason: "并发 Terminal",
        summary: "只能有一个事务成功",
        idempotencyKey: `single-gate-race-termination-${randomUUID()}`,
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(2);
    const [pendingMilestones, pendingRevisions, pendingTerminations] =
      await Promise.all([
        prisma.milestoneReview.count({
          where: {
            result: "PENDING",
            revokedAt: null,
            milestoneNode: { node: { taskId: fixture.taskId } },
          },
        }),
        prisma.revisionNode.count({
          where: {
            status: "PENDING_APPROVAL",
            node: { taskId: fixture.taskId },
          },
        }),
        prisma.terminationReview.count({
          where: {
            result: "PENDING",
            terminationNode: { node: { taskId: fixture.taskId } },
          },
        }),
      ]);
    expect(pendingMilestones + pendingRevisions + pendingTerminations).toBe(1);
    await expect(
      prisma.task.findUniqueOrThrow({
        where: { id: fixture.taskId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "ACTIVE" });
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          taskId: fixture.taskId,
          action: {
            in: [
              "pm.milestone.review.submit",
              "pm.revision.create",
              "pm.termination.review.submit",
            ],
          },
        },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          channel: "project-management",
          type: {
            in: [
              "milestone_review_submitted",
              "revision_pending_review",
              "termination_review_submitted",
            ],
          },
          payload: { contains: fixture.taskId },
        },
      }),
    ).toBe(1);
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
      (
        entry,
      ): entry is PromiseFulfilledResult<
        Awaited<ReturnType<typeof reviewMilestone>>
      > => entry.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(1);
    expect(
      decisions.filter((entry) => entry.status === "rejected"),
    ).toHaveLength(1);
    const persistedReview = await prisma.milestoneReview.findUniqueOrThrow({
      where: { id: submitted.reviewId },
      select: { result: true },
    });
    expect(persistedReview.result).toBe(fulfilled[0]?.value.result);
  });

  test("Revision create, reject and cancel preserve the current plan", async () => {
    const fixture = await createActivatedFixture();
    const activeNode = await firstCurrentMilestone(fixture.taskId);
    const revision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      reason: "计划需要调整",
      description: "计划需要调整",
      replacementMilestones: [
        milestoneInput("调整后 Milestone", "完成新目标", 4),
      ],
      revisionAt: new Date(
        Date.UTC(2026, 6, 31, 10, 0, 0),
      ).toISOString(),
      termination: terminationInput(8),
      idempotencyKey: `revision-reject-${randomUUID()}`,
    });
    expect(revision).toMatchObject({
      created: true,
      status: "PENDING_APPROVAL",
    });
    const pendingApprovalOutbox =
      await prisma.notificationOutbox.findUniqueOrThrow({
        where: {
          eventKey: `pm:revision:pending_review:${revision.revisionNodeId}:round:1:feishu`,
        },
      });
    const sentApprovalRecipient =
      await prisma.notificationOutboxRecipient.create({
        data: {
          outboxId: pendingApprovalOutbox.id,
          openId: fixture.reviewer.openId,
          status: "SENT",
          attempts: 1,
          sentAt: new Date(),
        },
      });
    const failedApprovalRecipient =
      await prisma.notificationOutboxRecipient.create({
        data: {
          outboxId: pendingApprovalOutbox.id,
          openId: fixture.admin.openId,
          status: "FAILED",
          attempts: 1,
          lastError: "等待重试",
        },
      });
    await prisma.notificationOutbox.update({
      where: { id: pendingApprovalOutbox.id },
      data: { status: "FAILED", attempts: 1, lastError: "等待重试" },
    });
    await expect(
      prisma.$executeRaw`
        UPDATE "RevisionNode"
        SET "baseTaskLockVersion" = -1
        WHERE "id" = ${revision.revisionNodeId}
      `,
    ).rejects.toThrow();

    expect(revision.status).toBe("PENDING_APPROVAL");

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
    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({
        where: { id: pendingApprovalOutbox.id },
        select: { status: true, lastError: true },
      }),
    ).resolves.toMatchObject({
      status: "CANCELED",
      lastError: expect.stringContaining("原审批请求不再有效"),
    });
    const staleApprovalPlan =
      await projectManagementNotificationChannel.resolveRecipientPlan(
        await prisma.notificationOutbox.findUniqueOrThrow({
          where: { id: pendingApprovalOutbox.id },
        }),
      );
    expect(staleApprovalPlan).toMatchObject({
      supported: true,
      openIds: [],
      cancelReason: expect.stringContaining("不再等待审批"),
    });
    await expect(
      prisma.notificationOutboxRecipient.findUniqueOrThrow({
        where: { id: sentApprovalRecipient.id },
        select: { status: true, sentAt: true },
      }),
    ).resolves.toMatchObject({ status: "SENT", sentAt: expect.any(Date) });
    await expect(
      prisma.notificationOutboxRecipient.findUniqueOrThrow({
        where: { id: failedApprovalRecipient.id },
        select: { status: true, lastError: true },
      }),
    ).resolves.toMatchObject({
      status: "CANCELED",
      lastError: expect.stringContaining("原审批请求不再有效"),
    });
    expect(
      await prisma.inAppNotification.count({
        where: {
          entityId: revision.revisionNodeId,
          readAt: null,
          payload: {
            path: ["kind"],
            equals: "revision_pending_review",
          },
        },
      }),
    ).toBe(0);
    const cancelledPayload = await expectProjectManagementOutbox(
      `pm:revision:cancelled:${revision.revisionNodeId}:round:1:feishu`,
      {
        type: "revision_cancelled",
        botKind: "notification",
        purpose: "notification",
      },
    );
    expect(cancelledPayload).toMatchObject({
      mandatory: true,
      taskId: fixture.taskId,
      linkPath: `/progress/tasks/${fixture.taskId}`,
      context: {
        revisionName: "计划需要调整",
        round: 1,
        beforeStatus: "REJECTED",
        afterStatus: "CANCELLED",
        cancelReason: "重新整理后再提交",
      },
    });
    expect(new Set(jsonStringArray(cancelledPayload.recipientOpenIds))).toEqual(
      new Set([
        fixture.owner.openId,
        ...(await activeGlobalAdministratorOpenIds()),
      ]),
    );
    const repeated = await cancelRevision(actor(fixture.owner), {
      revisionNodeId: revision.revisionNodeId,
      comment: "重复取消不得再次发送",
    });
    expect(repeated.status).toBe("CANCELLED");
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: `pm:revision:cancelled:${revision.revisionNodeId}:round:1:feishu`,
        },
      }),
    ).toBe(1);
  });

  test("Pending Revision cancellation notifies stakeholders and retires the approval request", async () => {
    const fixture = await createActivatedFixture();
    const revision = await createRevision(actor(fixture.member), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      reason: "取消仍待审批的计划",
      description: "验证取消审批消息不会继续重试",
      replacementMilestones: [
        milestoneInput("取消候选 Milestone", "无需继续审批", 4),
      ],
      revisionAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
      termination: terminationInput(8),
      idempotencyKey: `revision-cancel-pending-${randomUUID()}`,
    });

    const result = await cancelRevision(actor(fixture.member), {
      revisionNodeId: revision.revisionNodeId,
      comment: "需求已经撤回",
    });
    expect(result.status).toBe("CANCELLED");
    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({
        where: {
          eventKey: `pm:revision:pending_review:${revision.revisionNodeId}:round:1:feishu`,
        },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "CANCELED" });
    const payload = await expectProjectManagementOutbox(
      `pm:revision:cancelled:${revision.revisionNodeId}:round:1:feishu`,
      {
        type: "revision_cancelled",
        botKind: "notification",
        purpose: "notification",
      },
    );
    expect(payload.context).toMatchObject({
      beforeStatus: "PENDING_APPROVAL",
      afterStatus: "CANCELLED",
      cancelReason: "需求已经撤回",
    });
    expect(new Set(jsonStringArray(payload.recipientOpenIds))).toEqual(
      new Set([
        fixture.member.openId,
        fixture.owner.openId,
        ...(await activeGlobalAdministratorOpenIds()),
      ]),
    );
  });

  test("Revision cancellation keeps the worker parent-recipient lock order", async () => {
    const fixture = await createActivatedFixture();
    const revision = await createRevision(actor(fixture.member), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      reason: "验证取消通知锁顺序",
      description: "处理中审批与取消并发时不得死锁",
      replacementMilestones: [
        milestoneInput("并发取消 Milestone", "取消后不再审批", 4),
      ],
      revisionAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
      termination: terminationInput(8),
      idempotencyKey: `revision-cancel-lock-order-${randomUUID()}`,
    });
    const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: {
        eventKey: `pm:revision:pending_review:${revision.revisionNodeId}:round:1:feishu`,
      },
    });
    const lockedUntil = new Date(Date.now() + 60_000);
    const recipient = await prisma.notificationOutboxRecipient.create({
      data: {
        outboxId: outbox.id,
        openId: fixture.admin.openId,
        status: "PROCESSING",
        attempts: 1,
        lockedUntil,
      },
    });
    await prisma.notificationOutbox.update({
      where: { id: outbox.id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        lockedUntil,
      },
    });

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString || !new URL(connectionString).pathname.endsWith("_test")) {
      throw new Error("Revision 锁顺序测试只允许 runner 持有的 _test 数据库");
    }
    const locker = new Client({
      connectionString,
      application_name: "revision-cancel-lock-order-locker",
    });
    const observer = new Client({
      connectionString,
      application_name: "revision-cancel-lock-order-observer",
    });
    let transactionOpen = false;
    let cancellationSettlement:
      | Promise<
          | { status: "fulfilled"; value: Awaited<ReturnType<typeof cancelRevision>> }
          | { status: "rejected"; reason: unknown }
        >
      | null = null;
    try {
      await Promise.all([locker.connect(), observer.connect()]);
      await locker.query("BEGIN");
      transactionOpen = true;
      await locker.query("SET LOCAL lock_timeout = '3s'");
      await locker.query("SET LOCAL statement_timeout = '5s'");
      const pidResult = await locker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const lockerPid = pidResult.rows[0]?.pid;
      if (!lockerPid) throw new Error("无法取得通知锁顺序测试 backend pid");
      await locker.query(
        'SELECT "id" FROM "NotificationOutbox" WHERE "id" = $1 FOR UPDATE',
        [outbox.id],
      );

      cancellationSettlement = cancelRevision(actor(fixture.member), {
        revisionNodeId: revision.revisionNodeId,
        comment: "并发取消锁顺序验证",
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      await waitForDirectBlockers(observer, lockerPid, 1);

      await expect(
        locker.query(
          'SELECT "id" FROM "NotificationOutboxRecipient" WHERE "id" = $1 FOR UPDATE',
          [recipient.id],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await locker.query("COMMIT");
      transactionOpen = false;

      const cancellation = await cancellationSettlement;
      if (cancellation.status === "rejected") throw cancellation.reason;
      expect(cancellation.value.status).toBe("CANCELLED");
    } finally {
      if (transactionOpen) await locker.query("ROLLBACK").catch(() => undefined);
      if (cancellationSettlement) await cancellationSettlement;
      await Promise.allSettled([locker.end(), observer.end()]);
    }

    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({
        where: { id: outbox.id },
        select: { status: true, lockedUntil: true },
      }),
    ).resolves.toEqual({ status: "CANCELED", lockedUntil: null });
    await expect(
      prisma.notificationOutboxRecipient.findUniqueOrThrow({
        where: { id: recipient.id },
        select: { status: true, lockedUntil: true },
      }),
    ).resolves.toEqual({ status: "CANCELED", lockedUntil: null });
  });

  test("Rejected Revision resubmit enforces ownership, stale and association safety with auditable atomic updates", async () => {
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
    const revision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      reason: "Revision 重新送审初始计划",
      description: "Revision 重新送审初始计划的详细内容",
      replacementMilestones: [milestoneInput("候选节点 A", "候选条件 A", 4)],
      revisionAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
      termination: terminationInput(8),
      idempotencyKey: `revision-update-${randomUUID()}`,
    });
    await expect(
      getRevisionComposerRecord({
        actor: actor(fixture.owner),
        taskId: fixture.taskId,
        revisionNodeId: revision.revisionNodeId,
      }),
    ).resolves.toMatchObject({
      reason: "Revision 重新送审初始计划",
      description: "Revision 重新送审初始计划的详细内容",
    });
    const targetPlanVersionId = revision.targetPlanVersionId ?? "";
    await rejectRevision(actor(fixture.reviewer), {
      revisionNodeId: revision.revisionNodeId,
      comment: "请修改后重提",
    });
    let targetBefore = await revisionTargetSnapshot(targetPlanVersionId);
    const validUpdate = {
      revisionNodeId: revision.revisionNodeId,
      expectedTargetPlanUpdatedAt: targetBefore.updatedAt.toISOString(),
      reason: "Revision 重新送审已编辑",
      description: "Revision 重新送审已编辑后的详细内容",
      revisionAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
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

    await prisma.taskPlanVersion.update({
      where: { id: targetPlanVersionId },
      data: { plannedStartAt: new Date("2026-07-30T10:00:00.000Z") },
    });
    const targetWithChangedStart = await revisionTargetSnapshot(
      targetPlanVersionId,
    );
    await expectServiceError(
      reviseRejectedRevision(actor(fixture.owner), {
        ...validUpdate,
        expectedTargetPlanUpdatedAt:
          targetWithChangedStart.updatedAt.toISOString(),
      }),
      "PLAN_VERSION_CONFLICT",
    );
    expect(
      await prisma.revisionNode.findUniqueOrThrow({
        where: { id: revision.revisionNodeId },
        select: { status: true, reviewRound: true },
      }),
    ).toEqual({ status: "REJECTED", reviewRound: 1 });
    await prisma.taskPlanVersion.update({
      where: { id: targetPlanVersionId },
      data: { plannedStartAt: new Date("2026-07-31T10:00:00.000Z") },
    });
    targetBefore = await revisionTargetSnapshot(targetPlanVersionId);
    validUpdate.expectedTargetPlanUpdatedAt = targetBefore.updatedAt.toISOString();

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
      reviseRejectedRevision(actor(lead), validUpdate),
      "FORBIDDEN",
    );
    expect(await revisionTargetSnapshot(targetPlanVersionId)).toEqual(targetBefore);

    await expectServiceError(
      reviseRejectedRevision(actor(fixture.owner), {
        ...validUpdate,
        expectedTargetPlanUpdatedAt: new Date(0).toISOString(),
      }),
      "PLAN_VERSION_CONFLICT",
    );
    expect(await revisionTargetSnapshot(targetPlanVersionId)).toEqual(targetBefore);

    await expectServiceError(
      reviseRejectedRevision(actor(fixture.owner), {
        ...validUpdate,
        termination: {
          ...validUpdate.termination,
          plannedAt: validUpdate.revisionAt,
        },
      }),
      "PLAN_CHRONOLOGY_INVALID",
    );
    expect(await revisionTargetSnapshot(targetPlanVersionId)).toEqual(targetBefore);

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
        reviseRejectedRevision(actor(fixture.owner), {
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

    const updated = await reviseRejectedRevision(actor(fixture.owner), validUpdate);
    expect(updated.status).toBe("PENDING_APPROVAL");
    const resubmittedPayload = await expectProjectManagementOutbox(
      `pm:revision:pending_review:${revision.revisionNodeId}:round:2:feishu`,
      {
        type: "revision_pending_review",
        botKind: "approval",
        purpose: "approval_request",
      },
    );
    expect(resubmittedPayload.title).toBe("计划修订已重新提交审批");
    const previousRoundOutbox =
      await prisma.notificationOutbox.findUniqueOrThrow({
        where: {
          eventKey: `pm:revision:pending_review:${revision.revisionNodeId}:round:1:feishu`,
        },
      });
    await expect(
      projectManagementNotificationChannel.resolveRecipientPlan(
        previousRoundOutbox,
      ),
    ).resolves.toMatchObject({
      supported: true,
      openIds: [],
      cancelReason: expect.stringContaining("审批轮次已更新"),
    });
    await expect(
      getTaskLifecycleViews({
        actor: actor(fixture.owner),
        taskId: fixture.taskId,
      }),
    ).resolves.toMatchObject({
      revisions: [
        {
          reason: "Revision 重新送审已编辑",
          description: "Revision 重新送审已编辑后的详细内容",
        },
      ],
    });
    await expect(
      prisma.revisionNode.findUniqueOrThrow({
        where: { id: revision.revisionNodeId },
        select: {
          reviewRound: true,
          reviewedAt: true,
          reviewedByAccountId: true,
          reviewComment: true,
        },
      }),
    ).resolves.toEqual({
      reviewRound: 2,
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
        action: "pm.revision.resubmit",
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
      reviseRejectedRevision(actor(fixture.owner), validUpdate),
      "STATE_CONFLICT",
    );
    await expect(
      prisma.domainAuditEvent.count({
        where: {
          taskId: fixture.taskId,
          entityId: revision.revisionNodeId,
          action: "pm.revision.resubmit",
        },
      }),
    ).resolves.toBe(1);
  });

  test("Revision enforces the 200 Milestone limit after carried nodes are merged", async () => {
    const fixture = await createActivatedFixture(2);
    const activeMilestone = await firstCurrentMilestone(fixture.taskId);
    const review = await submitMilestoneForReview(actor(fixture.owner), {
      milestoneNodeId: activeMilestone.nodeId,
      idempotencyKey: `revision-limit-review-${randomUUID()}`,
      evidences: [{ kind: "TEXT", note: "完成锁定前缀" }],
    });
    await reviewMilestone(actor(fixture.reviewer), {
      reviewId: review.reviewId,
      result: "APPROVED",
      comment: "通过",
    });
    const revisionCountBefore = await prisma.revisionNode.count({
      where: { node: { taskId: fixture.taskId } },
    });
    const baseInput = {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 2,
      reason: "验证合并后的 Milestone 上限",
      description: "验证合并后的 Milestone 上限详细内容",
      revisionAt: new Date(Date.UTC(2026, 7, 2, 10, 0, 0)).toISOString(),
      termination: terminationInput(203),
    };
    const twoHundredReplacementMilestones = Array.from(
      { length: 200 },
      (_, index) => milestoneInput(`候选节点 ${index + 1}`, `候选条件 ${index + 1}`, index + 3),
    );

    await expectServiceError(
      createRevision(actor(fixture.owner), {
        ...baseInput,
        replacementMilestones: twoHundredReplacementMilestones,
        idempotencyKey: `revision-over-limit-${randomUUID()}`,
      }),
      "PLAN_CHRONOLOGY_INVALID",
    );
    expect(
      await prisma.revisionNode.count({
        where: { node: { taskId: fixture.taskId } },
      }),
    ).toBe(revisionCountBefore);

    const validRevision = await createRevision(actor(fixture.owner), {
      ...baseInput,
      replacementMilestones: twoHundredReplacementMilestones.slice(0, 199),
      idempotencyKey: `revision-at-limit-${randomUUID()}`,
    });
    const targetPlanVersionId = validRevision.targetPlanVersionId ?? "";
    expect(
      (await revisionTargetSnapshot(targetPlanVersionId)).nodes.filter(
        (entry) => entry.node.type === "MILESTONE",
      ),
    ).toHaveLength(200);

    await rejectRevision(actor(fixture.reviewer), {
      revisionNodeId: validRevision.revisionNodeId,
      comment: "请调整候选计划",
    });
    const targetBefore = await revisionTargetSnapshot(targetPlanVersionId);

    await expectServiceError(
      reviseRejectedRevision(actor(fixture.owner), {
        revisionNodeId: validRevision.revisionNodeId,
        expectedTargetPlanUpdatedAt: targetBefore.updatedAt.toISOString(),
        reason: "更新后超过 Milestone 上限",
        description: "更新后超过 Milestone 上限",
        revisionAt: baseInput.revisionAt,
        replacementMilestones: twoHundredReplacementMilestones,
        termination: baseInput.termination,
      }),
      "PLAN_CHRONOLOGY_INVALID",
    );
    expect(await revisionTargetSnapshot(targetPlanVersionId)).toEqual(targetBefore);
  });

  test("Revision approval atomically switches Current Plan without rewriting Task-associated segments", async () => {
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
        createdByAccountId: fixture.owner.account.id,
      },
    });

    const revision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      reason: "当前目标变更",
      description: "当前目标变更",
      replacementMilestones: [
        milestoneInput("新的当前 Milestone", "完成替代目标", 5),
      ],
      revisionAt: new Date(
        Date.UTC(2026, 6, 31, 11, 0, 0),
      ).toISOString(),
      termination: terminationInput(9),
      idempotencyKey: `revision-apply-${randomUUID()}`,
    });
    const revisionPendingPayload = await expectProjectManagementOutbox(
      `pm:revision:pending_review:${revision.revisionNodeId}:round:1:feishu`,
      {
        type: "revision_pending_review",
        botKind: "approval",
        purpose: "approval_request",
      },
    );
    expect(revisionPendingPayload.payloadVersion).toBe(1);
    expect(revisionPendingPayload.linkPath).toBe(
      `/progress/tasks/${fixture.taskId}`,
    );
    await expectNotificationLinkPath(
      `pm:revision:pending_review:${revision.revisionNodeId}:round:1:inapp:`,
      `/progress/tasks/${fixture.taskId}`,
    );
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
    const persistedSegments = await prisma.workSegment.findMany({
      where: {
        id: {
          in: [
            planned.id,
            overlappingPlanned.id,
            confirmedPlanned.id,
            cancelledPlanned.id,
          ],
        },
      },
      select: { id: true, status: true, updatedAt: true },
    });
    expect(
      persistedSegments.map((segment) => ({
        id: segment.id,
        status: segment.status,
        updatedAt: segment.updatedAt.toISOString(),
      })),
    ).toEqual(
      expect.arrayContaining(
        [planned, overlappingPlanned, confirmedPlanned, cancelledPlanned].map(
          (segment) => ({
            id: segment.id,
            status: segment.status,
            updatedAt: segment.updatedAt.toISOString(),
          }),
        ),
      ),
    );
    expect(
      await prisma.workSegmentChange.count({
        where: { reason: "Revision 生效后原关联节点失效" },
      }),
    ).toBe(0);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "WorkSegment",
          reason: "Revision 生效后原关联节点失效",
        },
      }),
    ).toBe(0);
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
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: {
            startsWith: `pm:segment:association_invalidated:${revision.revisionNodeId}`,
          },
        },
      }),
    ).toBe(0);
    expect(
      await prisma.inAppNotification.count({
        where: {
          eventKey: {
            startsWith: `pm:segment:association_invalidated:${revision.revisionNodeId}`,
          },
        },
      }),
    ).toBe(0);
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
    expect(diff.planChanges.plannedStartAt).toBeNull();
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
      createRevision(actor(fixture.owner), {
        taskId: fixture.taskId,
        basePlanVersionId: fixture.currentPlanVersionId,
        baseTaskLockVersion: 1,
        reason: "基线已过期",
        description: "基线已过期",
        replacementMilestones: [
          milestoneInput("过期修订", "不会生效", 6),
        ],
        revisionAt: new Date(
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
    const revision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      reason: "并发审批测试",
      description: "并发审批测试",
      replacementMilestones: [
        milestoneInput("并发后计划", "只有一个审批结果", 5),
      ],
      revisionAt: new Date(
        Date.UTC(2026, 6, 31, 10, 0, 0),
      ).toISOString(),
      termination: terminationInput(9),
      idempotencyKey: `revision-race-${randomUUID()}`,
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
    const revision = await createRevision(actor(fixture.admin), {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: 1,
      reason: "Owner 直接调整",
      description: "Owner 直接调整",
      replacementMilestones: [
        milestoneInput("Owner 新计划", "完成 Owner 目标", 3),
      ],
      revisionAt: new Date(
        Date.UTC(2026, 6, 31, 10, 0, 0),
      ).toISOString(),
      termination: terminationInput(7),
      idempotencyKey: `revision-direct-${randomUUID()}`,
    });
    expect(revision.status).toBe("PENDING_APPROVAL");
    expect(revision.currentPlanVersionId).toBe(fixture.currentPlanVersionId);
    const approved = await approveRevision(actor(fixture.admin), {
      revisionNodeId: revision.revisionNodeId,
      comment: "管理员自审通过",
    });
    expect(approved.status).toBe("EFFECTIVE");
    expect(approved.currentPlanVersionId).toBe(revision.targetPlanVersionId);
  });

  test("Termination Review matches Milestone submit/review permissions and preserves returned rounds", async () => {
    const fixture = await createActivatedFixture();
    const outsider = await createAccountPerson("生命周期 Termination 旁观者");
    const terminationEntry = (await currentPlanNodes(fixture.taskId)).at(-1);
    if (!terminationEntry?.node.termination)
      throw new Error("测试计划缺少 Terminal");

    await expectServiceError(
      submitTerminationForReview(actor(outsider), {
        terminationNodeId: terminationEntry.nodeId,
        outcome: "FAILED",
        reason: "旁观者不应提交",
        summary: "权限回归",
        idempotencyKey: `termination-outsider-${randomUUID()}`,
      }),
      "FORBIDDEN",
    );

    const firstKey = `termination-review-first-${randomUUID()}`;
    const first = await submitTerminationForReview(actor(fixture.member), {
      terminationNodeId: terminationEntry.nodeId,
      outcome: "CANCELLED",
      reason: "参与人申请提前取消",
      summary: "第一轮结束申请",
      idempotencyKey: firstKey,
    });
    expect(first).toMatchObject({ result: "PENDING", created: true });
    const globalAdministratorRecipients =
      await activeGlobalAdministratorNotificationRecipients();
    const firstRequestPayload = await expectProjectManagementOutbox(
      `pm:termination:review_submitted:${first.reviewId}:feishu`,
      {
        type: "termination_review_submitted",
        botKind: "approval",
        purpose: "approval_request",
      },
    );
    expect(firstRequestPayload.linkPath).toBe(
      `/progress/tasks/${fixture.taskId}?focus=${terminationEntry.nodeId}`,
    );
    expect(
      jsonStringArray(firstRequestPayload.recipientOpenIds).sort(),
    ).toEqual(globalAdministratorRecipients.openIds);
    await expectNotificationAccountIds(
      `pm:termination:review_submitted:${first.reviewId}:inapp:`,
      globalAdministratorRecipients.accountIds,
    );
    const adminActor: ProjectManagementActor = {
      ...actor(fixture.admin),
      systemRoles: [{ role: "PROJECT_ADMINISTRATOR", team: "", techGroup: "" }],
    };
    const [memberInbox, adminInbox, memberLifecycle, adminLifecycle] =
      await Promise.all([
        getActionInbox({ actor: actor(fixture.member), input: { limit: 100 } }),
        getActionInbox({ actor: adminActor, input: { limit: 100 } }),
        getTaskLifecycleViews({
          actor: actor(fixture.member),
          taskId: fixture.taskId,
          terminationReviewLimit: 5,
          currentOnly: true,
        }),
        getTaskLifecycleViews({
          actor: adminActor,
          taskId: fixture.taskId,
          terminationReviewLimit: 5,
          currentOnly: true,
        }),
      ]);
    expect(
      memberInbox.items.some(
        (item) => item.id === `termination-review:${first.reviewId}`,
      ),
    ).toBe(false);
    expect(adminInbox.items).toContainEqual(
      expect.objectContaining({
        id: `termination-review:${first.reviewId}`,
        kind: "TERMINATION_REVIEW",
        taskId: fixture.taskId,
      }),
    );
    expect(memberLifecycle.terminationReviews[0]).toMatchObject({
      id: first.reviewId,
      result: "PENDING",
      capabilities: { canReview: false },
    });
    expect(adminLifecycle.terminationReviews[0]).toMatchObject({
      id: first.reviewId,
      result: "PENDING",
      capabilities: { canReview: true },
    });
    await expect(
      submitTerminationForReview(actor(fixture.member), {
        terminationNodeId: terminationEntry.nodeId,
        outcome: "CANCELLED",
        reason: "参与人申请提前取消",
        summary: "第一轮结束申请",
        idempotencyKey: firstKey,
      }),
    ).resolves.toMatchObject({ reviewId: first.reviewId, created: false });
    await expectServiceError(
      submitTerminationForReview(actor(fixture.member), {
        terminationNodeId: terminationEntry.nodeId,
        outcome: "CANCELLED",
        reason: "参与人申请提前取消",
        summary: "第一轮结束申请",
        idempotencyKey: `termination-review-conflict-${randomUUID()}`,
      }),
      "STATE_CONFLICT",
    );
    await expect(
      prisma.task.findUniqueOrThrow({
        where: { id: fixture.taskId },
        select: { status: true, lockVersion: true },
      }),
    ).resolves.toEqual({ status: "ACTIVE", lockVersion: 1 });
    await expect(
      prisma.terminationNode.findUniqueOrThrow({
        where: { nodeId: terminationEntry.nodeId },
        select: { outcome: true, confirmedAt: true },
      }),
    ).resolves.toEqual({ outcome: null, confirmedAt: null });
    await expectServiceError(
      reviewTermination(actor(fixture.owner), {
        reviewId: first.reviewId,
        result: "APPROVED",
        comment: "Owner 不能审批",
      }),
      "FORBIDDEN",
    );
    const required = await reviewTermination(actor(fixture.reviewer), {
      reviewId: first.reviewId,
      result: "REVISION_REQUIRED",
      comment: "请补充结束说明",
    });
    expect(required).toMatchObject({
      result: "REVISION_REQUIRED",
      taskStatus: "ACTIVE",
      lockVersion: 1,
    });
    const returnedRecipients = await taskNotificationRecipients({
      taskId: fixture.taskId,
      roles: ["OWNER"],
      personIds: [fixture.member.person.id],
    });
    const requiredPayload = await expectProjectManagementOutbox(
      `pm:termination:review_result:${first.reviewId}:REVISION_REQUIRED:feishu`,
      {
        type: "termination_review_result",
        botKind: "notification",
        purpose: "notification",
      },
    );
    expect(requiredPayload.linkPath).toBe(
      `/progress/tasks/${fixture.taskId}?focus=${terminationEntry.nodeId}`,
    );
    expect(jsonStringArray(requiredPayload.recipientOpenIds).sort()).toEqual(
      returnedRecipients.openIds,
    );
    await expectNotificationAccountIds(
      `pm:termination:review_result:${first.reviewId}:REVISION_REQUIRED:inapp:`,
      returnedRecipients.accountIds,
    );
    await expect(
      getTaskLifecycleViews({
        actor: actor(fixture.owner),
        taskId: fixture.taskId,
        terminationReviewLimit: 5,
        currentOnly: true,
      }),
    ).resolves.toMatchObject({
      terminationReviews: [
        {
          id: first.reviewId,
          outcome: "CANCELLED",
          reason: "参与人申请提前取消",
          summary: "第一轮结束申请",
          result: "REVISION_REQUIRED",
          comment: "请补充结束说明",
        },
      ],
    });

    const second = await submitTerminationForReview(actor(fixture.owner), {
      terminationNodeId: terminationEntry.nodeId,
      outcome: "TIMEOUT",
      reason: "负责人修改为超时结束",
      summary: "第二轮结束申请",
      idempotencyKey: `termination-review-second-${randomUUID()}`,
    });
    const rejected = await reviewTermination(actor(fixture.admin), {
      reviewId: second.reviewId,
      result: "REJECTED",
      comment: "当前不能按超时结束",
    });
    expect(rejected).toMatchObject({
      result: "REJECTED",
      taskStatus: "ACTIVE",
    });

    const third = await submitTerminationForReview(actor(fixture.member), {
      terminationNodeId: terminationEntry.nodeId,
      outcome: "FAILED",
      reason: "最终申请失败结束",
      summary: "第三轮结束申请",
      idempotencyKey: `termination-review-third-${randomUUID()}`,
    });
    const approved = await reviewTermination(actor(fixture.reviewer), {
      reviewId: third.reviewId,
      result: "APPROVED",
      comment: "同意结束",
    });
    expect(approved).toMatchObject({
      result: "APPROVED",
      taskStatus: "FAILED",
      outcome: "FAILED",
      lockVersion: 2,
    });
    await expect(
      prisma.terminationNode.findUniqueOrThrow({
        where: { nodeId: terminationEntry.nodeId },
        select: {
          outcome: true,
          reason: true,
          summary: true,
          confirmedByAccountId: true,
        },
      }),
    ).resolves.toEqual({
      outcome: "FAILED",
      reason: "最终申请失败结束",
      summary: "第三轮结束申请",
      confirmedByAccountId: fixture.reviewer.account.id,
    });
    await expect(
      prisma.terminationReview.count({
        where: { terminationNodeId: terminationEntry.node.termination.id },
      }),
    ).resolves.toBe(3);
    const approvedPayload = await expectProjectManagementOutbox(
      `pm:task:terminated:${terminationEntry.nodeId}:feishu`,
      {
        type: "task_terminated",
        botKind: "notification",
        purpose: "notification",
      },
    );
    expect(approvedPayload.linkPath).toBe(
      `/progress/tasks/${fixture.taskId}?focus=${terminationEntry.nodeId}`,
    );
    expect(JSON.stringify(approvedPayload)).toContain("最终申请失败结束");
    expect(JSON.stringify(approvedPayload)).toContain("第三轮结束申请");
    const approvedRecipients = await taskNotificationRecipients({
      taskId: fixture.taskId,
      roles: ["OWNER", "PARTICIPANT"],
    });
    expect(jsonStringArray(approvedPayload.recipientOpenIds).sort()).toEqual(
      approvedRecipients.openIds,
    );
    await expectNotificationAccountIds(
      `pm:task:terminated:${terminationEntry.nodeId}:inapp:`,
      approvedRecipients.accountIds,
    );
    await expectProjectManagementOutbox(
      `pm:termination:review_submitted:${third.reviewId}:feishu`,
      {
        type: "termination_review_submitted",
        botKind: "approval",
        purpose: "approval_request",
      },
    );
    await expectProjectManagementOutbox(
      `pm:termination:review_result:${second.reviewId}:REJECTED:feishu`,
      {
        type: "termination_review_result",
        botKind: "notification",
        purpose: "notification",
      },
    );
    const persistedReviewers = await prisma.terminationReview.findMany({
      where: { id: { in: [first.reviewId, second.reviewId, third.reviewId] } },
      select: { id: true, reviewerAccountId: true },
    });
    expect(persistedReviewers).toHaveLength(3);
    expect(persistedReviewers).toEqual(
      expect.arrayContaining([
        { id: first.reviewId, reviewerAccountId: fixture.reviewer.account.id },
        { id: second.reviewId, reviewerAccountId: fixture.admin.account.id },
        { id: third.reviewId, reviewerAccountId: fixture.reviewer.account.id },
      ]),
    );
  });

  test("Termination Review permits administrator self-review and serializes concurrent decisions", async () => {
    const selfReviewFixture = await createActivatedFixture();
    const selfReviewTerminal = (
      await currentPlanNodes(selfReviewFixture.taskId)
    ).at(-1);
    if (!selfReviewTerminal?.node.termination) {
      throw new Error("测试计划缺少 Terminal");
    }
    const selfSubmitted = await submitTerminationForReview(
      actor(selfReviewFixture.admin),
      {
        terminationNodeId: selfReviewTerminal.nodeId,
        outcome: "CANCELLED",
        reason: "管理员自审结束",
        summary: "验证管理员可提交并审批自己的申请",
        idempotencyKey: `termination-self-review-${randomUUID()}`,
      },
    );
    const selfApproved = await reviewTermination(
      actor(selfReviewFixture.admin),
      {
        reviewId: selfSubmitted.reviewId,
        result: "APPROVED",
        comment: "管理员自审通过",
      },
    );
    expect(selfApproved).toMatchObject({
      result: "APPROVED",
      taskStatus: "CANCELLED",
    });
    await expect(
      prisma.terminationNode.findUniqueOrThrow({
        where: { nodeId: selfReviewTerminal.nodeId },
        select: { confirmedByAccountId: true },
      }),
    ).resolves.toEqual({
      confirmedByAccountId: selfReviewFixture.admin.account.id,
    });

    const concurrentFixture = await createActivatedFixture();
    const concurrentTerminal = (
      await currentPlanNodes(concurrentFixture.taskId)
    ).at(-1);
    if (!concurrentTerminal?.node.termination) {
      throw new Error("测试计划缺少 Terminal");
    }
    const submitted = await submitTerminationForReview(
      actor(concurrentFixture.member),
      {
        terminationNodeId: concurrentTerminal.nodeId,
        outcome: "FAILED",
        reason: "并发审批结束申请",
        summary: "只有一个审批决定可以生效",
        idempotencyKey: `termination-decision-race-${randomUUID()}`,
      },
    );
    const decisions = await Promise.allSettled([
      reviewTermination(actor(concurrentFixture.reviewer), {
        reviewId: submitted.reviewId,
        result: "APPROVED",
        comment: "并发通过",
      }),
      reviewTermination(actor(concurrentFixture.admin), {
        reviewId: submitted.reviewId,
        result: "REJECTED",
        comment: "并发驳回",
      }),
    ]);
    const fulfilled = decisions.filter(
      (
        entry,
      ): entry is PromiseFulfilledResult<
        Awaited<ReturnType<typeof reviewTermination>>
      > => entry.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(1);
    expect(
      decisions.filter((entry) => entry.status === "rejected"),
    ).toHaveLength(1);
    const [persistedReview, persistedTask, auditCount] = await Promise.all([
      prisma.terminationReview.findUniqueOrThrow({
        where: { id: submitted.reviewId },
        select: { result: true },
      }),
      prisma.task.findUniqueOrThrow({
        where: { id: concurrentFixture.taskId },
        select: { status: true },
      }),
      prisma.domainAuditEvent.count({
        where: {
          action: "pm.termination.review",
          entityType: "TerminationReview",
          entityId: submitted.reviewId,
        },
      }),
    ]);
    expect(persistedReview.result).toBe(fulfilled[0]?.value.result);
    expect(persistedTask.status).toBe(
      persistedReview.result === "APPROVED" ? "FAILED" : "ACTIVE",
    );
    expect(auditCount).toBe(1);
  });

  test("Termination negative decisions release the gate even after Task state drift", async () => {
    const fixture = await createActivatedFixture();
    const terminationEntry = (await currentPlanNodes(fixture.taskId)).at(-1);
    if (!terminationEntry?.node.termination) {
      throw new Error("测试计划缺少 Terminal");
    }
    const submitted = await submitTerminationForReview(actor(fixture.member), {
      terminationNodeId: terminationEntry.nodeId,
      outcome: "FAILED",
      reason: "状态漂移后仍需释放审批门禁",
      summary: "负面决定不得推进 Terminal",
      idempotencyKey: `termination-negative-drift-${randomUUID()}`,
    });
    await prisma.$transaction([
      prisma.task.update({
        where: { id: fixture.taskId },
        data: { status: "CANCELLED" },
      }),
      prisma.taskNode.update({
        where: { id: terminationEntry.nodeId },
        data: { status: "CANCELLED" },
      }),
    ]);

    const rejected = await reviewTermination(actor(fixture.admin), {
      reviewId: submitted.reviewId,
      result: "REJECTED",
      comment: "拒绝漂移状态下的结束申请并释放门禁",
    });
    expect(rejected).toMatchObject({
      result: "REJECTED",
      taskStatus: "CANCELLED",
      lockVersion: 1,
    });
    await expect(
      prisma.terminationNode.findUniqueOrThrow({
        where: { nodeId: terminationEntry.nodeId },
        select: { outcome: true, confirmedAt: true },
      }),
    ).resolves.toEqual({ outcome: null, confirmedAt: null });
    await expect(
      getTaskWorkspace({ actor: actor(fixture.owner), taskId: fixture.taskId }),
    ).resolves.toMatchObject({
      pendingApproval: null,
      pendingApprovalConflict: false,
    });
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
        reason: "管理员申请取消",
        summary: "全局管理员也可提交并审批结束申请",
        expectedLockVersion: reviewerCancelTask.lockVersion,
      },
    );
    expect(reviewerCancelled.status).toBe("CANCELLED");

    const completedFixture = await createActivatedFixture(1);
    const activeNode = await firstCurrentMilestone(completedFixture.taskId);
    const review = await submitMilestoneForReview(
      actor(completedFixture.member),
      {
        milestoneNodeId: activeNode.nodeId,
        idempotencyKey: `review-before-success-${randomUUID()}`,
        evidences: [{ kind: "TEXT", note: "单 Milestone 已完成" }],
      },
    );
    const approved = await reviewMilestone(actor(completedFixture.reviewer), {
      reviewId: review.reviewId,
      result: "APPROVED",
      comment: "通过",
    });
    expect(approved.activeMilestoneNodeId).toBeNull();
    const terminationNode = (
      await currentPlanNodes(completedFixture.taskId)
    )[1];
    const taskBeforeSuccess = await prisma.task.findUniqueOrThrow({
      where: { id: completedFixture.taskId },
      select: { lockVersion: true },
    });
    const successSubmission = await submitTerminationForReview(
      actor(completedFixture.owner),
      {
        terminationNodeId: terminationNode?.nodeId,
        outcome: "SUCCESS",
        reason: "",
        summary: "达到结束条件",
        idempotencyKey: `termination-success-recheck-${randomUUID()}`,
      },
    );
    await prisma.taskNode.update({
      where: { id: activeNode.nodeId },
      data: { status: "ACTIVE" },
    });
    await expectServiceError(
      reviewTermination(actor(completedFixture.admin), {
        reviewId: successSubmission.reviewId,
        result: "APPROVED",
        comment: "前置 Milestone 回退时不得通过",
      }),
      "STATE_CONFLICT",
    );
    await expect(
      prisma.terminationReview.findUniqueOrThrow({
        where: { id: successSubmission.reviewId },
        select: { result: true },
      }),
    ).resolves.toEqual({ result: "PENDING" });
    await prisma.taskNode.update({
      where: { id: activeNode.nodeId },
      data: { status: "COMPLETED" },
    });
    const success = await reviewTermination(actor(completedFixture.admin), {
      reviewId: successSubmission.reviewId,
      result: "APPROVED",
      comment: "前置 Milestone 恢复完成后通过",
    });
    expect(success.taskStatus).toBe("COMPLETED");
    expect(success.lockVersion).toBe(taskBeforeSuccess.lockVersion + 1);
  });

  test("没有可用全局审批人或有效飞书身份时提交审批整事务回滚", async () => {
    const fixture = await createActivatedFixture();
    const activeNode = await firstCurrentMilestone(fixture.taskId);
    const terminationEntry = (await currentPlanNodes(fixture.taskId)).at(-1);
    if (!terminationEntry?.node.termination)
      throw new Error("测试计划缺少 Terminal");
    const terminationReviewKey = `termination-approver-guard-${randomUUID()}`;
    const revisionInput = {
      taskId: fixture.taskId,
      basePlanVersionId: fixture.currentPlanVersionId,
      baseTaskLockVersion: fixture.lockVersion,
      reason: "审批人可达性门禁",
      description: "审批人可达性门禁",
      replacementMilestones: [
        milestoneInput("审批人恢复后再提交", "审批链路可达", 4),
      ],
      revisionAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
      termination: terminationInput(8),
      idempotencyKey: `revision-approver-guard-${randomUUID()}`,
    };
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
          message: expect.stringContaining("至少保留一名全局管理员"),
        });
        const revisionError = await captureServiceError(
          createRevision(actor(fixture.owner), {
            ...revisionInput,
            idempotencyKey: `${revisionInput.idempotencyKey}:no-admin`,
          }),
        );
        expect(revisionError).toMatchObject({
          code: "STATE_CONFLICT",
          message: expect.stringContaining("至少保留一名全局管理员"),
        });
        const terminationError = await captureServiceError(
          submitTerminationForReview(actor(fixture.member), {
            terminationNodeId: terminationEntry.nodeId,
            outcome: "FAILED",
            reason: "没有审批人时不得提交结束申请",
            summary: "审批人门禁回归",
            idempotencyKey: terminationReviewKey,
          }),
        );
        expect(terminationError).toMatchObject({
          code: "STATE_CONFLICT",
          message: expect.stringContaining("至少保留一名全局管理员"),
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
          createRevision(actor(fixture.owner), {
            ...revisionInput,
            idempotencyKey: `${revisionInput.idempotencyKey}:no-identity`,
          }),
        );
        expect(error).toMatchObject({
          code: "STATE_CONFLICT",
          message: expect.stringContaining("有效飞书身份"),
        });
        const terminationError = await captureServiceError(
          submitTerminationForReview(actor(fixture.owner), {
            terminationNodeId: terminationEntry.nodeId,
            outcome: "FAILED",
            reason: "没有飞书身份时不得提交结束申请",
            summary: "审批通知可达性回归",
            idempotencyKey: `${terminationReviewKey}:no-identity`,
          }),
        );
        expect(terminationError).toMatchObject({
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
        where: {
          milestoneNodeId: activeNode.nodeId,
          idempotencyKey: reviewKey,
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.revisionNode.count({
        where: { node: { taskId: fixture.taskId } },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.terminationReview.count({
        where: { terminationNodeId: terminationEntry.node.termination.id },
      }),
    ).resolves.toBe(0);
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

async function activeGlobalAdministratorOpenIds() {
  const identities = await prisma.accountIdentity.findMany({
    where: {
      provider: "FEISHU",
      tenantId: "default",
      account: {
        person: { is: { status: "ACTIVE" } },
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
    select: { openId: true },
  });
  return identities
    .map((identity) => identity.openId?.trim() ?? "")
    .filter((openId) => openId.length > 0);
}

async function createDraftFixture(
  milestoneCount = 2,
  terminationName = "Terminal",
) {
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
    terminationName,
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
  milestoneCount = 2,
  terminationName = "Terminal",
}: {
  ownerPersonId: string;
  memberPersonId: string;
  reviewerPersonId: string;
  idempotencyKey: string;
  milestoneCount?: number;
  terminationName?: string;
}) {
  return {
    title: `生命周期 Task ${randomUUID()}`,
    description: "服务端生命周期测试",
    team: "英雄",
    techGroup: "电控",
    priority: "HIGH",
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
    termination: terminationInput(milestoneCount + 3, terminationName),
    idempotencyKey,
  };
}

function memberlessDraftCanvasInput(taskId: string) {
  return {
    scope: { kind: "TASK_SCOPED", taskId },
    personIds: [],
    taskIds: [],
    types: [],
    statuses: [],
    groupBy: "PERSON",
    includeTaskAnchors: true,
    includeActual: true,
    includeBusyBlocks: false,
  };
}

async function taskActivationSnapshot(taskId: string) {
  const [task, nodes, auditCount, notificationCount, outboxCount] =
    await Promise.all([
      prisma.task.findUniqueOrThrow({
        where: { id: taskId },
        select: {
          status: true,
          lockVersion: true,
          activeMilestoneNodeId: true,
          startedAt: true,
        },
      }),
      prisma.taskNode.findMany({
        where: { taskId },
        select: { id: true, status: true },
        orderBy: { id: "asc" },
      }),
      prisma.domainAuditEvent.count({ where: { taskId } }),
      prisma.inAppNotification.count({ where: { taskId } }),
      prisma.notificationOutbox.count({
        where: { eventKey: { startsWith: `pm:task:activated:${taskId}:` } },
      }),
    ]);
  return { task, nodes, auditCount, notificationCount, outboxCount };
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

function terminationInput(daysFromBase: number, name = "Terminal") {
  return {
    name,
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

async function confirmTermination(
  submitter: ProjectManagementActor,
  input: {
    taskId: string;
    terminationNodeId: string;
    outcome: TerminationOutcome;
    reason: string;
    summary: string;
    expectedLockVersion: number;
  },
) {
  const submitted = await submitTerminationForReview(submitter, {
    terminationNodeId: input.terminationNodeId,
    outcome: input.outcome,
    reason: input.reason,
    summary: input.summary,
    idempotencyKey: `test-termination:${input.terminationNodeId}:${input.outcome}`,
  });
  const reviewer = await prisma.account.findFirstOrThrow({
    where: {
      person: { is: { status: "ACTIVE" } },
      systemRoles: {
        some: {
          role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] },
          team: "",
          techGroup: "",
          revokedAt: null,
        },
      },
    },
    select: {
      id: true,
      person: { select: { id: true } },
      identities: {
        where: { provider: "FEISHU", tenantId: "default" },
        select: { openId: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
    orderBy: { id: "asc" },
  });
  if (!reviewer.person) throw new Error("测试审批账号缺少 Person");
  const reviewed = await reviewTermination(
    {
      accountId: reviewer.id,
      personId: reviewer.person.id,
      openId: reviewer.identities[0]?.openId ?? "",
      unionId: null,
      systemRoles: [],
    },
    {
      reviewId: submitted.reviewId,
      result: "APPROVED",
      comment: "测试审批通过",
    },
  );
  return { ...reviewed, status: reviewed.taskStatus };
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

async function activeGlobalAdministratorNotificationRecipients() {
  const accounts = await prisma.account.findMany({
    where: {
      person: { is: { status: "ACTIVE" } },
      systemRoles: {
        some: {
          role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] },
          team: "",
          techGroup: "",
          revokedAt: null,
        },
      },
    },
    select: {
      id: true,
      identities: {
        where: { provider: "FEISHU", tenantId: "default" },
        select: { openId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  return notificationRecipientSets(accounts);
}

async function taskNotificationRecipients(input: {
  taskId: string;
  roles: Array<"OWNER" | "PARTICIPANT">;
  personIds?: string[];
}) {
  const members = await prisma.taskMember.findMany({
    where: {
      taskId: input.taskId,
      removedAt: null,
      person: { status: "ACTIVE", account: { isNot: null } },
      OR: [
        ...(input.roles.length > 0 ? [{ role: { in: input.roles } }] : []),
        ...(input.personIds?.length
          ? [{ personId: { in: input.personIds } }]
          : []),
      ],
    },
    select: {
      person: {
        select: {
          account: {
            select: {
              id: true,
              identities: {
                where: { provider: "FEISHU", tenantId: "default" },
                select: { openId: true },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              },
            },
          },
        },
      },
    },
  });
  return notificationRecipientSets(
    members.flatMap((member) =>
      member.person.account ? [member.person.account] : [],
    ),
  );
}

function notificationRecipientSets(
  accounts: Array<{
    id: string;
    identities: Array<{ openId: string | null }>;
  }>,
) {
  const uniqueAccounts = new Map(
    accounts.map((account) => [account.id, account]),
  );
  return {
    accountIds: [...uniqueAccounts.keys()].sort(),
    openIds: [...uniqueAccounts.values()]
      .map((account) => firstNonEmptyFeishuOpenId(account.identities))
      .filter((openId): openId is string => Boolean(openId))
      .sort(),
  };
}

async function expectNotificationAccountIds(
  eventKeyPrefix: string,
  expectedAccountIds: string[],
) {
  const notifications = await prisma.inAppNotification.findMany({
    where: { eventKey: { startsWith: eventKeyPrefix } },
    select: { recipientAccountId: true },
  });
  expect(
    notifications.map((notification) => notification.recipientAccountId).sort(),
  ).toEqual(expectedAccountIds);
}

async function expectNotificationLinkPath(
  eventKeyPrefix: string,
  expectedLinkPath: string,
) {
  const notifications = await prisma.inAppNotification.findMany({
    where: { eventKey: { startsWith: eventKeyPrefix } },
    select: { linkPath: true, payload: true },
  });
  expect(notifications.length).toBeGreaterThan(0);
  for (const notification of notifications) {
    expect(notification.linkPath).toBe(expectedLinkPath);
    expect(jsonRecord(notification.payload).linkPath).toBe(expectedLinkPath);
  }
}

function jsonStringArray(value: unknown) {
  if (
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string")
  ) {
    return value;
  }
  throw new Error("测试期望 JSON string array");
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
