import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Props = {
  children: ReactNode;
  className?: string;
};

/** 进度管理模块桌面宽屏布局 */
export function ProgressPageLayout({ children, className }: Props) {
  return (
    <main
      className={cn(
        "mx-auto w-full max-w-[min(1400px,96vw)] flex-1 px-8 py-10",
        className,
      )}
    >
      {children}
    </main>
  );
}
