"use client";

import Image from "next/image";
import { useState } from "react";

export type PersonAvatarOption = {
  displayName: string;
  avatar?: string | null;
};

export function PersonAvatar({
  option,
  size = "default",
}: {
  option: PersonAvatarOption;
  size?: "small" | "default";
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const pixels = size === "small" ? 20 : 32;
  const sizeClass = size === "small" ? "size-5" : "size-8";
  const source = option.avatar && failedSource !== option.avatar
    ? option.avatar
    : null;
  const initial = Array.from(option.displayName.trim())[0] || "?";

  if (source) {
    return (
      <Image
        src={source}
        alt=""
        width={pixels}
        height={pixels}
        unoptimized
        className={`${sizeClass} shrink-0 rounded-full object-cover`}
        data-testid="person-picker-avatar"
        onError={() => setFailedSource(source)}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`${sizeClass} flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium`}
      data-testid="person-picker-avatar"
    >
      {initial}
    </span>
  );
}
