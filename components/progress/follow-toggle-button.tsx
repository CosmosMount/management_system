"use client";

import { useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = {
  noun: "项目" | "任务";
  followed: boolean;
  canFollow: boolean;
  canUnfollow: boolean;
  disabledReason?: string;
  disabledReasons?: string[];
  className?: string;
  onFollow: () => Promise<void>;
  onUnfollow: () => Promise<void>;
};

export function FollowToggleButton({
  noun,
  followed,
  canFollow,
  canUnfollow,
  disabledReason,
  disabledReasons,
  className,
  onFollow,
  onUnfollow,
}: Props) {
  const [loading, setLoading] = useState(false);
  const disabled = loading || (!canFollow && !canUnfollow);
  const reason = formatDisabledReason({
    noun,
    followed,
    canFollow,
    canUnfollow,
    reasons:
      disabledReasons && disabledReasons.length > 0
        ? disabledReasons
        : disabledReason
          ? [disabledReason]
          : [],
  });
  const label = followed
    ? canUnfollow
      ? `取消关注${noun}`
      : "已关注"
    : `关注${noun}`;
  const Icon = followed && canUnfollow ? BellOff : Bell;

  async function handleClick() {
    if (disabled) return;
    setLoading(true);
    try {
      if (followed) {
        await onUnfollow();
      } else {
        await onFollow();
      }
    } finally {
      setLoading(false);
    }
  }

  if (disabled && !loading) {
    return (
      <span
        className="group relative inline-flex outline-none"
        title={reason}
        tabIndex={0}
      >
        <Button
          type="button"
          variant="outline"
          className={className}
          disabled
          aria-label={label}
        >
          <Icon className="h-4 w-4" />
          {label}
        </Button>
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-max max-w-72 -translate-x-1/2 rounded-md border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus:opacity-100"
        >
          {reason}
        </span>
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      className={className}
      disabled={loading}
      onClick={handleClick}
      title={followed ? `取消关注该${noun}通知` : `关注该${noun}通知`}
    >
      <Icon className="h-4 w-4" />
      {loading ? "处理中..." : label}
    </Button>
  );
}

function formatDisabledReason({
  noun,
  followed,
  canFollow,
  canUnfollow,
  reasons,
}: {
  noun: "项目" | "任务";
  followed: boolean;
  canFollow: boolean;
  canUnfollow: boolean;
  reasons: string[];
}) {
  const cleanReasons = reasons.map((item) => item.trim()).filter(Boolean);
  if (followed && !canUnfollow) {
    if (cleanReasons.length > 0) {
      return `不能取消关注：${cleanReasons.join("；")}。`;
    }
    return `不能取消关注：当前身份必须接收该${noun}通知。`;
  }
  if (!followed && !canFollow) {
    if (cleanReasons.length > 0) {
      return `不能关注：${cleanReasons.join("；")}。`;
    }
    return `当前不能关注该${noun}。`;
  }
  return followed ? `取消关注该${noun}通知` : `关注该${noun}通知`;
}
