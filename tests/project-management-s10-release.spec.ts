import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { prisma } from "../lib/prisma";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";

type RehearsalReport = {
  cleanup: {
    rehearsalDatabasesRemoved: boolean;
    temporaryFilesRemoved: boolean;
  };
  databaseRestore: {
    source: { stableHash: string };
    restored: { stableHash: string };
    verified: boolean;
  };
  identityBackfill: {
    apply: { conflicts: unknown[] };
    dryRun: { conflicts: unknown[] };
    repeatedApply: { conflicts: unknown[]; created: number };
    verifiedIdempotent: boolean;
  };
  migration: {
    appliedMigrationCount: number;
    appliedMigrations: string[];
    beforeMigrationCount: number;
    expectedMigrationsApplied: boolean;
    protectedTablesAfter: Record<
      string,
      { rowCount: number; stableHash: string }
    >;
    protectedTablesBefore: Record<
      string,
      { rowCount: number; stableHash: string }
    > | null;
    sharedDataUnchanged: boolean;
  };
  rehearsalId: string;
  safety: {
    forbiddenLegacyColumns: unknown[];
    legacyEnumCount: number;
    legacyTableCount: number;
    notificationDeliveryDisabled: true;
    progressOutboxRows: number;
    projectManagerRoleRows: number;
  };
  scenario: "empty" | "shared_snapshot";
  uploadRestore: {
    backup: { bytes: number; files: number; stableHash: string };
    restored: { bytes: number; files: number; stableHash: string };
    source: { bytes: number; files: number; stableHash: string };
    verified: boolean;
  };
};

function runRehearsal(
  scenario: "empty" | "shared_snapshot",
  uploadSourceDirectory: string,
): RehearsalReport {
  const result = spawnSync(
    path.join(process.cwd(), "node_modules", ".bin", "tsx"),
    ["scripts/project-management-release-rehearsal.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CHECKPOINT_DISABLE: "1",
        NOTIFICATION_DELIVERY_DISABLED: "true",
        PM_RELEASE_REHEARSAL_CONFIRM: "LOCAL_ISOLATED_REHEARSAL",
        PM_RELEASE_REHEARSAL_SCENARIO: scenario,
        PM_RELEASE_REHEARSAL_UPLOAD_SOURCE_DIR: uploadSourceDirectory,
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 240_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `release rehearsal failed: ${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(-8_000)}`,
    );
  }
  return JSON.parse(result.stdout) as RehearsalReport;
}

async function expectRehearsalDatabasesRemoved(
  report: RehearsalReport,
): Promise<void> {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL is required");
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const names = [
      `pmrel_${report.rehearsalId}_working_test`,
      `pmrel_${report.rehearsalId}_restored_test`,
    ];
    const result = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
      [names],
    );
    expect(result.rows).toEqual([]);
  } finally {
    await client.end();
  }
}

function expectSuccessfulReport(report: RehearsalReport): void {
  expect(report.migration.appliedMigrationCount).toBeGreaterThan(0);
  expect(report.migration.expectedMigrationsApplied).toBe(true);
  expect(report.migration.appliedMigrations).toContain(
    "20260731102000_project_management_scan_checkpoint",
  );
  if (report.scenario === "shared_snapshot") {
    expect(report.migration.appliedMigrations).toEqual([
      "20260731102000_project_management_scan_checkpoint",
    ]);
    expect(report.migration.appliedMigrationCount).toBe(1);
    expect(report.migration.beforeMigrationCount).toBeGreaterThan(0);
  }
  expect(report.migration.sharedDataUnchanged).toBe(true);
  expect(report.identityBackfill.dryRun.conflicts).toEqual([]);
  expect(report.identityBackfill.apply.conflicts).toEqual([]);
  expect(report.identityBackfill.repeatedApply.conflicts).toEqual([]);
  expect(report.identityBackfill.repeatedApply.created).toBe(0);
  expect(report.identityBackfill.verifiedIdempotent).toBe(true);
  expect(report.databaseRestore.verified).toBe(true);
  expect(report.databaseRestore.restored.stableHash).toBe(
    report.databaseRestore.source.stableHash,
  );
  expect(report.uploadRestore.verified).toBe(true);
  expect(report.uploadRestore.backup).toEqual(report.uploadRestore.source);
  expect(report.uploadRestore.restored).toEqual(report.uploadRestore.source);
  expect(report.safety).toMatchObject({
    forbiddenLegacyColumns: [],
    legacyEnumCount: 0,
    legacyTableCount: 0,
    notificationDeliveryDisabled: true,
    progressOutboxRows: 0,
    projectManagerRoleRows: 0,
  });
  expect(report.cleanup).toEqual({
    rehearsalDatabasesRemoved: true,
    temporaryFilesRemoved: true,
  });
}

