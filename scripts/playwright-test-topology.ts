import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

export const PLAYWRIGHT_PROJECT_NAMES = [
  "node-db",
  "desktop",
  "mobile",
] as const;

export type PlaywrightTestKind = "node-db" | "ui";
export type PlaywrightTopologySelectionMode = "full" | "partial";
export type PlaywrightProjectSelection = string[] | null;

export const PLAYWRIGHT_TOPOLOGY_SELECTION_MODE_ENV =
  "PLAYWRIGHT_TOPOLOGY_SELECTION_MODE";

export type PlaywrightTestTopology = {
  nodeDb: string[];
  ui: string[];
};

type PlaywrightSpecAnalysis = {
  usesBrowserFixture: boolean;
  usesDeviceProjectSkip: boolean;
};

const DECLARATION_PATTERN = /^\/\/ @playwright-project (node-db|ui)$/gm;
const PLAYWRIGHT_DEFAULT_TEST_FILE_PATTERN =
  /\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/;
const BROWSER_FIXTURES = new Set(["browser", "context", "page"]);
const HOOK_CALLBACKS = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
]);
const ANNOTATION_METHODS = new Set(["fail", "fixme", "skip", "slow"]);
// These exact paths mirror the callable properties installed by Playwright
// 1.61.1's TestTypeImpl; test.extend is recognized and rejected separately.
const TEST_REGISTRATION_PATHS = new Set([
  "",
  "fail",
  "fail.only",
  "fixme",
  "only",
  "skip",
]);
const SUITE_REGISTRATION_PATHS = new Set([
  "describe",
  "describe.fixme",
  "describe.only",
  "describe.parallel",
  "describe.parallel.only",
  "describe.serial",
  "describe.serial.only",
  "describe.skip",
]);
const NON_REGISTRATION_TEST_PATHS = new Set([
  "abort",
  "describe.configure",
  "info",
  "setTimeout",
  "step",
  "step.skip",
  "use",
]);
const EXPECT_CALL_SUFFIXES = new Set([
  "",
  "any",
  "anything",
  "arrayContaining",
  "arrayOf",
  "closeTo",
  "configure",
  "extend",
  "getState",
  "not.arrayContaining",
  "not.arrayOf",
  "not.closeTo",
  "not.objectContaining",
  "not.stringContaining",
  "not.stringMatching",
  "objectContaining",
  "poll",
  "stringContaining",
  "stringMatching",
]);
const TEST_API_RETURN_VALUE_PATHS = new Set(["info", "step", "step.skip"]);
const NODE_BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);
const SAFE_REGISTRATION_GLOBAL_CALL_ROOTS = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Buffer",
  "Date",
  "Intl",
  "JSON",
  "Math",
  "Number",
  "Object",
  "RegExp",
  "String",
  "URL",
  "process",
  "structuredClone",
]);
const SAFE_REGISTRATION_GLOBAL_CONSTRUCTORS = new Set([
  "Array",
  "Date",
  "Error",
  "EvalError",
  "Intl",
  "Map",
  "RangeError",
  "ReferenceError",
  "RegExp",
  "SyntaxError",
  "TypeError",
  "URIError",
  "URL",
  "URLSearchParams",
]);
const CALLBACK_INVOKING_GLOBAL_METHODS = new Set([
  "addListener",
  "catch",
  "every",
  "filter",
  "finally",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "nextTick",
  "on",
  "once",
  "prependListener",
  "prependOnceListener",
  "reduce",
  "reduceRight",
  "replace",
  "replaceAll",
  "some",
  "sort",
  "setUncaughtExceptionCaptureCallback",
  "then",
]);
const BOOLEAN_BINARY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.LessThanToken,
]);
const FULL_BOOLEAN_OPTIONS = new Set([
  "--fail-on-flaky-tests",
  "--forbid-only",
  "--headed",
  "--list",
  "--pass-with-no-tests",
  "--quiet",
]);
const FULL_VALUE_OPTIONS = new Set([
  "--global-timeout",
  "--max-failures",
  "--output",
  "--repeat-each",
  "--retries",
  "--timeout",
  "--trace",
]);
const PARTIAL_BOOLEAN_OPTIONS = new Set(["--last-failed"]);
const PARTIAL_OPTIONAL_VALUE_OPTIONS = new Set(["--only-changed"]);
const PARTIAL_VALUE_OPTIONS = new Set([
  "--grep",
  "--grep-invert",
  "--shard",
  "--test-list",
  "--test-list-invert",
]);

function walkSpecFiles(directory: string, testRoot: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSpecFiles(absolutePath, testRoot));
      continue;
    }
    if (!entry.isFile() || !PLAYWRIGHT_DEFAULT_TEST_FILE_PATTERN.test(entry.name)) {
      continue;
    }
    if (!entry.name.endsWith(".spec.ts")) {
      const relativePath = path
        .relative(testRoot, absolutePath)
        .split(path.sep)
        .join("/");
      throw new Error(
        `${relativePath} matches Playwright's default test filename rules but topology classification only supports .spec.ts; rename the file before running Playwright`,
      );
    }
    files.push(absolutePath);
  }
  return files.sort();
}

function declaredKind(source: string, relativePath: string): PlaywrightTestKind {
  const declarations = [...source.matchAll(DECLARATION_PATTERN)];
  if (declarations.length !== 1 || declarations[0]?.index !== 0) {
    throw new Error(
      `${relativePath} must start with exactly one // @playwright-project ui|node-db declaration`,
    );
  }
  return declarations[0][1] as PlaywrightTestKind;
}

