import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  createRevision,
  createTaskDraft,
  rejectRevision,
} from "../lib/project-management/application/lifecycle-service";
import {
  createWorkSegment,
} from "../lib/project-management/application/segment-service";
import {
  updateTaskDraftMetadata,
} from "../lib/project-management/application/task-mutation-service";
import {
  markInAppNotificationRead as markInAppNotificationReadService,
} from "../lib/project-management/application/notification-service";
import {
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "../lib/project-management/date-time";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

test.describe("project management P4/P6 UI integration", () => {
  test.beforeAll(async () => {
    const administrator = await createAccountPerson(
      `S5 UI Global Approval Administrator ${randomUUID()}`,
    );
    await grantRole(administrator.account.id, "PROJECT_ADMINISTRATOR");
  });

  test("datetime-local helpers preserve Shanghai business wall-clock", () => {
    expect(shanghaiDateTimeLocalToIso("2026-08-10T00:00")).toBe(
      "2026-08-09T16:00:00.000Z",
    );
    expect(shanghaiDateTimeLocalToIso("2026-08-10T00:00:30.123")).toBe(
      "2026-08-09T16:00:30.123Z",
    );
    expect(isoToShanghaiDateTimeLocal("2026-08-09T16:00:00.000Z")).toBe(
      "2026-08-10T00:00",
    );
  });

  test("server-rendered Task workbench tabs remain navigable without client JavaScript", async ({
    browser,
    baseURL,
  }, testInfo) => {
    if (!baseURL) throw new Error("无脚本回归缺少 Playwright baseURL");
    const owner = await createAccountPerson(
      `P6 UI No-JS Owner ${testInfo.project.name} ${randomUUID()}`,
    );
    const task = await createTaskDraft(actor(owner), {
      title: `P6 UI No-JS Task ${randomUUID()}`,
      description: "验证客户端脚本加载失败时的工作台导航",
      team: "英雄",
      techGroup: "电控",
      priority: "MEDIUM",
      tagIds: [],
      members: [{ personId: owner.person.id, role: "OWNER" }],
      milestones: [milestoneInput("No-JS Milestone", "完成无脚本回归", 1)],
      plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
      termination: terminationInput(5),
      idempotencyKey: `p6-ui-no-js-${randomUUID()}`,
    });
    await activateTask(actor(owner), {
      taskId: task.taskId,
      expectedLockVersion: task.lockVersion,
    });

    const context = await browser.newContext({
      baseURL,
      javaScriptEnabled: false,
      viewport:
        testInfo.project.name === "mobile"
          ? { width: 393, height: 727 }
          : { width: 1_440, height: 1_000 },
    });
    try {
      await loginAsTestUser(context, baseURL, {
        openId: owner.openId,
        name: owner.person.displayName,
      });
      const page = await context.newPage();
      await page.goto(`/progress/tasks/${task.taskId}`);
      await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
      await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
      await expect(page.getByRole("heading", { name: "No-JS Milestone" })).toBeVisible();
      await expect(page.getByRole("tab")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("Task Composer restores a scoped local draft and creates exactly one Task on desktop and mobile", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(90_000);
    const creator = await createAccountPerson(
      `S5 Composer Creator ${testInfo.project.name} ${randomUUID()}`,
    );
    const coOwner = await createAccountPerson(
      `S5 Composer Co-Owner ${testInfo.project.name} ${randomUUID()}`,
    );
    await loginAsTestUser(context, baseURL, {
      openId: creator.openId,
      name: creator.person.displayName,
    });
    const title = `S5 Composer ${randomUUID()}`;

    await page.goto("/progress/tasks/new?start=2026-09-01");
    await expect(page.getByRole("heading", { name: "新建 Task" })).toBeVisible();
    await expect(page.getByTestId("task-composer")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await expect(page.getByRole("checkbox", { name: /允许自审/ })).toHaveCount(0);
    await page.getByLabel("Task 名称").fill(title);
    await page.waitForTimeout(900);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(window.localStorage).some((key) => key.startsWith("task-draft:")),
        ),
      )
      .toBe(true);

    await page.reload();
    await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toBeVisible();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByLabel("Task 名称")).toHaveValue(title);

    const lastOwnerButton = page.getByRole("button", {
      name: `移除 ${creator.person.displayName} 负责人`,
    });
    await expect(lastOwnerButton).toBeDisabled();
    const ownerPicker = page.getByLabel("搜索负责人", { exact: true });
    await ownerPicker.fill(coOwner.person.displayName);
    await expect(
      page.getByRole("option", { name: new RegExp(coOwner.person.displayName) }),
    ).toBeVisible();
    await page
      .getByRole("option", { name: new RegExp(coOwner.person.displayName) })
      .click();
    await expect(lastOwnerButton).toBeEnabled();

    const originalViewport = page.viewportSize();
    if (!originalViewport) throw new Error("人员选择器回归缺少 viewport");
    await page.setViewportSize({ width: originalViewport.width, height: 529 });
    await ownerPicker.scrollIntoViewIfNeeded();
    await ownerPicker.click();
    const pickerPositioner = page.getByTestId("entity-picker-positioner");
    await expect(pickerPositioner).toHaveAttribute("data-side", /^(top|bottom)$/);
    await page.keyboard.press("Escape");
    await page.setViewportSize(originalViewport);

    await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("0/200");
    await expect(page.getByTestId("task-plan-node-navigator").getByRole("button", { name: /Start/ })).toBeVisible();
    await expect(page.getByTestId("task-plan-node-navigator").getByRole("button", { name: /Terminal/ })).toBeVisible();
    await expect(page.getByLabel("计划节点列表")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /复制 Milestone/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /批量删除/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "校验", exact: true })).toHaveCount(0);
    await expect(page.getByText("问题列表", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /添加 Milestone/ }).first().click();
    await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("1/200");
    await expect(page.getByTestId("task-composer-temporary-count")).toHaveText("1 个临时");
    await expect(
      page.getByTestId("task-plan-node-navigator").getByText("临时节点", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("目标").fill("完成 S5 Composer 主流程");
    await page
      .getByLabel("完成条件")
      .fill("创建页、权限、幂等和数据库断言均通过");
    await page
      .getByLabel("验收要求")
      .fill("由 Playwright 同时验证 Desktop 与 Pixel 5");
    await page.getByLabel("预期完成时间").fill("2026-09-08T09:00");
    await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("1/200");
    await expect(page.getByTestId("task-composer-temporary-count")).toHaveCount(0);
    const milestoneTime = page.getByLabel("预期完成时间");
    const originalMilestoneTime = await milestoneTime.inputValue();
    const milestoneAnchor = page.getByRole("button", {
      name: /计划节点 完成 S5 Composer 主流程/,
    });
    await milestoneAnchor.focus();
    await milestoneAnchor.press("ArrowRight");
    await expect.poll(() => milestoneTime.inputValue()).not.toBe(originalMilestoneTime);
    const movedMilestoneTime = await milestoneTime.inputValue();
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(milestoneTime).toHaveValue(originalMilestoneTime);
    await page.getByRole("button", { name: "重做" }).click();
    await expect(milestoneTime).toHaveValue(movedMilestoneTime);
    await milestoneTime.fill("");
    await expect(
      page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /完成 S5 Composer 主流程.*需修正/ }),
    ).toBeVisible();
    await milestoneTime.fill(originalMilestoneTime);

    const planNavigator = page.getByTestId("task-plan-node-navigator");
    if (testInfo.project.name === "desktop") {
      const canvasScroll = page.getByTestId("time-canvas-scroll");
      await planNavigator.getByRole("button", { name: /Start/ }).click();
      await expect.poll(() => canvasScroll.evaluate((element) => element.scrollLeft)).toBeLessThanOrEqual(1);
      await planNavigator.getByRole("button", { name: /Terminal/ }).click();
      await expect.poll(() => canvasScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(1);
    } else {
      await planNavigator.getByRole("button", { name: /Terminal/ }).click();
    }
    await page
      .getByLabel("结束条件")
      .fill("Task 草稿创建完成且不包含初始 Segment");
    await page.getByLabel("计划结束时间").fill("2026-09-07T18:00");
    await expect(
      page
        .getByTestId("task-composer-inspector")
        .getByText("Terminal 必须严格晚于 Start 和最后一个 Milestone。"),
    ).toBeVisible();
    await page.getByLabel("计划结束时间").fill("2026-09-16T18:00");

    await page.waitForTimeout(900);
    const extremeDraft = await page.evaluate(async () => {
      const key = Object.keys(window.localStorage).find((candidate) =>
        candidate.startsWith("task-draft:"),
      );
      if (!key) throw new Error("未找到 S5 本地草稿 key");
      const envelope = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
        draftId: string;
        savedAt: string;
        task: {
          milestones: Array<Record<string, unknown>>;
          selectedEntityId: string | null;
          termination: { plannedAt: string };
        };
      };
      const first = envelope.task.milestones[0];
      if (!first) throw new Error("本地草稿缺少 Milestone");
      const escapedBoundaryText = "\"".repeat(2_000);
      envelope.task.milestones = Array.from({ length: 200 }, (_, index) => ({
        ...first,
        id: `draft-node-${crypto.randomUUID()}`,
        goal: escapedBoundaryText,
        completionCriteria: escapedBoundaryText,
        reviewRequirements: escapedBoundaryText,
        businessDescription: escapedBoundaryText,
        expectedCompletedAt: new Date(
          new Date("2026-09-02T09:00:00+08:00").getTime() + index * 30 * 60 * 1_000,
        ).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T").slice(0, 16),
      }));
      envelope.task.termination.plannedAt = "2026-09-16T18:00";
      envelope.task.selectedEntityId = String(envelope.task.milestones.at(-1)?.id ?? "");
      envelope.savedAt = new Date().toISOString();
      const serialized = JSON.stringify(envelope);
      if (serialized.length <= 3_200_000) {
        throw new Error("极限草稿未覆盖 JSON 转义后的合法 200 节点容量");
      }
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("management-system-task-composer", 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("drafts")) {
            request.result.createObjectStore("drafts");
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("drafts", "readwrite");
        transaction.objectStore("drafts").put(serialized, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      window.localStorage.setItem(key, JSON.stringify({
        schemaVersion: 3,
        storage: "INDEXED_DB",
        draftId: envelope.draftId,
        savedAt: envelope.savedAt,
        serializedChars: serialized.length,
      }));
      return { key, savedAt: envelope.savedAt, serializedChars: serialized.length };
    });
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("200/200");
    const extremeNavigator = page.getByTestId("task-plan-node-navigator");
    await expect
      .poll(() =>
        extremeNavigator.evaluate((element) => {
          const selected = element.querySelector<HTMLElement>("[data-node-selected='true']");
          if (!selected) return false;
          const containerRect = element.getBoundingClientRect();
          const selectedRect = selected.getBoundingClientRect();
          return (
            selectedRect.left >= containerRect.left - 1 &&
            selectedRect.right <= containerRect.right + 1 &&
            selectedRect.top >= containerRect.top - 1 &&
            selectedRect.bottom <= containerRect.bottom + 1
          );
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(async ({ key, previousSavedAt, serializedChars }) => {
          const pointer = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
            storage?: string;
            savedAt?: string;
            serializedChars?: number;
          } | null;
          if (
            pointer?.storage !== "INDEXED_DB" ||
            pointer.savedAt === previousSavedAt ||
            typeof pointer.serializedChars !== "number" ||
            pointer.serializedChars < serializedChars
          ) {
            return false;
          }
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("management-system-task-composer", 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const raw = await new Promise<unknown>((resolve, reject) => {
            const transaction = database.transaction("drafts", "readonly");
            const request = transaction.objectStore("drafts").get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          database.close();
          return typeof raw === "string" && raw.length === pointer.serializedChars;
        }, {
          key: extremeDraft.key,
          previousSavedAt: extremeDraft.savedAt,
          serializedChars: extremeDraft.serializedChars,
        }),
      )
      .toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("200/200");
    if (testInfo.project.name === "desktop") {
      const concurrentPage = await context.newPage();
      await concurrentPage.goto("/progress/tasks/new?start=2026-09-01");
      await expect(
        concurrentPage.getByText(/检测到 .* 保存的未完成草稿/),
      ).toBeVisible();
      await concurrentPage.getByRole("button", { name: "恢复草稿" }).click();
      await expect(
        concurrentPage.getByTestId("task-composer-milestone-count"),
      ).toHaveText("200/200");
      const concurrentDescriptionA = `多标签页极限草稿 A ${"A".repeat(137)}`;
      const concurrentDescriptionB = `多标签页极限草稿 B ${"B".repeat(733)}`;
      await page.getByLabel("描述").fill(concurrentDescriptionA);
      await concurrentPage.getByLabel("描述").fill(concurrentDescriptionB);
      await Promise.all([
        page.getByRole("button", { name: "全部 Task", exact: true }).click(),
        concurrentPage.getByRole("button", { name: "全部 Task", exact: true }).click(),
      ]);
      const primaryLeaveDialog = page.getByRole("dialog", {
        name: "离开 Task Composer？",
      });
      const concurrentLeaveDialog = concurrentPage.getByRole("dialog", {
        name: "离开 Task Composer？",
      });
      await expect(primaryLeaveDialog).toBeVisible();
      await expect(concurrentLeaveDialog).toBeVisible();
      const lockPage = await context.newPage();
      await lockPage.goto("/progress/tasks");
      const heldDraftLock = lockPage.evaluate(async (lockName) => {
        const lockWindow = window as Window & {
          releaseDraftStorageLock?: () => void;
          draftStorageLockHeld?: boolean;
        };
        await navigator.locks.request(lockName, async () => {
          lockWindow.draftStorageLockHeld = true;
          await new Promise<void>((resolve) => {
            lockWindow.releaseDraftStorageLock = resolve;
          });
        });
      }, `management-system:task-composer-draft:${extremeDraft.key}`);
      await expect
        .poll(() =>
          lockPage.evaluate(
            () =>
              Boolean(
                (window as Window & { draftStorageLockHeld?: boolean })
                  .draftStorageLockHeld,
              ),
          ),
        )
        .toBe(true);
      await Promise.all([
        primaryLeaveDialog
          .getByRole("button", { name: "保存本地草稿并离开" })
          .click(),
        concurrentLeaveDialog
          .getByRole("button", { name: "保存本地草稿并离开" })
          .click(),
      ]);
      await expect(
        primaryLeaveDialog.getByRole("button", { name: "继续编辑" }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(primaryLeaveDialog).toBeVisible();
      await lockPage.evaluate(() => {
        (window as Window & { releaseDraftStorageLock?: () => void })
          .releaseDraftStorageLock?.();
      });
      await heldDraftLock;
      await expect(page.getByRole("heading", { name: "全部 Task" })).toBeVisible();
      await expect(
        concurrentPage.getByRole("heading", { name: "全部 Task" }),
      ).toBeVisible();
      await concurrentPage.close();
      await lockPage.close();
      await page.goto("/progress/tasks/new?start=2026-09-01");
      await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toBeVisible();
      await page.getByRole("button", { name: "恢复草稿" }).click();
      await expect(page.getByTestId("task-composer-milestone-count")).toHaveText(
        "200/200",
      );
      expect([concurrentDescriptionA, concurrentDescriptionB]).toContain(
        await page.getByLabel("描述").inputValue(),
      );
    }

    let aborted = false;
    await page.route("**/progress/tasks/new?*", async (route) => {
      if (route.request().method() === "POST" && !aborted) {
        aborted = true;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "创建 Task 草稿" }).click();
    await expect(page.getByText(/网络或服务暂时不可用/)).toBeVisible();
    expect(await prisma.task.count({ where: { title } })).toBe(1);
    await page.unroute("**/progress/tasks/new?*");
    await page.getByRole("button", { name: "创建 Task 草稿" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expectHealthyPage(page);
    const task = await prisma.task.findFirstOrThrow({
      where: { title },
      include: {
        members: { where: { removedAt: null } },
        currentPlanVersion: { include: { nodes: true } },
        workSegments: { where: { deletedAt: null } },
      },
    });
    expect(task.status).toBe("DRAFT");
    expect(task.members).toHaveLength(2);
    expect(task.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ personId: creator.person.id, role: "OWNER" }),
        expect.objectContaining({ personId: coOwner.person.id, role: "OWNER" }),
      ]),
    );
    expect(task.currentPlanVersion.plannedStartAt).not.toBeNull();
    expect(task.currentPlanVersion.nodes).toHaveLength(201);
    expect(task.workSegments).toHaveLength(0);
    expect(await prisma.task.count({ where: { title } })).toBe(1);
    expect(
      await page.evaluate(() =>
        Object.keys(window.localStorage).some((key) => key.startsWith("task-draft:")),
      ),
    ).toBe(false);
    expect(
      await page.evaluate(async (key) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("management-system-task-composer", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const stored = await new Promise<unknown>((resolve, reject) => {
          const transaction = database.transaction("drafts", "readonly");
          const request = transaction.objectStore("drafts").get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        database.close();
        return stored;
      }, extremeDraft.key),
    ).toBeUndefined();
    if (testInfo.project.name === "desktop") {
      await page.goto("/progress/tasks/new");
      await page.getByLabel("Task 名称").fill("立即放弃的防抖草稿");
      expect(
        await page.evaluate(async (key) => {
          const localRaw = window.localStorage.getItem(key);
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("management-system-task-composer", 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const indexedRaw = await new Promise<unknown>((resolve, reject) => {
            const transaction = database.transaction("drafts", "readonly");
            const request = transaction.objectStore("drafts").get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          database.close();
          return {
            hasLocalDraft: localRaw !== null,
            hasIndexedDraft: typeof indexedRaw === "string",
          };
        }, extremeDraft.key),
      ).toEqual({ hasLocalDraft: false, hasIndexedDraft: false });
      await page.getByRole("button", { name: "全部 Task", exact: true }).click();
      const leaveDialog = page.getByRole("dialog", {
        name: "离开 Task Composer？",
      });
      await expect(leaveDialog).toBeVisible();
      await leaveDialog.getByRole("button", { name: "放弃并离开" }).click();
      await expect(page.getByRole("heading", { name: "全部 Task" })).toBeVisible();
      await page.waitForTimeout(900);
      await page.goto("/progress/tasks/new");
      await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toHaveCount(0);
      await expect(page.getByLabel("Task 名称")).toHaveValue("");
    }
  });

  test("ordinary unified accounts can open the Task Composer without an organization role", async ({
    context,
    page,
    baseURL,
  }) => {
    const outsider = await createAccountPerson("S5 Composer Outsider");
    await loginAsTestUser(context, baseURL, {
      openId: outsider.openId,
      name: outsider.person.displayName,
    });
    await page.goto("/progress/tasks/new");
    await expect(page.getByTestId("task-composer")).toBeVisible();
    await expect(page.getByLabel("负责人", { exact: true })).toBeVisible();
    await expect(page.getByLabel("参与人员", { exact: true })).toBeVisible();
    await expect(page.getByLabel("搜索负责人")).toBeVisible();
    await expect(page.getByLabel("搜索参与人员")).toBeVisible();
    await expect(page.getByText("流程策略")).toHaveCount(0);
    await expectHealthyPage(page);
  });

  test("Task Composer creates and activates a Start-to-Terminal-only Task", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    const creator = await createAccountPerson(
      `S5 Zero Milestone ${testInfo.project.name} ${randomUUID()}`,
    );
    await loginAsTestUser(context, baseURL, {
      openId: creator.openId,
      name: creator.person.displayName,
    });
    const title = `S5 Zero Milestone Task ${randomUUID()}`;

    await page.goto("/progress/tasks/new?start=2026-09-20");
    await page.getByLabel("Task 名称").fill(title);
    await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("0/200");
    if (testInfo.project.name === "desktop") {
      await page.getByRole("button", { name: "编辑 Terminal" }).click();
    } else {
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ })
        .click();
    }
    await page.getByLabel("Terminal 名称").fill("交付终点");
    await page.getByLabel("结束条件").fill("无需中间验收，直接进入交付终点");
    await page.getByRole("button", { name: "创建 Task 草稿" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "激活 Task" }).click();
    await expect(page.getByText(/当前：交付终点/)).toBeVisible();
    await expectHealthyPage(page);

    const task = await prisma.task.findFirstOrThrow({
      where: { title },
      include: {
        currentPlanVersion: {
          include: {
            nodes: {
              include: { node: { include: { termination: true } } },
            },
          },
        },
      },
    });
    expect(task.status).toBe("ACTIVE");
    expect(task.activeMilestoneNodeId).toBeNull();
    expect(task.currentPlanVersion.nodes).toHaveLength(1);
    expect(task.currentPlanVersion.nodes[0]?.node).toMatchObject({
      type: "TERMINATION",
      status: "ACTIVE",
      termination: expect.objectContaining({ name: "交付终点" }),
    });
  });

  test("Task Composer preserves v1/v2 draft times while migrating Terminal name and zero Milestones", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "本地草稿版本迁移只需在桌面重复一次");
    const creator = await createAccountPerson(
      `S5 Composer Legacy Draft ${randomUUID()}`,
    );
    await loginAsTestUser(context, baseURL, {
      openId: creator.openId,
      name: creator.person.displayName,
    });

    await page.goto("/progress/tasks/new?start=2026-11-03");
    await page.getByLabel("Task 名称").fill("待迁移 v1 草稿");
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(window.localStorage).some((key) => key.endsWith(":v3")),
        ),
      )
      .toBe(true);

    const installLegacyDraft = async (version: 1 | 2, title: string) => {
      await page.evaluate(({ version, title }) => {
        const currentKey = Object.keys(window.localStorage).find((key) =>
          key.endsWith(":v3"),
        );
        if (!currentKey) throw new Error("未找到 v3 Task Composer 草稿");
        const envelope = JSON.parse(
          window.localStorage.getItem(currentKey) ?? "null",
        ) as {
          schemaVersion: number;
          inspectorDraft?: unknown;
          inspectorDirty?: boolean;
          task: {
            title: string;
            plannedStartAt: string;
            milestones: unknown[];
            termination: {
              name?: string;
              plannedAt: string;
              plannedOutcomeCriteria: string;
            };
          };
        };
        envelope.schemaVersion = version;
        delete envelope.inspectorDraft;
        delete envelope.inspectorDirty;
        envelope.task.title = title;
        envelope.task.milestones = version === 2
          ? [
              {
                id: "draft-node-legacy-later",
                goal: "旧草稿较晚节点",
                completionCriteria: "完成较晚节点",
                expectedCompletedAt: "2026-11-06T09:00",
                reviewRequirements: "验收较晚节点",
                businessDescription: "",
              },
              {
                id: "draft-node-legacy-earlier",
                goal: "旧草稿较早节点",
                completionCriteria: "完成较早节点",
                expectedCompletedAt: "2026-11-05T09:00",
                reviewRequirements: "验收较早节点",
                businessDescription: "",
              },
            ]
          : [];
        envelope.task.termination.plannedAt = version === 2
          ? "2026-11-07T09:00"
          : envelope.task.plannedStartAt;
        envelope.task.termination.plannedOutcomeCriteria = "旧草稿结束条件";
        delete envelope.task.termination.name;
        const scopedPrefix = currentKey.slice(0, -2);
        window.localStorage.removeItem(`${scopedPrefix}v1`);
        window.localStorage.removeItem(`${scopedPrefix}v2`);
        window.localStorage.removeItem(`${scopedPrefix}v3`);
        window.localStorage.setItem(
          `${scopedPrefix}v${version}`,
          JSON.stringify(envelope),
        );
      }, { version, title });
    };

    const assertMigratedDraft = async (title: string, version: 1 | 2) => {
      await page.reload();
      await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toBeVisible();
      await page.getByRole("button", { name: "恢复草稿" }).click();
      await expect(page.getByLabel("Task 名称")).toHaveValue(title);
      await expect(page.getByTestId("task-composer-milestone-count")).toHaveText(
        version === 2 ? "2/200" : "0/200",
      );
      if (version === 2) {
        const navigator = page.getByTestId("task-plan-node-navigator");
        await expect(navigator).toContainText("旧草稿较早节点");
        await expect(navigator).toContainText("旧草稿较晚节点");
      }
      await page.getByTestId("task-plan-node-navigator").getByRole("button", { name: /Terminal/ }).click();
      await expect(page.getByLabel("Terminal 名称")).toHaveValue("Terminal");
      await expect(page.getByLabel("计划结束时间")).toHaveValue(
        version === 2 ? "2026-11-07T09:00" : "2026-11-03T09:00",
      );
      if (version === 2) {
        await expect(page.getByText("当前计划内容校验通过")).toBeVisible();
      } else {
        await expect(
          page.getByRole("button", {
            name: "Terminal 必须严格晚于 Start 和最后一个 Milestone。",
          }),
        ).toBeVisible();
      }
      await expect
        .poll(() =>
          page.evaluate(() =>
            Object.keys(window.localStorage).some((key) => key.endsWith(":v3")),
          ),
        )
        .toBe(true);
    };

    await installLegacyDraft(1, "已迁移 v1 草稿");
    await assertMigratedDraft("已迁移 v1 草稿", 1);
    await installLegacyDraft(2, "已迁移 v2 草稿");
    await assertMigratedDraft("已迁移 v2 草稿", 2);
    await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((candidate) => candidate.endsWith(":v3"));
      if (!key) throw new Error("未找到待转换的 v3 草稿");
      const envelope = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
        inspectorDraft: unknown;
        inspectorDirty: boolean;
        task: { selectedEntityId: string | null };
      };
      const id = "draft-node-legacy-inspector-copy";
      envelope.task.selectedEntityId = id;
      envelope.inspectorDirty = true;
      envelope.inspectorDraft = {
        kind: "MILESTONE",
        entityId: id,
        isNew: true,
        returnEntityId: "draft-node-legacy-later",
        milestone: {
          id,
          goal: "旧 v3 Inspector 临时节点",
          completionCriteria: "",
          expectedCompletedAt: "2026-11-06T09:30",
          reviewRequirements: "",
          businessDescription: "旧工作副本应转换而不是丢失",
        },
      };
      window.localStorage.setItem(key, JSON.stringify(envelope));
    });
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("3/200");
    await expect(page.getByTestId("task-composer-temporary-count")).toHaveText("1 个临时");
    await expect(page.getByLabel("目标")).toHaveValue("旧 v3 Inspector 临时节点");
    await page.getByTestId("time-canvas-scroll").evaluate((element) => {
      element.scrollTo({ left: element.scrollWidth, behavior: "auto" });
    });
    await expect(page.locator('[data-anchor-visual-state="TEMPORARY"]')).toBeVisible();
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((candidate) => candidate.endsWith(":v3"));
      if (!key) throw new Error("未找到待破坏的 v3 草稿");
      const envelope = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
        task: {
          plannedStartAt: string;
          milestones: Array<{ id: string; expectedCompletedAt: string }>;
          nodeMeta: Record<string, { lifecycle: string; lastValidAt: string }>;
        };
      };
      const temporary = envelope.task.milestones.find(
        (milestone) => milestone.id === "draft-node-legacy-inspector-copy",
      );
      if (!temporary) throw new Error("旧 v3 临时节点未写入实时草稿");
      temporary.expectedCompletedAt = "";
      envelope.task.nodeMeta[temporary.id] = {
        lifecycle: "TEMPORARY",
        lastValidAt: envelope.task.plannedStartAt,
      };
      window.localStorage.setItem(key, JSON.stringify(envelope));
    });
    await page.reload();
    await expect(page.getByText(/草稿版本、结构或字段不兼容/)).toBeVisible();
    await expectHealthyPage(page);
  });

  test("an inactive Person account can open global read pages and the Task Composer", async ({
    context,
    page,
    baseURL,
  }) => {
    const guardAdmin = await createAccountPerson("S5 Inactive Owner Guard Admin");
    await grantRole(guardAdmin.account.id, "PROJECT_ADMINISTRATOR");
    const user = await createAccountPerson("S5 Inactive Unified Account");
    await prisma.person.update({
      where: { id: user.person.id },
      data: { status: "INACTIVE" },
    });
    const draftTitle = `S5 Inactive Owner Draft ${randomUUID()}`;
    const draft = await createTaskDraft(actor(user), {
      title: draftTitle,
      description: "停用创建者仍可创建 Task，但不能新增投入",
      team: "英雄",
      techGroup: "电控",
      priority: "MEDIUM",
      tagIds: [],
      members: [{ personId: user.person.id, role: "OWNER" }],
      milestones: [milestoneInput("停用负责人阶段", "完成阶段目标", 1)],
      plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
      termination: terminationInput(5),
      idempotencyKey: `inactive-owner-draft-${randomUUID()}`,
    });
    await loginAsTestUser(context, baseURL, {
      openId: user.openId,
      name: user.person.displayName,
    });

    await page.goto("/progress/resources");
    await expect(page.getByRole("heading", { name: "人员计划" })).toBeVisible();
    await expectHealthyPage(page);
    await page.goto("/progress/my-timeline");
    await expect(page.getByRole("heading", { name: "我的时间" })).toBeVisible();
    await expectHealthyPage(page);
    await page.goto("/progress/tasks/new");
    await expect(page.getByTestId("task-composer")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `移除 ${user.person.displayName} 负责人`,
      }),
    ).toBeDisabled();
    await expectHealthyPage(page);
    await page.goto(`/progress/tasks/${draft.taskId}`);
    await expect(page.getByRole("heading", { name: draftTitle })).toBeVisible();
    await expect(page.getByRole("button", { name: "新增投入" })).toHaveCount(0);
    await expectHealthyPage(page);
  });

  test("Task Composer isolates local drafts, preserves incompatible data and guards browser history", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    const creatorA = await createAccountPerson("S5 Draft Scope A");
    const creatorB = await createAccountPerson("S5 Draft Scope B");
    const hiddenCreator = await createAccountPerson("S5 Hidden Task Creator");
    const hiddenTitle = `S5 Hidden Related ${randomUUID()}`;
    const hiddenTask = await createTaskDraft(actor(hiddenCreator), {
      title: hiddenTitle,
      description: "不可枚举的关联 Task",
      team: "工程",
      techGroup: "机械",
      members: [{ personId: hiddenCreator.person.id, role: "OWNER" }],
      plannedStartAt: "2026-09-01T01:00:00.000Z",
      milestones: [
        {
          goal: "隐藏阶段",
          completionCriteria: "隐藏完成条件",
          expectedCompletedAt: "2026-09-02T10:00:00.000Z",
          reviewRequirements: "隐藏验收要求",
          businessDescription: "",
        },
      ],
      termination: {
        name: "Terminal",
        plannedOutcomeCriteria: "隐藏结束条件",
        plannedAt: "2026-09-04T10:00:00.000Z",
        businessDescription: "",
      },
      idempotencyKey: `s5-hidden-${randomUUID()}`,
    });
    await prisma.task.update({
      where: { id: hiddenTask.taskId },
      data: { deletedAt: new Date() },
    });
    await loginAsTestUser(context, baseURL, {
      openId: creatorA.openId,
      name: creatorA.person.displayName,
    });

    await page.goto("/progress/tasks");
    await page.getByRole("link", { name: "新建 Task" }).click();
    await page.getByLabel("关联 Task", { exact: true }).fill(hiddenTitle);
    await expect(page.getByText("没有匹配项。")).toBeVisible();
    await expect(
      page.getByRole("option", { name: new RegExp(hiddenTitle) }),
    ).toHaveCount(0);
    const forgedTitle = `S5 forged related ${randomUUID()}`;
    await page.getByLabel("Task 名称").fill(forgedTitle);
    await page.getByRole("button", { name: /添加 Milestone/ }).first().click();
    await page.getByLabel("目标").fill("伪造关联目标");
    await page.getByLabel("完成条件").fill("服务端拒绝隐藏关联");
    await page.getByLabel("验收要求").fill("不得通过本地草稿绕过可见性");
    if (testInfo.project.name === "desktop") {
      await page.getByRole("button", { name: "编辑 Terminal" }).click();
    } else {
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ })
        .click();
    }
    await page.getByLabel("结束条件").fill("隐藏关联写入被拒绝");
    await page.waitForTimeout(900);
    await page.evaluate(({ taskId, title }) => {
      const key = Object.keys(window.localStorage).find((candidate) =>
        candidate.startsWith("task-draft:"),
      );
      if (!key) throw new Error("未找到待伪造的本地草稿");
      const envelope = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
        task: { title: string; relatedTaskId: string | null };
      };
      envelope.task.title = title;
      envelope.task.relatedTaskId = taskId;
      window.localStorage.setItem(key, JSON.stringify(envelope));
    }, { taskId: hiddenTask.taskId, title: forgedTitle });
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await page.getByRole("button", { name: "创建 Task 草稿" }).click();
    await expect(page.getByText(/对象不存在|无权/)).toBeVisible();
    expect(await prisma.task.count({ where: { title: forgedTitle } })).toBe(0);
    await page.getByRole("button", { name: "清空关联 Task" }).click();
    await page.getByLabel("Task 名称").fill("S5 Account A local draft");
    await page.waitForTimeout(900);
    const localKey = await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((candidate) =>
        candidate.startsWith("task-draft:"),
      );
      if (!key) throw new Error("未找到本地草稿 key");
      window.localStorage.setItem(
        "task-draft:other-deployment:other-account:v1",
        window.localStorage.getItem(key) ?? "",
      );
      return key;
    });

    const taskTitleInput = page.getByLabel("Task 名称");
    await taskTitleInput.focus();
    await page.goBack();
    const leaveDialog = page.getByRole("dialog", { name: "离开 Task Composer？" });
    await expect(leaveDialog).toBeVisible();
    await expect(
      leaveDialog.getByRole("button", { name: "继续编辑" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(leaveDialog).toHaveCount(0);
    await expect(taskTitleInput).toBeFocused();
    await page.goBack();
    await expect(leaveDialog).toBeVisible();
    await leaveDialog.getByRole("button", { name: "继续编辑" }).click();
    await expect(page.getByTestId("task-composer")).toBeVisible();

    await page.evaluate((key) => {
      const envelope = JSON.parse(window.localStorage.getItem(key) ?? "null") as {
        task: { milestones: Array<{ id: string }> };
      };
      envelope.task.milestones[1] = {
        ...envelope.task.milestones[0]!,
      };
      window.localStorage.setItem(key, JSON.stringify(envelope));
    }, localKey);
    await page.reload();
    await expect(page.getByText(/草稿版本、结构或字段不兼容/)).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出原始草稿" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^task-composer-unreadable-.*\.json$/);
    await page.getByRole("button", { name: "安全放弃" }).click();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), localKey)).toBeNull();

    await page.getByLabel("Task 名称").fill("S5 Account A isolated draft");
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "全部 Task", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "离开 Task Composer？" })).toBeVisible();
    await page.getByRole("button", { name: "保存本地草稿并离开" }).click();
    await expect(page.getByRole("heading", { name: "全部 Task" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "全部 Task" })).toBeVisible();
    await expect(page.getByTestId("task-composer")).toHaveCount(0);
    await context.clearCookies();
    await loginAsTestUser(context, baseURL, {
      openId: creatorB.openId,
      name: creatorB.person.displayName,
    });
    await page.goto("/progress/tasks/new");
    await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toHaveCount(0);
    await expect(page.getByText(/草稿版本、结构或字段不兼容/)).toHaveCount(0);
    await expect(page.getByLabel("Task 名称")).toHaveValue("");
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("task-draft:other-deployment:other-account:v1"),
      ),
    ).not.toBeNull();
    await expectHealthyPage(page);
  });

  test("Task Composer keeps the current actor as Owner beyond the first people page and removes workflow policy controls", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "服务端分页归属路径只需在桌面重复一次");
    await prisma.person.createMany({
      data: Array.from({ length: 55 }, (_, index) => ({
        displayName: `000 S5 owner pagination ${String(index).padStart(2, "0")}`,
        status: "ACTIVE" as const,
      })),
    });
    const administrator = await createAccountPerson("ZZZ S5 System Administrator");
    await grantRole(administrator.account.id, "PROJECT_ADMINISTRATOR");
    await loginAsTestUser(context, baseURL, {
      openId: administrator.openId,
      name: administrator.person.displayName,
    });
    const title = `S5 system admin ${randomUUID()}`;

    await page.goto("/progress/tasks/new?start=2026-10-01");
    await expect(
      page.getByRole("button", {
        name: `移除 ${administrator.person.displayName} 负责人`,
      }),
    ).toBeVisible();
    await page.getByLabel("Task 名称").fill(title);
    await page.getByRole("button", { name: /添加 Milestone/ }).first().click();
    await page.getByLabel("目标").fill("管理员自审目标");
    await page.getByLabel("完成条件").fill("Owner 为当前 actor");
    await page.getByLabel("验收要求").fill("全局管理员审批");
    await expect(page.getByText("流程策略")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: /允许自审/ })).toHaveCount(0);
    await page.getByRole("button", { name: "编辑 Terminal" }).click();
    await page.getByLabel("结束条件").fill("管理员 Task 创建完成");
    await page.getByRole("button", { name: "创建 Task 草稿" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    const task = await prisma.task.findFirstOrThrow({
      where: { title },
      include: { members: { where: { removedAt: null } } },
    });
    expect(task.members).toEqual([
      expect.objectContaining({ personId: administrator.person.id, role: "OWNER" }),
    ]);
  });

  test("Task Composer restores an inactive template owner with the real status", async ({
    context,
    page,
    baseURL,
  }) => {
    const creator = await createAccountPerson("S5 Template Copy Creator");
    const inactiveOwner = await createAccountPerson("S5 Template Inactive Owner");
    const template = await createTaskDraft(actor(creator), {
      title: `S5 Inactive Template ${randomUUID()}`,
      description: "复制时必须恢复模板成员的真实人员状态",
      team: "英雄",
      techGroup: "电控",
      priority: "MEDIUM",
      tagIds: [],
      members: [
        { personId: inactiveOwner.person.id, role: "OWNER" },
        { personId: creator.person.id, role: "PARTICIPANT" },
      ],
      milestones: [milestoneInput("模板阶段", "模板完成条件", 1)],
      plannedStartAt: new Date(Date.UTC(2026, 7, 1, 1, 0, 0)).toISOString(),
      termination: terminationInput(5),
      idempotencyKey: `s5-inactive-template-${randomUUID()}`,
    });
    await prisma.person.update({
      where: { id: inactiveOwner.person.id },
      data: { status: "INACTIVE" },
    });
    await loginAsTestUser(context, baseURL, {
      openId: creator.openId,
      name: creator.person.displayName,
    });

    await page.goto(`/progress/tasks/new?templateTaskId=${template.taskId}`);
    await expect(
      page.getByRole("button", {
        name: `移除 ${inactiveOwner.person.displayName} 负责人`,
      }),
    ).toBeVisible();
    const memberPicker = page.getByLabel("搜索参与人员", { exact: true });
    await memberPicker.click();
    const inactiveOption = page.getByRole("option", {
      name: new RegExp(inactiveOwner.person.displayName),
    });
    await expect(inactiveOption).toContainText("人员已停用");
    await expect(inactiveOption).toHaveAttribute("aria-disabled", "true");
    await memberPicker.press("Escape");
    await expect(memberPicker).not.toHaveValue(inactiveOwner.person.displayName);
    await expect(
      page.getByRole("button", {
        name: `移除 ${inactiveOwner.person.displayName} 参与人员`,
      }),
    ).toHaveCount(0);
    await expectHealthyPage(page);
  });

  test("dashboard, Task workbench, resource timeline and notifications work", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(90_000);
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    const fixture = await createUiFixture();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.member.openId,
      name: fixture.member.person.displayName,
    });

    await page.goto("/progress");
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: fixture.taskTitle, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("未读通知")).toBeVisible();
    await expect(page.getByRole("link", { name: "资源冲突" })).toHaveCount(0);
    await expectHealthyPage(page);

    await page.goto("/progress/tasks");
    await expect(page.getByRole("heading", { name: "全部 Task" })).toBeVisible();
    await expect(page.getByLabel("Task 状态")).toHaveValue("ACTIVE");
    await expect(page.getByRole("checkbox", { name: "只看我参与" })).toBeChecked();
    await expect(page.getByText(fixture.taskTitle)).toBeVisible();
    await page.getByLabel("Task 状态").selectOption("");
    await page.getByRole("checkbox", { name: "只看我参与" }).uncheck();
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(page.getByLabel("Task 状态")).toHaveValue("");
    await expect(page.getByRole("checkbox", { name: "只看我参与" })).not.toBeChecked();
    await expectHealthyPage(page);

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(page.getByRole("heading", { name: fixture.taskTitle })).toBeVisible();
    await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
    await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Task 风险" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Task 评论" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
    await expect(page.getByText("从未记录风险")).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByText("人员投入", { exact: true })).toHaveCount(0);
    if (testInfo.project.name === "desktop") {
      await expect(page.getByRole("heading", { name: "计划时间轴" })).toBeVisible();
      await expect(page.getByTestId("time-canvas-root")).toBeVisible();
      const canvasScroll = page.getByTestId("time-canvas-scroll");
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ })
        .click();
      await expect
        .poll(() => canvasScroll.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(1);
      await page
        .getByRole("button", { name: /计划节点 P6 UI 第一阶段/ })
        .click();
      await expect(
        page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /P6 UI 第一阶段/ }),
      ).toHaveAttribute("aria-pressed", "true");
    } else {
      await expect(page.getByTestId("time-canvas-root")).not.toBeVisible();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await expectHealthyPage(page);

    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
    );
    await expect(page.getByRole("heading", { name: "人员计划" })).toBeVisible();
    await expect(page.getByTestId("time-canvas-root")).toBeVisible();
    await expect(page.getByText("只看冲突")).toHaveCount(0);
    await expect(page.getByText("投入比例")).toHaveCount(0);
    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.inactiveHistory.person.id}&zoom=hour`,
    );
    await expect(
      page.getByText(
        `${fixture.inactiveHistory.person.displayName}（已停用）`,
        { exact: true },
      ).first(),
    ).toBeVisible();
    await page.getByTestId("time-canvas-scroll").evaluate((element) => {
      element.scrollLeft = 1_200;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(
      page.getByTestId(`segment-block-${fixture.inactiveHistorySegmentId}`),
    ).toBeVisible();
    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
    );
    await expect(
      page.getByRole("button", { name: `移除${fixture.member.person.displayName}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `移除${fixture.owner.person.displayName}` }),
    ).toBeVisible();
    const peoplePicker = page.getByLabel("筛选人员", { exact: true });
    await peoplePicker.click();
    await peoplePicker.press("Backspace");
    await expect(
      page.getByRole("button", { name: `移除${fixture.owner.person.displayName}` }),
    ).toHaveCount(0);
    await peoplePicker.fill(fixture.owner.person.displayName);
    const ownerOption = page.getByRole("option", {
      name: fixture.owner.person.displayName,
      exact: true,
    });
    await expect(ownerOption.locator(".sr-only")).toHaveText("已绑定账号");
    const ownerLabelBox = await ownerOption
      .getByText(fixture.owner.person.displayName, { exact: true })
      .boundingBox();
    expect(ownerLabelBox?.width ?? 0).toBeGreaterThan(80);
    await ownerOption.click();
    const taskPicker = page.getByLabel("筛选 Task", { exact: true });
    await taskPicker.fill(fixture.taskTitle);
    const taskOption = page.getByRole("option", {
      name: fixture.taskTitle,
      exact: true,
    });
    await expect(taskOption.locator(".sr-only")).toContainText("进行中 · 高");
    await expect(taskOption.locator(".sr-only")).toContainText("英雄 / 电控");
    const taskTitleBox = await taskOption
      .getByText(fixture.taskTitle, { exact: true })
      .boundingBox();
    expect(taskTitleBox?.width ?? 0).toBeGreaterThan(120);
    await taskOption.click();
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(page).toHaveURL(new RegExp(`tasks=${fixture.taskId}`));
    await page.reload();
    await expect(
      page.getByRole("button", { name: `移除${fixture.owner.person.displayName}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `移除${fixture.taskTitle}` }),
    ).toBeVisible();
    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&tasks=${fixture.taskId}&group=task&zoom=hour`,
    );
    await expect(page.getByText(fixture.taskTitle, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "新增投入" })).toBeVisible();
    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
    );
    if (testInfo.project.name === "desktop") {
      await page.goto(
        `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id}&zoom=hour`,
      );
      const emptyCanvasScroll = page.getByTestId("time-canvas-scroll");
      await emptyCanvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const emptyRow = page.getByLabel(`${fixture.member.person.displayName} 时间行`, { exact: true });
      const emptyScrollBox = await emptyCanvasScroll.boundingBox();
      const emptyRowBox = await emptyRow.boundingBox();
      if (!emptyScrollBox || !emptyRowBox) throw new Error("未找到空人员行拖选坐标");
      const brushStartX = emptyScrollBox.x + Math.min(emptyScrollBox.width - 140, 760);
      const brushY = emptyRowBox.y + emptyRowBox.height - 8;
      await page.mouse.click(brushStartX, brushY);
      const clickCreate = page.getByRole("form", { name: "投入快速创建" });
      await expect(clickCreate).toBeVisible();
      const minimumRange = page.getByTestId("time-canvas-creation-range");
      await expect(minimumRange).toBeVisible();
      expect((await minimumRange.boundingBox())?.width ?? 0).toBeGreaterThan(0);
      await clickCreate.getByRole("button", { name: "取消", exact: true }).click();
      await expect(minimumRange).toHaveCount(0);
      await emptyRow.scrollIntoViewIfNeeded();
      const dragScrollBox = await emptyCanvasScroll.boundingBox();
      const dragRowBox = await emptyRow.boundingBox();
      if (!dragScrollBox || !dragRowBox) {
        throw new Error("取消快速创建后未找到空人员行拖选坐标");
      }
      const dragStartX =
        dragScrollBox.x + Math.min(dragScrollBox.width - 140, 760);
      const dragY = dragRowBox.y + dragRowBox.height - 8;
      await page.mouse.move(dragStartX, dragY);
      await page.mouse.down();
      await page.mouse.move(dragStartX + 72, dragY, { steps: 4 });
      await page.mouse.up();
      const brushCreate = page.getByRole("form", { name: "投入快速创建" });
      await expect(brushCreate).toBeVisible();
      await expect(page.getByTestId("time-canvas-creation-range")).toBeVisible();
      await expect(page.getByTestId("time-canvas-creation-range")).toHaveCSS(
        "border-top-style",
        "dashed",
      );
      await expect(brushCreate.getByLabel("投入比例")).toHaveCount(0);
      await brushCreate.getByLabel("Task", { exact: true }).fill(fixture.taskTitle);
      await page
        .getByRole("option", { name: fixture.taskTitle, exact: true })
        .click();
      await brushCreate.getByLabel("内容").fill(fixture.brushCreateContent);
      await brushCreate.getByRole("button", { name: "创建", exact: true }).click();
      await expect(page.getByText("已创建投入记录")).toBeVisible();
      await expect(page.getByTestId("time-canvas-creation-range")).toHaveCount(0);
      await expect.poll(() => prisma.workSegment.findFirst({
        where: {
          personId: fixture.member.person.id,
          content: fixture.brushCreateContent,
        },
        select: { taskId: true },
      })).toEqual({ taskId: fixture.taskId });
      await page.goto(
        `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&zoom=hour`,
      );
      const canvasScroll = page.getByTestId("time-canvas-scroll");
      await expect(canvasScroll).toBeVisible();
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const beforeKeyboardMove = await prisma.workSegment.findUniqueOrThrow({
        where: { id: fixture.movableSegmentId },
        select: { startAt: true },
      });
      const movable = page.getByTestId(`segment-block-${fixture.movableSegmentId}`);
      await prisma.workSegment.update({
        where: { id: fixture.movableSegmentId },
        data: { content: "P6 UI 制造 stale 后仍可重试" },
      });
      await movable.focus();
      await movable.press("Shift+ArrowRight");
      await expect(page.getByText(/投入记录已被他人修改/)).toBeVisible();
      expect(
        await prisma.workSegment.findUniqueOrThrow({
          where: { id: fixture.movableSegmentId },
          select: { startAt: true },
        }),
      ).toMatchObject({ startAt: beforeKeyboardMove.startAt });
      await page.waitForTimeout(500);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      await movable.focus();
      await movable.press("Shift+ArrowRight");
      await expect(page.getByText("已移动计划投入")).toBeVisible();
      await expect
        .poll(async () => {
          const row = await prisma.workSegment.findUniqueOrThrow({
            where: { id: fixture.movableSegmentId },
            select: { startAt: true },
          });
          return row.startAt.getTime();
        })
        .toBe(beforeKeyboardMove.startAt.getTime() + 30 * 60 * 1_000);
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const beforeInvalidDrop = await prisma.workSegment.findUniqueOrThrow({
        where: { id: fixture.movableSegmentId },
        select: { startAt: true, endAt: true },
      });
      const movableBox = await page
        .getByTestId(`segment-block-${fixture.movableSegmentId}`)
        .boundingBox();
      const otherRowBox = await page
        .getByLabel(`${fixture.owner.person.displayName} 时间行`, { exact: true })
        .boundingBox();
      if (!movableBox || !otherRowBox) throw new Error("未找到跨行拖动测试坐标");
      await page.mouse.move(movableBox.x + movableBox.width / 2, movableBox.y + movableBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(movableBox.x + movableBox.width / 2 + 36, otherRowBox.y + otherRowBox.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByText("不支持跨人员行拖放，投入仍保留在原位置。")).toBeVisible();
      expect(
        await prisma.workSegment.findUniqueOrThrow({
          where: { id: fixture.movableSegmentId },
          select: { startAt: true, endAt: true },
        }),
      ).toMatchObject(beforeInvalidDrop);

      await page.mouse.move(movableBox.x + movableBox.width / 2, movableBox.y + movableBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(movableBox.x + movableBox.width / 2 + 36, movableBox.y + movableBox.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByText("已移动计划投入")).toBeVisible();
      await expect
        .poll(async () => (await prisma.workSegment.findUniqueOrThrow({ where: { id: fixture.movableSegmentId }, select: { startAt: true } })).startAt.getTime())
        .toBe(beforeInvalidDrop.startAt.getTime() + 30 * 60 * 1_000);
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const beforeStartResize = await prisma.workSegment.findUniqueOrThrow({
        where: { id: fixture.movableSegmentId },
        select: { startAt: true },
      });
      const startResizeHandle = page
        .getByTestId(`segment-block-${fixture.movableSegmentId}`)
        .locator('[data-resize-handle="start"]');
      const startResizeBox = await startResizeHandle.boundingBox();
      if (!startResizeBox) throw new Error("未找到可见的 Segment 开始时间调整柄");
      await page.mouse.move(startResizeBox.x + startResizeBox.width / 2, startResizeBox.y + startResizeBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(startResizeBox.x + startResizeBox.width / 2 - 36, startResizeBox.y + startResizeBox.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByText("已调整计划投入区间")).toBeVisible();
      await expect
        .poll(async () => (await prisma.workSegment.findUniqueOrThrow({ where: { id: fixture.movableSegmentId }, select: { startAt: true } })).startAt.getTime())
        .toBe(beforeStartResize.startAt.getTime() - 30 * 60 * 1_000);
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const beforeResize = await prisma.workSegment.findUniqueOrThrow({
        where: { id: fixture.movableSegmentId },
        select: { endAt: true },
      });
      const resizeHandle = page
        .getByTestId(`segment-block-${fixture.movableSegmentId}`)
        .locator('[data-resize-handle="end"]');
      const resizeBox = await resizeHandle.boundingBox();
      if (!resizeBox) throw new Error("未找到可见的 Segment 结束时间调整柄");
      await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 36, resizeBox.y + resizeBox.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByText("已调整计划投入区间")).toBeVisible();
      await expect
        .poll(async () => {
          const row = await prisma.workSegment.findUniqueOrThrow({
            where: { id: fixture.movableSegmentId },
            select: { endAt: true },
          });
          return row.endAt.getTime();
        })
        .toBe(beforeResize.endAt.getTime() + 30 * 60 * 1_000);
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      const expectedRangeAfterTransforms = await prisma.workSegment.findUniqueOrThrow({
        where: { id: fixture.movableSegmentId },
        select: { startAt: true, endAt: true },
      });
      await page.getByTestId(`segment-block-${fixture.movableSegmentId}`).click();
      const movedInspector = page.getByTestId("segment-inspector");
      await expect(movedInspector.getByRole("heading", { name: "P6 UI 制造 stale 后仍可重试" })).toBeVisible();
      await expect(movedInspector.getByLabel("投入比例")).toHaveCount(0);
      await expect(movedInspector.getByLabel("职责", { exact: true })).toHaveCount(0);
      await expect(movedInspector.getByLabel("自定义职责")).toHaveCount(0);
      await movedInspector.getByLabel("内容").fill("P6 UI Inspector 更新不覆盖画布时间");
      await movedInspector.getByRole("button", { name: "保存精确修改" }).click();
      await expect(page.getByText("已更新投入详情")).toBeVisible();
      await expect.poll(async () => {
        const row = await prisma.workSegment.findUniqueOrThrow({
          where: { id: fixture.movableSegmentId },
          select: { startAt: true, endAt: true },
        });
        return {
          startAt: row.startAt.toISOString(),
          endAt: row.endAt.toISOString(),
        };
      }).toEqual({
        startAt: expectedRangeAfterTransforms.startAt.toISOString(),
        endAt: expectedRangeAfterTransforms.endAt.toISOString(),
      });
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      await page
        .getByTestId(`segment-block-${fixture.batchCancelableSegmentIds[0]}`)
        .click({ modifiers: ["Shift"] });
      await page
        .getByTestId(`segment-block-${fixture.batchCancelableSegmentIds[1]}`)
        .click({ modifiers: ["Shift"] });
      await expect(page.getByText("已选 2 条")).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "批量取消", exact: true }).click();
      await expect(page.getByText("已原子取消所选计划")).toBeVisible();
      await expect.poll(() => prisma.workSegment.count({
        where: {
          id: { in: [...fixture.batchCancelableSegmentIds] },
          status: "CANCELLED",
        },
      })).toBe(2);
      await page.waitForTimeout(800);
      await canvasScroll.evaluate((element) => {
        element.scrollLeft = 1_200;
        element.dispatchEvent(new Event("scroll"));
      });
      await page
        .getByTestId(`segment-block-${fixture.confirmableSegmentId}`)
        .click();
    } else {
      await expect(page.getByTestId("time-canvas-scroll")).toBeVisible();
      await page.getByRole("button", { name: "新增投入" }).click();
      const quickCreate = page.getByRole("form", { name: "投入快速创建" });
      await expect(quickCreate.getByLabel("投入比例")).toHaveCount(0);
      await quickCreate.getByLabel("内容").fill(fixture.mobileCreateContent);
      const actionUrl = "**/progress/resources**";
      let actionAborted = false;
      const abortFirstAction = async (route: import("@playwright/test").Route) => {
        if (!actionAborted && route.request().method() === "POST") {
          actionAborted = true;
          await route.abort();
          return;
        }
        await route.continue();
      };
      await page.route(actionUrl, abortFirstAction);
      await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
      await expect(page.getByText("网络异常，未能保存；输入仍保留，可直接重试。")).toBeVisible();
      await expect(quickCreate.getByLabel("内容")).toHaveValue(fixture.mobileCreateContent);
      await page.unroute(actionUrl, abortFirstAction);
      await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
      await expect(page.getByText("已创建投入记录")).toBeVisible();
      await expect
        .poll(() => prisma.workSegment.count({ where: { content: fixture.mobileCreateContent } }))
        .toBe(1);
      await page.waitForTimeout(800);
      await page
        .getByTestId(`agenda-item-${fixture.confirmableSegmentId}`)
        .click();
    }
    await expect(page.getByTestId("segment-inspector")).toBeVisible();
    await expect(
      page
        .getByTestId("segment-inspector")
        .getByRole("heading", { name: "P6 UI 可确认计划" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "完整确认", exact: true }).click();
    await expect(page.getByText("已完整确认并生成 Actual")).toBeVisible();
    await expect
      .poll(async () => {
        const row = await prisma.workSegment.findUniqueOrThrow({
          where: { id: fixture.confirmableSegmentId },
          select: { status: true },
        });
        return row.status;
      })
      .toBe("CONFIRMED");
    await expectHealthyPage(page);
    expect(pageErrors).toEqual([]);

    await page.goto("/progress/notifications");
    await expect(page.getByRole("heading", { name: "站内通知" })).toBeVisible();
    await expect(page.getByText("P6 UI 通知")).toBeVisible();
    await page
      .locator("article")
      .filter({ hasText: "P6 UI 通知" })
      .getByRole("button", { name: "标记已读" })
      .click();
    await expect(page.getByText("已标记通知为已读")).toBeVisible();
    await expect
      .poll(async () => {
        const row = await prisma.inAppNotification.findUniqueOrThrow({
          where: { id: fixture.notificationId },
          select: { readAt: true },
        });
        return row.readAt !== null;
      })
      .toBe(true);
    await expectHealthyPage(page);
  });

  test("non-member can view the full Task workbench but cannot mutate it", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createUiFixture();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.outsider.openId,
      name: fixture.outsider.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(page.getByRole("heading", { name: fixture.taskTitle })).toBeVisible();
    await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
    await expect(page.getByRole("button", { name: "修改 Task 基本信息" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "发起 Revision" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "提交验收" })).toHaveCount(0);
    await expectHealthyPage(page);

    await page.goto("/progress/notifications");
    await expect(page.getByRole("heading", { name: "站内通知" })).toBeVisible();
    await expect(page.getByText("P6 UI 通知")).toHaveCount(0);
    await expect(
      markInAppNotificationReadService(actor(fixture.outsider), {
        notificationId: fixture.notificationId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("S8 dashboard, action inbox, Tag and notification preferences work on desktop and mobile", async ({
    context,
    page,
    baseURL,
  }) => {
    const user = await createAccountPerson("S8 驾驶舱用户");
    await loginAsTestUser(context, baseURL, {
      openId: user.openId,
      name: user.person.displayName,
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/progress");
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
    await expect(page.getByLabel("工作指标")).toBeVisible();
    await expect(page.getByTestId("action-inbox")).toHaveCount(0);
    await expectHealthyPage(page);

    await page.goto("/progress/approvals");
    await expect(page.getByRole("heading", { name: "待办与审批" })).toBeVisible();
    await expect(page.getByText("当前没有需要你处理的事项。")).toBeVisible();

    const tagName = `S8 Tag ${randomUUID().slice(0, 12)}`;
    await page.goto("/progress/tags");
    await expect(page.getByRole("heading", { name: "Tag 管理" })).toBeVisible();
    await page.getByLabel("Tag 名称").fill(tagName);
    await page.getByLabel("说明").fill("S8 双端 Tag 管理验证");
    await page.getByRole("button", { name: "创建 Tag" }).click();
    await expect(page.getByText("Tag 已创建。")).toBeVisible();
    await expect(page.getByRole("heading", { name: tagName })).toBeVisible();
    await expect.poll(() => prisma.tag.count({ where: { name: tagName } })).toBe(1);

    await page.goto("/progress/notifications");
    await expect(page.getByRole("heading", { name: "通知偏好" })).toBeVisible();
    const taskFeishu = page.getByRole("checkbox", { name: "Task飞书通知" });
    await expect(taskFeishu).toBeChecked();
    await taskFeishu.uncheck();
    await expect(page.getByText(/通知偏好已保存/)).toBeVisible();
    await expect
      .poll(async () => {
        return prisma.notificationPreference.findUnique({
          where: {
            accountId_category_channel: {
              accountId: user.account.id,
              category: "TASK",
              channel: "FEISHU",
            },
          },
          select: { enabled: true },
        });
      })
      .toEqual({ enabled: false });
    await expectHealthyPage(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  test("Task workbench uses the unified Draft editor and locks it after activation", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    const fixture = await createDraftWorkbenchFixture();
    const addedMember = await createAccountPerson(
      `S6 Unified Editor Member ${randomUUID()}`,
    );
    const inactiveCurrentMember = await createAccountPerson(
      "S6 Unified Editor Inactive Member",
    );
    await prisma.taskMember.create({
      data: {
        taskId: fixture.taskId,
        personId: inactiveCurrentMember.person.id,
        role: "PARTICIPANT",
        createdByAccountId: fixture.admin.account.id,
      },
    });
    await prisma.person.update({
      where: { id: inactiveCurrentMember.person.id },
      data: { status: "INACTIVE" },
    });
    const tag = await prisma.tag.create({
      data: {
        name: `S6 Unified Editor Tag ${randomUUID()}`,
        color: "#2563eb",
        createdByAccountId: fixture.admin.account.id,
      },
    });
    const archivedTag = await prisma.tag.create({
      data: {
        name: `S6 Unified Editor Archived Tag ${randomUUID()}`,
        color: "#64748b",
        archivedAt: new Date(),
        createdByAccountId: fixture.admin.account.id,
      },
    });
    await prisma.taskTag.create({
      data: { taskId: fixture.taskId, tagId: archivedTag.id },
    });
    const updatedTitle = `S6 Unified Edited ${randomUUID()}`;
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(page.getByRole("heading", { name: fixture.taskTitle })).toBeVisible();
    await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
    await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
    await expect(page.getByRole("heading", { name: "编辑 Draft 计划" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "编辑 Task" })).toBeVisible();
    await expect(page.getByRole("button", { name: "修改 Task 基本信息" })).toHaveCount(0);

    await page.getByRole("link", { name: "编辑 Task" }).click();
    await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}/edit`);
    await expect(page.getByRole("heading", { name: "编辑 Task" })).toBeVisible();
    await expect(page.getByTestId("task-composer")).toHaveAttribute(
      "data-composer-mode",
      "EDIT_DRAFT",
    );
    await expect(page.getByLabel("Task 名称")).toHaveValue(fixture.taskTitle);
    await expect(page.getByText(inactiveCurrentMember.person.displayName)).toBeVisible();
    await expect(page.getByLabel(`${archivedTag.name}（已归档）`)).toBeChecked();
    await expect(page.getByRole("button", { name: "保存 Task" }).first()).toBeDisabled();
    if (testInfo.project.name === "mobile") {
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /S6 Draft 第一阶段/ })
        .click();
    } else {
      await page.getByRole("button", { name: "编辑 S6 Draft 第一阶段" }).click();
    }
    await expect(page.getByRole("button", { name: "保存 Task" }).first()).toBeDisabled();

    await page.getByLabel("描述").fill("会被撤销的本地修改");
    await expect
      .poll(() =>
        page.evaluate((taskId) =>
          Object.keys(window.localStorage).some(
            (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
          ),
        fixture.taskId),
      )
      .toBe(true);
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(page.getByLabel("描述")).toHaveValue("S6 Draft 工作台测试");
    await expect(page.getByRole("button", { name: "保存 Task" }).first()).toBeDisabled();
    await expect
      .poll(() =>
        page.evaluate((taskId) =>
          Object.keys(window.localStorage).every(
            (key) => !key.startsWith("task-edit-draft:") || !key.includes(taskId),
          ),
        fixture.taskId),
      )
      .toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/progress/tasks/${fixture.taskId}(?:\\?tab=overview)?$`));
    await page.getByRole("link", { name: "编辑 Task" }).click();
    await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toHaveCount(0);

    await page.getByLabel("Task 名称").fill(updatedTitle);
    await expect
      .poll(() =>
        page.evaluate((taskId) =>
          Object.keys(window.localStorage).some(
            (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
          ),
        fixture.taskId),
      )
      .toBe(true);
    const editDraftStorageKey = await page.evaluate((taskId) =>
      Object.keys(window.localStorage).find(
        (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
      ) ?? null,
    fixture.taskId);
    expect(editDraftStorageKey).not.toBeNull();
    await page.reload();
    await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toBeVisible();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByLabel("Task 名称")).toHaveValue(updatedTitle);

    await page.getByLabel(tag.name).check();
    await page.getByLabel(`${archivedTag.name}（已归档）`).uncheck();
    await page.getByLabel("搜索参与人员", { exact: true }).fill(addedMember.person.displayName);
    await page
      .getByRole("option", {
        name: addedMember.person.displayName,
        exact: true,
      })
      .click();

    if (testInfo.project.name === "mobile") {
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /S6 Draft 第一阶段/ })
        .click();
    } else {
      await page.getByRole("button", { name: "编辑 S6 Draft 第一阶段" }).click();
    }
    await page.getByLabel("目标").fill("S6 Draft 持久化目标");
    await page.getByRole("button", { name: "添加 Milestone", exact: true }).first().click();
    const draftInspector = page.getByTestId("task-composer-inspector");
    await draftInspector
      .getByRole("textbox", { name: /^目标/ })
      .fill("S6 新增 Milestone");
    await draftInspector
      .getByRole("textbox", { name: /^完成条件/ })
      .fill("新增节点保存到数据库");
    await draftInspector
      .getByRole("textbox", { name: /^验收要求/ })
      .fill("提交文本证据");
    await page.getByLabel("预期完成时间").fill("2026-08-03T18:00");
    if (testInfo.project.name === "mobile") {
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ })
        .click();
    } else {
      await page.getByRole("button", { name: "编辑 Terminal" }).click();
    }
    await page.getByLabel("Terminal 名称").fill("S6 Edited Terminal");
    await page.getByRole("button", { name: "保存 Task" }).first().click();
    await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
    await expect
      .poll(async () => {
        const task = await prisma.task.findUniqueOrThrow({
          where: { id: fixture.taskId },
          include: {
            currentPlanVersion: {
              include: {
                nodes: {
                  include: {
                    node: { include: { milestone: true, termination: true } },
                  },
                },
              },
            },
            members: { where: { removedAt: null } },
            tags: true,
          },
        });
        return {
          title: task.title,
          lockVersion: task.lockVersion,
          memberIds: task.members.map((member) => member.personId),
          tagIds: task.tags.map((entry) => entry.tagId),
          milestones: task.currentPlanVersion.nodes
            .flatMap((entry) => entry.node.milestone?.goal ?? [])
            .sort(),
          terminal: task.currentPlanVersion.nodes.find(
            (entry) => entry.node.termination,
          )?.node.termination?.name,
        };
      })
      .toEqual({
        title: updatedTitle,
        lockVersion: 1,
        memberIds: expect.arrayContaining([addedMember.person.id]),
        tagIds: [tag.id],
        milestones: [
          "S6 Draft 持久化目标",
          "S6 Draft 第二阶段",
          "S6 新增 Milestone",
        ].sort(),
        terminal: "S6 Edited Terminal",
      });
    expect(
      await page.evaluate((key) => key ? window.localStorage.getItem(key) : null, editDraftStorageKey),
    ).toBeNull();

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "激活 Task" }).click();
    await expect(page.getByText("Task 已激活。")).toBeVisible();
    await expect(page.getByRole("button", { name: "修改 Task 基本信息" })).toBeVisible();
    await expect(page.getByRole("link", { name: "编辑 Task" })).toHaveCount(0);
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { status: true, lockVersion: true },
        }),
      )
      .toEqual({ status: "ACTIVE", lockVersion: 2 });
    await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
    await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
    await expectHealthyPage(page);
  });

  test("Draft editor preserves every legacy member role and drops recovered member edits", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createDraftWorkbenchFixture();
    const legacyMembers = await Promise.all(
      (["LEAD", "MEMBER", "REVIEWER", "VIEWER"] as const).map(async (role) => ({
        role,
        account: await createAccountPerson(`S6 Legacy Draft ${role}`),
      })),
    );
    const updatedTitle = `S6 Legacy Draft Edited ${randomUUID()}`;
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
    await page
      .getByRole("button", {
        name: `移除 ${fixture.reviewer.person.displayName} 参与人员`,
      })
      .click();
    await page.getByLabel("Task 名称").fill(updatedTitle);
    await expect
      .poll(() =>
        page.evaluate((taskId) =>
          Object.keys(window.localStorage).some(
            (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
          ),
        fixture.taskId),
      )
      .toBe(true);
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "TaskMember" DROP CONSTRAINT "TaskMember_active_role_check"',
    );
    try {
      await prisma.taskMember.createMany({
        data: legacyMembers.map(({ account, role }) => ({
          taskId: fixture.taskId,
          personId: account.person.id,
          role,
          createdByAccountId: fixture.admin.account.id,
        })),
      });
    } finally {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE "TaskMember"
          ADD CONSTRAINT "TaskMember_active_role_check"
          CHECK (
            "removedAt" IS NOT NULL
            OR role IN ('OWNER', 'PARTICIPANT')
          ) NOT VALID
      `);
    }

    await page.reload();
    await expect(page.getByRole("button", { name: "恢复草稿" })).toBeVisible();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByLabel("Task 名称")).toHaveValue(updatedTitle);
    await expect(page.getByText(fixture.reviewer.person.displayName)).toBeVisible();
    const memberList = page.locator("#members");
    for (const { account, role } of legacyMembers) {
      const row = memberList.getByText(account.person.displayName).locator("..");
      await expect(row).toContainText(
        role === "REVIEWER"
          ? "审批人（历史）"
          : role === "VIEWER"
            ? "只读（历史）"
            : "参与人（历史）",
      );
    }
    await expect(page.getByText(/此 Task 含历史成员角色/)).toBeVisible();
    await expect(page.getByLabel("搜索负责人", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("搜索参与人员", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "保存 Task" }).first().click();
    await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
    await expect
      .poll(async () => {
        const task = await prisma.task.findUniqueOrThrow({
          where: { id: fixture.taskId },
          select: {
            title: true,
            lockVersion: true,
            members: {
              where: { removedAt: null },
              select: { personId: true, role: true },
              orderBy: [{ personId: "asc" }, { role: "asc" }],
            },
          },
        });
        return task;
      })
      .toEqual({
        title: updatedTitle,
        lockVersion: 1,
        members: [
          { personId: fixture.admin.person.id, role: "OWNER" },
          { personId: fixture.owner.person.id, role: "OWNER" },
          { personId: fixture.reviewer.person.id, role: "PARTICIPANT" },
          ...legacyMembers.map(({ account, role }) => ({
            personId: account.person.id,
            role,
          })),
        ].sort((left, right) =>
          left.personId.localeCompare(right.personId) ||
          left.role.localeCompare(right.role),
        ),
      });
    await expectHealthyPage(page);
  });

  test("Task Owner can delete an unactivated draft from the workbench", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createDraftWorkbenchFixture();

    await loginAsTestUser(context, baseURL, {
      openId: fixture.reviewer.openId,
      name: fixture.reviewer.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(page.getByRole("button", { name: "删除草稿" })).toHaveCount(0);

    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    const deleteButton = page.getByRole("button", { name: "删除草稿" });
    await expect(deleteButton).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("确定删除这个 Task 草稿");
      await dialog.accept();
    });
    await deleteButton.click();
    await expect(page).toHaveURL("/progress/tasks");
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { deletedAt: true, lockVersion: true },
        }),
      )
      .toMatchObject({ deletedAt: expect.any(Date), lockVersion: 1 });
    await expect(
      prisma.domainAuditEvent.count({
        where: { taskId: fixture.taskId, action: "pm.task.draft.delete" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationOutbox.count({
        where: {
          eventKey: `pm:task:deleted:${fixture.taskId}:1:feishu`,
          type: "task_deleted",
          botKind: "notification",
        },
      }),
    ).resolves.toBe(1);
    const deletedResponse = await page.goto(`/progress/tasks/${fixture.taskId}`);
    expect(deletedResponse?.status()).toBe(404);
    await expectHealthyPage(page);
  });

  test("Draft editor omits unchanged members after a live ownership downgrade", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createDraftWorkbenchFixture();
    const replacementOwner = await createAccountPerson("S6 Replacement Draft Owner");
    const updatedTitle = `S6 Downgraded Draft Edited ${randomUUID()}`;
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
    await expect(page.getByLabel("搜索负责人", { exact: true })).toBeVisible();
    await expect(page.getByLabel("搜索参与人员", { exact: true })).toBeVisible();
    await prisma.taskMember.updateMany({
      where: {
        taskId: fixture.taskId,
        personId: fixture.owner.person.id,
        role: "OWNER",
        removedAt: null,
      },
      data: { role: "PARTICIPANT" },
    });
    await prisma.taskMember.create({
      data: {
        taskId: fixture.taskId,
        personId: replacementOwner.person.id,
        role: "OWNER",
        createdByAccountId: fixture.admin.account.id,
      },
    });

    await page.getByLabel("Task 名称").fill(updatedTitle);
    await page.getByRole("button", { name: "保存 Task" }).first().click();
    await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
    await expect
      .poll(async () => {
        const task = await prisma.task.findUniqueOrThrow({
          where: { id: fixture.taskId },
          select: {
            title: true,
            lockVersion: true,
            members: {
              where: { removedAt: null },
              select: { personId: true, role: true },
              orderBy: [{ personId: "asc" }, { role: "asc" }],
            },
          },
        });
        return task;
      })
      .toEqual({
        title: updatedTitle,
        lockVersion: 1,
        members: [
          { personId: fixture.admin.person.id, role: "OWNER" },
          { personId: fixture.owner.person.id, role: "PARTICIPANT" },
          { personId: fixture.reviewer.person.id, role: "PARTICIPANT" },
          { personId: replacementOwner.person.id, role: "OWNER" },
        ].sort((left, right) =>
          left.personId.localeCompare(right.personId) ||
          left.role.localeCompare(right.role),
        ),
      });
    await expectHealthyPage(page);
  });

  test("Draft editor preserves stale local input without overwriting the server", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createDraftWorkbenchFixture();
    const serverTitle = `S6 Server Latest ${randomUUID()}`;
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
    await page.getByLabel("Task 名称").fill("S6 尚未提交的本地版本");
    await expect
      .poll(() =>
        page.evaluate((taskId) =>
          Object.keys(window.localStorage).some(
            (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
          ),
        fixture.taskId),
      )
      .toBe(true);
    const storageKey = await page.evaluate((taskId) =>
      Object.keys(window.localStorage).find(
        (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
      ) ?? null,
    fixture.taskId);
    expect(storageKey).not.toBeNull();

    await updateTaskDraftMetadata(actor(fixture.owner), {
      taskId: fixture.taskId,
      expectedLockVersion: 0,
      title: serverTitle,
      description: "服务端并发更新",
      team: "英雄",
      techGroup: "电控",
      priority: "MEDIUM",
      relatedTaskId: null,
      tagIds: [],
    });
    await page.getByRole("button", { name: "保存 Task" }).first().click();
    await expect(
      page.getByText(
        "Task 已在服务端更新，当前本地修改不会覆盖最新版本。请先导出，或放弃并加载最新版本。",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Task 名称")).toHaveValue("S6 尚未提交的本地版本");
    await expect(page.getByRole("button", { name: "导出原始草稿" })).toBeVisible();
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { title: true, lockVersion: true },
        }),
      )
      .toEqual({ title: serverTitle, lockVersion: 1 });

    await page.reload();
    await expect(
      page.getByText("Task 已在服务端更新，旧本地草稿不能直接覆盖最新版本。"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "恢复草稿" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "导出原始草稿" })).toBeVisible();
    await page.getByRole("button", { name: "放弃并加载最新版本" }).click();
    await expect(page.getByLabel("Task 名称")).toHaveValue(serverTitle);
    expect(
      await page.evaluate(
        (key) => (key ? window.localStorage.getItem(key) : null),
        storageKey,
      ),
    ).toBeNull();
    await expectHealthyPage(page);
  });

  test("Draft editor keeps Participant members read-only and denies unauthorized direct access", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    const fixture = await createDraftWorkbenchFixture();
    const outsider = await createAccountPerson("S6 Unified Editor Outsider");
    const searchFillerKey = randomUUID();
    await prisma.person.createMany({
      data: Array.from({ length: 55 }, (_, index) => ({
        displayName: `000 S6 permission search filler ${String(index).padStart(2, "0")} ${searchFillerKey}`,
        status: "ACTIVE" as const,
      })),
    });
    const localOnlyMember = await createAccountPerson(
      `S6 Permission Downgrade Local Member ${randomUUID()}`,
    );
    const temporaryAdministrator = await prisma.systemRoleAssignment.create({
      data: {
        accountId: fixture.reviewer.account.id,
        role: "PROJECT_ADMINISTRATOR",
        team: "",
        techGroup: "",
      },
    });
    const participantTitle = `S6 Participant Edited ${randomUUID()}`;
    const memberIdsBefore = (
      await prisma.taskMember.findMany({
        where: { taskId: fixture.taskId, removedAt: null },
        select: { personId: true },
        orderBy: { personId: "asc" },
      })
    ).map((member) => member.personId);
    await loginAsTestUser(context, baseURL, {
      openId: fixture.reviewer.openId,
      name: fixture.reviewer.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
    const memberPicker = page.getByLabel("搜索参与人员", { exact: true });
    await memberPicker.click();
    await memberPicker.press("ControlOrMeta+A");
    await memberPicker.pressSequentially(localOnlyMember.person.displayName);
    await page
      .getByRole("option", {
        name: localOnlyMember.person.displayName,
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate((taskId) =>
          Object.keys(window.localStorage).some(
            (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
          ),
        fixture.taskId),
      )
      .toBe(true);
    await prisma.systemRoleAssignment.update({
      where: { id: temporaryAdministrator.id },
      data: {
        revokedAt: new Date(),
        revokedByAccountId: fixture.reviewer.account.id,
      },
    });
    await page.reload();
    await expect(page.getByRole("button", { name: "恢复草稿" })).toBeVisible();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByText("你可以编辑 Task 内容和计划，成员与角色为只读。")).toBeVisible();
    await expect(page.getByLabel("搜索负责人", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("搜索参与人员", { exact: true })).toHaveCount(0);
    await expect(page.getByText(localOnlyMember.person.displayName)).toHaveCount(0);
    await page.getByLabel("Task 名称").fill(participantTitle);
    if (testInfo.project.name === "mobile") {
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /S6 Draft 第一阶段/ })
        .click();
    } else {
      await page.getByRole("button", { name: "编辑 S6 Draft 第一阶段" }).click();
    }
    await page.getByLabel("目标").fill("S6 Participant 更新计划");
    await page.getByRole("button", { name: "保存 Task" }).first().click();
    await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
    await expect
      .poll(async () => {
        const task = await prisma.task.findUniqueOrThrow({
          where: { id: fixture.taskId },
          include: {
            members: {
              where: { removedAt: null },
              select: { personId: true },
              orderBy: { personId: "asc" },
            },
          },
        });
        return {
          title: task.title,
          lockVersion: task.lockVersion,
          memberIds: task.members.map((member) => member.personId),
        };
      })
      .toEqual({
        title: participantTitle,
        lockVersion: 1,
        memberIds: memberIdsBefore,
      });

    await loginAsTestUser(context, baseURL, {
      openId: outsider.openId,
      name: outsider.person.displayName,
    });
    const response = await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId("task-composer")).toHaveCount(0);
  });

  test("Draft editor isolates local recovery across Tasks and accounts", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createDraftWorkbenchFixture();
    const secondTitle = `S6 Isolated Draft ${randomUUID()}`;
    const secondTask = await createTaskDraft(actor(fixture.admin), {
      title: secondTitle,
      description: "用于验证编辑草稿按 Task 隔离",
      team: "英雄",
      techGroup: "电控",
      priority: "MEDIUM",
      tagIds: [],
      relatedTaskId: null,
      members: [{ personId: fixture.owner.person.id, role: "OWNER" }],
      milestones: [],
      plannedStartAt: new Date(Date.UTC(2026, 7, 10, 10, 0, 0)).toISOString(),
      termination: terminationInput(12),
      idempotencyKey: `s6-edit-isolation-${randomUUID()}`,
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
    await page.getByLabel("Task 名称").fill("S6 Owner Task One Local Draft");
    await expect
      .poll(() =>
        page.evaluate((taskId) =>
          Object.keys(window.localStorage).some(
            (key) => key.startsWith("task-edit-draft:") && key.includes(taskId),
          ),
        fixture.taskId),
      )
      .toBe(true);
    await page.getByRole("button", { name: "返回 Task 工作台" }).click();
    await page.getByRole("button", { name: "保存本地草稿并离开" }).click();
    await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);

    await page.goto(`/progress/tasks/${secondTask.taskId}/edit`);
    await expect(page.getByLabel("Task 名称")).toHaveValue(secondTitle);
    await expect(page.getByRole("button", { name: "恢复草稿" })).toHaveCount(0);

    await loginAsTestUser(context, baseURL, {
      openId: fixture.reviewer.openId,
      name: fixture.reviewer.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
    await expect(page.getByLabel("Task 名称")).toHaveValue(fixture.taskTitle);
    await expect(page.getByRole("button", { name: "恢复草稿" })).toHaveCount(0);

    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
    await expect(page.getByRole("button", { name: "恢复草稿" })).toBeVisible();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByLabel("Task 名称")).toHaveValue(
      "S6 Owner Task One Local Draft",
    );
    await expectHealthyPage(page);
  });

  test("Task workbench quick create skips an inactive first member", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createDraftWorkbenchFixture();
    await prisma.person.update({
      where: { id: fixture.owner.person.id },
      data: { status: "INACTIVE" },
    });
    await prisma.person.update({
      where: { id: fixture.admin.person.id },
      data: { status: "INACTIVE" },
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.reviewer.openId,
      name: fixture.reviewer.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("button", { name: "新增投入", exact: true }).click();
    const quickCreate = page.getByRole("form", { name: "投入快速创建" });
    await expect(quickCreate.locator('input[name="personId"]')).toHaveValue(
      fixture.reviewer.person.id,
    );
    await expect(
      quickCreate.getByLabel("人员", { exact: true }),
    ).toHaveValue(fixture.reviewer.person.displayName);
    await quickCreate
      .getByLabel("人员", { exact: true })
      .fill(fixture.owner.person.displayName);
    await expect(page.getByText("没有匹配项。")).toBeVisible();
    await expect(
      page.getByRole("option", {
        name: new RegExp(fixture.owner.person.displayName),
      }),
    ).toHaveCount(0);
    await quickCreate.getByLabel("人员", { exact: true }).press("Escape");
    await expect(quickCreate.getByLabel("Task", { exact: true })).toHaveValue(
      fixture.taskTitle,
    );
    await expect(quickCreate.getByLabel("Task", { exact: true })).toHaveAttribute(
      "readonly",
      "",
    );
    await expect(quickCreate.locator('input[name="taskId"]')).toHaveValue(
      fixture.taskId,
    );
    await expectHealthyPage(page);
  });

  test("Task workbench keeps saved related Task and members across authoritative refreshes", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createDraftWorkbenchFixture();
    const addedMember = await createAccountPerson(
      `S6 Workbench Persisted Member ${randomUUID()}`,
    );
    const relatedTitle = `S6 Workbench Related ${randomUUID()}`;
    const related = await createTaskDraft(actor(fixture.admin), {
      title: relatedTitle,
      description: "验证 Workbench 保存后的 authoritative refresh",
      team: "英雄",
      techGroup: "电控",
      priority: "MEDIUM",
      tagIds: [],
      members: [{ personId: fixture.owner.person.id, role: "OWNER" }],
      milestones: [milestoneInput("关联 Task 阶段", "关联 Task 完成条件", 1)],
      plannedStartAt: new Date(Date.UTC(2026, 7, 1, 1, 0, 0)).toISOString(),
      termination: terminationInput(5),
      idempotencyKey: `s6-workbench-related-${randomUUID()}`,
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("button", { name: "新增投入", exact: true }).click();
    const quickCreate = page.getByRole("form", { name: "投入快速创建" });
    const segmentPersonPicker = quickCreate.getByLabel("人员", { exact: true });
    await segmentPersonPicker.click();
    await expect(
      page.getByRole("option", {
        name: fixture.admin.person.displayName,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("option", {
        name: fixture.reviewer.person.displayName,
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("option", {
        name: fixture.reviewer.person.displayName,
        exact: true,
      })
      .click();
    await expect(quickCreate.locator('input[name="personId"]')).toHaveValue(
      fixture.reviewer.person.id,
    );
    await quickCreate.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("link", { name: "编辑 Task" }).click();
    const relatedPicker = page.getByLabel("关联 Task", { exact: true });
    await relatedPicker.fill(relatedTitle);
    await page
      .getByRole("option", { name: relatedTitle, exact: true })
      .click();
    const memberPicker = page.getByLabel("搜索参与人员", { exact: true });
    await memberPicker.fill(addedMember.person.displayName);
    await page
      .getByRole("option", {
        name: addedMember.person.displayName,
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "保存 Task" }).first().click();
    await expect(page).toHaveURL(`/progress/tasks/${fixture.taskId}`);
    await expect
      .poll(async () => ({
        task: await prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { relatedTaskId: true, lockVersion: true },
        }),
        memberCount: await prisma.taskMember.count({
          where: {
            taskId: fixture.taskId,
            personId: addedMember.person.id,
            role: "PARTICIPANT",
            removedAt: null,
          },
        }),
      }))
      .toEqual({
        task: { relatedTaskId: related.taskId, lockVersion: 1 },
        memberCount: 1,
      });
    await page.getByRole("link", { name: "编辑 Task" }).click();
    await expect(relatedPicker).toHaveValue(relatedTitle);
    await expect(page.getByText(addedMember.person.displayName)).toBeVisible();
    await expectHealthyPage(page);
  });

  test("cancelling a rejected Revision keeps an unrelated Milestone gate", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createUiFixture();
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: fixture.taskId },
      select: { currentPlanVersionId: true, lockVersion: true },
    });
    const reason = `S6 不相关门禁 ${randomUUID()}`;
    const revision = await createRevision(actor(fixture.owner), {
      taskId: fixture.taskId,
      basePlanVersionId: task.currentPlanVersionId,
      baseTaskLockVersion: task.lockVersion,
      reason,
      description: reason,
      revisionAt: "2026-07-31T12:00:00.000Z",
      replacementMilestones: [
        milestoneInput("S6 不相关门禁候选", "候选完成条件", 2),
      ],
      termination: terminationInput(5),
      idempotencyKey: `s6-unrelated-gate-revision-${randomUUID()}`,
    });
    await rejectRevision(actor(fixture.admin), {
      revisionNodeId: revision.revisionNodeId,
      comment: "保留为可取消的已驳回 Revision",
    });
    const activeMilestone = await prisma.milestoneNode.findUniqueOrThrow({
      where: { nodeId: fixture.activeNodeId },
      select: { id: true },
    });
    await prisma.milestoneReview.create({
      data: {
        milestoneNodeId: activeMilestone.id,
        result: "PENDING",
        submittedByAccountId: fixture.owner.account.id,
        idempotencyKey: `s6-unrelated-gate-review-${randomUUID()}`,
      },
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}?tab=revisions`);
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "Milestone",
    );
    await page.evaluate(() => {
      const browserWindow = window as Window & {
        __taskApprovalGateRemoved?: boolean;
        __taskApprovalGateObserver?: MutationObserver;
      };
      browserWindow.__taskApprovalGateRemoved = false;
      browserWindow.__taskApprovalGateObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const removedNode of record.removedNodes) {
            if (
              removedNode instanceof Element &&
              (removedNode.matches('[data-testid="task-approval-gate"]') ||
                removedNode.querySelector('[data-testid="task-approval-gate"]'))
            ) {
              browserWindow.__taskApprovalGateRemoved = true;
            }
          }
        }
      });
      browserWindow.__taskApprovalGateObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
    const revisionCard = page
      .getByRole("heading", { name: "当前 Revision 候选" })
      .locator("../..");
    await expect(
      revisionCard.getByRole("button", { name: "修改并重新送审" }),
    ).toBeDisabled();
    await revisionCard.getByRole("button", { name: "取消 Revision" }).click();
    await expect(page.getByText("Revision 已取消。")).toBeVisible();
    await expect(page.getByTestId("task-approval-gate")).toContainText(
      "Milestone",
    );
    expect(
      await page.evaluate(() => {
        const browserWindow = window as Window & {
          __taskApprovalGateRemoved?: boolean;
          __taskApprovalGateObserver?: MutationObserver;
        };
        browserWindow.__taskApprovalGateObserver?.disconnect();
        return browserWindow.__taskApprovalGateRemoved;
      }),
    ).toBe(false);
    await expect(page.getByRole("button", { name: "提交验收" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "结束 Task" })).toBeDisabled();
    await expectHealthyPage(page);
  });

  test("Task UI v2 edits active metadata in a dialog and exposes selected-node actions", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createUiFixture();
    const renamedTitle = `${fixture.taskTitle} · v2`;
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(page.getByTestId("task-workbench-v2")).toBeVisible();
    await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(0);
    await page.getByRole("button", { name: "修改 Task 基本信息" }).click();
    const editor = page.getByRole("dialog", { name: "修改 Task 基本信息" });
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("搜索负责人", { exact: true })).toBeVisible();
    await expect(editor.getByLabel("搜索参与人员", { exact: true })).toBeVisible();
    await expect(editor.getByLabel("新增成员角色")).toHaveCount(0);
    const editForm = editor.getByRole("form", { name: "修改 Task" });
    await editForm.getByLabel("标题").fill(renamedTitle);
    await expect(editForm.getByRole("button", { name: "保存修改" })).toHaveCount(1);
    await expect(editForm.getByRole("button", { name: /保存基本信息|保存 Tags|保存成员/ })).toHaveCount(0);
    await editForm.getByRole("button", { name: "保存修改" }).click();
    await expect(page.getByText("Task 修改已保存。")).toBeVisible();
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { title: true },
        }),
      )
      .toEqual({ title: renamedTitle });
    await expect(editor).toHaveCount(0);

    await page.getByRole("button", { name: "修改 Task 基本信息" }).click();
    const staleEditor = page.getByRole("dialog", { name: "修改 Task 基本信息" });
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: {
        title: "其他用户并发保存的标题",
        lockVersion: { increment: 1 },
      },
    });
    await staleEditor.getByLabel("标题").fill("不应覆盖并发修改的标题");
    await staleEditor.getByRole("button", { name: "保存修改" }).click();
    await expect(staleEditor.getByRole("alert")).toContainText(
      "Task 已被他人修改，请刷新后重试",
    );
    await expect(staleEditor.getByRole("alert")).toContainText(
      "请关闭并重新打开编辑窗口",
    );
    await expect(
      staleEditor.getByRole("button", { name: "保存修改" }),
    ).toBeDisabled();
    await staleEditor.getByLabel("标题").press("Enter");
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { title: true },
        }),
      )
      .toEqual({ title: "其他用户并发保存的标题" });
    await page.keyboard.press("Escape");
    await expect(staleEditor).toHaveCount(0);

    await page.getByRole("textbox", { name: "文本证据" }).fill("Task UI v2 验收证据");
    await page.getByRole("button", { name: "提交验收" }).click();
    await expect(page.getByText("Milestone 已提交验收。")).toBeVisible();
    await expect(page.getByTestId("task-approval-gate")).toContainText("Milestone");

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByLabel("审批说明").fill("Task UI v2 管理员通过");
    await page.getByRole("button", { name: "通过", exact: true }).click();
    await expect(page.getByText("验收已通过。")).toBeVisible();
    await page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: /Terminal/ })
      .click();
    await expect(page.getByLabel("结束结果")).toBeVisible();
    await page.getByLabel("结束结果").selectOption("CANCELLED");
    await page.getByLabel("原因").fill("Task UI v2 提前结束回归");
    await page.getByLabel("总结").fill("Task UI v2 生命周期操作完成");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "确认结束 Task" }).click();
    await expect(page.getByText("Task 已完成 Termination 确认。")).toBeVisible();
    await expect
      .poll(() =>
        prisma.task.findUnique({
          where: { id: fixture.taskId },
          select: { status: true },
        }),
      )
      .toEqual({ status: "CANCELLED" });
    await expect(page.getByRole("heading", { name: "Task 风险" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Task 评论" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await expectHealthyPage(page);
  });

  test("Task UI v2 creates and resubmits a Revision through the vertical Composer", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const fixture = await createUiFixture();
    const firstReason = `S6 v2 Revision ${randomUUID()}`;
    const firstDescription = "第一次 Revision 的详细变更内容";
    const secondReason = `${firstReason} 二次送审`;
    const secondDescription = "根据审批意见调整后的 Revision 详细内容";
    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("link", { name: "发起 Revision" }).click();
    await expect(page.getByTestId("task-composer")).toHaveAttribute(
      "data-composer-mode",
      "CREATE_REVISION",
    );
    await expect(page.getByTestId("task-plan-node-navigator")).toBeVisible();
    const revisionTaskInfo = page.getByLabel("Task 基本信息");
    await expect(
      revisionTaskInfo.getByRole("heading", { name: "基本信息" }),
    ).toBeVisible();
    await expect(revisionTaskInfo.getByLabel("Task 名称")).toHaveValue(
      fixture.taskTitle,
    );
    await expect(revisionTaskInfo.getByLabel("Task 名称")).toBeDisabled();
    await expect(
      page.getByRole("heading", { name: "Revision 信息" }),
    ).toHaveCount(0);
    await expect(page.getByText("只读基线", { exact: true })).toHaveCount(0);
    await expect(page.getByText("问题列表", { exact: true })).toHaveCount(0);
    const currentRevisionButton = page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: /当前 Revision/ });
    await expect(currentRevisionButton).toHaveAttribute("aria-pressed", "true");
    const revisionInspector = page.getByLabel("计划节点检查器");
    await expect(revisionInspector.getByText("不可删除", { exact: true })).toBeVisible();
    await expect(revisionInspector.getByRole("alert")).toContainText(
      "请输入 Revision 名称",
    );
    await expect(revisionInspector.getByRole("alert")).toContainText(
      "请输入 Revision 详细内容",
    );
    await revisionInspector.getByLabel("Revision 名称").fill(firstReason);
    await revisionInspector
      .getByLabel("Revision 详细内容")
      .fill(firstDescription);
    await page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: new RegExp(firstReason) })
      .click();
    await page.getByLabel("Revision 时间").fill("2026-08-03T12:00");
    await expect(page.getByText(/^本地已保存/)).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "恢复草稿" }).click();
    await expect(page.getByLabel("Revision 名称")).toHaveValue(firstReason);
    await expect(page.getByLabel("Revision 详细内容")).toHaveValue(
      firstDescription,
    );
    await page.getByRole("button", { name: "创建并送审" }).first().click();
    const firstRevisionCard = page
      .getByRole("heading", { name: "当前 Revision 候选" })
      .locator("../..");
    await expect(firstRevisionCard).toContainText(firstReason);
    await expect(firstRevisionCard).toContainText(firstDescription);
    await expect(page.getByTestId("task-approval-gate")).toContainText("Revision");

    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByLabel("处理说明").fill("请调整候选计划");
    await page.getByRole("button", { name: "驳回" }).click();
    await expect(page.getByText("Revision 已驳回。")).toBeVisible();

    await loginAsTestUser(context, baseURL, {
      openId: fixture.owner.openId,
      name: fixture.owner.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await page.getByRole("link", { name: "修改并重新送审" }).click();
    await expect(page.getByTestId("task-composer")).toHaveAttribute(
      "data-composer-mode",
      "RESUBMIT_REVISION",
    );
    await page.getByLabel("Revision 名称").fill(secondReason);
    await page.getByLabel("Revision 详细内容").fill(secondDescription);
    await page.getByRole("button", { name: "修改并重新送审" }).first().click();
    const secondRevisionCard = page
      .getByRole("heading", { name: "当前 Revision 候选" })
      .locator("../..");
    await expect(secondRevisionCard).toContainText(secondReason);
    await expect(secondRevisionCard).toContainText(secondDescription);
    await expect
      .poll(() =>
        prisma.revisionNode.findFirst({
          where: { node: { taskId: fixture.taskId } },
          orderBy: { node: { createdAt: "desc" } },
          select: {
            status: true,
            reviewRound: true,
            node: { select: { businessDescription: true } },
          },
        }),
      )
      .toEqual({
        status: "PENDING_APPROVAL",
        reviewRound: 2,
        node: { businessDescription: secondDescription },
      });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.admin.openId,
      name: fixture.admin.person.displayName,
    });
    await page.goto(`/progress/tasks/${fixture.taskId}`);
    const approvalCard = page
      .getByRole("heading", { name: "当前 Revision 候选" })
      .locator("../..");
    await approvalCard.getByLabel("处理说明").fill("同意应用修订计划");
    await approvalCard.getByRole("button", { name: "批准" }).click();
    await expect(page.getByText("Revision 已批准并应用。")).toBeVisible();
    await page
      .getByTestId("task-plan-node-navigator")
      .getByRole("button", { name: new RegExp(secondReason) })
      .click();
    const selectedRevision = page.locator("#task-selected-node-detail");
    await expect(selectedRevision).toContainText(secondReason);
    await expect(selectedRevision).toContainText(secondDescription);
    await expectHealthyPage(page);
  });

  test("S7 resource filters, removed conflict route and personal timeline work on desktop and mobile", async ({
    context,
    page,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const fixture = await createUiFixture();
    await prisma.workSegment.update({
      where: { id: fixture.confirmableSegmentId },
      data: { status: "PENDING_CONFIRMATION" },
    });
    await loginAsTestUser(context, baseURL, {
      openId: fixture.member.openId,
      name: fixture.member.person.displayName,
    });

    await page.goto(`/progress/resources?focus=${fixture.confirmableSegmentId}`);
    await expect(page.getByTestId("segment-inspector")).toContainText(
      "P6 UI 可确认计划",
    );

    await page.goto(
      `/progress/resources?from=2026-08-10&to=2026-08-12&people=${fixture.member.person.id},${fixture.owner.person.id}&tasks=${fixture.taskId}&types=planned&statuses=pending_confirmation&group=person&zoom=hour&focus=${fixture.confirmableSegmentId}`,
    );
    await expect(page.getByRole("heading", { name: "人员计划" })).toBeVisible();
    await expect(page.getByRole("region", { name: "资源计划筛选" })).toBeVisible();
    await expect(page.getByText("人员（2）")).toBeVisible();
    await expect(page.getByText("Task（1）")).toBeVisible();
    await expect(page.getByLabel("待确认")).toBeChecked();
    await expect(page.getByTestId("segment-inspector")).toContainText("P6 UI 可确认计划");
    await page.getByRole("button", { name: "7 天" }).click();
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(page).toHaveURL(/to=2026-08-17/);
    await page.getByRole("button", { name: "复制视图链接" }).click();
    await expect(page.getByText(/已复制当前视图链接|无法访问剪贴板/)).toBeVisible();
    await expectHealthyPage(page);

    const removedConflictPage = await page.goto("/progress/resources/conflicts");
    expect(removedConflictPage?.status()).toBe(404);

    await page.goto(`/progress/my-timeline?focus=${fixture.confirmableSegmentId}&mode=day`);
    await expect(page.getByRole("heading", { name: "我的时间" })).toBeVisible();
    await expect(page.getByTestId("segment-inspector")).toContainText(
      "P6 UI 可确认计划",
    );
    const dueQueue = page.getByRole("region", { name: "到期计划与确认队列" });
    await expect(dueQueue.getByRole("heading", { name: "到期计划与确认队列" })).toBeVisible();
    await expect(dueQueue.getByText("P6 UI 可确认计划")).toBeVisible();
    await expect(page.getByTestId("time-canvas-scroll")).toBeVisible();
    await dueQueue.getByRole("button", { name: "与计划一致" }).click();
    await expect(page.getByText("已完整确认并生成 Actual")).toBeVisible();
    await expect.poll(() => prisma.workSegment.findUnique({
      where: { id: fixture.confirmableSegmentId },
      select: { status: true },
    })).toEqual({ status: "CONFIRMED" });

    const independentContent = `S7 独立安排 ${randomUUID()}`;
    await page.getByRole("button", { name: "新增投入" }).click();
    const quickCreate = page.getByRole("form", { name: "投入快速创建" });
    await expect(
      quickCreate.locator('input[type="hidden"][name="taskId"]'),
    ).toHaveValue("");
    await quickCreate.getByLabel("内容").fill(independentContent);
    await quickCreate.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByText("已创建投入记录")).toBeVisible();
    await expect.poll(() => prisma.workSegment.count({
      where: { personId: fixture.member.person.id, taskId: null, content: independentContent },
    })).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expectHealthyPage(page);
  });
});

