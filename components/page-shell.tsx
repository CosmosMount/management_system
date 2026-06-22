import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
};

export function PageShell({ children }: Props) {
  return (
    <div className="relative flex min-h-full flex-1 flex-col">
      <div
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/8 via-background to-background"
        aria-hidden
      />
      {children}
    </div>
  );
}
