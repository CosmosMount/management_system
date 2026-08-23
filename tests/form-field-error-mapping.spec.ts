import { expect, test } from "@playwright/test";
import {
  serverFieldValidationIssues,
  serverFieldValidationIssuesFullyMapped,
} from "../components/project-management/task-composer-validation";
import type { TaskComposerSeed } from "../lib/project-management/composer-contract";
import {
  fieldErrorsFullyHandled,
  firstFieldErrorMessage,
} from "../lib/project-management/field-errors";

const composerState: TaskComposerSeed = {
  draftId: "field-error-mapping",
  title: "字段错误映射",
  description: "",
  team: "工程",
  techGroup: "机械",
  priority: "MEDIUM",
  relatedTaskId: null,
  projectId: null,
  members: [{ personId: "00000000-0000-4000-8000-000000000001", role: "OWNER" }],
  plannedStartAt: "2026-08-01T09:00",
  milestones: [
    {
      id: "milestone-1",
      goal: "完成映射",
      completionCriteria: "映射正确",
      expectedCompletedAt: "2026-08-02T09:00",
      reviewRequirements: "覆盖已知与未知路径",
      businessDescription: "",
    },
  ],
  termination: {
    id: "termination-1",
    name: "结束",
    plannedAt: "2026-08-03T09:00",
    plannedOutcomeCriteria: "测试通过",
    businessDescription: "",
  },
  selectedEntityId: null,
};

test("Composer 完整映射已知服务端字段错误且不需要重复全局提示", () => {
  const fieldErrors = {
    title: ["服务端 Task 名称错误"],
    "milestones.0.goal": ["服务端 Milestone 目标错误"],
  };
  const issues = serverFieldValidationIssues(fieldErrors, composerState);

  expect(issues).toEqual([
    { key: "title", message: "服务端 Task 名称错误" },
    {
      key: "goal-milestone-1",
      entityId: "milestone-1",
      message: "服务端 Milestone 目标错误",
    },
  ]);
  expect(serverFieldValidationIssuesFullyMapped(fieldErrors, issues)).toBe(true);
});

test("Composer 混入未知路径时保留全局错误且不伪装成目标字段", () => {
  const fieldErrors = {
    title: ["服务端 Task 名称错误"],
    "milestones.0.unknownField": ["未知 Milestone 字段错误"],
  };
  const issues = serverFieldValidationIssues(fieldErrors, composerState);

  expect(issues).toEqual([
    { key: "title", message: "服务端 Task 名称错误" },
  ]);
  expect(issues.some((issue) => issue.key === "goal-milestone-1")).toBe(false);
  expect(serverFieldValidationIssuesFullyMapped(fieldErrors, issues)).toBe(false);
});

test("Composer 忽略空字段消息且不会因此吞掉未知字段的全局错误", () => {
  const fieldErrors = {
    title: [""],
    unknown: ["未知字段错误"],
  };
  const issues = serverFieldValidationIssues(fieldErrors, composerState);

  expect(issues).toEqual([]);
  expect(serverFieldValidationIssuesFullyMapped(fieldErrors, issues)).toBe(false);
});

test("Revision Composer 按可编辑 Milestone 索引映射替换计划字段", () => {
  const lockedMilestone = {
    ...composerState.milestones[0]!,
    id: "locked-milestone",
    expectedCompletedAt: "2026-08-02T09:00",
  };
  const editableMilestone = {
    ...composerState.milestones[0]!,
    id: "editable-milestone",
    expectedCompletedAt: "2026-08-03T09:00",
  };
  const revisionState: TaskComposerSeed = {
    ...composerState,
    milestones: [lockedMilestone, editableMilestone],
    revision: {
      markerId: "revision-marker",
      reason: "调整计划",
      description: "替换未完成节点",
      revisionAt: "2026-08-02T12:00",
      reviewRound: 1,
      lockedMilestoneIds: [lockedMilestone.id],
      carriedAnchors: [],
    },
  };
  const fieldErrors = {
    "replacementMilestones.0.goal": ["请填写替换节点目标"],
    "replacementMilestones.0.unknownField": ["未知替换节点字段错误"],
  };
  const issues = serverFieldValidationIssues(fieldErrors, revisionState);

  expect(issues).toEqual([
    {
      key: "goal-editable-milestone",
      entityId: "editable-milestone",
      message: "请填写替换节点目标",
    },
  ]);
  expect(serverFieldValidationIssuesFullyMapped(fieldErrors, issues)).toBe(false);
});

test("mutation runner 仅在全部非空字段路径均受支持时消费全局错误", () => {
  expect(
    fieldErrorsFullyHandled(
      { comment: ["请填写说明"], reason: ["请填写原因"] },
      ["comment", "reason"],
    ),
  ).toBe(true);
  expect(
    fieldErrorsFullyHandled(
      { comment: ["请填写说明"], unknown: ["未知字段错误"] },
      ["comment"],
    ),
  ).toBe(false);
  expect(fieldErrorsFullyHandled({}, ["comment"])).toBe(false);
  expect(
    fieldErrorsFullyHandled(
      { comment: [""], unknown: ["未知字段错误"] },
      ["comment"],
    ),
  ).toBe(false);
  expect(firstFieldErrorMessage({ comment: ["", "请填写说明"] }, "comment"))
    .toBe("请填写说明");
});
