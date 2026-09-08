"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
    <form action={action} method="get" aria-label={label} aria-busy={isPending} className={className} onSubmit={submit}>
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
  );
}