type TestImports = {
  importedModules: Map<string, string>;
  testBindings: Set<string>;
};

function testImports(
  sourceFile: ts.SourceFile,
  relativePath: string,
): TestImports {
  const importedModules = new Map<string, string>();
  const testBindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : "";
    const importClause = statement.importClause;
    if (importClause?.name) importedModules.set(importClause.name.text, moduleName);
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      importedModules.set(namedBindings.name.text, moduleName);
      continue;
    }
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const element of namedBindings.elements) {
      importedModules.set(element.name.text, moduleName);
      const importedName = (element.propertyName ?? element.name).text;
      if (importedName !== "test") continue;
      if (moduleName !== "@playwright/test") {
        throw new Error(
          `${relativePath} imports a custom test fixture; specs must import test directly from @playwright/test`,
        );
      }
      testBindings.add(element.name.text);
    }
  }
  if (testBindings.size === 0) {
    throw new Error(
      `${relativePath} must import test directly from @playwright/test`,
    );
  }
  return { importedModules, testBindings };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function rootIdentifier(expression: ts.Expression): ts.Identifier | null {
  let current = unwrapExpression(expression);
  while (
    ts.isCallExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isPropertyAccessExpression(current)
  ) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : null;
}

type LocalValueBindings = {
  hasAt(identifier: ts.Identifier): boolean;
};

function officialTestPath(
  expression: ts.Expression,
  testBindings: Set<string>,
  localBindings: LocalValueBindings,
): string[] | null {
  const current = unwrapExpression(expression);
  if (
    ts.isIdentifier(current) &&
    testBindings.has(current.text) &&
    !localBindings.hasAt(current)
  ) {
    return [];
  }
  if (ts.isPropertyAccessExpression(current)) {
    const parentPath = officialTestPath(
      current.expression,
      testBindings,
      localBindings,
    );
    return parentPath ? [...parentPath, current.name.text] : null;
  }
  return null;
}

function callPathKey(callPath: string[]): string {
  return callPath.join(".");
}

function isSupportedExpectCallPath(callPath: string[]): boolean {
  if (callPath[0] !== "expect") return false;
  const suffix = callPath.slice(1);
  while (suffix[0] === "soft") suffix.shift();
  return EXPECT_CALL_SUFFIXES.has(suffix.join("."));
}

function isTestApiReturnValuePath(callPath: string[]): boolean {
  return (
    isSupportedExpectCallPath(callPath) ||
    TEST_API_RETURN_VALUE_PATHS.has(callPathKey(callPath))
  );
}

function returnedTestApiPath(
  expression: ts.Expression,
  testBindings: Set<string>,
  localBindings: LocalValueBindings,
): string[] | null {
  let current = unwrapExpression(expression);
  while (
    ts.isElementAccessExpression(current) ||
    ts.isPropertyAccessExpression(current)
  ) {
    current = unwrapExpression(current.expression);
  }
  if (!ts.isCallExpression(current)) return null;
  const callPath = officialTestPath(
    current.expression,
    testBindings,
    localBindings,
  );
  if (callPath && isTestApiReturnValuePath(callPath)) return callPath;
  return returnedTestApiPath(current.expression, testBindings, localBindings);
}

function localValueBindings(sourceFile: ts.SourceFile): LocalValueBindings {
  const bindingsByScope = new Map<ts.Node, Set<string>>();
  const addBinding = (scope: ts.Node, name: string): void => {
    const bindings = bindingsByScope.get(scope) ?? new Set<string>();
    bindings.add(name);
    bindingsByScope.set(scope, bindings);
  };
  let lexicalScope: ts.Node = sourceFile;
  let functionScope: ts.Node = sourceFile;
  const addBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      addBinding(lexicalScope, name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) addBindingName(element.name);
    }
  };
  const visit = (node: ts.Node): void => {
    const previousLexicalScope = lexicalScope;
    const previousFunctionScope = functionScope;
    if (
      ts.isBlock(node) ||
      ts.isCaseBlock(node) ||
      ts.isCatchClause(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isFunctionLike(node) ||
      ts.isSourceFile(node)
    ) {
      lexicalScope = node;
    }
    if (ts.isFunctionLike(node)) functionScope = node;

    if (
      (ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isFunctionDeclaration(node)) &&
      node.name
    ) {
      addBinding(previousLexicalScope, node.name.text);
    }
    if (
      (ts.isClassExpression(node) || ts.isFunctionExpression(node)) &&
      node.name
    ) {
      addBinding(node, node.name.text);
    }
    if (ts.isVariableDeclaration(node)) {
      const declarationList = ts.isVariableDeclarationList(node.parent)
        ? node.parent
        : null;
      const bindingScope = lexicalScope;
      if (
        declarationList &&
        !(declarationList.flags & ts.NodeFlags.BlockScoped)
      ) {
        lexicalScope = functionScope;
      }
      addBindingName(node.name);
      lexicalScope = bindingScope;
    }
    if (ts.isParameter(node)) {
      const bindingScope = lexicalScope;
      lexicalScope = functionScope;
      addBindingName(node.name);
      lexicalScope = bindingScope;
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      addBindingName(node.variableDeclaration.name);
    }
    ts.forEachChild(node, visit);

    lexicalScope = previousLexicalScope;
    functionScope = previousFunctionScope;
  };
  visit(sourceFile);
  return {
    hasAt(identifier) {
      let current: ts.Node | undefined = identifier.parent;
      while (current) {
        if (bindingsByScope.get(current)?.has(identifier.text)) return true;
        current = current.parent;
      }
      return false;
    },
  };
}

