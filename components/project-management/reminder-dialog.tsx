"use client";

import type { ReactNode } from "react";
import { BellRing } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ReminderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy?: boolean;
  title: string;
  description: string;
  children: ReactNode;
  error?: string;
  footer: ReactNode;
};

export function ReminderDialog({
  open,
  onOpenChange,
  busy = false,
  title,
  description,
  children,
  error,
  footer,
}: ReminderDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="flex min-w-0 items-start gap-3 pr-2">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <BellRing className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 space-y-1">
              <DialogTitle className="text-lg">{title}</DialogTitle>
              <DialogDescription className="break-words">
                {description}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          {children}
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
