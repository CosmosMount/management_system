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
  materialScanSchema,
} from "@/lib/material-management/validations";
import { isMaterialReturnPhotoStoragePath, validateStoredMaterialReturnPhoto } from "@/lib/material-management/return-photo-file";

const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 30_000 } as const;

export type MaterialScanResult = {
  materialId: string;
  materialName: string;
  operation: "CHECKOUT" | "RETURN";
  occurredAt: string;
};

export type MaterialReturnPreflight =
  | { kind: "READY"; loanId: string }
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
    where: { qrToken: parsed.qrToken },
    select: { id: true, name: true },
  });
  if (!material) throw notFoundError();

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
        materialName: material.name,
        operation: "RETURN",
        occurredAt: replay.returnedAt.toISOString(),
      },
    };
  }

  const activeLoan = await prisma.materialLoan.findFirst({
    where: { materialId: material.id, returnedAt: null },
    select: { id: true, borrowerAccountId: true },
  });
  if (!activeLoan || activeLoan.id !== parsed.expectedActiveLoanId) {
    throw stateConflictError();
  }
  if (activeLoan.borrowerAccountId !== actor.accountId) {
    throw stateConflictError("该物资由其他用户使用，只有领用人可以归还");
  }
  return { kind: "READY", loanId: activeLoan.id };
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

    const material = await tx.material.create({
      data: {
        registrationKey: parsed.idempotencyKey,
        name: parsed.name,
        price: new Prisma.Decimal(parsed.price),
        techGroup: parsed.techGroup,
        createdByAccountId: actor.accountId,
      },
      select: {
        id: true,
        name: true,
        price: true,
        techGroup: true,
      },
    });
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
      },
    });
    return { materialId: material.id };
  }, TRANSACTION_OPTIONS);
}