function localCallableBindings(
  sourceFile: ts.SourceFile,
  localBindings: LocalValueBindings,
  importedModules: Map<string, string>,
): Set<string> {
  const callableBindings = new Set<string>();
  const aliases: Array<{ initializer: ts.Expression; name: string }> = [];
  const addConservativeBindingNames = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      callableBindings.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) {
        addConservativeBindingNames(element.name);
      }
    }
  };
  const isProcessEnvValueAccess = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    if (
      !ts.isElementAccessExpression(current) &&
      !ts.isPropertyAccessExpression(current)
    ) {
      return false;
    }
    const envAccess = unwrapExpression(current.expression);
    if (
      !ts.isPropertyAccessExpression(envAccess) ||
      envAccess.name.text !== "env"
    ) {
      return false;
    }
    const processIdentifier = unwrapExpression(envAccess.expression);
    return (
      ts.isIdentifier(processIdentifier) &&
      processIdentifier.text === "process" &&
      !localBindings.hasAt(processIdentifier) &&
      !importedModules.has(processIdentifier.text)
    );
  };
  const containsCallableExpression = (node: ts.Node): boolean => {
    if (
      ts.isArrowFunction(node) ||
      ts.isClassExpression(node) ||
      ts.isFunctionExpression(node)
    ) {
      return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && containsCallableExpression(child)) found = true;
    });
    return found;
  };
  const recordBinding = (name: ts.BindingName, initializer: ts.Expression): void => {
    const current = unwrapExpression(initializer);
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (!ts.isIdentifier(element.name)) {
          addConservativeBindingNames(element.name);
          continue;
        }
        // A destructured value can be replaced through its source object before
        // registration. Treat it as callable when it is passed to any helper.
        callableBindings.add(element.name.text);
      }
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (!ts.isIdentifier(element.name)) {
          addConservativeBindingNames(element.name);
          continue;
        }
        callableBindings.add(element.name.text);
      }
      return;
    }
    if (
      containsCallableExpression(current) ||
      ((ts.isElementAccessExpression(current) ||
        ts.isPropertyAccessExpression(current)) &&
        !isProcessEnvValueAccess(current))
    ) {
      callableBindings.add(name.text);
      return;
    }
    aliases.push({ initializer: current, name: name.text });
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name
    ) {
      callableBindings.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      recordBinding(node.name, node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      recordBinding(node.left, node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const { initializer, name } of aliases) {
      const root = rootIdentifier(initializer);
      if (!root || !callableBindings.has(root.text) || callableBindings.has(name)) {
        continue;
      }
      callableBindings.add(name);
      changed = true;
    }
  }
  return callableBindings;
}

function containsAccessorDeclaration(node: ts.Node): boolean {
  if (ts.isGetAccessorDeclaration(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsAccessorDeclaration(child)) found = true;
  });
  return found;
}

