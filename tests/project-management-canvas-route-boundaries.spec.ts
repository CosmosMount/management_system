// @playwright-project ui
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { loginAsTestUser } from "./helpers/functional-fixtures";

import {
  RANGE_END,
  RANGE_START,
  actor,
  canvasInput,
  createAccountPerson,
  createTask,
  systemAdministratorRole,
} from "./helpers/project-management-canvas-security-fixtures";

test.describe("project management canvas security project-management-canvas-route-boundaries", () => {
  test("authenticated Canvas route binds every public query to the session actor", async ({
      context,
      request,
      baseURL,
    }) => {
      if (!baseURL) throw new Error("Canvas route 测试缺少 baseURL");
      const owner = await createAccountPerson("Action 边界 Owner");
      const outsider = await createAccountPerson("Action 边界 Outsider");
      const task = await createTask({
        ownerAccountId: owner.account.id,
        title: "Action 边界可见 Task",
        team: "英雄",
        techGroup: "电控",
        members: [{ personId: owner.person.id, role: "OWNER" }],
      });
      const endpoint = new URL("/api/project-management/canvas", baseURL).toString();

      const unauthenticated = await request.post(endpoint, {
        data: { operation: "searchTaskOptions", input: {} },
      });
      expect(unauthenticated.status()).toBe(401);
      expect(unauthenticated.headers()["cache-control"]).toContain("no-store");
      expect(await unauthenticated.json()).toMatchObject({
        ok: false,
        error: { code: "UNAUTHENTICATED" },
      });

      await loginAsTestUser(context, baseURL, {
        openId: owner.openId,
        name: owner.person.displayName,
      });
      const allowedInputs: Array<{ operation: string; input: unknown }> = [
        {
          operation: "getTimeCanvasData",
          input: canvasInput({ scope: { kind: "PERSONAL" }, groupBy: "PERSON" }),
        },
        {
          operation: "getTimeCanvasData",
          input: canvasInput({
            scope: { kind: "TASK_SCOPED", taskId: task.taskId },
            groupBy: "TASK",
          }),
        },
        { operation: "searchPeople", input: { purpose: "VISIBLE" } },
        { operation: "searchTaskOptions", input: { query: "Action 边界" } },
        {
          operation: "getMyWorkDashboard",
          input: { rangeStart: RANGE_START, rangeEnd: RANGE_END },
        },
      ];
      for (const payload of allowedInputs) {
        const response = await context.request.post(endpoint, { data: payload });
        expect(await response.json(), payload.operation).toMatchObject({ ok: true });
        expect(response.headers()["cache-control"]).toContain("no-store");
      }

      const spoofedActor = await context.request.post(endpoint, {
        data: {
          operation: "getMyWorkDashboard",
          input: {},
          actor: actor(outsider, [systemAdministratorRole()]),
        },
      });
      expect(await spoofedActor.json()).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR" },
      });
      const spoofedPersonalIdentity = await context.request.post(endpoint, {
        data: {
          operation: "getTimeCanvasData",
          input: canvasInput({
            scope: { kind: "PERSONAL" },
            groupBy: "PERSON",
            personIds: [outsider.person.id],
          }),
        },
      });
      expect(await spoofedPersonalIdentity.json()).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });

      const malformedInput = await context.request.post(endpoint, {
        data: {
          operation: "getTimeCanvasData",
          input: { scope: { kind: "PERSONAL" }, rangeStart: "invalid" },
        },
      });
      expect(await malformedInput.json()).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR" },
      });
      const stableLimitError = await context.request.post(endpoint, {
        data: {
          operation: "searchPeople",
          input: { purpose: "VISIBLE", limit: 51 },
        },
      });
      expect(await stableLimitError.json()).toMatchObject({
        ok: false,
        error: { code: "QUERY_LIMIT_EXCEEDED" },
      });
      const malformedJson = await context.request.post(endpoint, {
        data: "{",
        headers: { "Content-Type": "application/json" },
      });
      expect(await malformedJson.json()).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR" },
      });

      await loginAsTestUser(context, baseURL, {
        openId: outsider.openId,
        name: outsider.person.displayName,
      });
      for (const payload of [
        {
          operation: "getTimeCanvasData",
          input: canvasInput({
            scope: { kind: "TASK_SCOPED", taskId: task.taskId },
            groupBy: "TASK",
          }),
        },
      ]) {
        const readable = await context.request.post(endpoint, { data: payload });
        expect(await readable.json()).toMatchObject({ ok: true });
      }
    });

  test("Segment create action accepts creatable Tasks and returns a stable denial for terminal Tasks", async ({
      context,
      page,
      baseURL,
    }) => {
      const owner = await createAccountPerson("Create Action Owner");
      const activeTaskTitle = `Create Action Active ${randomUUID()}`;
      const activeTask = await createTask({
        ownerAccountId: owner.account.id,
        title: activeTaskTitle,
        team: "英雄",
        techGroup: "电控",
        members: [{ personId: owner.person.id, role: "OWNER" }],
      });
      const terminalTask = await createTask({
        ownerAccountId: owner.account.id,
        title: `Create Action Completed ${randomUUID()}`,
        team: "英雄",
        techGroup: "电控",
        status: "COMPLETED",
        members: [{ personId: owner.person.id, role: "OWNER" }],
      });
      await loginAsTestUser(context, baseURL, {
        openId: owner.openId,
        name: owner.person.displayName,
      });
      await page.goto(
        `/progress/resources?from=2026-08-10&to=2026-08-12&people=${owner.person.id}`,
      );

      await page.getByRole("button", { name: "新增投入" }).click();
      const quickCreate = page.getByRole("form", { name: "投入快速创建" });
      await quickCreate.getByLabel("Task", { exact: true }).fill(activeTaskTitle);
      await page
        .getByRole("option", { name: activeTaskTitle, exact: true })
        .click();
      await quickCreate.locator("#quick-content").fill("真实 Action 允许 Active Task");
      await quickCreate.getByRole("button", { name: "创建" }).click();
      await expect(
        page.getByText("已创建投入记录", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() =>
          prisma.workSegment.count({
            where: {
              personId: owner.person.id,
              taskId: activeTask.taskId,
              content: "真实 Action 允许 Active Task",
            },
          }),
        )
        .toBe(1);

      await page.getByRole("button", { name: "新增投入" }).click();
      const deniedQuickCreate = page.getByRole("form", { name: "投入快速创建" });
      await deniedQuickCreate.locator("#quick-content").fill("真实 Action 拒绝 Completed Task");
      const deniedActionResponse = page.waitForResponse((response) =>
        Boolean(response.request().headers()["next-action"]),
      );
      await deniedQuickCreate.evaluate((form, taskId) => {
        const hiddenTaskId = form.querySelector<HTMLInputElement>('input[name="taskId"]');
        const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (!hiddenTaskId || !submit) throw new Error("快速创建表单结构不完整");
        hiddenTaskId.remove();
        const injectedTaskId = document.createElement("input");
        injectedTaskId.type = "hidden";
        injectedTaskId.name = "taskId";
        injectedTaskId.value = taskId;
        form.prepend(injectedTaskId);
        (form as HTMLFormElement).requestSubmit(submit);
      }, terminalTask.taskId);
      expect(await (await deniedActionResponse).text()).toContain(
        "ASSOCIATION_INVALID",
      );
      await expect(
        page.getByText("当前 Task 状态不允许创建或关联 Segment", {
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await prisma.workSegment.count({
          where: { taskId: terminalTask.taskId },
        }),
      ).toBe(0);
    });
});
