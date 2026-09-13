"use client";

import { useState } from "react";
import Image from "next/image";
import { Tooltip } from "@base-ui/react/tooltip";
import { TextTooltip } from "@/components/ui/text-tooltip";
import { cn } from "@/lib/utils";

type Owner = {
  personId: string;
  displayName: string;
  avatar: string | null;
  status: "ACTIVE" | "INACTIVE";
};

export function OwnerAvatarGroup({ owners, label }: { owners: Owner[]; label: string }) {
  const people = [...new Map(owners.map((owner) => [owner.personId, owner])).values()];
  const names = people.map((owner) => `${owner.displayName}${owner.status === "INACTIVE" ? "（已停用）" : ""}`).join("、");
  const description = people.length ? `${label}：${names}` : `${label}未设置`;

  return <Tooltip.Provider>
    <TextTooltip text={description}>
      <span tabIndex={0} aria-label={description} className="inline-flex w-fit shrink-0 items-center rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring" data-testid="owner-avatar-group">
        <span aria-hidden="true" className="flex -space-x-2">
          {people.slice(0, 2).map((owner, index) => <OwnerAvatar key={owner.personId} owner={owner} index={index} />)}
          {people.length > 2 && <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-background bg-slate-100 text-xs font-medium text-slate-600" data-testid="owner-avatar-overflow">+{people.length - 2}</span>}
          {people.length === 0 && <span className="text-sm text-muted-foreground">—</span>}
        </span>
      </span>
    </TextTooltip>
  </Tooltip.Provider>;
}

function OwnerAvatar({ owner, index }: { owner: Owner; index: number }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return <span className={cn("relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-background text-sm font-medium text-white", index === 0 ? "bg-slate-400" : "bg-blue-500")} data-testid="owner-avatar">
    {owner.avatar && failedSource !== owner.avatar
      ? <Image src={owner.avatar} alt="" width={32} height={32} unoptimized className="size-full object-cover" onError={() => setFailedSource(owner.avatar)} />
      : <span>{Array.from(owner.displayName.trim())[0] || "?"}</span>}
  </span>;
}
