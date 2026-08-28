import * as React from "react";
import { cn } from "@/lib/utils";

function List({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="list"
      className={cn(
        "min-w-0 divide-y divide-border overflow-hidden rounded-xl border border-border bg-background",
        className,
      )}
      {...props}
    />
  );
}

function ListItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="list-item"
      className={cn(
        "flex min-w-0 flex-col gap-4 p-4 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center",
        className,
      )}
      {...props}
    />
  );
}

function ListContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="list-content"
      className={cn("min-w-0 flex-1", className)}
      {...props}
    />
  );
}

function ListActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="list-actions"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-2 sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function ListEmpty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="list-empty"
      className={cn(
        "rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { List, ListActions, ListContent, ListEmpty, ListItem };
