import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  href: string;
  label: string;
  className?: string;
};

export function BackLink({ href, label, className }: Props) {
  return (
    <div className={cn("mb-2", className)}>
      <Link
        href={href}
        className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
        {label}
      </Link>
    </div>
  );
}
