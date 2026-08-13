import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;
const SOURCE_ROOTS = ["app", "components", "lib", "prisma", "scripts", "tests"];
const ROOT_SOURCE_FILES = [
  "next.config.ts",
  "playwright.config.ts",
  "prisma.config.ts",
  "proxy.ts",
];
const REACHABILITY_CHECKED_ROOTS = ["components", "lib"];
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".next-playwright",
  ".tmp",
  "generated",
  "node_modules",
  "playwright-report",
  "storage",
  "test-results",
]);

type SourceModule = {
  absolutePath: string;
  repositoryPath: string;
  dependencies: Set<string>;
  moduleSpecifiers: string[];
  isClientModule: boolean;
  isServerModule: boolean;
};

const NODE_BUILTIN_MODULES = new Set(
  builtinModules.flatMap((moduleName) => [
    moduleName.replace(/^node:/u, ""),
    `node:${moduleName.replace(/^node:/u, "")}`,
  ]),
);

function repositoryPath(absolutePath: string): string {
  return path.relative(REPOSITORY_ROOT, absolutePath).split(path.sep).join("/");
}

function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (IGNORED_DIRECTORIES.has(entry.name)) return [];
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolutePath);
    return SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
      ? [absolutePath]
      : [];
  });
}

function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function candidatePaths(basePath: string): string[] {
  if (SOURCE_EXTENSIONS.some((extension) => basePath.endsWith(extension))) {
    return [basePath];
  }
  return [
    ...SOURCE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(basePath, `index${extension}`)),
  ];
}

function resolveSourceImport(importer: string, specifier: string): string | null {
  let basePath: string;
  if (specifier.startsWith("@/")) {
    basePath = path.join(REPOSITORY_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    basePath = path.resolve(path.dirname(importer), specifier);
  } else {
    return null;
  }
  return candidatePaths(basePath).find((candidate) => fs.existsSync(candidate)) ?? null;
}

function isInternalSpecifier(specifier: string): boolean {
  return specifier.startsWith("@/") || specifier.startsWith(".");
}

function loadModules(): Map<string, SourceModule> {
  const absolutePaths = [
    ...SOURCE_ROOTS.flatMap((sourceRoot) =>
      walk(path.join(REPOSITORY_ROOT, sourceRoot)),
    ),
    ...ROOT_SOURCE_FILES.map((sourceFile) =>
      path.join(REPOSITORY_ROOT, sourceFile),
    ).filter((sourceFile) => fs.existsSync(sourceFile)),
  ];
  const modules = new Map<string, SourceModule>();
  for (const absolutePath of absolutePaths) {
    const sourceText = fs.readFileSync(absolutePath, "utf8");
    const sourceFile = ts.createSourceFile(
      absolutePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      absolutePath.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : absolutePath.endsWith(".jsx")
          ? ts.ScriptKind.JSX
          : absolutePath.endsWith(".js") ||
              absolutePath.endsWith(".mjs") ||
              absolutePath.endsWith(".cjs")
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS,
    );
    const specifiers = moduleSpecifiers(sourceFile);
    const dependencies = new Set(
      specifiers.flatMap((specifier) => {
        const resolved = resolveSourceImport(absolutePath, specifier);
        return resolved ? [resolved] : [];
      }),
    );
    modules.set(absolutePath, {
      absolutePath,
      repositoryPath: repositoryPath(absolutePath),
      dependencies,
      moduleSpecifiers: specifiers,
      isClientModule: sourceFile.statements.some(
        (statement) =>
          ts.isExpressionStatement(statement) &&
          ts.isStringLiteral(statement.expression) &&
          statement.expression.text === "use client",
      ),
      isServerModule: sourceFile.statements.some(
        (statement) =>
          ts.isExpressionStatement(statement) &&
          ts.isStringLiteral(statement.expression) &&
          statement.expression.text === "use server",
      ),
    });
  }
  return modules;
}

function findUnresolvedInternalImports(
  modules: Map<string, SourceModule>,
): string[] {
  const violations: string[] = [];
  for (const sourceModule of modules.values()) {
    for (const specifier of sourceModule.moduleSpecifiers) {
      if (!isInternalSpecifier(specifier)) continue;
      if (resolveSourceImport(sourceModule.absolutePath, specifier)) continue;
      const basePath = specifier.startsWith("@/")
        ? path.join(REPOSITORY_ROOT, specifier.slice(2))
        : path.resolve(path.dirname(sourceModule.absolutePath), specifier);
      // Existing non-TypeScript files such as CSS are outside this source graph.
      // A directory without a resolvable index module is still a broken import.
      if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) continue;
      violations.push(`${sourceModule.repositoryPath} -> ${specifier}`);
    }
  }
  return violations.sort();
}