test.describe("S10 release readiness", () => {
  test("release tooling fails closed before opening a database", async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "operational safety runs once");
    const result = spawnSync(
      path.join(process.cwd(), "node_modules", ".bin", "tsx"),
      ["scripts/project-management-release-rehearsal.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NOTIFICATION_DELIVERY_DISABLED: "true",
          PM_RELEASE_REHEARSAL_CONFIRM: "WRONG_CONFIRMATION",
          PM_RELEASE_REHEARSAL_SCENARIO: "empty",
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "PM_RELEASE_REHEARSAL_CONFIRM must equal LOCAL_ISOLATED_REHEARSAL",
    );
  });

  test("empty schema, two shared snapshot releases, database and upload restore all reconcile", async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "release rehearsal runs once");
    test.setTimeout(600_000);
    const uploadSource = await mkdtemp(path.join(os.tmpdir(), "pm-uat-upload-"));
    const openId = `ou_release_${randomUUID()}`;
    await mkdir(path.join(uploadSource, "nested"), { recursive: true });
    await writeFile(path.join(uploadSource, "proof.txt"), "release-proof\n");
    await writeFile(
      path.join(uploadSource, "nested", "附件.bin"),
      Buffer.from([0, 1, 2, 3, 255]),
    );
    await resolveFeishuIdentityForUser({
      name: "发布演练共享用户",
      openId,
      unionId: `on_release_${randomUUID()}`,
    });

    try {
      const emptyReport = runRehearsal("empty", uploadSource);
      expect(emptyReport.scenario).toBe("empty");
      expect(emptyReport.migration.protectedTablesBefore).toBeNull();
      expectSuccessfulReport(emptyReport);
      await expectRehearsalDatabasesRemoved(emptyReport);

      const first = runRehearsal("shared_snapshot", uploadSource);
      const second = runRehearsal("shared_snapshot", uploadSource);
      for (const report of [first, second]) {
        expect(report.scenario).toBe("shared_snapshot");
        expect(report.migration.protectedTablesBefore).not.toBeNull();
        expect(report.migration.protectedTablesAfter).toEqual(
          report.migration.protectedTablesBefore,
        );
        expect(report.uploadRestore.source).toMatchObject({
          bytes: 19,
          files: 2,
        });
        expectSuccessfulReport(report);
        await expectRehearsalDatabasesRemoved(report);
      }
      expect(first.rehearsalId).not.toBe(second.rehearsalId);
    } finally {
      await prisma.user.deleteMany({ where: { openId } });
      await rm(uploadSource, { force: true, recursive: true });
    }
  });

  test("static release gate excludes legacy contracts and direct sends from domain code", async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "static release gate runs once");
    const schema = await readFile(
      path.join(process.cwd(), "prisma", "schema.prisma"),
      "utf8",
    );
    expect(schema).not.toMatch(/legacySource|migrationNeedsReview/);
    expect(schema).not.toMatch(
      /model\s+(?:Project|ProjectStage|ProjectCreationRequest|TaskCreationRequest)\b/,
    );

    const roots = [
      path.join(process.cwd(), "app", "actions", "project-management"),
      path.join(process.cwd(), "lib", "project-management"),
    ];
    const pending = [...roots];
    const sourceFiles: string[] = [];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) continue;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(target);
        else if (/\.(?:ts|tsx)$/.test(entry.name)) sourceFiles.push(target);
      }
    }
    for (const file of sourceFiles) {
      expect(await readFile(file, "utf8"), file).not.toContain(
        "sendFeishuDirectMessage",
      );
    }
  });
});
