"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  seconds?: number;
};

export function NotFoundRedirect({ seconds = 5 }: Props) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    if (remaining <= 0) {
      router.replace("/");
      return;
    }

    const timer = window.setTimeout(() => {
      setRemaining((current) => current - 1);
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [remaining, router]);

  return (
    <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
      <Link href="/" className={cn(buttonVariants({ size: "lg" }), "w-fit")}>
        返回首页
      </Link>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {remaining > 0 ? `${remaining} 秒后自动返回首页` : "正在返回首页..."}
      </p>
    </div>
  );
}