function findUnreachableModules(modules: Map<string, SourceModule>): string[] {
  const entries = [...modules.values()].filter((sourceModule) =>
    !REACHABILITY_CHECKED_ROOTS.some((root) =>
      sourceModule.repositoryPath.startsWith(`${root}/`),
    ),
  );
  const reachable = new Set<string>();
  const pending = entries.map((entry) => entry.absolutePath);
  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || reachable.has(currentPath)) continue;
    reachable.add(currentPath);
    const current = modules.get(currentPath);
    if (!current) continue;
    for (const dependency of current.dependencies) pending.push(dependency);
  }
  return [...modules.values()]
    .filter((sourceModule) =>
      REACHABILITY_CHECKED_ROOTS.some((root) =>
        sourceModule.repositoryPath.startsWith(`${root}/`),
      ),
    )
    .filter((sourceModule) => !reachable.has(sourceModule.absolutePath))
    .map((sourceModule) => sourceModule.repositoryPath)
    .sort();
}

function isProjectManagementModule(sourceModule: SourceModule): boolean {
  return sourceModule.repositoryPath.startsWith("lib/project-management/");
}

function findProjectManagementBoundaryViolations(
  modules: Map<string, SourceModule>,
): string[] {
  const violations: string[] = [];
  for (const root of [...modules.values()].filter(isProjectManagementModule)) {
    const visited = new Set<string>();
    const pending = [...root.dependencies];
    while (pending.length > 0) {
      const dependencyPath = pending.pop();
      if (!dependencyPath || visited.has(dependencyPath)) continue;
      visited.add(dependencyPath);
      const dependency = modules.get(dependencyPath);
      if (!dependency) continue;
      if (
        dependency.repositoryPath.startsWith("components/") ||
        dependency.isClientModule
      ) {
        violations.push(`${root.repositoryPath} -> ${dependency.repositoryPath}`);
        continue;
      }
      for (const nestedDependency of dependency.dependencies) {
        pending.push(nestedDependency);
      }
    }
  }
  return [...new Set(violations)].sort();
}

function assertProjectManagementBoundaryFixture(): void {
  const rootPath = path.join(REPOSITORY_ROOT, "lib/project-management/root.ts");
  const bridgePath = path.join(REPOSITORY_ROOT, "lib/bridge.ts");
  const clientPath = path.join(REPOSITORY_ROOT, "components/client.tsx");
  const fixture = new Map<string, SourceModule>([
    [
      rootPath,
      {
        absolutePath: rootPath,
        repositoryPath: "lib/project-management/root.ts",
        dependencies: new Set([bridgePath]),
        moduleSpecifiers: [],
        isClientModule: false,
        isServerModule: false,
      },
    ],
    [
      bridgePath,
      {
        absolutePath: bridgePath,
        repositoryPath: "lib/bridge.ts",
        dependencies: new Set([clientPath]),
        moduleSpecifiers: [],
        isClientModule: false,
        isServerModule: false,
      },
    ],
    [
      clientPath,
      {
        absolutePath: clientPath,
        repositoryPath: "components/client.tsx",
        dependencies: new Set(),
        moduleSpecifiers: [],
        isClientModule: true,
        isServerModule: false,
      },
    ],
  ]);
  const expected = "lib/project-management/root.ts -> components/client.tsx";
  const actual = findProjectManagementBoundaryViolations(fixture);
  if (actual.length !== 1 || actual[0] !== expected) {
    throw new Error("project-management 传递边界自测失败");
  }
}

const OUTBOX_CORE_MODULES = new Set([
  "lib/notification-outbox.ts",
  "lib/notification-channel-adapter.ts",
]);
const OUTBOX_CORE_PREFIX = "lib/notification-outbox/";
const OUTBOX_ALLOWED_DEPENDENCIES = new Set([
  "lib/logger.ts",
  "lib/prisma.ts",
  "lib/notification-channel-adapter.ts",
]);
const OUTBOX_INFRASTRUCTURE_MODULES = new Set([
  "lib/logger.ts",
  "lib/log-context.ts",
  "lib/prisma.ts",
]);
const OUTBOX_REGISTRY_MODULE = "lib/notification-channel-registry.ts";
const OUTBOX_REGISTRY_ALLOWED_DEPENDENCIES = new Set([
  "lib/notification-channel-adapter.ts",
  "lib/notification-channels/email.ts",
  "lib/notification-channels/feedback.ts",
  "lib/notification-channels/procurement.ts",
  "lib/notification-channels/project-management.ts",
]);

