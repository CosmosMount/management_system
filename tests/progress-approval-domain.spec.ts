import { expect, test } from "@playwright/test";
import {
  canRequestProgressApprovalReminder,
  canUserApproveProgressApproval,
  type ResolvedProgressApproval,
} from "../lib/progress-approval-domain";

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
