// @playwright-project node-db
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { canViewFileAsset } from "../lib/file-asset-permissions";
import { saveMaterialReturnPhoto } from "../lib/file-upload";
import {
  createMaterial,
  deleteMaterial,
  preflightMaterialReturn,
  scanMaterial,
} from "../lib/material-management/service";
import {
  ProjectManagementServiceError,
} from "../lib/project-management/application/errors";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import { getMaterialByQrToken, getMaterialDetail, listMaterials } from "../lib/material-management/queries";

test.describe("material management concurrency and audit safety", () => {
  test("paired materials with matching sequence check out and return together atomically", async () => {
    const owner = await createActor("配套物资登记人");
    const borrower = await createActor("配套物资领用人");
    const other = await createActor("配套物资其他用户");
    const registrationKey = randomUUID();
    const input = {
      name: "无线麦克",
      quantity: 2,
      price: "120.00",
      techGroup: "硬件",
      paired: true,
      companionName: "接收器",
      companionPrice: "30.00",
      companionTechGroup: "电控",
      idempotencyKey: registrationKey,
    };
    const result = await createMaterial(owner.actor, input);
    await expect(createMaterial(owner.actor, input)).resolves.toEqual(result);

    const materials = await prisma.material.findMany({
      where: { createdByAccountId: owner.actor.accountId },
      orderBy: { name: "asc" },
    });
    expect(materials.map((item) => item.name)).toEqual(
      ["无线麦克-1", "无线麦克-2", "接收器-1", "接收器-2"].sort(),
    );
    const pairGroups = new Map<string, typeof materials>();
    for (const material of materials) {
      expect(material.pairKey).not.toBeNull();
      const pairKey = material.pairKey!;
      pairGroups.set(pairKey, [...(pairGroups.get(pairKey) ?? []), material]);
    }
    expect(pairGroups.size).toBe(2);
    for (const pair of pairGroups.values()) {
      expect(pair).toHaveLength(2);
      const suffixes = pair.map((item) => item.name.split("-").at(-1));
      expect(new Set(suffixes).size).toBe(1);
      const audits = await prisma.domainAuditEvent.findMany({
        where: {
          entityId: { in: pair.map((item) => item.id) },
          action: "material.registered",
        },
        select: { entityId: true, after: true },
      });
      expect(audits).toHaveLength(2);
      for (const audit of audits) {
        const pairedMaterial = pair.find((item) => item.id !== audit.entityId)!;
        expect(audit.after).toMatchObject({
          pairKey: pair[0].pairKey,
          pairedMaterialId: pairedMaterial.id,
        });
      }
    }

    const firstPair = [...pairGroups.values()].find((pair) =>
      pair.some((item) => item.name === "无线麦克-1"),
    );
    if (!firstPair) throw new Error("缺少第一套配套物资");
    const scanned = firstPair.find((item) => item.name === "无线麦克-1")!;
    const companion = firstPair.find((item) => item.id !== scanned.id)!;
    const checkoutInput = {
      qrToken: scanned.qrToken,
      operation: "CHECKOUT" as const,
      expectedActiveLoanId: null,
      idempotencyKey: randomUUID(),
    };
    const checkout = await scanMaterial(borrower.actor, checkoutInput);
    expect(checkout.relatedMaterialIds.sort()).toEqual(firstPair.map((item) => item.id).sort());
    expect(checkout.materialName).toContain("无线麦克-1");
    expect(checkout.materialName).toContain("接收器-1");
    const activeLoans = await prisma.materialLoan.findMany({
      where: { materialId: { in: firstPair.map((item) => item.id) }, returnedAt: null },
      orderBy: { materialId: "asc" },
    });
    expect(activeLoans).toHaveLength(2);
    expect(new Set(activeLoans.map((loan) => loan.borrowerAccountId))).toEqual(
      new Set([borrower.actor.accountId]),
    );
    expect(new Set(activeLoans.map((loan) => loan.checkedOutAt.toISOString())).size).toBe(1);
    await expect(scanMaterial(other.actor, {
      qrToken: companion.qrToken,
      operation: "CHECKOUT",
      expectedActiveLoanId: null,
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "STATE_CONFLICT" });

    const scannedLoan = activeLoans.find((loan) => loan.materialId === scanned.id)!;
    const returnInput = {
      qrToken: scanned.qrToken,
      operation: "RETURN" as const,
      expectedActiveLoanId: scannedLoan.id,
      idempotencyKey: randomUUID(),
    };
    const preflight = await preflightMaterialReturn(borrower.actor, returnInput);
    const concurrentPreflight = await preflightMaterialReturn(borrower.actor, returnInput);
    expect(preflight.kind).toBe("READY");
    if (preflight.kind !== "READY") throw new Error("配套归还预检未就绪");
    expect(concurrentPreflight.kind).toBe("READY");
    if (concurrentPreflight.kind !== "READY") throw new Error("并发配套归还预检未就绪");
    expect(preflight.loanIds.sort()).toEqual(activeLoans.map((loan) => loan.id).sort());
    const uploads = [];
    const concurrentUploads = [];
    for (const loanId of preflight.loanIds) {
      const saved = await saveMaterialReturnPhoto(
        loanId,
        borrower.actor.openId,
        new File([new Uint8Array(validPngBuffer())], "paired-return.png", { type: "image/png" }),
      );
      uploads.push({ loanId, returnPhotoPath: saved.publicPath, writeGeneration: saved.writeGeneration });
      const concurrentSaved = await saveMaterialReturnPhoto(
        loanId,
        borrower.actor.openId,
        new File([new Uint8Array(validPngBuffer())], "concurrent-paired-return.png", { type: "image/png" }),
      );
      concurrentUploads.push({
        loanId,
        returnPhotoPath: concurrentSaved.publicPath,
        writeGeneration: concurrentSaved.writeGeneration,
      });
    }
    await scanMaterial(borrower.actor, returnInput, uploads);
    await scanMaterial(borrower.actor, returnInput, concurrentUploads);
    const returnedLoans = await prisma.materialLoan.findMany({
      where: { id: { in: activeLoans.map((loan) => loan.id) } },
    });
    expect(returnedLoans.every((loan) => loan.returnedAt && loan.returnPhotoPath)).toBe(true);
    expect(new Set(returnedLoans.map((loan) => loan.returnedAt?.toISOString())).size).toBe(1);
    expect(new Set(returnedLoans.map((loan) => loan.returnPhotoPath)).size).toBe(2);
    expect(await prisma.fileAsset.count({
      where: { publicPath: { in: concurrentUploads.map((item) => item.returnPhotoPath) } },
    })).toBe(0);
    expect((await getMaterialDetail(scanned.id))?.pairedMaterial).toMatchObject({ id: companion.id });
    expect((await getMaterialByQrToken(companion.qrToken))?.pairedMaterial).toMatchObject({ id: scanned.id });
    for (const material of firstPair) {
      expect(await prisma.domainAuditEvent.count({
        where: { entityId: material.id, action: { in: ["material.checked_out", "material.returned"] } },
      })).toBe(2);
    }
    await deleteMaterial(owner.actor, { materialId: companion.id });
    expect(await prisma.material.count({
      where: { id: { in: firstPair.map((item) => item.id) }, deletedAt: { not: null } },
    })).toBe(2);
    expect(await prisma.domainAuditEvent.count({
      where: { entityId: { in: firstPair.map((item) => item.id) }, action: "material.deleted" },
    })).toBe(2);
  });

  test("paired checkout rolls back the first item when the companion write fails", async () => {
    const owner = await createActor("配套领用回滚登记人");
    const borrower = await createActor("配套领用回滚用户");
    const { materialId } = await createMaterial(owner.actor, {
      name: "相机",
      quantity: 1,
      price: "500",
      techGroup: "硬件",
      paired: true,
      companionName: "镜头",
      companionPrice: "300",
      companionTechGroup: "硬件",
      idempotencyKey: randomUUID(),
    });
    const material = await prisma.material.findUniqueOrThrow({ where: { id: materialId } });
    const pair = await prisma.material.findMany({
      where: { pairKey: material.pairKey },
      orderBy: { id: "asc" },
    });
    const failureMaterialId = pair[1].id;
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `paired_checkout_failure_${suffix}`;
    const triggerName = `paired_checkout_trigger_${suffix}`;
    const checkoutInput = {
      qrToken: material.qrToken,
      operation: "CHECKOUT" as const,
      expectedActiveLoanId: null,
      idempotencyKey: randomUUID(),
    };
    try {
      await prisma.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."materialId" = '${failureMaterialId}' THEN
            RAISE EXCEPTION 'injected paired checkout failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "MaterialLoan" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
      await expect(scanMaterial(borrower.actor, checkoutInput)).rejects.toThrow("injected paired checkout failure");
      expect(await prisma.materialLoan.count({ where: { materialId: { in: pair.map((item) => item.id) } } })).toBe(0);
      expect(await prisma.domainAuditEvent.count({
        where: { entityId: { in: pair.map((item) => item.id) }, action: "material.checked_out" },
      })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "MaterialLoan"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
    await expect(scanMaterial(borrower.actor, checkoutInput)).resolves.toMatchObject({
      relatedMaterialIds: expect.arrayContaining(pair.map((item) => item.id)),
    });
    expect(await prisma.materialLoan.count({
      where: { materialId: { in: pair.map((item) => item.id) }, returnedAt: null },
    })).toBe(2);
  });

  test("delete waits for the account permission lock and observes concurrent super administrator revocation", async () => {
    const owner = await createActor("撤权删除登记人");
    const administrator = await createActor("撤权删除管理员");
    const assignment = await prisma.systemRoleAssignment.create({ data: { accountId: administrator.actor.accountId, role: "SUPER_ADMINISTRATOR" } });
    const material = await createMaterial(owner.actor, { name: "撤权并发物资", price: "1", techGroup: "硬件", idempotencyKey: randomUUID() });
    const connection = new Client({ connectionString: process.env.DATABASE_URL });
    await connection.connect();
    let deletion: Promise<unknown> | undefined;
    try {
      await connection.query("BEGIN");
      const backend = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await connection.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`account-permissions:${administrator.actor.accountId}`]);
      deletion = deleteMaterial(administrator.actor, material).then(
        (result) => ({ ok: true, result }),
        (error: unknown) => ({ ok: false, error }),
      );
      await expect.poll(async () => {
        const blocked = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) FROM pg_stat_activity WHERE ${backend.rows[0].pid} = ANY(pg_blocking_pids(pid))
        `;
        return Number(blocked[0].count);
      }).toBeGreaterThan(0);
      await connection.query('UPDATE "SystemRoleAssignment" SET "revokedAt" = NOW() WHERE id = $1', [assignment.id]);
      await connection.query("COMMIT");
      expect(await deletion).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect((await prisma.material.findUniqueOrThrow({ where: { id: material.materialId } })).deletedAt).toBeNull();
      expect(await prisma.domainAuditEvent.count({ where: { entityId: material.materialId, action: "material.deleted" } })).toBe(0);
    } finally {
      await connection.query("ROLLBACK");
      await connection.end();
      await deletion;
    }
  });

  test("soft deletion refreshes permissions, preserves history and registration identity, and disables QR replay", async () => {
    const owner = await createActor("删除登记人");
    const other = await createActor("删除权限测试用户");
    const input = { name: `删除测试-${randomUUID()}`, price: "3.00", techGroup: "硬件", idempotencyKey: randomUUID() };
    const { materialId } = await createMaterial(owner.actor, input);
    const material = await prisma.material.findUniqueOrThrow({ where: { id: materialId } });
    await expect(deleteMaterial(other.actor, { materialId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const staleAdmin = { ...other.actor, systemRoles: [{ role: "SUPER_ADMINISTRATOR" as const, team: "", techGroup: "" }] };
    await expect(deleteMaterial(staleAdmin, { materialId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const assignment = await prisma.systemRoleAssignment.create({ data: { accountId: other.actor.accountId, role: "PROJECT_ADMINISTRATOR" } });
    await expect(deleteMaterial(other.actor, { materialId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await prisma.systemRoleAssignment.update({ where: { id: assignment.id }, data: { revokedAt: new Date() } });
    const superAssignment = await prisma.systemRoleAssignment.create({ data: { accountId: other.actor.accountId, role: "SUPER_ADMINISTRATOR" } });
    await prisma.systemRoleAssignment.update({ where: { id: superAssignment.id }, data: { revokedAt: new Date() } });
    await expect(deleteMaterial(staleAdmin, { materialId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await prisma.person.update({ where: { id: owner.personId }, data: { status: "INACTIVE" } });
    await expect(deleteMaterial(owner.actor, { materialId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await prisma.person.update({ where: { id: owner.personId }, data: { status: "ACTIVE" } });
    const checkout = { qrToken: material.qrToken, operation: "CHECKOUT" as const, expectedActiveLoanId: null, idempotencyKey: randomUUID() };
    await scanMaterial(other.actor, checkout);
    await expect(deleteMaterial(owner.actor, { materialId })).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    const loan = await prisma.materialLoan.findFirstOrThrow({ where: { materialId, returnedAt: null } });
    const photo = await saveMaterialReturnPhoto(loan.id, other.actor.openId,
      new File([new Uint8Array(validPngBuffer())], "return.png", { type: "image/png" }));
    const returnInput = { qrToken: material.qrToken, operation: "RETURN" as const, expectedActiveLoanId: loan.id, idempotencyKey: randomUUID() };
    await scanMaterial(other.actor, returnInput, { returnPhotoPath: photo.publicPath, writeGeneration: photo.writeGeneration });
    const loanBefore = await prisma.materialLoan.findUniqueOrThrow({ where: { id: loan.id } });
    const beforeList = await listMaterials({});
    const deletions = await Promise.all([deleteMaterial(owner.actor, { materialId }), deleteMaterial(owner.actor, { materialId })]);
    expect(deletions[0]).toEqual(deletions[1]);
    const deleted = await prisma.material.findUniqueOrThrow({ where: { id: materialId } });
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.qrToken).toBe(material.qrToken);
    expect(deleted.registrationKey).toBe(input.idempotencyKey);
    expect(await prisma.materialLoan.findUnique({ where: { id: loan.id } })).toEqual(loanBefore);
    expect((await getMaterialDetail(materialId))?.history).toHaveLength(1);
    expect(await getMaterialByQrToken(material.qrToken)).toBeNull();
    expect((await listMaterials({ query: input.name })).items).toEqual([]);
    const afterList = await listMaterials({});
    expect(afterList.totalCount).toBe(beforeList.totalCount - 1);
    expect(afterList.availableCount).toBe(beforeList.availableCount - 1);
    expect(afterList.inUseCount).toBe(beforeList.inUseCount);
    await expect(scanMaterial(other.actor, checkout)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(preflightMaterialReturn(other.actor, returnInput)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(scanMaterial(other.actor, returnInput)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await createMaterial(owner.actor, input)).toEqual({ materialId });
    const audits = await prisma.domainAuditEvent.findMany({ where: { entityId: materialId, action: "material.deleted" } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorAccountId).toBe(owner.actor.accountId);
    expect(audits[0].after).toMatchObject({ name: input.name, deletedAt: deleted.deletedAt?.toISOString() });
    const another = await createMaterial(owner.actor, { ...input, idempotencyKey: randomUUID() });
    await prisma.systemRoleAssignment.create({ data: { accountId: other.actor.accountId, role: "SUPER_ADMINISTRATOR" } });
    await expect(deleteMaterial(other.actor, another)).resolves.toMatchObject(another);
    await expect(deleteMaterial(owner.actor, { materialId: "invalid" })).rejects.toThrow();
    await expect(deleteMaterial(owner.actor, { materialId: randomUUID() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("delete and checkout serialize on the material row without deleting an active loan", async () => {
    const owner = await createActor("删除并发登记人");
    const borrower = await createActor("删除并发领用人");
    for (const deleteFirst of [true, false]) {
      const { materialId } = await createMaterial(owner.actor, {
        name: "删除领用竞争", price: "1", techGroup: "硬件", idempotencyKey: randomUUID(),
      });
      const material = await prisma.material.findUniqueOrThrow({ where: { id: materialId } });
      const connection = new Client({ connectionString: process.env.DATABASE_URL });
      await connection.connect();
      const operations = [
        () => deleteMaterial(owner.actor, { materialId }),
        () => scanMaterial(borrower.actor, { qrToken: material.qrToken, operation: "CHECKOUT", expectedActiveLoanId: null, idempotencyKey: randomUUID() }),
      ];
      if (!deleteFirst) operations.reverse();
      const pending: Array<Promise<unknown>> = [];
      try {
        await connection.query("BEGIN");
        await connection.query('SELECT id FROM "Material" WHERE id = $1 FOR UPDATE', [materialId]);
        for (const operation of operations) {
          pending.push(operation().then(
            (value) => ({ ok: true, value }),
            (error: unknown) => ({ ok: false, error }),
          ));
          await expect.poll(async () => {
            const waiters = await prisma.$queryRaw<Array<{ count: bigint }>>`
              SELECT count(*) FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE '%FROM "Material"%' AND query LIKE '%FOR UPDATE%'
            `;
            return Number(waiters[0].count);
          }).toBe(pending.length);
        }
        await connection.query("COMMIT");
        const outcomes = await Promise.all(pending);
        expect(outcomes[0]).toMatchObject({ ok: true });
        expect(outcomes[1]).toMatchObject({ ok: false, error: { code: deleteFirst ? "NOT_FOUND" : "STATE_CONFLICT" } });
      } finally {
        await connection.query("ROLLBACK");
        await connection.end();
        await Promise.all(pending);
      }
      const current = await prisma.material.findUniqueOrThrow({ where: { id: materialId } });
      expect(Boolean(current.deletedAt)).toBe(deleteFirst);
      expect(await prisma.materialLoan.count({ where: { materialId, returnedAt: null } })).toBe(deleteFirst ? 0 : 1);
      expect(await prisma.domainAuditEvent.count({ where: { entityId: materialId, action: "material.deleted" } })).toBe(deleteFirst ? 1 : 0);
    }
  });

  test("delete rolls back when its audit fails and can retry safely", async () => {
    const owner = await createActor("删除审计回滚");
    const { materialId } = await createMaterial(owner.actor, { name: "删除审计回滚", price: "1", techGroup: "硬件", idempotencyKey: randomUUID() });
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `material_delete_failure_${suffix}`;
    const triggerName = `material_delete_trigger_${suffix}`;
    try {
      await prisma.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."entityId" = '${materialId}' AND NEW."action" = 'material.deleted' THEN
            RAISE EXCEPTION 'injected material delete audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "DomainAuditEvent" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
      await expect(deleteMaterial(owner.actor, { materialId })).rejects.toThrow("injected material delete audit failure");
      expect((await prisma.material.findUniqueOrThrow({ where: { id: materialId } })).deletedAt).toBeNull();
      expect(await prisma.domainAuditEvent.count({ where: { entityId: materialId, action: "material.deleted" } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "DomainAuditEvent"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
    await expect(deleteMaterial(owner.actor, { materialId })).resolves.toMatchObject({ materialId });
  });

  test("batch registration rolls back partial items and audit, then retries up to the quantity limit", async () => {
    const { actor } = await createActor("批量回滚测试用户");
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `material_batch_failure_${suffix}`;
    const triggerName = `material_batch_trigger_${suffix}`;
    const input = {
      name: suffix,
      quantity: 3,
      price: "12.00",
      techGroup: "硬件",
      idempotencyKey: randomUUID(),
    };
    try {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."name" = '${suffix}-2' THEN
            RAISE EXCEPTION 'injected material batch failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "Material"
        FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
      `);
      await expect(createMaterial(actor, input)).rejects.toThrow("injected material batch failure");
      expect(await prisma.material.count({ where: { createdByAccountId: actor.accountId } })).toBe(0);
      expect(await prisma.domainAuditEvent.count({
        where: { actorAccountId: actor.accountId, action: "material.registered" },
      })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "Material"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
    await createMaterial(actor, input);
    expect(await prisma.material.count({ where: { createdByAccountId: actor.accountId } })).toBe(3);
    const maximumInput = { ...input, name: "长".repeat(196), quantity: 100, idempotencyKey: randomUUID() };
    await createMaterial(actor, maximumInput);
    const maximumMaterials = await prisma.material.findMany({
      where: { createdByAccountId: actor.accountId, name: { startsWith: maximumInput.name } },
    });
    expect(maximumMaterials).toHaveLength(100);
    expect(new Set(maximumMaterials.map((material) => material.qrToken)).size).toBe(100);
    expect(maximumMaterials.map((material) => material.name).sort()).toEqual(
      Array.from({ length: 100 }, (_, index) => `${maximumInput.name}-${index + 1}`).sort(),
    );
    const audits = await prisma.domainAuditEvent.findMany({
      where: { entityId: { in: maximumMaterials.map((material) => material.id) }, action: "material.registered" },
    });
    expect(audits).toHaveLength(100);
    expect(new Set(audits.map((audit) => audit.entityId)).size).toBe(100);
    await expect(createMaterial(actor, { ...maximumInput, name: "长".repeat(197), idempotencyKey: randomUUID() })).rejects.toThrow();
    expect(await prisma.material.count({ where: { createdByAccountId: actor.accountId } })).toBe(103);
  });

  test("batch registration creates independently audited items exactly once and validates boundaries", async () => {
    const { actor, personId } = await createActor("批量物资登记用户");
    const input = {
      name: `批量示波器-${randomUUID()}`,
      quantity: 3,
      price: "25.50",
      techGroup: "硬件",
      idempotencyKey: randomUUID(),
    };
    const results = await Promise.all([
      createMaterial(actor, input),
      createMaterial(actor, input),
    ]);
    expect(results[0]).toEqual(results[1]);
    const materials = await prisma.material.findMany({
      where: { createdByAccountId: actor.accountId },
      orderBy: { name: "asc" },
    });
    expect(materials.map((material) => material.name)).toEqual([1, 2, 3].map((index) => `${input.name}-${index}`));
    expect(new Set(materials.map((material) => material.qrToken)).size).toBe(3);
    for (const material of materials) {
      expect(material.price.toFixed(2)).toBe("25.50");
      expect(material.techGroup).toBe("硬件");
      expect(await prisma.domainAuditEvent.count({
        where: { entityId: material.id, action: "material.registered" },
      })).toBe(1);
    }
    await expect(createMaterial(actor, { ...input, quantity: 100 })).resolves.toEqual(results[0]);
    for (const quantity of [0, -1, 1.5, 101, "3", null]) {
      await expect(createMaterial(actor, { ...input, quantity, idempotencyKey: randomUUID() })).rejects.toThrow();
    }
    await expect(createMaterial(actor, { ...input, name: "长".repeat(199), idempotencyKey: randomUUID() })).rejects.toThrow();
    expect(await prisma.material.count({ where: { createdByAccountId: actor.accountId } })).toBe(3);
    await prisma.person.update({ where: { id: personId }, data: { status: "INACTIVE" } });
    await expect(createMaterial(actor, { ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.material.count({ where: { createdByAccountId: actor.accountId } })).toBe(3);
  });

  test("registration is idempotent and checkout/return is serialized with immutable QR and history", async () => {
    const first = await createActor("物资并发用户甲");
    const second = await createActor("物资并发用户乙");
    const registrationKey = randomUUID();

    const registrations = await Promise.all([
      createMaterial(first.actor, {
        name: "并发测试示波器",
        price: "12888.50",
        techGroup: "硬件",
        idempotencyKey: registrationKey,
      }),
      createMaterial(first.actor, {
        name: "并发测试示波器",
        price: "12888.50",
        techGroup: "硬件",
        idempotencyKey: registrationKey,
      }),
    ]);
    expect(registrations[0].materialId).toBe(registrations[1].materialId);

    const material = await prisma.material.findUniqueOrThrow({
      where: { id: registrations[0].materialId },
      select: { id: true, qrToken: true },
    });
    const checkoutOutcomes = await Promise.allSettled([
      scanMaterial(first.actor, {
        qrToken: material.qrToken,
        operation: "CHECKOUT",
        expectedActiveLoanId: null,
        idempotencyKey: randomUUID(),
      }),
      scanMaterial(second.actor, {
        qrToken: material.qrToken,
        operation: "CHECKOUT",
        expectedActiveLoanId: null,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(
      checkoutOutcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = checkoutOutcomes.find(
      (outcome) => outcome.status === "rejected",
    );
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(ProjectManagementServiceError);
      expect(rejected.reason.code).toBe("STATE_CONFLICT");
    }

    const activeLoan = await prisma.materialLoan.findFirstOrThrow({
      where: { materialId: material.id, returnedAt: null },
    });
    const borrower =
      activeLoan.borrowerAccountId === first.actor.accountId ? first : second;
    const other = borrower === first ? second : first;


    await expect(
      preflightMaterialReturn(other.actor, {
        qrToken: material.qrToken,
        operation: "RETURN",
        expectedActiveLoanId: activeLoan.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "STATE_CONFLICT",
      message: "该物资由其他用户使用，只有领用人可以归还",
    });
    await expect(
      scanMaterial(other.actor, {
        qrToken: material.qrToken,
        operation: "RETURN",
        expectedActiveLoanId: activeLoan.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "STATE_CONFLICT",
      message: "该物资由其他用户使用，只有领用人可以归还",
    });

    const returnIdempotencyKey = randomUUID();
    await expect(
      scanMaterial(borrower.actor, {
        qrToken: material.qrToken,
        operation: "RETURN",
        expectedActiveLoanId: activeLoan.id,
        idempotencyKey: returnIdempotencyKey,
      }),
    ).rejects.toMatchObject({
      code: "STATE_CONFLICT",
      message: "请拍摄物资归还照片后再确认归还",
    });
    const missingPhotoPath =
      `/uploads/materials/${activeLoan.id}/${randomUUID()}.png`;
    const missingGeneration = randomUUID();
    const missingAsset = await prisma.fileAsset.create({
      data: {
        publicPath: missingPhotoPath,
        storagePath: missingPhotoPath.slice("/uploads/".length),
        kind: "MATERIAL_RETURN_PHOTO",
        mimeType: "image/png",
        size: validPngBuffer().length,
        ownerOpenId: borrower.actor.openId,
        writeGeneration: missingGeneration,
      },
    });
    await expect(
      scanMaterial(
        borrower.actor,
        {
          qrToken: material.qrToken,
          operation: "RETURN",
          expectedActiveLoanId: activeLoan.id,
          idempotencyKey: returnIdempotencyKey,
        },
        {
          returnPhotoPath: missingPhotoPath,
          writeGeneration: missingGeneration,
        },
      ),
    ).rejects.toMatchObject({
      code: "STATE_CONFLICT",
      message: "归还照片无效，请重新拍摄后提交",
    });
    await expect(
      canViewFileAsset({
        asset: missingAsset,
        userOpenId: other.actor.openId,
        roles: [],
      }),
    ).resolves.toBe(false);
    await prisma.fileAsset.delete({ where: { id: missingAsset.id } });

    const savedPhoto = await saveMaterialReturnPhoto(
      activeLoan.id,
      borrower.actor.openId,
      new File([new Uint8Array(validPngBuffer())], "return-photo.png", { type: "image/png" }),
    );
    const returnPhotoPath = savedPhoto.publicPath;
    await expect(
      scanMaterial(
        borrower.actor,
        {
          qrToken: material.qrToken,
          operation: "RETURN",
          expectedActiveLoanId: activeLoan.id,
          idempotencyKey: returnIdempotencyKey,
        },
        {
          returnPhotoPath,
          writeGeneration: randomUUID(),
        },
      ),
    ).rejects.toMatchObject({
      code: "STATE_CONFLICT",
      message: "归还照片无效，请重新拍摄后提交",
    });
    const returned = await scanMaterial(borrower.actor, {
      qrToken: material.qrToken,
      operation: "RETURN",
      expectedActiveLoanId: activeLoan.id,
      idempotencyKey: returnIdempotencyKey,
    }, {
      returnPhotoPath,
      writeGeneration: savedPhoto.writeGeneration,
    });

    const returnedAsset = await prisma.fileAsset.findUniqueOrThrow({
      where: { publicPath: returnPhotoPath },
    });
    await expect(
      canViewFileAsset({
        asset: returnedAsset,
        userOpenId: borrower.actor.openId,
        roles: [],
      }),
    ).resolves.toBe(true);
    await prisma.person.update({
      where: { id: borrower.personId },
      data: { status: "INACTIVE" },
    });
    await expect(
      canViewFileAsset({
        asset: returnedAsset,
        userOpenId: borrower.actor.openId,
        roles: [],
      }),
    ).resolves.toBe(false);
    await prisma.person.update({
      where: { id: borrower.personId },
      data: { status: "ACTIVE" },
    });
    const cleanupMarkedAsset = await prisma.fileAsset.update({
      where: { publicPath: returnPhotoPath },
      data: { cleanupRequestedAt: new Date() },
    });
    await expect(
      canViewFileAsset({
        asset: cleanupMarkedAsset,
        userOpenId: borrower.actor.openId,
        roles: [],
      }),
    ).resolves.toBe(false);
    await prisma.fileAsset.update({
      where: { publicPath: returnPhotoPath },
      data: { cleanupRequestedAt: null },
    });
    const replayed = await scanMaterial(borrower.actor, {
      qrToken: material.qrToken,
      operation: "RETURN",
      expectedActiveLoanId: activeLoan.id,
      idempotencyKey: returnIdempotencyKey,
    });
    expect(replayed).toEqual(returned);
    await expect(
      preflightMaterialReturn(borrower.actor, {
        qrToken: material.qrToken,
        operation: "RETURN",
        expectedActiveLoanId: activeLoan.id,
        idempotencyKey: returnIdempotencyKey,
      }),
    ).resolves.toEqual({
      kind: "REPLAY",
      result: returned,
    });
    await expect(
      prisma.materialLoan.findUniqueOrThrow({
        where: { id: activeLoan.id },
        select: { returnPhotoPath: true, returnPhotoClearedAt: true },
      }),
    ).resolves.toEqual({
      returnPhotoPath,
      returnPhotoClearedAt: null,
    });

    const afterCycle = await prisma.material.findUniqueOrThrow({
      where: { id: material.id },
      select: { qrToken: true },
    });
    expect(afterCycle.qrToken).toBe(material.qrToken);
    expect(
      await prisma.materialLoan.count({
        where: { materialId: material.id, returnedAt: null },
      }),
    ).toBe(0);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "Material",
          entityId: material.id,
          action: {
            in: [
              "material.registered",
              "material.checked_out",
              "material.returned",
            ],
          },
        },
      }),
    ).toBe(3);

    await expect(
      prisma.material.update({
        where: { id: material.id },
        data: { qrToken: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.materialLoan.delete({ where: { id: activeLoan.id } }),
    ).rejects.toThrow();

    await scanMaterial(other.actor, {
      qrToken: material.qrToken,
      operation: "CHECKOUT",
      expectedActiveLoanId: null,
      idempotencyKey: randomUUID(),
    });
    const clearedReturn = await prisma.materialLoan.findUniqueOrThrow({
      where: { id: activeLoan.id },
      select: { returnPhotoPath: true, returnPhotoClearedAt: true },
    });
    expect(clearedReturn.returnPhotoPath).toBeNull();
    expect(clearedReturn.returnPhotoClearedAt).not.toBeNull();
    await expect(
      prisma.fileAsset.findUnique({ where: { publicPath: returnPhotoPath } }),
    ).resolves.toBeNull();

    await prisma.person.update({
      where: { id: borrower.personId },
      data: { status: "INACTIVE" },
    });
    await expect(
      scanMaterial(borrower.actor, {
        qrToken: material.qrToken,
        operation: "CHECKOUT",
        expectedActiveLoanId: null,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "人员已停用，无法执行此操作",
    });
  });
});

function validPngBuffer(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  );
}

async function createActor(displayName: string): Promise<{
  actor: ProjectManagementActor;
  personId: string;
}> {
  const openId = `ou_material_${randomUUID()}`;
  const resolved = await resolveFeishuIdentityForUser({
    openId,
    unionId: null,
    name: displayName,
  });
  await prisma.person.update({
    where: { id: resolved.person.id },
    data: { status: "ACTIVE" },
  });
  return {
    personId: resolved.person.id,
    actor: {
      accountId: resolved.account.id,
      personId: resolved.person.id,
      openId,
      unionId: null,
      isActive: true,
      systemRoles: [],
    },
  };
}