function isOutboxCoreModule(repositoryPath: string): boolean {
  return (
    OUTBOX_CORE_MODULES.has(repositoryPath) ||
    repositoryPath.startsWith(OUTBOX_CORE_PREFIX)
  );
}

function findOutboxBoundaryViolations(modules: Map<string, SourceModule>): string[] {
  const violations: string[] = [];
  for (const sourceModule of modules.values()) {
    if (!isOutboxCoreModule(sourceModule.repositoryPath)) continue;
    for (const dependencyPath of sourceModule.dependencies) {
      const dependency = modules.get(dependencyPath);
      if (!dependency) continue;
      if (
        !isOutboxCoreModule(dependency.repositoryPath) &&
        !OUTBOX_ALLOWED_DEPENDENCIES.has(dependency.repositoryPath)
      ) {
        violations.push(
          `${sourceModule.repositoryPath} -> ${dependency.repositoryPath}`,
        );
      }
    }

    const visited = new Set<string>();
    const pending = [...sourceModule.dependencies];
    while (pending.length > 0) {
      const dependencyPath = pending.pop();
      if (!dependencyPath || visited.has(dependencyPath)) continue;
      visited.add(dependencyPath);
      const dependency = modules.get(dependencyPath);
      if (!dependency) continue;
      if (
        !isOutboxCoreModule(dependency.repositoryPath) &&
        !OUTBOX_INFRASTRUCTURE_MODULES.has(dependency.repositoryPath)
      ) {
        violations.push(
          `${sourceModule.repositoryPath} -> ${dependency.repositoryPath}`,
        );
        continue;
      }
      for (const nestedDependency of dependency.dependencies) {
        pending.push(nestedDependency);
      }
    }
  }
  const registry = [...modules.values()].find(
    (sourceModule) => sourceModule.repositoryPath === OUTBOX_REGISTRY_MODULE,
  );
  if (registry) {
    for (const dependencyPath of registry.dependencies) {
      const dependency = modules.get(dependencyPath);
      if (
        dependency &&
        !OUTBOX_REGISTRY_ALLOWED_DEPENDENCIES.has(dependency.repositoryPath)
      ) {
        violations.push(
          `${registry.repositoryPath} -> ${dependency.repositoryPath}`,
        );
      }
    }
  }
  return violations.sort();
}

function assertOutboxBoundaryFixture(): void {
  const corePath = path.join(REPOSITORY_ROOT, "lib/notification-outbox.ts");
  const loggerPath = path.join(REPOSITORY_ROOT, "lib/logger.ts");
  const forbiddenPath = path.join(REPOSITORY_ROOT, "lib/feishu.ts");
  const fixture = new Map<string, SourceModule>([
    [
      corePath,
      {
        absolutePath: corePath,
        repositoryPath: "lib/notification-outbox.ts",
        dependencies: new Set([loggerPath]),
        moduleSpecifiers: [],
        isClientModule: false,
        isServerModule: false,
      },
    ],
    [
      loggerPath,
      {
        absolutePath: loggerPath,
        repositoryPath: "lib/logger.ts",
        dependencies: new Set([forbiddenPath]),
        moduleSpecifiers: [],
        isClientModule: false,
        isServerModule: false,
      },
    ],
    [
      forbiddenPath,
      {
        absolutePath: forbiddenPath,
        repositoryPath: "lib/feishu.ts",
        dependencies: new Set(),
        moduleSpecifiers: [],
        isClientModule: false,
        isServerModule: false,
      },
    ],
  ]);
  const actual = findOutboxBoundaryViolations(fixture);
  const expected = "lib/notification-outbox.ts -> lib/feishu.ts";
  if (actual.length !== 1 || actual[0] !== expected) {
    throw new Error("notification outbox 传递边界自测失败");
  }
}

