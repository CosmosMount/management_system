// @playwright-project node-db
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { canViewFileAsset } from "../lib/file-asset-permissions";
import { saveMaterialReturnPhoto } from "../lib/file-upload";
import {
  createMaterial,
  preflightMaterialReturn,
  scanMaterial,
} from "../lib/material-management/service";
import {
  ProjectManagementServiceError,
} from "../lib/project-management/application/errors";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";
import type { ProjectManagementActor } from "../lib/project-management/identity";

test.describe("material management concurrency and audit safety", () => {
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
