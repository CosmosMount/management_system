import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createTaskDraft } from "../lib/project-management/application/lifecycle-service";
import { isoToShanghaiDateTimeLocal, shanghaiDateTimeLocalToIso } from "../lib/project-management/date-time";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

import {
  actor,
  createAccountPerson,
  grantRole,
  milestoneInput,
  terminationInput,
} from "./helpers/project-management-ui-fixtures";

test.describe("project management UI project-management-ui-composer", () => {
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
      await expect(page).toHaveURL(/\/progress\/tasks\/new$/);
      await expect(page.getByRole("heading", { name: "新建 Task" })).toBeVisible();
      await expect(page.getByTestId("task-composer")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      await expect(page.getByRole("checkbox", { name: /允许自审/ })).toHaveCount(0);
      await page.getByLabel("Task 名称").fill(title);
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Start/ })
        .click();
      await page.getByLabel("计划开始时间").fill("2026-09-01T09:00");
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
        page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /临时 Milestone.*临时节点/ }),
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
      if (testInfo.project.name === "desktop") {
        const milestoneAnchor = page
          .getByTestId("time-canvas-root")
          .getByRole("button", { name: /^计划节点 完成 S5 Composer 主流程/ });
        await milestoneAnchor.focus();
        await milestoneAnchor.press("ArrowRight");
        await expect.poll(() => milestoneTime.inputValue()).not.toBe(originalMilestoneTime);
        const movedMilestoneTime = await milestoneTime.inputValue();
        await page.getByRole("button", { name: "撤销" }).click();
        await expect(milestoneTime).toHaveValue(originalMilestoneTime);
        await page.getByRole("button", { name: "重做" }).click();
        await expect(milestoneTime).toHaveValue(movedMilestoneTime);
      } else {
        await expect(page.getByTestId("time-canvas-root")).toBeHidden();
      }
      await milestoneTime.fill("");
      await expect(
        page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /完成 S5 Composer 主流程.*需修正/ }),
      ).toBeVisible();
      await milestoneTime.fill(originalMilestoneTime);

      const planNavigator = page.getByTestId("task-plan-node-navigator");
      await planNavigator.getByRole("button", { name: /Start/ }).click();
      await expect(page.getByTestId("task-composer-inspector")).toContainText("Start");
      await planNavigator.getByRole("button", { name: /Terminal/ }).click();
      await expect(page.getByTestId("task-composer-inspector")).toContainText("Terminal");
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
          schemaVersion: 4,
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
          { timeout: 15_000 },
        )
        .toBe(true);
      const middleNode = extremeNavigator.getByRole("button").nth(100);
      await middleNode.click();
      await expect(middleNode).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(() =>
          extremeNavigator.evaluate((element) => {
            const selected = element.querySelector<HTMLElement>(
              "[data-node-selected='true']",
            );
            if (!selected) return Number.POSITIVE_INFINITY;
            const containerRect = element.getBoundingClientRect();
            const selectedRect = selected.getBoundingClientRect();
            const horizontal = window.matchMedia("(min-width: 640px)").matches;
            const containerCenter = horizontal
              ? containerRect.left + element.clientLeft + element.clientWidth / 2
              : containerRect.top + element.clientTop + element.clientHeight / 2;
            const selectedCenter = horizontal
              ? selectedRect.left + selectedRect.width / 2
              : selectedRect.top + selectedRect.height / 2;
            return Math.abs(containerCenter - selectedCenter);
          }),
          { timeout: 15_000 },
        )
        .toBeLessThanOrEqual(2);
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
      await expect(
        page
          .getByTestId("task-workbench-v2")
          .getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();
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
      await expect(page.getByLabel("搜索负责人", { exact: true })).toBeVisible();
      await expect(page.getByLabel("搜索参与人员", { exact: true })).toBeVisible();
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

      await page.goto("/progress/tasks/new?start=2026-08-01");
      await expect(page).toHaveURL(/\/progress\/tasks\/new$/);
      await page.getByLabel("Task 名称").fill(title);
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Start/ })
        .click();
      await page.getByLabel("计划开始时间").fill("2026-08-01T09:00");
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ })
        .click();
      await page.getByLabel("计划结束时间").fill("2026-08-15T09:00");
      await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("0/200");
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ })
        .click();
      await page.getByLabel("Terminal 名称").fill("交付终点");
      await page.getByLabel("结束条件").fill("无需中间验收，直接进入交付终点");
      await page.getByRole("button", { name: "创建 Task 草稿" }).click();
      await expect(
        page
          .getByTestId("task-workbench-v2")
          .getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();

      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "激活 Task" }).click();
      await expect(
        page
          .getByTestId("task-plan-node-navigator")
          .getByRole("button", { name: /交付终点.*Terminal.*当前/ }),
      ).toBeVisible();
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

  test("Task Composer deletes v1/v2/v3 drafts without reading or restoring them and keeps v4 recovery", async ({
      context,
      page,
      baseURL,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "草稿 tombstone 只需在桌面验证一次");
      const creator = await createAccountPerson(
        `Composer V4 Baseline ${randomUUID()}`,
      );
      await loginAsTestUser(context, baseURL, {
        openId: creator.openId,
        name: creator.person.displayName,
      });

      await page.goto("/progress/tasks/new");
      await page.getByLabel("Task 名称").fill("当前 v4 草稿完整保留");
      const keys = await expect.poll(() => page.evaluate(() => {
        const currentKey = Object.keys(window.localStorage).find((key) =>
          key.endsWith(":v4"),
        );
        return currentKey ? { currentKey } : null;
      })).not.toBeNull();
      void keys;
      const installed = await page.evaluate(async () => {
        const currentKey = Object.keys(window.localStorage).find((key) =>
          key.endsWith(":v4"),
        );
        if (!currentKey) throw new Error("未找到 v4 Task Composer 草稿");
        const prefix = currentKey.slice(0, -2);
        const retiredKeys = [1, 2, 3].map((version) => `${prefix}v${version}`);
        for (const [index, retiredKey] of retiredKeys.entries()) {
          window.localStorage.setItem(
            retiredKey,
            JSON.stringify({ schemaVersion: index + 1, mustNotBeRead: true }),
          );
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
          for (const retiredKey of retiredKeys) {
            transaction.objectStore("drafts").put("retired body", retiredKey);
          }
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
        database.close();
        return { currentKey, retiredKeys };
      });

      await page.reload();
      await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toBeVisible();
      await page.getByRole("button", { name: "恢复草稿" }).click();
      await expect(page.getByLabel("Task 名称")).toHaveValue(
        "当前 v4 草稿完整保留",
      );
      await expect.poll(() => page.evaluate(async ({ retiredKeys }) => {
        const localRemoved = retiredKeys.every(
          (key) => window.localStorage.getItem(key) === null,
        );
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("management-system-task-composer", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const remaining = await new Promise<unknown[]>((resolve, reject) => {
          const transaction = database.transaction("drafts", "readonly");
          const requests = retiredKeys.map((key) =>
            transaction.objectStore("drafts").get(key),
          );
          transaction.oncomplete = () => resolve(requests.map((request) => request.result));
          transaction.onerror = () => reject(transaction.error);
        });
        database.close();
        return localRemoved && remaining.every((value) => value === undefined);
      }, installed)).toBe(true);
      await expect(page.getByText(/草稿版本、结构或字段不兼容/)).toHaveCount(0);

      await page.evaluate(async ({ currentKey }) => {
        window.localStorage.setItem(currentKey, JSON.stringify({
          schemaVersion: 3,
          storage: "INDEXED_DB",
          draftId: crypto.randomUUID(),
          savedAt: new Date().toISOString(),
          serializedChars: 12,
        }));
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("management-system-task-composer", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("drafts", "readwrite");
          transaction.objectStore("drafts").put("v3 body", currentKey);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
        database.close();
      }, installed);
      await page.reload();
      await expect(page.getByText(/检测到 .* 保存的未完成草稿/)).toHaveCount(0);
      await expect(page.getByText(/草稿版本、结构或字段不兼容/)).toHaveCount(0);
      await expect(page.getByLabel("Task 名称")).toHaveValue("");
      await expect.poll(() => page.evaluate(async ({ currentKey }) => {
        const localRemoved = window.localStorage.getItem(currentKey) === null;
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("management-system-task-composer", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const indexed = await new Promise<unknown>((resolve, reject) => {
          const transaction = database.transaction("drafts", "readonly");
          const request = transaction.objectStore("drafts").get(currentKey);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        database.close();
        return localRemoved && indexed === undefined;
      }, installed)).toBe(true);
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
      await expect(page.getByRole("heading", { name: "资源计划" })).toBeVisible();
      await expectHealthyPage(page);
      await page.goto("/progress");
      await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible({
        timeout: 15_000,
      });
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
      await expect(
        page
          .getByTestId("task-workbench-v2")
          .getByRole("heading", { name: draftTitle, exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "新增投入" })).toHaveCount(0);
      await expectHealthyPage(page);
    });

  test("Task Composer isolates local drafts, preserves incompatible data and guards browser history", async ({
      context,
      page,
      baseURL,
    }) => {
      test.setTimeout(150_000);
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
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ })
        .click();
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
      await expect(page).toHaveURL(/\/progress\/tasks\/new$/);
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
      await page
        .getByTestId("task-plan-node-navigator")
        .getByRole("button", { name: /Terminal/ })
        .click();
      await page.getByLabel("结束条件").fill("管理员 Task 创建完成");
      await page.getByRole("button", { name: "创建 Task 草稿" }).click();
      await expect(
        page
          .getByTestId("task-workbench-v2")
          .getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();
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
});