function localAccessorBindings(sourceFile: ts.SourceFile): Set<string> {
  const accessorBindings = new Set<string>();
  const accessorClasses = new Set<string>();
  const aliases: Array<{ initializer: ts.Expression; name: string }> = [];
  const descriptorDefinesGetter = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    if (!ts.isObjectLiteralExpression(current)) return false;
    return current.properties.some((property) => {
      if (
        (ts.isMethodDeclaration(property) ||
          ts.isPropertyAssignment(property)) &&
        property.name
      ) {
        const name = property.name;
        return (
          (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
          name.text === "get"
        );
      }
      return false;
    });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      containsAccessorDeclaration(node)
    ) {
      accessorClasses.add(node.name.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "defineProperty" &&
      node.arguments[0] &&
      node.arguments[2] &&
      descriptorDefinesGetter(node.arguments[2])
    ) {
      const target = rootIdentifier(node.arguments[0]);
      if (target) accessorBindings.add(target.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (
        ts.isObjectLiteralExpression(initializer) &&
        containsAccessorDeclaration(initializer)
      ) {
        accessorBindings.add(node.name.text);
      } else if (ts.isNewExpression(initializer)) {
        const root = rootIdentifier(initializer.expression);
        if (root && accessorClasses.has(root.text)) {
          accessorBindings.add(node.name.text);
        } else {
          aliases.push({ initializer: initializer.expression, name: node.name.text });
        }
      } else {
        aliases.push({ initializer, name: node.name.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const { initializer, name } of aliases) {
      const root = rootIdentifier(initializer);
      if (
        !root ||
        (!accessorBindings.has(root.text) && !accessorClasses.has(root.text)) ||
        accessorBindings.has(name)
      ) {
        continue;
      }
      accessorBindings.add(name);
      changed = true;
    }
  }
  return accessorBindings;
}

function containsCustomIterator(node: ts.Node): boolean {
  const name = "name" in node ? (node as ts.NamedDeclaration).name : undefined;
  if (name && ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "Symbol" &&
      expression.name.text === "iterator"
    ) {
      return true;
    }
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsCustomIterator(child)) found = true;
  });
  return found;
}

function localIterableBindings(sourceFile: ts.SourceFile): Set<string> {
  const iterableBindings = new Set<string>();
  const iterableClasses = new Set<string>();
  const aliases: Array<{ initializer: ts.Expression; name: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      containsCustomIterator(node)
    ) {
      iterableClasses.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (
        ts.isObjectLiteralExpression(initializer) &&
        containsCustomIterator(initializer)
      ) {
        iterableBindings.add(node.name.text);
      } else if (ts.isNewExpression(initializer)) {
        const root = rootIdentifier(initializer.expression);
        if (root && iterableClasses.has(root.text)) {
          iterableBindings.add(node.name.text);
        } else {
          aliases.push({ initializer: initializer.expression, name: node.name.text });
        }
      } else {
        aliases.push({ initializer, name: node.name.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const { initializer, name } of aliases) {
      const root = rootIdentifier(initializer);
      if (
        !root ||
        (!iterableBindings.has(root.text) && !iterableClasses.has(root.text)) ||
        iterableBindings.has(name)
      ) {
        continue;
      }
      iterableBindings.add(name);
      changed = true;
    }
  }
  return iterableBindings;
}

function argumentMayBeCallable(
  argument: ts.Expression,
  callableBindings: Set<string>,
  localBindings: LocalValueBindings,
  importedModules: Map<string, string>,
): boolean {
  const inspect = (node: ts.Node): boolean => {
    if (ts.isTypeNode(node)) return false;
    if (
      ts.isArrowFunction(node) ||
      ts.isClassExpression(node) ||
      ts.isFunctionExpression(node)
    ) {
      return true;
    }
    if (ts.isIdentifier(node)) {
      if (callableBindings.has(node.text)) return true;
      const importedModule = importedModules.get(node.text);
      if (
        importedModule &&
        importedModule !== "@playwright/test" &&
        !NODE_BUILTIN_MODULES.has(importedModule)
      ) {
        return true;
      }
    }
    if (
      ts.isCallExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isPropertyAccessExpression(node)
    ) {
      const root = rootIdentifier(node);
      if (root && localBindings.hasAt(root)) return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && inspect(child)) found = true;
    });
    return found;
  };
  return inspect(unwrapExpression(argument));
}

function isStaticallyBooleanCondition(
  expression: ts.Expression,
  localBindings: LocalValueBindings,
  importedModules: Map<string, string>,
): boolean {
  const current = unwrapExpression(expression);
  if (
    current.kind === ts.SyntaxKind.FalseKeyword ||
    current.kind === ts.SyntaxKind.TrueKeyword
  ) {
    return true;
  }
  if (
    ts.isPrefixUnaryExpression(current) &&
    current.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return true;
  }
  if (ts.isBinaryExpression(current)) {
    return BOOLEAN_BINARY_OPERATORS.has(current.operatorToken.kind);
  }
  if (ts.isConditionalExpression(current)) {
    return (
      isStaticallyBooleanCondition(
        current.whenTrue,
        localBindings,
        importedModules,
      ) &&
      isStaticallyBooleanCondition(
        current.whenFalse,
        localBindings,
        importedModules,
      )
    );
  }
  if (ts.isCallExpression(current)) {
    const calledExpression = unwrapExpression(current.expression);
    return (
      ts.isIdentifier(calledExpression) &&
      calledExpression.text === "Boolean" &&
      !localBindings.hasAt(calledExpression) &&
      !importedModules.has("Boolean")
    );
  }
  return false;
}

function globalCallMayInvokeCallback(call: ts.CallExpression): boolean {
  const root = rootIdentifier(call.expression);
  if (!root) return false;
  const expression = unwrapExpression(call.expression);
  const methodName = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : null;
  if (
    root.text === "Array" &&
    methodName === "from" &&
    call.arguments.length >= 2
  ) {
    return true;
  }
  if (
    root.text === "JSON" &&
    methodName === "stringify" &&
    call.arguments.length >= 2
  ) {
    return true;
  }
  return Boolean(
    methodName &&
      CALLBACK_INVOKING_GLOBAL_METHODS.has(methodName) &&
      call.arguments.length > 0,
  );
}

function inlineCallback(argument: ts.Expression | undefined):
  | ts.ArrowFunction
  | ts.FunctionExpression
  | null {
  const current = argument ? unwrapExpression(argument) : undefined;
  return current &&
    (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
    ? current
    : null;
}

function isTitleExpression(argument: ts.Expression | undefined): boolean {
  return Boolean(
    argument &&
      (ts.isStringLiteralLike(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument) ||
        ts.isTemplateExpression(argument)),
  );
}

function callbackForOfficialRegistration(
  call: ts.CallExpression,
  callPath: string[],
  relativePath: string,
  localBindings: LocalValueBindings,
  importedModules: Map<string, string>,
): {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  kind: "execution" | "suite";
} | null {
  const pathLabel = `test${callPath.map((part) => `.${part}`).join("")}`;
  const pathKey = callPathKey(callPath);
  const lastArgument = call.arguments.at(-1);
  const callback = inlineCallback(lastArgument);
  const conditionalAnnotationCallback =
    callPath.length === 1 && ANNOTATION_METHODS.has(callPath[0]!)
      ? inlineCallback(call.arguments[0])
      : null;
  const hasUnclassifiedConditionalArgument =
    callPath.length === 1 &&
    ANNOTATION_METHODS.has(callPath[0]!) &&
    Boolean(
      call.arguments[0] &&
        !conditionalAnnotationCallback &&
        !isStaticallyBooleanCondition(
          call.arguments[0]!,
          localBindings,
          importedModules,
        ),
    );
  const isTestRegistration = TEST_REGISTRATION_PATHS.has(pathKey);
  const isSuite = SUITE_REGISTRATION_PATHS.has(pathKey);
  const isHook =
    callPath.length === 1 && HOOK_CALLBACKS.has(callPath[0]!);

  if (pathKey === "" || isSuite || isHook) {
    if (!callback) {
      throw new Error(
        `${relativePath} passes a non-inline callback to ${pathLabel}; topology requires an inline function`,
      );
    }
    return { callback, kind: isSuite ? "suite" : "execution" };
  }
  if (
    isTestRegistration &&
    (callback || isTitleExpression(call.arguments[0]))
  ) {
    if (!callback) {
      throw new Error(
        `${relativePath} passes a non-inline callback to ${pathLabel}; topology requires an inline function`,
      );
    }
    return { callback, kind: "execution" };
  }
  if (conditionalAnnotationCallback) {
    return { callback: conditionalAnnotationCallback, kind: "execution" };
  }
  if (hasUnclassifiedConditionalArgument) {
    throw new Error(
      `${relativePath} passes a non-inline conditional callback or non-static condition to ${pathLabel}; topology requires an inline function or statically boolean expression`,
    );
  }
  return null;
}

function fixtureNames(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile,
  relativePath: string,
): string[] {
  const fixtureParameter = callback.parameters[0];
  if (!fixtureParameter || !ts.isObjectBindingPattern(fixtureParameter.name)) {
    return [];
  }
  return fixtureParameter.name.elements.map((element) => {
    const fixtureKey = element.propertyName ?? element.name;
    if (ts.isIdentifier(fixtureKey) || ts.isStringLiteralLike(fixtureKey)) {
      return fixtureKey.text;
    }
    throw new Error(
      `${relativePath} uses a non-static fixture key ${fixtureKey.getText(sourceFile)}; topology requires an identifier or string literal`,
    );
  });
}

function isSupportedNonRegistrationTestCall(callPath: string[]): boolean {
  return (
    (callPath.length === 1 && ANNOTATION_METHODS.has(callPath[0]!)) ||
    isSupportedExpectCallPath(callPath) ||
    NON_REGISTRATION_TEST_PATHS.has(callPathKey(callPath))
  );
}

function analyzeSpec(
  source: string,
  relativePath: string,
): PlaywrightSpecAnalysis {
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const { importedModules, testBindings } = testImports(
    sourceFile,
    relativePath,
  );
  const localBindings = localValueBindings(sourceFile);
  const callableBindings = localCallableBindings(
    sourceFile,
    localBindings,
    importedModules,
  );
  const accessorBindings = localAccessorBindings(sourceFile);
  const iterableBindings = localIterableBindings(sourceFile);
  let usesBrowserFixture = false;
  let usesDeviceProjectSkip = false;
  const executionCallbacks = new Set<ts.Node>();
  const suiteCallbacks = new Set<ts.Node>();
  const approvedTestBindingReferences = new Set<ts.Identifier>();
  const globalObjectAliases = new Set<string>();
  let foundGlobalAlias = true;
  while (foundGlobalAlias) {
    foundGlobalAlias = false;
    const collectGlobalAliases = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const initializer = unwrapExpression(node.initializer);
        if (
          ts.isIdentifier(initializer) &&
          ((["global", "globalThis"].includes(initializer.text) &&
            !localBindings.hasAt(initializer) &&
            !importedModules.has(initializer.text)) ||
            globalObjectAliases.has(initializer.text)) &&
          !globalObjectAliases.has(node.name.text)
        ) {
          globalObjectAliases.add(node.name.text);
          foundGlobalAlias = true;
        }
      }
      ts.forEachChild(node, collectGlobalAliases);
    };
    collectGlobalAliases(sourceFile);
  }

  const isGlobalObject = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    return Boolean(
      ts.isIdentifier(current) &&
        (globalObjectAliases.has(current.text) ||
          (["global", "globalThis"].includes(current.text) &&
            !localBindings.hasAt(current) &&
            !importedModules.has(current.text))),
    );
  };

  const isGlobalProcessEnvObject = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    if (
      !ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current)
    ) {
      return false;
    }
    const propertyName = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : current.argumentExpression &&
          ts.isStringLiteralLike(current.argumentExpression)
        ? current.argumentExpression.text
        : null;
    const processIdentifier = unwrapExpression(current.expression);
    return (
      propertyName === "env" &&
      ts.isIdentifier(processIdentifier) &&
      processIdentifier.text === "process" &&
      !localBindings.hasAt(processIdentifier) &&
      !importedModules.has(processIdentifier.text)
    );
  };
  const isGlobalProcessWriteTarget = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    if (
      ts.isIdentifier(current) &&
      current.text === "process" &&
      !localBindings.hasAt(current) &&
      !importedModules.has(current.text)
    ) {
      return true;
    }
    if (
      !ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current)
    ) {
      return false;
    }
    const propertyName = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : current.argumentExpression &&
          ts.isStringLiteralLike(current.argumentExpression)
        ? current.argumentExpression.text
        : null;
    return (
      propertyName === "process" ||
      (ts.isElementAccessExpression(current) &&
        propertyName === null &&
        isGlobalObject(current.expression))
    );
  };

  const validateOfficialCalls = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializerRoot = rootIdentifier(node.initializer);
      if (ts.isIdentifier(node.name)) {
        const importedModule = initializerRoot
          ? importedModules.get(initializerRoot.text)
          : undefined;
        if (
          importedModule &&
          importedModule !== "@playwright/test" &&
          !NODE_BUILTIN_MODULES.has(importedModule)
        ) {
          importedModules.set(node.name.text, importedModule);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const root = rootIdentifier(node.expression);
      if (
        root &&
        testBindings.has(root.text) &&
        !localBindings.hasAt(root)
      ) {
        const callPath = officialTestPath(
          node.expression,
          testBindings,
          localBindings,
        );
        if (!callPath) {
          if (
            !returnedTestApiPath(
              node.expression,
              testBindings,
              localBindings,
            )
          ) {
            throw new Error(
              `${relativePath} uses a computed or indirect test API; use a direct test method call`,
            );
          }
        } else {
          if (callPathKey(callPath) === "extend") {
            throw new Error(
              `${relativePath} calls test.extend; custom fixtures must not be defined in specs`,
            );
          }
          const registration = callbackForOfficialRegistration(
            node,
            callPath,
            relativePath,
            localBindings,
            importedModules,
          );
          if (registration) {
            const callbacks = registration.kind === "suite"
              ? suiteCallbacks
              : executionCallbacks;
            callbacks.add(registration.callback);
            for (const fixtureName of fixtureNames(
              registration.callback,
              sourceFile,
              relativePath,
            )) {
              if (BROWSER_FIXTURES.has(fixtureName)) usesBrowserFixture = true;
            }
          } else if (!isSupportedNonRegistrationTestCall(callPath)) {
            throw new Error(
              `${relativePath} uses unsupported test API ${node.expression.getText(sourceFile)}; topology only permits direct, statically classified test calls`,
            );
          }
          approvedTestBindingReferences.add(root);
        }
      }
    }
    ts.forEachChild(node, validateOfficialCalls);
  };
  validateOfficialCalls(sourceFile);

  const validateOfficialBindingReferences = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      testBindings.has(node.text) &&
      !localBindings.hasAt(node)
    ) {
      const isImportBinding =
        ts.isImportSpecifier(node.parent) && node.parent.name === node;
      const isPropertyName =
        (ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node) ||
        (ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
        (ts.isMethodDeclaration(node.parent) && node.parent.name === node) ||
        (ts.isPropertyDeclaration(node.parent) && node.parent.name === node);
      if (
        !isImportBinding &&
        !isPropertyName &&
        !approvedTestBindingReferences.has(node)
      ) {
        throw new Error(
          `${relativePath} references the official test binding outside an approved direct test API call`,
        );
      }
    }
    ts.forEachChild(node, validateOfficialBindingReferences);
  };
  validateOfficialBindingReferences(sourceFile);

  const executesDuringRegistration = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isFunctionLike(current)) {
        if (executionCallbacks.has(current)) return false;
        if (!suiteCallbacks.has(current)) return false;
      }
      current = current.parent;
    }
    return true;
  };

  const expressionMayReadAccessor = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    const root = rootIdentifier(current);
    const importedModule = root
      ? importedModules.get(root.text)
      : undefined;
    return Boolean(
      (root &&
        localBindings.hasAt(root) &&
        accessorBindings.has(root.text)) ||
        (root &&
          importedModule &&
          !localBindings.hasAt(root) &&
          importedModule !== "@playwright/test" &&
          !NODE_BUILTIN_MODULES.has(importedModule)) ||
        containsAccessorDeclaration(current),
    );
  };

  const expressionMayInvokeIterator = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    const root = rootIdentifier(current);
    const importedModule = root
      ? importedModules.get(root.text)
      : undefined;
    return Boolean(
      (root &&
        localBindings.hasAt(root) &&
        iterableBindings.has(root.text)) ||
        (root &&
          importedModule &&
          !localBindings.hasAt(root) &&
          importedModule !== "@playwright/test" &&
          !NODE_BUILTIN_MODULES.has(importedModule)) ||
        containsCustomIterator(current),
    );
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (isGlobalProcessEnvObject(node.left) ||
        isGlobalProcessWriteTarget(node.left)) &&
      executesDuringRegistration(node)
    ) {
      throw new Error(
        `${relativePath} replaces global process or process.env while registering tests`,
      );
    }
    if (
      ts.isDeleteExpression(node) &&
      (isGlobalProcessEnvObject(node.expression) ||
        isGlobalProcessWriteTarget(node.expression)) &&
      executesDuringRegistration(node)
    ) {
      throw new Error(
        `${relativePath} deletes global process or process.env while registering tests`,
      );
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      executesDuringRegistration(node)
    ) {
      if (
        ts.isObjectBindingPattern(node.name) &&
        expressionMayReadAccessor(node.initializer)
      ) {
        throw new Error(
          `${relativePath} destructures an untrusted accessor source while registering tests`,
        );
      }
      if (
        ts.isArrayBindingPattern(node.name) &&
        expressionMayInvokeIterator(node.initializer)
      ) {
        throw new Error(
          `${relativePath} destructures an untrusted iterable while registering tests`,
        );
      }
    }
    if (
      ts.isSpreadAssignment(node) &&
      executesDuringRegistration(node) &&
      expressionMayReadAccessor(node.expression)
    ) {
      throw new Error(
        `${relativePath} spreads an untrusted accessor source while registering tests`,
      );
    }
    if (
      ts.isSpreadElement(node) &&
      executesDuringRegistration(node) &&
      expressionMayInvokeIterator(node.expression)
    ) {
      throw new Error(
        `${relativePath} spreads an untrusted iterable while registering tests`,
      );
    }
    if (
      ts.isForOfStatement(node) &&
      executesDuringRegistration(node) &&
      expressionMayInvokeIterator(node.expression)
    ) {
      throw new Error(
        `${relativePath} iterates an untrusted value while registering tests`,
      );
    }
    if (ts.isTaggedTemplateExpression(node) && executesDuringRegistration(node)) {
      const tag = unwrapExpression(node.tag);
      const root = rootIdentifier(tag);
      const isSafeStringRaw = Boolean(
        root &&
          root.text === "String" &&
          ts.isPropertyAccessExpression(tag) &&
          tag.name.text === "raw" &&
          !importedModules.has(root.text) &&
          !localBindings.hasAt(root),
      );
      if (!isSafeStringRaw) {
        throw new Error(
          `${relativePath} uses an untrusted tagged template while registering tests: ${node.tag.getText(sourceFile)}`,
        );
      }
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      executesDuringRegistration(node)
    ) {
      if (expressionMayReadAccessor(node.expression)) {
        throw new Error(
          `${relativePath} reads an untrusted property while registering tests: ${node.getText(sourceFile)}; accessors are not executed or analyzed by topology`,
        );
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const root = rootIdentifier(node.expression);
      const importedModule = root ? importedModules.get(root.text) : undefined;
      const callArguments = node.arguments ?? [];
      const callPath = ts.isCallExpression(node)
        ? officialTestPath(node.expression, testBindings, localBindings)
        : null;
      const returnedApiPath = ts.isCallExpression(node)
        ? returnedTestApiPath(node.expression, testBindings, localBindings)
        : null;
      if (!callPath && !returnedApiPath && executesDuringRegistration(node)) {
        const hasCallableArgument = callArguments.some(
          (argument) =>
            argumentMayBeCallable(
              argument,
              callableBindings,
              localBindings,
              importedModules,
            ),
        );
        const hasAccessorArgument = callArguments.some(
          expressionMayReadAccessor,
        );
        const isNodeBuiltinCall = Boolean(
          root &&
            importedModule &&
            !localBindings.hasAt(root) &&
            NODE_BUILTIN_MODULES.has(importedModule),
        );
        const isSafeGlobalCall = Boolean(
          ts.isCallExpression(node) &&
          root &&
            !importedModule &&
            !localBindings.hasAt(root) &&
            SAFE_REGISTRATION_GLOBAL_CALL_ROOTS.has(root.text),
        );
        const isSafeGlobalConstructor = Boolean(
          ts.isNewExpression(node) &&
            root &&
            !importedModule &&
            !localBindings.hasAt(root) &&
            SAFE_REGISTRATION_GLOBAL_CONSTRUCTORS.has(root.text),
        );
        const mayInvokeCallback =
          ts.isCallExpression(node) && globalCallMayInvokeCallback(node);
        if (
          (importedModule && importedModule !== "@playwright/test" &&
            !isNodeBuiltinCall) ||
          hasCallableArgument ||
          hasAccessorArgument ||
          mayInvokeCallback ||
          (!isNodeBuiltinCall &&
            !isSafeGlobalCall &&
            !isSafeGlobalConstructor)
        ) {
          throw new Error(
            `${relativePath} uses an untrusted call while registering tests: ${node.expression.getText(sourceFile)}; topology does not execute or analyze cross-module/local registration helpers`,
          );
        }
      }
      const skipCondition = callArguments[0];
      if (
        ts.isCallExpression(node) &&
        callPath?.at(-1) === "skip" &&
        skipCondition
      ) {
        let referencesProjectName = false;
        let referencesDeviceProject = false;
        const visitSkipCondition = (conditionNode: ts.Node): void => {
          if (
            ts.isPropertyAccessExpression(conditionNode) &&
            conditionNode.name.text === "name" &&
            ts.isPropertyAccessExpression(conditionNode.expression) &&
            conditionNode.expression.name.text === "project"
          ) {
            referencesProjectName = true;
          }
          if (
            ts.isStringLiteralLike(conditionNode) &&
            (conditionNode.text === "desktop" || conditionNode.text === "mobile")
          ) {
            referencesDeviceProject = true;
          }
          ts.forEachChild(conditionNode, visitSkipCondition);
        };
        visitSkipCondition(skipCondition);
        usesDeviceProjectSkip ||=
          referencesProjectName && referencesDeviceProject;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { usesBrowserFixture, usesDeviceProjectSkip };
}

function parseProjectOption(
  args: string[],
  index: number,
): { nextIndex: number; patterns: string[] } | null {
  const argument = args[index] ?? "";
  if (argument.startsWith("--project=")) {
    const pattern = argument.slice("--project=".length);
    if (!pattern) {
      throw new Error("--project requires a non-empty project name");
    }
    return { nextIndex: index, patterns: [pattern] };
  }
  if (argument !== "--project") return null;
  const patterns: string[] = [];
  while (args[index + 1] && !args[index + 1]!.startsWith("-")) {
    index += 1;
    patterns.push(args[index]!);
  }
  if (patterns.length === 0) {
    throw new Error("--project requires at least one project name");
  }
  return { nextIndex: index, patterns };
}

export function playwrightProjectSelection(
  args: string[],
): PlaywrightProjectSelection {
  const patterns: string[] = [];
  let hasProjectOption = false;
  for (let index = 0; index < args.length; index += 1) {
    const projectOption = parseProjectOption(args, index);
    if (!projectOption) continue;
    hasProjectOption = true;
    patterns.push(...projectOption.patterns);
    index = projectOption.nextIndex;
  }
  return hasProjectOption ? patterns : null;
}

function wildcardPattern(pattern: string): RegExp {
  const escapedParts = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escapedParts.join(".*")}$`, "i");
}

export function selectedPlaywrightProjectNames(
  projectNames: string[],
  selection: PlaywrightProjectSelection,
): string[] {
  if (!selection) return [...projectNames];
  const exactNames = new Map<string, string>();
  const wildcardPatterns: RegExp[] = [];
  for (const requestedName of selection) {
    const lowerCaseName = requestedName.toLocaleLowerCase();
    if (lowerCaseName.includes("*")) {
      wildcardPatterns.push(wildcardPattern(lowerCaseName));
    } else {
      exactNames.set(lowerCaseName, requestedName);
    }
  }
  const matchedNames = projectNames.filter((projectName) => {
    const lowerCaseName = projectName.toLocaleLowerCase();
    if (exactNames.delete(lowerCaseName)) return true;
    return wildcardPatterns.some((pattern) => pattern.test(lowerCaseName));
  });
  if (exactNames.size > 0) {
    throw new Error(
      `Project(s) ${[...exactNames.values()].map((name) => `"${name}"`).join(", ")} not found. Available projects: ${projectNames.map((name) => `"${name}"`).join(", ")}`,
    );
  }
  if (matchedNames.length === 0) {
    throw new Error(
      `No projects matched. Available projects: ${projectNames.map((name) => `"${name}"`).join(", ")}`,
    );
  }
  return matchedNames;
}

export function playwrightTopologySelectionMode(
  args: string[],
): PlaywrightTopologySelectionMode {
  playwrightProjectSelection(args);
  let selectionMode: PlaywrightTopologySelectionMode = "full";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("-")) {
      selectionMode = "partial";
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unsupported Playwright option: ${argument}`);
    }
    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex === -1
      ? argument
      : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1
      ? undefined
      : argument.slice(equalsIndex + 1);

    if (FULL_BOOLEAN_OPTIONS.has(option)) {
      if (inlineValue === "") {
        throw new Error(
          `${option} requires a non-empty inline value when = is used`,
        );
      }
      continue;
    }
    const projectOption = parseProjectOption(args, index);
    if (projectOption) {
      index = projectOption.nextIndex;
      continue;
    }
    if (FULL_VALUE_OPTIONS.has(option) || PARTIAL_VALUE_OPTIONS.has(option)) {
      if (inlineValue === undefined) {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) {
          throw new Error(`${option} requires a value`);
        }
        index += 1;
      } else if (!inlineValue) {
        throw new Error(`${option} requires a non-empty value`);
      }
      if (PARTIAL_VALUE_OPTIONS.has(option)) selectionMode = "partial";
      continue;
    }
    if (PARTIAL_BOOLEAN_OPTIONS.has(option)) {
      if (inlineValue === "") {
        throw new Error(
          `${option} requires a non-empty inline value when = is used`,
        );
      }
      selectionMode = "partial";
      continue;
    }
    if (PARTIAL_OPTIONAL_VALUE_OPTIONS.has(option)) {
      if (inlineValue === undefined) {
        const optionalValue = args[index + 1];
        if (optionalValue && !optionalValue.startsWith("-")) index += 1;
      } else if (!inlineValue) {
        throw new Error(
          `${option} requires a non-empty inline value when = is used`,
        );
      }
      selectionMode = "partial";
      continue;
    }
    throw new Error(`Unsupported Playwright option: ${option}`);
  }
  return selectionMode;
}

