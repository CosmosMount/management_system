// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const MIGRATION = "20260916130000_add_purchase_item_reference_images";

test("加工件多图迁移回填旧图片且与 Prisma schema 无漂移", async () => {
  test.setTimeout(300_000);
  const source = new URL(process.env.DATABASE_URL ?? "");
  if (
    !process.env.PLAYWRIGHT_DB_OWNERSHIP_TOKEN ||
    !["localhost", "127.0.0.1", "[::1]"].includes(source.hostname) ||
    !/^[A-Za-z0-9_]+_test$/.test(source.pathname.slice(1)) ||
    /prod(?:uction)?/i.test(source.pathname)
  ) {
    throw new Error("加工件多图迁移测试仅允许官方 runner 的本机隔离数据库环境");
  }

  const suffix = randomUUID().replaceAll("-", "");
  const targetUrl = new URL(source);
  targetUrl.pathname = `/procurement_images_${suffix}_test`;
  const shadowUrl = new URL(source);
  shadowUrl.pathname = `/procurement_images_${suffix}_shadow_test`;
  const adminUrl = new URL(source);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  const createdDatabases: string[] = [];
  let target: Client | undefined;
  let directory: string | undefined;
  await admin.connect();

  function run(command: string, args: string[]) {
    const result = spawnSync(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        DATABASE_URL: targetUrl.toString(),
        SHADOW_DATABASE_URL: shadowUrl.toString(),
        NOTIFICATION_DELIVERY_DISABLED: "true",
        DB_WAIT_MS: "10000",
      },
    });
    expect(result.error).toBeUndefined();
    expect(
      result.status,
      `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
    ).toBe(0);
  }

  try {
    for (const databaseUrl of [targetUrl, shadowUrl]) {
      const databaseName = databaseUrl.pathname.slice(1);
      if (
        !/^procurement_images_[a-f0-9]{32}(?:_shadow)?_test$/.test(
          databaseName,
        )
      ) {
        throw new Error("非法加工件多图迁移测试库名称");
      }
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      createdDatabases.push(databaseName);
    }

    await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true });
    directory = await mkdtemp(
      path.join(process.cwd(), ".tmp/procurement-images-migration-"),
    );
    const migrations = path.join(directory, "migrations");
    await mkdir(migrations);
    const sourceMigrations = path.join(process.cwd(), "prisma/migrations");
    for (const entry of await readdir(sourceMigrations, { withFileTypes: true })) {
      if (
        entry.name === "migration_lock.toml" ||
        (entry.isDirectory() && entry.name < MIGRATION)
      ) {
        await cp(
          path.join(sourceMigrations, entry.name),
          path.join(migrations, entry.name),
          { recursive: true },
        );
      }
    }
    const config = path.join(directory, "prisma.config.ts");
    await writeFile(
      config,
      `import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: ${JSON.stringify(
        path.join(process.cwd(), "prisma/schema.prisma"),
      )}, migrations: { path: ${JSON.stringify(
        migrations,
      )} }, datasource: { url: process.env.DATABASE_URL, shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } });\n`,
    );
    run("npx", ["prisma", "migrate", "deploy", "--config", config]);

    target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();
    const accountId = randomUUID();
    const userId = randomUUID();
    const orderId = randomUUID();
    const itemId = randomUUID();
    const legacyPath = `/uploads/${orderId}/legacy.png`;
    await target.query(
      'INSERT INTO "Account" (id, "updatedAt") VALUES ($1, NOW())',
      [accountId],
    );
    await target.query(
      'INSERT INTO "User" (id, "accountId", "openId", name) VALUES ($1, $2, $3, $4)',
      [userId, accountId, `ou_${suffix}`, "迁移前采购人"],
    );
    await target.query(
      `INSERT INTO "PurchaseOrder" (
        id, "orderNo", "initiatorId", "initiatorName", team, "techGroup", "updatedAt"
      ) VALUES ($1, $2, $3, $4, '英雄', '机械', NOW())`,
      [orderId, `MIG-${suffix}`, userId, "迁移前采购人"],
    );
    await target.query(
      `INSERT INTO "PurchaseItem" (
        id, "orderId", name, spec, "itemKind", "referenceImagePath", "processingVendor", quantity, "unitPrice"
      ) VALUES ($1, $2, '迁移前加工件', 'A-01', 'PROCESSING_FEE', $3, '迁移加工商', 1, 10)`,
      [itemId, orderId, legacyPath],
    );

    run("npm", ["run", "db:deploy"]);
    run("npm", ["run", "db:deploy"]);
    expect(
      (
        await target.query(
          'SELECT "referenceImagePath", "referenceImagePaths"::jsonb AS paths FROM "PurchaseItem" WHERE id=$1',
          [itemId],
        )
      ).rows,
    ).toEqual([{ referenceImagePath: legacyPath, paths: [legacyPath] }]);

    run("npx", [
      "prisma",
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      "prisma/schema.prisma",
      "--exit-code",
    ]);
    run("npx", [
      "prisma",
      "migrate",
      "diff",
      "--from-migrations",
      "prisma/migrations",
      "--to-schema",
      "prisma/schema.prisma",
      "--exit-code",
    ]);
  } finally {
    const failures: unknown[] = [];
    if (target) await target.end().catch((error: unknown) => failures.push(error));
    for (const databaseName of createdDatabases.reverse()) {
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()",
          [databaseName],
        );
        await admin.query(`DROP DATABASE "${databaseName}"`);
      } catch (error) {
        failures.push(error);
      }
    }
    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch(
        (error: unknown) => failures.push(error),
      );
    }
    await admin.end().catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
      throw new AggregateError(failures, "加工件多图迁移测试隔离资源清理失败");
    }
  }
});
