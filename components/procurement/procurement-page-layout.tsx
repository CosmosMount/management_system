import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Props = {
  children: ReactNode;
  className?: string;
};

/** 采购管理共享布局：明细表或画布单独管理自己的滚动区域。 */
export function ProcurementPageLayout({ children, className }: Props) {
  return (
    <div
      className={cn(
        "mx-auto min-w-0 w-full max-w-[1440px] flex-1 px-4 pt-4 pb-8 sm:px-6 lg:px-8 lg:pt-6",
        className,
      )}
    >
      {children}
    </div>
  );
}
