import { cn } from "@/lib/utils";

type Step = {
  key: string;
  label: string;
};

type Props = {
  steps: Step[];
  currentIndex: number;
  className?: string;
};

export function StatusStepper({ steps, currentIndex, className }: Props) {
  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <ol className="flex min-w-max items-center gap-0">
        {steps.map((step, index) => {
          const isDone = index < currentIndex;
          const isCurrent = index === currentIndex;
          const isLast = index === steps.length - 1;

          return (
            <li key={step.key} className="flex items-center">
              <div className="flex flex-col items-center px-4">
                <div
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors",
                    isDone && "border-primary bg-primary text-primary-foreground",
                    isCurrent &&
                      "border-primary bg-primary/10 text-primary ring-4 ring-primary/15",
                    !isDone &&
                      !isCurrent &&
                      "border-muted-foreground/30 text-muted-foreground",
                  )}
                >
                  {index + 1}
                </div>
                <span
                  className={cn(
                    "mt-2 max-w-[7rem] text-center text-sm",
                    isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {step.label}
                </span>
              </div>
              {!isLast && (
                <div
                  className={cn(
                    "mb-6 h-0.5 w-16 shrink-0",
                    index < currentIndex ? "bg-primary" : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
