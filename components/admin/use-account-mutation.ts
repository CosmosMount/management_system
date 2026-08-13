"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { RunAccountMutation } from "@/components/admin/accounts-contract";

export function useAccountMutation(): {
  pending: boolean;
  run: RunAccountMutation;
} {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const run: RunAccountMutation = (action, options) => {
    startTransition(async () => {
      try {
        const result = await action();
        toast.success(
          result?.changed === false && options.unchanged
            ? options.unchanged
            : options.success,
        );
        options.afterSuccess?.(result ?? {});
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "操作失败，请稍后重试");
      }
    });
  };

  return { pending, run };
}
