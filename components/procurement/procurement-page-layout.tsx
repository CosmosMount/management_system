import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Props = {
  children: ReactNode;
  className?: string;
};

/** 采购管理模块桌面宽屏布局 */
export function ProcurementPageLayout({ children, className }: Props) {
  return (
    <main
      className={cn(
        "mx-auto w-full max-w-[1440px] flex-1 px-4 py-8 sm:px-6 lg:px-8",
        className,
      )}
    >
      {children}
    </main>
  );
}
