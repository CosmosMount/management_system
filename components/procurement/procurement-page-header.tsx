import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  href: string;
  backLabel: string;
  title: string;
  description?: string;
  icon?: LucideIcon;
  className?: string;
};

/** 采购子页紧凑页头：回退链接 + 带图标的标题 */
export function ProcurementPageHeader({
  href,
  backLabel,
  title,
  description,
  icon: Icon,
  className,
}: Props) {
  return (
    <header className={cn("mb-6", className)}>
      <Link
        href={href}
        className="-ml-1 mb-1.5 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
        {backLabel}
      </Link>
      <div className="flex items-center gap-3">
        {Icon ? (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </div>
        ) : null}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
    </header>
  );
}
