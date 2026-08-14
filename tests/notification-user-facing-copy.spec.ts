import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createFeishuEventDispatcher } from "../lib/feishu-event-handlers";
import { procurementNotificationTitle } from "../lib/feishu-procurement-card";
import { feedbackStatusLabels } from "../lib/feedback-labels";
import { statusLabels } from "../lib/permissions-client";
import { prisma } from "../lib/prisma";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import {
  normalizeProjectManagementNotificationText,
  projectManagementContextLines,
  projectManagementEntityLabel,
  taskMemberChangeSummary,
} from "../lib/project-management/notifications/user-facing-copy";
import { listInAppNotifications } from "../lib/project-management/queries/notification-queries";

test.describe("用户可见通知文案", () => {
  test("旧项目管理术语会转换为明确中文", () => {
    expect(
      normalizeProjectManagementNotificationText(
        "Task「电控调试」的 Current Plan 已切换",
        { field: "summary", kind: "revision_applied" },
      ),
    ).toBe("任务「电控调试」的当前计划已切换");
    expect(
      normalizeProjectManagementNotificationText("Planned Segment 待确认", {
        field: "title",
        kind: "segment_confirmation_due",
      }),
    ).toBe("计划投入待确认");
    expect(
      normalizeProjectManagementNotificationText("计划修订重新待审批", {
        field: "title",
        kind: "revision_pending_review",
      }),
    ).toBe("计划修订已重新提交审批");
    expect(
      normalizeProjectManagementNotificationText("验收结果：REVISION_REQUIRED", {
        field: "summary",
        kind: "milestone_review_result",
        context: { summarySource: "SYSTEM_DEFAULT" },
      }),
    ).toBe("验收结果：需要修改");
    expect(
      normalizeProjectManagementNotificationText("验收结果：APPROVED", {
        field: "summary",
        kind: "milestone_review_result",
        context: { summarySource: "SYSTEM_DEFAULT" },
      }),
    ).toBe("验收结果：已通过");
    expect(
      normalizeProjectManagementNotificationText("验收结果：APPROVED", {
        field: "summary",
        kind: "milestone_review_result",
        context: { summarySource: "USER_PROVIDED" },
      }),
    ).toBe("验收结果：APPROVED");
    expect(
      normalizeProjectManagementNotificationText("验收结果：APPROVED", {
        field: "summary",
        kind: "milestone_review_result",
      }),
    ).toBe("验收结果：APPROVED");
    expect(
      normalizeProjectManagementNotificationText("任务已结束（Terminal）：SUCCESS", {
        field: "summary",
        kind: "task_terminated",
      }),
    ).toBe("任务已结束（结束节点）：成功结束");
    expect(
      normalizeProjectManagementNotificationText(
        "Task「名称」的 Current Plan 已切换」的 Current Plan 已切换",
        { field: "summary", kind: "revision_applied" },
      ),
    ).toBe("任务「名称」的 Current Plan 已切换」的当前计划已切换");
    expect(
      normalizeProjectManagementNotificationText(
        "Task「名称」已移动 Project「旧称」已移动 Project「新项目」",
        {
          field: "summary",
          kind: "project_task_changed",
          taskTitle: "名称",
          projectName: "旧称」已移动 Project「新项目",
        },
      ),
    ).toBe("任务「名称」已移动到项目「旧称」已移动 Project「新项目」");
    expect(
      normalizeProjectManagementNotificationText(
        "Project「名称，关联 Task 已保留并移出 Project」已删除，关联 Task 已保留并移出 Project；负责人：Project；关联 2 个 Task",
        {
          field: "summary",
          kind: "project_deleted",
          projectName: "名称，关联 Task 已保留并移出 Project",
          context: { taskCount: 2 },
        },
      ),
    ).toBe(
      "项目「名称，关联 Task 已保留并移出 Project」已删除，关联任务已保留并移出项目；负责人：Project；关联 2 个任务",
    );
    expect(
      normalizeProjectManagementNotificationText(
        "甲：未通过，审批意见：负责人：王；本轮 8 个 Task；负责人：李；本轮 2 个 Task",
        {
          field: "summary",
          kind: "project_establishment_result",
          projectName: "甲",
          context: { taskCount: 2 },
        },
      ),
    ).toBe(
      "项目「甲」：未通过，审批意见：负责人：王；本轮 8 个 Task；负责人：李；本轮 2 个任务",
    );
    expect(
      normalizeProjectManagementNotificationText("Task「用户原文」", {
        field: "summary",
        kind: "revision_result",
      }),
    ).toBe("Task「用户原文」");
    const memberChangeCases = [
      {
        changeKind: "ADDED" as const,
        beforeRoles: [],
        afterRoles: ["OWNER"],
        legacy: "李棋轩已将你在 Task「电控调试」中的成员关系加入：无 → 负责人",
        expected: "李棋轩已将你加入任务「电控调试」，成员角色：无 → 负责人",
      },
      {
        changeKind: "REMOVED" as const,
        beforeRoles: ["OWNER"],
        afterRoles: [],
        legacy: "李棋轩已将你在 Task「电控调试」中的成员关系移出：负责人 → 无",
        expected: "李棋轩已将你移出任务「电控调试」，成员角色：负责人 → 无",
      },
      {
        changeKind: "ROLES_CHANGED" as const,
        beforeRoles: ["OWNER"],
        afterRoles: ["PARTICIPANT"],
        legacy:
          "李棋轩已将你在 Task「电控调试」中的成员关系调整角色：负责人 → 参与人",
        expected:
          "李棋轩已调整你在任务「电控调试」中的成员角色：负责人 → 参与人",
      },
    ];
    for (const memberChange of memberChangeCases) {
      const options = {
        actorName: "李棋轩",
        taskTitle: "电控调试",
        changeKind: memberChange.changeKind,
        beforeRoles: memberChange.beforeRoles,
        afterRoles: memberChange.afterRoles,
      };
      expect(taskMemberChangeSummary(options)).toBe(memberChange.expected);
      expect(
        normalizeProjectManagementNotificationText(memberChange.legacy, {
          field: "summary",
          kind: "task_assigned",
          actorName: options.actorName,
          taskTitle: options.taskTitle,
          context: {
            changeKind: options.changeKind,
            beforeRoles: options.beforeRoles,
            afterRoles: options.afterRoles,
          },
        }),
      ).toBe(memberChange.expected);
    }

    expect(
      normalizeProjectManagementNotificationText(
        "Task「名称」已移动 Project「旧称」已移动 Project「新项目」",
        { field: "summary", kind: "project_task_changed" },
      ),
    ).toBe("Task「名称」已移动 Project「旧称」已移动 Project「新项目」");
  });

  test("通知对象和上下文只展示中文白名单", () => {
    expect(projectManagementEntityLabel("MilestoneReview")).toBe("里程碑验收");
    expect(projectManagementEntityLabel("UnexpectedInternalEntity")).toBe(
      "相关事项",
    );

    const lines = projectManagementContextLines({
      taskStatus: "ACTIVE",
      segmentStatus: "PENDING_CONFIRMATION",
      changeKind: "ROLES_CHANGED",
      beforeRoles: ["OWNER"],
      afterRoles: ["PARTICIPANT"],
      recipientResolution: "PERSON_INACTIVE",
      recipientPolicy: "GLOBAL_ADMINISTRATORS_V2",
      internalDebugName: "DO_NOT_RENDER",
    });
    expect(lines).toEqual([
      { label: "任务状态", value: "进行中", maxLength: 120 },
      { label: "投入状态", value: "待确认", maxLength: 120 },
      { label: "成员变更", value: "调整角色", maxLength: 120 },
      { label: "变更前角色", value: "负责人", maxLength: 120 },
      { label: "变更后角色", value: "参与人", maxLength: 120 },
    ]);
    expect(JSON.stringify(lines)).not.toContain("PERSON_INACTIVE");
    expect(JSON.stringify(lines)).not.toContain("GLOBAL_ADMINISTRATORS_V2");
    expect(JSON.stringify(lines)).not.toContain("internalDebugName");
  });

  test("采购通知标题会明确说明当前处理环节", () => {
    expect(procurementNotificationTitle("MANAGEMENT_REVIEW")).toBe(
      "采购申请待管理审核",
    );
    expect(procurementNotificationTitle("TEACHER_REVIEW")).toBe(
      "采购申请待老师审核",
    );
    expect(procurementNotificationTitle("PENDING_APPLICANT_DOCS")).toBe(
      "请上传采购报销凭证",
    );
    expect(procurementNotificationTitle("PENDING_FINANCE_REVIEW")).toBe(
      "采购报销资料待报销员处理",
    );
    expect(procurementNotificationTitle("PENDING_APPLICANT_CONFIRM")).toBe(
      "请确认采购报销结果",
    );
    expect(procurementNotificationTitle("COMPLETED")).toBe("采购报销已完成");
    expect(statusLabels.PENDING_APPLICANT_DOCS).toBe("待申请人上传凭证");
    expect(statusLabels.PENDING_FINANCE_REVIEW).toBe("待报销员处理");
    expect(statusLabels.PENDING_APPLICANT_CONFIRM).toBe("待申请人确认");
  });

  test("反馈通知状态使用明确的处理语义", () => {
    expect(feedbackStatusLabels.OPEN).toBe("待处理");
    expect(feedbackStatusLabels.IN_PROGRESS).toBe("处理中");
    expect(feedbackStatusLabels.CLOSED).toBe("已关闭");
  });

  test("站内通知读取使用持久化字段转换旧模板并保留名称原文", async () => {
    const actor = await createNotificationActor();
    const summary =
      "Task「任务名」已移动 Project「项目甲」已移动 Project「项目乙」";
    await prisma.inAppNotification.create({
      data: {
        eventKey: `notification-copy-${randomUUID()}`,
        recipientAccountId: actor.accountId,
        category: "PROJECT",
        title: "Task 所属 Project 已变更",
        summary,
        entityType: "Task",
        entityId: randomUUID(),
        linkPath: "/progress",
        payload: {
          kind: "project_task_changed",
          payloadVersion: 1,
          purpose: "notification",
          category: "PROJECT",
          title: "Task 所属 Project 已变更",
          summary,
          actorName: "系统",
          taskId: null,
          taskTitle: "任务名",
          projectId: null,
          projectName: "项目甲」已移动 Project「项目乙",
          entityType: "Task",
          entityId: randomUUID(),
          linkPath: "/progress",
          recipientOpenIds: [],
          mandatory: true,
          context: {},
        },
      },
    });

    const result = await listInAppNotifications({
      actor,
      input: { limit: 1 },
    });
    expect(result.items[0]?.title).toBe("任务所属项目已变更");
    expect(result.items[0]?.summary).toBe(
      "任务「任务名」已移动到项目「项目甲」已移动 Project「项目乙」",
    );
  });

  test("飞书卡片回调异常不会向用户暴露内部错误", async () => {
    const dispatcher = createFeishuEventDispatcher({
      handleCardAction: async () => {
        throw new Error("INTERNAL_ACTION_NAME: payload.status=FAILED");
      },
    });
    const result = await dispatcher.invoke(
      {
        schema: "2.0",
        header: { event_type: "card.action.trigger" },
        event: {
          operator: { open_id: "ou_notification_copy_test" },
          action: { tag: "button", name: "internal_action" },
        },
      },
      { needCheck: false },
    );

    expect(result).toEqual({
      toast: {
        type: "error",
        content: "操作失败，请打开系统查看最新状态后重试",
        i18n: {
          zh_cn: "操作失败，请打开系统查看最新状态后重试",
          en_us: "操作失败，请打开系统查看最新状态后重试",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("INTERNAL_ACTION_NAME");
    expect(JSON.stringify(result)).not.toContain("payload.status");
  });
});

async function createNotificationActor(): Promise<ProjectManagementActor> {
  const openId = `ou_notification_copy_${randomUUID()}`;
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
          displayName: `通知文案测试 ${randomUUID()}`,
          status: "ACTIVE",
        },
      },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("通知文案测试账号缺少人员档案");
  return {
    accountId: account.id,
    personId: account.person.id,
    openId,
    unionId: null,
    systemRoles: [],
  };
}
