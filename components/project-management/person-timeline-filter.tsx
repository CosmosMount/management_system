"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserSelect } from "@/components/project-management/user-picker";
import type { PersonOptionDto } from "@/lib/project-management/types/time-canvas";

export function PersonTimelineFilter({
  selectedPerson,
}: {
  selectedPerson: PersonOptionDto;
}) {
  const router = useRouter();
  const [selectedPersonId, setSelectedPersonId] = useState(selectedPerson.id);
  const [isPending, startTransition] = useTransition();

  return (
    <section
      aria-labelledby="person-timeline-filter-title"
      className="rounded-xl border border-border bg-card p-4"
      data-testid="person-timeline-filter"
    >
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] sm:items-end">
        <div className="min-w-0">
          <label
            className="mb-2 block text-sm font-medium"
            htmlFor="person-timeline-person"
            id="person-timeline-filter-title"
          >
            查看人员
          </label>
          <UserSelect
            inputId="person-timeline-person"
            ariaLabel="查看人员"
            scope={{ purpose: "VISIBLE" }}
            initialOptions={[selectedPerson]}
            value={selectedPersonId}
            clearable={false}
            disabled={isPending}
            onValueChange={(personId) => {
              if (!personId || personId === selectedPersonId) return;
              setSelectedPersonId(personId);
              startTransition(() => {
                const url = new URL(window.location.href);
                url.searchParams.set("people", personId);
                url.searchParams.delete("personError");
                router.push(`${url.pathname}?${url.searchParams.toString()}`, {
                  scroll: false,
                });
              });
            }}
          />
        </div>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {isPending
            ? "正在加载所选人员的时间线…"
            : `当前查看：${selectedPerson.displayName}。看板仅供查看，不能修改投入。`}
        </p>
      </div>
    </section>
  );
}
