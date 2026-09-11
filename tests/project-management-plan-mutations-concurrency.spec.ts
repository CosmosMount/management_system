// @playwright-project node-db
import { expect, test } from "@playwright/test";
import type { TaskMemberRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { expectedProjectManagementRecipients } from "./helpers/project-management-notification-recipients";
import { activateTask } from "../lib/project-management/application/lifecycle-service";
import { createWorkSegment } from "../lib/project-management/application/segment-service";
import { updateActiveTask, updateTaskDraft } from "../lib/project-management/application/task-mutation-service";

import {
  AccountPerson,
  MUTATION_ACTION_CASES,
  actor,
  createAccountPerson,
  createDraft,
  currentPlan,
  currentTask,
  expectMutationBusinessEffect,
  expectServiceError,
  grantRole,
  installControlledAuditFailureTrigger,
  installControlledMemberOutboxFailureTrigger,
  invokeMutationAction,
  iso,
  jsonRecord,
  mutationSideEffectCounts,
  planMilestoneReplacement,
  planTerminationReplacement,
  removeControlledAuditFailureTrigger,
  removeControlledMemberOutboxFailureTrigger,
  runBehindTaskLockBarrier,
  runTaskAssociationLockChain,
  serviceOutcomeCodes,
} from "./helpers/project-management-plan-mutation-fixtures";

test.describe("project management plan mutations project-management-plan-mutations-concurrency", () => {
  test("both supported mutation actions enforce visible authorization, lifecycle and stale matrices with zero rejected effects", async () => {
      const admin = await createAccountPerson("S2 Matrix Admin");
      const owner = await createAccountPerson("S2 Matrix Owner");
      const reviewer = await createAccountPerson("S2 Matrix Reviewer");
      const viewer = await createAccountPerson("S2 Matrix Viewer");
      const outsider = await createAccountPerson("S2 Matrix Outsider");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");

      const fixtures = new Map<string, Awaited<ReturnType<typeof createDraft>>>();
      for (const status of [
        "DRAFT",
        "ACTIVE",
        "COMPLETED",
        "FAILED",
        "CANCELLED",
        "TIMEOUT",
        "ARCHIVED",
      ] as const) {
        const fixture = await createDraft({
          creator: admin,
          owner,
          reviewer,
          title: `S2 matrix ${status}`,
        });
        if (status !== "DRAFT") {
          await activateTask(actor(owner), {
            taskId: fixture.taskId,
            expectedLockVersion: 0,
          });
          if (status !== "ACTIVE") {
            await prisma.task.update({
              where: { id: fixture.taskId },
              data: { status },
            });
          }
        }
        fixtures.set(status, fixture);
      }

      for (const mutationCase of MUTATION_ACTION_CASES) {
        const allowedFixture = fixtures.get(mutationCase.requiredStatus);
        if (!allowedFixture) throw new Error("缺少 mutation 状态 fixture");
        const allowedTask = await currentTask(allowedFixture.taskId);
        const beforeUnauthorized = await mutationSideEffectCounts(
          allowedFixture.taskId,
        );
        await expectServiceError(
          invokeMutationAction(
            mutationCase.name,
            actor(viewer),
            allowedFixture,
            allowedTask.lockVersion,
          ),
          "FORBIDDEN",
        );
        expect(await mutationSideEffectCounts(allowedFixture.taskId)).toEqual(
          beforeUnauthorized,
        );

        await expectServiceError(
          invokeMutationAction(
            mutationCase.name,
            actor(outsider),
            allowedFixture,
            allowedTask.lockVersion,
          ),
          "FORBIDDEN",
        );
        expect(await mutationSideEffectCounts(allowedFixture.taskId)).toEqual(
          beforeUnauthorized,
        );

        await expectServiceError(
          invokeMutationAction(
            mutationCase.name,
            actor(owner),
            allowedFixture,
            allowedTask.lockVersion + 1,
          ),
          "STALE_TASK",
          { expectedCurrentLockVersion: allowedTask.lockVersion },
        );
        expect(await mutationSideEffectCounts(allowedFixture.taskId)).toEqual(
          beforeUnauthorized,
        );

        for (const [status, fixture] of fixtures) {
          if (status === mutationCase.requiredStatus) continue;
          const task = await currentTask(fixture.taskId);
          const before = await mutationSideEffectCounts(fixture.taskId);
          await expectServiceError(
            invokeMutationAction(
              mutationCase.name,
              actor(owner),
              fixture,
              task.lockVersion,
            ),
            "STATE_CONFLICT",
          );
          expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(before);
        }
      }
    });

  test("both supported mutation actions serialize the same lock version exactly once", async () => {
      const admin = await createAccountPerson("S2 Exactly Once Admin");
      const owner = await createAccountPerson("S2 Exactly Once Owner");
      const reviewer = await createAccountPerson("S2 Exactly Once Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");

      for (const mutationCase of MUTATION_ACTION_CASES) {
        let requestedMembers: Array<{
          personId: string;
          role: TaskMemberRole;
        }> | undefined;
        let expectedChangedPeople: AccountPerson[] = [];
        const extraMembers: Array<{
          personId: string;
          role: TaskMemberRole;
        }> = [];
        if (mutationCase.name === "updateActiveTask") {
          const removed = await createAccountPerson("S2 Concurrent Removed");
          const added = await createAccountPerson("S2 Concurrent Added");
          extraMembers.push({ personId: removed.person.id, role: "PARTICIPANT" });
          requestedMembers = [
            { personId: owner.person.id, role: "OWNER" },
            { personId: reviewer.person.id, role: "PARTICIPANT" },
            { personId: added.person.id, role: "PARTICIPANT" },
          ];
          expectedChangedPeople = [removed, added];
        }
        const fixture = await createDraft({
          creator: admin,
          owner,
          reviewer,
          title: `S2 exactly once ${mutationCase.name}`,
          extraMembers,
        });
        if (mutationCase.requiredStatus === "ACTIVE") {
          await activateTask(actor(owner), {
            taskId: fixture.taskId,
            expectedLockVersion: 0,
          });
        }
        const beforeTask = await currentTask(fixture.taskId);
        const beforeSnapshot = await mutationSideEffectCounts(fixture.taskId);
        const auditBefore = await prisma.domainAuditEvent.count({
          where: { taskId: fixture.taskId, action: mutationCase.auditAction },
        });
        const outcomes = await runBehindTaskLockBarrier(fixture.taskId, [
          () =>
            invokeMutationAction(
              mutationCase.name,
              actor(owner),
              fixture,
              beforeTask.lockVersion,
              { members: requestedMembers },
            ),
          () =>
            invokeMutationAction(
              mutationCase.name,
              actor(owner),
              fixture,
              beforeTask.lockVersion,
              { members: requestedMembers },
            ),
        ]);
        expect(serviceOutcomeCodes(outcomes)).toEqual(["OK", "STALE_TASK"]);
        expect((await currentTask(fixture.taskId)).lockVersion).toBe(
          beforeTask.lockVersion + 1,
        );
        expect(
          await prisma.domainAuditEvent.count({
            where: { taskId: fixture.taskId, action: mutationCase.auditAction },
          }),
        ).toBe(auditBefore + 1);
        expect(
          await prisma.notificationOutbox.count({
            where: {
              eventKey: `pm:task:${fixture.taskId}:updated:${beforeTask.lockVersion + 1}:feishu`,
            },
          }),
        ).toBe(1);
        const afterSnapshot = await mutationSideEffectCounts(fixture.taskId);
        expectMutationBusinessEffect(
          mutationCase.name,
          beforeSnapshot,
          afterSnapshot,
        );
        if (mutationCase.name === "updateActiveTask") {
          const eventPrefix = `pm:task:member_changed:${fixture.taskId}:${beforeTask.lockVersion + 1}:`;
          const outboxes = await prisma.notificationOutbox.findMany({
            where: { eventKey: { startsWith: eventPrefix } },
          });
          expect(outboxes).toHaveLength(expectedChangedPeople.length);
          expect(
            outboxes
              .map((row) =>
                String(
                  jsonRecord(jsonRecord(JSON.parse(row.payload)).context)
                    .affectedPersonId,
                ),
              )
              .sort(),
          ).toEqual(expectedChangedPeople.map((person) => person.person.id).sort());
          const inAppRows = await prisma.inAppNotification.findMany({
            where: { eventKey: { startsWith: eventPrefix } },
            select: { recipientAccountId: true },
          });
          const expectedPerEvent = await Promise.all(expectedChangedPeople.map((person) => expectedProjectManagementRecipients([person], "TASK", true)));
          expect(inAppRows.map((row) => row.recipientAccountId).sort()).toEqual(
            expectedPerEvent.flatMap((recipients) => recipients.accountIds).sort(),
          );
        }
      }
    });

  test("both supported mutation actions roll back business, audit, lock and notifications on a controlled late failure", async () => {
      const admin = await createAccountPerson("S2 Late Failure Admin");
      const owner = await createAccountPerson("S2 Late Failure Owner");
      const reviewer = await createAccountPerson("S2 Late Failure Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixtures: Array<{
        mutationCase: (typeof MUTATION_ACTION_CASES)[number];
        fixture: Awaited<ReturnType<typeof createDraft>>;
      }> = [];
      for (const mutationCase of MUTATION_ACTION_CASES) {
        const fixture = await createDraft({
          creator: admin,
          owner,
          reviewer,
          title: `S2 late failure ${mutationCase.name}`,
        });
        if (mutationCase.requiredStatus === "ACTIVE") {
          await activateTask(actor(owner), {
            taskId: fixture.taskId,
            expectedLockVersion: 0,
          });
        }
        fixtures.push({ mutationCase, fixture });
      }

      await installControlledAuditFailureTrigger();
      try {
        for (const { mutationCase, fixture } of fixtures) {
          const task = await currentTask(fixture.taskId);
          const before = await mutationSideEffectCounts(fixture.taskId);
          await expect(
            invokeMutationAction(
              mutationCase.name,
              actor(owner),
              fixture,
              task.lockVersion,
            ),
          ).rejects.toThrow("s2 controlled late audit failure");
          expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(before);
        }
      } finally {
        await removeControlledAuditFailureTrigger();
      }
    });

  test("Active member replacement rolls back after InApp write when outbox insertion fails", async () => {
      const admin = await createAccountPerson("S2 Outbox Rollback Admin");
      const owner = await createAccountPerson("S2 Outbox Rollback Owner");
      const reviewer = await createAccountPerson("S2 Outbox Rollback Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
      const fixture = await createDraft({ creator: admin, owner, reviewer });
      await activateTask(actor(owner), {
        taskId: fixture.taskId,
        expectedLockVersion: 0,
      });
      const before = await mutationSideEffectCounts(fixture.taskId);

      await installControlledMemberOutboxFailureTrigger();
      try {
        await expect(
          updateActiveTask(actor(owner), {
            taskId: fixture.taskId,
            expectedLockVersion: 1,
            members: [
              { personId: owner.person.id, role: "OWNER" },
            ],
          }),
        ).rejects.toThrow("s2 controlled outbox failure after inapp");
      } finally {
        await removeControlledMemberOutboxFailureTrigger();
      }
      expect(await mutationSideEffectCounts(fixture.taskId)).toEqual(before);
    });

  test("Task association lock orders Segment writer and Draft replace without deadlock", async () => {
      expect(new URL(process.env.DATABASE_URL ?? "").pathname).toMatch(/_test$/);
      const admin = await createAccountPerson("S2 Association Lock Admin");
      const owner = await createAccountPerson("S2 Association Lock Owner");
      const reviewer = await createAccountPerson("S2 Association Lock Reviewer");
      await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");

      for (const first of ["WRITER", "REPLACE"] as const) {
        const fixture = await createDraft({
          creator: admin,
          owner,
          reviewer,
          title: `S2 association order ${first}`,
        });
        const plan = await currentPlan(fixture.taskId);
        const retained = plan.nodes[0];
        const removed = plan.nodes[1];
        const termination = plan.nodes.at(-1);
        if (!retained?.node.milestone || !removed || !termination?.node.termination) {
          throw new Error("缺少关联锁测试计划节点");
        }
        const writer = () =>
          createWorkSegment(actor(owner), {
            personId: owner.person.id,
            startAt: new Date("2026-08-03T01:00:00.000Z"),
            endAt: new Date("2026-08-03T02:00:00.000Z"),
            content: `association writer ${first}`,
            taskId: fixture.taskId,
          });
        const replace = () =>
          updateTaskDraft(actor(owner), {
            taskId: fixture.taskId,
            planVersionId: fixture.currentPlanVersionId,
            expectedLockVersion: 0,
            title: `S2 association order ${first}`,
            description: "Task 关联锁顺序回归",
            team: "英雄",
            techGroup: "电控",
            priority: "MEDIUM",
            relatedTaskId: null,
            plannedStartAt: iso(2026, 8, 1),
            milestones: [planMilestoneReplacement(retained)],
            termination: planTerminationReplacement(termination),
          });
        const operations = first === "WRITER" ? [writer, replace] : [replace, writer];
        const outcomes = await runTaskAssociationLockChain(
          fixture.taskId,
          operations[0],
          operations[1],
        );
        const codes = serviceOutcomeCodes(outcomes);
        if (first === "WRITER") {
          expect(codes).toEqual(["OK", "OK"]);
          const segment = await prisma.workSegment.findFirstOrThrow({
            where: { taskId: fixture.taskId, content: `association writer ${first}` },
          });
          expect(segment.taskId).toBe(fixture.taskId);
          expect(await prisma.taskNode.findUnique({ where: { id: removed.nodeId } })).toBeNull();
        } else {
          expect(codes).toEqual(["OK", "OK"]);
          expect(
            await prisma.workSegment.count({
              where: { taskId: fixture.taskId, content: `association writer ${first}` },
            }),
          ).toBe(1);
          expect(await prisma.taskNode.findUnique({ where: { id: removed.nodeId } })).toBeNull();
        }
      }
    });
});
