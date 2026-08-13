import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { activateTask, cancelRevision, createRevision } from "../lib/project-management/application/lifecycle-service";

import {
  actor,
  createAccountPerson,
  createDraft,
  currentPlan,
  currentTask,
  grantRole,
  iso,
  milestoneInput,
  terminationInput,
} from "./helpers/project-management-plan-mutation-fixtures";

test.describe("project management plan mutations project-management-plan-mutations-revision-time", () => {
  test("Revision marker accepts Start and Candidate Terminal equality boundaries", async () => {
      const admin = await createAccountPerson("S2 Revision Boundary Admin");
      const owner = await createAccountPerson("S2 Revision Boundary Owner");
      const reviewer = await createAccountPerson("S2 Revision Boundary Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({ creator: admin, owner, reviewer });
      await activateTask(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
      });
      const task = await currentTask(fixture.taskId);
      const current = await currentPlan(fixture.taskId);

      const atStart = await createRevision(actor(owner), {
        taskId: fixture.taskId,
        basePlanVersionId: current.id,
        baseTaskLockVersion: task.lockVersion,
        reason: "Revision 等于 Start",
        description: "Revision 等于 Start",
        revisionAt: iso(2026, 8, 1),
        replacementMilestones: [milestoneInput("Start 边界后计划", 4)],
        termination: terminationInput(8),
        idempotencyKey: `s2-revision-at-start-${randomUUID()}`,
      });
      expect(atStart.status).toBe("PENDING_APPROVAL");
      await cancelRevision(actor(owner), {
        revisionNodeId: atStart.revisionNodeId,
        comment: "验证下一个等值边界",
      });

      const atTerminal = await createRevision(actor(owner), {
        taskId: fixture.taskId,
        basePlanVersionId: current.id,
        baseTaskLockVersion: task.lockVersion,
        reason: "Revision 等于 Candidate Terminal",
        description: "Revision 等于 Candidate Terminal",
        revisionAt: iso(2026, 8, 8),
        replacementMilestones: [milestoneInput("Terminal 边界前计划", 4)],
        termination: terminationInput(8),
        idempotencyKey: `s2-revision-at-terminal-${randomUUID()}`,
      });
      expect(atTerminal.status).toBe("PENDING_APPROVAL");
    });
});
