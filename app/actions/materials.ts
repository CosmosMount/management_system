"use server";

import { logger } from "@/lib/logger";
import { type ProjectManagementActionResult } from "@/lib/project-management/application/action-result";
import {
  toProjectManagementServiceError,
  validationError,
} from "@/lib/project-management/application/errors";
import { getCurrentProjectManagementActor } from "@/lib/project-management/identity";
import { saveMaterialReturnPhoto } from "@/lib/file-upload";
import { cleanupUploadPaths } from "@/lib/upload-cleanup";
import { materialScanSchema } from "@/lib/material-management/validations";
import {
  createMaterial as createMaterialService,
  deleteMaterial as deleteMaterialService,
  preflightMaterialReturn,
  scanMaterial as scanMaterialService,
  type MaterialScanResult,
} from "@/lib/material-management/service";
import { revalidateMaterials } from "@/lib/revalidate";

export async function createMaterial(
  input: unknown,
): Promise<ProjectManagementActionResult<{ materialId: string }>> {
  return runMaterialAction("material.register", "createMaterial", async () => {
    const actor = await getCurrentProjectManagementActor();
    const result = await createMaterialService(actor, input);
    revalidateMaterials(result.materialId);
    return { actorAccountId: actor.accountId, data: result };
  });
}

export async function deleteMaterial(
  input: unknown,
): Promise<ProjectManagementActionResult<{ materialId: string }>> {
  return runMaterialAction("material.delete", "deleteMaterial", async () => {
    const actor = await getCurrentProjectManagementActor();
    const result = await deleteMaterialService(actor, input);
    for (const material of result.relatedMaterials) {
      revalidateMaterials(material.materialId, material.qrToken);
    }
    return { actorAccountId: actor.accountId, data: { materialId: result.materialId } };
  });
}

export async function scanMaterial(
  input: unknown,
): Promise<ProjectManagementActionResult<MaterialScanResult>> {
  return runMaterialAction("material.scan", "scanMaterial", async () => {
    const actor = await getCurrentProjectManagementActor();
    const result = await scanMaterialService(actor, input);
    for (const materialId of result.relatedMaterialIds) {
      revalidateMaterials(materialId);
    }
    return { actorAccountId: actor.accountId, data: result };
  });
}

export async function returnMaterial(
  formData: FormData,
): Promise<ProjectManagementActionResult<MaterialScanResult>> {
  return runMaterialAction("material.scan", "returnMaterial", async () => {
    const actor = await getCurrentProjectManagementActor();
    const input = materialScanSchema.parse({
      qrToken: String(formData.get("qrToken") ?? ""),
      operation: "RETURN" as const,
      expectedActiveLoanId: String(formData.get("expectedActiveLoanId") ?? ""),
      idempotencyKey: String(formData.get("idempotencyKey") ?? ""),
    });
    const preflight = await preflightMaterialReturn(actor, input);
    if (preflight.kind === "REPLAY") {
      for (const materialId of preflight.result.relatedMaterialIds) {
        revalidateMaterials(materialId);
      }
      return { actorAccountId: actor.accountId, data: preflight.result };
    }

    const photo = formData.get("returnPhoto");
    if (!(photo instanceof File) || photo.size === 0) {
      throw validationError("请拍摄物资归还照片", {
        returnPhoto: ["请拍摄物资归还照片"],
      });
    }

    const savedPhotos: Array<{
      loanId: string;
      publicPath: string;
      writeGeneration: string;
    }> = [];
    try {
      for (const loanId of preflight.loanIds) {
        const saved = await saveMaterialReturnPhoto(loanId, actor.openId, photo);
        savedPhotos.push({ loanId, ...saved });
      }
    } catch (error) {
      await cleanupUploadPaths(
        savedPhotos.map((saved) => saved.publicPath),
        "material_paired_return_upload_compensation",
      );
      const message =
        error instanceof Error ? error.message : "归还照片保存失败，请重试";
      throw validationError(message, { returnPhoto: [message] });
    }

    let result: MaterialScanResult;
    try {
      result = await scanMaterialService(
        actor,
        input,
        savedPhotos.map((saved) => ({
          loanId: saved.loanId,
          returnPhotoPath: saved.publicPath,
          writeGeneration: saved.writeGeneration,
        })),
      );
    } catch (error) {
      await cleanupUploadPaths(
        savedPhotos.map((saved) => saved.publicPath),
        "material_return_transaction_compensation",
      );
      throw error;
    }
    for (const materialId of result.relatedMaterialIds) {
      revalidateMaterials(materialId);
    }
    return { actorAccountId: actor.accountId, data: result };
  });
}

async function runMaterialAction<T>(
  event: string,
  action: string,
  callback: () => Promise<{ actorAccountId: string; data: T }>,
): Promise<ProjectManagementActionResult<T>> {
  const startedAt = Date.now();
  let actorAccountId: string | undefined;
  try {
    const result = await callback();
    actorAccountId = result.actorAccountId;
    logger.audit(event, {
      module: "material-management",
      action,
      actorAccountId,
      durationMs: Date.now() - startedAt,
      result: "success",
    });
    return { ok: true, data: result.data };
  } catch (error) {
    const mapped = toProjectManagementServiceError(error);
    logger[mapped.code === "INTERNAL_ERROR" ? "error" : "warn"](event, {
      module: "material-management",
      action,
      actorAccountId,
      durationMs: Date.now() - startedAt,
      result: "failure",
      errorCode: mapped.code,
      errorMessage: mapped.message,
      error: mapped.code === "INTERNAL_ERROR" ? error : undefined,
    });
    return {
      ok: false,
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.fieldErrors ? { fieldErrors: mapped.fieldErrors } : {}),
      },
    };
  }
}
