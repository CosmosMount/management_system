import { builtinModules } from "node:module";
import ts from "typescript";

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
export const NODE_BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

export type TestImports = {
  importedModules: Map<string, string>;
  testBindings: Set<string>;
};

export function testImports(
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
    if (importClause?.name)
      importedModules.set(importClause.name.text, moduleName);
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

export function unwrapExpression(expression: ts.Expression): ts.Expression {
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

export function rootIdentifier(
  expression: ts.Expression,
): ts.Identifier | null {
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

export type LocalValueBindings = {
  hasAt(identifier: ts.Identifier): boolean;
};

export function officialTestPath(
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

export function callPathKey(callPath: string[]): string {
  return callPath.join(".");
}

export function isSupportedExpectCallPath(callPath: string[]): boolean {
  if (callPath[0] !== "expect") return false;
  const suffix = callPath.slice(1);
  while (suffix[0] === "soft") suffix.shift();
  return EXPECT_CALL_SUFFIXES.has(suffix.join("."));
}

export function isTestApiReturnValuePath(callPath: string[]): boolean {
  return (
    isSupportedExpectCallPath(callPath) ||
    TEST_API_RETURN_VALUE_PATHS.has(callPathKey(callPath))
  );
}

export function returnedTestApiPath(
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

export function localValueBindings(
  sourceFile: ts.SourceFile,
): LocalValueBindings {
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

export function localCallableBindings(
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
  const recordBinding = (
    name: ts.BindingName,
    initializer: ts.Expression,
  ): void => {
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
      if (
        !root ||
        !callableBindings.has(root.text) ||
        callableBindings.has(name)
      ) {
        continue;
      }
      callableBindings.add(name);
      changed = true;
    }
  }
  return callableBindings;
}

export function containsAccessorDeclaration(node: ts.Node): boolean {
  if (ts.isGetAccessorDeclaration(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsAccessorDeclaration(child)) found = true;
  });
  return found;
}

export function localAccessorBindings(sourceFile: ts.SourceFile): Set<string> {
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
          aliases.push({
            initializer: initializer.expression,
            name: node.name.text,
          });
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

export function containsCustomIterator(node: ts.Node): boolean {
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

export function localIterableBindings(sourceFile: ts.SourceFile): Set<string> {
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
          aliases.push({
            initializer: initializer.expression,
            name: node.name.text,
          });
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

export function argumentMayBeCallable(
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
