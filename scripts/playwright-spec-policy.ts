import ts from "typescript";
import {
  argumentMayBeCallable,
  callPathKey,
  containsAccessorDeclaration,
  containsCustomIterator,
  isSupportedExpectCallPath,
  localAccessorBindings,
  localCallableBindings,
  localIterableBindings,
  localValueBindings,
  NODE_BUILTIN_MODULES,
  officialTestPath,
  returnedTestApiPath,
  rootIdentifier,
  testImports,
  unwrapExpression,
  type LocalValueBindings,
} from "./playwright-spec-binding-facts";

export type PlaywrightSpecAnalysis = {
  usesBrowserFixture: boolean;
  usesDeviceProjectSkip: boolean;
};

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

function inlineCallback(
  argument: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | null {
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
  const isHook = callPath.length === 1 && HOOK_CALLBACKS.has(callPath[0]!);

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

export function analyzePlaywrightSpec(
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
      if (root && testBindings.has(root.text) && !localBindings.hasAt(root)) {
        const callPath = officialTestPath(
          node.expression,
          testBindings,
          localBindings,
        );
        if (!callPath) {
          if (
            !returnedTestApiPath(node.expression, testBindings, localBindings)
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
            const callbacks =
              registration.kind === "suite"
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
    const importedModule = root ? importedModules.get(root.text) : undefined;
    return Boolean(
      (root && localBindings.hasAt(root) && accessorBindings.has(root.text)) ||
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
    const importedModule = root ? importedModules.get(root.text) : undefined;
    return Boolean(
      (root && localBindings.hasAt(root) && iterableBindings.has(root.text)) ||
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
    if (
      ts.isTaggedTemplateExpression(node) &&
      executesDuringRegistration(node)
    ) {
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
        const hasCallableArgument = callArguments.some((argument) =>
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
          (importedModule &&
            importedModule !== "@playwright/test" &&
            !isNodeBuiltinCall) ||
          hasCallableArgument ||
          hasAccessorArgument ||
          mayInvokeCallback ||
          (!isNodeBuiltinCall && !isSafeGlobalCall && !isSafeGlobalConstructor)
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
            conditionNode.text === "desktop"
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
