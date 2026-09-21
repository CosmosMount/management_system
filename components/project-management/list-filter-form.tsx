"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type FilterField = {
  name: "mine" | "status" | "priority";
  label: string;
  value: string;
  options: { value: string; label: string }[];
};

export function ListFilterForm({
  action,
  label,
  searchLabel,
  query,
  filters,
  className,
}: {
  action: string;
  label: string;
  searchLabel: string;
  query: string;
  filters: FilterField[];
  className: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState(true);
  const filterFieldsId = useId();
  const committedValues: Record<string, string> = {
    q: query,
    ...Object.fromEntries(filters.map((filter) => [filter.name, filter.value])),
  };
  const routeKey = JSON.stringify([action, searchParams.toString(), committedValues]);
  const [draft, setDraft] = useState<{
    routeKey: string;
    values: Record<string, string>;
  } | null>(null);
  const values = draft?.routeKey === routeKey ? draft.values : committedValues;
  if (draft && draft.routeKey !== routeKey) setDraft(null);

  function updateField(name: string, value: string) {
    setDraft({ routeKey, values: { ...values, [name]: value } });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const search = new URLSearchParams(values);
    setDraft(null);
    startTransition(() => router.push(`${action}?${search.toString()}`));
  }

  return (
    <div className="min-w-0 space-y-2">
    <div className="flex min-w-0 flex-wrap items-center gap-2 lg:hidden">
      <Button type="button" variant="outline" aria-expanded={expanded} aria-controls={filterFieldsId} onClick={() => setExpanded((current) => !current)}>{expanded ? "收起筛选条件" : "展开筛选条件"}</Button>
      <span className="min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{[query && `关键词：${query}`, ...filters.map((filter) => filter.options.find((option) => option.value === filter.value)?.label)].filter(Boolean).join(" · ")}</span>
    </div>
    <form id={filterFieldsId} action={action} method="get" aria-label={label} aria-busy={isPending} className={cn(className, !expanded && "hidden lg:grid")} onSubmit={submit}>
      <Input name="q" value={values.q} onChange={(event) => updateField("q", event.target.value)} placeholder={searchLabel} aria-label={searchLabel} />
      {filters.map((filter) => (
        <select key={filter.name} name={filter.name} value={values[filter.name]} onChange={(event) => updateField(filter.name, event.target.value)} aria-label={filter.label} className="h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm">
          {filter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ))}
      <Button type="submit" disabled={isPending} aria-label="筛选">{isPending ? "筛选中…" : "筛选"}</Button>
      <Link href={action} aria-label="重置为默认筛选" className="text-sm text-primary hover:underline" onClick={(event) => {
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) setDraft(null);
      }}>重置</Link>
    </form>
    </div>
  );
}