function assertModuleSpecifierFixture(): void {
  const sourceFile = ts.createSourceFile(
    "/fixture/import-types.ts",
    'type ClientType = import("@/components/client").ClientType;',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const actual = moduleSpecifiers(sourceFile);
  if (actual.length !== 1 || actual[0] !== "@/components/client") {
    throw new Error("TypeScript import type 依赖提取自测失败");
  }
}

const BROWSER_SAFE_CONTRACTS = new Set([
  "lib/project-management/composer-contract.ts",
]);
const BROWSER_SAFE_PREFIXES = ["lib/project-management/time-canvas/"];

function isBrowserSafeRoot(repositoryPath: string): boolean {
  return (
    BROWSER_SAFE_CONTRACTS.has(repositoryPath) ||
    BROWSER_SAFE_PREFIXES.some((prefix) => repositoryPath.startsWith(prefix))
  );
}

function importsServerOnlyApi(sourceModule: SourceModule): boolean {
  return (
    sourceModule.isServerModule ||
    sourceModule.moduleSpecifiers.some(
      (specifier) =>
        NODE_BUILTIN_MODULES.has(specifier) ||
        specifier.startsWith("@prisma/") ||
        specifier === "server-only" ||
        specifier === "next/headers" ||
        specifier === "next/server" ||
        specifier === "@/lib/prisma" ||
        specifier.startsWith("@/lib/prisma/"),
    )
  );
}

function assertBrowserContractBoundaryFixture(): void {
  const fixture = {
    absolutePath: "/fixture/browser-contract.ts",
    repositoryPath: "lib/project-management/time-canvas/fixture.ts",
    dependencies: new Set<string>(),
    moduleSpecifiers: ["crypto"],
    isClientModule: false,
    isServerModule: false,
  } satisfies SourceModule;
  if (!importsServerOnlyApi(fixture)) {
    throw new Error("浏览器契约 Node builtin 边界自测失败");
  }
  if (
    !importsServerOnlyApi({
      ...fixture,
      moduleSpecifiers: [],
      isServerModule: true,
    })
  ) {
    throw new Error("浏览器契约 use server 边界自测失败");
  }
}

function findBrowserContractViolations(modules: Map<string, SourceModule>): string[] {
  const violations: string[] = [];
  for (const root of [...modules.values()].filter((sourceModule) =>
    isBrowserSafeRoot(sourceModule.repositoryPath),
  )) {
    const visited = new Set<string>();
    const pending = [root.absolutePath];
    while (pending.length > 0) {
      const currentPath = pending.pop();
      if (!currentPath || visited.has(currentPath)) continue;
      visited.add(currentPath);
      const current = modules.get(currentPath);
      if (!current) continue;
      if (importsServerOnlyApi(current)) {
        violations.push(
          `${root.repositoryPath} reaches server-only ${current.repositoryPath}`,
        );
      }
      for (const dependencyPath of current.dependencies) {
        const dependency = modules.get(dependencyPath);
        if (!dependency) continue;
        if (dependency.repositoryPath.startsWith("components/")) {
          violations.push(
            `${root.repositoryPath} -> ${dependency.repositoryPath}`,
          );
          continue;
        }
        pending.push(dependencyPath);
      }
    }
  }
  return [...new Set(violations)].sort();
}

function printFailure(title: string, details: string[]): void {
  if (details.length === 0) return;
  console.error(`\n${title}:`);
  for (const detail of details) console.error(`- ${detail}`);
}

const modules = loadModules();
assertModuleSpecifierFixture();
assertOutboxBoundaryFixture();
assertProjectManagementBoundaryFixture();
assertBrowserContractBoundaryFixture();
const unresolvedInternalImports = findUnresolvedInternalImports(modules);
const unreachableModules = findUnreachableModules(modules);
const projectManagementViolations = findProjectManagementBoundaryViolations(modules);
const outboxViolations = findOutboxBoundaryViolations(modules);
const browserContractViolations = findBrowserContractViolations(modules);

printFailure("存在无法解析的内部源码依赖", unresolvedInternalImports);
printFailure("components/ 或 lib/ 中存在无法从入口到达的模块", unreachableModules);
printFailure("lib/project-management 依赖了客户端实现", projectManagementViolations);
printFailure("notification outbox 核心依赖了业务实现", outboxViolations);
printFailure("浏览器安全契约依赖了服务端实现", browserContractViolations);

const failureCount =
  unresolvedInternalImports.length +
  unreachableModules.length +
  projectManagementViolations.length +
  outboxViolations.length +
  browserContractViolations.length;
if (failureCount > 0) process.exitCode = 1;
else console.log(`Source dependency checks passed (${modules.size} modules).`);