export function discoverPlaywrightTestTopology(
  repositoryRoot = process.cwd(),
): PlaywrightTestTopology {
  const testRoot = path.join(repositoryRoot, "tests");
  const topology: PlaywrightTestTopology = { nodeDb: [], ui: [] };

  for (const absolutePath of walkSpecFiles(testRoot, testRoot)) {
    const relativePath = path
      .relative(testRoot, absolutePath)
      .split(path.sep)
      .join("/");
    const source = fs.readFileSync(absolutePath, "utf8");
    const kind = declaredKind(source, relativePath);
    const analysis = analyzeSpec(source, relativePath);
    if (kind === "ui" && !analysis.usesBrowserFixture) {
      throw new Error(`${relativePath} declares ui but uses no browser fixture`);
    }
    if (kind === "node-db" && analysis.usesBrowserFixture) {
      throw new Error(
        `${relativePath} declares node-db but uses a browser fixture`,
      );
    }
    if (kind === "node-db" && analysis.usesDeviceProjectSkip) {
      throw new Error(
        `${relativePath} declares node-db but skips a desktop or mobile project`,
      );
    }
    topology[kind === "ui" ? "ui" : "nodeDb"].push(relativePath);
  }

  if (topology.nodeDb.length === 0 || topology.ui.length === 0) {
    throw new Error("Playwright topology must contain both ui and node-db specs");
  }
  return topology;
}
