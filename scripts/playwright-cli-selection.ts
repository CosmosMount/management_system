export const PLAYWRIGHT_PROJECT_NAMES = [
  "node-db",
  "desktop",
  "mobile",
] as const;

export type PlaywrightTopologySelectionMode = "full" | "partial";
export type PlaywrightProjectSelection = string[] | null;

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
    const option =
      equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);

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
