import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAnchorGroupMove,
  applyComposerBatchDelay,
  editableComposerEntityIds,
  normalizeComposerSeed,
} from "../components/project-management/task-composer-plan-state";
import {
  TASK_COMPOSER_START_ID,
  type TaskComposerSeed,
} from "../lib/project-management/composer-contract";

const DAY_MS = 24 * 60 * 60 * 1_000;

test("Task Composer group move preserves selected intervals and leaves unselected nodes unchanged", () => {
  const state = composerSeed();
  const result = applyAnchorGroupMove(
    state,
    moveRequest("milestone-1", "2026-09-04T09:00", DAY_MS),
    ["milestone-1", "milestone-2"],
  );
  if (!result.ok) assert.fail(result.message);

  assert.deepEqual(new Set(result.movedEntityIds), new Set(["milestone-1", "milestone-2"]));
  assert.equal(result.deltaMs, DAY_MS);
  assert.equal(milestoneAt(result.state, "milestone-1"), "2026-09-04T09:00");
  assert.equal(milestoneAt(result.state, "milestone-2"), "2026-09-07T09:00");
  assert.equal(milestoneAt(result.state, "milestone-3"), "2026-09-09T09:00");
  assert.equal(result.state.termination.plannedAt, "2026-09-12T18:00");
});

test("Task Composer rejects an illegal group collision without mutating any node", () => {
  const state = composerSeed();
  const before = structuredClone(state);
  const result = applyAnchorGroupMove(
    state,
    moveRequest("milestone-1", "2026-09-06T09:00", 3 * DAY_MS),
    ["milestone-1", "milestone-2"],
  );

  assert.equal(result.ok, false);
  assert.deepEqual(state, before);
});

test("Task Composer batch delay shifts the selected node and every later editable node once", () => {
  const state = composerSeed();
  const result = applyComposerBatchDelay(
    state,
    "milestone-2",
    "2026-09-08T09:00",
  );
  if (!result.ok) assert.fail(result.message);

  assert.deepEqual(
    result.movedEntityIds,
    ["milestone-2", "milestone-3", state.termination.id],
  );
  assert.equal(state.plannedStartAt, "2026-09-01T09:00");
  assert.equal(milestoneAt(result.state, "milestone-1"), "2026-09-03T09:00");
  assert.equal(milestoneAt(result.state, "milestone-2"), "2026-09-08T09:00");
  assert.equal(milestoneAt(result.state, "milestone-3"), "2026-09-11T09:00");
  assert.equal(result.state.termination.plannedAt, "2026-09-14T18:00");
});

test("Task Composer batch delay rejects empty, equal, and earlier targets with zero mutation", () => {
  const state = composerSeed();
  const before = structuredClone(state);

  for (const targetAt of ["", "2026-09-06T09:00", "2026-09-05T09:00"]) {
    const result = applyComposerBatchDelay(state, "milestone-2", targetAt);
    assert.equal(result.ok, false);
    assert.deepEqual(state, before);
  }
});

test("Revision carry-forward nodes never join a group while editable candidate nodes move atomically", () => {
  const state = revisionComposerSeed();
  assert.deepEqual(
    editableComposerEntityIds(state),
    ["milestone-2", "milestone-3", "revision-current", state.termination.id],
  );

  const result = applyAnchorGroupMove(
    state,
    moveRequest("revision-current", "2026-09-05T09:00", DAY_MS),
    [
      TASK_COMPOSER_START_ID,
      "milestone-1",
      "revision-effective",
      "revision-current",
      "milestone-2",
    ],
  );
  if (!result.ok) assert.fail(result.message);

  assert.deepEqual(
    new Set(result.movedEntityIds),
    new Set(["revision-current", "milestone-2"]),
  );
  assert.equal(result.state.plannedStartAt, state.plannedStartAt);
  assert.equal(
    milestoneAt(result.state, "milestone-1"),
    milestoneAt(state, "milestone-1"),
  );
  assert.equal(result.state.revision?.carriedAnchors[0]?.revisionAt, "2026-09-03T09:00");
  assert.equal(result.state.revision?.revisionAt, "2026-09-05T09:00");
  assert.equal(milestoneAt(result.state, "milestone-2"), "2026-09-07T09:00");
});

test("Revision replacement Milestones cannot move as a group across the locked prefix", () => {
  const state = revisionComposerSeed();
  const before = structuredClone(state);
  const result = applyAnchorGroupMove(
    state,
    moveRequest("milestone-2", "2026-09-02T09:00", -4 * DAY_MS),
    ["milestone-2", "milestone-3"],
  );

  assert.equal(result.ok, false);
  assert.deepEqual(state, before);
});

test("Revision replacement Milestone single moves clamp after the locked prefix", () => {
  const state = revisionComposerSeed();
  const result = applyAnchorGroupMove(
    state,
    moveRequest("milestone-2", "2026-09-02T09:00", -4 * DAY_MS),
    ["milestone-2"],
  );
  if (!result.ok) assert.fail(result.message);

  assert.equal(milestoneAt(result.state, "milestone-1"), "2026-09-03T09:00");
  assert.equal(milestoneAt(result.state, "milestone-2"), "2026-09-04T09:00");
  assert.equal(milestoneAt(result.state, "milestone-3"), "2026-09-09T09:00");
});

function composerSeed(): TaskComposerSeed {
  return normalizeComposerSeed({
    draftId: "task-composer-plan-state-test",
    title: "Composer plan state test",
    description: "",
    team: "HERO",
    techGroup: "ELECTRONIC_CONTROL",
    priority: "MEDIUM",
    relatedTaskId: null,
    projectId: null,
    members: [],
    plannedStartAt: "2026-09-01T09:00",
    milestones: [
      milestone("milestone-1", "2026-09-03T09:00"),
      milestone("milestone-2", "2026-09-06T09:00"),
      milestone("milestone-3", "2026-09-09T09:00"),
    ],
    termination: {
      id: "terminal",
      name: "Terminal",
      plannedAt: "2026-09-12T18:00",
      plannedOutcomeCriteria: "完成",
      businessDescription: "",
    },
    selectedEntityId: "milestone-1",
  });
}

function revisionComposerSeed(): TaskComposerSeed {
  return normalizeComposerSeed({
    ...composerSeed(),
    selectedEntityId: "revision-current",
    revision: {
      markerId: "revision-current",
      reason: "当前 Revision",
      description: "候选计划",
      revisionAt: "2026-09-04T09:00",
      reviewRound: 1,
      lockedMilestoneIds: ["milestone-1"],
      carriedAnchors: [
        {
          id: "revision-effective",
          reason: "已生效 Revision",
          description: "只读承接",
          revisionAt: "2026-09-03T09:00",
          status: "EFFECTIVE",
        },
      ],
    },
  });
}

function milestone(id: string, expectedCompletedAt: string) {
  return {
    id,
    goal: id,
    completionCriteria: "完成",
    expectedCompletedAt,
    reviewRequirements: "验收",
    businessDescription: "",
  };
}

function milestoneAt(state: TaskComposerSeed, id: string) {
  return state.milestones.find((milestone) => milestone.id === id)
    ?.expectedCompletedAt;
}

function moveRequest(anchorId: string, targetAt: string, deltaMs: number) {
  return {
    anchorId,
    rowId: "task-composer-plan-row",
    kind: "MOVE" as const,
    atMs: new Date(`${targetAt}:00+08:00`).getTime(),
    deltaMs,
    snapMs: DAY_MS,
  };
}
