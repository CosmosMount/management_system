// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { APP_NAME } from "../lib/branding";
import { createLinkPreviewFixtures } from "./helpers/project-management-link-preview-fixtures";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

test("匿名原链接直接返回完整 HTML 名称预览，所有状态可见且不泄露详情或产生副作用", async ({ request, page }) => {
  const fixture = await createLinkPreviewFixtures();
  const before = await Promise.all([prisma.domainAuditEvent.count(), prisma.notificationOutbox.count()]);
  for (const kind of ["projects", "tasks", "meetings"] as const) {
    const id = { projects: fixture.project.id, tasks: fixture.task.taskId, meetings: fixture.meeting.id }[kind];
    const path = `/progress/${kind}/${id}?center=2026-10-04T19%3A00%3A00.000Z&scale=week`;
    const title = `${{ projects: "项目", tasks: "任务", meetings: "会议" }[kind]}：${fixture.name} | ${APP_NAME}`;
    for (const userAgent of ["Mozilla/5.0", "FeishuBot", "LarkBot", "Bytespider"]) {
      const response = await request.get(path, { headers: { "User-Agent": userAgent }, maxRedirects: 0 });
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(response.headers()["cache-control"]).toContain("private");
      expect(response.headers()["x-robots-tag"]).toContain("noindex");
      const html = await response.text();
      const head = html.split("</head>")[0];
      expect(head).toContain(`<title>${title}</title>`);
      expect(head).toContain(`<meta property="og:title" content="${title}">`);
      expect(head).toContain(path.replaceAll("&", "&amp;"));
      expect(html).not.toContain("self.__next_f");
      for (const marker of fixture.privateMarkers) expect(html).not.toContain(marker);
      if (kind === "meetings") {
        for (const privateId of [fixture.project.id, fixture.task.taskId, fixture.owner.person.id]) {
          expect(html).not.toContain(privateId);
        }
      }
    }
    const headResponse = await request.head(path, { maxRedirects: 0 });
    expect(headResponse.status()).toBe(200);
    expect(await headResponse.text()).toBe("");
    expect(headResponse.headers()["cache-control"]).toContain("no-store");
    await page.goto(path);
    await expect(page.locator("head meta[property='og:title']")).toHaveAttribute("content", title);
    await expect(page).toHaveURL(new RegExp(`/progress/${kind}/${id}\\?`));
  }
  for (const status of ["DRAFT", "PENDING_APPROVAL", "ACTIVE", "COMPLETED"] as const) {
    await prisma.project.update({ where: { id: fixture.project.id }, data: { status } });
    expect((await request.get(`/progress/projects/${fixture.project.id}`, { maxRedirects: 0 })).status()).toBe(200);
  }
  for (const status of ["DRAFT", "ACTIVE", "COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ARCHIVED"] as const) {
    await prisma.task.update({ where: { id: fixture.task.taskId }, data: { status } });
    expect((await request.get(`/progress/tasks/${fixture.task.taskId}`, { maxRedirects: 0 })).status()).toBe(200);
  }
  expect(await Promise.all([prisma.domainAuditEvent.count(), prisma.notificationOutbox.count()])).toEqual(before);
});

