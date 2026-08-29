// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const PROJECT_MANAGEMENT_FEISHU_TRANSPORT_MODULES = [
  "lib/feishu",
  "lib/feishu-message",
  "lib/feishu-webhook",
  "lib/feishu-cardkit",
  "lib/feishu-procurement-card-sync",
] as const;

const PROJECT_MANAGEMENT_FEISHU_TRANSPORT_SYMBOLS = [
  "sendFeishuDirectMessage",
  "postToFeishuWebhook",
  "sendTrackedProcurementCardKitDm",
  "createCardKitInstance",
  "updateCardKitInstanceResilient",
] as const;

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

test("项目管理入口和领域服务不能直接依赖飞书传输层", async () => {
  const projectManagementFiles = await collectExistingSourceFiles([
    path.join(process.cwd(), "app/progress"),
    path.join(process.cwd(), "app/actions/project-management"),
    path.join(process.cwd(), "components/project-management"),
    path.join(process.cwd(), "lib/project-management"),
  ]);
  const imports = await Promise.all(
    projectManagementFiles.map(async (filePath) => ({
      filePath,
      content: await readFile(filePath, "utf8"),
    })),
  );

  expect(
    projectManagementFeishuTransportViolations(imports),
  ).toEqual([]);
});

test("项目管理飞书传输只在 notification channel adapter 内启用", async () => {
  const adapterPath = path.join(
    process.cwd(),
    "lib/notification-channels/project-management.ts",
  );
  const content = await readFile(adapterPath, "utf8");
  expect(content).toContain("sendFeishuDirectMessage");
  expect(
    projectManagementFeishuTransportViolations([
      { filePath: adapterPath, content },
    ]).map((violation) => violation.filePath),
  ).toEqual([
    "lib/notification-channels/project-management.ts",
    "lib/notification-channels/project-management.ts",
  ]);
});

test("通知生产 Server Action 在事务提交后触发即时 outbox drain", async () => {
  const expectedCalls = new Map([
    ["app/actions/project-management/tasks.ts", 3],
    ["app/actions/project-management/projects.ts", 1],
    ["app/actions/project-management/revisions.ts", 1],
    ["app/actions/project-management/collaboration.ts", 1],
  ]);
  for (const [relativeFilePath, callCount] of expectedCalls) {
    const content = await readFile(
      path.join(process.cwd(), relativeFilePath),
      "utf8",
    );
    expect(content, relativeFilePath).toContain(
      'import { drainNotificationOutboxSoon } from "@/lib/notification-delivery";',
    );
    expect(
      content.match(/\bdrainNotificationOutboxSoon\(\);/g),
      relativeFilePath,
    ).toHaveLength(callCount);
    expect(
      content.indexOf("drainNotificationOutboxSoon();"),
      relativeFilePath,
    ).toBeGreaterThan(content.indexOf("await "));
  }
});

async function collectExistingSourceFiles(directories: string[]): Promise<string[]> {
  const files = await Promise.all(
    directories.map(async (directory) => {
      try {
        const entry = await stat(directory);
        if (entry.isFile() && /\.(?:ts|tsx)$/.test(directory)) return [directory];
        if (!entry.isDirectory()) return [];
        return await collectSourceFiles(directory);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return [];
        throw error;
      }
    }),
  );
  return files.flat();
}

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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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

function projectManagementFeishuTransportViolations(
  sources: Array<{ filePath: string; content: string }>,
) {
  return sources
    .flatMap(({ filePath, content }) => {
      const importViolations = extractImportSpecifiers(content)
        .map((specifier) => ({
          kind: "import",
          filePath: relativePath(filePath),
          value: specifier,
          resolved: normalizeProjectModulePath(filePath, specifier),
        }))
        .filter(
          ({ resolved }) =>
            resolved !== null &&
            PROJECT_MANAGEMENT_FEISHU_TRANSPORT_MODULES.includes(
              resolved as (typeof PROJECT_MANAGEMENT_FEISHU_TRANSPORT_MODULES)[number],
            ),
        );

      const symbolViolations = PROJECT_MANAGEMENT_FEISHU_TRANSPORT_SYMBOLS
        .filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(content))
        .map((symbol) => ({
          kind: "symbol",
          filePath: relativePath(filePath),
          value: symbol,
          resolved: null,
        }));

      return [...importViolations, ...symbolViolations];
    })
    .sort((left, right) =>
      `${left.filePath}:${left.kind}:${left.value}`.localeCompare(
        `${right.filePath}:${right.kind}:${right.value}`,
      ),
    );
}

function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const importPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(content)) !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function normalizeProjectModulePath(
  filePath: string,
  specifier: string,
): string | null {
  if (specifier.startsWith("@/")) {
    return stripModuleExtension(specifier.slice(2));
  }
  if (specifier.startsWith(".")) {
    return stripModuleExtension(
      relativePath(path.resolve(path.dirname(filePath), specifier)),
    );
  }
  return null;
}

function stripModuleExtension(modulePath: string): string {
  return modulePath
    .replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "")
    .replace(/\/index$/, "");
}

function relativePath(filePath: string): string {
  return path.relative(process.cwd(), filePath).split(path.sep).join("/");
}
