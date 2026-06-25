"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function NotFoundRedirect() {
  return (
    <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
      <Link href="/" className={cn(buttonVariants({ size: "lg" }), "w-fit")}>
        返回首页
      </Link>
    </div>
  );
}