export async function scanMaterial(
  actor: ProjectManagementActor,
  input: unknown,
  upload?: { returnPhotoPath: string; writeGeneration: string },
): Promise<MaterialScanResult> {
  const parsed = materialScanSchema.parse(input);

  const outcome = await prisma.$transaction(async (tx) => {
    await refreshProjectManagementActorTx(tx, actor);

    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Material"
      WHERE "qrToken" = CAST(${parsed.qrToken} AS UUID)
      FOR UPDATE
    `;
    if (locked.length !== 1) throw notFoundError();

    const material = await tx.material.findUnique({
      where: { qrToken: parsed.qrToken },
      select: { id: true, name: true },
    });
    if (!material) throw notFoundError();

    const replay = await findScanReplay(tx, {
      materialId: material.id,
      accountId: actor.accountId,
      operation: parsed.operation,
      idempotencyKey: parsed.idempotencyKey,
    });
    if (replay) {
      const cleanupPaths =
        upload?.returnPhotoPath &&
        upload.returnPhotoPath !== replay.returnPhotoPath
          ? [upload.returnPhotoPath]
          : [];
      return {
        result: {
          materialId: material.id,
          materialName: material.name,
          operation: parsed.operation,
          occurredAt: replay.occurredAt.toISOString(),
        },
        cleanupPaths,
      };
    }

    const activeLoan = await tx.materialLoan.findFirst({
      where: { materialId: material.id, returnedAt: null },
      select: {
        id: true,
        borrowerAccountId: true,
        borrowerAccount: {
          select: { person: { select: { displayName: true } } },
        },
      },
    });

    if (parsed.operation === "CHECKOUT") {
      if (activeLoan) {
        if (activeLoan.borrowerAccountId === actor.accountId) {
          throw stateConflictError("该物资已由你领用，请刷新后再归还");
        }
        const borrowerName =
          activeLoan.borrowerAccount.person?.displayName ?? "其他用户";
        throw stateConflictError(
          `该物资当前由${borrowerName}使用，暂不能领用`,
        );
      }

      const loan = await tx.materialLoan.create({
        data: {
          materialId: material.id,
          borrowerAccountId: actor.accountId,
          checkoutIdempotencyKey: parsed.idempotencyKey,
        },
        select: { id: true, checkedOutAt: true },
      });
      const previousReturn = await tx.materialLoan.findFirst({
        where: {
          materialId: material.id,
          returnedAt: { not: null },
          returnPhotoPath: { not: null },
        },
        orderBy: { returnedAt: "desc" },
        select: { id: true, returnPhotoPath: true },
      });
      const cleanupPaths = previousReturn?.returnPhotoPath
        ? [previousReturn.returnPhotoPath]
        : [];
      if (previousReturn?.returnPhotoPath) {
        const cleanupRequestedAt = new Date();
        await tx.materialLoan.update({
          where: { id: previousReturn.id },
          data: {
            returnPhotoPath: null,
            returnPhotoClearedAt: cleanupRequestedAt,
          },
        });
        await tx.fileAsset.update({
          where: { publicPath: previousReturn.returnPhotoPath },
          data: {
            cleanupRequestedAt,
            cleanupNextRunAt: cleanupRequestedAt,
            cleanupLastError: "物资已被下一位用户领用，等待清理上一笔归还照片",
          },
        });
      }
      await touchMaterial(tx, material.id);
      await createDomainAuditEventTx(tx, {
        actorAccountId: actor.accountId,
        actorPersonId: actor.personId,
        action: "material.checked_out",
        entityType: "Material",
        entityId: material.id,
        before: { activeLoanId: null },
        after: {
          activeLoanId: loan.id,
          borrowerAccountId: actor.accountId,
          checkedOutAt: loan.checkedOutAt.toISOString(),
          previousReturnPhotoCleared: cleanupPaths.length > 0,
        },
      });
      return {
        result: {
          materialId: material.id,
          materialName: material.name,
          operation: "CHECKOUT" as const,
          occurredAt: loan.checkedOutAt.toISOString(),
        },
        cleanupPaths,
      };
    }

    if (
      !activeLoan ||
      activeLoan.id !== parsed.expectedActiveLoanId
    ) {
      throw stateConflictError();
    }
    if (activeLoan.borrowerAccountId !== actor.accountId) {
      throw stateConflictError("该物资由其他用户使用，只有领用人可以归还");
    }
    if (!upload?.returnPhotoPath) {
      throw stateConflictError("请拍摄物资归还照片后再确认归还");
    }
    const photo = await tx.fileAsset.findFirst({
      where: {
        publicPath: upload.returnPhotoPath,
        kind: "MATERIAL_RETURN_PHOTO",
        ownerOpenId: actor.openId,
        cleanupRequestedAt: null,
      },
      select: {
        publicPath: true,
        storagePath: true,
        mimeType: true,
        size: true,
        writeGeneration: true,
      },
    });
    if (
      !photo ||
      !isMaterialReturnPhotoStoragePath(photo.storagePath, activeLoan.id)
    ) {
      throw stateConflictError("归还照片无效，请重新拍摄后提交");
    }
    const photoIsValid = await validateStoredMaterialReturnPhoto(
      photo,
      upload.writeGeneration,
    );
    if (!photoIsValid) {
      throw stateConflictError("归还照片无效，请重新拍摄后提交");
    }

    const returnedAt = new Date();
    await tx.materialLoan.update({
      where: { id: activeLoan.id },
      data: {
        returnedAt,
        returnIdempotencyKey: parsed.idempotencyKey,
        returnPhotoPath: photo.publicPath,
      },
    });
    await touchMaterial(tx, material.id);
    await createDomainAuditEventTx(tx, {
      actorAccountId: actor.accountId,
      actorPersonId: actor.personId,
      action: "material.returned",
      entityType: "Material",
      entityId: material.id,
      before: {
        activeLoanId: activeLoan.id,
        borrowerAccountId: actor.accountId,
      },
      after: {
        activeLoanId: null,
        returnedAt: returnedAt.toISOString(),
        returnPhotoCaptured: true,
      },
    });
    return {
      result: {
        materialId: material.id,
        materialName: material.name,
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

async function findScanReplay(
  tx: Prisma.TransactionClient,
  input: {
    materialId: string;
    accountId: string;
    operation: "CHECKOUT" | "RETURN";
    idempotencyKey: string;
  },
): Promise<{ occurredAt: Date; returnPhotoPath: string | null } | null> {
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
      ? { occurredAt: loan.checkedOutAt, returnPhotoPath: null }
      : null;
  }
  const loan = await tx.materialLoan.findFirst({
    where: {
      materialId: input.materialId,
      borrowerAccountId: input.accountId,
      returnIdempotencyKey: input.idempotencyKey,
    },
    select: { returnedAt: true, returnPhotoPath: true },
  });
  return loan?.returnedAt
    ? {
        occurredAt: loan.returnedAt,
        returnPhotoPath: loan.returnPhotoPath,
      }
    : null;
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
