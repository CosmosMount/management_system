"use client";

import { useId, useState } from "react";
import { DeadlineLegend } from "@/components/project-management/node-deadline";

export function DeadlineRules() {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return <div
    onPointerEnter={(event) => { if (event.pointerType === "mouse" && window.matchMedia("(hover: hover)").matches) setOpen(true); }}
    onPointerLeave={(event) => { if (event.pointerType === "mouse" && window.matchMedia("(hover: hover)").matches) setOpen(false); }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
  >
    <button
      type="button"
      aria-expanded={open}
      aria-controls={contentId}
      onClick={() => setOpen((current) => !current)}
      className="cursor-pointer rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
    >到期规则</button>
    <div id={contentId} hidden={!open} className="absolute left-0 top-full z-20 w-[min(20rem,calc(100vw-4rem))] pt-2">
      <div className="space-y-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md">
        <DeadlineLegend />
        <p className="text-xs text-muted-foreground">仅提示进行中任务当前生效计划的当前节点，按截止时刻判断。到期颜色不代表审批状态。</p>
      </div>
    </div>
  </div>;
}
