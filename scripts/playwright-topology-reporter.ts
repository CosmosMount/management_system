import path from "node:path";
import type {
  FullConfig,
  Reporter,
  Suite,
} from "@playwright/test/reporter";
import {
  discoverPlaywrightTestTopology,
  PLAYWRIGHT_PROJECT_NAMES,
  playwrightProjectSelection,
  selectedPlaywrightProjectNames,
  type PlaywrightTopologySelectionMode,
} from "./playwright-test-topology";

const projectsForKind = {
  "node-db": new Set(["node-db"]),
  ui: new Set(["desktop"]),
} as const;

class PlaywrightTopologyReporter implements Reporter {
  private readonly repositoryRoot: string;
  private readonly selectionMode: PlaywrightTopologySelectionMode;
  private validationError: Error | null = null;

  constructor(
    options: {
      repositoryRoot?: string;
      selectionMode?: PlaywrightTopologySelectionMode;
    } = {},
  ) {
    this.repositoryRoot = options.repositoryRoot ?? process.cwd();
    this.selectionMode = options.selectionMode ?? "full";
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.validationError = null;
    try {
      this.validateCollection(config, suite);
    } catch (error) {
      this.validationError =
        error instanceof Error ? error : new Error(String(error));
      // Reporter exceptions are swallowed by Playwright. Marking the entire
      // collected suite skipped prevents any test body from running before
      // onEnd converts the overall result to failed.
      for (const testCase of suite.allTests()) {
        testCase.expectedStatus = "skipped";
      }
      process.stderr.write(
        `Playwright topology validation failed: ${this.validationError.message}\n`,
      );
    }
  }

  async onEnd(): Promise<{ status: "failed" } | void> {
    if (this.validationError) return { status: "failed" };
  }

  private validateCollection(config: FullConfig, suite: Suite): void {
    const repositoryRoot = this.repositoryRoot;
    const topology = discoverPlaywrightTestTopology(repositoryRoot);
    const kindByFile = new Map([
      ...topology.nodeDb.map((file) => [file, "node-db"] as const),
      ...topology.ui.map((file) => [file, "ui"] as const),
    ]);
    const selectedProjects = new Set(
      selectedPlaywrightProjectNames(
        config.projects.map((project) => project.name),
        playwrightProjectSelection(process.argv.slice(2)),
      ),
    );
    for (const project of selectedProjects) {
      if (!(PLAYWRIGHT_PROJECT_NAMES as readonly string[]).includes(project)) {
        throw new Error(`Unexpected Playwright project: ${project}`);
      }
    }

    const projectsByFile = new Map<string, Set<string>>();
    const testCountByProject = new Map<string, number>();
    for (const testCase of suite.allTests()) {
      const relativePath = path
        .relative(path.join(repositoryRoot, "tests"), testCase.location.file)
        .split(path.sep)
        .join("/");
      const kind = kindByFile.get(relativePath);
      if (!kind) {
        throw new Error(`Playwright collected an unclassified test: ${relativePath}`);
      }
      const project = testCase.parent.project()?.name;
      if (
        !project ||
        !selectedProjects.has(project) ||
        !projectsForKind[kind].has(project)
      ) {
        throw new Error(
          `${relativePath} (${kind}) was collected by ${project ?? "no project"}`,
        );
      }
      const fileProjects = projectsByFile.get(relativePath) ?? new Set<string>();
      fileProjects.add(project);
      projectsByFile.set(relativePath, fileProjects);
      testCountByProject.set(project, (testCountByProject.get(project) ?? 0) + 1);
    }

    if (this.selectionMode === "full") {
      for (const [file, kind] of kindByFile) {
        const actualProjects = projectsByFile.get(file) ?? new Set<string>();
        const expectedProjects = new Set(
          [...projectsForKind[kind]].filter((project) =>
            selectedProjects.has(project),
          ),
        );
        if (
          actualProjects.size !== expectedProjects.size ||
          [...actualProjects].some((project) => !expectedProjects.has(project))
        ) {
          throw new Error(
            `${file} expected projects ${[...expectedProjects].join(", ")} but collected ${[...actualProjects].join(", ")}`,
          );
        }
      }
    }

    if (
      selectedProjects.size === PLAYWRIGHT_PROJECT_NAMES.length &&
      PLAYWRIGHT_PROJECT_NAMES.every((project) =>
        selectedProjects.has(project),
      )
    ) {
      const summary = PLAYWRIGHT_PROJECT_NAMES.map(
        (project) => `${project}=${testCountByProject.get(project) ?? 0}`,
      ).join(" ");
      process.stdout.write(
        `Playwright topology: ${topology.nodeDb.length} node-db specs; ${topology.ui.length} UI specs; ${summary}\n`,
      );
    }
  }
}

export default PlaywrightTopologyReporter;
