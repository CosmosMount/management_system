// @playwright-project ui
import { expect, test } from "@playwright/test";
import { resolveProjectManagementNotificationLinkPath } from "../lib/project-management/notifications/link-path";
import type { ProjectManagementNotificationPayload } from "../lib/project-management/notifications/contract";

type LinkPathTestCase = {
  name: string;
  input: {
    kind: ProjectManagementNotificationPayload["kind"];
    linkPath?: string | null;
    taskId?: string | null;
    projectId?: string | null;
  };
  expected: string;
};

const CASES: LinkPathTestCase[] = [
  {
    name: "Task 事件进入 Task 详情",
    input: { kind: "task_activated", taskId: "task-direct" },
    expected: "/progress/tasks/task-direct",
  },
  {
    name: "Project 事件进入 Project 详情",
    input: { kind: "project_completed", projectId: "project-direct" },
    expected: "/progress/projects/project-direct",
  },
  {
    name: "同时有 Task 和 Project 时优先 Task",
    input: {
      kind: "comment_created",
      linkPath: "/progress/projects/project-secondary",
      taskId: "task-preferred",
      projectId: "project-secondary",
    },
    expected: "/progress/tasks/task-preferred",
  },
  {
    name: "保留 Terminal focus 深链",
    input: {
      kind: "termination_review_submitted",
      linkPath: "/progress/tasks/task-terminal?focus=terminal-node",
      taskId: "task-terminal",
    },
    expected: "/progress/tasks/task-terminal?focus=terminal-node",
  },
  {
    name: "保留 Project 立项锚点",
    input: {
      kind: "project_establishment_submitted",
      linkPath: "/progress/projects/project-establishment#establishment",
      projectId: "project-establishment",
    },
    expected: "/progress/projects/project-establishment#establishment",
  },
  {
    name: "Segment 到期确认保留 My Work focus 深链",
    input: {
      kind: "segment_confirmation_due",
      linkPath: "/progress?focus=segment-due",
      taskId: "task-for-segment",
    },
    expected: "/progress?focus=segment-due",
  },
  {
    name: "Segment 不接受 Task 详情作为确认入口",
    input: {
      kind: "segment_confirmation_due",
      linkPath: "/progress/tasks/task-for-segment",
      taskId: "task-for-segment",
    },
    expected: "/progress",
  },
  {
    name: "Task 删除事件进入 Task 列表",
    input: {
      kind: "task_deleted",
      linkPath: "/progress/tasks/deleted-task",
      taskId: "deleted-task",
    },
    expected: "/progress/tasks",
  },
  {
    name: "Project 删除事件进入 Project 列表",
    input: {
      kind: "project_deleted",
      linkPath: "/progress/projects/deleted-project",
      projectId: "deleted-project",
    },
    expected: "/progress/projects",
  },
  {
    name: "无业务目标时回退 My Work",
    input: { kind: "account_security" },
    expected: "/progress",
  },
  {
    name: "旧版精确 My Work 链接按 Task 目标推导",
    input: {
      kind: "risk_created",
      linkPath: "/progress",
      taskId: "legacy-task",
      projectId: "legacy-project",
    },
    expected: "/progress/tasks/legacy-task",
  },
  {
    name: "旧版精确 My Work 链接按 Project 目标推导",
    input: {
      kind: "risk_resolved",
      linkPath: "/progress",
      projectId: "legacy-project",
    },
    expected: "/progress/projects/legacy-project",
  },
];

test.describe("project-management notification link path", () => {
  for (const testCase of CASES) {
    test(testCase.name, () => {
      expect(
        resolveProjectManagementNotificationLinkPath(testCase.input),
      ).toBe(testCase.expected);
    });
  }

  test("匿名访问 Project/Task 详情时完整保留登录回跳目标", async ({
    context,
    page,
  }) => {
    await context.clearCookies();
    for (const target of [
      "/progress/projects/project-login-return",
      "/progress/tasks/task-login-return?focus=terminal-node",
    ]) {
      const response = await page.goto(target);
      expect(response?.status()).toBeLessThan(500);
      const loginUrl = new URL(page.url());
      expect(loginUrl.pathname).toBe("/login");
      expect(loginUrl.searchParams.get("callbackUrl")).toBe(target);
    }
  });
});
