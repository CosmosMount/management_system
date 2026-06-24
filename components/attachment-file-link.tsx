"use client";

import { ImagePreview } from "@/components/image-preview";
import { displayFileName } from "@/lib/order-attachments";
import { isImagePath } from "@/lib/image-path";

type Props = {
  filePath: string;
  className?: string;
  previewClassName?: string;
};

export function AttachmentFileLink({
  filePath,
  className = "text-sm text-primary hover:underline",
  previewClassName = "max-h-48 rounded-md border object-contain",
}: Props) {
  const name = displayFileName(filePath);

  if (isImagePath(filePath)) {
    return (
      <ImagePreview
        src={filePath}
        alt={name}
        wrapperClassName="block text-left"
        className={previewClassName}
      />
    );
  }

  return (
    <a
      href={`${filePath}${filePath.includes("?") ? "&" : "?"}download=1`}
      target="_blank"
      rel="noreferrer"
      className={className}
    >
      {name}
    </a>
  );
}
