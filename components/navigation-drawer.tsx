"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogClose, DialogContent, DialogDescription,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

type NavigationDrawerProps = {
  title: string;
  triggerLabel: string;
  children: ReactNode;
  compact?: boolean;
};

export function NavigationDrawer(props: NavigationDrawerProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // A committed route change closes navigation; canceled draft guards do not.
  return <NavigationDrawerContent key={`${pathname}?${searchParams.toString()}`} {...props} />;
}

function NavigationDrawerContent({
  title, triggerLabel, children, compact = false,
}: NavigationDrawerProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        aria-label={triggerLabel}
        render={<Button variant="ghost" className="min-h-11 min-w-11 gap-2" />}
      >
        <Menu className="size-5" aria-hidden="true" />
        {!compact && <span>{title}</span>}
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        data-navigation-drawer
        className="inset-y-0 left-0 flex h-dvh max-h-dvh w-80 max-w-[calc(100%-3rem)] translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 sm:max-w-80"
      >
        <DialogHeader className="shrink-0 border-b p-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>{title}</DialogTitle>
            <DialogClose aria-label={`关闭${title}`} render={<Button variant="ghost" className="size-11" />}>
              <X aria-hidden="true" />
            </DialogClose>
          </div>
          <DialogDescription>选择页面，继续处理您的工作。</DialogDescription>
        </DialogHeader>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))]"
          onClickCapture={(event) => {
            if (event.defaultPrevented) return;
            const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
            if (link instanceof HTMLAnchorElement && link.href === window.location.href) setOpen(false);
          }}
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
