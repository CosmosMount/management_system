// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

test("material migrations preserve existing records and paired identity without schema drift", async () => {
  test.setTimeout(300_000);
  const source = new URL(process.env.DATABASE_URL ?? "");
  if (!process.env.PLAYWRIGHT_DB_OWNERSHIP_TOKEN ||
    !["localhost", "127.0.0.1", "[::1]"].includes(source.hostname) ||
    !/^[A-Za-z0-9_]+_test$/.test(source.pathname.slice(1)) || /prod(?:uction)?/i.test(source.pathname)) {
    throw new Error("物资迁移测试仅允许官方 runner 的本机隔离数据库环境");
  }
  const suffix = randomUUID().replaceAll("-", "");
  const targetUrl = new URL(source);
  targetUrl.pathname = `/material_delete_${suffix}_test`;
  const shadowUrl = new URL(source);
  shadowUrl.pathname = `/material_delete_${suffix}_shadow_test`;
  const adminUrl = new URL(source);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  const created: string[] = [];
  let target: Client | undefined;
  let directory: string | undefined;
  await admin.connect();

  function run(command: string, args: string[]) {
    const result = spawnSync(command, args, {
      cwd: process.cwd(), encoding: "utf8", timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: targetUrl.toString(), SHADOW_DATABASE_URL: shadowUrl.toString(), NOTIFICATION_DELIVERY_DISABLED: "true", DB_WAIT_MS: "10000" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
  }

  try {
    for (const database of [targetUrl, shadowUrl]) {
      const name = database.pathname.slice(1);
      if (!/^material_delete_[a-f0-9]{32}(?:_shadow)?_test$/.test(name)) throw new Error("非法迁移测试库名称");
      await admin.query(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true });
    directory = await mkdtemp(path.join(process.cwd(), ".tmp/material-delete-migration-"));
    const migrations = path.join(directory, "migrations");
    await mkdir(migrations);
    const sourceMigrations = path.join(process.cwd(), "prisma/migrations");
    for (const entry of await readdir(sourceMigrations, { withFileTypes: true })) {
      if (entry.name === "migration_lock.toml" || (entry.isDirectory() && entry.name < "20260913220000_add_material_soft_delete")) {
        await cp(path.join(sourceMigrations, entry.name), path.join(migrations, entry.name), { recursive: true });
      }
    }
    const config = path.join(directory, "prisma.config.ts");
    await writeFile(config, `import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: ${JSON.stringify(path.join(process.cwd(), "prisma/schema.prisma"))}, migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.DATABASE_URL, shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } });\n`);
    run("npx", ["prisma", "migrate", "deploy", "--config", config]);
    target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();
    const accountId = randomUUID();
    const materialId = randomUUID();
    const loanId = randomUUID();
    const qrToken = randomUUID();
    const registrationKey = randomUUID();
    await target.query('INSERT INTO "Account" (id, "updatedAt") VALUES ($1, NOW())', [accountId]);
    await target.query(`INSERT INTO "Material" (id, "qrToken", "registrationKey", name, price, "techGroup", "createdByAccountId", "updatedAt")
      VALUES ($1, $2, $3, '迁移前物资', 12.50, '硬件', $4, NOW())`, [materialId, qrToken, registrationKey, accountId]);
    await target.query(`INSERT INTO "MaterialLoan" (id, "materialId", "borrowerAccountId", "checkoutIdempotencyKey")
      VALUES ($1, $2, $3, $4)`, [loanId, materialId, accountId, randomUUID()]);
    await target.query(`INSERT INTO "DomainAuditEvent" (id, "actorAccountId", action, "entityType", "entityId")
      VALUES ($1, $2, 'material.registered', 'Material', $3)`, [randomUUID(), accountId, materialId]);
    const beforeMaterial = (await target.query('SELECT * FROM "Material" WHERE id=$1', [materialId])).rows[0];
    const beforeLoan = (await target.query('SELECT * FROM "MaterialLoan" WHERE id=$1', [loanId])).rows;
    const beforeAudit = (await target.query('SELECT * FROM "DomainAuditEvent" WHERE "entityId"=$1', [materialId])).rows;
    run("npm", ["run", "db:deploy"]);
    run("npm", ["run", "db:deploy"]);
    expect((await target.query('SELECT * FROM "Material" WHERE id=$1', [materialId])).rows).toEqual([{ ...beforeMaterial, deletedAt: null, pairKey: null }]);
    const pairedMaterialId = randomUUID();
    const pairKey = randomUUID();
    await target.query(`INSERT INTO "Material" (
      id, "qrToken", "registrationKey", name, price, "techGroup",
      "createdByAccountId", "pairKey", "updatedAt"
    ) VALUES ($1, $2, $3, '迁移后配套物资', 3.00, '硬件', $4, $5, NOW())`, [
      pairedMaterialId,
      randomUUID(),
      randomUUID(),
      accountId,
      pairKey,
    ]);
    await expect(
      target.query('UPDATE "Material" SET "pairKey"=$1 WHERE id=$2', [randomUUID(), pairedMaterialId]),
    ).rejects.toThrow(/Material identity is immutable/);
    expect((await target.query('SELECT "pairKey" FROM "Material" WHERE id=$1', [pairedMaterialId])).rows)
      .toEqual([{ pairKey }]);
    expect((await target.query('SELECT * FROM "MaterialLoan" WHERE id=$1', [loanId])).rows).toEqual(beforeLoan);
    expect((await target.query('SELECT * FROM "DomainAuditEvent" WHERE "entityId"=$1', [materialId])).rows).toEqual(beforeAudit);
    expect((await target.query('SELECT COUNT(*)::int AS count FROM "NotificationOutbox"')).rows).toEqual([{ count: 0 }]);
    run("npx", ["prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"]);
    run("npx", ["prisma", "migrate", "diff", "--from-migrations", "prisma/migrations", "--to-schema", "prisma/schema.prisma", "--exit-code"]);
  } finally {
    const failures: unknown[] = [];
    if (target) await target.end().catch((error: unknown) => failures.push(error));
    for (const name of created.reverse()) {
      try {
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()", [name]);
        await admin.query(`DROP DATABASE "${name}"`);
      } catch (error) { failures.push(error); }
    }
    if (directory) await rm(directory, { recursive: true, force: true }).catch((error: unknown) => failures.push(error));
    await admin.end().catch((error: unknown) => failures.push(error));
    if (failures.length) throw new AggregateError(failures, "物资迁移测试隔离资源清理失败");
  }
});
