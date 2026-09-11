"use client";

import type { ReactElement } from "react";
import { Tooltip } from "@base-ui/react/tooltip";

export function TextTooltip({ text, children }: { text: string; children: ReactElement }) {
  return <Tooltip.Root>
    <Tooltip.Trigger render={children} />
    <Tooltip.Portal>
      <Tooltip.Positioner sideOffset={6} className="z-60">
        <Tooltip.Popup role="tooltip" className="max-h-[min(24rem,var(--available-height))] max-w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md [overflow-wrap:anywhere]">
          {text}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>;
}
