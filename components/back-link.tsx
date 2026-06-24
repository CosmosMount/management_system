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
    <div className={cn("mb-4", className)}>
      <Link
        href={href}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {label}
      </Link>
    </div>
  );
}
