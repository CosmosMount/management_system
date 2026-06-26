import type { AdminIcon } from "@/components/admin/types";

export function AdminMetric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: AdminIcon;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-3 break-words text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function SystemStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-background px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
