import Link from "next/link";
import { cn } from "@/lib/utils";

export function WorkspaceViewNavigation({ management = false, schedule = false }: { management?: boolean; schedule?: boolean }) {
  return <nav aria-label="工作台视图" className="flex flex-wrap gap-1 border-b">
    {[{ href: "/progress", label: "我的工作", active: !management && !schedule }, { href: "/progress?view=schedule", label: "个人日程", active: schedule }, { href: "/progress?view=management", label: "管理概览", active: management }].map((item) => <Link key={item.href} href={item.href} aria-current={item.active ? "page" : undefined} className={cn("border-b-2 px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring", item.active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground")}>{item.label}</Link>)}
  </nav>;
}
