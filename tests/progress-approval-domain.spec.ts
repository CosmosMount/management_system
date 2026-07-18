import { expect, test } from "@playwright/test";
import { ProjectStatus, TaskStatus } from "@prisma/client";
import {
  canRequestProgressApprovalReminder,
  canUserApproveProgressApproval,
  getMyProgressApprovalSubmissions,
  type ResolvedProgressApproval,
} from "../lib/progress-approval-domain";
import { prisma } from "../lib/prisma";

function taskDeletionApproval(): ResolvedProgressApproval {
  return {
    reference: { kind: "TASK_DELETION", id: "approval-task-deletion" },
    status: "PENDING",
    project: {
      id: "project",
      name: "权限作用域项目",
      team: "项目车组",
      techGroup: "项目技术组",
      status: "IN_PROGRESS",
      ownerOpenId: "ou_owner",
      ownerName: "项目负责人",
      owners: [{ openId: "ou_owner", name: "项目负责人" }],
      participants: [],
      allowOwnerSelfApproval: false,
    },
    stage: null,
    task: {
      id: "task",
      title: "跨组任务",
      team: "任务车组",
      techGroup: "任务技术组",
      status: "IN_PROGRESS",
      assigneeOpenIds: ["ou_assignee"],
      techGroups: ["任务技术组", "附加技术组"],
      deletedAt: null,
    },
    submitterOpenId: "ou_submitter",
    submitterName: "提交人",
    submittedAt: new Date("2026-07-18T08:00:00.000Z"),
    processedAt: null,
    subject: "跨组任务",
    summary: "任务删除申请",
    href: "/progress/task/task",
  };
}

test("任务删除审批人与提醒发起人都使用任务权限作用域", () => {
  const approval = taskDeletionApproval();
  const taskLeadRoles = [
    { role: "TEAM_ADMIN" as const, team: "任务车组", techGroup: "" },
  ];
  const projectLeadRoles = [
    { role: "TEAM_ADMIN" as const, team: "项目车组", techGroup: "" },
  ];

  expect(canUserApproveProgressApproval(approval, taskLeadRoles, "ou_task_lead"))
    .toBe(true);
  expect(canUserApproveProgressApproval(approval, projectLeadRoles, "ou_project_lead"))
    .toBe(false);
  expect(
    canRequestProgressApprovalReminder({
      approval,
      roles: taskLeadRoles,
      userOpenId: "ou_task_lead",
    }),
  ).toBe(true);
  expect(
    canRequestProgressApprovalReminder({
      approval,
      roles: projectLeadRoles,
      userOpenId: "ou_project_lead",
    }),
  ).toBe(false);
});

test("任务删除的附加技术组组长和项目技术组组长均不可越权", () => {
  const approval = taskDeletionApproval();
  expect(
    canRequestProgressApprovalReminder({
      approval,
      roles: [
        {
          role: "TECH_GROUP_ADMIN",
          team: "",
          techGroup: "附加技术组",
        },
      ],
      userOpenId: "ou_extra_tech_lead",
    }),
  ).toBe(false);
  expect(
    canRequestProgressApprovalReminder({
      approval,
      roles: [
        {
          role: "TECH_GROUP_ADMIN",
          team: "",
          techGroup: "项目技术组",
        },
      ],
      userOpenId: "ou_project_tech_lead",
    }),
  ).toBe(false);
});

test("仅任务 DDL 允许附加技术组组长请求提醒", () => {
  const approval = taskDeletionApproval();
  approval.reference.kind = "TASK_DDL";
  expect(
    canRequestProgressApprovalReminder({
      approval,
      roles: [
        {
          role: "TECH_GROUP_ADMIN",
          team: "",
          techGroup: "附加技术组",
        },
      ],
      userOpenId: "ou_extra_tech_lead",
    }),
  ).toBe(true);
});

test("统一审批列表将撤回状态映射为已撤回且只有待审批申请可撤回", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const submitterOpenId = `ou_domain_withdraw_${suffix}`;
  const project = await prisma.project.create({
    data: {
      name: `领域撤回状态项目-${suffix}`,
      team: "测试车组",
      techGroup: "测试技术组",
      status: ProjectStatus.IN_PROGRESS,
      ownerOpenId: submitterOpenId,
      ownerName: "领域测试提交人",
      owners: {
        create: [{ openId: submitterOpenId, name: "领域测试提交人" }],
      },
    },
  });

  try {
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        title: `领域撤回状态任务-${suffix}`,
        assigneeOpenId: submitterOpenId,
        assigneeName: "领域测试提交人",
        team: project.team,
        techGroup: project.techGroup,
        dueAt: new Date(Date.now() + 86_400_000),
        status: TaskStatus.IN_PROGRESS,
      },
    });
    const [pending, withdrawn] = await Promise.all([
      prisma.taskDdlChangeRequest.create({
        data: {
          taskId: task.id,
          requesterOpenId: submitterOpenId,
          requesterName: "领域测试提交人",
          oldDueAt: task.dueAt,
          newDueAt: new Date(task.dueAt.getTime() + 86_400_000),
          reason: "待审批状态映射",
          status: "PENDING",
          pendingKey: "PENDING",
        },
      }),
      prisma.taskDdlChangeRequest.create({
        data: {
          taskId: task.id,
          requesterOpenId: submitterOpenId,
          requesterName: "领域测试提交人",
          oldDueAt: task.dueAt,
          newDueAt: new Date(task.dueAt.getTime() + 172_800_000),
          reason: "已撤回状态映射",
          status: "WITHDRAWN",
          pendingKey: `WITHDRAWN:${suffix}`,
          withdrawnAt: new Date(),
          withdrawnByOpenId: submitterOpenId,
          withdrawnByName: "领域测试提交人",
        },
      }),
    ]);

    const items = await getMyProgressApprovalSubmissions({
      userOpenId: submitterOpenId,
      roles: [],
    });
    const pendingItem = items.find((item) => item.reference.id === pending.id);
    const withdrawnItem = items.find((item) => item.reference.id === withdrawn.id);

    expect(pendingItem).toMatchObject({
      status: "PENDING",
      statusLabel: "待审批",
      canWithdraw: true,
    });
    expect(withdrawnItem).toMatchObject({
      status: "WITHDRAWN",
      statusLabel: "已撤回",
      canWithdraw: false,
    });
    expect(withdrawnItem?.processedAt).not.toBeNull();
  } finally {
    await prisma.project.delete({ where: { id: project.id } });
  }
});
