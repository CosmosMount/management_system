import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function MineScopeToggle({
  basePath,
  mine,
  className,
}: {
  basePath: string;
  mine: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      <Link
        href={basePath}
        className={cn(
          buttonVariants({ size: "sm", variant: mine ? "outline" : "default" }),
        )}
      >
        全队
      </Link>
      <Link
        href={`${basePath}?mine=1`}
        className={cn(
          buttonVariants({ size: "sm", variant: mine ? "default" : "outline" }),
        )}
      >
        只看自己
      </Link>
    </div>
  );
}

export async function readMineSearchParam(
  searchParams:
    | Promise<Record<string, string | string[] | undefined>>
    | undefined,
): Promise<boolean> {
  const params = searchParams ? await searchParams : {};
  const value = params.mine;
  return Array.isArray(value) ? value.includes("1") : value === "1";
}

export function withMine(path: string, mine: boolean): string {
  return mine ? `${path}?mine=1` : path;
}
