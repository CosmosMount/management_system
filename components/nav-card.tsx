import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Props = {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  className?: string;
  variant?: "card" | "wide";
};

export function NavCard({
  href,
  title,
  description,
  icon: Icon,
  className,
  variant = "card",
}: Props) {
  if (variant === "wide") {
    return (
      <Link href={href} className="group block w-full">
        <Card
          className={cn(
            "flex min-h-[7rem] w-full flex-row items-center gap-6 border-border/60 bg-card/80 p-6 shadow-sm backdrop-blur-sm transition-all hover:border-primary/30 hover:shadow-md",
            className,
          )}
        >
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
            <Icon className="h-7 w-7" />
          </div>
          <CardHeader className="flex-1 gap-1 p-0">
            <CardTitle className="text-xl">{title}</CardTitle>
            <CardDescription className="text-base">{description}</CardDescription>
          </CardHeader>
        </Card>
      </Link>
    );
  }

  return (
    <Link href={href} className="group block h-full">
      <Card
        className={cn(
          "h-full border-border/60 bg-card/80 shadow-sm backdrop-blur-sm transition-all hover:border-primary/30 hover:shadow-md",
          className,
        )}
      >
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
            <Icon className="h-5 w-5" />
          </div>
          <CardTitle className="text-lg">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}
