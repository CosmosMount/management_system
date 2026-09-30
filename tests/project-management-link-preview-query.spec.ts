// @playwright-project node-db
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { getPublicProgressLinkPreview } from "../lib/project-management/queries/public-link-preview";
import { GET } from "../app/link-preview/progress/[kind]/[id]/route";
import { createLinkPreviewFixtures } from "./helpers/project-management-link-preview-fixtures";

test("公开查询仅返回类型和名称，拒绝无效类型和 ID", async () => {
  const fixture = await createLinkPreviewFixtures();
  expect(await getPublicProgressLinkPreview("projects", "invalid")).toBeNull();
  expect(await getPublicProgressLinkPreview("tasks", "invalid")).toBeNull();
  expect(await getPublicProgressLinkPreview("meetings", "invalid")).toBeNull();
  expect(await getPublicProgressLinkPreview("meetings", randomUUID())).toBeNull();
  expect(await getPublicProgressLinkPreview("accounts", fixture.owner.account.id)).toBeNull();
  expect(await getPublicProgressLinkPreview("projects", fixture.project.id)).toEqual({ kind: "projects", name: fixture.name });
  expect(await getPublicProgressLinkPreview("tasks", fixture.task.taskId)).toEqual({ kind: "tasks", name: fixture.name });
  expect(await getPublicProgressLinkPreview("meetings", fixture.meeting.id)).toEqual({ kind: "meetings", name: fixture.name });
});

test("预览数据库故障返回无内部信息的 503，并记录结构化错误", async () => {
  const failure = new Error("private database query details");
  const projectRead = prisma.project.findFirst;
  prisma.project.findFirst = () => { throw failure; };
  const log = mock.method(logger, "error", () => undefined);
  try {
    const id = randomUUID();
    for (const method of ["GET", "HEAD"]) {
      const response = await GET(
        new NextRequest(`http://localhost/link-preview/progress/projects/${id}`, { method }),
        { params: Promise.resolve({ kind: "projects", id }) },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const html = await response.text();
      expect(html).not.toContain(failure.message);
      if (method === "GET") expect(html).toContain("暂时无法获取预览");
      else expect(html).toBe("");
    }
    expect(log.mock.calls[0].arguments).toEqual(["progress.link_preview.failed", { error: failure }]);
  } finally {
    prisma.project.findFirst = projectRead;
    log.mock.restore();
  }
});
