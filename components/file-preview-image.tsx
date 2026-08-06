"use client";

/* eslint-disable @next/next/no-img-element -- Protected uploads and Blob URLs cannot use Next image optimization. */

import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

type Props = {
  file?: File;
  fallbackSrc?: string | null;
  alt: string;
  className?: string;
};

export function FilePreviewImage({ file, fallbackSrc, alt, className }: Props) {
  const objectUrlRef = useRef<string | null>(null);
  const attachImage = useCallback((node: HTMLImageElement | null) => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (node && file) {
      const objectUrl = URL.createObjectURL(file);
      objectUrlRef.current = objectUrl;
      node.src = objectUrl;
    }
  }, [file]);

  if (!file && !fallbackSrc) return null;

  return (
    <img
      ref={file ? attachImage : undefined}
      src={file ? undefined : (fallbackSrc ?? undefined)}
      alt={alt}
      className={cn(className)}
    />
  );
}