async function createUiFixture() {
  const fixtureKey = randomUUID();
  const admin = await createAccountPerson(`P6 UI Team Admin ${fixtureKey}`);
  const owner = await createAccountPerson(`P6 UI Owner ${fixtureKey}`);
  const member = await createAccountPerson(`P6 UI Member ${fixtureKey}`);
  const reviewer = await createAccountPerson(`P6 UI Reviewer ${fixtureKey}`);
  const outsider = await createAccountPerson(`P6 UI Outsider ${fixtureKey}`);
  const inactiveHistory = await createAccountPerson(
    `P6 UI Historical Person ${fixtureKey}`,
  );
  await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
  const taskTitle = `P6 UI Task ${randomUUID()}`;
  const draft = await createTaskDraft(actor(admin), {
    title: taskTitle,
    description: "P6 UI 集成测试 Task",
    team: "英雄",
    techGroup: "电控",
    priority: "HIGH",
    tagIds: [],
    members: [
      { personId: owner.person.id, role: "OWNER" },
      { personId: member.person.id, role: "PARTICIPANT" },
      { personId: reviewer.person.id, role: "PARTICIPANT" },
      { personId: inactiveHistory.person.id, role: "PARTICIPANT" },
    ],
    milestones: [
      milestoneInput("P6 UI 第一阶段", "完成第一阶段", 1),
      milestoneInput("P6 UI 第二阶段", "完成第二阶段", 2),
    ],
    plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
    termination: terminationInput(5),
    idempotencyKey: `p6-ui-task-${randomUUID()}`,
  });
  await activateTask(actor(owner), {
    taskId: draft.taskId,
    expectedLockVersion: draft.lockVersion,
  });
  const activeTask = await prisma.task.findUniqueOrThrow({
    where: { id: draft.taskId },
    select: { activeMilestoneNodeId: true },
  });
  if (!activeTask.activeMilestoneNodeId) {
    throw new Error("P6 UI fixture 缺少 Active Milestone");
  }
  const confirmable = await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(9),
    endAt: atHour(10),
    content: "P6 UI 可确认计划",
    priority: "MEDIUM",
    taskId: draft.taskId,
    tagIds: [],
  });
  const movable = await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(10),
    endAt: atHour(11),
    content: "P6 UI 重叠计划 A",
    priority: "MEDIUM",
    taskId: draft.taskId,
    tagIds: [],
  });
  await createWorkSegment(actor(owner), {
    personId: owner.person.id,
    type: "PLANNED",
    startAt: atHour(8),
    endAt: atHour(9),
    content: "P6 UI 跨行目标人员安排",
    priority: "LOW",
    taskId: draft.taskId,
    tagIds: [],
  });
  await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(10.5),
    endAt: atHour(11.5),
    content: "P6 UI 重叠计划 B",
    priority: "MEDIUM",
    taskId: draft.taskId,
    tagIds: [],
  });
  const inactiveHistorySegment = await createWorkSegment(
    actor(inactiveHistory),
    {
      personId: inactiveHistory.person.id,
      type: "ACTUAL",
      startAt: atHour(15),
      endAt: atHour(16),
      content: "P6 UI 停用人员历史投入",
      actualOutput: "历史产出",
      completionPercent: 100,
      priority: "LOW",
      taskId: draft.taskId,
      tagIds: [],
    },
  );
  await prisma.person.update({
    where: { id: inactiveHistory.person.id },
    data: { status: "INACTIVE" },
  });
  const batchCancelableA = await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(12),
    endAt: atHour(13),
    content: "P6 UI 批量取消 A",
    priority: "LOW",
    taskId: draft.taskId,
    tagIds: [],
  });
  const batchCancelableB = await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(13),
    endAt: atHour(14),
    content: "P6 UI 批量取消 B",
    priority: "LOW",
    taskId: draft.taskId,
    tagIds: [],
  });
  const notification = await prisma.inAppNotification.create({
    data: {
      eventKey: `p6-ui-notification-${randomUUID()}`,
      recipientAccountId: member.account.id,
      category: "TASK",
      title: "P6 UI 通知",
      summary: "这是一条用于验证通知中心的站内通知",
      entityType: "Task",
      entityId: draft.taskId,
      taskId: draft.taskId,
      linkPath: `/progress/tasks/${draft.taskId}`,
      payloadVersion: 1,
      payload: {},
    },
  });
  return {
    admin,
    owner,
    member,
    reviewer,
    outsider,
    inactiveHistory,
    taskId: draft.taskId,
    taskTitle,
    activeNodeId: activeTask.activeMilestoneNodeId,
    confirmableSegmentId: confirmable.segment.id,
    movableSegmentId: movable.segment.id,
    inactiveHistorySegmentId: inactiveHistorySegment.segment.id,
    batchCancelableSegmentIds: [
      batchCancelableA.segment.id,
      batchCancelableB.segment.id,
    ] as const,
    brushCreateContent: `P6 UI 画布拖选创建 ${randomUUID()}`,
    mobileCreateContent: `P6 UI 移动端精确创建 ${randomUUID()}`,
    notificationId: notification.id,
  };
}

