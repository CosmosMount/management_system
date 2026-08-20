import type { ReactNode } from "react";

type PageCommandBarProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  sectionLabel?: string;
  testId?: string;
};

export function PageCommandBar({
  title,
  description,
  actions,
  sectionLabel = "项目管理",
  testId = "project-management-command-bar",
}: PageCommandBarProps) {
  return (
    <header
      className="border-b border-[var(--pm-shell-border)] bg-[var(--pm-command-bar-bg)]"
      data-testid={testId}
    >
      <div className="mx-auto flex min-h-16 w-full min-w-0 max-w-[96rem] flex-col gap-3 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-muted-foreground">
            {sectionLabel}
          </p>
          <h1
            className="mt-0.5 min-w-0 break-words text-xl font-semibold tracking-tight text-foreground sm:text-2xl"
            title={title}
          >
            {title}
          </h1>
          {description && (
            <p className="mt-1 max-w-4xl break-words text-sm leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}
