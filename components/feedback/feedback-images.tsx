"use client";

import type { ChangeEvent, ClipboardEvent } from "react";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { ImagePreview } from "@/components/image-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  FeedbackImageFile,
  FeedbackImageFiles,
} from "@/components/feedback/feedback-types";
import {
  FEEDBACK_IMAGE_ACCEPT,
  FEEDBACK_IMAGE_ALLOWED_TYPES,
  FEEDBACK_IMAGE_SIZE_LABEL,
  FEEDBACK_IMAGE_TOTAL_SIZE_LABEL,
  MAX_FEEDBACK_IMAGE_COUNT,
  MAX_FEEDBACK_IMAGE_SIZE,
  MAX_FEEDBACK_IMAGE_TOTAL_SIZE,
} from "@/lib/feedback-upload-limits";
import { cn } from "@/lib/utils";

const feedbackImageTypeSet = new Set<string>(FEEDBACK_IMAGE_ALLOWED_TYPES);

export function handleFeedbackPaste(
  event: ClipboardEvent,
  { files, setFiles }: FeedbackImageFiles,
) {
  const items = Array.from(event.clipboardData.items);
  if (
    !items.some((item) => item.kind === "file" && item.type.startsWith("image/"))
  ) {
    return;
  }
  const images = items
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file && file.type.startsWith("image/"));
  const accepted = acceptedFeedbackImages(images, false);
  if (accepted.length === 0) {
    if (!event.clipboardData.getData("text/plain")) {
      acceptedFeedbackImages(images);
    }
    return;
  }
  event.preventDefault();
  addAcceptedFeedbackImages(files, accepted, setFiles);
}

export function buildFeedbackFormData(
  form: HTMLFormElement,
  imageFiles: FeedbackImageFile[],
): FormData {
  const formData = new FormData(form);
  formData.delete("images");
  for (const image of imageFiles) {
    formData.append("images", image.file, image.file.name);
  }
  return formData;
}

export function revokeFeedbackImages(images: FeedbackImageFile[]) {
  for (const image of images) URL.revokeObjectURL(image.previewUrl);
}

function acceptedFeedbackImages(files: File[], showErrors = true): File[] {
  const accepted: File[] = [];
  for (const file of files) {
    if (!feedbackImageTypeSet.has(file.type)) {
      if (showErrors) toast.error("反馈图片仅支持 PNG/JPG/WebP");
      continue;
    }
    if (file.size > MAX_FEEDBACK_IMAGE_SIZE) {
      if (showErrors) {
        toast.error(`单张反馈图片不能超过 ${FEEDBACK_IMAGE_SIZE_LABEL}`);
      }
      continue;
    }
    accepted.push(file);
  }
  return accepted;
}

function addAcceptedFeedbackImages(
  currentFiles: FeedbackImageFile[],
  accepted: File[],
  setFiles: (files: FeedbackImageFile[]) => void,
) {
  if (accepted.length === 0) return;
  const remaining = MAX_FEEDBACK_IMAGE_COUNT - currentFiles.length;
  if (remaining <= 0) {
    toast.error(`最多上传 ${MAX_FEEDBACK_IMAGE_COUNT} 张图片`);
    return;
  }
  if (accepted.length > remaining) {
    toast.error(`最多上传 ${MAX_FEEDBACK_IMAGE_COUNT} 张图片`);
  }
  const totalSize = [...currentFiles.map((image) => image.file), ...accepted]
    .slice(0, currentFiles.length + remaining)
    .reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_FEEDBACK_IMAGE_TOTAL_SIZE) {
    toast.error(`反馈图片总大小不能超过 ${FEEDBACK_IMAGE_TOTAL_SIZE_LABEL}`);
    return;
  }
  setFiles([
    ...currentFiles,
    ...accepted.slice(0, remaining).map(createFeedbackImageFile),
  ]);
}

function createFeedbackImageFile(file: File): FeedbackImageFile {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${file.name}-${file.size}-${file.lastModified}-${Date.now()}`;
  return { id, file, previewUrl: URL.createObjectURL(file) };
}

export function FeedbackImageInput({
  files,
  setFiles,
  disabled,
  compact = false,
}: FeedbackImageFiles & { disabled: boolean; compact?: boolean }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (files.length === 0 && inputRef.current) inputRef.current.value = "";
  }, [files.length]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    addAcceptedFeedbackImages(
      files,
      acceptedFeedbackImages(Array.from(event.target.files ?? [])),
      setFiles,
    );
    event.target.value = "";
  }

  function removeFile(index: number) {
    const removed = files[index];
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    setFiles(files.filter((_, fileIndex) => fileIndex !== index));
  }

  return (
    <div className="space-y-2">
      {files.length > 0 && (
        <div
          className={cn(
            compact
              ? "flex gap-2 overflow-x-auto pb-1 [scrollbar-gutter:stable]"
              : "grid grid-cols-3 gap-2 sm:grid-cols-4",
          )}
        >
          {files.map((image, index) => (
            <div
              key={image.id}
              className={cn(
                "group relative overflow-hidden rounded-md border bg-muted",
                compact ? "h-16 w-16 shrink-0" : "aspect-square",
              )}
            >
              <ImagePreview
                src={image.previewUrl}
                alt={image.file.name}
                wrapperClassName="block h-full w-full"
                className="h-full w-full object-cover"
              />
              <Button
                type="button"
                size="icon-xs"
                variant="destructive"
                className="absolute right-1 top-1"
                disabled={disabled}
                aria-label={`移除 ${image.file.name}`}
                onClick={() => removeFile(index)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Input
        ref={inputRef}
        type="file"
        accept={FEEDBACK_IMAGE_ACCEPT}
        multiple
        disabled={disabled}
        className={cn(compact ? "max-w-full" : "max-w-md")}
        onChange={handleFileChange}
      />
      <p className="text-xs text-muted-foreground">
        支持 PNG/JPG/WebP，可选择文件或在输入框中粘贴截图；最多{" "}
        {MAX_FEEDBACK_IMAGE_COUNT} 张，单张不超过 {FEEDBACK_IMAGE_SIZE_LABEL}，
        合计不超过 {FEEDBACK_IMAGE_TOTAL_SIZE_LABEL}。
      </p>
    </div>
  );
}
