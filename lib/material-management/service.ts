import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { prisma } from "@/lib/prisma";
import { cleanupUploadPaths } from "@/lib/upload-cleanup";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import {
  ProjectManagementServiceError,
  notFoundError,
  stateConflictError,
} from "@/lib/project-management/application/errors";
import {
  createMaterialSchema,
  deleteMaterialSchema,
  materialScanSchema,
} from "@/lib/material-management/validations";
import { isMaterialReturnPhotoStoragePath, validateStoredMaterialReturnPhoto } from "@/lib/material-management/return-photo-file";
import { canDeleteMaterial } from "@/lib/material-management/permissions";

const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 30_000 } as const;

export type MaterialScanResult = {
  materialId: string;
  relatedMaterialIds: string[];
  materialName: string;
  operation: "CHECKOUT" | "RETURN";
  occurredAt: string;
};

export type MaterialReturnPreflight =
  | { kind: "READY"; loanId: string; loanIds: string[] }
  | { kind: "REPLAY"; result: MaterialScanResult };

export async function preflightMaterialReturn(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<MaterialReturnPreflight> {
  const parsed = materialScanSchema.parse(input);
  if (parsed.operation !== "RETURN") {
    throw stateConflictError("扫码操作无效，请重新扫码");
  }

  const account = await prisma.account.findUnique({
    where: { id: actor.accountId },
    select: { person: { select: { id: true, status: true } } },
  });
  if (
    !account?.person ||
    account.person.id !== actor.personId ||
    account.person.status !== "ACTIVE"
  ) {
    throw new ProjectManagementServiceError(
      "FORBIDDEN",
      "人员已停用，无法执行此操作",
    );
  }

  const material = await prisma.material.findUnique({
    where: { qrToken: parsed.qrToken, deletedAt: null },
    select: { id: true, name: true, pairKey: true },
  });
  if (!material) throw notFoundError();
  const materials = await prisma.material.findMany({
    where: material.pairKey
      ? { pairKey: material.pairKey, deletedAt: null }
      : { id: material.id, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });
  assertCompleteMaterialGroup(material.pairKey, materials);

  const replay = await prisma.materialLoan.findFirst({
    where: {
      materialId: material.id,
      borrowerAccountId: actor.accountId,
      returnIdempotencyKey: parsed.idempotencyKey,
      returnedAt: { not: null },
    },
    select: { returnedAt: true },
  });
  if (replay?.returnedAt) {
    return {
      kind: "REPLAY",
      result: {
        materialId: material.id,
        relatedMaterialIds: materials.map((item) => item.id),
        materialName: materialGroupName(materials),
        operation: "RETURN",
        occurredAt: replay.returnedAt.toISOString(),
      },
    };
  }

  const activeLoans = await prisma.materialLoan.findMany({
    where: { materialId: { in: materials.map((item) => item.id) }, returnedAt: null },
    select: { id: true, materialId: true, borrowerAccountId: true },
  });
  const activeLoan = activeLoans.find((loan) => loan.materialId === material.id);
  if (!activeLoan || activeLoan.id !== parsed.expectedActiveLoanId) {
    throw stateConflictError();
  }
  if (activeLoans.length !== materials.length || activeLoans.some((loan) => loan.borrowerAccountId !== actor.accountId)) {
    throw stateConflictError("该物资由其他用户使用，只有领用人可以归还");
  }
  return { kind: "READY", loanId: activeLoan.id, loanIds: activeLoans.map((loan) => loan.id) };
}

export async function createMaterial(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<{ materialId: string }> {
  const parsed = createMaterialSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    await refreshProjectManagementActorTx(tx, actor);
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`material:register:${parsed.idempotencyKey}`}))
    `;

    const existing = await tx.material.findUnique({
      where: { registrationKey: parsed.idempotencyKey },
      select: { id: true },
    });
    if (existing) return { materialId: existing.id };

    let materialId = "";
    for (let index = 1; index <= parsed.quantity; index += 1) {
      const pairKey = parsed.paired ? randomUUID() : null;
      const material = await tx.material.create({
        data: {
          registrationKey: index === 1 ? parsed.idempotencyKey : randomUUID(),
          name: parsed.quantity === 1 ? parsed.name : `${parsed.name}-${index}`,
          price: new Prisma.Decimal(parsed.price),
          techGroup: parsed.techGroup,
          pairKey,
          createdByAccountId: actor.accountId,
        },
        select: {
          id: true,
          name: true,
          price: true,
          techGroup: true,
        },
      });
      let pairedMaterialId: string | null = null;
      if (parsed.paired) {
        const companion = await tx.material.create({
          data: {
            registrationKey: randomUUID(),
            name: parsed.quantity === 1
              ? parsed.companionName!
              : `${parsed.companionName}-${index}`,
            price: new Prisma.Decimal(parsed.companionPrice!),
            techGroup: parsed.companionTechGroup!,
            pairKey,
            createdByAccountId: actor.accountId,
          },
          select: { id: true, name: true, price: true, techGroup: true },
        });
        pairedMaterialId = companion.id;
        await createDomainAuditEventTx(tx, {
          actorAccountId: actor.accountId,
          actorPersonId: actor.personId,
          action: "material.registered",
          entityType: "Material",
          entityId: companion.id,
          after: {
            name: companion.name,
            price: companion.price.toFixed(2),
            techGroup: companion.techGroup,
            pairKey,
            pairedMaterialId: material.id,
          },
        });
      }
      await createDomainAuditEventTx(tx, {
        actorAccountId: actor.accountId,
        actorPersonId: actor.personId,
        action: "material.registered",
        entityType: "Material",
        entityId: material.id,
        after: {
          name: material.name,
          price: material.price.toFixed(2),
          techGroup: material.techGroup,
          pairKey,
          pairedMaterialId,
        },
      });
      if (index === 1) materialId = material.id;
    }
    return { materialId };
  }, TRANSACTION_OPTIONS);
}

export async function deleteMaterial(
  actor: ProjectManagementActor,
  input: unknown,
) {
  const parsed = deleteMaterialSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "Person" WHERE "id" = ${actor.personId} FOR UPDATE
    `;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`account-permissions:${actor.accountId}`}))
    `;
    const currentActor = await refreshProjectManagementActorTx(tx, actor);
    const target = await tx.material.findUnique({
      where: { id: parsed.materialId },
      select: { id: true, pairKey: true },
    });
    if (!target) throw notFoundError();
    await tx.$queryRaw`
      SELECT "id" FROM "Material"
      WHERE "id" = ${target.id}
        OR (${target.pairKey}::UUID IS NOT NULL AND "pairKey" = ${target.pairKey}::UUID)
      ORDER BY "id" FOR UPDATE
    `;
    const materials = await tx.material.findMany({
      where: target.pairKey ? { pairKey: target.pairKey } : { id: target.id },
      select: {
        id: true,
        name: true,
        qrToken: true,
        deletedAt: true,
        createdByAccountId: true,
      },
      orderBy: { id: "asc" },
    });
    assertCompleteMaterialGroup(target.pairKey, materials);
    const material = materials.find((item) => item.id === target.id);
    if (!material) throw notFoundError();
    if (
      materials.some(
        (item) => !canDeleteMaterial(currentActor, item.createdByAccountId),
      )
    ) {
      throw new ProjectManagementServiceError(
        "FORBIDDEN",
        "只有登记人或超级管理员可以删除物资",
      );
    }
    const result = {
      materialId: material.id,
      qrToken: material.qrToken,
      relatedMaterials: materials.map((item) => ({
        materialId: item.id,
        qrToken: item.qrToken,
      })),
    };
    if (materials.every((item) => item.deletedAt)) return result;
    if (materials.some((item) => item.deletedAt)) {
      throw stateConflictError("配套物资状态异常，请联系管理员处理");
    }
    const activeLoan = await tx.materialLoan.findFirst({
      where: {
        materialId: { in: materials.map((item) => item.id) },
        returnedAt: null,
      },
      select: { id: true },
    });
    if (activeLoan) {
      throw stateConflictError("物资正在使用中，请先归还后再删除");
    }
    const deletedAt = new Date();
    await tx.material.updateMany({
      where: { id: { in: materials.map((item) => item.id) } },
      data: { deletedAt },
    });
    for (const item of materials) {
      await createDomainAuditEventTx(tx, {
        actorAccountId: currentActor.accountId,
        actorPersonId: currentActor.personId,
        action: "material.deleted",
        entityType: "Material",
        entityId: item.id,
        before: { name: item.name, deletedAt: null },
        after: {
          name: item.name,
          deletedAt: deletedAt.toISOString(),
          pairedMaterialIds: materials
            .filter((candidate) => candidate.id !== item.id)
            .map((candidate) => candidate.id),
        },
      });
    }
    return result;
  }, TRANSACTION_OPTIONS);
}

export async function scanMaterial(
  actor: ProjectManagementActor,
  input: unknown,
  upload?: { returnPhotoPath: string; writeGeneration: string } | Array<{
    loanId: string;
    returnPhotoPath: string;
    writeGeneration: string;
  }>,
): Promise<MaterialScanResult> {
  const parsed = materialScanSchema.parse(input);

  const outcome = await prisma.$transaction(async (tx) => {
    await refreshProjectManagementActorTx(tx, actor);

    const scanned = await tx.material.findUnique({
      where: { qrToken: parsed.qrToken },
      select: { id: true, pairKey: true },
    });
    if (!scanned) throw notFoundError();
    await tx.$queryRaw`
      SELECT "id" FROM "Material"
      WHERE "id" = ${scanned.id}
        OR (${scanned.pairKey}::UUID IS NOT NULL AND "pairKey" = ${scanned.pairKey}::UUID)
      ORDER BY "id" FOR UPDATE
    `;
    const materials = await tx.material.findMany({
      where: scanned.pairKey
        ? { pairKey: scanned.pairKey, deletedAt: null }
        : { id: scanned.id, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    });
    const material = materials.find((item) => item.id === scanned.id);
    if (!material) throw notFoundError();
    assertCompleteMaterialGroup(scanned.pairKey, materials);

    const replay = await findScanReplay(tx, {
      materialId: material.id,
      materialIds: materials.map((item) => item.id),
      accountId: actor.accountId,
      operation: parsed.operation,
      idempotencyKey: parsed.idempotencyKey,
    });
    if (replay) {
      const boundPhotoPaths = new Set(replay.returnPhotoPaths);
      const submittedPhotoPaths = Array.isArray(upload)
        ? upload.map((item) => item.returnPhotoPath)
        : upload
          ? [upload.returnPhotoPath]
          : [];
      const cleanupPaths = submittedPhotoPaths.filter(
        (publicPath) => !boundPhotoPaths.has(publicPath),
      );
      return {
        result: {
          materialId: material.id,
          relatedMaterialIds: materials.map((item) => item.id),
          materialName: materialGroupName(materials),
          operation: parsed.operation,
          occurredAt: replay.occurredAt.toISOString(),
        },
        cleanupPaths,
      };
    }

    const activeLoans = await tx.materialLoan.findMany({
      where: { materialId: { in: materials.map((item) => item.id) }, returnedAt: null },
      select: {
        id: true,
        materialId: true,
        borrowerAccountId: true,
        borrowerAccount: {
          select: { person: { select: { displayName: true } } },
        },
      },
    });
    const activeLoan = activeLoans.find((loan) => loan.materialId === material.id);

    if (parsed.operation === "CHECKOUT") {
      if (activeLoans.length > 0) {
        if (activeLoans.every((loan) => loan.borrowerAccountId === actor.accountId)) {
          throw stateConflictError("该套物资已由你领用，请刷新后再归还");
        }
        const borrowerName = activeLoans[0].borrowerAccount.person?.displayName ?? "其他用户";
        throw stateConflictError(
          `该套物资当前由${borrowerName}使用，暂不能领用`,
        );
      }
      const checkedOutAt = new Date();
      const cleanupPaths: string[] = [];
      for (const item of materials) {
        const loan = await tx.materialLoan.create({
          data: {
            materialId: item.id,
            borrowerAccountId: actor.accountId,
            checkoutIdempotencyKey: item.id === material.id ? parsed.idempotencyKey : randomUUID(),
            checkedOutAt,
          },
          select: { id: true },
        });
        const previousReturn = await tx.materialLoan.findFirst({
          where: { materialId: item.id, returnedAt: { not: null }, returnPhotoPath: { not: null } },
          orderBy: { returnedAt: "desc" },
          select: { id: true, returnPhotoPath: true },
        });
        if (previousReturn?.returnPhotoPath) {
          cleanupPaths.push(previousReturn.returnPhotoPath);
          const cleanupRequestedAt = new Date();
          await tx.materialLoan.update({ where: { id: previousReturn.id }, data: { returnPhotoPath: null, returnPhotoClearedAt: cleanupRequestedAt } });
          await tx.fileAsset.update({ where: { publicPath: previousReturn.returnPhotoPath }, data: {
            cleanupRequestedAt, cleanupNextRunAt: cleanupRequestedAt,
            cleanupLastError: "物资已被下一位用户领用，等待清理上一笔归还照片",
          } });
        }
        await touchMaterial(tx, item.id);
        await createDomainAuditEventTx(tx, {
          actorAccountId: actor.accountId,
          actorPersonId: actor.personId,
          action: "material.checked_out",
          entityType: "Material",
          entityId: item.id,
          before: { activeLoanId: null },
          after: {
            activeLoanId: loan.id,
            borrowerAccountId: actor.accountId,
            checkedOutAt: checkedOutAt.toISOString(),
            pairedMaterialIds: materials.filter((candidate) => candidate.id !== item.id).map((candidate) => candidate.id),
            previousReturnPhotoCleared: Boolean(previousReturn?.returnPhotoPath),
          },
        });
      }
      return {
        result: {
          materialId: material.id,
          relatedMaterialIds: materials.map((item) => item.id),
          materialName: materialGroupName(materials),
          operation: "CHECKOUT" as const,
          occurredAt: checkedOutAt.toISOString(),
        },
        cleanupPaths,
      };
    }

    if (!activeLoan || activeLoan.id !== parsed.expectedActiveLoanId || activeLoans.length !== materials.length) {
      throw stateConflictError();
    }
    if (activeLoans.some((loan) => loan.borrowerAccountId !== actor.accountId)) {
      throw stateConflictError("该物资由其他用户使用，只有领用人可以归还");
    }
    const uploads = Array.isArray(upload)
      ? upload
      : upload
        ? [{ loanId: activeLoan.id, ...upload }]
        : [];
    if (uploads.length !== activeLoans.length) {
      throw stateConflictError("请拍摄物资归还照片后再确认归还");
    }
    const returnedAt = new Date();
    for (const loan of activeLoans) {
      const uploaded = uploads.find((item) => item.loanId === loan.id);
      if (!uploaded) throw stateConflictError("归还照片无效，请重新拍摄后提交");
      const photo = await tx.fileAsset.findFirst({ where: {
        publicPath: uploaded.returnPhotoPath, kind: "MATERIAL_RETURN_PHOTO",
        ownerOpenId: actor.openId, cleanupRequestedAt: null,
      }, select: { publicPath: true, storagePath: true, mimeType: true, size: true, writeGeneration: true } });
      if (!photo || !isMaterialReturnPhotoStoragePath(photo.storagePath, loan.id) ||
        !await validateStoredMaterialReturnPhoto(photo, uploaded.writeGeneration)) {
        throw stateConflictError("归还照片无效，请重新拍摄后提交");
      }
      await tx.materialLoan.update({ where: { id: loan.id }, data: {
        returnedAt,
        returnIdempotencyKey: loan.id === activeLoan.id ? parsed.idempotencyKey : randomUUID(),
        returnPhotoPath: photo.publicPath,
      } });
      await touchMaterial(tx, loan.materialId);
      await createDomainAuditEventTx(tx, {
        actorAccountId: actor.accountId, actorPersonId: actor.personId,
        action: "material.returned", entityType: "Material", entityId: loan.materialId,
        before: { activeLoanId: loan.id, borrowerAccountId: actor.accountId },
        after: {
          activeLoanId: null, returnedAt: returnedAt.toISOString(), returnPhotoCaptured: true,
          pairedMaterialIds: materials.filter((item) => item.id !== loan.materialId).map((item) => item.id),
        },
      });
    }
    return {
      result: {
        materialId: material.id,
        relatedMaterialIds: materials.map((item) => item.id),
        materialName: materialGroupName(materials),
        operation: "RETURN" as const,
        occurredAt: returnedAt.toISOString(),
      },
      cleanupPaths: [] as string[],
    };
  }, TRANSACTION_OPTIONS);

  if (outcome.cleanupPaths.length > 0) {
    await cleanupUploadPaths(
      outcome.cleanupPaths,
      "material_next_checkout_previous_return_photo",
    );
  }
  return outcome.result;
}

function assertCompleteMaterialGroup(pairKey: string | null, materials: Array<{ id: string }>) {
  if (materials.length !== (pairKey ? 2 : 1)) {
    throw stateConflictError("配套物资状态异常，请联系管理员处理");
  }
}

function materialGroupName(materials: Array<{ name: string }>) {
  return materials.map((material) => material.name).join(" + ");
}

async function findScanReplay(
  tx: Prisma.TransactionClient,
  input: {
    materialId: string;
    materialIds: string[];
    accountId: string;
    operation: "CHECKOUT" | "RETURN";
    idempotencyKey: string;
  },
): Promise<{ occurredAt: Date; returnPhotoPaths: string[] } | null> {
  if (input.operation === "CHECKOUT") {
    const loan = await tx.materialLoan.findFirst({
      where: {
        materialId: input.materialId,
        borrowerAccountId: input.accountId,
        checkoutIdempotencyKey: input.idempotencyKey,
      },
      select: { checkedOutAt: true },
    });
    return loan
      ? { occurredAt: loan.checkedOutAt, returnPhotoPaths: [] }
      : null;
  }
  const loan = await tx.materialLoan.findFirst({
    where: {
      materialId: input.materialId,
      borrowerAccountId: input.accountId,
      returnIdempotencyKey: input.idempotencyKey,
    },
    select: { returnedAt: true },
  });
  if (!loan?.returnedAt) return null;
  const returnedLoans = await tx.materialLoan.findMany({
    where: {
      materialId: { in: input.materialIds },
      borrowerAccountId: input.accountId,
      returnedAt: loan.returnedAt,
      returnPhotoPath: { not: null },
    },
    select: { returnPhotoPath: true },
  });
  return {
    occurredAt: loan.returnedAt,
    returnPhotoPaths: returnedLoans.flatMap((item) =>
      item.returnPhotoPath ? [item.returnPhotoPath] : [],
    ),
  };
}

async function touchMaterial(
  tx: Prisma.TransactionClient,
  materialId: string,
): Promise<void> {
  await tx.material.update({
    where: { id: materialId },
    data: { updatedAt: new Date() },
    select: { id: true },
  });
}