async function createDraftWorkbenchFixture() {
  const admin = await createAccountPerson("S6 Draft Team Admin");
  const owner = await createAccountPerson("S6 Draft Owner");
  const reviewer = await createAccountPerson("S6 Draft Reviewer");
  const taskTitle = `S6 Draft Workbench ${randomUUID()}`;
  const task = await createTaskDraft(actor(admin), {
    title: taskTitle,
    description: "S6 Draft 工作台测试",
    team: "英雄",
    techGroup: "电控",
    priority: "MEDIUM",
    tagIds: [],
    members: [
      { personId: owner.person.id, role: "OWNER" },
      { personId: reviewer.person.id, role: "PARTICIPANT" },
    ],
    milestones: [
      milestoneInput("S6 Draft 第一阶段", "完成第一阶段", 1),
      milestoneInput("S6 Draft 第二阶段", "完成第二阶段", 2),
    ],
    plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
    termination: terminationInput(5),
    idempotencyKey: `s6-draft-workbench-${randomUUID()}`,
  });
  return { admin, owner, reviewer, taskId: task.taskId, taskTitle };
}

async function createAccountPerson(displayName: string) {
  const openId = `ou_pm_p6_ui_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: {
        create: {
          displayName,
          status: "ACTIVE",
        },
      },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { account, person: account.person, openId };
}

async function grantRole(
  accountId: string,
  role: "PROJECT_ADMINISTRATOR",
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team: "",
      techGroup: "",
    },
  });
}

function actor(input: Awaited<ReturnType<typeof createAccountPerson>>): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles: [],
  };
}

function milestoneInput(goal: string, criteria: string, daysFromBase: number) {
  return {
    goal,
    completionCriteria: criteria,
    expectedCompletedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    reviewRequirements: "提交文本或链接证据",
    businessDescription: goal,
  };
}

function terminationInput(daysFromBase: number) {
  return {
    name: "Terminal",
    plannedOutcomeCriteria: "所有 Milestone 完成并完成总结",
    plannedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    businessDescription: "结束确认",
  };
}

function atHour(hour: number) {
  const fullHour = Math.trunc(hour);
  const minutes = Math.round((hour - fullHour) * 60);
  return new Date(Date.UTC(2026, 7, 10, fullHour, minutes, 0));
}
