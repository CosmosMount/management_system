import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { timeCanvasDataToModel } from "../components/project-management/time-canvas/adapter";
import { prisma } from "../lib/prisma";
import { createActualSegment, createWorkSegment } from "../lib/project-management/application/segment-service";
import { listTasks } from "../lib/project-management/queries/task-queries";
import { getResourcePlanSelectionPage } from "../lib/project-management/queries/resource-plan-queries";
import { resolvePeopleOptionsByIds, resolveTaskOptionsByIds, searchPeople, searchTaskOptions } from "../lib/project-management/queries/option-queries";
import { getResourcePlanPageData, getTimeCanvasData } from "../lib/project-management/queries/time-canvas-queries";

import {
  RANGE_START,
  actor,
  atHour,
  canvasInput,
  createAccountPerson,
  createSegment,
  createTask,
  createTaskOptionFixtures,
  expectErrorCode,
  grantScopedRole,
  resourcePlanCursorId,
  rewriteResourcePlanCursor,
  rowCanCreate,
  scopedRole,
  serviceErrorOf,
  systemAdministratorRole,
} from "./helpers/project-management-canvas-security-fixtures";

test.describe("project management canvas security project-management-canvas-option-safety", () => {
  test("People and Task options use minimal permission-filtered stable cursor pages", async () => {
      const optionKey = randomUUID();
      const sameNamePerson = `同名成员 ${optionKey}`;
      const sameNameTask = `同名 Task ${optionKey}`;
      const owner = await createAccountPerson(`选项 Owner ${optionKey}`);
      const visibleMember = await createAccountPerson(sameNamePerson);
      const visibleSegmentPerson = await createAccountPerson(sameNamePerson);
      const outsider = await createAccountPerson(`非成员 ${optionKey}`);
      const inactive = await createAccountPerson(
        `停用成员 ${optionKey}`,
        "INACTIVE",
      );
      const hiddenOwner = await createAccountPerson(`其他 Task Owner ${optionKey}`);
      const ownerActor = actor(owner);
      const adminActor = actor(owner, [systemAdministratorRole()]);
      const visibleTask = await createTask({
        ownerAccountId: owner.account.id,
        title: sameNameTask,
        team: "英雄",
        techGroup: "电控",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: visibleMember.person.id, role: "PARTICIPANT" },
        ],
      });
      const hiddenTask = await createTask({
        ownerAccountId: hiddenOwner.account.id,
        title: sameNameTask,
        team: "步兵",
        techGroup: "机械",
        members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
      });
      await createSegment({
        accountId: owner.account.id,
        personId: visibleSegmentPerson.person.id,
        taskId: visibleTask.taskId,
        startAt: atHour(9),
        endAt: atHour(10),
      });

      const people = await searchPeople({
        actor: ownerActor,
        input: { purpose: "VISIBLE", query: optionKey, limit: 50 },
      });
      expect(people.items.map((item) => item.id)).toEqual(
        expect.arrayContaining([
          owner.person.id,
          visibleMember.person.id,
          visibleSegmentPerson.person.id,
          outsider.person.id,
          hiddenOwner.person.id,
        ]),
      );
      expect(people.items.map((item) => item.id)).not.toContain(inactive.person.id);
      expect(
        people.items.every(
          (item) =>
            Object.keys(item).sort().join("|") ===
            [
              "accountBinding",
              "avatar",
              "displayName",
              "id",
              "status",
            ]
              .sort()
              .join("|"),
        ),
      ).toBe(true);

      const sameNamePage = await searchPeople({
        actor: ownerActor,
        input: { purpose: "VISIBLE", query: "同名成员", limit: 50 },
      });
      const sameNameIds = sameNamePage.items.map((item) => item.id);
      expect(new Set(sameNameIds).size).toBe(sameNameIds.length);
      expect(sameNameIds).toEqual(
        expect.arrayContaining([
          visibleMember.person.id,
          visibleSegmentPerson.person.id,
        ]),
      );
      await expectErrorCode(
        searchPeople({
          actor: adminActor,
          input: { purpose: "VISIBLE", cursor: "not-a-cursor" },
        }),
        "VALIDATION_ERROR",
      );
      const firstPeoplePage = await searchPeople({
        actor: adminActor,
        input: { purpose: "VISIBLE", limit: 1 },
      });
      await expectErrorCode(
        searchPeople({
          actor: adminActor,
          input: {
            purpose: "VISIBLE",
            query: `不同查询 ${optionKey}`,
            cursor: firstPeoplePage.nextCursor,
          },
        }),
        "VALIDATION_ERROR",
      );

      const taskOptions = await searchTaskOptions({
        actor: ownerActor,
        input: { query: sameNameTask },
      });
      expect(taskOptions.items.map((item) => item.id).sort()).toEqual(
        [visibleTask.taskId, hiddenTask.taskId].sort(),
      );
      expect(taskOptions.items[0]?.permission).toEqual({ canView: true });
      const taskList = await listTasks({
        actor: ownerActor,
        input: { query: sameNameTask, limit: 50 },
      });
      expect(taskList.items.map((item) => item.id).sort()).toEqual(
        [visibleTask.taskId, hiddenTask.taskId].sort(),
      );
      expect(taskList.nextCursor).toBeNull();
      const resolvedTasks = await resolveTaskOptionsByIds({
        actor: ownerActor,
        input: { ids: [hiddenTask.taskId, visibleTask.taskId] },
      });
      expect(resolvedTasks.map((item) => item.id)).toEqual([
        hiddenTask.taskId,
        visibleTask.taskId,
      ]);
      const resolvedPeople = await resolvePeopleOptionsByIds({
        actor: ownerActor,
        input: {
          scope: { purpose: "VISIBLE" },
          ids: [hiddenOwner.person.id, visibleSegmentPerson.person.id, visibleMember.person.id],
        },
      });
      expect(resolvedPeople.map((item) => item.id)).toEqual([
        hiddenOwner.person.id,
        visibleSegmentPerson.person.id,
        visibleMember.person.id,
      ]);
    });

  test("People purposes expose the active directory with safe account binding", async () => {
      const directoryKey = randomUUID();
      const directoryQuery = `成员目录 ${directoryKey}`;
      const owner = await createAccountPerson("成员目录 Owner");
      await prisma.systemRoleAssignment.create({
        data: {
          accountId: owner.account.id,
          role: "PROJECT_ADMINISTRATOR",
          team: "",
          techGroup: "",
        },
      });
      const teamAdmin = await createAccountPerson("成员目录 Team Admin");
      const ordinary = await createAccountPerson("成员目录普通成员");
      const hiddenOwner = await createAccountPerson("成员目录隐藏 Owner");
      const active = await createAccountPerson(`${directoryQuery} Active`);
      const bound = await createAccountPerson(`${directoryQuery} Bound`);
      const inactive = await createAccountPerson(
        `${directoryQuery} Inactive`,
        "INACTIVE",
      );
      const unbound = await prisma.person.create({
        data: { displayName: `${directoryQuery} Unbound`, status: "ACTIVE" },
      });
      const activeIdentityMarker = `active-identity-${randomUUID()}`;
      const boundIdentityMarker = `bound-identity-${randomUUID()}`;
      await prisma.accountIdentity.createMany({
        data: [
          {
            accountId: active.account.id,
            provider: "FEISHU",
            providerSubject: activeIdentityMarker,
            tenantId: `tenant-${activeIdentityMarker}`,
            openId: `ou_${activeIdentityMarker}`,
            unionId: `on_${activeIdentityMarker}`,
          },
          {
            accountId: bound.account.id,
            provider: "FEISHU",
            providerSubject: boundIdentityMarker,
            tenantId: `tenant-${boundIdentityMarker}`,
            openId: `ou_${boundIdentityMarker}`,
            unionId: `on_${boundIdentityMarker}`,
          },
        ],
      });
      const task = await createTask({
        ownerAccountId: owner.account.id,
        title: "成员目录可管理 Task",
        team: "英雄",
        techGroup: "电控",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: ordinary.person.id, role: "PARTICIPANT" },
          { personId: inactive.person.id, role: "PARTICIPANT" },
        ],
      });
      const hiddenTask = await createTask({
        ownerAccountId: hiddenOwner.account.id,
        title: "成员目录隐藏 Task",
        team: "步兵",
        techGroup: "机械",
        members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
      });
      const ownerActor = actor(owner);
      const teamAdminActor = actor(teamAdmin, [
        scopedRole("英雄", "电控"),
      ]);
      const ordinaryActor = actor(ordinary);
      const systemActor = actor(owner, [systemAdministratorRole()]);

      const ordinaryVisible = await searchPeople({
        actor: ordinaryActor,
        input: { purpose: "VISIBLE", query: directoryQuery },
      });
      expect(ordinaryVisible.items.map((item) => item.id)).toEqual(
        expect.arrayContaining([
          active.person.id,
          bound.person.id,
          unbound.id,
        ]),
      );
      expect(ordinaryVisible.items.map((item) => item.id)).not.toContain(
        inactive.person.id,
      );

      const systemVisible = await searchPeople({
        actor: systemActor,
        input: { purpose: "VISIBLE", query: directoryQuery },
      });
      expect(systemVisible.items.map((item) => item.id)).toEqual(
        expect.arrayContaining([
          active.person.id,
          bound.person.id,
          unbound.id,
        ]),
      );
      expect(systemVisible.items.map((item) => item.id)).not.toContain(
        inactive.person.id,
      );

      for (const input of [
        {
          purpose: "TASK_CREATE" as const,
          team: "英雄" as const,
          techGroup: "电控" as const,
          query: directoryQuery,
        },
        {
          purpose: "TASK_MEMBERS" as const,
          taskId: task.taskId,
          query: directoryQuery,
        },
      ]) {
        const page = await searchPeople({ actor: systemActor, input });
        expect(page.items.map((item) => item.id)).toEqual(
          expect.arrayContaining([
            active.person.id,
            bound.person.id,
            unbound.id,
          ]),
        );
        expect(page.items.map((item) => item.id)).not.toContain(
          inactive.person.id,
        );
      }

      const ownerMembers = await searchPeople({
        actor: ownerActor,
        input: {
          purpose: "TASK_MEMBERS",
          taskId: task.taskId,
          query: directoryQuery,
        },
      });
      expect(
        ownerMembers.items.map((item) => [item.id, item.accountBinding]),
      ).toEqual(
        expect.arrayContaining([
          [active.person.id, "BOUND"],
          [bound.person.id, "BOUND"],
          [unbound.id, "UNBOUND"],
        ]),
      );
      expect(ownerMembers.items.map((item) => item.id)).not.toContain(
        inactive.person.id,
      );
      for (const item of ownerMembers.items) {
        expect(Object.keys(item).sort()).toEqual(
          [
            "accountBinding",
            "avatar",
            "displayName",
            "id",
            "status",
          ].sort(),
        );
      }
      await expect(
        searchPeople({
          actor: ordinaryActor,
          input: {
            purpose: "TASK_SEGMENT_CREATE",
            taskId: task.taskId,
            limit: 50,
          },
        }),
      ).resolves.toMatchObject({
        items: [expect.objectContaining({ id: ordinary.person.id })],
      });
      await expect(
        searchPeople({
          actor: ownerActor,
          input: {
            purpose: "TASK_SEGMENT_CREATE",
            taskId: task.taskId,
            limit: 50,
          },
        }),
      ).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ id: owner.person.id }),
          expect.objectContaining({ id: ordinary.person.id }),
        ]),
      });
      await expect(
        searchPeople({
          actor: teamAdminActor,
          input: {
            purpose: "TASK_SEGMENT_CREATE",
            taskId: task.taskId,
            limit: 50,
          },
        }),
      ).resolves.toMatchObject({ items: [] });
      await expect(
        resolvePeopleOptionsByIds({
          actor: ordinaryActor,
          input: {
            scope: {
              purpose: "TASK_SEGMENT_CREATE",
              taskId: task.taskId,
            },
            ids: [owner.person.id, ordinary.person.id],
          },
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: ordinary.person.id }),
      ]);
      await expect(
        resolvePeopleOptionsByIds({
          actor: ownerActor,
          input: {
            scope: {
              purpose: "TASK_SEGMENT_CREATE",
              taskId: task.taskId,
            },
            ids: [owner.person.id, ordinary.person.id, inactive.person.id],
          },
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: owner.person.id }),
        expect.objectContaining({ id: ordinary.person.id }),
      ]);
      const serialized = JSON.stringify(ownerMembers);
      for (const sensitive of [
        active.account.id,
        bound.account.id,
        activeIdentityMarker,
        boundIdentityMarker,
        `tenant-${activeIdentityMarker}`,
        `tenant-${boundIdentityMarker}`,
      ]) {
        expect(serialized).not.toContain(sensitive);
      }

      for (const searchActor of [teamAdminActor, ordinaryActor]) {
        const page = await searchPeople({
          actor: searchActor,
          input: {
            purpose: "TASK_CREATE",
            team: "英雄",
            techGroup: "电控",
            query: directoryQuery,
          },
        });
        expect(page.items.map((item) => item.id)).toEqual(
          expect.arrayContaining([
            active.person.id,
            bound.person.id,
            unbound.id,
          ]),
        );
        expect(page.items.map((item) => item.id)).not.toContain(
          inactive.person.id,
        );
      }

      expect(
        (
          await searchPeople({
            actor: teamAdminActor,
            input: {
              purpose: "TASK_CREATE",
              team: "步兵",
              techGroup: "机械",
              query: directoryQuery,
            },
          })
        ).items.map((item) => item.id),
      ).toEqual(expect.arrayContaining([active.person.id, unbound.id]));
      await expectErrorCode(
        searchPeople({
          actor: teamAdminActor,
          input: {
            purpose: "TASK_MEMBERS",
            taskId: hiddenTask.taskId,
            query: directoryQuery,
          },
        }),
        "FORBIDDEN",
      );
      await expectErrorCode(
        searchPeople({
          actor: ordinaryActor,
          input: {
            purpose: "TASK_MEMBERS",
            taskId: task.taskId,
            query: directoryQuery,
          },
        }),
        "FORBIDDEN",
      );
      await expect(
        resolvePeopleOptionsByIds({
          actor: ordinaryActor,
          input: {
            scope: { purpose: "TASK_CREATE", team: "英雄", techGroup: "电控" },
            ids: [active.person.id],
          },
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: active.person.id, accountBinding: "BOUND" }),
      ]);
      await expectErrorCode(
        resolvePeopleOptionsByIds({
          actor: ordinaryActor,
          input: {
            scope: { purpose: "TASK_MEMBERS", taskId: task.taskId },
            ids: [active.person.id],
          },
        }),
        "FORBIDDEN",
      );

      const randomTaskError = await serviceErrorOf(
        searchPeople({
          actor: ordinaryActor,
          input: { purpose: "TASK_MEMBERS", taskId: randomUUID() },
        }),
      );
      const hiddenTaskError = await serviceErrorOf(
        searchPeople({
          actor: ordinaryActor,
          input: { purpose: "TASK_MEMBERS", taskId: hiddenTask.taskId },
        }),
      );
      expect(randomTaskError.code).toBe("NOT_FOUND");
      expect(hiddenTaskError.code).toBe("FORBIDDEN");

      await expectErrorCode(
        searchPeople({ actor: systemActor, input: { query: directoryQuery } }),
        "VALIDATION_ERROR",
      );
      await expectErrorCode(
        searchPeople({
          actor: systemActor,
          input: {
            purpose: "VISIBLE",
            team: "英雄",
            query: directoryQuery,
          },
        }),
        "VALIDATION_ERROR",
      );
      await expectErrorCode(
        searchPeople({
          actor: systemActor,
          input: { purpose: "TASK_CREATE", query: directoryQuery },
        }),
        "VALIDATION_ERROR",
      );
      await expectErrorCode(
        searchPeople({
          actor: systemActor,
          input: {
            purpose: "TASK_CREATE",
            team: "不存在车组",
            techGroup: "电控",
            query: directoryQuery,
          },
        }),
        "VALIDATION_ERROR",
      );
      await expectErrorCode(
        searchPeople({
          actor: systemActor,
          input: {
            purpose: "TASK_CREATE",
            team: "英雄",
            techGroup: "不存在技术组",
            query: directoryQuery,
          },
        }),
        "VALIDATION_ERROR",
      );
      await expectErrorCode(
        searchPeople({
          actor: systemActor,
          input: { purpose: "TASK_MEMBERS", query: directoryQuery },
        }),
        "VALIDATION_ERROR",
      );
    });

  test("resource plan expands Project, Task and Person unions and pins focused rows", async () => {
      const owner = await createAccountPerson("资源计划 Owner");
      const taskMember = await createAccountPerson("资源计划 Task 成员");
      const projectMember = await createAccountPerson("资源计划 Project 成员");
      const selectedPerson = await createAccountPerson("资源计划直接选择人员");
      const project = await prisma.project.create({
        data: {
          name: `资源计划 Project ${randomUUID()}`,
          description: "资源计划集合展开测试",
          status: "ACTIVE",
          requesterAccountId: owner.account.id,
          startedAt: new Date(),
        },
      });
      await prisma.projectMember.create({
        data: {
          projectId: project.id,
          personId: projectMember.person.id,
          role: "OWNER",
          createdByAccountId: owner.account.id,
        },
      });
      const task = await createTask({
        ownerAccountId: owner.account.id,
        title: `资源计划 Task ${randomUUID()}`,
        team: "英雄",
        techGroup: "电控",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: taskMember.person.id, role: "PARTICIPANT" },
        ],
      });
      await prisma.task.update({
        where: { id: task.taskId },
        data: { projectId: project.id },
      });

      const expanded = await getResourcePlanSelectionPage({
        actor: actor(owner),
        input: {
          all: false,
          projectIds: [project.id],
          taskIds: [],
          personIds: [selectedPerson.person.id],
        },
      });
      expect(expanded.taskIds).toContain(task.taskId);
      expect(expanded.personIds).toEqual(expect.arrayContaining([
        owner.person.id,
        taskMember.person.id,
        projectMember.person.id,
        selectedPerson.person.id,
      ]));

      const pinned = await getResourcePlanSelectionPage({
        actor: actor(owner),
        input: {
          all: true,
          projectIds: [],
          taskIds: [],
          personIds: [],
          pinnedTaskIds: [task.taskId],
          pinnedPersonIds: [selectedPerson.person.id],
        },
      });
      expect(pinned.taskIds[0]).toBe(task.taskId);
      expect(pinned.personIds[0]).toBe(selectedPerson.person.id);
    });

  test("resource plan validates independent Task and Person cursors against the current selection", async () => {
      const owner = await createAccountPerson(`资源计划游标 Owner ${randomUUID()}`);
      await prisma.systemRoleAssignment.create({
        data: {
          accountId: owner.account.id,
          role: "PROJECT_ADMINISTRATOR",
          grantedByAccountId: owner.account.id,
        },
      });
      const project = await prisma.project.create({
        data: {
          name: `资源计划游标 Project ${randomUUID()}`,
          description: "独立游标约束回归",
          status: "ACTIVE",
          requesterAccountId: owner.account.id,
          startedAt: new Date(),
        },
      });
      const taskIds = await createTaskOptionFixtures({
        ownerAccountId: owner.account.id,
        ownerPersonId: owner.person.id,
        titlePrefix: `000 资源计划游标 Task ${randomUUID()}`,
        count: 27,
        withTerminationNodes: true,
      });
      await prisma.task.updateMany({
        where: { id: { in: taskIds } },
        data: { projectId: project.id },
      });
      const people = Array.from({ length: 52 }, (_, index) => ({
        id: randomUUID(),
        displayName: `000 资源计划游标 Person ${String(index).padStart(2, "0")} ${project.id}`,
        status: "ACTIVE" as const,
      }));
      await prisma.person.createMany({ data: people });
      await prisma.taskMember.createMany({
        data: people.map((person) => ({
          taskId: taskIds[0]!,
          personId: person.id,
          role: "PARTICIPANT" as const,
          createdByAccountId: owner.account.id,
        })),
      });
      const input = {
        all: false,
        projectIds: [project.id],
        taskIds: [],
        personIds: [],
      };
      const first = await getResourcePlanSelectionPage({ actor: actor(owner), input });
      expect(first.taskIds).toHaveLength(25);
      expect(first.personIds).toHaveLength(50);
      expect(first.nextTaskCursor).not.toBeNull();
      expect(first.nextPersonCursor).not.toBeNull();

      const assembled = await getResourcePlanPageData({
        actor: actor(owner),
        input,
        preferredCenterMs: Date.parse(RANGE_START),
        load: { mode: "INITIAL" },
      });
      expect(assembled.selection.taskIds).toEqual(first.taskIds);
      expect(assembled.selection.personIds).toEqual(first.personIds);
      expect(assembled.data.anchors).toHaveLength(25);
      expect(
        timeCanvasDataToModel(assembled.data, "RESOURCE_PLANNER").rows.filter(
          (row) => row.kind === "PLAN",
        ),
      ).toHaveLength(25);
      expect(assembled.data.rows.filter((row) => row.kind === "PERSON")).toHaveLength(50);

      const taskSecond = await getResourcePlanSelectionPage({
        actor: actor(owner),
        input: { ...input, taskCursor: first.nextTaskCursor },
      });
      expect(taskSecond.taskIds).toHaveLength(2);
      expect(taskSecond.personIds).toEqual(first.personIds);
      const personSecond = await getResourcePlanSelectionPage({
        actor: actor(owner),
        input: { ...input, personCursor: first.nextPersonCursor },
      });
      expect(personSecond.taskIds).toEqual(first.taskIds);
      expect(personSecond.personIds.length).toBeGreaterThan(0);
      expect(personSecond.personIds.length).toBeLessThanOrEqual(3);

      const forgedTaskCursor = rewriteResourcePlanCursor(
        first.nextTaskCursor!,
        randomUUID(),
      );
      const forgedPersonCursor = rewriteResourcePlanCursor(
        first.nextPersonCursor!,
        randomUUID(),
      );
      await expectErrorCode(
        getResourcePlanSelectionPage({
          actor: actor(owner),
          input: { ...input, taskCursor: forgedTaskCursor },
        }),
        "VALIDATION_ERROR",
      );
      await expectErrorCode(
        getResourcePlanSelectionPage({
          actor: actor(owner),
          input: { ...input, personCursor: forgedPersonCursor },
        }),
        "VALIDATION_ERROR",
      );
      await expectErrorCode(
        getResourcePlanSelectionPage({
          actor: actor(owner),
          input: {
            ...input,
            projectIds: [],
            taskIds: [taskIds[0]!],
            taskCursor: first.nextTaskCursor,
          },
        }),
        "VALIDATION_ERROR",
      );

      const expiredTaskId = resourcePlanCursorId(first.nextTaskCursor!);
      await prisma.task.update({
        where: { id: expiredTaskId },
        data: { deletedAt: new Date() },
      });
      await expectErrorCode(
        getResourcePlanSelectionPage({
          actor: actor(owner),
          input: { ...input, taskCursor: first.nextTaskCursor },
        }),
        "VALIDATION_ERROR",
      );

      const expiredPersonId = resourcePlanCursorId(first.nextPersonCursor!);
      await prisma.taskMember.updateMany({
        where: { taskId: taskIds[0]!, personId: expiredPersonId, removedAt: null },
        data: { removedAt: new Date() },
      });
      await expectErrorCode(
        getResourcePlanSelectionPage({
          actor: actor(owner),
          input: { ...input, personCursor: first.nextPersonCursor },
        }),
        "VALIDATION_ERROR",
      );
    });

  test("People and Task cap fuzzy candidates at 501 while empty queries retain bound cursors", async () => {
      const owner = await createAccountPerson("选项游标 Owner");
      const ownerActor = actor(owner);
      const adminActor = actor(owner, [systemAdministratorRole()]);
      const queryKey = randomUUID();
      const peopleQuery = `游标边界 Person ${queryKey}`;
      const taskQuery = `游标边界 Task ${queryKey}`;
      const taskIds = await createTaskOptionFixtures({
        ownerAccountId: owner.account.id,
        ownerPersonId: owner.person.id,
        titlePrefix: taskQuery,
        count: 502,
      });
      const personIds = Array.from({ length: 502 }, () => randomUUID());
      await prisma.person.createMany({
        data: personIds.map((id) => ({
          id,
          displayName: peopleQuery,
          status: "ACTIVE",
        })),
      });
      await prisma.taskMember.createMany({
        data: personIds.map((personId) => ({
          taskId: taskIds[0]!,
          personId,
          role: "PARTICIPANT",
          createdByAccountId: owner.account.id,
        })),
      });

      const firstPeoplePage = await searchPeople({
        actor: adminActor,
        input: { purpose: "VISIBLE", query: peopleQuery, limit: 50 },
      });
      expect(firstPeoplePage.items).toHaveLength(50);
      expect(firstPeoplePage.nextCursor).toBeNull();
      expect(firstPeoplePage.hasMoreByQuery).toBe(true);
      expect(personIds).toEqual(expect.arrayContaining(firstPeoplePage.items.map((item) => item.id)));
      await prisma.person.update({
        where: { id: personIds[0]! },
        data: { status: "INACTIVE" },
      });
      const restoredPeople = await resolvePeopleOptionsByIds({
        actor: adminActor,
        input: {
          scope: { purpose: "VISIBLE" },
          ids: [personIds[1]!, personIds[0]!],
        },
      });
      expect(restoredPeople.map((item) => [item.id, item.status])).toEqual([
        [personIds[1], "ACTIVE"],
        [personIds[0], "INACTIVE"],
      ]);
      const peopleCursorPage = await searchPeople({
        actor: adminActor,
        input: { purpose: "VISIBLE", limit: 1 },
      });
      expect(peopleCursorPage.nextCursor).not.toBeNull();

      const firstTaskPage = await searchTaskOptions({
        actor: ownerActor,
        input: { query: taskQuery, limit: 50 },
      });
      expect(firstTaskPage.items).toHaveLength(50);
      expect(firstTaskPage.nextCursor).toBeNull();
      expect(firstTaskPage.hasMoreByQuery).toBe(true);
      expect(taskIds).toEqual(expect.arrayContaining(firstTaskPage.items.map((item) => item.id)));
      const taskCursorPage = await searchTaskOptions({
        actor: ownerActor,
        input: { limit: 1 },
      });
      expect(taskCursorPage.nextCursor).not.toBeNull();


      await expectErrorCode(
        searchPeople({
          actor: adminActor,
          input: {
            purpose: "VISIBLE",
            query: `${peopleQuery} changed`,
            cursor: peopleCursorPage.nextCursor ?? undefined,
          },
        }),
        "VALIDATION_ERROR",
      );
      const taskCreatePeoplePage = await searchPeople({
        actor: adminActor,
        input: {
          purpose: "TASK_CREATE",
          team: "英雄",
          techGroup: "电控",
          limit: 1,
        },
      });
      expect(taskCreatePeoplePage.nextCursor).not.toBeNull();
      await expectErrorCode(
        searchPeople({
          actor: adminActor,
          input: {
            purpose: "VISIBLE",
            cursor: taskCreatePeoplePage.nextCursor ?? undefined,
          },
        }),
        "VALIDATION_ERROR",
      );
      await expectErrorCode(
        searchPeople({
          actor: adminActor,
          input: {
            purpose: "TASK_CREATE",
            team: "步兵",
            techGroup: "机械",
            cursor: taskCreatePeoplePage.nextCursor ?? undefined,
          },
        }),
        "VALIDATION_ERROR",
      );
      const taskMembersPeoplePage = await searchPeople({
        actor: adminActor,
        input: {
          purpose: "TASK_MEMBERS",
          taskId: taskIds[0]!,
          limit: 1,
        },
      });
      expect(taskMembersPeoplePage.nextCursor).not.toBeNull();
      await expectErrorCode(
        searchPeople({
          actor: adminActor,
          input: {
            purpose: "TASK_MEMBERS",
            taskId: taskIds[1]!,
            cursor: taskMembersPeoplePage.nextCursor ?? undefined,
          },
        }),
        "VALIDATION_ERROR",
      );
      await expectErrorCode(
        searchTaskOptions({
          actor: adminActor,
          input: {
            query: taskQuery,
            cursor: peopleCursorPage.nextCursor ?? undefined,
          },
        }),
        "VALIDATION_ERROR",
      );
      await expectErrorCode(
        searchTaskOptions({
          actor: ownerActor,
          input: { query: taskQuery, limit: 51 },
        }),
        "QUERY_LIMIT_EXCEEDED",
      );
      await expectErrorCode(
        resolvePeopleOptionsByIds({
          actor: adminActor,
          input: {
            scope: { purpose: "VISIBLE" },
            ids: personIds.slice(0, 51),
          },
        }),
        "QUERY_LIMIT_EXCEEDED",
      );
      await expectErrorCode(
        resolveTaskOptionsByIds({
          actor: ownerActor,
          input: { ids: taskIds.slice(0, 51) },
        }),
        "QUERY_LIMIT_EXCEEDED",
      );
      await expectErrorCode(
        searchPeople({
          actor: adminActor,
          input: { purpose: "VISIBLE", query: peopleQuery, limit: 51 },
        }),
        "QUERY_LIMIT_EXCEEDED",
      );
    });

  test("PERSON row creation capabilities use eligible Task existence without granting retired leaders write access", async () => {
      const resourceManager = await createAccountPerson("Capability Resource Manager");
      const teamAdmin = await createAccountPerson("Capability Team Admin");
      const owner = await createAccountPerson("Capability Owner");
      const target = await createAccountPerson("Capability 目标人员");
      const viewer = await createAccountPerson("Capability Viewer");
      const inactiveMember = await createAccountPerson("Capability 停用成员");
      const outOfScopePerson = await createAccountPerson("Capability 越界人员");
      const unassignedPerson = await createAccountPerson("Capability 未加入 Task");
      const resourceManagerActor = actor(resourceManager, [systemAdministratorRole()]);
      const teamAdminActor = actor(teamAdmin, [
        scopedRole("英雄", "电控"),
      ]);
      await Promise.all([
        prisma.systemRoleAssignment.create({
          data: {
            accountId: resourceManager.account.id,
            role: "PROJECT_ADMINISTRATOR",
          },
        }),
        grantScopedRole(teamAdmin.account.id, "英雄", "电控"),
      ]);
      const activeTask = await createTask({
        ownerAccountId: owner.account.id,
        title: "Capability Active",
        team: "英雄",
        techGroup: "电控",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: target.person.id, role: "PARTICIPANT" },
          { personId: viewer.person.id, role: "PARTICIPANT" },
          { personId: inactiveMember.person.id, role: "PARTICIPANT" },
        ],
      });
      await prisma.person.update({
        where: { id: inactiveMember.person.id },
        data: { status: "INACTIVE" },
      });
      const draftTask = await createTask({
        ownerAccountId: owner.account.id,
        title: "Capability Draft",
        team: "英雄",
        techGroup: "电控",
        status: "DRAFT",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: target.person.id, role: "PARTICIPANT" },
        ],
      });
      const terminalTasks = await Promise.all(
        (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ARCHIVED"] as const).map(
          (status) =>
            createTask({
              ownerAccountId: owner.account.id,
              title: `Capability ${status}`,
              team: "英雄",
              techGroup: "电控",
              status,
              members: [
                { personId: owner.person.id, role: "OWNER" },
                { personId: target.person.id, role: "PARTICIPANT" },
              ],
            }),
        ),
      );
      const outOfScopeTask = await createTask({
        ownerAccountId: owner.account.id,
        title: "Capability 越界 Task",
        team: "步兵",
        techGroup: "机械",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: outOfScopePerson.person.id, role: "PARTICIPANT" },
        ],
      });

      const administratorCanvas = await getTimeCanvasData({
        actor: resourceManagerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [target.person.id, unassignedPerson.person.id],
        }),
      });
      expect(rowCanCreate(administratorCanvas, target.person.id)).toBe(true);
      expect(rowCanCreate(administratorCanvas, unassignedPerson.person.id)).toBe(
        false,
      );
      const ownerCanvas = await getTimeCanvasData({
        actor: actor(owner),
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [target.person.id, unassignedPerson.person.id],
        }),
      });
      expect(rowCanCreate(ownerCanvas, target.person.id)).toBe(true);
      expect(rowCanCreate(ownerCanvas, unassignedPerson.person.id)).toBe(false);
      for (const createActor of [resourceManagerActor, actor(owner)]) {
        const singleTaskNonMemberCanvas = await getTimeCanvasData({
          actor: createActor,
          input: canvasInput({
            scope: { kind: "RESOURCE_PLANNER" },
            groupBy: "PERSON",
            personIds: [unassignedPerson.person.id],
            taskIds: [activeTask.taskId],
          }),
        });
        expect(
          rowCanCreate(singleTaskNonMemberCanvas, unassignedPerson.person.id),
        ).toBe(false);
      }
      const selfFilteredToNonMemberTask = await getTimeCanvasData({
        actor: actor(unassignedPerson),
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [unassignedPerson.person.id],
          taskIds: [activeTask.taskId],
        }),
      });
      expect(
        rowCanCreate(selfFilteredToNonMemberTask, unassignedPerson.person.id),
      ).toBe(false);
      const inactiveMemberTaskCanvas = await getTimeCanvasData({
        actor: actor(inactiveMember),
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "TASK",
          taskIds: [activeTask.taskId],
        }),
      });
      expect(rowCanCreate(inactiveMemberTaskCanvas, activeTask.taskId)).toBe(false);
      const retiredLeaderCanvas = await getTimeCanvasData({
        actor: teamAdminActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [target.person.id],
        }),
      });
      expect(rowCanCreate(retiredLeaderCanvas, target.person.id)).toBe(false);
      for (const canvas of [administratorCanvas, retiredLeaderCanvas]) {
        expect(canvas.rows.map((row) => row.id)).toContain(target.person.id);
      }

      const allPeopleCanvas = await getTimeCanvasData({
        actor: teamAdminActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [outOfScopePerson.person.id],
        }),
      });
      expect(allPeopleCanvas.rows.map((row) => row.id)).toContain(
        outOfScopePerson.person.id,
      );

      const singleTerminal = await getTimeCanvasData({
        actor: resourceManagerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [target.person.id],
          taskIds: [terminalTasks[0]!.taskId],
        }),
      });
      expect(rowCanCreate(singleTerminal, target.person.id)).toBe(false);
      const deniedWriteCounts = {
        segments: await prisma.workSegment.count({
          where: { personId: target.person.id },
        }),
        changes: await prisma.workSegmentChange.count(),
        audits: await prisma.domainAuditEvent.count(),
        outbox: await prisma.notificationOutbox.count({
          where: { channel: "project-management" },
        }),
      };
      for (const [index, task] of terminalTasks.entries()) {
        await expectErrorCode(
          createWorkSegment(resourceManagerActor, {
            personId: target.person.id,
            type: "PLANNED",
            startAt: atHour(14 + index * 0.1),
            endAt: atHour(14.05 + index * 0.1),
            content: `禁止关联终态 Task ${index}`,
            taskId: task.taskId,
          }),
          "ASSOCIATION_INVALID",
        );
        await expectErrorCode(
          createActualSegment(teamAdminActor, {
            personId: target.person.id,
            startAt: atHour(15 + index * 0.1),
            endAt: atHour(15.05 + index * 0.1),
            content: `禁止 Actual 关联终态 Task ${index}`,
            taskId: task.taskId,
          }),
          "FORBIDDEN",
        );
      }
      expect({
        segments: await prisma.workSegment.count({
          where: { personId: target.person.id },
        }),
        changes: await prisma.workSegmentChange.count(),
        audits: await prisma.domainAuditEvent.count(),
        outbox: await prisma.notificationOutbox.count({
          where: { channel: "project-management" },
        }),
      }).toEqual(deniedWriteCounts);

      const activeCreated = await createWorkSegment(resourceManagerActor, {
        personId: target.person.id,
        type: "PLANNED",
        startAt: atHour(15),
        endAt: atHour(16),
        content: "允许关联 Active Task",
        taskId: activeTask.taskId,
      });
      expect(activeCreated.segment.taskId).toBe(activeTask.taskId);
      const draftCreated = await createWorkSegment(resourceManagerActor, {
        personId: target.person.id,
        type: "PLANNED",
        startAt: atHour(16),
        endAt: atHour(17),
        content: "允许关联 Draft Task",
        taskId: draftTask.taskId,
      });
      expect(draftCreated.segment.taskId).toBe(draftTask.taskId);
      const mixedTasks = await getTimeCanvasData({
        actor: resourceManagerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [target.person.id],
          taskIds: [activeTask.taskId, terminalTasks[0]!.taskId],
        }),
      });
      expect(rowCanCreate(mixedTasks, target.person.id)).toBe(true);
      const terminalOnlyTasks = await getTimeCanvasData({
        actor: resourceManagerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [target.person.id],
          taskIds: [terminalTasks[0]!.taskId, terminalTasks[1]!.taskId],
        }),
      });
      expect(rowCanCreate(terminalOnlyTasks, target.person.id)).toBe(false);

      for (const [index, status] of [
        "COMPLETED",
        "FAILED",
        "CANCELLED",
        "TIMEOUT",
        "ARCHIVED",
      ].entries()) {
        const terminalCanvas = await getTimeCanvasData({
          actor: actor(owner),
          input: canvasInput({
            scope: {
              kind: "TASK_SCOPED",
              taskId: terminalTasks[index]!.taskId,
            },
            groupBy: "PERSON",
            personIds: [owner.person.id],
          }),
        });
        expect(rowCanCreate(terminalCanvas, owner.person.id), status).toBe(false);
      }

      const viewerCanvas = await getTimeCanvasData({
        actor: actor(viewer),
        input: canvasInput({
          scope: { kind: "TASK_SCOPED", taskId: activeTask.taskId },
          groupBy: "PERSON",
        }),
      });
      expect(rowCanCreate(viewerCanvas, viewer.person.id)).toBe(true);
      expect(rowCanCreate(viewerCanvas, target.person.id)).toBe(false);

      const independent = await createAccountPerson("Capability 独立 Segment 本人");
      const personalCanvas = await getTimeCanvasData({
        actor: actor(independent),
        input: canvasInput({
          scope: { kind: "PERSONAL" },
          groupBy: "PERSON",
        }),
      });
      expect(rowCanCreate(personalCanvas, independent.person.id)).toBe(true);

      const groupLeaderTaskFilter = await getTimeCanvasData({
        actor: resourceManagerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          taskIds: [activeTask.taskId],
        }),
      });
      expect(groupLeaderTaskFilter.anchors.map((anchor) => anchor.id)).toContain(
        activeTask.taskId,
      );
      expect(
        (
          await getTimeCanvasData({
            actor: teamAdminActor,
            input: canvasInput({
              scope: { kind: "RESOURCE_PLANNER" },
              groupBy: "PERSON",
              taskIds: [outOfScopeTask.taskId],
            }),
          })
        ).anchors.map((anchor) => anchor.id),
      ).toContain(outOfScopeTask.taskId);
    });
});