test("预览支持无脚本抓取、长名称、转义及键盘操作，登录后仍进入完整详情", async ({ browser, context, page, baseURL }, testInfo) => {
  const name = `预览 <img src=x onerror=alert(1)> & " '</title><script>alert(1)</script> ${"很长的名称".repeat(20)}`;
  const fixture = await createLinkPreviewFixtures(name);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => { errors.push(dialog.message()); void dialog.dismiss(); });
  const noScript = await browser.newContext({ javaScriptEnabled: false, baseURL });
  try {
    const staticPage = await noScript.newPage();
    for (const [kind, id, label] of [["projects", fixture.project.id, "项目"], ["tasks", fixture.task.taskId, "任务"], ["meetings", fixture.meeting.id, "会议"]]) {
      await staticPage.goto(`/progress/${kind}/${id}`);
      await expect(staticPage.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(staticPage.locator("head meta[property='og:title']")).toHaveAttribute("content", `${label}：${name} | ${APP_NAME}`);
      await staticPage.getByRole("link", { name: "登录查看详情" }).click();
      expect(new URL(staticPage.url()).searchParams.get("callbackUrl")).toBe(`/progress/${kind}/${id}`);
    }
  } finally {
    await noScript.close();
  }
  for (const [width, height] of [[1440, 1000], [393, 851], [360, 851]]) {
    await page.setViewportSize({ width, height });
    for (const path of [`/progress/projects/${fixture.project.id}`, `/progress/tasks/${fixture.task.taskId}`, `/progress/meetings/${fixture.meeting.id}`]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(page.locator("img")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "登录查看详情" })).toBeFocused();
      await expectHealthyPage(page);
      await page.screenshot({ path: testInfo.outputPath(`preview-${path.split("/")[2]}-${width}.png`), fullPage: true, animations: "disabled" });
    }
  }
  expect(errors).toEqual([]);
  await prisma.project.update({ where: { id: fixture.project.id }, data: { avatarPath: null } });
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const path of [`/progress/projects/${fixture.project.id}`, `/progress/tasks/${fixture.task.taskId}`, `/progress/meetings/${fixture.meeting.id}`]) {
    expect((await page.goto(path))?.status()).toBe(200);
    await expect(page.getByRole("link", { name: "登录查看详情" })).toHaveCount(0);
    if (path.includes("/meetings/")) {
      await expect(page.getByRole("heading", { name: `会议纪要：${name}`, exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "会议内容", exact: true })).toContainText(fixture.meeting.minutes);
    } else {
      await expect(page.getByTestId(path.includes("/projects/") ? "project-overview" : "task-overview")
        .getByRole("heading", { name, exact: true })).toBeVisible();
    }
    await expectHealthyPage(page);
    const forgedPreview = await context.request.get(path, { headers: { "x-pnx-progress-preview": "1" } });
    expect(forgedPreview.status()).toBe(200);
    expect(await forgedPreview.text()).toContain(path.includes("/meetings/") ? fixture.meeting.minutes : fixture.privateMarkers[0]);
    expect(await forgedPreview.text()).not.toContain('id="preview-title"');
  }
  await context.clearCookies();
  await page.reload();
  await expect(page.getByRole("link", { name: "登录查看详情" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("改名实时生效，软删除和无效链接统一返回不含名称的 404", async ({ request, page }) => {
  const fixture = await createLinkPreviewFixtures();
  const renamed = `新名称 ${randomUUID()}`;
  for (const kind of ["projects", "tasks"] as const) {
    const id = kind === "projects" ? fixture.project.id : fixture.task.taskId;
    const path = `/progress/${kind}/${id}`;
    expect(await (await request.get(path)).text()).toContain(fixture.name);
    if (kind === "projects") await prisma.project.update({ where: { id }, data: { name: renamed } });
    else await prisma.task.update({ where: { id }, data: { title: renamed } });
    const html = await (await request.get(path)).text();
    expect(html).toContain(renamed);
    expect(html).not.toContain(fixture.name);
    if (kind === "projects") await prisma.project.update({ where: { id }, data: { deletedAt: new Date() } });
    else await prisma.task.update({ where: { id }, data: { deletedAt: new Date() } });
    for (const unavailablePath of [path, `/progress/${kind}/${randomUUID()}`, `/progress/${kind}/invalid-id`]) {
      const response = await request.get(unavailablePath, { maxRedirects: 0 });
      expect(response.status()).toBe(404);
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(await response.text()).not.toContain(renamed);
      expect(await response.text()).toContain("项目、任务或会议不存在");
      expect((await request.head(unavailablePath, { maxRedirects: 0 })).status()).toBe(404);
    }
  }
  expect((await page.goto(`/progress/projects/${fixture.project.id}`))?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "项目、任务或会议不存在" })).toBeVisible();
  await expect(page.getByRole("link", { name: "登录查看详情" })).toHaveCount(0);
});

test("预览不开放列表、编辑、附件、内部处理器或业务 API，非文档请求保持认证", async ({ request }) => {
  const id = randomUUID();
  for (const path of [
    "/progress/projects", "/progress/tasks", "/progress/projects/new", "/progress/tasks/new",
    "/progress/meetings", "/progress/meetings/new", "/progress/meetings/templates",
    "/progress/meetings/templates/new", `/progress/meetings/templates/${id}/edit`, `/progress/meetings/${id}/edit`,
    `/link-preview/progress/meetings/${id}`,
    `/progress/projects/${id}/edit`, `/progress/tasks/${id}/edit`, `/progress/tasks/${id}/revisions/new`,
    `/uploads/${id}.png`, `/link-preview/progress/projects/${id}`,
  ]) {
    const response = await request.get(path, { headers: { "x-pnx-progress-preview": "1" }, maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(new URL(response.headers().location, "http://localhost").pathname).toBe("/login");
  }
  const nonDocumentHeaders: Array<Record<string, string>> = [
    { rsc: "1" }, { "next-router-prefetch": "1" }, { "next-action": "fake-action" },
    { purpose: "prefetch" }, { "sec-purpose": "prefetch" },
  ];
  for (const kind of ["projects", "tasks", "meetings"]) {
    for (const headers of nonDocumentHeaders) {
      const response = await request.get(`/progress/${kind}/${id}?scale=week`, { headers, maxRedirects: 0 });
      expect(response.status()).toBe(307);
      expect(new URL(response.headers().location, "http://localhost").searchParams.get("callbackUrl"))
        .toBe(`/progress/${kind}/${id}?scale=week`);
    }
    const actionResponse = await request.post(`/progress/${kind}/${id}`, {
      headers: { "next-action": "fake-action" }, data: [], maxRedirects: 0,
    });
    expect(actionResponse.status()).toBe(307);
  }
  const apiResponse = await request.get("/api/project-management/time-canvas", { maxRedirects: 0 });
  expect(apiResponse.status()).toBe(401);
  expect(await apiResponse.json()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
});

test("会议改名实时更新预览，无效及不存在的会议统一返回 404", async ({ request }) => {
  const fixture = await createLinkPreviewFixtures();
  const path = `/progress/meetings/${fixture.meeting.id}`;
  expect(await (await request.get(path)).text()).toContain(fixture.name);
  const topic = `更新的会议主题 ${randomUUID()}`;
  await prisma.meetingRecord.update({ where: { id: fixture.meeting.id }, data: { topic } });
  const html = await (await request.get(path)).text();
  expect(html).toContain(topic);
  expect(html).not.toContain(fixture.name);
  for (const id of [randomUUID(), "invalid-id"]) {
    const response = await request.get(`/progress/meetings/${id}`, { maxRedirects: 0 });
    expect(response.status()).toBe(404);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(await response.text()).toContain("项目、任务或会议不存在");
    expect(await response.text()).not.toContain(topic);
    expect((await request.head(`/progress/meetings/${id}`, { maxRedirects: 0 })).status()).toBe(404);
  }
});
