import { expect, test } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

test("飞书 API 调用保持在各自传输边界内", async () => {
  const sourceFiles = [
    ...(await collectSourceFiles(path.join(process.cwd(), "app"))),
    ...(await collectSourceFiles(path.join(process.cwd(), "components"))),
    ...(await collectSourceFiles(path.join(process.cwd(), "lib"))),
    ...(await collectSourceFiles(path.join(process.cwd(), "scripts"))),
  ];
  const sources = await Promise.all(
    sourceFiles.map(async (filePath) => ({
      filePath,
      content: await readFile(filePath, "utf8"),
    })),
  );

  expect(filesContaining(sources, "/open-apis/im/v1/messages")).toEqual([
    "lib/feishu-message.ts",
  ]);
  expect(filesContaining(sources, "/open-apis/cardkit/v1/cards")).toEqual([
    "lib/feishu-cardkit.ts",
  ]);
  expect(filesContaining(sources, "fetch(webhookUrl")).toEqual([
    "lib/feishu-webhook.ts",
  ]);
});

test("项目管理入口不能直接依赖飞书传输层", async () => {
  const appFiles = await collectSourceFiles(path.join(process.cwd(), "app"));
  const imports = await Promise.all(
    appFiles.map(async (filePath) => ({
      filePath,
      content: await readFile(filePath, "utf8"),
    })),
  );

  expect(
    imports
      .filter(({ content }) => content.includes("@/lib/feishu-message"))
      .map(({ filePath }) => relativePath(filePath)),
  ).toEqual([]);
});

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(absolutePath);
      if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) return [];
      return [absolutePath];
    }),
  );
  return files.flat();
}

function filesContaining(
  sources: Array<{ filePath: string; content: string }>,
  needle: string,
): string[] {
  return sources
    .filter(({ content }) => content.includes(needle))
    .map(({ filePath }) => relativePath(filePath))
    .sort();
}

function relativePath(filePath: string): string {
  return path.relative(process.cwd(), filePath).split(path.sep).join("/");
}
