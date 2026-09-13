"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Camera, CheckCircle2, PackageCheck } from "lucide-react";
import { returnMaterial, scanMaterial } from "@/app/actions/materials";
import { FilePreviewImage } from "@/components/file-preview-image";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  formatMaterialDateTime,
} from "@/lib/material-management/presentation";
import { createClientUuid } from "@/lib/material-management/client-uuid";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

export function MaterialScanConfirmation({
  qrToken,
  operation,
  expectedActiveLoanId,
}: {
  qrToken: string;
  operation: "CHECKOUT" | "RETURN";
  expectedActiveLoanId: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [idempotencyKey] = useState(createClientUuid);
  const [error, setError] = useState("");
  const [returnPhoto, setReturnPhoto] = useState<File | null>(null);
  const [success, setSuccess] = useState<{
    operation: "CHECKOUT" | "RETURN";
    materialName: string;
    occurredAt: string;
  } | null>(null);

  async function submit() {
    setError("");
    if (operation === "RETURN" && !returnPhoto) {
      setError("请先拍摄物资归还照片");
      document.getElementById("material-return-photo")?.focus();
      return;
    }
    const result =
      operation === "RETURN"
        ? await returnMaterial(buildReturnFormData({
            qrToken,
            expectedActiveLoanId,
            idempotencyKey,
            returnPhoto: returnPhoto!,
          }))
        : await scanMaterial({
            qrToken,
            operation,
            expectedActiveLoanId,
            idempotencyKey,
          });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSuccess(result.data);
  }

  if (success) {
    return (
      <div role="status" className="space-y-4 text-center">
        <CheckCircle2
          className="mx-auto size-12 text-emerald-600"
          aria-hidden="true"
        />
        <div>
          <h2 className="text-xl font-semibold">
            {success.operation === "CHECKOUT" ? "领用成功" : "归还成功"}
          </h2>
          <p className="mt-2 break-words text-sm text-muted-foreground">
            {success.materialName}
            <span aria-hidden="true"> · </span>
            {formatMaterialDateTime(success.occurredAt)}
          </p>
        </div>
        <Link
          href={routes.materials.root}
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          返回物资台账
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">
        {operation === "CHECKOUT"
          ? "确认后将以当前登录用户领用该物资。"
          : "请现场拍摄物资当前状态。照片将在下一位用户成功领用时自动删除。"}
      </p>
      {operation === "RETURN" && (
        <div className="space-y-2">
          <Label htmlFor="material-return-photo">归还照片</Label>
          {returnPhoto && (
            <FilePreviewImage
              file={returnPhoto}
              alt="待提交的物资归还照片"
              className="max-h-72 w-full rounded-lg border bg-muted object-contain"
            />
          )}
          <Input
            id="material-return-photo"
            name="returnPhoto"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif,image/avif"
            capture="environment"
            disabled={pending}
            aria-describedby="material-return-photo-help"
            onChange={(event) => {
              setError("");
              setReturnPhoto(event.target.files?.[0] ?? null);
            }}
          />
          <p id="material-return-photo-help" className="text-xs text-muted-foreground">
            手机会优先打开后置相机；电脑可选择摄像头照片。仅支持常见图片格式，最大 8MB。
          </p>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={pending}
        onClick={() => startTransition(submit)}
      >
        {operation === "CHECKOUT" ? (
          <PackageCheck aria-hidden="true" />
        ) : (
          <Camera aria-hidden="true" />
        )}
        {pending
          ? "正在处理…"
          : operation === "CHECKOUT"
            ? "确认领用"
            : "确认归还"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        为防止相机预览或链接预取误操作，扫码后需要手动确认。
      </p>
    </div>
  );
}

function buildReturnFormData(input: {
  qrToken: string;
  expectedActiveLoanId: string | null;
  idempotencyKey: string;
  returnPhoto: File;
}): FormData {
  const formData = new FormData();
  formData.set("qrToken", input.qrToken);
  formData.set("expectedActiveLoanId", input.expectedActiveLoanId ?? "");
  formData.set("idempotencyKey", input.idempotencyKey);
  formData.set("returnPhoto", input.returnPhoto, input.returnPhoto.name);
  return formData;
}
