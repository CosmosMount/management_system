// @playwright-project ui
import { expect, test } from "@playwright/test";
import { resolveProjectManagementNotificationLinkPath } from "../lib/project-management/notifications/link-path";
import type { ProjectManagementNotificationPayload } from "../lib/project-management/notifications/contract";
import { createLinkPreviewFixtures } from "./helpers/project-management-link-preview-fixtures";

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

  test("匿名预览 Project/Task/Meeting 后点击登录完整保留回跳目标", async ({
    context,
    page,
  }) => {
    const fixture = await createLinkPreviewFixtures();
    await context.clearCookies();
    for (const target of [
      `/progress/projects/${fixture.project.id}?center=2026-10-04T19%3A00%3A00.000Z&scale=week#establishment`,
      `/progress/tasks/${fixture.task.taskId}?focus=${fixture.task.milestoneNodeId}&center=2026-09-23T01%3A00%3A00.000Z&scale=week`,
      `/progress/meetings/${fixture.meeting.id}?center=2026-09-23T01%3A00%3A00.000Z&scale=week#meeting-content-heading`,
    ]) {
      const response = await page.goto(target);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
      await page.getByRole("link", { name: "登录查看详情" }).click();
      const loginUrl = new URL(page.url());
      expect(loginUrl.pathname).toBe("/login");
      expect(loginUrl.searchParams.get("callbackUrl")).toBe(target);
    }
  });
});
